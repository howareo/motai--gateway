// Syntax-check every console source file so new modules cannot slip past `npm run check`.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const roots = ['src', 'public'];
const files = roots.flatMap((root) => readdirSync(root, { recursive: true })
  .filter((name) => /\.(?:m?js)$/.test(name))
  .map((name) => path.join(root, name)))
  .sort();

let failed = 0;
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    failed += 1;
    process.stderr.write(`${file}\n${error.stderr}`);
  }
}
console.log(`syntax check: ${files.length - failed}/${files.length} files ok`);
process.exitCode = failed ? 1 : 0;
