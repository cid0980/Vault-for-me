import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
/**
 * Reclaim-space tests: purge history, rebuild the repo, export a ZIP.
 *
 * These assert the *uncomfortable* parts, not just the happy path:
 *   • purging really does drop the old commits from the branch,
 *   • files survive byte-for-byte,
 *   • other branches/tags are reported as blockers for space reclaim,
 *   • rebuilding refuses to delete anything until every file is in memory,
 *   • a failed rebuild keeps the files around so nothing is lost,
 *   • the ZIP is a real ZIP (verified by Python's zipfile, not by our own code).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GitHubAdapter } from '../app/adapters/github.js';
import { MemoryAdapter } from '../app/adapters/memory.js';
import { Vault } from '../app/core/vault.js';
import { createZip, crc32, safeZipPath, exportName } from '../app/core/zip.js';
import { analyseHistory, planRebuild, matchPhrase, commitCountFromLink, PURGE_PHRASE, REBUILD_PHRASE } from '../app/core/purge.js';
import { utf8 } from '../app/core/util.js';
import { createMockGitHub } from './helpers/mock-github.mjs';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);
const enc = new TextEncoder();
const dec = new TextDecoder();

const adapterFor = (mock, opts = {}) => new GitHubAdapter({
  owner: 'octo', repo: 'vault', branch: 'main', token: 't',
  fetchImpl: mock.fetchImpl, smallFileThreshold: 4096, maxFileBytes: 1 << 20, ...opts,
});

/* ------------------------------------------------------------- pure logic */

test('commitCountFromLink reads GitHub pagination correctly', () => {
  const link = '<https://api.github.com/repositories/1/commits?per_page=1&page=2>; rel="next", <https://api.github.com/repositories/1/commits?per_page=1&page=5>; rel="last"';
  assert.equal(commitCountFromLink(link, { perPage: 1 }), 5);
  assert.equal(commitCountFromLink('', { perPage: 1, bodyLength: 1 }), 1, 'no Link header → one page');
  assert.equal(commitCountFromLink(null, { perPage: 1, bodyLength: 0 }), 0, 'empty repo → zero');
  const paged = '<https://api.github.com/x?per_page=30&page=3>; rel="next", <https://api.github.com/x?per_page=30&page=9>; rel="last"';
  assert.equal(commitCountFromLink(paged, { perPage: 30 }), 270);
});

test('matchPhrase is forgiving about case and spaces, strict about everything else', () => {
  ok(matchPhrase('purge', PURGE_PHRASE));
  ok(matchPhrase('  PURGE  ', PURGE_PHRASE));
  ok(!matchPhrase('purge ', 'PURGE!'), 'not a prefix match');
  ok(!matchPhrase('purg', PURGE_PHRASE));
  ok(!matchPhrase('', PURGE_PHRASE));
  ok(!matchPhrase(null, PURGE_PHRASE));
  ok(matchPhrase('rebuild', REBUILD_PHRASE));
});

test('analyseHistory blocks a pointless purge and warns about refs that keep space', () => {
  const minimal = analyseHistory({ commitCount: 1, branches: ['main'], branch: 'main' });
  assert.equal(minimal.canPurge, false);
  ok(minimal.blockers[0].includes('single commit'));

  const messy = analyseHistory({
    commitCount: 42, branches: ['main', 'backup'], tags: ['v1'], branch: 'main',
    fileCount: 10, logicalBytes: 1000, reportedBytes: 9000,
  });
  assert.equal(messy.canPurge, true, 'purging is allowed on main');
  assert.equal(messy.removedCommits, 41);
  assert.equal(messy.historyBytes, 8000, 'history overhead = reported - logical');
  ok(messy.otherBranches.length === 1 && messy.otherBranches[0] === 'backup');
  const all = messy.warnings.join(' ');
  ok(all.includes('backup'), 'warns that another branch holds the old objects');
  ok(all.includes('v1'), 'warns that tags hold old objects');
  ok(/KB|MB/.test(all) && /history/.test(all), 'quantifies the history overhead in human units: ' + all.split('. ')[2]);
});

test('planRebuild refuses what it cannot do safely', () => {
  const noAdmin = planRebuild({ fileCount: 5, totalBytes: 1000, hasAdmin: false });
  assert.equal(noAdmin.canRebuild, false);
  ok(noAdmin.blockers[0].includes('Administration'));

  const empty = planRebuild({ fileCount: 0, hasAdmin: true });
  assert.equal(empty.canRebuild, false);

  const tooBig = planRebuild({ fileCount: 3, totalBytes: 600 * 1024 * 1024, hasAdmin: true });
  assert.equal(tooBig.canRebuild, false);
  ok(tooBig.blockers.join(' ').includes('512'), 'says which limit was hit');

  const fine = planRebuild({ fileCount: 3, totalBytes: 1000, hasAdmin: true });
  assert.equal(fine.canRebuild, true);
  ok(fine.warnings.join(' ').includes('recreated empty'), 'always warns about the destructive middle step');
});

/* ------------------------------------------------------------ ZIP archive */

test('crc32 matches the canonical test vector', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('safeZipPath strips traversal and control characters', () => {
  assert.equal(safeZipPath('uploads/../../etc/passwd'), 'uploads/etc/passwd');
  assert.equal(safeZipPath('/abs/path.txt'), 'abs/path.txt');
  assert.equal(safeZipPath('bad\u0000name.txt'), 'badname.txt');
  assert.equal(safeZipPath(''), 'unnamed');
  assert.equal(exportName(new Date('2026-10-05T12:00:00Z')).startsWith('repovault-2026-10-0'), true, 'dated filename');
});

test('createZip emits a real archive that Python zipfile can verify and extract', () => {
  const files = [
    { name: 'notes.txt', data: enc.encode('hello vault') },
    { name: 'photos/cat.png', data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]) },
    { name: 'data/empty.bin', data: new Uint8Array(0) },
    { name: 'secret.txt.vault', data: new Uint8Array(600).fill(9) },
  ];
  const zip = createZip(files, { date: new Date('2026-10-05T12:00:00Z') });
  assert.equal(zip.count, 4);
  assert.equal(zip.skipped.length, 0);

  // signatures in the right places
  const dv = new DataView(zip.blob.buffer, zip.blob.byteOffset, zip.blob.byteLength);
  assert.equal(dv.getUint32(0, true), 0x04034b50, 'local file header signature');
  assert.equal(dv.getUint32(zip.blob.length - 22, true), 0x06054b50, 'end of central directory signature');

  // independent verification: Python's zipfile module, not our own reader
  const dir = mkdtempSync(join(tmpdir(), 'repovault-zip-'));
  const file = join(dir, 'export.zip');
  writeFileSync(file, zip.blob);

  const testRun = spawnSync('python3', ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
  assert.equal(testRun.status, 0, `python zipfile -t failed: ${testRun.stdout}${testRun.stderr}`);

  const check = spawnSync('python3', ['-c', `
import zipfile, sys, json
z = zipfile.ZipFile(${JSON.stringify(file)})
out = {n: list(z.read(n)) for n in z.namelist()}
print(json.dumps({"names": sorted(z.namelist()), "first": out["notes.txt"], "photo": out["photos/cat.png"], "emptyLen": len(out["data/empty.bin"])}))
`], { encoding: 'utf8' });
  assert.equal(check.status, 0, check.stderr);
  const parsed = JSON.parse(check.stdout);
  assert.deepEqual(parsed.names, ['data/empty.bin', 'notes.txt', 'photos/cat.png', 'secret.txt.vault']);
  assert.equal(dec.decode(new Uint8Array(parsed.first)), 'hello vault', 'content round-trips byte-for-byte');
  assert.deepEqual(parsed.photo, [0x89, 0x50, 0x4e, 0x47, 1, 2, 3], 'binary content intact');
  assert.equal(parsed.emptyLen, 0, 'zero-byte entries survive');
});

test('createZip skips what it cannot store instead of producing a broken archive', () => {
  const zip = createZip([
    { name: 'ok.txt', data: enc.encode('fine') },
    { name: '', data: enc.encode('nameless') },
  ]);
  assert.equal(zip.count, 1);
  assert.equal(zip.skipped.length, 1);
  assert.equal(zip.skipped[0].reason, 'empty-name');
});

/* ------------------------------------------------------- adapter: purge */

test('purgeHistory folds the branch into one root commit and keeps every file', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'uploads/a.txt': 'aaa', 'uploads/b.bin': 'bbbb' }, isPrivate: true });
  const gh = adapterFor(mock);
  // build up some history first
  mock.externalPush('uploads/c.txt', 'cccc');
  mock.externalPush('uploads/d.txt', 'dddd');
  await gh.putFile('uploads/e.txt', enc.encode('eeeee'), { message: 'add e' });

  const before = await gh.getCommitCount();
  ok(before >= 4, `expected a few commits, got ${before}`);

  const filesBefore = await gh.listFiles();
  const result = await gh.purgeHistory({ message: 'fold it' });

  const after = await gh.getCommitCount();
  assert.equal(after, 1, 'history is a single commit now');
  assert.equal(result.tree, mock.state.commits.get(result.oldHead).tree, 'the tree was reused, nothing re-uploaded');
  assert.equal(mock.state.commits.get(result.newCommit).parents.length, 0, 'new commit is a root commit');

  const filesAfter = await gh.listFiles();
  assert.deepEqual(
    filesAfter.files.map((f) => f.path).sort(),
    filesBefore.files.map((f) => f.path).sort(),
    'file list is unchanged',
  );
  assert.equal(dec.decode(mock.bytesOf('uploads/a.txt')), 'aaa', 'bytes untouched');
  assert.equal(dec.decode(mock.bytesOf('uploads/e.txt')), 'eeeee');

  const patches = mock.callsTo('PATCH /repos/octo/vault/git/refs/heads/main');
  assert.equal(patches.at(-1).body.force, true, 'ref was force-moved (that is what makes history unreachable)');
});

test('purgeHistory is idempotent and refuses to invent history when there is none', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'a.txt': 'x' } });
  const gh = adapterFor(mock);
  await gh.purgeHistory();
  const first = await gh.getCommitCount();
  assert.equal(first, 1);
  await gh.purgeHistory();
  assert.equal(await gh.getCommitCount(), 1, 'still one commit — nothing to fold');
});

test('getCommitCount handles an empty repository without throwing', async () => {
  const mock = createMockGitHub({ empty: true });
  const gh = adapterFor(mock);
  assert.equal(await gh.getCommitCount(), 0);
});

test('listRefs reports other branches and tags (they keep old objects alive)', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'a.txt': 'x' }, extraBranches: ['backup'], tags: ['v1', 'v2'] });
  const gh = adapterFor(mock);
  const refs = await gh.listRefs();
  assert.deepEqual(refs.branches.sort(), ['backup', 'main']);
  assert.deepEqual(refs.tags.sort(), ['v1', 'v2']);
});

test('usage reports logical bytes from the tree, not just the stale API size', async () => {
  const mock = createMockGitHub({ empty: false });
  const gh = adapterFor(mock);
  await gh.putFile('uploads/one.txt', new Uint8Array(1500), { message: 'add' });
  await gh.putFile('uploads/two.bin', new Uint8Array(2500), { message: 'add' });
  const usage = await gh.usage();
  assert.equal(usage.usedBytes, 4000, 'sums the blobs actually in the tree');
  assert.equal(usage.fileCount, 2);
  ok(typeof usage.reportedBytes === 'number', 'also surfaces what GitHub reports');
});

/* ----------------------------------------------------- adapter: rebuild */

test('rebuildFromFiles creates one root commit holding everything', async () => {
  const mock = createMockGitHub({ empty: true });
  const gh = adapterFor(mock);
  const files = [
    { path: 'uploads/a.txt', bytes: enc.encode('alpha') },
    { path: 'photos/b.bin', bytes: new Uint8Array([1, 2, 3, 4, 5]) },
    { path: '.vault/init.json', bytes: enc.encode('{"app":"repovault"}') },
  ];
  const result = await gh.rebuildFromFiles(files, { message: 'rebuild' });

  assert.equal(result.uploaded, 3);
  assert.equal(result.failed.length, 0);
  assert.equal(await gh.getCommitCount(), 1);
  const listing = await gh.listFiles({ includeSystem: true });
  assert.deepEqual(listing.files.map((f) => f.path).sort(), ['.vault/init.json', 'photos/b.bin', 'uploads/a.txt']);
  assert.equal(dec.decode(mock.bytesOf('uploads/a.txt')), 'alpha');
  assert.deepEqual(Array.from(mock.bytesOf('photos/b.bin')), [1, 2, 3, 4, 5], 'nested paths land correctly');
});

test('delete then recreate then rebuild yields a zero-history repo', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'old.txt': 'old' } });
  const gh = adapterFor(mock);
  mock.externalPush('another.txt', 'noise');
  mock.externalPush('more.txt', 'noise');
  ok((await gh.getCommitCount()) >= 3);

  await gh.deleteRepo();
  assert.equal(mock.state.exists, false, 'repo is gone');

  const created = await gh.createRepo({ name: 'vault', isPrivate: true });
  assert.equal(created.isPrivate, true);
  assert.equal(mock.state.createdPrivate, true, 'visibility preserved');

  const result = await gh.rebuildFromFiles([{ path: 'keeper.txt', bytes: enc.encode('survivor') }], { branch: 'main' });
  assert.equal(result.uploaded, 1);
  assert.equal(await gh.getCommitCount(), 1, 'exactly one commit — no history at all');
  const listing = await gh.listFiles({ includeSystem: true });
  assert.deepEqual(listing.files.map((f) => f.path), ['keeper.txt']);
  ok(!mock.state.files.has('old.txt'), 'old blobs are gone from the rebuilt repo');
  ok(!mock.state.files.has('another.txt'), 'the intermediate commits are gone too');
});

test('a token without admin cannot delete the repo, and says so clearly', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'a.txt': 'x' }, allowDelete: false });
  const gh = adapterFor(mock);
  await assert.rejects(() => gh.deleteRepo(), (e) => {
    ok(e.code === 'forbidden', `expected forbidden, got ${e.code}`);
    ok(e.message.includes('Administration'), 'message tells the user which permission to add');
    return true;
  });
});

/* -------------------------------------------------------- vault: compact */

test('vault.compact() holds every file in memory before touching the repo', async () => {
  const store = new Map();
  const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const mock = createMockGitHub({ empty: true });
  const vault = new Vault({ adapter: adapterFor(mock) });
  // point the vault at the mock's repo so its entries match the mock's tree
  await vault.connect();
  await vault.upload(enc.encode('first'), { name: 'one.txt', folder: 'docs' });
  await vault.upload(enc.encode('second'), { name: 'two.txt', folder: 'docs' });

  const phases = [];
  const result = await vault.compact({ onProgress: (p) => phases.push(p.phase) });

  assert.ok(phases.includes('download') && phases.includes('delete') && phases.includes('upload'), `phases seen: ${phases.join(',')}`);
  assert.equal(phases.indexOf('download') < phases.indexOf('delete'), true, 'downloads happen strictly before the delete');
  assert.equal(result.fileCount, 2);
  assert.equal(await vault.adapter.getCommitCount(), 1, 'rebuilt repo has a single commit');

  const listing = await vault.adapter.listFiles({ includeSystem: true });
  const paths = listing.files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['docs/one.txt', 'docs/two.txt']);
  assert.equal(dec.decode(await vault.adapter.getFileBytes('docs/one.txt')), 'first');
});

test('a failed rebuild surfaces the files it was holding, so nothing is silently lost', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'keep.txt': 'valuable' } });
  const gh = adapterFor(mock);
  const vault = new Vault({ adapter: gh });
  await vault.connect();

  // blow up during upload, after the repo has already been deleted
  const original = gh.rebuildFromFiles.bind(gh);
  gh.rebuildFromFiles = async () => { throw new Error('network died mid-rebuild'); };

  await assert.rejects(() => vault.compact(), (e) => {
    assert.equal(e.rebuildInterrupted, true);
    assert.equal(e.heldFiles.length, 1, 'the file was still in memory when it failed');
    assert.equal(dec.decode(e.heldFiles[0].bytes), 'valuable', 'and its bytes are intact');
    return true;
  });
  assert.equal(mock.state.exists, true, 'repo was recreated (empty) — the caller can retry or export');
  gh.rebuildFromFiles = original;
});

test('vault.historyInfo() combines commit count, refs and sizes', async () => {
  const mock = createMockGitHub({ empty: false, seed: { 'a.txt': 'x' }, extraBranches: ['old'], tags: ['v1'], hasAdmin: true });
  const gh = adapterFor(mock);
  const vault = new Vault({ adapter: gh });
  await vault.connect();
  const info = await vault.historyInfo();
  assert.equal(info.supported, true);
  assert.equal(info.commitCount, 1);
  assert.deepEqual(info.branches.sort(), ['main', 'old']);
  assert.deepEqual(info.tags, ['v1']);
  assert.equal(info.hasAdmin, true, 'admin permission is surfaced so the rebuild button can appear');
});

/* ------------------------------------------------------------- vault: zip */

test('vault.exportZip() produces a verifiable archive of the stored files', async () => {
  const vault = new Vault({ adapter: new MemoryAdapter({ storage: new Map() && { getItem: () => null, setItem: () => {}, removeItem: () => {} } }) });
  await vault.connect();
  await vault.upload(enc.encode('plain content'), { name: 'plain.txt', folder: 'docs' });
  await vault.upload(enc.encode('secret content'), { name: 'secret.txt', folder: 'docs', encrypt: true, password: 'pw-123' });

  const zip = await vault.exportZip();
  assert.equal(zip.count, 2);
  ok(zip.name.endsWith('.zip'));

  const dir = mkdtempSync(join(tmpdir(), 'repovault-export-'));
  const file = join(dir, zip.name);
  writeFileSync(file, zip.blob);
  const run = spawnSync('python3', ['-m', 'zipfile', '-t', file], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);

  const names = spawnSync('python3', ['-c', `import zipfile;print("\\n".join(sorted(zipfile.ZipFile(${JSON.stringify(file)}).namelist())))`], { encoding: 'utf8' }).stdout.trim().split('\n');
  assert.deepEqual(names, ['docs/plain.txt', 'docs/secret.txt.vault'], 'encrypted files are exported as ciphertext, paths preserved');

  const listing = spawnSync('python3', ['-c', `import zipfile;print(len(zipfile.ZipFile(${JSON.stringify(file)}).read("docs/secret.txt.vault")))`], { encoding: 'utf8' }).stdout.trim();
  ok(Number(listing) > 16, 'ciphertext in the archive is non-trivial (header + tag)');
});

test('exportZip can decrypt on the way out when asked', async () => {
  const vault = new Vault({ adapter: new MemoryAdapter({ storage: { getItem: () => null, setItem: () => {}, removeItem: () => {} } }) });
  await vault.connect();
  await vault.upload(enc.encode('the real content'), { name: 'notes.txt', folder: 'docs', encrypt: true, password: 'pw-abc' });

  const zip = await vault.exportZip({ decrypt: true, password: 'pw-abc' });
  const dir = mkdtempSync(join(tmpdir(), 'repovault-export2-'));
  const file = join(dir, zip.name);
  writeFileSync(file, zip.blob);
  const out = spawnSync('python3', ['-c', `
import zipfile
z = zipfile.ZipFile(${JSON.stringify(file)})
print(sorted(z.namelist())[0], "|", z.read(z.namelist()[0]).decode())
`], { encoding: 'utf8' }).stdout.trim();
  assert.equal(out, 'docs/notes.txt | the real content', 'decrypted export restores the original name and bytes');
});

/* ------------------------------------------------------------------- runner */

let passed = 0, failed = 0;
/* ------------------------------------------------- UI wiring (cheap, catches the bug class we actually hit) */

test('the Storage panel ships with one control per reclaim path', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['storage-btn', 'storage-modal', 'purge-btn', 'purge-confirm', 'export-btn', 'rebuild-btn', 'rebuild-confirm']) {
    ok(html.includes(`id="${id}"`), `#${id} is in the markup`);
  }
  ok(html.includes(PURGE_PHRASE) && html.includes(REBUILD_PHRASE), 'the typed confirmations are what the user is asked to type');
  ok(/unreachable/.test(html), 'the copy uses the honest word: unreachable');
  ok(/no longer exist/.test(html), 'and distinguishes it from "no longer exist" for the rebuild path');
});

test('the controller calls all three paths, with payloads the vault really emits', () => {
  const js = readFileSync(new URL('../app/ui/app.js', import.meta.url), 'utf8');
  ok(js.includes('state.vault.purgeHistory('), 'purge is wired');
  ok(js.includes('state.vault.compact('), 'rebuild is wired');
  ok(js.includes('state.vault.exportZip('), 'export is wired');
  ok(js.includes("phase === 'zip'"), 'export progress reads { phase, fraction } — the shape the vault emits');
  ok(js.includes('err.heldFiles'), 'a rebuild that dies mid-way offers the held files instead of dropping them');
  ok(js.includes('matchPhrase('), 'the typed confirmation is enforced in code, not only in the copy');
});

test('every method the Storage panel leans on exists and is callable', async () => {
  const { Vault } = await import('../app/core/vault.js');
  for (const m of ['historyInfo', 'purgeHistory', 'compact', 'exportZip']) {
    ok(typeof Vault.prototype[m] === 'function', `Vault.prototype.${m}`);
  }
  const { GitHubAdapter } = await import('../app/adapters/github.js');
  for (const m of ['getCommitCount', 'listRefs', 'createOrphanCommit', 'setRef', 'purgeHistory', 'deleteRepo', 'createRepo', 'rebuildFromFiles']) {
    ok(typeof GitHubAdapter.prototype[m] === 'function', `GitHubAdapter.prototype.${m}`);
  }
});

test('every element the controller reaches for exists in the markup', () => {
  const js = readFileSync(new URL('../app/ui/app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const referenced = new Set([...js.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]).filter((id) => !id.includes('${')));
  const present = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const missing = [...referenced].filter((id) => !present.has(id));
  assert.deepEqual(missing, [], `markup is missing: ${missing.join(', ')}`);
  ok(referenced.size > 50, `checked a meaningful number of ids (${referenced.size})`);
});

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
console.log(`\n  reclaim: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
