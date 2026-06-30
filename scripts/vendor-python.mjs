import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const target = join(root, 'vendor', 'python');

const candidates = [
  process.env.PYTHON,
  process.platform === 'win32' ? 'python' : 'python3',
  'python3',
  'python',
].filter(Boolean);

let python = null;
for (const executable of [...new Set(candidates)]) {
  const check = spawnSync(
    executable,
    ['-m', 'pip', '--version'],
    { cwd: root, stdio: 'ignore' },
  );
  if (!check.error && check.status === 0) {
    python = executable;
    break;
  }
}

if (!python && existsSync(join(target, 'can', '__init__.py'))) {
  console.log(`Reusing existing portable Python packages in ${target}`);
  process.exit(0);
}
if (!python) {
  throw new Error('Could not find Python with pip to vendor the dependencies.');
}

if (existsSync(target)) rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });

const install = spawnSync(python, [
  '-m', 'pip', 'install',
  '--disable-pip-version-check',
  '--no-cache-dir',
  '--no-compile',
  '--target', target,
  '-r', join(root, 'requirements.txt'),
], { cwd: root, stdio: 'inherit' });
if (install.error || install.status !== 0) {
  throw new Error('Could not vendor the Python dependencies.');
}

function prune(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__pycache__') {
        rmSync(filename, { recursive: true, force: true });
      } else {
        prune(filename);
      }
    } else if (/\.(?:pyc|pyd|so)$/.test(entry.name)) {
      // python-can and its dependencies all provide pure-Python fallbacks.
      // Removing host-native extensions keeps this vendor tree ARM-portable.
      rmSync(filename, { force: true });
    }
  }
}

prune(target);
console.log(`Vendored Raspberry Pi Python packages in ${target}`);
