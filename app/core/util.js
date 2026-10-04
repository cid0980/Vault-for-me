/**
 * RepoVault — shared helpers.
 *
 * Pure, DOM-free, dependency-free. Runs identically in the browser (as an ES
 * module) and in Node (for the test suite), which is why every function here
 * avoids touching `window` or `document`.
 */

/** Hard facts we build around (see README → "The honest limits"). */
export const LIMITS = {
  SMALL_FILE_BYTES: 20 * 1024 * 1024, //   <= this: Contents API (simple, one request)
  WARN_FILE_BYTES: 50 * 1024 * 1024, //   GitHub starts warning about blobs this big
  MAX_FILE_BYTES: 100 * 1024 * 1024, //   hard block for normal git objects
  REPO_SOFT_LIMIT: 1024 * 1024 * 1024, // 1 GB "recommended" repo size
  REPO_HARD_GUIDANCE: 5 * 1024 * 1024 * 1024,
  SYSTEM_DIR: '.vault/', //               hidden housekeeping folder
};

export const te = new TextEncoder();
export const td = new TextDecoder();

/* ------------------------------------------------------------------ bytes */

export function formatBytes(n, digits = 1) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let u = -1, x = v;
  do { x /= 1024; u++; } while (x >= 1024 && u < units.length - 1);
  return x.toFixed(x < 10 ? digits : 0) + ' ' + units[u];
}

export function timeAgo(ts) {
  if (!ts) return 'unknown';
  const diff = Date.now() - new Date(ts).getTime();
  const s = Math.round(diff / 1000);
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.round(h / 24);
  if (d < 31) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

/* ------------------------------------------------------------------ paths */

export function normalizePath(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .join('/');
}

export function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join('/'));
}

export function dirName(p) {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i === -1 ? '' : n.slice(0, i);
}

export function baseName(p) {
  const n = normalizePath(p);
  const i = n.lastIndexOf('/');
  return i === -1 ? n : n.slice(i + 1);
}

export function extOf(p) {
  const name = baseName(p);
  const i = name.lastIndexOf('.');
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase();
}

/** Percent-encode each path segment but keep the slashes. */
export function encodePath(p) {
  return normalizePath(p).split('/').map(encodeURIComponent).join('/');
}

/** Make a filename safe for git + URLs + our UI. */
export function safeFileName(name, fallback = 'file') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|#%]+/g, '-')
    .replace(/[\u0000-\u001f\u007f]+/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\.{2,}/g, '.') // kill dot-runs so a name can never read as a traversal
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

export function safeFolder(folder) {
  return normalizePath(folder || '').split('/').map((s) => s.replace(/[\\:*?"<>|#%]+/g, '-')).join('/');
}

/** `report.pdf` → `report-2.pdf` when `report.pdf` is already taken. */
export function uniquePath(path, taken) {
  const has = (p) => (taken instanceof Set ? taken.has(p) : taken.includes(p));
  if (!has(path)) return path;
  const dir = dirName(path), name = baseName(path), ext = extOf(path);
  const stem = ext ? name.slice(0, -(ext.length + 1)) : name;
  for (let i = 2; i < 1000; i++) {
    const candidate = joinPath(dir, `${stem}-${i}${ext ? '.' + ext : ''}`);
    if (!has(candidate)) return candidate;
  }
  throw new Error('Too many files with that name.');
}

/* -------------------------------------------------------------- file kinds */

export const KINDS = {
  image: { label: 'Images', icon: '🖼️', mime: null },
  video: { label: 'Videos', icon: '🎬', mime: null },
  audio: { label: 'Audio', icon: '🎵', mime: null },
  pdf: { label: 'PDFs', icon: '📕', mime: 'application/pdf' },
  doc: { label: 'Docs', icon: '📄', mime: null },
  archive: { label: 'Archives', icon: '🗜️', mime: null },
  code: { label: 'Code', icon: '⌨️', mime: null },
  other: { label: 'Other', icon: '📦', mime: 'application/octet-stream' },
};

const EXT_KIND = {
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', svg: 'image', ico: 'image', heic: 'image',
  mp4: 'video', webm: 'video', mov: 'video', m4v: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', m4a: 'audio', flac: 'audio', aac: 'audio',
  pdf: 'pdf',
  md: 'doc', txt: 'doc', rtf: 'doc', doc: 'doc', docx: 'doc', xls: 'doc', xlsx: 'doc', ppt: 'doc', pptx: 'doc', csv: 'doc', epub: 'doc',
  zip: 'archive', gz: 'archive', tar: 'archive', '7z': 'archive', rar: 'archive', bz2: 'archive', xz: 'archive',
  js: 'code', mjs: 'code', ts: 'code', jsx: 'code', tsx: 'code', json: 'code', html: 'code', css: 'code', py: 'code', rb: 'code', go: 'code', rs: 'code', java: 'code', c: 'code', cpp: 'code', h: 'code', sh: 'code', yml: 'code', yaml: 'code', toml: 'code', sql: 'code', xml: 'code',
};

const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml', ico: 'image/x-icon',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/x-m4v', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac', aac: 'audio/aac',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', html: 'text/html', css: 'text/css', js: 'text/javascript', xml: 'application/xml',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
  vault: 'application/octet-stream',
};

export function kindOf(name) {
  return EXT_KIND[extOf(name)] || 'other';
}

export function mimeOf(name) {
  return MIME[extOf(name)] || 'application/octet-stream';
}

export function isTextLike(name) {
  const e = extOf(name);
  return ['txt', 'md', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'log', 'ini', 'env'].includes(e) || KINDS[EXT_KIND[e]] && EXT_KIND[e] === 'code';
}

/* ----------------------------------------------------------------- base64 */

const CHUNK = 0x8000;

/** Base64 for arbitrarily large buffers without blowing the call stack. */
export function b64encode(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  let out = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

export function b64decode(str) {
  const bin = atob(String(str || '').replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(str) { return te.encode(String(str)); }
export function fromUtf8(bytes) { return td.decode(bytes); }

/** Accepts File | Blob | ArrayBuffer | TypedArray | string → Uint8Array. */
export async function toBytes(input) {
  if (input == null) throw new Error('No data supplied.');
  if (typeof input === 'string') return utf8(input);
  if (input instanceof Uint8Array) return input;
  if (typeof ArrayBuffer !== 'undefined' && input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof Blob !== 'undefined' && input instanceof Blob) return new Uint8Array(await input.arrayBuffer());
  throw new Error('Unsupported data type: ' + Object.prototype.toString.call(input));
}

/* ----------------------------------------------------------------- retries */

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry `fn` with exponential backoff. Honours `error.retryAfterMs` when the
 * server tells us how long to wait (GitHub's secondary rate limits do).
 */
export async function withRetry(fn, { retries = 3, baseDelay = 700, onRetry, isRetryable } = {}) {
  const retryable = isRetryable || ((e) => !!(e && e.retryable));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !retryable(err)) throw err;
      const wait = Math.min(err.retryAfterMs || baseDelay * 2 ** attempt, 60_000) + Math.random() * 250;
      if (onRetry) onRetry(err, attempt + 1, wait);
      await sleep(wait);
    }
  }
}

/** Small typed error so the UI can react to `err.code` instead of matching text. */
export function codedError(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}
