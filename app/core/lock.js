/**
 * RepoVault — screen lock (passcode) + auto-lock.
 *
 * WHAT THIS IS: a passcode gate in front of the UI, stored as a PBKDF2 hash in
 * this browser only. It keeps a borrowed phone or a shoulder-surfer out of your
 * file list and stops the saved GitHub token being used by whoever picks up the
 * device.
 *
 * WHAT THIS IS NOT: encryption, and not a server-side auth check. It is a
 * static site — anyone can read the source, open devtools, or point a client
 * straight at the GitHub API with their own token. Your real protections are:
 *   1. the repo's visibility + fine-grained token scope, and
 *   2. the vault password that encrypts file contents before upload.
 *
 * DOM-free and dependency-light so the whole thing is unit-testable.
 */

import { b64encode, b64decode, te, codedError } from './util.js';
import { randomBytes, hasWebCrypto } from './crypto.js';

export const LOCK_KEY = 'repovault.lock.v1';
export const SESSION_KEY = 'repovault.unlocked';
export const DEFAULT_ITERATIONS = 150_000;
export const MIN_PASSCODE = 6;
const DIGEST_BYTES = 32;

/** @returns {{ok: boolean, message?: string}} */
export function validatePasscode(passcode) {
  const p = String(passcode || '');
  if (p.length < MIN_PASSCODE) return { ok: false, message: `Use at least ${MIN_PASSCODE} characters — this is the only thing standing between a stranger and your files.` };
  if (/^\d+$/.test(p) && p.length < 8) return { ok: false, message: 'All-digits passcodes should be 8+ long (a 6-digit PIN is 20 bits — trivially guessed offline).' };
  if (new Set(p).size < 3) return { ok: false, message: 'Too repetitive — mix in some different characters.' };
  return { ok: true };
}

async function deriveBits(passcode, salt, iterations) {
  if (!hasWebCrypto()) throw codedError('no-crypto', 'A passcode lock needs WebCrypto (https:// or localhost).');
  const material = await crypto.subtle.importKey('raw', te.encode(String(passcode)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    DIGEST_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Create a lock record to persist (localStorage):
 *   { v: 1, salt: b64, hash: b64, iterations, timeoutMs, createdAt }
 */
export async function createPasscode(passcode, { iterations = DEFAULT_ITERATIONS, salt = null, timeoutMs = 15 * 60_000 } = {}) {
  const check = validatePasscode(passcode);
  if (!check.ok) throw codedError('weak-passcode', check.message);
  const saltBytes = salt || randomBytes(16);
  const hash = await deriveBits(passcode, saltBytes, iterations);
  return {
    v: 1,
    salt: b64encode(saltBytes),
    hash: b64encode(hash),
    iterations,
    timeoutMs,
    createdAt: new Date().toISOString(),
  };
}

/** Constant-time compare so a wrong passcode leaks no timing signal. */
export function constantTimeEqual(a, b) {
  const A = typeof a === 'string' ? te.encode(a) : a;
  const B = typeof b === 'string' ? te.encode(b) : b;
  // Empty inputs never match anything: a corrupted record with an empty hash
  // must not be unlockable with an empty passcode.
  if (!A || !B || A.length === 0 || B.length === 0) return false;
  if (A.length !== B.length) return false;
  let diff = 0;
  for (let i = 0; i < A.length; i++) diff |= A[i] ^ B[i];
  return diff === 0;
}

export async function verifyPasscode(passcode, record) {
  if (!record || record.v !== 1 || !record.salt || !record.hash) {
    throw codedError('malformed', 'The stored lock record is corrupted — remove the lock and set it again.');
  }
  let expected;
  try {
    expected = b64decode(record.hash);
  } catch {
    throw codedError('malformed', 'The stored lock record is unreadable — remove the lock and set it again.');
  }
  const actual = await deriveBits(String(passcode || ''), b64decode(record.salt), record.iterations || DEFAULT_ITERATIONS);
  return constantTimeEqual(actual, expected);
}

/**
 * Inactivity auto-lock. Timers are injectable so tests don't sleep for real.
 */
export class AutoLock {
  constructor({ timeoutMs = 15 * 60_000, onLock = () => {}, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    this.timeoutMs = timeoutMs;
    this.onLock = onLock;
    this._now = now;
    this._setTimer = setTimer;
    this._clearTimer = clearTimer;
    this._timer = null;
    this._lastActivity = null;
    this.armed = false;
  }

  get enabled() { return this.timeoutMs > 0; }
  get remainingMs() {
    if (!this.armed || !this._lastActivity) return this.timeoutMs;
    return Math.max(0, this.timeoutMs - (this._now() - this._lastActivity));
  }

  start() {
    this.armed = true;
    this._lastActivity = this._now();
    this._schedule();
    return this;
  }

  /** Call on any user activity: mousemove, keydown, touchstart, visibilitychange… */
  touch() {
    if (!this.armed || !this.enabled) return;
    this._lastActivity = this._now();
    this._schedule();
  }

  stop() {
    this.armed = false;
    this._lastActivity = null;
    if (this._timer !== null) { this._clearTimer(this._timer); this._timer = null; }
  }

  /** Lock right now (e.g. the "Lock now" button). */
  lockNow() {
    this.stop();
    this.onLock('manual');
  }

  _schedule() {
    if (this._timer !== null) this._clearTimer(this._timer);
    if (!this.enabled) { this._timer = null; return; }
    this._timer = this._setTimer(() => {
      this._timer = null;
      this.armed = false;
      this.onLock('timeout');
    }, this.timeoutMs);
  }
}

/* --------------------------------------------------------- tiny persistence */

export function readLock(storage) {
  try {
    const raw = storage && storage.getItem(LOCK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && parsed.v === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export function writeLock(storage, record) {
  storage.setItem(LOCK_KEY, JSON.stringify(record));
  return record;
}

export function clearLock(storage) {
  storage.removeItem(LOCK_KEY);
  try { storage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}

export function isSessionUnlocked(storage) {
  try { return storage.getItem(SESSION_KEY) === '1'; } catch { return false; }
}

export function markSessionUnlocked(storage) {
  try { storage.setItem(SESSION_KEY, '1'); } catch { /* ignore */ }
}

export function clearSession(storage) {
  try { storage.removeItem(SESSION_KEY); } catch { /* ignore */ }
}
