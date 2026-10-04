/**
 * Vault (domain layer) tests, driven by the demo adapter so they run offline
 * and describe exactly what the UI does: upload → list → search → preview →
 * rename → delete, with and without encryption.
 */
import assert from 'node:assert/strict';
import { Vault, SALT_PATH, ENC_SUFFIX } from '../app/core/vault.js';
import { MemoryAdapter } from '../app/adapters/memory.js';
import { isEncryptedBytes } from '../app/core/crypto.js';
import { utf8 } from '../app/core/util.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);

function makeStorage() {
  const map = new Map();
  return { getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

async function freshVault() {
  const vault = new Vault({ adapter: new MemoryAdapter({ storage: makeStorage() }) });
  await vault.connect();
  return vault;
}

const file = (name, text) => ({ name, bytes: utf8(text), type: 'text/plain' });

test('connect() reports the backend and starts with an empty index', async () => {
  const vault = await freshVault();
  assert.equal(vault.info.fullName, 'demo/local-vault');
  assert.equal(vault.entries.length, 0);
  assert.equal(vault.summary().count, 0);
});

test('upload → list → search → folders → summary', async () => {
  const vault = await freshVault();
  await vault.upload(file('notes.txt', 'hello').bytes, { name: 'notes.txt', folder: 'uploads' });
  await vault.upload(file('cat.png', 'PNG').bytes, { name: 'cat.png', folder: 'photos' });
  await vault.upload(file('dog.jpg', 'JPG').bytes, { name: 'dog.jpg', folder: 'photos' });

  assert.equal(vault.entries.length, 3);
  assert.deepEqual(vault.folders(), ['photos', 'uploads']);

  assert.deepEqual(vault.list({ kind: 'image' }).map((e) => e.displayName).sort(), ['cat.png', 'dog.jpg']);
  assert.deepEqual(vault.list({ folder: 'photos' }).map((e) => e.displayName).sort(), ['cat.png', 'dog.jpg']);
  assert.deepEqual(vault.list({ query: 'NOT' }).map((e) => e.displayName), ['notes.txt']);
  assert.equal(vault.list({ query: 'nothing-matches' }).length, 0);

  const summary = vault.summary();
  assert.equal(summary.count, 3);
  assert.equal(summary.encrypted, 0);
  assert.equal(summary.byKind.image, 2);
  assert.equal(summary.byKind.doc, 1);
  ok(/B$/.test(summary.human), 'human size string');
});

test('name collisions never overwrite: report.pdf → report-2.pdf', async () => {
  const vault = await freshVault();
  await vault.upload(utf8('one'), { name: 'report.pdf', folder: 'docs' });
  const second = await vault.upload(utf8('two'), { name: 'report.pdf', folder: 'docs' });
  const third = await vault.upload(utf8('three'), { name: 'report.pdf', folder: 'docs' });
  assert.equal(second.path, 'docs/report-2.pdf');
  assert.equal(third.path, 'docs/report-3.pdf');
  const kept = await vault.download(vault.entries.find((e) => e.path === 'docs/report.pdf'));
  assert.equal(await kept.blob.text(), 'one', 'original untouched');
});

test('filenames with hostile characters are stored safely', async () => {
  const vault = await freshVault();
  const entry = await vault.upload(utf8('x'), { name: '../../etc/passwd?.txt', folder: 'uploads' });
  ok(!entry.path.includes('..'), 'no traversal in the stored path: ' + entry.path);
  assert.equal(entry.folder, 'uploads');
  ok(entry.path.startsWith('uploads/'), 'stays inside the target folder');
});

test('download returns a typed Blob for plain files', async () => {
  const vault = await freshVault();
  const entry = await vault.upload(utf8('plain text'), { name: 'note.txt', folder: 'uploads' });
  const got = await vault.download(entry);
  assert.equal(got.decrypted, false);
  assert.equal(got.blob.type, 'text/plain');
  assert.equal(await got.blob.text(), 'plain text');
  assert.equal(await vault.text(entry), 'plain text');
});

test('encrypted upload: ciphertext on the backend, plaintext only with the password', async () => {
  const vault = await freshVault();
  const secret = 'ssh-rsa AAAAB3NzaC1yc2E SUPER-SECRET';

  const entry = await vault.upload(utf8(secret), {
    name: 'id_rsa.txt', folder: 'secrets', encrypt: true, password: 'vault-password-123',
  });

  assert.ok(entry.encrypted, 'entry marked encrypted');
  assert.equal(entry.path, 'secrets/id_rsa.txt' + ENC_SUFFIX);
  assert.equal(entry.displayName, 'id_rsa.txt', 'name shown without the suffix');
  assert.equal(entry.kind, 'doc', 'kind derived from the original name');

  const stored = await vault.adapter.getFileBytes(entry.path);
  ok(isEncryptedBytes(stored), 'stored payload carries the RVLT1 magic');
  ok(!Buffer.from(stored).toString('latin1').includes('SUPER-SECRET'), 'no plaintext on the backend');

  const salt = await vault.adapter.getFileBytes(SALT_PATH);
  ok(salt.length > 20, 'vault salt file was created');

  const got = await vault.download(entry, { password: 'vault-password-123' });
  assert.equal(got.decrypted, true);
  assert.equal(got.name, 'id_rsa.txt', 'inner filename restored from the encrypted header');
  assert.equal(await got.blob.text(), secret);

  assert.equal(vault.summary().encrypted, 1);
});

test('encrypted files reuse one derived key for the whole session', async () => {
  const vault = await freshVault();
  const a = await vault.upload(utf8('first'), { name: 'a.txt', encrypt: true, password: 'pw-for-the-vault' });
  const firstKey = vault._key;
  const b = await vault.upload(utf8('second'), { name: 'b.txt', encrypt: true, password: 'ignored-once-unlocked' });
  assert.equal(vault._key, firstKey, 'key reused, no second PBKDF2 run');
  assert.equal(await (await vault.download(b, { password: 'anything' })).blob.text(), 'second');
  assert.equal(a.encrypted && b.encrypted, true);
});

test('wrong vault password is rejected, and locking requires it again', async () => {
  const vault = await freshVault();
  const entry = await vault.upload(utf8('classified'), { name: 'c.txt', encrypt: true, password: 'right-password' });
  vault.lock();
  await assert.rejects(() => vault.download(entry, { password: 'wrong-password' }), (e) => e.code === 'bad-password');
  await assert.rejects(() => vault.download(entry, { password: '' }), (e) => e.code === 'password-required');
  assert.equal(await (await vault.download(entry, { password: 'right-password' })).blob.text(), 'classified');
});

test('rename keeps the folder, and the .vault suffix on encrypted files', async () => {
  const vault = await freshVault();
  const plain = await vault.upload(utf8('x'), { name: 'old.txt', folder: 'docs' });
  const renamed = await vault.rename(plain, 'new.txt');
  assert.equal(renamed.path, 'docs/new.txt');
  assert.equal(vault.entries.find((e) => e.path === 'docs/old.txt'), undefined);

  const enc = await vault.upload(utf8('y'), { name: 'secret.txt', folder: 'docs', encrypt: true, password: 'pw' });
  const encRenamed = await vault.rename(enc, 'hidden.txt');
  assert.equal(encRenamed.path, 'docs/hidden.txt' + ENC_SUFFIX);
  assert.equal(encRenamed.encrypted, true);
  assert.equal(encRenamed.displayName, 'hidden.txt');
  assert.equal(await (await vault.download(encRenamed, { password: 'pw' })).blob.text(), 'y', 'still decryptable after rename');
});

test('delete removes the entry from the index and the backend', async () => {
  const vault = await freshVault();
  const entry = await vault.upload(utf8('bye'), { name: 'gone.txt', folder: 'uploads' });
  await vault.remove(entry);
  assert.equal(vault.entries.length, 0);
  await assert.rejects(() => vault.adapter.getFileBytes('uploads/gone.txt'), (e) => e.code === 'not-found');
});

test('share links: none for a private backend, deep link fallback in-app', async () => {
  const vault = await freshVault();
  const entry = await vault.upload(utf8('shared'), { name: 'share.txt', folder: 'uploads' });
  assert.equal(vault.shareUrl(entry), null, 'private → not a public URL');
  const deep = vault.shareUrl(entry, 'https://vault.example/app/#old');
  assert.equal(deep, `https://vault.example/app/#repo=demo%2Flocal-vault&path=uploads%2Fshare.txt`);
});

test('progress callbacks are monotonic and end at 1', async () => {
  const vault = await freshVault();
  const seen = [];
  await vault.upload(new Uint8Array(5000).fill(3), { name: 'blob.bin', folder: 'uploads', onProgress: (f) => seen.push(f) });
  ok(seen.length >= 1, 'progress reported');
  assert.equal(seen.at(-1), 1, 'ends at 100%');
  for (let i = 1; i < seen.length; i++) ok(seen[i] >= seen[i - 1], 'never goes backwards');
});

test('oversized uploads are refused with a helpful message', async () => {
  const vault = await freshVault();
  const adapter = vault.adapter;
  adapter.capacity = 10; // pretend the backend is tiny
  await assert.rejects(() => vault.upload(new Uint8Array(5000), { name: 'big.bin' }), (e) => e.code === 'quota');
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
console.log(`\n  vault: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
