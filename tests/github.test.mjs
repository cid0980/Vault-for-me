/**
 * GitHub adapter tests — run against the mock API in tests/helpers/mock-github.mjs.
 * These cover the paths that actually break in the wild: empty repos, sha
 * requirements on overwrite, the 100 MB wall, rate limits and ref races.
 */
import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
import assert from 'node:assert/strict';
import { GitHubAdapter } from '../app/adapters/github.js';
import { withRetry, b64decode } from '../app/core/util.js';
import { createMockGitHub } from './helpers/mock-github.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);
const enc = new TextEncoder();

function adapterFor(mock, opts = {}) {
  return new GitHubAdapter({
    owner: 'octo', repo: 'vault', branch: 'main', token: 'test-token',
    fetchImpl: mock.fetchImpl, smallFileThreshold: 4096, maxFileBytes: 1 << 20, ...opts,
  });
}

/* ------------------------------------------------------------------ basics */

test('empty repository gets bootstrapped with an initial commit', async () => {
  const mock = createMockGitHub({ empty: true });
  const gh = adapterFor(mock);
  assert.equal(gh._headCache, null);
  await assert.rejects(() => gh.getHead(), (e) => e.code === 'empty-repo');

  const info = await gh.ensureInitialized();
  ok(info.defaultBranch === 'main', 'default branch detected');
  const initPut = mock.callsTo('PUT /repos/octo/vault/contents/.vault/init.json');
  assert.equal(initPut.length, 1, 'init file written once');
  const head = await gh.getHead({ fresh: true });
  ok(/^[a-f0-9]{40}$/.test(head.sha), 'repo now has a head commit');

  // and it is idempotent
  await gh.ensureInitialized();
  assert.equal(mock.callsTo('PUT /repos/octo/vault/contents/.vault/init.json').length, 1, 'no duplicate bootstrap');
});

test('small upload uses the Contents API and stores exact bytes', async () => {
  const mock = createMockGitHub({ empty: true });
  const gh = adapterFor(mock);
  await gh.ensureInitialized();
  const payload = enc.encode('hello vault 👋');
  const res = await gh.putFile('uploads/hello.txt', payload, { message: 'add hello' });

  const puts = mock.callsTo('PUT /repos/octo/vault/contents/uploads/hello.txt');
  assert.equal(puts.length, 1, 'exactly one contents PUT');
  assert.equal(puts[0].body.message, 'add hello');
  assert.equal(puts[0].body.branch, 'main');
  assert.deepEqual(Array.from(b64decode(puts[0].body.content)), Array.from(payload), 'base64 body matches payload');
  ok(res.commit && res.commit.length === 40, 'a commit sha is returned');
  assert.deepEqual(Array.from(mock.bytesOf('uploads/hello.txt')), Array.from(payload), 'stored bytes match');
});

test('large upload goes through blobs → tree → commit → ref', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock);
  const payload = new Uint8Array(9000).map((_, i) => (i * 31) % 251);
  await gh.putFile('uploads/big.bin', payload, { message: 'add big' });

  const log = mock.requestLog.map((r) => `${r.method} ${r.path.replace('/repos/octo/vault', '')}`);
  const iBlob = log.findIndex((l) => l === 'POST /git/blobs');
  const iTree = log.findIndex((l) => l === 'POST /git/trees');
  const iCommit = log.findIndex((l) => l === 'POST /git/commits');
  const iRef = log.findIndex((l) => l === 'PATCH /git/refs/heads/main');
  ok(iBlob >= 0 && iTree > iBlob && iCommit > iTree && iRef > iCommit, 'correct call order: ' + log.join(' → '));

  const blobBody = mock.requestLog[iBlob].body;
  assert.equal(blobBody.encoding, 'base64');
  assert.deepEqual(Array.from(b64decode(blobBody.content)), Array.from(payload), 'blob content matches');

  const treeBody = mock.requestLog[iTree].body;
  assert.equal(treeBody.tree[0].path, 'uploads/big.bin');
  assert.equal(treeBody.tree[0].mode, '100644');
  ok(!!treeBody.base_tree, 'tree is based on the current head');

  const commitBody = mock.requestLog[iCommit].body;
  assert.equal(commitBody.parents.length, 1, 'commit has the previous head as parent');
  assert.deepEqual(Array.from(mock.bytesOf('uploads/big.bin')), Array.from(payload), 'stored bytes match');

  // and the file reads back byte-for-byte through the raw contents endpoint
  const round = await gh.getFileBytes('uploads/big.bin');
  assert.deepEqual(Array.from(round), Array.from(payload), 'read back matches');
});

test('content-type header is sent and the API version is pinned', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock);
  await gh.getRepo();
  const req = mock.requestLog[0];
  assert.equal(req.headers.Authorization, 'Bearer test-token');
  assert.equal(req.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(req.headers.Accept, 'application/vnd.github+json');
});

test('overwriting an existing file recovers from the missing-sha 422', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'uploads/note.txt': 'v1' } });
  const gh = adapterFor(mock);
  await gh.putFile('uploads/note.txt', enc.encode('v2'), { message: 'update note' });

  const puts = mock.callsTo('PUT /repos/octo/vault/contents/uploads/note.txt');
  assert.equal(puts.length, 2, 'first attempt rejected, second supplied sha');
  ok(puts[1].body.sha, 'retry includes the sha');
  assert.equal(new TextDecoder().decode(mock.bytesOf('uploads/note.txt')), 'v2', 'file updated');
});

test('listing excludes the system folder unless asked', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'uploads/a.png': 'x', '.vault/salt.b64': 'salt', 'photos/b.jpg': 'y' } });
  const gh = adapterFor(mock);
  const user = await gh.listFiles();
  assert.deepEqual(user.files.map((f) => f.path).sort(), ['photos/b.jpg', 'uploads/a.png']);
  const all = await gh.listFiles({ includeSystem: true });
  assert.equal(all.files.length, 3);
  const prefixed = await gh.listFiles({ prefix: 'photos' });
  assert.deepEqual(prefixed.files.map((f) => f.path), ['photos/b.jpg']);
  ok(user.files.every((f) => typeof f.size === 'number' && f.sha), 'entries carry size + sha');
});

/* ------------------------------------------------------------------ mutate */

test('delete removes the path in a single commit', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'uploads/gone.txt': 'bye' } });
  const gh = adapterFor(mock);
  await gh.deleteFile('uploads/gone.txt');
  const treeReq = mock.callsTo('POST /repos/octo/vault/git/trees')[0];
  assert.equal(treeReq.body.tree[0].sha, null, 'null sha deletes the path');
  assert.equal(mock.bytesOf('uploads/gone.txt'), null, 'file is gone from the tree');
});

test('move does not re-upload the blob, even for a big file', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock);
  const payload = new Uint8Array(9000).fill(7);
  await gh.putFile('uploads/movie.mp4', payload, { message: 'add movie' });
  const blobsBefore = mock.callsTo('POST /repos/octo/vault/git/blobs').length;

  const listing = await gh.listFiles();
  const sha = listing.files.find((f) => f.path === 'uploads/movie.mp4').sha;
  await gh.moveFile('uploads/movie.mp4', 'archive/movie.mp4', { sha, message: 'move movie' });

  assert.equal(mock.callsTo('POST /repos/octo/vault/git/blobs').length, blobsBefore, 'no blob upload during move');
  const treeReq = mock.callsTo('POST /repos/octo/vault/git/trees').at(-1);
  const paths = treeReq.body.tree.map((e) => e.path + (e.sha === null ? ' (deleted)' : ''));
  assert.deepEqual(paths.sort(), ['archive/movie.mp4', 'uploads/movie.mp4 (deleted)']);
  assert.deepEqual(Array.from(mock.bytesOf('archive/movie.mp4')), Array.from(payload), 'bytes intact after move');
});

/* ------------------------------------------------------------------ errors */

test('files over the limit are rejected before any network call', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock, { maxFileBytes: 1024 });
  await assert.rejects(() => gh.putFile('uploads/huge.bin', new Uint8Array(2048)), (e) => e.code === 'too-large' && /100 MB/.test(e.message));
  assert.equal(mock.requestLog.length, 0, 'nothing was sent');
});

test('bad token → non-retryable auth error', async () => {
  const mock = createMockGitHub({ empty: false });
  mock.state.inject.push(() => ({ status: 401, body: { message: 'Bad credentials' } }));
  const gh = adapterFor(mock);
  await assert.rejects(() => gh.getRepo(), (e) => e.code === 'auth' && e.retryable === false && e.status === 401);
});

test('rate limit is surfaced as retryable and withRetry backs off then succeeds', async () => {
  const mock = createMockGitHub({ empty: true });
  mock.state.inject.push(() => ({ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1), 'retry-after': '0' } }));
  const gh = adapterFor(mock);
  const retries = [];
  const info = await withRetry(() => gh.ensureInitialized(), { retries: 2, baseDelay: 10, onRetry: (e, n) => retries.push([e.code, n]) });
  ok(info.fullName === 'octo/vault', 'recovered after backoff');
  assert.deepEqual(retries, [['rate-limit', 1]], 'exactly one retry, tagged rate-limit');
});

test('a concurrent push is detected and the commit is rebased onto it', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'uploads/mine.txt': 'mine' } });
  const gh = adapterFor(mock);
  const EXTERNAL = 'b'.repeat(40);

  // Another tab commits while we upload, then our ref update is rejected once.
  mock.state.inject.push((req, state) => {
    if (!req.pathname.endsWith('/git/refs/heads/main')) return undefined;
    const currentTree = new Map(state.trees.get(state.commits.get(state.head).tree));
    const blobSha = [...state.blobs.keys()][0];
    currentTree.set('uploads/other.txt', blobSha);
    state.trees.set('a'.repeat(40), currentTree);
    state.commits.set(EXTERNAL, { tree: 'a'.repeat(40), parents: [state.head], message: 'other tab' });
    state.head = EXTERNAL;
    return { status: 422, body: { message: 'Update is not a fast forward' } };
  });

  // 9 KB payload → forces the Git Data path (blobs/trees/commits/refs)
  const payload = new Uint8Array(9000).fill(42);
  await gh.putFile('uploads/mine.txt', payload, { message: 'update mine' });

  const refPatches = mock.callsTo('PATCH /repos/octo/vault/git/refs/heads/main');
  assert.equal(refPatches.length, 2, 'ref update retried after the conflict');
  const lastCommit = mock.requestLog.filter((r) => r.method === 'POST' && r.path.endsWith('/git/commits')).at(-1);
  assert.equal(lastCommit.body.parents[0], EXTERNAL, 'final commit sits on top of the other tab\u2019s commit');
  assert.deepEqual(Array.from(mock.bytesOf('uploads/mine.txt')), Array.from(payload), 'our version won');
  ok(mock.bytesOf('uploads/other.txt'), 'the other tab\u2019s file survived (no clobbering)');
});

/* ---------------------------------------------------------------- adapter API */

test('publicUrl is a raw link with encoded path segments', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock);
  assert.equal(
    gh.publicUrl('my photos/holiday 2026.jpg'),
    'https://raw.githubusercontent.com/octo/vault/main/my%20photos/holiday%202026.jpg',
  );
});

test('usage reports repo size against the 1 GB soft limit', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'a.bin': new Uint8Array(2048) } });
  const gh = adapterFor(mock);
  const usage = await gh.usage();
  ok(usage.usedBytes > 0, 'some bytes used');
  assert.equal(usage.softLimitBytes, 1024 * 1024 * 1024);
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
console.log(`\n  github adapter: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
