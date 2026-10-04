# RepoVault

**Your GitHub repo as cloud storage — no backend, no database, no server bill.**

A static website that turns a git repository into a personal drive. Drag in images, videos, PDFs, zips, anything; the browser commits them straight to your repo via GitHub's API. Open it from any device, preview files inline, share links, rename and delete. Optional **client-side AES-256-GCM encryption** so a *public* repo can safely hold private files.

```
you ──▶ drop files ──▶ [ browser: optional AES-256-GCM ] ──▶ api.github.com ──▶ your repo
                                                                                    │
any device ──▶ RepoVault (static page) ◀── Authorization: Bearer <your token> ◀─────┘
                          ▲
                   no server in the middle: your token never leaves your browser
```

There is no "RepoVault server" anywhere. The whole app is static files you can host for free (or open from disk), and the only network calls it makes are to `api.github.com`.

---

## The honest limits (read this first)

"Unlimited" is the pitch every GitHub-storage gimmick uses. Here are the real numbers, so you can plan around them instead of discovering them at 2 a.m.:

| Limit | Value | What RepoVault does about it |
| --- | --- | --- |
| **Per file, via git** | **100 MiB hard block** | Refuses locally with a clear message *before* burning upload time. |
| Per file, via the GitHub **web UI** | 25 MiB | Irrelevant here — we use the API, not the upload form. |
| Warning threshold | 50 MiB | Flagged with a "big" badge in the UI. |
| **Repo size (recommended)** | **< 1 GB**, < 5 GB strongly recommended | Live usage meter in the header; the app nudges you at 60 % / 85 %. |
| Push size | 2 GB per push | We commit one file at a time, so this never applies. |
| Bandwidth | "significantly excessive" gets throttled; see [AUP §9 Excessive Bandwidth Use](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies) | Fine for personal use; don't run a CDN off it. |
| Free private repos | Unlimited, but private files need a token to read | Encryption handles the alternative: public repo + ciphertext. |
| `git gc` | Deleted blobs stay in history, so the repo doesn't shrink | Documented below — see *Reclaiming space*. |

**Per-repo budget:** ~1 GB comfortable, 5 GB as a practical ceiling, 100 MB max per file. That's a genuinely useful personal drive (photos, documents, installers, project archives) with zero cost and zero ops. If you need *terabytes* of hot storage with public URLs, the `StorageAdapter` interface (below) is designed so you can drop in Cloudflare R2 or S3 in ~60 lines.

---

## Setup in 90 seconds

1. **Create a repo** called `my-vault` (private if you want privacy for free, public if you'll use the built-in encryption).
2. **Create a fine-grained token:** GitHub → *Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token*
   - **Repository access:** Only select repositories → your vault repo
   - **Permissions:** Contents → **Read and write** (nothing else)
   - Expiry: your call; short is safer, longer is convenient.
3. **Open RepoVault** (`repovault.html` works straight from disk — no server needed) and paste *owner / repo / token*.
4. Drop a file in. The first upload bootstraps an empty repo automatically (it writes `.vault/init.json` and creates the first commit for you).

Your token is stored in `localStorage` only if you tick *Remember this browser*. Un-tick it and it lives in memory for that tab.

## What it does

- **Any file type.** Upload by drag-and-drop, file picker, whole folder (structure preserved), or clipboard paste.
- **Upload pipeline built for real files.** ≤ 20 MB goes through one `PUT /contents` call; bigger files go blob → tree → commit → ref through the Git Data API, with a live progress bar (XHR upload events) — this is what makes 90 MB uploads survive.
- **Live previews.** Images, video, audio and PDFs render in a modal; text/code files render as text; anything else gets a download button. Public repos stream previews straight from `raw.githubusercontent.com` (no API quota burned).
- **Client-side encryption.** AES-256-GCM, chunked at 1 MiB, key derived once per vault with PBKDF2-SHA256 (200k iterations, per-vault salt). Filenames and MIME types are stored *inside* the encrypted header, so a public repo leaks neither content nor metadata.
- **Encryption done safely.** A wrong password is rejected and the cached key is dropped, so you can never "half unlock" a vault.
- **Concurrency-safe writes.** Commits use optimistic locking: if another tab (or your laptop on the train) pushed meanwhile, the ref update is rejected, the head is re-read, and your commit is rebased on top. No silent clobbering.
- **Cheap rename/delete.** Both are one tree commit — a 90 MB video is *never* re-uploaded to move it.
- **Folder view, search, filters, sort, grid/list toggle** — all local, instant, no round-trips.
- **Demo mode.** Try the entire app (upload, preview, encrypt, rename, delete) with zero GitHub account, backed by localStorage.
- **Installable app (PWA).** Add it to your home screen and it opens fullscreen with its own icon, works offline, and updates itself with an in-app "Reload to update" chip. Android/desktop get a real install prompt; iOS gets the two-tap Safari instructions. The service worker only ever caches its own shell — uploads and every GitHub API call bypass it entirely.
- **Screen lock + auto-lock.** Optional passcode gate (PBKDF2-hashed, 150k iterations, constant-time compare) with an inactivity timer, so a borrowed phone can't read your file list or reuse the saved token. It's a screen gate, not encryption — the README says so out loud.

## Install it on your phone

Once Pages is enabled, open the site and:

| Platform | How |
| --- | --- |
| **Android (Chrome/Edge)** | A blue **Install app** button appears in the header (or ⋮ → *Install app*). One tap. |
| **iPhone / iPad** | Tap **Share → Add to Home Screen → Add**. Safari only — iOS Chrome can't install PWAs. The app shows these steps if you're on iOS. |
| **Desktop (Chrome/Edge)** | Install icon in the address bar, or **Install app** in the header. |

What you get: standalone window with no browser chrome, its own home-screen icon, **offline support** (the app shell opens with no signal — GitHub calls still need data, obviously), and automatic updates with a "Reload to update" prompt when a new version is cached.

Installability checklist this repo satisfies: HTTPS-hosted, `manifest.webmanifest` with `name`/`start_url`/`display: standalone`/`theme_color` plus 192px, 512px and **maskable** icons, an `apple-touch-icon` for iOS, and a service worker with a `fetch` handler. All of it is asserted in `tests/pwa.test.mjs`.

```
sw.js                  app-shell cache: network-first navigations, cache-first
                       assets, versioned cache, stale-cache eviction.
                       Refuses to touch POST/PUT/PATCH or any cross-origin URL.
manifest.webmanifest   install metadata + icon set (any + maskable)
icons/icon-maskable.svg  full-bleed variant with the art inside Android's safe zone
```

## Architecture

```
index.html                 shell + styles (thin: markup, no logic)
repovault.html             single-file build  ← what you open from disk
app/core/util.js           bytes/paths/retries/formatting     (DOM-free, tested)
app/core/crypto.js         RVLT1 chunked AES-256-GCM format   (DOM-free, tested)
app/adapters/github.js     REST client for GitHub             (injectable fetch → tested)
app/adapters/memory.js     demo/localStorage backend          (tested)
app/core/vault.js          domain layer: list/upload/preview/rename/delete/encrypt (tested)
app/ui/app.js              DOM wiring only
tools/bundle.mjs           modules → single file, fails on duplicate bindings
tools/run-tests.mjs        runs all suites
```

### Adding a new storage backend

Implement the same handful of methods and the entire UI works unchanged:

```js
export class R2Adapter {
  async test() { /* → { owner, repo, fullName, isPrivate, defaultBranch, canPush } */ }
  async ensureInitialized() { /* create bucket/namespace if needed */ }
  async listFiles({ prefix }) { /* → { files: [{ path, sha, size }], truncated } */ }
  async putFile(path, bytes, { message, onProgress }) { /* → { commit } */ }
  async getFileBytes(path) { /* → Uint8Array */ }
  async deleteFile(path) { /* → { commit } */ }
  async moveFile(from, to) { /* → { commit } */ }
  async usage() { /* → { usedBytes, softLimitBytes } */ }
  publicUrl(path) { /* → string | null */ }
}
```

That's the whole contract — `Vault`, the UI, encryption and the tests all sit behind it. (Roadmap: R2/S3 adapter with presigned URLs, which removes the 100 MB cap entirely.)

### The encrypted file format (v1)

```
RVLT1 · uint32 headerLength · JSON header · ciphertext chunks

header = { v:1, alg:"A256GCM", kdf:"PBKDF2-SHA256", iterations, size, chunkSize,
           chunks, iv, name, type, at }

chunk i = AES-256-GCM(key, iv = baseIV[0..8] || uint32BE(i), aad = header || uint32LE(i))
key     = PBKDF2-SHA256(password, salt from .vault/salt.b64, iterations)
```

Why chunked: a 90 MB video never needs a single giant GCM call, memory stays flat, and a corrupt chunk is detected on its own. Why the header is authenticated as AAD: changing the size, chunk count, IV or metadata invalidates every chunk, and swapping two chunks is caught because the chunk index is bound into the AAD.

## Test suite

```bash
npm test        # or: node tools/run-tests.mjs
```

**81 tests, zero dependencies, no network.** The GitHub adapter is exercised against `tests/helpers/mock-github.mjs`, a mock that enforces real semantics — empty repos have no refs, overwriting needs a sha, ref updates must fast-forward, blobs are immutable. The service worker is *executed* in a sandbox with stubbed `caches`/`fetch` to prove what it refuses to intercept.

```
utils  (11)   path traversal attempts, duplicate names, sanitisation, base64 at 200 KB,
              retry/backoff incl. server-supplied retryAfter, formatting
crypto (12)   sizes 0…6 MB around chunk boundaries, no-plaintext-leak, fresh IVs,
              wrong key, single-byte tamper, header tamper, chunk reorder, progress
github (14)   empty-repo bootstrap, both upload paths (call order verified),
              overwrite recovery, system-folder filtering, delete, move-without-
              re-upload, >100 MB refusal, 401 vs 403 vs 422 handling, rate-limit
              backoff, concurrent-push rebase, URL encoding
vault  (13)   upload/list/search/folders/summary, collision handling, hostile
              filenames, encrypted round-trip with plaintext-absence proof,
              session key reuse, wrong-password lockout, rename semantics, delete,
              share URLs, progress monotonicity, quota
lock   (11)   weak-passcode rejection, hash-never-plaintext, unique salts, corrupt
              record handling, constant-time compare, auto-lock timing/activity/
              disable, storage round-trip, session flag
pwa    (14)   manifest install fields + required icon sizes (files must exist),
              precache list vs. disk (catches silent offline breakage), executed
              worker: POST never intercepted, GitHub API never intercepted,
              cache-first assets, network-first navigations with offline fallback
bundle  (6)   regenerates repovault.html from source, then executes it with no DOM:
              crypto round-trip + full vault workflow through the shipped artifact,
              and asserts a fresh build is byte-identical to the committed one
```

CI runs all of that on Node 18/20/22 plus a "is `repovault.html` stale?" gate.

## Deploy it

```bash
git clone https://github.com/cid0980/Vault-for-me.git
cd repovault
npm test                       # 81 tests, ~3 seconds
npm run build                  # refreshes repovault.html
npm run dev                    # http://localhost:8000
```

**GitHub Pages** (recommended — same platform as your storage): push to `main`, then *Settings → Pages → Source: **Deploy from a branch** → branch `main`, folder `/ (root)`*. It goes live at `https://cid0980.github.io/Vault-for-me/` — bookmark that on your phone and your repo is a drive you can reach from anywhere. (Prefer CI-driven deploys? The repo's `test.yml` workflow runs the 81-test suite on every push; pushing workflows needs a token with **Workflows: Read and write**, which is why they are kept out of the first commit.) Want Actions-based deploys instead? Move `docs/actions-pages-workflow.yml` to `.github/workflows/pages.yml` and set Pages → Source: GitHub Actions.

**Netlify / Cloudflare Pages:** drag the folder in (no build command, publish dir `/`); `_headers` adds a strict CSP.

**No hosting at all:** open `repovault.html` from your disk. Everything works except nothing — it's fully functional offline apart from the GitHub calls themselves.

## Reclaiming space

Git is a history, not a delete button: removing a 200 MB video from the branch leaves the blob in the object store, so the repo doesn't shrink and GitHub still counts it. RepoVault says this in the delete dialog rather than pretending otherwise. To actually reclaim:

```bash
git clone --mirror https://github.com/<you>/my-vault.git && cd my-vault.git
git filter-repo --strip-blobs-bigger-than 10M    # or --path uploads/big.mp4 --invert-paths
git reflog expire --expire=now --all && git gc --prune=now --aggressive
git push --force
```

(With great power: that rewrites history. Fine for a personal vault, never for a shared repo.)

## Security notes

- **Threat model.** The token is scoped to one repository with Contents access, and lives in your browser (or memory). Private repo = only token holders read the files. Public repo + encryption = nobody can read them without the password, including GitHub.
- **What encryption does not do:** it doesn't protect a file you've already unlocked on a compromised device, it doesn't make a weak password strong (200k PBKDF2 is a speed bump, not Argon2), and it doesn't hide *that* you stored something. Metadata inside the encrypted header means the *stored filename* is `.vault`-suffixed but still visible; rename it to something opaque if that matters.
- **XSS:** every filename and error string is HTML-escaped before it touches the DOM. The CSP in `_headers` forbids `object-src`, framing and inline event handlers, and allows network access only to GitHub.
- **Losing the password loses the data.** There is no recovery path — there is no server to recover it from. That's the deal.

## Roadmap

- [ ] Cloudflare R2 / S3 adapter with presigned URLs (no 100 MB cap, no token in the browser)
- [ ] Resumable multi-part upload for 5 GB+ objects
- [ ] Git LFS support (2 GB per file on Free)
- [ ] Public "gallery" mode that renders a folder as an album/site
- [ ] Argon2id (WASM) KDF and optional keyfile second factor
- [ ] Multi-vault switcher (one repo per project)

---

## Push it to your account

```bash
cd repovault

git init -b main
git add -A
git commit -m "feat: RepoVault v1 — git repo as cloud storage, zero backend"

# ── HTTPS ──────────────────────────────────────────────────────────────────
git remote add origin https://github.com/cid0980/Vault-for-me.git

# ── or SSH ─────────────────────────────────────────────────────────────────
# git remote add origin git@github.com:cid0980/Vault-for-me.git

git push -u origin main
```

Then enable Pages (**Settings → Pages → Source: GitHub Actions**) and keep your *storage* repo separate from this *app* repo — that way the app can be public and your vault private.

> Note: the demo vault lives in `localStorage`, so it is per-browser and capped at a few MB. It exists to let you try the app, not to store anything real.

## License

MIT © 2026 `cid0980`
