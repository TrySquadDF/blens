import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageDir = join(root, 'packages/blens');
const temporary = mkdtempSync(join(tmpdir(), 'blens-package-'));

try {
  // The build and full suite run before this command in CI and release scripts.
  const packed = JSON.parse(execFileSync('npm', [
    'pack', '--ignore-scripts', '--json', '--pack-destination', temporary,
  ], { cwd: packageDir, encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  const files = new Set(packed[0].files.map(({ path }) => path));
  for (const file of ['package.json', 'README.md', 'LICENSE', 'CHANGELOG.md',
    'dist/index.mjs', 'dist/index.d.mts']) {
    assert.ok(files.has(file), `Missing npm package file: ${file}`);
  }
  for (const file of files) {
    assert.ok(!/^(?:src|test|bench|node_modules|\.cache|coverage)\//.test(file),
      `Unexpected npm package file: ${file}`);
  }

  writeFileSync(join(temporary, 'package.json'), JSON.stringify({
    name: 'blens-consumer-check', private: true, type: 'module',
  }));
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund',
    '--package-lock=false', join(temporary, packed[0].filename)], {
    cwd: temporary, stdio: 'inherit',
  });
  const installed = JSON.parse(readFileSync(
    join(temporary, 'node_modules/blens/package.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
  assert.equal(installed.name, 'blens');
  assert.equal(installed.version, source.version);

  copyFileSync(join(packageDir, 'test/platform/node.mjs'), join(temporary, 'package.test.mjs'));
  execFileSync(process.execPath, ['--test', 'package.test.mjs'], {
    cwd: temporary, stdio: 'inherit',
  });
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
