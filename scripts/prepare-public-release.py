#!/usr/bin/env python3
"""Export a committed, allowlisted source snapshot; never push or deploy."""
import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import tarfile

DIRECTORIES = ('src/', 'public/', 'contracts/', 'gateway/core/source/',
               'gateway/core/overlay/', 'gateway/patches/', 'design/motai-console-v1/')
FILES = {'.gitattributes', '.gitignore', 'package.json', 'package-lock.json',
         'config.example.json', 'gateway/candidate-lock.json', 'gateway/core-lock.json',
         'gateway/THIRD_PARTY.md', 'gateway/build/jsonschema-lock.json',
         'docs/public/README.md', 'docs/motai-config-migration.example.json',
         'scripts/check-syntax.mjs', 'scripts/prepare-public-release.py',
         'scripts/test_prepare_public_release.py'}
CODE_SUFFIXES = {'.py', '.mjs', '.js', '.sh', '.sql', '.yaml'}
SECRET = re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\r?\n'
                    rb'[A-Za-z0-9+/=\r\n]{40,}-----END (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|'
                    rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|'
                    rb'AIza[A-Za-z0-9_-]{35}|sk-(?:proj-|ant-)?[A-Za-z0-9_-]{32,}')
# Fixed test keys and an upstream masking example, reviewed by exact path and fingerprint.
REVIEWED_LITERALS = {
    ('gateway/core/source/new-api-rc25-maintained.tar.gz:relaykit/relayconvert/kitutil/mask.go', '52d372096438'),
    ('test/caller-key-ui.test.js', '45d76460edf1'),
    ('test/gateway-caller-keys.test.js', '84f788d0fca1'),
    ('test/gateway-caller-keys.test.js', 'f890958e2dc3'),
    ('test/gateway-caller-keys.test.js', 'e23cde8aa34b'),
}


def allowed(path, patch_paths):
    parts = PurePosixPath(path).parts
    if any(part in {'.git', '.migration-private', 'node_modules', '__pycache__'} for part in parts):
        return False
    return (path in FILES or path in patch_paths or path.startswith(DIRECTORIES)
            or path.startswith('test/') and PurePosixPath(path).suffix in CODE_SUFFIXES | {'.json', '.html'}
            or path.startswith(('gateway/build/', 'gateway/lab/'))
            and PurePosixPath(path).suffix in CODE_SUFFIXES)


def findings(name, content):
    # Repeated-letter keys are explicit synthetic fixtures, not account secrets.
    result = []
    for match in SECRET.finditer(content):
        fingerprint = hashlib.sha256(match.group()).hexdigest()[:12]
        if len(set(match.group())) > 10 and (name, fingerprint) not in REVIEWED_LITERALS:
            result.append({'path': name, 'line': content.count(b'\n', 0, match.start()) + 1,
                           'fingerprint': fingerprint})
    return result


def export(root, output, revision):
    if output.exists():
        raise ValueError('output must be a new directory')

    def git(*args):
        return subprocess.check_output(['git', '-C', str(root), *args])

    commit = git('rev-parse', '--verify', revision + '^{commit}').decode().strip()
    series = json.loads(git('show', commit + ':gateway/patches/series.json'))
    schema = json.loads(git('show', commit + ':gateway/build/jsonschema-lock.json'))
    patch_paths = {item['path'] for item in series['patches']} | {schema['patch']}
    entries = []
    for entry in git('ls-tree', '-rz', commit).split(b'\0'):
        if not entry:
            continue
        metadata, raw_path = entry.split(b'\t', 1)
        path = raw_path.decode('utf-8')
        if allowed(path, patch_paths):
            mode, kind, oid = metadata.decode().split()
            if kind != 'blob' or mode not in {'100644', '100755'}:
                raise ValueError('unsupported public entry: ' + path)
            entries.append((path, mode, oid))
    selected = {path for path, _, _ in entries}
    missing = (FILES | patch_paths) - selected
    if missing:
        raise ValueError('missing public inputs: ' + ', '.join(sorted(missing)))
    output.mkdir(parents=True)
    hashes, alerts = {}, []
    for path, mode, oid in entries:
        content = git('cat-file', 'blob', oid)
        target = output / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)
        if mode == '100755':
            target.chmod(0o755)
        hashes[path] = hashlib.sha256(content).hexdigest()
        alerts.extend(findings(path, content))
        if path.endswith('.tar.gz'):
            with tarfile.open(fileobj=io.BytesIO(content)) as archive:
                for member in archive:
                    if member.isfile():
                        alerts.extend(findings(path + ':' + member.name,
                                               archive.extractfile(member).read()))
    readme = (output / 'docs/public/README.md').read_bytes()
    (output / 'README.md').write_bytes(readme)
    hashes['README.md'] = hashlib.sha256(readme).hexdigest()
    manifest = {'format_version': 1, 'source_revision': commit,
                'files': hashes, 'secret_findings': alerts}
    (output / 'public-source-manifest.json').write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(output), 'source_revision': commit,
                      'files': len(hashes), 'secret_findings': len(alerts)}))
    if alerts:
        raise ValueError('review redacted findings in public-source-manifest.json before publication')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--ref', default='HEAD')
    arguments = parser.parse_args()
    export(Path(__file__).resolve().parents[1], arguments.output.resolve(), arguments.ref)
