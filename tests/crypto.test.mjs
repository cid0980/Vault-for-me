/**
 * Encryption tests — the format is the contract, so these assert byte-level
 * behaviour: magic bytes, chunk independence, tamper detection, ordering.
 */
import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
import assert from 'node:assert/strict';
import { deriveVaultKey, encryptBytes, decryptBytes, isEncryptedBytes, peekHeader, randomBytes } from '../app/core/crypto.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);

const KEY = await deriveVaultKey('correct horse battery staple', randomBytes(16), 1000);
const random = (n) => new Uint8Array(n).map((_, i) => (i * 37 + 11) % 256);

test('round-trips every awkward size around the chunk boundary', async () => {
  const chunkSize = 1024;
  for (const size of [0, 1, 15, 255, 1023, 1024, 1025, 2048, 3000]) {
    const input = random(size);
    const { data } = await encryptBytes(input, KEY, { chunkSize, meta: { name: 'f.bin', type: 'application/octet-stream' } });
    ok(isEncryptedBytes(data), `magic present for size ${size}`);
    const out = await decryptBytes(data, KEY);
    assert.deepEqual(Array.from(out.data), Array.from(input), `payload mismatch at size ${size}`);
  }
});

test('header metadata survives the round-trip (original name and mime)', async () => {
  const { data } = await encryptBytes(random(10), KEY, { chunkSize: 1024, meta: { name: 'holiday photo.jpg', type: 'image/jpeg' } });
  const { header } = await decryptBytes(data, KEY);
  assert.equal(header.name, 'holiday photo.jpg');
  assert.equal(header.type, 'image/jpeg');
  assert.equal(header.size, 10);
  assert.equal(header.v, 1);
  assert.equal(header.alg, 'A256GCM');
  ok(peekHeader(data).name === 'holiday photo.jpg', 'peekHeader reads metadata without the key');
});

test('ciphertext contains no plaintext (the point of the exercise)', async () => {
  const secret = 'MY-DATABASE-PASSWORD-hunter2';
  const { data } = await encryptBytes(new TextEncoder().encode(secret), KEY, { chunkSize: 1024 });
  const asLatin = Buffer.from(data).toString('latin1');
  ok(!asLatin.includes('hunter2'), 'plaintext must not leak into ciphertext');
  ok(!Buffer.from(data).toString('base64').includes('aHVudGVy'), 'nor via base64');
});

test('two encryptions of the same file differ (fresh IV per file, per chunk material)', async () => {
  const input = random(2048);
  const a = await encryptBytes(input, KEY, { chunkSize: 1024 });
  const b = await encryptBytes(input, KEY, { chunkSize: 1024 });
  ok(Buffer.compare(Buffer.from(a.data), Buffer.from(b.data)) !== 0, 'outputs must differ');
  assert.equal(peekHeader(a.data).iv === peekHeader(b.data).iv, false, 'IVs differ');
});

test('wrong key is rejected with a typed error', async () => {
  const { data } = await encryptBytes(random(500), KEY, { chunkSize: 256 });
  const otherKey = await deriveVaultKey('the-wrong-password', randomBytes(16), 1000);
  await assert.rejects(() => decryptBytes(data, otherKey), (e) => e.code === 'bad-password');
});

test('tampering with any ciphertext byte is detected', async () => {
  const { data } = await encryptBytes(random(3000), KEY, { chunkSize: 1024 });
  for (const index of [400, 1200, data.length - 5]) { // inside the ciphertext body
    const copy = data.slice();
    copy[index] ^= 0x40;
    await assert.rejects(() => decryptBytes(copy, KEY), (e) => e.code === 'bad-password', `byte ${index} slipped through`);
  }
});

test('corrupting the cleartext header is caught too (malformed, or AAD mismatch)', async () => {
  const { data } = await encryptBytes(random(3000), KEY, { chunkSize: 1024 });
  for (const index of [10, 40]) { // inside the JSON header
    const copy = data.slice();
    copy[index] ^= 0x40;
    await assert.rejects(
      () => decryptBytes(copy, KEY),
      (e) => ['malformed', 'bad-password'].includes(e.code),
      `header byte ${index} slipped through`,
    );
  }
});

test('swapping two chunks is detected (chunk index is authenticated)', async () => {
  const chunkSize = 1024;
  const { data } = await encryptBytes(random(2048), KEY, { chunkSize });
  const headerLen = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(5, true);
  const bodyStart = 9 + headerLen;
  const ctLen = chunkSize + 16;
  const swapped = data.slice();
  const first = swapped.slice(bodyStart, bodyStart + ctLen);
  const second = swapped.slice(bodyStart + ctLen, bodyStart + 2 * ctLen);
  swapped.set(second, bodyStart);
  swapped.set(first, bodyStart + ctLen);
  await assert.rejects(() => decryptBytes(swapped, KEY), (e) => e.code === 'bad-password', 'reordering must fail');
});

test('editing the header (e.g. the size) is detected — the header is authenticated', async () => {
  const { data } = await encryptBytes(random(100), KEY, { chunkSize: 1024 });
  const text = Buffer.from(data).toString('latin1');
  const tampered = Buffer.from(text.replace('"size":100', '"size":200'), 'latin1');
  await assert.rejects(() => decryptBytes(new Uint8Array(tampered), KEY));
});

test('progress callbacks report per chunk and finish at 1', async () => {
  const seen = [];
  await encryptBytes(random(3000), KEY, { chunkSize: 1024, onProgress: (f) => seen.push(f) });
  assert.deepEqual(seen, [1 / 3, 2 / 3, 1]);
});

test('non-vault bytes are rejected cleanly, not crashed on', async () => {
  await assert.rejects(() => decryptBytes(new TextEncoder().encode('just a normal file'), KEY), (e) => e.code === 'not-encrypted');
  assert.equal(isEncryptedBytes(new Uint8Array([1, 2, 3])), false);
});

test('a 6 MB file round-trips with the production chunk size', async () => {
  const input = new Uint8Array(6 * 1024 * 1024).map((_, i) => (i * 17) % 256);
  const { data } = await encryptBytes(input, KEY, { meta: { name: 'video.mp4', type: 'video/mp4' } });
  const out = await decryptBytes(data, KEY);
  assert.equal(out.data.length, input.length);
  ok(Buffer.compare(Buffer.from(out.data.subarray(0, 4096)), Buffer.from(input.subarray(0, 4096))) === 0, 'prefix matches');
  assert.equal(out.data[input.length - 1], input[input.length - 1], 'last byte matches');
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
console.log(`\n  crypto: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
