/**
 * RepoVault — UI controller.
 *
 * Plain DOM, no framework, no build step. Everything here is wiring: state,
 * rendering the grid/list, the upload tray, the viewer and the settings form.
 * All the interesting logic lives in ../core/* and ../adapters/*, which are
 * DOM-free and unit-tested.
 */

import { LIMITS, formatBytes, timeAgo, kindOf, isTextLike } from '../core/util.js';
import { GitHubAdapter } from '../adapters/github.js';
import { MemoryAdapter } from '../adapters/memory.js';
import { Vault } from '../core/vault.js';
import {
  validatePasscode, createPasscode, verifyPasscode, AutoLock,
  readLock, writeLock, clearLock, isSessionUnlocked, markSessionUnlocked, clearSession,
} from '../core/lock.js';

const $ = (id) => document.getElementById(id);
const CFG_KEY = 'repovault.config.v1';

const CHIPS = [
  { key: 'all', label: 'All', icon: '🗂️' },
  { key: 'image', label: 'Images', icon: '🖼️' },
  { key: 'video', label: 'Videos', icon: '🎬' },
  { key: 'pdf', label: 'PDFs', icon: '📕' },
  { key: 'doc', label: 'Docs', icon: '📄' },
  { key: 'audio', label: 'Audio', icon: '🎵' },
  { key: 'archive', label: 'Archives', icon: '🗜️' },
  { key: 'code', label: 'Code', icon: '⌨️' },
  { key: 'encrypted', label: 'Encrypted', icon: '🔒' },
  { key: 'other', label: 'Other', icon: '📦' },
];

const state = {
  vault: null,
  entries: [],
  query: '',
  kind: 'all',
  folder: '',
  sort: 'name',
  view: 'grid',
  password: '',
  encryptUploads: false,
  objectUrls: new Map(), // path -> object URL (thumbs + viewer)
  thumbs: new Map(),     // path -> object URL for the grid
  queue: [],
  active: 0,
  current: null,         // entry open in the viewer
  lockRecord: null,      // passcode lock config (localStorage)
  autoLock: null,        // AutoLock instance
  activityBound: false,
};

/* ------------------------------------------------------------------ helpers */

let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function show(el, on = true) { el.hidden = !on; }

function alertBox(el, kind, html) {
  el.hidden = !html;
  el.className = 'alert' + (kind ? ' ' + kind : '');
  el.innerHTML = html || '';
}

function confirmDialog(title, text, okLabel = 'Confirm') {
  return new Promise((resolve) => {
    $('confirm-title').textContent = title;
    $('confirm-text').innerHTML = text;
    $('confirm-ok').textContent = okLabel;
    show($('confirm'), true);
    const done = (value) => {
      show($('confirm'), false);
      $('confirm-ok').onclick = $('confirm-cancel').onclick = $('confirm-close').onclick = null;
      resolve(value);
    };
    $('confirm-ok').onclick = () => done(true);
    $('confirm-cancel').onclick = () => done(false);
    $('confirm-close').onclick = () => done(false);
  });
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast(label + ' copied to clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.top = '-1000px';
    document.body.appendChild(ta); ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* blocked */ }
    document.body.removeChild(ta);
    toast(ok ? label + ' copied' : 'Clipboard blocked — copy manually: ' + text.slice(0, 60));
  }
}

function revokeAll() {
  for (const url of [...state.thumbs.values(), ...state.objectUrls.values()]) URL.revokeObjectURL(url);
  state.thumbs.clear();
  state.objectUrls.clear();
}

/* ------------------------------------------------------------------- config */

function loadConfig() {
  try {
    const raw = localStorage.getItem(CFG_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function saveConfig(cfg) {
  try {
    if (cfg && cfg.remember) localStorage.setItem(CFG_KEY, JSON.stringify(cfg));
    else localStorage.removeItem(CFG_KEY);
  } catch { /* storage blocked — session-only mode */ }
}

function fillForm(cfg) {
  if (!cfg) return;
  $('s-backend').value = cfg.backend || 'github';
  $('s-owner').value = cfg.owner || '';
  $('s-repo').value = cfg.repo || '';
  $('s-branch').value = cfg.branch || '';
  $('s-token').value = cfg.token || '';
  $('s-remember').checked = !!cfg.remember;
}

function readForm() {
  return {
    backend: $('s-backend').value,
    owner: $('s-owner').value.trim(),
    repo: $('s-repo').value.trim(),
    branch: $('s-branch').value.trim(),
    token: $('s-token').value.trim(),
    remember: $('s-remember').checked,
  };
}

/* ------------------------------------------------------------------ connect */

async function connect(cfg) {
  const errBox = $('setup-error');
  alertBox(errBox, '', '');
  const label = $('connect-label');
  const btn = $('connect-btn');
  btn.disabled = true;
  label.textContent = 'Connecting…';

  let adapter;
  if (cfg.backend === 'memory') {
    adapter = new MemoryAdapter();
  } else {
    if (!cfg.owner || !cfg.repo) {
      btn.disabled = false; label.textContent = 'Connect vault';
      return alertBox(errBox, 'warn', 'Owner and repository are required — or hit <b>Try the demo vault</b>.');
    }
    if (!cfg.token) {
      btn.disabled = false; label.textContent = 'Connect vault';
      return alertBox(errBox, 'warn', 'A fine-grained token with <b>Contents: Read and write</b> is required. See "How to set this up" below.');
    }
    adapter = new GitHubAdapter({ owner: cfg.owner, repo: cfg.repo, branch: cfg.branch, token: cfg.token });
  }

  const vault = new Vault({ adapter });
  try {
    const info = await vault.connect();
    state.vault = vault;
    state.entries = vault.entries;
    saveConfig(cfg);
    renderChrome();
    show($('setup-screen'), false);
    show($('app-screen'), true);
    show($('settings-btn'), true);
    render();
    const empty = vault.entries.filter((e) => !e.system).length === 0;
    show($('empty-repo-note'), cfg.backend === 'github' && empty);
    toast(cfg.backend === 'memory' ? 'Demo vault ready — nothing leaves this browser' : `Connected to ${info.fullName}`);
    handleDeepLink();
  } catch (err) {
    state.vault = null;
    show($('app-screen'), false);
    show($('setup-screen'), true);
    alertBox(errBox, '', `<b>Couldn't connect.</b> ${err.message}
      ${err.code === 'auth' ? '\nCheck the token has Contents: Read and write on this exact repository.' : ''}`);
  } finally {
    btn.disabled = false;
    label.textContent = 'Connect vault';
  }
}

/* ------------------------------------------------------------------ chrome */

function renderChrome() {
  const info = state.vault.info;
  show($('engine-chip'), true);
  $('engine-name').textContent = state.vault.adapter.id === 'memory'
    ? 'Demo vault · this browser'
    : `${info.fullName}${info.isPrivate ? ' · private' : ' · public'}`;
  $('engine-dot').className = 'dot' + (state.vault.adapter.id === 'memory' ? ' demo' : info.isPrivate ? '' : ' bad');
  $('engine-chip').title = state.vault.adapter.id === 'memory'
    ? 'Demo mode: files live in localStorage and vanish when you clear site data.'
    : info.isPrivate ? 'Private repo: only someone with a token can read these files.' : 'Public repo: anyone with the link can read these files — use Encrypt uploads for anything private.';

  const usage = state.vault.usage;
  show($('usage-chip'), !!usage && state.vault.adapter.id !== 'memory');
  if (usage && state.vault.adapter.id !== 'memory') {
    const pct = Math.min(100, (usage.usedBytes / usage.softLimitBytes) * 100);
    $('usage-meter').style.width = Math.max(pct, usage.usedBytes ? 2 : 0) + '%';
    $('usage-meter').style.background = pct > 85 ? 'var(--bad)' : pct > 60 ? 'var(--warn)' : 'var(--grad)';
    $('usage-text').textContent = `${formatBytes(usage.usedBytes)} / 1 GB`;
    $('usage-chip').title = `Repo size ${formatBytes(usage.usedBytes)} — GitHub recommends staying under 1 GB (5 GB strongly recommended).`;
  }
  show($('lock-btn'), state.vault.hasEncryptedFiles && !!state.password);
  show($('enc-note'), state.vault.hasEncryptedFiles && !state.password);
  show($('empty-repo-note'), state.vault.adapter.id !== 'memory' && state.entries.filter((e) => !e.system).length === 0);
  show($('trunc-warn'), !!state.vault.truncated);
  $('footer-note').textContent = state.vault.adapter.id === 'memory'
    ? 'Demo mode: files stay in this browser only.'
    : `Backend: ${state.vault.adapter.slug}.`;
}

/* --------------------------------------------------------------- rendering */

function visibleEntries() {
  return state.vault.list({ query: state.query, kind: state.kind, folder: state.folder, sort: state.sort });
}

function render() {
  if (!state.vault) return;
  renderChrome();
  renderChips();
  renderFolders();
  renderList();
}

function renderChips() {
  const all = state.vault.entries.filter((e) => !e.system);
  const counts = { all: all.length, encrypted: all.filter((e) => e.encrypted).length };
  for (const e of all) counts[e.kind] = (counts[e.kind] || 0) + 1;
  const html = CHIPS.map((c) => {
    const n = counts[c.key] || 0;
    if (!n && c.key !== 'all') return '';
    return `<button class="filt" data-kind="${c.key}" aria-pressed="${state.kind === c.key}">${c.icon} ${c.label} <b>${n}</b></button>`;
  }).join('');
  const box = $('kind-chips');
  box.innerHTML = html;
  box.querySelectorAll('button').forEach((btn) => btn.addEventListener('click', () => {
    state.kind = btn.dataset.kind;
    render();
  }));
}

function renderFolders() {
  const sel = $('folder-select');
  const folders = state.vault.folders();
  const current = state.folder;
  sel.innerHTML = '<option value="">All folders</option>' +
    folders.map((f) => `<option value="${f}">${f}</option>`).join('');
  sel.value = folders.includes(current) ? current : '';
  state.folder = sel.value;
  show(sel, folders.length > 0);
}

function iconFor(entry) {
  if (entry.encrypted) return '🔒';
  return { image: '🖼️', video: '🎬', audio: '🎵', pdf: '📕', doc: '📄', archive: '🗜️', code: '⌨️' }[entry.kind] || '📦';
}

function sizeBadge(entry) {
  if (entry.size > LIMITS.WARN_FILE_BYTES) return '<span class="badge big">big</span>';
  return '';
}

function renderList() {
  const items = visibleEntries();
  const grid = $('grid');
  const list = $('list');
  show($('empty-state'), items.length === 0);
  show(grid, state.view === 'grid');
  show(list, state.view === 'list');
  $('view-grid').setAttribute('aria-pressed', String(state.view === 'grid'));
  $('view-list').setAttribute('aria-pressed', String(state.view === 'list'));

  if (state.view === 'grid') {
    grid.innerHTML = items.map((e) => `
      <button class="tile" data-path="${escapeAttr(e.path)}">
        <div class="thumb" data-thumb="${escapeAttr(e.path)}">${iconFor(e)}</div>
        <div class="nm">${escapeHtml(e.displayName)}</div>
        <div class="mt">
          <span>${formatBytes(e.size)}</span>
          ${e.encrypted ? '<span class="badge enc">encrypted</span>' : ''}
          ${sizeBadge(e)}
        </div>
      </button>`).join('');
  } else {
    list.innerHTML = items.map((e) => `
      <div class="rowitem" data-path="${escapeAttr(e.path)}">
        <div class="ico">${iconFor(e)}</div>
        <div>
          <div>${escapeHtml(e.displayName)}</div>
          <div class="sub">${escapeHtml(e.folder || '/')}</div>
        </div>
        <div class="sub kind">${e.kind}</div>
        <div class="sub when">${formatBytes(e.size)}</div>
        <div class="acts">
          ${e.encrypted ? '<span class="badge enc">enc</span>' : ''}
        </div>
      </div>`).join('');
  }

  const open = (path) => {
    const entry = state.vault.entries.find((e) => e.path === path);
    if (entry) openViewer(entry);
  };
  for (const node of document.querySelectorAll('[data-path]')) {
    node.addEventListener('click', () => open(node.dataset.path));
  }
  if (state.view === 'grid') observeThumbs();
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/* -------------------------------------------------------------- thumbnails */

let thumbObserver = null;
function observeThumbs() {
  if (!('IntersectionObserver' in window)) return lazyThumbs();
  if (!thumbObserver) {
    thumbObserver = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          thumbObserver.unobserve(e.target);
          enqueueThumb(e.target.dataset.thumb, e.target);
        }
      }
    }, { rootMargin: '240px' });
  }
  document.querySelectorAll('[data-thumb]').forEach((el) => thumbObserver.observe(el));
}

function lazyThumbs() {
  // no IntersectionObserver: just load the first few so the UI still works
  const els = [...document.querySelectorAll('[data-thumb]')].slice(0, 24);
  els.forEach((el) => enqueueThumb(el.dataset.thumb, el));
}

function enqueueThumb(path, el) {
  if (state.thumbs.has(path)) return paintThumb(el, state.thumbs.get(path));
  state.queue.push({ path, el });
  pump();
}

async function pump() {
  const MAX = 3;
  while (state.active < MAX && state.queue.length) {
    const job = state.queue.shift();
    state.active++;
    loadThumb(job.path, job.el).finally(() => { state.active--; pump(); });
  }
}

async function loadThumb(path, el) {
  const entry = state.vault.entries.find((e) => e.path === path);
  if (!entry || entry.kind !== 'image' || entry.encrypted) return; // only plain images get real thumbs
  try {
    if (state.thumbs.has(path)) return paintThumb(el, state.thumbs.get(path));
    const adapter = state.vault.adapter;
    const canUseRaw = adapter.publicUrl && !state.vault.info.isPrivate;
    if (canUseRaw) {
      state.thumbs.set(path, adapter.publicUrl(path));
      return paintThumb(el, state.thumbs.get(path));
    }
    const bytes = await state.vault.readBytes(entry);
    const url = URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
    state.thumbs.set(path, url);
    paintThumb(el, url);
  } catch { /* keep the emoji placeholder */ }
}

function paintThumb(el, url) {
  if (!el || !url) return;
  el.innerHTML = `<img loading="lazy" alt="" src="${url}" />`;
}

/* ------------------------------------------------------------------ viewer */

function closeViewer() {
  show($('viewer'), false);
  $('viewer-media').innerHTML = '';
  for (const [key, url] of state.objectUrls) { URL.revokeObjectURL(url); state.objectUrls.delete(key); }
  state.current = null;
}

async function openViewer(entry) {
  state.current = entry;
  show($('viewer'), true);
  $('viewer-title').textContent = entry.displayName;
  $('viewer-meta').innerHTML = [
    formatBytes(entry.size),
    entry.folder || '/',
    entry.kind,
    entry.encrypted ? 'encrypted' : null,
  ].filter(Boolean).map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('');
  $('viewer-status').textContent = '';
  show($('viewer-password-wrap'), entry.encrypted && !state.password);
  $('viewer-password').value = '';
  renderMedia(entry);
}

async function renderMedia(entry) {
  const box = $('viewer-media');
  const status = $('viewer-status');
  const needsPassword = entry.encrypted && !state.password;
  if (needsPassword) {
    box.innerHTML = `<div class="ph">🔒 This file is encrypted.<br />Enter the vault password to decrypt it in this tab.</div>`;
    return;
  }

  const adapter = state.vault.adapter;
  const canUseRaw = adapter.publicUrl && !state.vault.info.isPrivate && !entry.encrypted;

  // Fast path: public repos stream straight from raw.githubusercontent.com
  if (canUseRaw && ['image', 'video', 'audio', 'pdf'].includes(entry.kind)) {
    const url = adapter.publicUrl(entry.path);
    box.innerHTML = mediaMarkup(entry, url);
    return;
  }
  if (canUseRaw && (entry.kind === 'doc' || entry.kind === 'code') && isTextLike(entry.displayName)) {
    status.textContent = 'loading text…';
    try {
      const res = await fetch(adapter.publicUrl(entry.path));
      const text = await res.text();
      box.innerHTML = `<pre>${escapeHtml(text.slice(0, 200_000))}</pre>`;
    } catch (err) {
      box.innerHTML = `<div class="ph">Couldn't load the preview: ${escapeHtml(err.message)}</div>`;
    }
    status.textContent = '';
    return;
  }

  // Everything else: fetch through the API (works for private repos and decryption)
  box.innerHTML = `<div class="ph">Loading…</div>`;
  try {
    if (['doc', 'code'].includes(entry.kind) && isTextLike(entry.displayName)) {
      const text = await state.vault.text(entry, { password: state.password });
      box.innerHTML = `<pre>${escapeHtml(text)}</pre>`;
      status.textContent = '';
      return;
    }
    const started = Date.now();
    const { blob, name, kind } = await state.vault.download(entry, {
      password: state.password,
      onProgress: (f) => { status.textContent = `decrypting ${Math.round(f * 100)}%`; },
    });
    const url = URL.createObjectURL(blob);
    state.objectUrls.set(entry.path, url);
    box.innerHTML = mediaMarkup({ ...entry, kind, displayName: name, mime: blob.type }, url);
    status.textContent = `fetched in ${((Date.now() - started) / 1000).toFixed(1)}s · ${formatBytes(blob.size)}`;
  } catch (err) {
    box.innerHTML = `<div class="ph">${err.code === 'bad-password' ? '🔑 Wrong vault password.' : '⚠️ ' + escapeHtml(err.message)}</div>`;
    if (err.code === 'bad-password' || err.code === 'password-required') {
      show($('viewer-password-wrap'), true);
      state.password = '';
    }
    status.textContent = '';
  }
}

function mediaMarkup(entry, url) {
  const kind = entry.kind;
  if (kind === 'image') return `<img alt="${escapeAttr(entry.displayName)}" src="${url}" />`;
  if (kind === 'video') return `<video controls playsinline preload="metadata" src="${url}"></video>`;
  if (kind === 'audio') return `<audio controls src="${url}"></audio>`;
  if (kind === 'pdf') return `<iframe title="${escapeAttr(entry.displayName)}" src="${url}"></iframe>`;
  return `<div class="ph">No inline preview for ${escapeHtml(entry.kind)} files.<br />Use <b>Download</b> to save it.<br /><br />
    <a href="${url}" download="${escapeAttr(entry.displayName)}">Download ${escapeHtml(entry.displayName)}</a></div>`;
}

async function unlockViewer() {
  const password = $('viewer-password').value;
  if (!password) return toast('Type the vault password first');
  $('viewer-unlock').disabled = true;
  try {
    await state.vault.ensureKey(password); // derives once, cached for the session
    state.password = password;
    $('vault-password').value = password;
    show($('viewer-password-wrap'), false);
    show($('lock-btn'), true);
    renderChrome();
    await renderMedia(state.current);
    toast('Vault unlocked for this tab');
  } catch (err) {
    toast(err.code === 'bad-password' ? 'Wrong password' : err.message);
  } finally {
    $('viewer-unlock').disabled = false;
  }
}

/* ------------------------------------------------------------------ uploads */

function showTray(on = true) { show($('tray'), on); }

function trayItem(name, size) {
  const li = document.createElement('li');
  li.innerHTML = `
    <div class="lbl"><b title="${escapeAttr(name)}">${escapeHtml(name)}</b><span>${formatBytes(size)}</span></div>
    <div class="bar"><i></i></div>`;
  $('tray-list').prepend(li);
  return li;
}

function setTrayProgress(li, fraction) {
  li.querySelector('.bar i').style.width = Math.round(fraction * 100) + '%';
}

function setTrayDone(li, entry) {
  li.querySelector('.bar').classList.add('done');
  li.querySelector('.bar i').style.width = '100%';
  li.querySelector('.lbl span').textContent = entry.encrypted ? 'encrypted ✓' : 'done ✓';
}

function setTrayFail(li, err) {
  li.querySelector('.bar').classList.add('fail');
  li.querySelector('.lbl span').textContent = err.code === 'too-large' ? 'too big ✗' : 'failed ✗';
  li.title = err.message;
}

async function uploadFiles(fileList, folder) {
  if (!state.vault) return;
  const files = [...fileList];
  if (!files.length) return;
  if (state.encryptUploads && !state.password) {
    show($('encrypt-bar'), true);
    $('vault-password').focus();
    return toast('Set a vault password first (or turn encryption off)');
  }
  $('tray-title').textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}`;
  showTray(true);
  let okCount = 0, failCount = 0;

  for (const file of files) {
    const li = trayItem(file.name, file.size);
    if (file.size > LIMITS.MAX_FILE_BYTES) {
      setTrayFail(li, { code: 'too-large', message: `>${formatBytes(LIMITS.MAX_FILE_BYTES)}` });
      failCount++;
      continue;
    }
    try {
      const entry = await state.vault.upload(file, {
        folder: folder ?? state.folder ?? '',
        encrypt: state.encryptUploads,
        password: state.password,
        onProgress: (f) => setTrayProgress(li, f),
      });
      setTrayDone(li, entry);
      okCount++;
    } catch (err) {
      setTrayFail(li, err);
      failCount++;
      if (err.code === 'too-large' || err.code === 'quota') toast(err.message);
    }
  }

  render();
  if (okCount) toast(`${okCount} file${okCount > 1 ? 's' : ''} committed to ${state.vault.adapter.slug}`);
  if (failCount && !okCount) toast('Upload failed — see the tray for details');
  if (state.vault.truncated) show($('trunc-warn'), true);
}

/* ------------------------------------------------------------------- wiring */

function wire() {
  // ---- setup
  $('s-backend').addEventListener('change', () => {
    const demo = $('s-backend').value === 'memory';
    show($('github-fields'), !demo);
  });
  $('connect-btn').addEventListener('click', () => connect(readForm()));
  $('demo-btn').addEventListener('click', () => connect({ backend: 'memory', remember: true }));
  $('settings-btn').addEventListener('click', () => {
    show($('app-screen'), false);
    show($('setup-screen'), true);
    fillForm(loadConfig() || { backend: 'github', remember: true });
  });

  // ---- toolbar
  $('search').addEventListener('input', (e) => { state.query = e.target.value; renderList(); });
  $('folder-select').addEventListener('change', (e) => { state.folder = e.target.value; renderList(); });
  $('sort-select').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });
  $('view-grid').addEventListener('click', () => { state.view = 'grid'; renderList(); });
  $('view-list').addEventListener('click', () => { state.view = 'list'; renderList(); });
  $('upload-btn').addEventListener('click', () => $('file-input').click());
  $('upload-folder-btn').addEventListener('click', () => $('folder-input').click());
  $('file-input').addEventListener('change', (e) => { uploadFiles(e.target.files, ''); e.target.value = ''; });
  $('folder-input').addEventListener('change', (e) => {
    // keep the folder structure of the picked directory
    const files = [...e.target.files];
    for (const f of files) f.vaultFolder = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(0, -1).join('/') : '';
    (async () => {
      for (const f of files) await uploadFiles([f], f.vaultFolder);
    })();
    e.target.value = '';
  });

  $('refresh-btn').addEventListener('click', async () => {
    try {
      revokeAll();
      await state.vault.refresh();
      render();
      toast('Vault index refreshed');
    } catch (err) { toast('Refresh failed: ' + err.message); }
  });

  $('encrypt-toggle').addEventListener('click', () => {
    state.encryptUploads = !state.encryptUploads;
    $('encrypt-toggle').setAttribute('aria-pressed', String(state.encryptUploads));
    show($('encrypt-bar'), state.encryptUploads || state.vault.hasEncryptedFiles);
    if (state.encryptUploads) {
      $('vault-password').focus();
      toast('New uploads will be encrypted in this browser first');
    }
  });
  $('vault-password').addEventListener('input', (e) => { state.password = e.target.value; show($('lock-btn'), !!state.password); });
  $('lock-btn').addEventListener('click', () => {
    state.vault.lock();
    state.password = '';
    $('vault-password').value = '';
    show($('lock-btn'), false);
    renderChrome();
    toast('Vault locked — password forgotten');
  });

  // ---- drag & drop anywhere on the page
  const drop = $('drop');
  const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  window.addEventListener('dragover', (e) => { if (isFileDrag(e)) { e.preventDefault(); drop.classList.add('over'); } });
  window.addEventListener('dragleave', (e) => { if (e.target === document.documentElement) drop.classList.remove('over'); });
  window.addEventListener('drop', (e) => {
    if (!isFileDrag(e) || !state.vault) return;
    e.preventDefault();
    drop.classList.remove('over');
    uploadFiles(e.dataTransfer.files, state.folder);
  });
  drop.addEventListener('click', () => $('file-input').click());

  // ---- paste files
  window.addEventListener('paste', (e) => {
    if (!state.vault) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) { e.preventDefault(); uploadFiles(files, state.folder); }
  });

  // ---- keyboard
  window.addEventListener('keydown', (e) => {
    if (!$('lock-screen').hidden) return; // the lock screen owns the keyboard
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || '');
    if (e.key === 'Escape') { closeViewer(); show($('confirm'), false); return; }
    if (typing) return;
    if (e.key === '/') { e.preventDefault(); $('search').focus(); }
    if (e.key === 'u' && state.vault) { e.preventDefault(); $('file-input').click(); }
    if (e.key === 'r' && state.vault) { e.preventDefault(); $('refresh-btn').click(); }
  });

  // ---- viewer
  $('viewer-close').addEventListener('click', closeViewer);
  $('viewer').addEventListener('click', (e) => { if (e.target === $('viewer')) closeViewer(); });
  $('viewer-unlock').addEventListener('click', unlockViewer);
  $('viewer-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') unlockViewer(); });
  $('viewer-download').addEventListener('click', async () => {
    const entry = state.current;
    if (!entry) return;
    if (entry.encrypted && !state.password) return toast('Enter the vault password first');
    try {
      let url = state.objectUrls.get(entry.path);
      if (!url) {
        const { blob } = await state.vault.download(entry, { password: state.password });
        url = URL.createObjectURL(blob);
        state.objectUrls.set(entry.path, url);
      }
      const a = document.createElement('a');
      a.href = url;
      a.download = entry.displayName;
      document.body.appendChild(a); a.click(); a.remove();
      toast('Download started');
    } catch (err) { toast('Download failed: ' + err.message); }
  });
  $('viewer-share').addEventListener('click', async () => {
    const entry = state.current;
    if (!entry) return;
    const url = state.vault.shareUrl(entry, location.href);
    if (!url) return toast('This backend has no shareable URL');
    await copyText(url, state.vault.info.isPrivate ? 'App link' : 'Raw link');
    if (state.vault.info.isPrivate) toast('Private repo: whoever opens this needs their own token');
    else if (entry.encrypted) toast('Public link — but the file is encrypted, so it is still unreadable without the password');
  });
  $('viewer-rename').addEventListener('click', async () => {
    const entry = state.current;
    if (!entry) return;
    const next = window.prompt('New name', entry.displayName);
    if (!next || next === entry.displayName) return;
    try {
      await state.vault.rename(entry, next);
      closeViewer();
      render();
      toast('Renamed');
    } catch (err) { toast('Rename failed: ' + err.message); }
  });
  $('viewer-delete').addEventListener('click', async () => {
    const entry = state.current;
    if (!entry) return;
    const yes = await confirmDialog(
      'Delete this file?',
      `<b>${escapeHtml(entry.displayName)}</b> (${formatBytes(entry.size)}) will be removed from the repo's latest commit.
       Note: git keeps history — the blob stays in the object store, so a <2 GB repo does not shrink. See the README for reclaiming space.`,
      'Delete',
    );
    if (!yes) return;
    try {
      await state.vault.remove(entry);
      closeViewer();
      render();
      toast('Deleted from the branch');
    } catch (err) { toast('Delete failed: ' + err.message); }
  });

  // ---- tray
  $('tray-close').addEventListener('click', () => showTray(false));

  // ---- deep link: #repo=owner%2Fname&path=uploads%2Ffile.png
  window.addEventListener('hashchange', handleDeepLink);
}

function handleDeepLink() {
  const hash = location.hash.replace(/^#/, '');
  if (!hash.includes('path=')) return;
  const params = new URLSearchParams(hash);
  const path = params.get('path');
  if (!path || !state.vault) return;
  const entry = state.vault.entries.find((e) => e.path === decodeURIComponent(path));
  if (entry) openViewer(entry);
}

/* ------------------------------------------------------- PWA: install + update */

/** Already running as an installed app? */
function isStandalone() {
  const media = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  return !!media || window.navigator.standalone === true;
}

function isIOS() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS masquerades as macOS
}

let deferredInstall = null;
let swRegistration = null;
let updateRequested = false;

function wireInstall() {
  const btn = $('install-btn');
  if (isStandalone()) return;                       // nothing to offer — it's already installed

  if (isIOS()) { btn.hidden = false; btn.dataset.mode = 'ios'; }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();                             // Chrome's mini-infobar → our own button
    deferredInstall = e;
    btn.hidden = false;
    btn.dataset.mode = 'prompt';
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    btn.hidden = true;
    toast('Installed — open RepoVault from your home screen');
  });

  btn.addEventListener('click', async () => {
    if (btn.dataset.mode === 'prompt' && deferredInstall) {
      deferredInstall.prompt();
      try {
        const choice = await deferredInstall.userChoice;
        if (choice && choice.outcome === 'accepted') {
          toast('Installing…');
          btn.hidden = true;
        }
      } catch { /* the user dismissed it — leave the button in place */ }
      deferredInstall = null;
      return;
    }
    show($('install-sheet'), true);                 // iOS and manual instructions
  });

  $('install-close').addEventListener('click', () => show($('install-sheet'), false));
  $('install-sheet').addEventListener('click', (e) => { if (e.target === $('install-sheet')) show($('install-sheet'), false); });
}

function registerSW() {
  // service workers need a secure context; file:// has none, and that's fine
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    swRegistration = reg;

    // a worker is already waiting from a previous visit
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateChip(true);

    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdateChip(true);
      });
    });
  }).catch((err) => {
    // never let offline caching break the app itself
    console.warn('[repovault] service worker registration failed:', err && err.message);
  });

  // after the waiting worker takes over, reload once so the page matches it
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateRequested) return;                   // first install: no reload needed
    location.reload();
  });

  $('update-chip').addEventListener('click', () => {
    const waiting = swRegistration && swRegistration.waiting;
    if (!waiting) { location.reload(); return; }
    updateRequested = true;
    waiting.postMessage('SKIP_WAITING');
  });
}

function showUpdateChip(on) {
  const chip = $('update-chip');
  if (!chip) return;
  if (on && chip.hidden) toast('A new version is ready — tap Reload to update');
  show(chip, on);
}

/* --------------------------------------------------------------- screen lock */

function showLockScreen() {
  show($('lock-screen'), true);
  show($('setup-screen'), false);
  show($('app-screen'), false);
  show($('settings-btn'), false);
  show($('engine-chip'), false);
  show($('usage-chip'), false);
  show($('tray'), false);
  show($('viewer'), false);
  state.autoLock?.stop();
  setTimeout(() => { try { $('lock-input').focus({ preventScroll: true }); } catch { /* focus needs a user gesture sometimes */ } }, 60);
}

/** Things that must not survive a lock: keys, plaintext URLs, rendered listings. */
function wipeSession() {
  try { state.vault?.lock(); } catch { /* adapter may already be gone */ }
  state.vault = null;
  state.entries = [];
  state.queue = [];
  state.current = null;
  state.password = '';
  state.encryptUploads = false;
  $('vault-password').value = '';
  $('encrypt-toggle').setAttribute('aria-pressed', 'false');
  show($('encrypt-bar'), false);
  revokeAll();
  $('grid').innerHTML = '';
  $('list').innerHTML = '';
  $('kind-chips').innerHTML = '';
  $('viewer-media').innerHTML = '';
}

function lockNow(reason = 'manual') {
  if (!state.lockRecord) return;
  clearSession(sessionStorage);
  wipeSession();
  showLockScreen();
  toast(reason === 'timeout' ? 'Locked after inactivity' : 'Vault locked');
}

async function tryUnlock() {
  const input = $('lock-input');
  const btn = $('lock-unlock');
  const errBox = $('lock-error');
  alertBox(errBox, '', '');
  const passcode = input.value;
  if (!passcode) return alertBox(errBox, 'warn', 'Enter your passcode.');
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    const okPass = await verifyPasscode(passcode, state.lockRecord);
    if (!okPass) {
      alertBox(errBox, '', 'Wrong passcode.');
      input.select();
      return;
    }
    markSessionUnlocked(sessionStorage);
    input.value = '';
    show($('lock-screen'), false);
    toast('Unlocked');
    await resume();
  } catch (err) {
    alertBox(errBox, '', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function startAutoLock() {
  if (!state.lockRecord) return;
  const timeoutMs = Number(state.lockRecord.timeoutMs ?? 15 * 60_000);
  if (!state.autoLock) state.autoLock = new AutoLock({ timeoutMs, onLock: (reason) => lockNow(reason) });
  else state.autoLock.timeoutMs = timeoutMs;
  state.autoLock.start();

  if (!state.activityBound) {
    state.activityBound = true;
    const bump = () => state.autoLock && state.autoLock.armed && state.autoLock.touch();
    ['pointerdown', 'pointermove', 'keydown', 'touchstart', 'wheel'].forEach((ev) =>
      window.addEventListener(ev, bump, { passive: true }));
    document.addEventListener('visibilitychange', () => {
      if (!state.autoLock || !state.autoLock.armed) return;
      if (document.visibilityState === 'hidden') state.autoLock.touch();          // pause while backgrounded
      else if (state.autoLock.remainingMs <= 0) lockNow('timeout');               // expired while away
    });
  }
}

function renderSecurity() {
  const has = !!state.lockRecord;
  show($('lock-remove'), has);
  show($('lock-now'), has);
  $('lock-save').textContent = has ? 'Change passcode' : 'Set passcode';
  if (has) $('lock-timeout').value = String(state.lockRecord.timeoutMs ?? 15 * 60_000);
}

function wireLock() {
  $('lock-save').addEventListener('click', async () => {
    const status = $('lock-status');
    const p1 = $('lock-pass').value;
    const p2 = $('lock-pass2').value;
    if (p1 !== p2) return alertBox(status, '', 'The two passcodes do not match.');
    const check = validatePasscode(p1);
    if (!check.ok) return alertBox(status, '', check.message);
    try {
      const record = await createPasscode(p1, { timeoutMs: Number($('lock-timeout').value) });
      writeLock(localStorage, record);
      state.lockRecord = record;
      markSessionUnlocked(sessionStorage);
      startAutoLock();
      $('lock-pass').value = '';
      $('lock-pass2').value = '';
      alertBox(status, 'ok', 'Passcode set. It will be asked for next time this page loads, and after the inactivity window.');
      renderSecurity();
    } catch (err) {
      alertBox(status, '', err.message);
    }
  });

  $('lock-remove').addEventListener('click', async () => {
    const yes = await confirmDialog(
      'Remove the screen lock?',
      'Anyone who picks up this device can open RepoVault again. The passcode is not used to encrypt files, so nothing becomes unreadable by removing it.',
      'Remove lock',
    );
    if (!yes) return;
    clearLock(localStorage);
    state.lockRecord = null;
    state.autoLock?.stop();
    state.autoLock = null;
    alertBox($('lock-status'), 'ok', 'Screen lock removed.');
    renderSecurity();
  });

  $('lock-now').addEventListener('click', () => lockNow('manual'));
  $('lock-unlock').addEventListener('click', tryUnlock);
  $('lock-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });

  $('lock-forgot').addEventListener('click', async () => {
    const yes = await confirmDialog(
      'Remove the lock without the passcode?',
      'This clears the lock <b>and</b> the saved GitHub token and settings in this browser — a passcode you cannot enter should not leave your token usable by someone else. Files already in your repository are untouched.',
      'Remove lock + settings',
    );
    if (!yes) return;
    clearLock(localStorage);
    saveConfig(null);
    state.lockRecord = null;
    state.autoLock?.stop();
    state.autoLock = null;
    $('s-token').value = '';
    $('lock-input').value = '';
    show($('lock-screen'), false);
    show($('app-screen'), false);
    show($('setup-screen'), true);
    alertBox($('setup-error'), 'warn', 'Lock and saved credentials cleared. Paste your token to reconnect — your files in the repo are safe.');
    renderSecurity();
  });
}

/* -------------------------------------------------------------------- boot */

/** Connect (or restore) the session. Called on load and after every unlock. */
async function resume() {
  if (state.lockRecord) {
    markSessionUnlocked(sessionStorage);
    startAutoLock();
  }
  renderSecurity();
  if (state.vault) {                       // already connected, just re-show
    show($('setup-screen'), false);
    show($('app-screen'), true);
    show($('settings-btn'), true);
    render();
    return;
  }
  const cfg = loadConfig();
  if (cfg) {
    fillForm(cfg);
    if ($('s-backend').value === 'memory') show($('github-fields'), false);
    await connect(cfg);                    // auto-reconnect with the remembered token
  } else {
    show($('setup-screen'), true);
  }
}

export function mount() {
  wire();
  wireLock();
  wireInstall();
  registerSW();
  $('s-remember').checked = true;
  state.lockRecord = readLock(localStorage);

  if (state.lockRecord && !isSessionUnlocked(sessionStorage)) {
    showLockScreen();
  } else {
    resume();
  }
  if (!('clipboard' in navigator)) toast('Clipboard API unavailable — copy links manually');
}

if (typeof document !== 'undefined' && document.getElementById && document.getElementById('setup-screen')) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
}
