/**
 * A small, *honest* mock of the GitHub REST endpoints RepoVault uses.
 *
 * It enforces the rules that actually bite in production:
 *   • empty repos have no refs (409 "Git Repository is empty.")
 *   • overwriting via PUT /contents requires the current blob sha (422 otherwise)
 *   • PATCH /git/refs is fast-forward only (422 on a stale parent)
 *   • blobs are immutable and addressable by sha
 *
 * `inject` lets a test force a failure — and mutate state — at the exact moment
 * a request is made, which is how we simulate "another tab pushed while you
 * were uploading".
 */

import { createHash } from 'node:crypto';

const sha = (obj) => createHash('sha1').update(typeof obj === 'string' ? obj : JSON.stringify(obj)).digest('hex');

function response(status, body, headers = {}) {
  const text = body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const map = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n) => map[String(n).toLowerCase()] ?? null },
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

function binaryResponse(bytes) {
  const copy = new Uint8Array(bytes);
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => '',
    arrayBuffer: async () => copy.buffer,
  };
}

export function createMockGitHub({ owner = 'octo', repo = 'vault', branch = 'main', isPrivate = true, seed = {}, empty = true } = {}) {
  const state = {
    files: new Map(),   // path -> { sha, bytes }
    blobs: new Map(),   // sha  -> Uint8Array
    trees: new Map(),   // sha  -> Map(path -> sha)
    commits: new Map(), // sha  -> { tree, parents }
    head: null,
    requests: [],
    inject: [],         // [(req, state) => {status, body, headers} | undefined]
    apiCalls: 0,
    rateRemaining: '4999',
  };

  function addFile(path, bytes) {
    const blobSha = sha([...bytes].slice(0, 64).join(',') + bytes.length + path);
    state.blobs.set(blobSha, bytes);
    state.files.set(path, { sha: blobSha, bytes });
    return blobSha;
  }

  function currentTreeMap() {
    if (!state.head) return new Map();
    const commit = state.commits.get(state.head);
    return commit ? new Map(state.trees.get(commit.tree) || []) : new Map();
  }

  function commitTree(treeMap, message, parents) {
    const treeSha = sha(['tree', message, [...treeMap.entries()].sort().join('|'), Date.now(), state.commits.size]);
    state.trees.set(treeSha, new Map(treeMap));
    const commitSha = sha(['commit', treeSha, message, parents.join(','), state.commits.size]);
    state.commits.set(commitSha, { tree: treeSha, parents, message });
    state.head = commitSha;
    return commitSha;
  }

  for (const [path, bytesLike] of Object.entries(seed)) {
    addFile(path, bytesLike instanceof Uint8Array ? bytesLike : new TextEncoder().encode(String(bytesLike)));
  }
  if (!empty) {
    commitTree(new Map([...state.files].map(([p, f]) => [p, f.sha])), 'seed', []);
  }

  const prefix = `/repos/${owner}/${repo}`;

  async function route(method, pathname, search, body, headers) {
    // Injectors stay armed until they actually fire (and can mutate state on the way).
    for (let i = 0; i < state.inject.length; i++) {
      const candidate = state.inject[i];
      const injected = typeof candidate === 'function' ? candidate({ method, pathname, body }, state) : candidate;
      if (injected) {
        state.inject.splice(i, 1);
        return response(injected.status, injected.body ?? { message: 'injected failure' }, injected.headers || {});
      }
    }

    if (method === 'GET' && pathname === prefix) {
      const size = [...state.files.values()].reduce((n, f) => n + f.bytes.length, 0);
      return response(200, {
        full_name: `${owner}/${repo}`, private: isPrivate, default_branch: branch,
        size: Math.ceil(size / 1024), html_url: `https://github.com/${owner}/${repo}`, permissions: { push: true },
      });
    }

    if (method === 'GET' && pathname === `${prefix}/git/ref/heads/${branch}`) {
      if (!state.head) return response(409, { message: 'Git Repository is empty.' });
      return response(200, { ref: `refs/heads/${branch}`, object: { sha: state.head } });
    }

    if (method === 'POST' && pathname === `${prefix}/git/refs`) {
      if (body.ref !== `refs/heads/${branch}`) return response(404, { message: 'Not Found' });
      return response(201, { ref: body.ref, object: { sha: body.sha } });
    }

    if (method === 'GET' && pathname.startsWith(`${prefix}/git/trees/`)) {
      if (!state.head) return response(409, { message: 'Git Repository is empty.' });
      const tree = currentTreeMap();
      // the tree is the source of truth for what exists at this commit
      return response(200, {
        sha: state.commits.get(state.head).tree,
        truncated: false,
        tree: [...tree.entries()].map(([path, blobSha]) => ({
          path, mode: '100644', type: 'blob', sha: blobSha, size: state.blobs.get(blobSha)?.length || 0,
        })),
      });
    }

    if (method === 'POST' && pathname === `${prefix}/git/blobs`) {
      const bytes = Buffer.from(body.content, 'base64');
      const blobSha = sha(['blob', bytes.length, bytes.toString('base64').slice(0, 64), state.blobs.size]);
      state.blobs.set(blobSha, new Uint8Array(bytes));
      return response(201, { sha: blobSha });
    }

    if (method === 'POST' && pathname === `${prefix}/git/trees`) {
      const base = body.base_tree ? state.trees.get(state.commits.get(body.base_tree)?.tree) || new Map() : currentTreeMap();
      const tree = new Map(base);
      for (const entry of body.tree || []) {
        if (entry.sha === null) tree.delete(entry.path);
        else tree.set(entry.path, entry.sha);
      }
      const treeSha = sha(['tree', [...tree.entries()].sort().join('|'), state.trees.size]);
      state.trees.set(treeSha, tree);
      return response(201, { sha: treeSha });
    }

    if (method === 'POST' && pathname === `${prefix}/git/commits`) {
      if (state.head && body.parents?.[0] !== state.head) {
        return response(422, { message: 'Update is not a fast forward' });
      }
      if (body.parents?.[0] && !state.commits.has(body.parents[0])) return response(422, { message: 'parent not found' });
      if (!state.trees.has(body.tree)) return response(422, { message: 'tree not found' });
      const commitSha = sha(['commit', body.tree, body.message, (body.parents || []).join(','), state.commits.size]);
      state.commits.set(commitSha, { tree: body.tree, parents: body.parents || [], message: body.message });
      // materialise files from the tree so /contents reads stay truthful …
      for (const [path, blobSha] of state.trees.get(body.tree)) {
        state.files.set(path, { sha: blobSha, bytes: state.blobs.get(blobSha) || new Uint8Array() });
      }
      for (const path of [...state.files.keys()]) if (!state.trees.get(body.tree).has(path)) state.files.delete(path);
      // … but do NOT move the branch: only PATCH /git/refs does that (like real GitHub).
      return response(201, { sha: commitSha, tree: { sha: body.tree }, parents: (body.parents || []).map((s) => ({ sha: s })) });
    }

    if (method === 'PATCH' && pathname.startsWith(`${prefix}/git/refs/heads/`)) {
      const commit = state.commits.get(body.sha);
      if (!commit) return response(422, { message: 'reference update: not a commit' });
      if (state.head && commit.parents[0] !== state.head && !body.force) {
        return response(422, { message: 'Update is not a fast forward' });
      }
      state.head = body.sha;
      return response(200, { ref: `refs/heads/${branch}`, object: { sha: body.sha } });
    }

    if (pathname.startsWith(`${prefix}/contents/`)) {
      const path = decodeURIComponent(pathname.slice(`${prefix}/contents/`.length));
      const existing = state.files.get(path);
      if (method === 'GET') {
        if (!existing) return response(404, { message: 'Not Found' });
        if (String(headers?.Accept || headers?.accept || '').includes('vnd.github.raw')) return binaryResponse(existing.bytes);
        return response(200, { name: path.split('/').pop(), path, sha: existing.sha, size: existing.bytes.length, download_url: `https://raw.example/${path}` });
      }
      if (method === 'PUT') {
        if (existing && !body.sha) {
          return response(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
        }
        if (existing && body.sha && body.sha !== existing.sha) {
          return response(409, { message: 'sha does not match' });
        }
        const bytes = new Uint8Array(Buffer.from(body.content, 'base64'));
        const blobSha = sha(['contents', path, bytes.length, state.blobs.size]);
        state.blobs.set(blobSha, bytes);
        state.files.set(path, { sha: blobSha, bytes });
        const tree = currentTreeMap();
        tree.set(path, blobSha);
        const commitSha = commitTree(tree, body.message, state.head ? [state.head] : []);
        return response(201, { content: { path, sha: blobSha }, commit: { sha: commitSha } });
      }
    }

    return response(404, { message: 'Not Found' });
  }

  const fetchImpl = async (url, init = {}) => {
    state.apiCalls++;
    const u = new URL(url);
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : null;
    state.requests.push({ method, path: u.pathname, search: u.search, body, headers: init.headers || {} });
    return route(method, u.pathname, u.search, body, init.headers || {});
  };

  return {
    state,
    fetchImpl,
    get requestLog() { return state.requests; },
    callsTo(fragment) { return state.requests.filter((r) => (r.method + ' ' + r.path).includes(fragment)); },
    files() { return new Map([...state.files].map(([p, f]) => [p, f.bytes])); },
    bytesOf(path) { return state.files.get(path)?.bytes ?? null; },
    /** Simulate a different tab/client committing while we work. */
    externalPush(path, text) {
      const bytes = new TextEncoder().encode(text);
      addFile(path, bytes);
      const tree = currentTreeMap();
      tree.set(path, state.files.get(path).sha);
      return commitTree(tree, 'external push', state.head ? [state.head] : []);
    },
  };
}
