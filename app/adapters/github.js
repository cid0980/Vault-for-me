/**
 * RepoVault — GitHub storage adapter.
 *
 * Treats a git repository as a key/value store of file paths → blobs:
 *
 *   small files (<= 20 MB)  →  PUT /contents/:path          (one request, one commit)
 *   large files (<= 100 MB) →  POST /git/blobs → /git/trees → /git/commits → PATCH /git/refs
 *   delete / move           →  one tree commit (no data re-uploaded, even for GB-scale files)
 *
 * Everything is plain REST + a token; no SDK, no build step, works from any
 * browser tab (api.github.com sends permissive CORS headers).
 *
 * Adapter interface (implement this to add S3 / R2 / Drive later):
 *   test()                          → NormalisedRepo
 *   listFiles({prefix})             → { files: FileEntry[], truncated }
 *   putFile(path, bytes, opts)      → { commit, path, size }
 *   getFileBytes(path)              → Uint8Array
 *   deleteFile(path, opts)          → { commit }
 *   moveFile(from, to, opts)        → { commit }
 *   ensureInitialized()             → NormalisedRepo
 *   usage()                         → { usedBytes, softLimitBytes }
 *   publicUrl(path)                 → string | null
 */

import { LIMITS, b64encode, encodePath, joinPath, normalizePath, utf8, codedError, withRetry } from '../core/util.js';

const API_VERSION = '2022-11-28'; // pinned so a GitHub default change can't break us

export class GitHubError extends Error {
  constructor(message, { status = 0, code = 'github', retryable = false, retryAfterMs = 0, payload = null } = {}) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.payload = payload;
  }
}

/* --------------------------------------------------------------- transport */

function headerBag(raw) {
  const map = {};
  String(raw || '').split(/\r?\n/).forEach((line) => {
    const i = line.indexOf(':');
    if (i > 0) map[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  });
  return { get: (name) => map[String(name).toLowerCase()] ?? null };
}

/** XHR only where it buys something: upload progress. */
function xhrRequest(url, { method, headers, body, onProgress, binary = false }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);
    if (binary) xhr.responseType = 'arraybuffer';
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
    }
    xhr.onload = () => resolve({
      ok: xhr.status >= 200 && xhr.status < 300,
      status: xhr.status,
      headers: headerBag(xhr.getAllResponseHeaders()),
      text: binary ? null : xhr.responseText,
      bytes: binary && xhr.response ? new Uint8Array(xhr.response) : null,
    });
    xhr.onerror = () => reject(codedError('network', 'Network error while contacting ' + url, { retryable: true }));
    xhr.send(body === undefined ? null : body);
  });
}

/* ------------------------------------------------------------------ adapter */

export class GitHubAdapter {
  static id = 'github';
  static label = 'GitHub repository';

  constructor({
    owner, repo, branch = '', token, apiBase = 'https://api.github.com', fetchImpl = null, onLog = null,
    smallFileThreshold = LIMITS.SMALL_FILE_BYTES, // overridable so tests can exercise both code paths cheaply
    maxFileBytes = LIMITS.MAX_FILE_BYTES,
  } = {}) {
    if (!owner || !repo) throw codedError('config', 'Both owner and repo are required.');
    this.owner = String(owner).trim();
    this.repo = String(repo).trim().replace(/\.git$/, '');
    this.branch = String(branch || '').trim();
    this.token = token || '';
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.fetchImpl = fetchImpl;
    this.onLog = onLog;
    this.smallFileThreshold = smallFileThreshold;
    this.maxFileBytes = maxFileBytes;
    this._headCache = null;
    this._repoCache = null;
  }

  get id() { return GitHubAdapter.id; }
  get label() { return GitHubAdapter.label; }
  get slug() { return `${this.owner}/${this.repo}`; }

  _fetch(input, init) {
    const f = this.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw codedError('no-fetch', 'fetch() is unavailable in this environment.');
    return f(input, init);
  }

  _headers(extra) {
    return {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': API_VERSION,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(extra || {}),
    };
  }

  _url(pathOrUrl) {
    return pathOrUrl.startsWith('http') ? pathOrUrl : this.apiBase + pathOrUrl;
  }

  /** Raw request → { ok, status, headers, text, bytes }. */
  async _raw(pathOrUrl, { method = 'GET', body, headers, onProgress, accept, binary = false } = {}) {
    const url = this._url(pathOrUrl);
    const finalHeaders = this._headers({ ...(accept ? { Accept: accept } : {}), ...(headers || {}) });
    if (body !== undefined) finalHeaders['Content-Type'] = 'application/json';
    const useXhr = !!onProgress && typeof XMLHttpRequest !== 'undefined' && !this.fetchImpl;
    const started = Date.now();
    let res;
    if (useXhr) {
      res = await xhrRequest(url, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body), onProgress, binary });
    } else {
      const raw = await this._fetch(url, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body) });
      if (binary) {
        res = { ok: raw.ok, status: raw.status, headers: raw.headers, text: null, bytes: new Uint8Array(await raw.arrayBuffer()) };
      } else {
        res = { ok: raw.ok, status: raw.status, headers: raw.headers, text: await raw.text(), bytes: null };
      }
    }
    if (this.onLog) {
      const kb = body === undefined ? 0 : Math.round(String(body).length / 1024);
      this.onLog({ method, url, status: res.status, ms: Date.now() - started, sentKB: kb });
    }
    return res;
  }

  _fail(res) {
    let payload = null;
    try { payload = res.text ? JSON.parse(res.text) : null; } catch { /* not JSON */ }
    const status = res.status;
    const ghMessage = payload && payload.message ? payload.message : `HTTP ${status}`;
    const remaining = res.headers.get('x-ratelimit-remaining');
    const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
    const retryAfter = Number(res.headers.get('retry-after')) || 0;

    if (status === 401) return new GitHubError('Token rejected (401). It may be expired, revoked, or missing the "Contents: Read and write" permission.', { status, code: 'auth', payload });
    if (status === 403 && (remaining === '0' || retryAfter)) {
      const resetMs = reset ? reset * 1000 - Date.now() : 0;
      return new GitHubError(`GitHub rate limit reached. ${reset ? 'Resets ' + new Date(reset * 1000).toLocaleTimeString() + '.' : ''}`, { status, code: 'rate-limit', retryable: true, retryAfterMs: Math.max(resetMs, retryAfter * 1000, 1000), payload });
    }
    if (status === 403) return new GitHubError('GitHub refused the request (403): ' + ghMessage, { status, code: 'forbidden', payload });
    if (status === 404) return new GitHubError('Not found (404): ' + ghMessage, { status, code: 'not-found', payload });
    if (status === 409) {
      if (/empty/i.test(ghMessage)) return new GitHubError('Repository is empty.', { status, code: 'empty-repo', payload });
      return new GitHubError('Conflict (409): ' + ghMessage, { status, code: 'conflict', retryable: true, payload });
    }
    if (status === 413) return new GitHubError('That file is too large for GitHub.', { status, code: 'too-large', payload });
    if (status === 422) {
      if (/sha|fast forward|reference update|conflict/i.test(ghMessage)) return new GitHubError('Update conflict (422): ' + ghMessage, { status, code: 'conflict', retryable: true, payload });
      const detail = payload && payload.errors && payload.errors.length ? ' — ' + payload.errors.map((e) => e.message || e.code).join('; ') : '';
      return new GitHubError('GitHub rejected the request (422): ' + ghMessage + detail, { status, code: 'unprocessable', payload });
    }
    if (status === 429) return new GitHubError('Too many requests (429).', { status, code: 'rate-limit', retryable: true, retryAfterMs: retryAfter * 1000 || 5000, payload });
    if (status >= 500) return new GitHubError(`GitHub is having a moment (${status}).`, { status, code: 'server', retryable: true, payload });
    return new GitHubError(ghMessage, { status, code: 'http', payload });
  }

  async _json(pathOrUrl, opts = {}) {
    const res = await this._raw(pathOrUrl, opts);
    if (!res.ok) throw this._fail(res);
    if (!res.text) return null;
    try { return JSON.parse(res.text); } catch { return null; }
  }

  /* ------------------------------------------------------------ inspection */

  async getRepo({ fresh = false } = {}) {
    if (this._repoCache && !fresh) return this._repoCache;
    const data = await this._json(`/repos/${this.owner}/${this.repo}`);
    this._repoCache = {
      owner: this.owner,
      repo: this.repo,
      fullName: data.full_name,
      isPrivate: !!data.private,
      defaultBranch: data.default_branch || 'main',
      sizeKB: data.size || 0,
      htmlUrl: data.html_url,
      canPush: !data.permissions || data.permissions.push !== false,
      empty: (data.size || 0) === 0,
    };
    return this._repoCache;
  }

  /** Head commit sha of the working branch (cached until a write happens). */
  async getHead({ fresh = false } = {}) {
    if (this._headCache && !fresh) return this._headCache;
    if (!this.branch) {
      const repo = await this.getRepo();
      this.branch = repo.defaultBranch;
    }
    const res = await this._raw(`/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(this.branch)}`);
    if (res.status === 404 || res.status === 409) {
      const repo = await this.getRepo({ fresh: true });
      const looksEmpty = res.status === 409 || /empty/i.test(res.text || '') || repo.empty;
      throw new GitHubError(looksEmpty ? 'Repository has no commits yet.' : `Branch "${this.branch}" not found.`, {
        status: res.status, code: 'empty-repo',
      });
    }
    if (!res.ok) throw this._fail(res);
    const data = JSON.parse(res.text);
    this._headCache = { sha: data.object.sha, branch: this.branch };
    return this._headCache;
  }

  async test() {
    const repo = await this.getRepo({ fresh: true });
    return { ...repo, branch: this.branch || repo.defaultBranch };
  }

  async usage() {
    const repo = await this.getRepo({ fresh: true });
    return { usedBytes: repo.sizeKB * 1024, softLimitBytes: LIMITS.REPO_SOFT_LIMIT, hardGuidanceBytes: LIMITS.REPO_HARD_GUIDANCE };
  }

  publicUrl(path) {
    const branch = this.branch || 'main';
    return `https://raw.githubusercontent.com/${this.owner}/${this.repo}/${encodeURIComponent(branch)}/${encodePath(path)}`;
  }

  /* --------------------------------------------------------------- listing */

  async listFiles({ prefix = '', includeSystem = false, ref = null } = {}) {
    const branch = ref || this.branch || (await this.getRepo()).defaultBranch;
    this.branch = branch;
    const data = await this._json(`/repos/${this.owner}/${this.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const wanted = normalizePath(prefix);
    const files = (data.tree || [])
      .filter((n) => n.type === 'blob')
      .filter((n) => includeSystem || !n.path.startsWith(LIMITS.SYSTEM_DIR))
      .filter((n) => !wanted || n.path.startsWith(wanted))
      .map((n) => ({ path: n.path, sha: n.sha, size: n.size || 0, mode: n.mode }));
    return { files, truncated: !!data.truncated, branch };
  }

  /* ---------------------------------------------------------------- read */

  async getFileBytes(path) {
    const branch = this.branch || (await this.getRepo()).defaultBranch;
    const url = `/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`;
    const res = await this._raw(url, { accept: 'application/vnd.github.raw', binary: true });
    if (!res.ok) throw this._fail(res);
    return res.bytes;
  }

  /* --------------------------------------------------------------- writes */

  async ensureInitialized() {
    const repo = await this.getRepo({ fresh: true });
    if (!this.branch) this.branch = repo.defaultBranch;
    try {
      await this.getHead({ fresh: true });
    } catch (err) {
      if (err.code !== 'empty-repo') throw err;
      // The Contents API is the only endpoint that can seed a repo with zero commits.
      await this._json(`/repos/${this.owner}/${this.repo}/contents/${encodePath(joinPath(LIMITS.SYSTEM_DIR, 'init.json'))}`, {
        method: 'PUT',
        body: {
          message: 'chore(repovault): initialise vault',
          content: b64encode(utf8(JSON.stringify({ app: 'repovault', v: 1, createdAt: new Date().toISOString() }, null, 2))),
          branch: this.branch,
        },
      });
      this._headCache = null;
      this._repoCache = null;
    }
    if (this.branch !== repo.defaultBranch) await this.ensureBranch(this.branch);
    return this.getRepo({ fresh: true });
  }

  async ensureBranch(branch) {
    try {
      await this._json(`/repos/${this.owner}/${this.repo}/git/ref/heads/${encodeURIComponent(branch)}`);
      return { created: false };
    } catch (err) {
      if (err.code !== 'not-found' && err.code !== 'empty-repo') throw err;
      const head = await this.getHead({ fresh: true });
      await this._json(`/repos/${this.owner}/${this.repo}/git/refs`, {
        method: 'POST',
        body: { ref: `refs/heads/${branch}`, sha: head.sha },
      });
      this.branch = branch;
      this._headCache = null;
      return { created: true };
    }
  }

  /**
   * Create one commit from tree entries.
   * entries: [{ path, sha|null, mode?, type? }] — `sha: null` deletes the path.
   * Uses optimistic locking (force: false): if the branch moved meanwhile we
   * re-read the head and re-commit, so two tabs never silently clobber each other.
   */
  async _commitEntries(entries, { message, attempts = 3 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
      const head = await this.getHead({ fresh: true });
      const tree = await withRetry(() => this._json(`/repos/${this.owner}/${this.repo}/git/trees`, {
        method: 'POST',
        body: { base_tree: head.sha, tree: entries.map((e) => ({ mode: e.mode || '100644', type: e.type || 'blob', ...e })) },
      }));
      const commit = await withRetry(() => this._json(`/repos/${this.owner}/${this.repo}/git/commits`, {
        method: 'POST',
        body: { message, tree: tree.sha, parents: [head.sha] },
      }));
      try {
        await this._json(`/repos/${this.owner}/${this.repo}/git/refs/heads/${encodeURIComponent(this.branch)}`, {
          method: 'PATCH',
          body: { sha: commit.sha, force: false },
        });
        this._headCache = { sha: commit.sha, branch: this.branch };
        return { commit: commit.sha, tree: tree.sha };
      } catch (err) {
        lastErr = err;
        if (err.code !== 'conflict' && err.code !== 'not-found') throw err;
        this._headCache = null; // someone else pushed — rebase onto the new head and retry
      }
    }
    throw lastErr || codedError('conflict', 'Could not update the branch after several attempts.');
  }

  /** Small files: Contents API (also auto-creates the branch on an empty repo). */
  async putSmall(path, bytes, { message, sha = null, onProgress } = {}) {
    const body = {
      message: message || `add ${path}`,
      content: b64encode(bytes),
      branch: this.branch,
      ...(sha ? { sha } : {}),
    };
    if (sha) body.sha = sha;
    const res = await this._raw(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}`, {
      method: 'PUT', body, onProgress,
    });
    if (!res.ok) {
      const err = this._fail(res);
      // Overwriting a file needs its current sha; fetch it and retry once.
      if ((err.code === 'conflict' || err.code === 'unprocessable') && !sha) {
        const existing = await this.getFileMeta(path).catch(() => null);
        if (existing) return this.putSmall(path, bytes, { message, sha: existing.sha, onProgress });
      }
      throw err;
    }
    this._headCache = null;
    const data = JSON.parse(res.text);
    return { commit: data.commit && data.commit.sha, path, size: bytes.length };
  }

  /** Large files: blob → tree → commit → ref. Returns without touching history twice. */
  async putLarge(path, bytes, { message, onProgress } = {}) {
    const blob = await withRetry(() => this._json(`/repos/${this.owner}/${this.repo}/git/blobs`, {
      method: 'POST',
      body: { content: b64encode(bytes), encoding: 'base64' },
      onProgress: onProgress ? (f) => onProgress(f * 0.85) : undefined,
    }));
    const result = await this._commitEntries([{ path: normalizePath(path), sha: blob.sha }], { message });
    if (onProgress) onProgress(1);
    return { commit: result.commit, path, size: bytes.length };
  }

  async putFile(path, data, { message, sha = null, onProgress } = {}) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!bytes.length) throw codedError('empty', 'Refusing to upload an empty payload.');
    if (bytes.length > this.maxFileBytes) {
      throw codedError(
        'too-large',
        `${(bytes.length / 1048576).toFixed(1)} MB exceeds GitHub's 100 MB per-file limit. Split it (e.g. zip parts) or use an R2/S3 adapter (see README).`,
      );
    }
    return bytes.length <= this.smallFileThreshold
      ? this.putSmall(path, bytes, { message, sha, onProgress })
      : this.putLarge(path, bytes, { message, onProgress });
  }

  async getFileMeta(path) {
    const branch = this.branch || (await this.getRepo()).defaultBranch;
    const data = await this._json(`/repos/${this.owner}/${this.repo}/contents/${encodePath(path)}?ref=${encodeURIComponent(branch)}`);
    if (Array.isArray(data)) throw codedError('not-a-file', `${path} is a directory.`);
    return { path, sha: data.sha, size: data.size, url: data.download_url };
  }

  async deleteFile(path, { message } = {}) {
    const result = await this._commitEntries(
      [{ path: normalizePath(path), sha: null }],
      { message: message || `delete ${path}` },
    );
    return { commit: result.commit, path };
  }

  /** Atomic move/rename — the file never re-uploads, even at 90 MB. */
  async moveFile(from, to, { message, sha = null } = {}) {
    let blobSha = sha;
    if (!blobSha) {
      const listing = await this.listFiles({ includeSystem: true });
      const found = listing.files.find((f) => f.path === normalizePath(from));
      if (!found) throw codedError('not-found', `Can't find ${from} in the vault index.`);
      blobSha = found.sha;
    }
    const result = await this._commitEntries(
      [
        { path: normalizePath(to), sha: blobSha },
        { path: normalizePath(from), sha: null },
      ],
      { message: message || `move ${from} → ${to}` },
    );
    return { commit: result.commit, from, to };
  }
}
