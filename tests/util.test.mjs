/**
 * Helper tests — path handling, naming collisions and retry behaviour.
 * Boring, but this is where "it silently overwrote my file" bugs live.
 */
import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
import assert from 'node:assert/strict';
import {
  formatBytes, normalizePath, joinPath, dirName, baseName, extOf, encodePath,
  safeFileName, safeFolder, uniquePath, kindOf, mimeOf, isTextLike,
  b64encode, b64decode, toBytes, utf8, fromUtf8, withRetry, codedError, timeAgo,
} from '../app/core/util.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);

test('path helpers normalise separators and traversal attempts', () => {
  assert.equal(normalizePath('a\\b/c'), 'a/b/c');
  assert.equal(normalizePath('/leading//double/'), 'leading/double');
  assert.equal(normalizePath('../../etc/passwd'), 'etc/passwd', '.. segments are dropped, not resolved');
  assert.equal(joinPath('photos', '2026', 'a.jpg'), 'photos/2026/a.jpg');
  assert.equal(dirName('photos/2026/a.jpg'), 'photos/2026');
  assert.equal(dirName('a.jpg'), '');
  assert.equal(baseName('photos/a.jpg'), 'a.jpg');
  assert.equal(extOf('photos/archive.tar.gz'), 'gz');
  assert.equal(extOf('noext'), '');
});

test('encodePath escapes segments but keeps the tree structure', () => {
  assert.equal(encodePath('my photos/holiday 2026.jpg'), 'my%20photos/holiday%202026.jpg');
  assert.equal(encodePath('a/b#c?d.png'), 'a/b%23c%3Fd.png');
});

test('filenames are sanitised for git and URLs', () => {
  assert.equal(safeFileName('my:file*name?.png'), 'my-file-name-.png');
  assert.equal(safeFileName('   spaced  out.pdf  '), 'spaced out.pdf');
  assert.equal(safeFileName('....'), 'file');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('a'.repeat(400)).length, 120);
  assert.equal(safeFolder('my photos/2026 !!'), 'my photos/2026 !!');
  assert.equal(safeFolder('bad/folder'), 'bad/folder');
});

test('duplicate names get a counter instead of overwriting', () => {
  const taken = new Set(['uploads/a.png']);
  assert.equal(uniquePath('uploads/a.png', taken), 'uploads/a-2.png');
  taken.add('uploads/a-2.png');
  assert.equal(uniquePath('uploads/a.png', taken), 'uploads/a-3.png');
  assert.equal(uniquePath('uploads/b.png', taken), 'uploads/b.png');
  assert.equal(uniquePath('uploads/noext', new Set(['uploads/noext'])), 'uploads/noext-2');
});

test('file kinds and mimes are detected from extensions', () => {
  assert.equal(kindOf('a.PNG'), 'image');
  assert.equal(kindOf('clip.mov'), 'video');
  assert.equal(kindOf('song.flac'), 'audio');
  assert.equal(kindOf('paper.pdf'), 'pdf');
  assert.equal(kindOf('data.csv'), 'doc');
  assert.equal(kindOf('backup.tar'), 'archive');
  assert.equal(kindOf('main.rs'), 'code');
  assert.equal(kindOf('mystery.xyz'), 'other');
  assert.equal(mimeOf('a.png'), 'image/png');
  assert.equal(mimeOf('a.xyz'), 'application/octet-stream');
  ok(isTextLike('notes.md') && isTextLike('cfg.yaml') && !isTextLike('img.png'));
});

test('formatBytes is human-readable at every magnitude', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(1048576), '1.0 MB');
  assert.equal(formatBytes(1024 ** 3), '1.0 GB');
  assert.equal(formatBytes(1024 ** 3 * 3.5), '3.5 GB');
});

test('base64 round-trips arbitrary binary, including >64 KB', () => {
  const big = new Uint8Array(200_000).map((_, i) => (i * 7 + 3) % 256);
  const b64 = b64encode(big);
  assert.deepEqual(Array.from(b64decode(b64)), Array.from(big));
  assert.equal(fromUtf8(utf8('ünïcödé 🔐')), 'ünïcödé 🔐');
  assert.equal(b64encode(utf8('hi')), 'aGk=');
});

test('toBytes accepts the shapes the UI actually produces', async () => {
  assert.deepEqual(Array.from(await toBytes('abc')), [97, 98, 99]);
  assert.deepEqual(Array.from(await toBytes(new Uint8Array([1, 2]))), [1, 2]);
  assert.deepEqual(Array.from(await toBytes(new Uint8Array([3, 4]).buffer)), [3, 4]);
  const view = new Uint16Array([1, 2]).subarray(1);
  assert.equal((await toBytes(view)).length, 2);
  if (typeof Blob !== 'undefined') assert.deepEqual(Array.from(await toBytes(new Blob([new Uint8Array([9, 8])]))), [9, 8]);
  await assert.rejects(() => toBytes(42));
});

test('withRetry retries retryable errors and gives up on the rest', async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw codedError('server', 'boom', { retryable: true });
    return 'ok';
  };
  assert.equal(await withRetry(flaky, { baseDelay: 1 }), 'ok');
  assert.equal(calls, 3);

  let fatal = 0;
  await assert.rejects(() => withRetry(async () => { fatal++; throw codedError('auth', 'nope'); }, { baseDelay: 1 }));
  assert.equal(fatal, 1, 'non-retryable errors surface immediately');

  let exhausted = 0;
  await assert.rejects(() => withRetry(async () => { exhausted++; throw codedError('server', 'boom', { retryable: true }); }, { retries: 2, baseDelay: 1 }));
  assert.equal(exhausted, 3, 'one attempt + two retries');
});

test('withRetry honours a server-supplied retryAfterMs', async () => {
  const waits = [];
  const started = Date.now();
  await withRetry(async () => {
    if (waits.length === 0) { waits.push(1); throw codedError('rate-limit', 'slow down', { retryable: true, retryAfterMs: 60 }); }
    return 'done';
  }, { baseDelay: 5000, onRetry: (e, n, wait) => waits.push(wait) });
  ok(Date.now() - started < 1000, 'used the 60ms hint instead of the 5s backoff');
});

test('timeAgo renders compact relative times', () => {
  const now = Date.now();
  assert.equal(timeAgo(now - 5_000), 'just now');
  assert.equal(timeAgo(now - 5 * 60_000), '5m ago');
  assert.equal(timeAgo(now - 3 * 3_600_000), '3h ago');
  assert.equal(timeAgo(now - 4 * 86_400_000), '4d ago');
  assert.equal(timeAgo(null), 'unknown');
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
console.log(`\n  utils: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
