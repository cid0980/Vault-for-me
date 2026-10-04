/**
 * RepoVault — client-side file encryption.
 *
 * Why this exists: a repo is only "free unlimited storage" if you don't have to
 * pay for private repos. If the vault lives in a **public** repo, anyone who
 * guesses a path could read your files — unless they're encrypted before they
 * ever leave the browser. Then a public repo is just untrusted disk space.
 *
 * Format (v1): `RVLT1` magic · uint32 header length · JSON header · ciphertext chunks
 *
 *   chunk i  = AES-256-GCM(key, iv = baseIV[0..8] || uint32BE(i), aad = header || uint32LE(i))
 *
 * Chunked (1 MiB) so a 90 MB video never needs one giant GCM call, and so a
 * corrupted chunk is detected individually. The key is derived once per vault
 * (PBKDF2-SHA256, per-vault random salt kept in `.vault/salt.b64`), not per
 * file, so unlocking once unlocks the whole vault for the session.
 */

import { b64encode, b64decode, te, td, codedError } from './util.js';

const MAGIC = new Uint8Array([0x52, 0x56, 0x4c, 0x54, 0x31]); // "RVLT1"
const TAG_BYTES = 16;
export const DEFAULT_ITERATIONS = 200_000;
export const DEFAULT_CHUNK = 1024 * 1024;

export function hasWebCrypto() {
  return typeof crypto !== 'undefined' && !!crypto.subtle && typeof crypto.subtle.encrypt === 'function';
}

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

export function isEncryptedBytes(bytes) {
  if (!bytes || bytes.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return true;
}

export async function deriveVaultKey(password, salt, iterations = DEFAULT_ITERATIONS) {
  if (!hasWebCrypto()) throw codedError('no-crypto', 'This browser has no WebCrypto (needs https:// or localhost).');
  if (!password) throw codedError('password-required', 'A vault password is required for encrypted files.');
  const material = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function chunkIv(baseIv, index) {
  const iv = baseIv.slice();
  new DataView(iv.buffer, iv.byteOffset, iv.byteLength).setUint32(8, index, false);
  return iv;
}

function chunkAad(headerBytes, index) {
  const aad = new Uint8Array(headerBytes.length + 4);
  aad.set(headerBytes, 0);
  new DataView(aad.buffer).setUint32(headerBytes.length, index, true);
  return aad;
}

/**
 * Encrypt bytes → { data, header }.
 * `meta` (original name/mime) is stored *inside* the encrypted header, so even
 * the filename can stay secret if you rename the stored file yourself.
 */
export async function encryptBytes(bytes, key, { meta = {}, chunkSize = DEFAULT_CHUNK, iterations = DEFAULT_ITERATIONS, onProgress } = {}) {
  if (!hasWebCrypto()) throw codedError('no-crypto', 'This browser has no WebCrypto (needs https:// or localhost).');
  const ivBase = randomBytes(12);
  const header = {
    v: 1, alg: 'A256GCM', kdf: 'PBKDF2-SHA256', iterations,
    size: bytes.length, chunkSize,
    chunks: Math.max(1, Math.ceil(bytes.length / chunkSize)),
    iv: b64encode(ivBase),
    name: meta.name || '', type: meta.type || '', at: Date.now(),
  };
  const headerBytes = te.encode(JSON.stringify(header));

  const parts = [];
  for (let i = 0; i < header.chunks; i++) {
    const start = i * chunkSize;
    const end = Math.min(bytes.length, start + chunkSize);
    const ct = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: chunkIv(ivBase, i), additionalData: chunkAad(headerBytes, i), tagLength: 128 },
      key,
      bytes.subarray(start, end),
    );
    parts.push(new Uint8Array(ct));
    if (onProgress) onProgress((i + 1) / header.chunks);
  }

  const bodyLen = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + bodyLen);
  out.set(MAGIC, 0);
  new DataView(out.buffer).setUint32(MAGIC.length, headerBytes.length, true);
  out.set(headerBytes, MAGIC.length + 4);
  let offset = MAGIC.length + 4 + headerBytes.length;
  for (const p of parts) { out.set(p, offset); offset += p.length; }

  return { data: out, header };
}

/** Decrypt bytes → { data, header }. Throws on wrong password or any tampering. */
export async function decryptBytes(bytes, key, { onProgress } = {}) {
  if (!hasWebCrypto()) throw codedError('no-crypto', 'This browser has no WebCrypto (needs https:// or localhost).');
  if (!isEncryptedBytes(bytes)) throw codedError('not-encrypted', 'That file is not a RepoVault encrypted file.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(MAGIC.length, true);
  const headerStart = MAGIC.length + 4;
  const headerBytes = bytes.subarray(headerStart, headerStart + headerLen);
  let header;
  try {
    header = JSON.parse(td.decode(headerBytes));
  } catch {
    throw codedError('malformed', 'This encrypted file looks corrupted.');
  }
  if (header.v !== 1) throw codedError('unsupported', `Unsupported vault format v${header.v}.`);

  const ivBase = b64decode(header.iv);
  const out = new Uint8Array(header.size);
  let offset = headerStart + headerLen;
  let written = 0;

  for (let i = 0; i < header.chunks; i++) {
    const plainLen = Math.min(header.chunkSize, header.size - written);
    const ctLen = plainLen + TAG_BYTES;
    const ct = bytes.subarray(offset, offset + ctLen);
    let plain;
    try {
      plain = new Uint8Array(await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: chunkIv(ivBase, i), additionalData: chunkAad(headerBytes, i), tagLength: 128 },
        key,
        ct,
      ));
    } catch {
      throw codedError('bad-password', 'Wrong vault password — or the file was modified after upload.');
    }
    out.set(plain, written);
    written += plain.length;
    offset += ctLen;
    if (onProgress) onProgress((i + 1) / header.chunks);
  }

  return { data: out, header };
}

/** Cheap metadata peek without decrypting (header is cleartext by design). */
export function peekHeader(bytes) {
  if (!isEncryptedBytes(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerLen = view.getUint32(MAGIC.length, true);
  const start = MAGIC.length + 4;
  try {
    return JSON.parse(td.decode(bytes.subarray(start, start + headerLen)));
  } catch {
    return null;
  }
}
