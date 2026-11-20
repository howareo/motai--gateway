import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('public_release', Path(__file__).with_name('prepare-public-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class PublicReleasePolicy(unittest.TestCase):
    def test_full_runtime_and_required_patch_are_included(self):
        for path in ('src/server.js', 'public/app.js', 'gateway/core/overlay/cmd/motai/main.go',
                     'test/gateway-editors.browser.html',
                     'gateway/core/source/new-api-rc25-maintained.tar.gz', 'patches/required.patch'):
            self.assertTrue(release.allowed(path, {'patches/required.patch'}), path)

    def test_private_material_and_unrelated_history_are_excluded(self):
        for path in ('.env', '.migration-private/token.txt', 'artifacts/request.json',
                     'verification/log.json', 'scripts/rollback-local.ps1',
                     'patches/old-debug.patch', 'src/.git/config',
                     'test/codex-example.verification.txt',
                     'gateway/build/production-verification.json'):
            self.assertFalse(release.allowed(path, set()), path)

    def test_secret_reports_never_contain_the_secret(self):
        value = b'github_pat_' + b'AbCdEfGh1234567890' * 4
        found = release.findings('sample.txt', b'first line\n' + value)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]['line'], 2)
        self.assertNotIn(value.decode(), str(found))

    def test_repeated_fixture_key_is_not_an_account(self):
        self.assertEqual(release.findings('test.js', b'sk-' + b'a' * 40), [])

    def test_pem_parser_markers_are_not_private_keys(self):
        self.assertEqual(release.findings('parser.go', b'"-----BEGIN PRIVATE KEY-----"'), [])
        pem = b'-----BEGIN PRIVATE KEY-----\n' + b'QUJDZGVmMDEyMzQ1Njc4OQ==' * 4 + b'\n-----END PRIVATE KEY-----'
        self.assertEqual(len(release.findings('private.pem', pem)), 1)

    def test_reviewed_literal_is_scoped_to_exact_file(self):
        value = b'github_pat_' + b'AbCdEfGh1234567890' * 4
        fingerprint = release.findings('fixture.js', value)[0]['fingerprint']
        with patch.object(release, 'REVIEWED_LITERALS', {('fixture.js', fingerprint)}):
            self.assertEqual(release.findings('fixture.js', value), [])
            self.assertEqual(len(release.findings('production.js', value)), 1)


if __name__ == '__main__':
    unittest.main()
