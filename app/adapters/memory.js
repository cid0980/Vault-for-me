/**
 * RepoVault — demo adapter.
 *
 * Same interface as the GitHub adapter, backed by localStorage (with an
 * in-memory fallback when storage is blocked, e.g. inside a sandboxed iframe).
 * Lets a reviewer click around the whole app — upload, preview, rename, delete,
 * encryption — with no account, no token and no network.
 */

import { LIMITS, normalizePath, dirName, baseName, codedError, utf8 } from '../core/util.js';

const CAPACITY = 4 * 1024 * 1024; // 4 MB of base64 ≈ 3 MB of files — localStorage's usual ceiling

function checksum(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + bytes.length.toString(16);
}

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

export class MemoryAdapter {
  static id = 'memory';
  static label = 'Demo vault (this browser only)';

  constructor({ storage = null, namespace = 'repovault.demo.v1', capacity = CAPACITY, branch = 'main' } = {}) {
    this.branch = branch;
    this.namespace = namespace;
    this.capacity = capacity;
    this.owner = 'demo';
    this.repo = 'local-vault';
    this.slug = 'demo/local-vault';
    let store = storage;
    if (!store && typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(namespace + ':probe', '1');
        localStorage.removeItem(namespace + ':probe');
        store = localStorage;
      } catch { store = null; }
    }
    this.storage = store || new MemoryStorage();
    this.persistent = store !== null && store !== undefined && store === this.storage;
    this._files = this._read();
  }

  get id() { return MemoryAdapter.id; }
  get label() { return MemoryAdapter.label; }

  _read() {
    try {
      const raw = this.storage.getItem(this.namespace);
      const parsed = raw ? JSON.parse(raw) : [];
      return new Map((Array.isArray(parsed) ? parsed : []).map((f) => [f.path, f]));
    } catch {
      return new Map();
    }
  }

  _write() {
    try {
      this.storage.setItem(this.namespace, JSON.stringify([...this._files.values()]));
      return true;
    } catch {
      throw codedError('quota', 'Demo storage is full (browsers cap localStorage at a few MB). Connect a real repository for real storage.');
    }
  }

  _usage() {
    return [...this._files.values()].reduce((n, f) => n + (f.b64 ? f.b64.length : 0), 0);
  }

  async test() {
    return {
      owner: this.owner, repo: this.repo, fullName: this.slug,
      isPrivate: true, defaultBranch: this.branch, branch: this.branch,
      sizeKB: Math.round(this._usage() / 1024), htmlUrl: '', canPush: true, empty: false,
      demo: true, persistent: this.persistent,
    };
  }

  async ensureInitialized() { return this.test(); }
  async usage() { return { usedBytes: this._usage(), softLimitBytes: this.capacity, hardGuidanceBytes: this.capacity, demo: true }; }
  publicUrl() { return null; }

  async listFiles({ prefix = '', includeSystem = true } = {}) {
    const wanted = normalizePath(prefix);
    const files = [...this._files.values()]
      .filter((f) => includeSystem || !f.path.startsWith(LIMITS.SYSTEM_DIR))
      .filter((f) => !wanted || f.path.startsWith(wanted))
      .map((f) => ({ path: f.path, sha: f.sha, size: f.size, updatedAt: f.at }));
    return { files, truncated: false, branch: this.branch };
  }

  async getFileBytes(path) {
    const f = this._files.get(normalizePath(path));
    if (!f) throw codedError('not-found', `${path} is not in the demo vault.`);
    const bin = atob(f.b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  async putFile(path, data, { onProgress } = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    let b64 = '';
    for (let i = 0; i < bytes.length; i += 0x8000) b64 += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    b64 = btoa(b64);
    if (this._usage() + b64.length > this.capacity) {
      throw codedError('quota', 'Demo vault is full (4 MB cap). Connect a real repository for real storage.');
    }
    const clean = normalizePath(path);
    const record = { path: clean, name: baseName(clean), folder: dirName(clean), size: bytes.length, sha: checksum(bytes), b64, at: new Date().toISOString() };
    this._files.set(clean, record);
    this._write();
    if (onProgress) onProgress(1);
    return { commit: record.sha, path: clean, size: bytes.length, demo: true };
  }

  async deleteFile(path) {
    const clean = normalizePath(path);
    this._files.delete(clean);
    this._write();
    return { commit: 'demo-' + Date.now(), path: clean, demo: true };
  }

  async moveFile(from, to) {
    const clean = normalizePath(from);
    const record = this._files.get(clean);
    if (!record) throw codedError('not-found', `${from} is not in the demo vault.`);
    const target = normalizePath(to);
    this._files.delete(clean);
    record.path = target;
    record.name = baseName(target);
    record.folder = dirName(target);
    this._files.set(target, record);
    this._write();
    return { commit: 'demo-' + Date.now(), from: clean, to: target, demo: true };
  }

  async clear() {
    this._files.clear();
    this._write();
  }
}

export { utf8 };
