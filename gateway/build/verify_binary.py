#!/usr/bin/env python3
"""Check the gateway executable in its runtime image without config or network."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess


def verify_runtime(binary, image):
    binary = Path(binary).resolve(strict=True)
    image_id = subprocess.check_output(
        ['docker', 'image', 'inspect', '--format', '{{.Id}}', image], text=True, timeout=10).strip()
    result = subprocess.run([
        'docker', 'run', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--mount',
        f'type=bind,source={binary},target=/candidate/motai-gateway,readonly',
        '--entrypoint', '/candidate/motai-gateway', image_id, '--check-executable-only',
    ], capture_output=True, text=True, timeout=20)
    # main rejects arguments before loading config, opening the database or starting work.
    if result.returncode != 1 or result.stdout or result.stderr.strip() != 'motai candidate initialization failed':
        raise ValueError(f'gateway cannot execute in runtime image (exit={result.returncode})')
    return {'binary_sha256': hashlib.sha256(binary.read_bytes()).hexdigest(),
            'image_id': image_id, 'entrypoint_reached': True}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=Path, required=True)
    parser.add_argument('--image', required=True)
    args = parser.parse_args()
    print(json.dumps(verify_runtime(args.binary, args.image)))
