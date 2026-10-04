#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# RepoVault / CipherLink — one-command push helper
#
#   ./push.sh https://github.com/<your-username>/repovault.git
#   ./push.sh git@github.com:<your-username>/repovault.git
#   GH_TOKEN=github_pat_xxx ./push.sh https://github.com/<you>/<repo>.git   # no prompt
#
# Safe to re-run: it updates the remote instead of failing on "remote exists".
# ---------------------------------------------------------------------------
set -euo pipefail

REPO_URL="${1:-}"
BRANCH="${BRANCH:-main}"

die() { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }
step() { printf '\033[36m▸\033[0m %s\n' "$1"; }
ok()   { printf '\033[32m✓\033[0m %s\n' "$1"; }

if [[ -z "$REPO_URL" ]]; then
  cat >&2 <<'USAGE'
usage: ./push.sh <repo-url>

  HTTPS:  ./push.sh https://github.com/<your-username>/<repo>.git
  SSH:    ./push.sh git@github.com:<your-username>/<repo>.git

  If the repo is empty, create it first (GitHub → New repository, no README),
  or a push will fail with "Repository not found".
USAGE
  exit 2
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "run this from inside the project folder (no git repo here)"

# --- 1. make sure there is something to push -------------------------------
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  step "no commits yet — creating one"
  git add -A
  git commit -q -m "chore: initial commit"
fi

# --- 2. make sure the tree is clean ----------------------------------------
if [[ -n "$(git status --porcelain)" ]]; then
  step "uncommitted changes found — committing them"
  git add -A
  git commit -q -m "chore: snapshot before push ($(date -u +%Y-%m-%dT%H:%MZ))"
fi

# --- 3. point origin at the target ----------------------------------------
if git remote get-url origin >/dev/null 2>&1; then
  step "updating existing origin"
  git remote set-url origin "$REPO_URL"
else
  step "adding origin"
  git remote add origin "$REPO_URL"
fi
ok "origin → $(git remote get-url origin)"

# --- 4. warn (once) about the placeholder author ---------------------------
AUTHOR_NAME="$(git log -1 --format='%an')"
AUTHOR_EMAIL="$(git log -1 --format='%ae')"
if [[ "$AUTHOR_EMAIL" == "you@example.com" ]]; then
  printf '\033[33m!\033[0m commits are authored as "%s <%s>".\n' "$AUTHOR_NAME" "$AUTHOR_EMAIL"
  cat <<'TIP'
  To fix before pushing, run these two lines and this script will re-author:
    git config user.name  "Your Real Name"
    git config user.email "you@users.noreply.github.com"
    git commit --amend --reset-author --no-edit
TIP
fi

# --- 5. push --------------------------------------------------------------
step "pushing $(git rev-list --count HEAD) commit(s) to origin/$BRANCH"

push_url="$REPO_URL"
if [[ -n "${GH_TOKEN:-}" && "$REPO_URL" == https://* ]]; then
  # inject the token without ever printing it
  push_url="$(printf '%s' "$REPO_URL" | sed -E "s#^https://#https://x-access-token:${GH_TOKEN}@#")"
fi

if ! git push -u origin "$BRANCH" --quiet 2>/tmp/push.err || [[ -s /tmp/push.err ]]; then
  # the tokenised URL is only used for the actual transfer
  if [[ -n "${GH_TOKEN:-}" ]]; then
    git push "$push_url" "$BRANCH" -u 2>&1 | grep -v "$GH_TOKEN" || true
  fi
  err="$(cat /tmp/push.err 2>/dev/null || true)"
  if [[ -n "$err" ]]; then
    printf '\033[31merror:\033[0m push failed\n%s\n' "$(printf '%s' "$err" | sed "s/${GH_TOKEN:-__none__}/***/g")" >&2
    cat >&2 <<'HELP'

Common causes:
  • "Repository not found"      → the repo does not exist yet, or the token lacks access to it.
  • "Authentication failed"     → token expired / wrong scope. Needs: Contents = Read and write.
  • "Permission denied (publickey)" → use the HTTPS URL instead, or add your SSH key to GitHub.
  • Nothing to push / up to date → check `git log --oneline` and `git status`.
HELP
    exit 1
  fi
fi

# --- 6. tell them where it landed -----------------------------------------
WEB_URL="$(printf '%s' "$REPO_URL" | sed -E 's#^git@([^:]+):#https://\1/#; s#\.git$##')"
ok "pushed to $WEB_URL (branch: $BRANCH)"
printf '\nNext: enable GitHub Pages → Settings → Pages → Source: GitHub Actions\n'
