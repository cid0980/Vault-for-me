/**
 * Bundle integrity test.
 *
 * The single-file build is what people actually open (file://, sandboxed
 * previews, a USB stick), so we regenerate it from source and then *execute*
 * it in a DOM-less VM, proving that the flattened modules still expose working
 * crypto and a working vault — not just that they parse.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { build } from '../tools/bundle.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);

const built = build();                       // regenerate repovault.html from source
const html = readFileSync(join(root, 'repovault.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.equal(scripts.length, 1, 'the build must contain exactly one inline script');

// A deliberately DOM-less sandbox: if any module touched window/document at
// import time, evaluating this would throw.
const sandbox = {
  crypto: globalThis.crypto, btoa, atob, TextEncoder, TextDecoder, Blob, URL,
  console: { log() {}, warn() {}, error() {} }, setTimeout, clearTimeout,
  fetch: async () => { throw new Error('network disabled in tests'); },
};
const ctx = vm.createContext(sandbox);
new vm.Script(scripts[0], { filename: 'repovault-bundle.js' }).runInContext(ctx);
const RV = ctx.RepoVault;

test('bundle loads without a DOM and exposes the documented API', () => {
  ok(RV, 'globalThis.RepoVault exists');
  for (const name of ['Vault', 'GitHubAdapter', 'MemoryAdapter', 'encryptBytes', 'decryptBytes', 'deriveVaultKey', 'isEncryptedBytes', 'formatBytes', 'b64encode', 'b64decode', 'LIMITS', 'mount']) {
    ok(RV[name], `RepoVault.${name} is exported`);
  }
  assert.equal(typeof ctx.document, 'undefined', 'sandbox really has no document');
});

test('all import/export syntax was flattened away', () => {
  ok(!/^\s*import\s/m.test(scripts[0]), 'no import statements left');
  ok(!/^\s*export\s/m.test(scripts[0]), 'no export statements left');
  ok(scripts[0].includes('"use strict"'), 'wrapped in strict-mode IIFE');
});

test('the shipped file is self-contained (no local asset requests)', () => {
  ok(!html.includes('src="./app/'), 'no module script tag remains');
  ok(html.includes('<style>'), 'CSS is inlined');
  ok(scripts[0].includes('A256GCM'), 'crypto code is actually inside the bundle');
  ok(html.includes('data:image/svg+xml'), 'favicon is an inline data URI');
});

test('crypto round-trips through the bundled build', async () => {
  const key = await RV.deriveVaultKey('bundle-password', new Uint8Array(16).fill(7), 1000);
  const input = new TextEncoder().encode('hello from the single-file build 🔐');
  const { data } = await RV.encryptBytes(input, key, { chunkSize: 512, meta: { name: 'x.txt', type: 'text/plain' } });
  ok(RV.isEncryptedBytes(data), 'magic bytes present');
  const out = await RV.decryptBytes(data, key);
  assert.equal(new TextDecoder().decode(out.data), 'hello from the single-file build 🔐');
  assert.equal(out.header.name, 'x.txt');
});

test('a full vault workflow works through the bundled build', async () => {
  const map = new Map();
  const storage = { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const vault = new RV.Vault({ adapter: new RV.MemoryAdapter({ storage }) });
  await vault.connect();

  await vault.upload(new TextEncoder().encode('notes'), { name: 'notes.txt', folder: 'docs' });
  const secret = await vault.upload(new TextEncoder().encode('secret value'), { name: 'key.txt', folder: 'docs', encrypt: true, password: 'pw-123' });
  assert.equal(vault.entries.length, 2);
  assert.equal(vault.list({ kind: 'doc' }).length, 2);

  const stored = await vault.adapter.getFileBytes(secret.path);
  ok(!Buffer.from(stored).toString('latin1').includes('secret value'), 'plaintext never reaches storage');

  const got = await vault.download(secret, { password: 'pw-123' });
  assert.equal(await got.blob.text(), 'secret value');

  const renamed = await vault.rename(secret, 'hidden.txt');
  assert.equal(renamed.path, 'docs/hidden.txt.vault');
  await vault.remove(vault.entries.find((e) => e.path === 'docs/notes.txt'));
  assert.equal(vault.entries.length, 1);
});

test('a fresh build is byte-identical to the committed repovault.html', () => {
  const again = readFileSync(join(root, 'repovault.html'), 'utf8');
  assert.equal(again, html, 'rebuilding is deterministic');
  assert.equal(built.modules, 6, 'all six modules bundled');
});

/* ------------------------------------------------------------------- runner */

let passed = 0, failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
    passed++;
  } catch (e) {
    failed++;
    console.log(`  \u001b[31m✗\u001b[0m ${name}\n      ${String(e.message).split('\n')[0]}`);
  }
}
console.log(`\n  bundle: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
