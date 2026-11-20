#!/usr/bin/env python3
"""Local dependency replay regression tests; no downloads or candidate build."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import replay


STOCK = b'package fixture\n\nvar Original = true\n'
PATCHED = b'package fixture\n\nvar Original = false\n'
PATCH = ('--- a/schema.go\n+++ b/schema.go\n@@ -1,3 +1,3 @@\n'
         ' package fixture\n \n-var Original = true\n+var Original = false\n')


class SourceArchiveTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='replay-source-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.public = self.root / 'public.tar.gz'
        self.original = self.root / 'original.tar.gz'
        self.public.write_bytes(b'public fixture')
        self.original.write_bytes(b'original fixture')
        self.source = {
            'archive_sha256': replay.sha(self.original),
            'public_archive': {'path': self.public.name, 'sha256': replay.sha(self.public)},
        }

    def test_defaults_to_bundled_archive(self):
        self.assertEqual(replay.resolve_archive(self.root, self.source),
                         (self.public, replay.sha(self.public)))

    def test_original_archive_override_still_supported(self):
        self.assertEqual(replay.resolve_archive(self.root, self.source, self.original),
                         (self.original, replay.sha(self.original)))

    def test_public_archive_override_supported(self):
        self.assertEqual(replay.resolve_archive(self.root, self.source, self.public),
                         (self.public, replay.sha(self.public)))

    def test_changed_archive_rejected(self):
        self.public.write_bytes(b'changed fixture')
        with self.assertRaisesRegex(ValueError, 'source archive hash mismatch'):
            replay.resolve_archive(self.root, self.source)


class DependencyReplayTest(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp(prefix='replay-test-'))
        self.root = self.base / 'root'
        (self.root / 'gateway/build').mkdir(parents=True)
        self.source = self.base / 'cache'
        self.source.mkdir()
        (self.source / 'schema.go').write_bytes(STOCK)
        (self.source / 'LICENSE').write_bytes(b'fixture license\n')
        self.output = self.base / 'output'
        self.output.mkdir()
        self.patch = self.root / 'dependency.patch'
        self.lock = {
            'module': 'example.test/schema', 'version': 'v1.0.0', 'sum': 'fixture-sum',
            'license_sha256': replay.sha(self.source / 'LICENSE'),
            'schema_go_sha256': replay.sha(self.source / 'schema.go'),
            'patched_schema_go_sha256': replay.hashlib.sha256(PATCHED).hexdigest(),
            'patch': 'dependency.patch',
        }
        self.write_patch(PATCH)

    def tearDown(self):
        for directory, _, files in os.walk(self.base):
            Path(directory).chmod(0o700)
            for name in files:
                (Path(directory) / name).chmod(0o600)
        shutil.rmtree(self.base)

    def write_patch(self, body):
        self.patch.write_bytes(body.encode())
        self.lock['patch_sha256'] = replay.sha(self.patch)
        (self.root / 'gateway/build/jsonschema-lock.json').write_text(json.dumps(self.lock))

    def prepare(self):
        env = dict(os.environ, XDG_CONFIG_HOME=str(self.base / 'git-config'), GIT_CONFIG_GLOBAL=os.devnull)
        subprocess.run(['git', 'init', '-q'], cwd=self.output, env=env, check=True)
        (self.output / 'go.mod').write_text('module example.test/replay\n\ngo 1.25\n')
        downloaded = dict(Dir=str(self.source), Sum=self.lock['sum'])
        with patch.object(replay.subprocess, 'check_output', return_value=json.dumps(downloaded)):
            return replay.prepare_jsonschema(self.root, self.output, env)

    def assert_no_replace(self):
        self.assertNotIn('replace', (self.output / 'go.mod').read_text())

    def test_valid_patch(self):
        self.assertEqual(self.prepare(), self.lock)
        self.assertEqual((self.output / '.motai-deps/jsonschema/schema.go').read_bytes(), PATCHED)
        self.assertIn('replace example.test/schema => ./.motai-deps/jsonschema',
                      (self.output / 'go.mod').read_text())
        self.assertEqual((self.source / 'schema.go').read_bytes(), STOCK)

    def test_git_header_patch_applies_inside_output_repo(self):
        self.write_patch('diff --git a/schema.go b/schema.go\n' + PATCH)
        self.assertEqual(self.prepare(), self.lock)
        self.assertEqual((self.output / '.motai-deps/jsonschema/schema.go').read_bytes(), PATCHED)
        self.assertIn('replace example.test/schema => ./.motai-deps/jsonschema',
                      (self.output / 'go.mod').read_text())

    def test_changed_result_rejected(self):
        changed = PATCH.replace('@@ -1,3 +1,3 @@', '@@ -1,3 +1,4 @@').replace(
            '+var Original = false\n', '+var Original = false\n+var Unexpected = true\n')
        self.write_patch(changed)
        with self.assertRaisesRegex(ValueError, 'patched source mismatch'):
            self.prepare()
        self.assertIn(b'Unexpected', (self.output / '.motai-deps/jsonschema/schema.go').read_bytes())
        self.assert_no_replace()

    @unittest.skipUnless(hasattr(os, 'fork') and os.getuid() == 0,
                         'requires Linux root to drop to uid 65534')
    def test_readonly_cache_nonroot(self):
        self.base.chmod(0o755)
        self.source.chmod(0o555)
        for name in ('schema.go', 'LICENSE'):
            (self.source / name).chmod(0o444)
        os.chown(self.output, 65534, 65534)
        pid = os.fork()
        if pid == 0:
            try:
                os.setgroups([])
                os.setgid(65534)
                os.setuid(65534)
                self.test_valid_patch()
                self.assertEqual((self.output / '.motai-deps/jsonschema').stat().st_mode & 0o777, 0o755)
            except BaseException:
                import traceback
                traceback.print_exc()
                os._exit(1)
            os._exit(0)
        _, status = os.waitpid(pid, 0)
        self.assertEqual(os.waitstatus_to_exitcode(status), 0)
        self.assertEqual(self.source.stat().st_mode & 0o777, 0o555)
        for name in ('schema.go', 'LICENSE'):
            self.assertEqual((self.source / name).stat().st_mode & 0o777, 0o444)


if __name__ == '__main__':
    unittest.main(verbosity=2)
