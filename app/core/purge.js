/**
 * RepoVault — reclaiming space: is history really gone?
 *
 * The uncomfortable truth this module encodes:
 *
 *   1. `git rm` + commit removes a file from the *branch*. The blob stays in
 *      the object database and keeps counting against the repo.
 *   2. Making the old commits unreachable (a force-push over a rewritten
 *      branch) is as far as a browser can go. It does NOT delete the objects.
 *   3. GitHub runs garbage collection on its own schedule and, per its own
 *      docs on removing sensitive data, expects you to ask Support to expunge
 *      unreachable objects. Until that happens the objects remain fetchable
 *      *by SHA* for anyone who knows one.
 *   4. The only way to guarantee a zero-history repo instantly is to delete
 *      the repository and recreate it from the files you still hold.
 *
 * So the app offers both, tells you which one actually reclaims space, and
 * never pretends the cheap one is the same as the expensive one.
 *
 * DOM-free and pure so the rules (and the warnings) are unit-tested.
 */

import { formatBytes } from './util.js';

export const PURGE_PHRASE = 'PURGE';
export const REBUILD_PHRASE = 'REBUILD';

/** Typed-confirmation matcher: case- and whitespace-insensitive. */
export function matchPhrase(input, phrase) {
  const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toUpperCase();
  return norm(input) === norm(phrase);
}

/** GitHub sends `Link: <…?page=2>; rel="next", <…?page=5>; rel="last"`. */
export function commitCountFromLink(linkHeader, { perPage = 1, bodyLength = 0 } = {}) {
  const link = String(linkHeader || '');
  const last = /[?&]page=(\d+)[^>]*>;\s*rel="last"/.exec(link);
  if (last) return Number(last[1]) * perPage;
  const next = /[?&]page=(\d+)[^>]*>;\s*rel="(?:next|prev)"/.exec(link);
  if (next) return Number(next[1]) * perPage; // single extra page
  return bodyLength;                            // no pagination: the count is the page itself
}

/**
 * Everything the reclaim UI needs to decide what to show, and what to warn
 * about — computed rather than embedded in the template.
 */
export function analyseHistory({
  commitCount = 0,
  branches = [],
  tags = [],
  branch = '',
  fileCount = 0,
  logicalBytes = 0,
  reportedBytes = 0,
} = {}) {
  const otherBranches = (branches || []).filter((b) => b && b !== branch);
  const tagList = tags || [];
  const blockers = [];
  const warnings = [];

  if (commitCount <= 1) blockers.push('History is already a single commit — there is nothing to fold away.');

  if (otherBranches.length) {
    warnings.push(`Other branches still point at the old history (${otherBranches.join(', ')}), so those objects stay reachable — and countable — until the branches are deleted.`);
  }
  if (tagList.length) {
    warnings.push(`Tags keep old commits alive (${tagList.join(', ')}). Delete them or they keep holding space.`);
  }
  if (commitCount > 25) {
    warnings.push(`${commitCount} commits become 1. Old commits are not erased, just made unreachable — see the note below.`);
  }
  if (reportedBytes && logicalBytes && reportedBytes > logicalBytes * 1.5) {
    warnings.push(`GitHub reports ${formatBytes(reportedBytes)} while your files add up to ${formatBytes(logicalBytes)} — most of the difference is history (old versions of files you have since replaced or deleted).`);
  }

  return {
    commitCount,
    branches: branches || [],
    tags: tagList,
    branch,
    fileCount,
    logicalBytes,
    reportedBytes,
    otherBranches,
    removedCommits: Math.max(0, commitCount - 1),
    /** History overhead as far as the numbers let us guess. */
    historyBytes: Math.max(0, reportedBytes - logicalBytes),
    canPurge: blockers.length === 0,
    blockers,
    warnings,
    purgeSteps: [
      'Fold the current file tree into one new root commit (all files preserved, byte for byte)',
      'Force-move the branch to it — the old commits become unreachable',
      'GitHub frees the space when it runs garbage collection; until then the old blobs still exist, findable by SHA',
    ],
  };
}

/** Can we pull every file into the browser and rebuild the repo from it? */
export function planRebuild({ fileCount = 0, totalBytes = 0, hasAdmin = false, memoryLimitBytes = 512 * 1024 * 1024 } = {}) {
  const blockers = [];
  const warnings = [];

  if (!hasAdmin) blockers.push('Rebuilding needs a token with Administration: Read and write (or delete the repo by hand and reconnect).');
  if (fileCount === 0) blockers.push('There is nothing in the vault to rebuild from.');
  if (totalBytes > memoryLimitBytes) {
    blockers.push(`The vault holds ${formatBytes(totalBytes)}; rebuilding downloads everything into the browser first, and this build refuses to do that above ${formatBytes(memoryLimitBytes)}. Export a ZIP backup and rebuild in batches instead.`);
  }
  if (totalBytes > memoryLimitBytes * 0.6) {
    warnings.push('This downloads every file into memory before touching the repository. Keep the tab open and on a stable connection.');
  }
  warnings.push('If anything fails mid-way, the repository has already been recreated empty — download the ZIP backup first, or keep a copy of your files.');

  return {
    canRebuild: blockers.length === 0,
    blockers,
    warnings,
    requiresDownload: fileCount,
    downloadBytes: totalBytes,
    steps: [
      'Download every file into this tab (nothing is deleted until they all arrive)',
      'Delete the repository — instant, guaranteed removal of every object',
      'Recreate it and push everything back as a single commit',
    ],
  };
}

/** Human summary of what just happened, for the UI's result line. */
export function summarisePurge({ before = {}, after = {} } = {}) {
  return {
    headline: `History folded: ${before.commitCount ?? '?'} commits → 1`,
    detail: 'Files are unchanged. Old objects become unreachable; GitHub reclaims the space when it garbage-collects.',
    before,
    after,
  };
}

export function summariseRebuild({ fileCount = 0, totalBytes = 0 } = {}) {
  return {
    headline: `Repository rebuilt with ${fileCount} file${fileCount === 1 ? '' : 's'}`,
    detail: `${formatBytes(totalBytes)} restored as a single commit. Previous history is gone for good — guaranteed, not just unreachable.`,
  };
}
