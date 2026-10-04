#!/usr/bin/env node
/** Runs every suite in one process tree and aggregates the result. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const suites = [
  'tests/util.test.mjs',
  'tests/crypto.test.mjs',
  'tests/github.test.mjs',
  'tests/vault.test.mjs',
  'tests/lock.test.mjs',
  'tests/pwa.test.mjs',
  'tests/reclaim.test.mjs',
  'tests/bundle.test.mjs',
];

let failed = 0;
for (const suite of suites) {
  console.log(`\n\u001b[1m${suite}\u001b[0m`);
  const res = spawnSync(process.execPath, [join(root, suite)], { stdio: 'inherit', cwd: root });
  if (res.status !== 0) failed++;
}
console.log(failed ? `\n\u001b[31m${failed} suite(s) failed\u001b[0m` : '\n\u001b[32mAll suites passed\u001b[0m');
process.exit(failed ? 1 : 0);
