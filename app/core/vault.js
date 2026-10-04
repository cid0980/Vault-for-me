/**
 * RepoVault — domain layer.
 *
 * Sits between the UI and any StorageAdapter so the app never talks to GitHub
 * directly. Everything the UI needs is here: listing, searching, upload with
 * optional encryption, preview, rename, delete, quota accounting.
 */

import { LIMITS, joinPath, safeFileName, safeFolder, uniquePath, kindOf, mimeOf, dirName, baseName, extOf, toBytes, fromUtf8, utf8, b64encode, b64decode, codedError, formatBytes } from './util.js';
import { deriveVaultKey, encryptBytes, decryptBytes, isEncryptedBytes, randomBytes, DEFAULT_ITERATIONS, hasWebCrypto } from './crypto.js';

export const SALT_PATH = LIMITS.SYSTEM_DIR + 'salt.b64';
export const ENC_SUFFIX = '.vault';
const SALT_BYTES = 32;

export class Vault {
  constructor({ adapter, defaultFolder = 'uploads/' } = {}) {
    if (!adapter) throw codedError('config', 'A Vault needs a storage adapter.');
    this.adapter = adapter;
    this.defaultFolder = defaultFolder;
    this.entries = [];
    this.info = null;
    this.usage = null;
    this.truncated = false;
    this._key = null;
    this._unlocked = false;
  }

  /* ------------------------------------------------------------ lifecycle */

  async connect() {
    this.info = await this.adapter.test();
    if (this.adapter.ensureInitialized) await this.adapter.ensureInitialized();
    this.info = await this.adapter.test();
    this.usage = this.adapter.usage ? await this.adapter.usage() : null;
    await this.refresh();
    return this.info;
  }

  async refresh({ prefix = '' } = {}) {
    const { files, truncated } = await this.adapter.listFiles({ prefix });
    this.truncated = truncated;
    this.entries = files.map((f) => this.decorate(f));
    if (this.adapter.usage) this.usage = await this.adapter.usage();
    return this.entries;
  }

  decorate(file) {
    const encrypted = file.path.endsWith(ENC_SUFFIX);
    const displayName = encrypted ? baseName(file.path).slice(0, -ENC_SUFFIX.length) : baseName(file.path);
    return {
      path: file.path,
      name: baseName(file.path),
      displayName,
      folder: dirName(file.path),
      size: file.size,
      sha: file.sha,
      encrypted,
      kind: encrypted ? kindOf(displayName) : kindOf(file.path),
      mime: mimeOf(displayName),
      updatedAt: file.updatedAt || null,
      system: file.path.startsWith(LIMITS.SYSTEM_DIR),
    };
  }

  /* ------------------------------------------------------------ searching */

  list({ query = '', kind = 'all', folder = '', sort = 'newest' } = {}) {
    const q = query.trim().toLowerCase();
    let out = this.entries.filter((e) => !e.system);
    if (q) out = out.filter((e) => e.displayName.toLowerCase().includes(q) || e.path.toLowerCase().includes(q));
    if (kind && kind !== 'all') out = out.filter((e) => (kind === 'encrypted' ? e.encrypted : e.kind === kind));
    if (folder) out = out.filter((e) => e.folder === folder);
    const by = {
      newest: (a, b) => a.displayName.localeCompare(b.displayName),
      size: (a, b) => b.size - a.size,
      kind: (a, b) => a.kind.localeCompare(b.kind) || a.displayName.localeCompare(b.displayName),
      name: (a, b) => a.displayName.localeCompare(b.displayName),
    };
    return out.sort(by[sort] || by.name);
  }

  folders() {
    const set = new Set();
    for (const e of this.entries) if (!e.system && e.folder) set.add(e.folder);
    return [...set].sort();
  }

  summary() {
    const files = this.entries.filter((e) => !e.system);
    const byKind = {};
    let bytes = 0, encrypted = 0;
    for (const f of files) {
      byKind[f.kind] = (byKind[f.kind] || 0) + 1;
      bytes += f.size || 0;
      if (f.encrypted) encrypted++;
    }
    return { count: files.length, bytes, byKind, encrypted, human: formatBytes(bytes) };
  }

  /* ------------------------------------------------------------ encryption */

  get unlocked() { return this._unlocked; }
  get hasEncryptedFiles() { return this.entries.some((e) => e.encrypted); }

  /** Derive (once per session) the vault key from the vault salt file. */
  async ensureKey(password) {
    if (this._key) return this._key;
    if (!hasWebCrypto()) throw codedError('no-crypto', 'Encryption needs a secure context (https:// or localhost).');
    if (!password) throw codedError('password-required', 'Enter your vault password to read encrypted files.');
    let salt = null;
    try {
      const stored = await this.adapter.getFileBytes(SALT_PATH);
      salt = b64decode(fromUtf8(stored).trim());
      if (salt.length !== SALT_BYTES) throw codedError('malformed', 'The vault salt file is corrupted.');
    } catch (err) {
      // Only a *missing* salt is created. Any other failure (auth, network,
      // corruption) must surface: silently minting a new salt would make every
      // previously encrypted file undecryptable.
      if (err.code !== 'not-found') throw err;
      salt = randomBytes(SALT_BYTES);
      await this.adapter.putFile(SALT_PATH, utf8(b64encode(salt)), { message: 'chore(repovault): create vault salt' });
    }
    this._key = await deriveVaultKey(password, salt, DEFAULT_ITERATIONS);
    this._unlocked = true;
    return this._key;
  }

  lock() {
    this._key = null;
    this._unlocked = false;
  }

  /* --------------------------------------------------------------- upload */

  /**
   * @param input    File | Blob | Uint8Array | ArrayBuffer
   * @param options  { name, folder, encrypt, password, onProgress }
   */
  async upload(input, { name, folder, encrypt = false, password = null, onProgress = null } = {}) {
    const sourceName = name || (input && input.name) || 'file';
    const fileName = safeFileName(sourceName);
    const mime = (input && input.type) || mimeOf(fileName);
    const bytes = await toBytes(input);
    if (!bytes.length) throw codedError('empty', 'That file is empty.');

    let payload = bytes;
    let storedName = fileName;
    if (encrypt) {
      const key = await this.ensureKey(password);
      const enc = await encryptBytes(bytes, key, {
        meta: { name: fileName, type: mime },
        onProgress: onProgress ? (f) => onProgress(f * 0.45) : null,
      });
      payload = enc.data;
      storedName = fileName + ENC_SUFFIX;
    }

    if (payload.length > LIMITS.MAX_FILE_BYTES) {
      throw codedError('too-large',
        `${formatBytes(bytes.length)} is over GitHub's 100 MB per-file limit${encrypt ? ' (encryption adds ~16 bytes per MB)' : ''}. Split it or add an R2/S3 adapter.`);
    }

    const targetFolder = safeFolder(folder ?? this.defaultFolder);
    const taken = new Set(this.entries.map((e) => e.path));
    const path = uniquePath(joinPath(targetFolder, storedName), taken);

    const res = await this.adapter.putFile(path, payload, {
      message: `${encrypt ? 'add encrypted' : 'add'}: ${storedName} (${formatBytes(bytes.length)})`,
      onProgress: onProgress ? (f) => onProgress(encrypt ? 0.45 + f * 0.55 : f) : null,
    });

    const entry = this.decorate({ path, sha: res && res.commit, size: payload.length, updatedAt: new Date().toISOString() });
    this.entries.push(entry);
    if (this.adapter.usage) this.usage = await this.adapter.usage().catch(() => this.usage);
    return entry;
  }

  /* --------------------------------------------------------------- access */

  async readBytes(entry) {
    return this.adapter.getFileBytes(entry.path);
  }

  /** Fetch (and decrypt if needed) a file → { blob, name, kind, mime, decrypted } */
  async download(entry, { password = null, onProgress = null } = {}) {
    const bytes = await this.adapter.getFileBytes(entry.path);
    if (!entry.encrypted) {
      const blob = new Blob([bytes], { type: entry.mime });
      return { blob, name: entry.displayName, kind: entry.kind, mime: entry.mime, decrypted: false };
    }
    const key = await this.ensureKey(password);
    let decrypted;
    try {
      decrypted = await decryptBytes(bytes, key, { onProgress });
    } catch (err) {
      // A typo'd password must never stay cached as "the" session key, otherwise
      // every later file fails with a misleading error and unlocked() lies.
      if (err.code === 'bad-password') this.lock();
      throw err;
    }
    const { data, header } = decrypted;
    const innerName = header.name || entry.displayName;
    const innerMime = header.type || mimeOf(innerName);
    return {
      blob: new Blob([data], { type: innerMime }),
      name: innerName,
      kind: kindOf(innerName),
      mime: innerMime,
      decrypted: true,
      size: data.length,
    };
  }

  async text(entry, { password = null, limit = 200_000 } = {}) {
    const bytes = await this.readBytes(entry);
    let data = bytes;
    if (entry.encrypted) {
      const key = await this.ensureKey(password);
      try {
        data = (await decryptBytes(bytes, key)).data;
      } catch (err) {
        if (err.code === 'bad-password') this.lock();
        throw err;
      }
    }
    return fromUtf8(data.subarray(0, Math.min(data.length, limit)));
  }

  /* --------------------------------------------------------------- mutate */

  async remove(entry) {
    const res = await this.adapter.deleteFile(entry.path, { message: `delete: ${entry.name} (${formatBytes(entry.size)})` });
    this.entries = this.entries.filter((e) => e.path !== entry.path);
    return res;
  }

  async rename(entry, newName) {
    const clean = safeFileName(newName);
    if (!clean || clean === entry.name) return entry;
    let target = clean;
    if (entry.encrypted && !clean.endsWith(ENC_SUFFIX)) target = clean + ENC_SUFFIX;
    if (!entry.encrypted && clean.endsWith(ENC_SUFFIX)) target = clean.slice(0, -ENC_SUFFIX.length);
    const taken = new Set(this.entries.map((e) => e.path));
    taken.delete(entry.path);
    const to = uniquePath(joinPath(entry.folder, target), taken);
    const res = await this.adapter.moveFile(entry.path, to, { sha: entry.sha, message: `rename: ${entry.name} → ${baseName(to)}` });
    this.entries = this.entries.filter((e) => e.path !== entry.path);
    const updated = this.decorate({ path: to, sha: res && res.commit, size: entry.size, updatedAt: new Date().toISOString() });
    this.entries.push(updated);
    return updated;
  }

  /** Shareable URL: public repos get a raw link, private repos only work in-app. */
  shareUrl(entry, appUrl = '') {
    if (this.info && !this.info.isPrivate && this.adapter.publicUrl) return this.adapter.publicUrl(entry.path);
    if (appUrl) {
      const base = appUrl.split('#')[0];
      return `${base}#repo=${encodeURIComponent(this.adapter.slug || '')}&path=${encodeURIComponent(entry.path)}`;
    }
    return null;
  }
}

export { extOf, baseName, dirName, formatBytes };
