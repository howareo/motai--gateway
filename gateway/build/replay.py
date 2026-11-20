#!/usr/bin/env python3
"""Reconstruct only a new candidate directory from locked inputs; never deploy."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


def sha(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def run(args, cwd, env=None):
    subprocess.run(args, cwd=cwd, env=env, check=True)


def resolve_archive(root, source, override=None):
    public = source['public_archive']
    archive = override if override is not None else root / public['path']
    digest = sha(archive)
    if digest not in {source['archive_sha256'], public['sha256']}:
        raise ValueError('source archive hash mismatch')
    return archive, digest


def prepare_jsonschema(root, output, env):
    lock = json.loads((root / 'gateway/build/jsonschema-lock.json').read_text())
    downloaded = json.loads(subprocess.check_output(
        ['go', 'mod', 'download', '-json', lock['module'] + '@' + lock['version']], cwd=output, env=env, text=True))
    source = Path(downloaded['Dir'])
    patch = root / lock['patch']
    if (downloaded['Sum'] != lock['sum'] or sha(source / 'LICENSE') != lock['license_sha256']
            or sha(source / 'schema.go') != lock['schema_go_sha256'] or sha(patch) != lock['patch_sha256']):
        raise ValueError('jsonschema dependency provenance mismatch')
    target = output / '.motai-deps/jsonschema'
    shutil.copytree(source, target)
    # Module-cache directories are read-only; git apply must replace schema.go.
    target.chmod(target.stat().st_mode | 0o200)
    (target / 'schema.go').chmod(0o600)
    # output is a Git work tree; stop repository discovery at the dependency copy so
    # git apply cannot resolve paths against the outer repository and skip them.
    apply_env = dict(env, GIT_CEILING_DIRECTORIES=str(target.parent))
    run(['git', 'apply', '--check', str(patch)], target, apply_env)
    run(['git', 'apply', str(patch)], target, apply_env)
    run(['gofmt', '-w', 'schema.go'], target, env)
    if sha(target / 'schema.go') != lock['patched_schema_go_sha256']:
        raise ValueError('jsonschema patched source mismatch')
    run(['go', 'mod', 'edit', '-replace=' + lock['module'] + '=./.motai-deps/jsonschema'], output, env)
    return lock


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, help='override the bundled source with a locked archive')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build', action='store_true')
    parser.add_argument('--test', action='store_true')
    parser.add_argument('--mutator-probe', action='store_true', help='lab build panics on real billing entry points')
    parser.add_argument('--legacy-read-probe', action='store_true', help='lab build panics on old identity and route reads')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    lock = json.loads((root / 'gateway/candidate-lock.json').read_text())
    series = json.loads((root / 'gateway/patches/series.json').read_text())
    archive_path, archive_sha256 = resolve_archive(root, lock['source'], args.archive)
    output = args.output.resolve()
    if output.exists():
        raise ValueError('output must be a new directory')
    output.mkdir(parents=True)
    with tarfile.open(archive_path) as archive:
        archive.extractall(output, filter='data')
    for name, expected in [('LICENSE', lock['source']['license_sha256']),
                           ('go.mod', lock['build']['go_mod_base_sha256']),
                           ('go.sum', lock['build']['go_sum_base_sha256'])]:
        if sha(output / name) != expected:
            raise ValueError(f'baseline input hash mismatch: {name}')
    run(['git', 'init', '-q'], output)
    applied = []
    for item in series['patches']:
        patch = (root / item['path']).resolve()
        if sha(patch) != item['sha256']:
            raise ValueError(f'patch hash mismatch: {item["path"]}')
        run(['git', 'apply', '--check', str(patch)], output)
        run(['git', 'apply', str(patch)], output)
        applied.append({'path': item['path'], 'sha256': item['sha256']})
    overlay = root / 'gateway/core/overlay'
    overlays = []
    for item in sorted(overlay.rglob('*')):
        if item.is_file():
            relative = item.relative_to(overlay)
            target = output / relative
            if target.exists():
                raise ValueError(f'overlay would replace upstream input: {relative}')
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(item, target)
            overlays.append({'path': str(relative), 'sha256': sha(item)})
    probes = {}
    if args.mutator_probe:
        probes.update({
            'service/billing_session.go': ['NewBillingSession'],
            'service/quota.go': ['PreConsumeTokenQuota', 'PostConsumeQuota', 'checkAndSendQuotaNotify', 'checkAndSendSubscriptionQuotaNotify'],
            'model/token.go': ['IncreaseTokenQuota', 'DecreaseTokenQuota'],
            'model/user.go': ['IncreaseUserQuota', 'DecreaseUserQuota', 'DeltaUpdateUserQuota', 'UpdateUserUsedQuotaAndRequestCount', 'UpdateUserUsedQuota'],
            'model/channel.go': ['UpdateChannelUsedQuota'],
        })
    if args.legacy_read_probe:
        probes.update({'model/user_cache.go': ['GetUserCache'],
                       'model/ability.go': ['GetChannel'],
                       'model/channel_cache.go': ['GetRandomSatisfiedChannel','CacheGetChannel'],
                       'service/channel_select.go': ['CacheGetRandomSatisfiedChannel']})
        probes.setdefault('model/token.go',[]).extend(['ValidateUserToken','GetTokenByKey'])
    if probes:
        import re
        for file, names in probes.items():
            path = output / file
            text = path.read_text()
            for name in names:
                pattern = rf'(func {name}\([^\n]+\{{\n)'
                text, count = re.subn(pattern, rf'\1\tpanic("MOTAI_BILLING_MUTATOR:{name}")\n', text, count=1)
                if count != 1:
                    raise ValueError(f'probe entry point not found: {file}:{name}')
            path.write_text(text)
    env = dict(os.environ, CGO_ENABLED='0', GOMAXPROCS='2', MOTAI_CONTRACTS_DIR=str(root / 'contracts'))
    version = subprocess.check_output(['go', 'version'], text=True).strip()
    if version != 'go version ' + lock['build']['go_version']:
        raise ValueError(f'toolchain mismatch: {version}')
    print(version)
    run(['go', 'mod', 'edit', '-require=github.com/santhosh-tekuri/jsonschema/v5@v5.3.1'], output, env)
    run(['go', 'mod', 'download', 'github.com/santhosh-tekuri/jsonschema/v5'], output, env)
    schema_dependency = prepare_jsonschema(root, output, env)
    changed = [str(output / item['path']) for item in overlays if item['path'].endswith('.go')]
    changed += [str(output / item) for item in series['patches'][-1]['touched_files'] if item.endswith('.go')]
    run(['gofmt', '-w', *changed], output, env)
    for item in overlays:
        if sha(output / item['path']) != item['sha256']:
            raise ValueError(f'overlay changed during formatting; format the input before replay: {item["path"]}')
    manifest = {'source_archive_sha256': archive_sha256,
                'source_baseline_sha256': lock['source']['archive_sha256'], 'patches': applied, 'overlay': overlays,
                'schema_dependency': schema_dependency,
                'go_version': version,
                'go_mod_sha256': sha(output / 'go.mod'), 'go_sum_sha256': sha(output / 'go.sum'),
                'mutator_probe': args.mutator_probe, 'legacy_read_probe': args.legacy_read_probe,
                'test_passed': False, 'build_passed': False}
    if args.test:
        command = ['go', 'test', '-p', '2', '-count=1']
        if args.mutator_probe:
            command += ['-run', 'TestMotai|TestShared|TestInvalidCounters']
        run(command + ['./motai/...', './service', './relay/helper', './controller', './middleware', './cmd/motai'], output, env)
        manifest['test_passed'] = True
    if args.build:
        command = ['go', 'build', '-p', '2', '-trimpath', '-buildvcs=false', '-ldflags',
                   '-s -w -X github.com/QuantumNous/new-api/common.Version=v0.1.0-motai-candidate.20261027',
                   '-o', str(output / 'motai-gateway'), './cmd/motai']
        run(command, output, env)
        run(['go','build','-p','2','-trimpath','-buildvcs=false','-o',str(output/'motai-migrate'),'./cmd/motai-migrate'],output,env)
        manifest.update(build_passed=True, build_command=command, binary_sha256=sha(output / 'motai-gateway'))
    (output / 'build-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps({'output': str(output), 'manifest': str(output / 'build-manifest.json'),
                      'binary_sha256': manifest.get('binary_sha256'), 'test_passed': manifest['test_passed']}))


if __name__ == '__main__':
    main()
