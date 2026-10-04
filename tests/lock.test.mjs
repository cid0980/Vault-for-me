import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
/**
 * Screen-lock tests: passcode hashing, constant-time compare, auto-lock timers.
 */
import assert from 'node:assert/strict';
import {
  validatePasscode, createPasscode, verifyPasscode, constantTimeEqual, AutoLock,
  readLock, writeLock, clearLock, isSessionUnlocked, markSessionUnlocked, clearSession, LOCK_KEY, SESSION_KEY,
} from '../app/core/lock.js';

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);

const mem = () => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map,
  };
};

/* ---------------------------------------------------------------- passcode */

test('weak passcodes are rejected with a reason', () => {
  ok(!validatePasscode('').ok);
  ok(!validatePasscode('12345').ok, 'too short');
  ok(!validatePasscode('123456').ok, 'all-digit 6 is rejected');
  ok(!validatePasscode('aaaaaa').ok, 'too repetitive');
  ok(validatePasscode('12345678').ok, '8 digits is acceptable');
  ok(validatePasscode('horse-battery').ok);
  ok(validatePasscode('Str0ng! enough').ok);
});

test('createPasscode stores a hash, never the passcode', async () => {
  const rec = await createPasscode('correct-horse', { iterations: 1000 });
  assert.equal(rec.v, 1);
  ok(rec.salt && rec.hash && rec.iterations === 1000);
  ok(!JSON.stringify(rec).includes('correct-horse'), 'passcode must not appear in the record');
  assert.equal(Buffer.from(rec.hash, 'base64').length, 32, '32-byte digest');
});

test('verifyPasscode accepts the right passcode and rejects the wrong one', async () => {
  const rec = await createPasscode('open-sesame-42', { iterations: 1000 });
  ok(await verifyPasscode('open-sesame-42', rec));
  ok(!(await verifyPasscode('open-sesame-43', rec)), 'off-by-one char must fail');
  ok(!(await verifyPasscode('', rec)), 'empty must fail');
  ok(!(await verifyPasscode('open-sesame-42 ', rec)), 'trailing space must fail');
});

test('the same passcode on two devices produces different hashes (unique salt)', async () => {
  const a = await createPasscode('same-passcode', { iterations: 1000 });
  const b = await createPasscode('same-passcode', { iterations: 1000 });
  ok(a.salt !== b.salt, 'salts differ');
  ok(a.hash !== b.hash, 'hashes differ — no rainbow-table shortcut');
});

test('a corrupted lock record fails loudly instead of silently unlocking', async () => {
  await assert.rejects(() => verifyPasscode('whatever', { v: 1 }), (e) => e.code === 'malformed');
  await assert.rejects(() => verifyPasscode('whatever', null), (e) => e.code === 'malformed');
  const rec = await createPasscode('good-passcode', { iterations: 1000 });
  await assert.rejects(() => verifyPasscode('good-passcode', { ...rec, hash: '!!!not-base64!!!' }), (e) => e.code === 'malformed');
});

test('constantTimeEqual is correct and rejects length mismatches', () => {
  ok(constantTimeEqual('abc', 'abc'));
  ok(constantTimeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3])));
  ok(!constantTimeEqual('abc', 'abd'));
  ok(!constantTimeEqual('abc', 'abcd'));
  ok(!constantTimeEqual('', ''));
  ok(!constantTimeEqual(null, null));
});

/* --------------------------------------------------------------- auto-lock */

test('AutoLock fires after the timeout and reports why', () => {
  let now = 1_000_000;
  const fired = [];
  const timers = [];
  const auto = new AutoLock({
    timeoutMs: 5_000,
    onLock: (reason) => fired.push([reason, now]),
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: (id) => { timers[id - 1] && (timers[id - 1].cleared = true); },
  });

  auto.start();
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 5_000, 'timer armed for the configured window');

  now += 5_001;
  timers[0].fn();
  assert.deepEqual(fired, [['timeout', now]]);
  assert.equal(auto.armed, false, 'disarms after firing');
});

test('AutoLock.touch() restarts the clock (activity keeps you unlocked)', () => {
  let now = 0;
  const timers = [];
  const fired = [];
  const auto = new AutoLock({
    timeoutMs: 1_000,
    onLock: (r) => fired.push(r),
    now: () => now,
    setTimer: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearTimer: (id) => { timers[id - 1].cleared = true; },
  });
  auto.start();

  now = 900;
  auto.touch();
  assert.equal(timers[0].cleared, true, 'previous timer cancelled');
  assert.equal(timers[1].ms, 1_000, 'fresh window');
  assert.equal(auto.remainingMs, 1_000);

  now = 1_500;
  assert.equal(auto.remainingMs, 400);
  assert.deepEqual(fired, [], 'still unlocked — activity happened 600 ms ago');
});

test('AutoLock handles manual lock, disable, and double-fire safety', () => {
  const fired = [];
  const auto = new AutoLock({ timeoutMs: 60_000, onLock: (r) => fired.push(r), now: () => 0, setTimer: () => 1, clearTimer: () => {} });
  auto.start();
  auto.lockNow();
  assert.deepEqual(fired, ['manual']);
  assert.equal(auto.armed, false);

  const disabled = new AutoLock({ timeoutMs: 0, onLock: () => fired.push('should-not-happen'), setTimer: () => 1, clearTimer: () => {} });
  disabled.start();
  assert.equal(disabled.enabled, false, 'timeout 0 means never');
  assert.deepEqual(fired, ['manual'], 'disabled lock never fires');
  disabled.touch(); // must be a no-op
});

/* ------------------------------------------------------------- persistence */

test('lock records round-trip through storage and can be removed', async () => {
  const storage = mem();
  assert.equal(readLock(storage), null);

  const rec = await createPasscode('storage-test-1', { iterations: 1000 });
  writeLock(storage, rec);
  assert.deepEqual(readLock(storage), rec);
  ok(storage.getItem(LOCK_KEY).includes('"v":1'));

  // garbage in storage must not crash the app
  storage.setItem(LOCK_KEY, 'not json');
  assert.equal(readLock(storage), null);
  storage.setItem(LOCK_KEY, JSON.stringify({ v: 99 }));
  assert.equal(readLock(storage), null, 'unknown version ignored');

  writeLock(storage, rec);
  clearLock(storage);
  assert.equal(readLock(storage), null);
  assert.equal(storage.getItem(SESSION_KEY), null, 'clearing the lock also clears the session flag');
});

test('the unlocked flag is per browser session', () => {
  const storage = mem();
  assert.equal(isSessionUnlocked(storage), false);
  markSessionUnlocked(storage);
  assert.equal(isSessionUnlocked(storage), true);
  clearSession(storage);
  assert.equal(isSessionUnlocked(storage), false);
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
console.log(`\n  lock: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
