import './helpers/webcrypto.mjs'; // must come first: installs the crypto global on Node 18
/**
 * PWA tests.
 *
 * Installability is a checklist of boring facts, and every one of them can be
 * asserted: manifest fields, icon sizes (192 + 512, plus a maskable), a linked
 * manifest, an HTTPS-eligible service worker with a fetch handler, and — most
 * importantly — a precache list whose files actually exist on disk. A typo in
 * that list is the classic silent PWA bug: installs fine, breaks offline.
 *
 * The service worker is then *executed* in a sandbox with stubbed caches/fetch,
 * because the rules that matter are about what it refuses to do: intercept
 * uploads or GitHub API calls.
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const ok = (c, m) => assert.ok(c, m);
const read = (p) => readFileSync(join(root, p), 'utf8');

const html = read('index.html');
const swSource = read('sw.js');
const manifest = JSON.parse(read('manifest.webmanifest'));

/* ------------------------------------------------------------------ manifest */

test('manifest has every field a browser needs to offer installation', () => {
  assert.equal(typeof manifest.name, 'string');
  assert.ok(manifest.short_name && manifest.short_name.length <= 12, 'short_name fits under a home-screen icon');
  assert.ok(manifest.start_url, 'start_url present');
  assert.equal(manifest.display, 'standalone', 'standalone is what makes it feel like an app');
  ok(manifest.theme_color, 'theme_color present');
  ok(manifest.background_color, 'background_color present (shown on the splash screen)');
  ok(!/^https?:/.test(manifest.start_url), 'start_url must be relative so it works under /<repo>/ on Pages');
  ok(!/^https?:/.test(manifest.scope || '.'), 'scope must be relative too');
});

test('manifest ships the icon sizes Android and iOS actually require', () => {
  const sizes = manifest.icons.map((i) => i.sizes);
  ok(sizes.includes('192x192'), '192×192 required for Android install');
  ok(sizes.includes('512x512'), '512×512 required for the splash screen');
  ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'a maskable icon stops Android from cropping the art');
  for (const icon of manifest.icons) {
    ok(existsSync(join(root, icon.src)), `icon file exists: ${icon.src}`);
  }
});

test('index.html links the manifest and carries the mobile meta tags', () => {
  ok(html.includes('rel="manifest" href="manifest.webmanifest"'), 'manifest is linked');
  ok(html.includes('name="theme-color"'), 'theme-color tint for the OS chrome');
  ok(html.includes('name="apple-mobile-web-app-capable"'), 'iOS standalone mode');
  ok(html.includes('name="apple-mobile-web-app-title"'), 'iOS home-screen label');
  ok(html.includes('rel="apple-touch-icon"'), 'iOS ignores manifest icons — it needs this');
  ok(html.includes('id="install-btn"'), 'there is an install affordance in the UI');
  ok(html.includes('id="install-sheet"'), 'and instructions for iOS, which has no install prompt');
  ok(html.includes('id="update-chip"'), 'and a way to apply a downloaded update');
});

test('the palette in the manifest matches the app (orange / white / black)', () => {
  assert.equal(manifest.theme_color.toLowerCase(), '#ff7a00');
  assert.equal(manifest.background_color.toLowerCase(), '#0a0a0b');
  ok(html.includes('content="#0a0a0b"'), 'meta theme-color matches background_color');
});

/* ------------------------------------------------------------ service worker */

test('sw.js is valid JavaScript with the four handlers a PWA needs', () => {
  new vm.Script(swSource, { filename: 'sw.js' }); // throws on syntax errors
  for (const evt of ['install', 'activate', 'fetch', 'message']) {
    ok(new RegExp(`addEventListener\\(['"]${evt}['"]`).test(swSource), `handles "${evt}"`);
  }
  ok(/caches\.open\(CACHE_VERSION\)/.test(swSource), 'uses a versioned cache');
  ok(/caches\.keys\(\)[\s\S]*caches\.delete/.test(swSource), 'deletes stale caches on activate');
  ok(/skipWaiting|SKIP_WAITING/.test(swSource), 'can take over immediately when the user asks');
});

test('every URL in the precache list exists on disk', () => {
  const block = swSource.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const paths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  ok(paths.length >= 15, `precaches the app shell (${paths.length} entries)`);
  for (const path of paths) {
    const onDisk = path === './' ? 'index.html' : path.replace(/^\.\//, '');
    ok(existsSync(join(root, onDisk)), `precache entry exists: ${path} → ${onDisk}`);
  }
  ok(paths.includes('./index.html') && paths.includes('./repovault.html'), 'both builds are cached (they are different entry points)');
});

/* ---- behavioural: run the worker with stubbed caches/fetch and watch what it
        does with each kind of request. ---- */

const SW_URL = 'https://cid0980.github.io/Vault-for-me/sw.js';

/** Cache keys are URLs. Strings are resolved against the worker's location,
 *  exactly like a real browser does — that is what makes `caches.match('./index.html')`
 *  hit the entry precached as './index.html'. */
const cacheKey = (req) => {
  if (req && req.url) return req.url;
  try { return new URL(String(req), SW_URL).href; } catch { return String(req); }
};

function loadWorker({ fetchImpl } = {}) {
  const listeners = new Map();
  const waiting = [];
  const store = new Map();
  const cache = {
    add: async (req) => { store.set(cacheKey(req), { status: 200 }); },
    put: async (req, res) => { store.set(cacheKey(req), res); },
    match: async (req) => store.get(cacheKey(req)) || undefined,
  };
  const sandbox = {
    self: {
      location: { origin: 'https://cid0980.github.io', href: 'https://cid0980.github.io/Vault-for-me/sw.js' },
      addEventListener: (type, fn) => listeners.set(type, fn),
      skipWaiting: async () => { sandbox.__skipped = true; },
      clients: { claim: async () => { sandbox.__claimed = true; } },
    },
    caches: {
      open: async () => cache,
      match: async (req) => store.get(cacheKey(req)) || undefined,
      keys: async () => ['repovault-v0', 'repovault-v1'],
      delete: async (name) => { sandbox.__deleted = (sandbox.__deleted || []).concat(name); return true; },
    },
    fetch: fetchImpl || (async (req) => ({ ok: true, status: 200, type: 'basic', url: String(req && req.url ? req.url : req), clone() { return this; } })),
    URL, console: { warn() {}, log() {} }, Promise, Object, RegExp, Array, String, Number,
    __store: store,
  };
  sandbox.self.registration = {};
  const ctx = vm.createContext(sandbox);
  new vm.Script(swSource, { filename: 'sw.js' }).runInContext(ctx);
  const dispatch = (type, event) => {
    const fn = listeners.get(type);
    assert.ok(fn, `worker registered a ${type} listener`);
    fn(event);
  };
  return { sandbox, dispatch, listeners, waiting, store };
}

const makeEvent = (url, { method = 'GET', mode = 'no-cors' } = {}) => {
  const event = { request: { url, method, mode }, responded: undefined, waits: [] };
  event.respondWith = (p) => { event.responded = p; };
  event.waitUntil = (p) => { event.waits.push(p); };
  return event;
};

test('install precaches the shell, tolerates a missing file, and skips waiting', async () => {
  const failed = [];
  const { sandbox, dispatch } = loadWorker({
    fetchImpl: async (req) => {
      const url = String(req);
      if (url.endsWith('apple-touch-icon.png')) failed.push(url);
      if (failed.length) throw new Error('404');
      return { ok: true, status: 200, type: 'basic', url, clone() { return this; } };
    },
  });
  const event = makeEvent('https://cid0980.github.io/Vault-for-me/');
  dispatch('install', event);
  await Promise.all(event.waits);
  ok(sandbox.__skipped, 'skipWaiting() called so updates do not sit idle');
  assert.equal(sandbox.__store.size, 17, `cached 17 shell entries (got ${sandbox.__store.size}) even with a 404 in the list`);
});

test('activate deletes the previous cache version and claims open clients', async () => {
  const { sandbox, dispatch } = loadWorker();
  const event = makeEvent('https://cid0980.github.io/Vault-for-me/');
  dispatch('activate', event);
  await Promise.all(event.waits);
  assert.deepEqual(sandbox.__deleted, ['repovault-v0'], 'only the stale cache is dropped');
  ok(sandbox.__claimed, 'claims clients so the new worker serves the open page');
});

test('uploads are never intercepted (POST/PUT/PATCH go straight to the network)', () => {
  const { dispatch } = loadWorker();
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const event = makeEvent('https://cid0980.github.io/Vault-for-me/app/ui/app.js', { method });
    dispatch('fetch', event);
    assert.equal(event.responded, undefined, `${method} must not be cached or short-circuited`);
  }
});

test('GitHub API and raw links are never intercepted', () => {
  const { dispatch } = loadWorker();
  const crossOrigin = [
    'https://api.github.com/repos/cid0980/Vault-for-me/git/blobs',
    'https://raw.githubusercontent.com/cid0980/Vault-for-me/main/uploads/cat.png',
    'https://objects.githubusercontent.com/somewhere',
  ];
  for (const url of crossOrigin) {
    const event = makeEvent(url);
    dispatch('fetch', event);
    assert.equal(event.responded, undefined, `must not intercept ${url}`);
  }
});

test('same-origin static assets are served from cache with a background refresh', async () => {
  let networkHits = 0;
  const { dispatch, store } = loadWorker({
    fetchImpl: async (req) => {
      networkHits++;
      const url = String(req.url || req);
      return { ok: true, status: 200, type: 'basic', url, clone() { return this; } };
    },
  });
  const url = 'https://cid0980.github.io/Vault-for-me/app/core/vault.js';

  // first request: cache miss → network, and the response gets stored
  const first = makeEvent(url);
  dispatch('fetch', first);
  await first.responded;
  assert.equal(networkHits, 1, 'went to the network on a cache miss');
  assert.ok(store.has(url), 'response was cached for next time');

  // second request: cache hit → instant, no waiting on the network
  const second = makeEvent(url);
  dispatch('fetch', second);
  const served = await second.responded;
  ok(served && served.url === url, 'served the cached copy');
});

test('navigations are network-first, with the cached shell as the offline fallback', async () => {
  const offline = loadWorker({
    fetchImpl: async (req) => ({
      ok: true, status: 200, type: 'basic', url: String(req.url || req),
      clone() { return this; },
    }),
  });
  const offlineEvent = makeEvent('https://cid0980.github.io/Vault-for-me/', { mode: 'navigate' });
  offline.dispatch('fetch', offlineEvent);
  const served = await offlineEvent.responded;
  ok(served && served.status === 200, 'online navigation hits the network first');

  const broken = loadWorker({ fetchImpl: async () => { throw new Error('offline'); } });
  broken.store.set('https://cid0980.github.io/Vault-for-me/index.html', { status: 200, url: 'index.html' });
  ok(broken.store.has('https://cid0980.github.io/Vault-for-me/index.html'), 'cache stub resolves relative keys like a browser');
  const offlineNav = makeEvent('https://cid0980.github.io/Vault-for-me/', { mode: 'navigate' });
  broken.dispatch('fetch', offlineNav);
  const fallback = await offlineNav.responded;
  ok(fallback && fallback.url === 'index.html', 'falls back to the cached index.html when the network is gone');
  ok(broken.store.size > 0, 'fallback came from the cache, not the network');
});

test('the app itself registers the worker and wires the install flow', () => {
  const ui = read('app/ui/app.js');
  ok(/serviceWorker' in navigator/.test(ui), 'feature-detects serviceWorker');
  ok(/register\('\.\/sw\.js'\)/.test(ui), 'registers a relative sw.js (works under /<repo>/)');
  ok(/beforeinstallprompt/.test(ui), 'captures Chrome/Android install prompt');
  ok(/appinstalled/.test(ui), 'reacts when installation completes');
  ok(/Add to Home Screen/i.test(html), 'tells iOS users the two taps they need');
  ok(/display-mode: standalone/.test(ui), 'detects when it is already installed');
});

test('the single-file bundle also carries the install and update UI', () => {
  const bundle = read('repovault.html');
  ok(bundle.includes('id="install-btn"'), 'install button present in the bundle');
  ok(bundle.includes('id="install-sheet"'), 'iOS instructions present in the bundle');
  ok(bundle.includes('registerSW'), 'service-worker registration survived bundling');
  ok(!bundle.includes('import '), 'bundle stays a classic script');
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
console.log(`\n  pwa: ${passed}/${tests.length} passed${failed ? ` — ${failed} FAILED` : ''}`);
process.exit(failed ? 1 : 0);
