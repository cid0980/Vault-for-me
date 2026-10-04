/**
 * WebCrypto shim for the test suite.
 *
 * Node 19+ exposes a global `crypto` (WebCrypto) in ESM module scope; Node 18
 * does not, even though `node:crypto` has had `webcrypto` since 15. The app
 * modules under test deliberately use the bare `crypto` global because that is
 * what browsers provide, so the tests install it here — imported first, before
 * anything that touches crypto is evaluated.
 *
 * Browsers are unaffected: this file is never loaded by the app itself.
 */

const g = globalThis;

if (!g.crypto || !g.crypto.subtle) {
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(g, 'crypto', { value: webcrypto, configurable: true, writable: true });
}

export const webcrypto = g.crypto;
