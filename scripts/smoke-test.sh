#!/bin/sh
# Post-deploy smoke test: fetch the deployed site and assert the PWA
# artifacts are actually served — the page shell, the webmanifest and the
# service worker. Used by the deploy job in .github/workflows/ci.yml and
# rehearsable against any served build:
#
#   scripts/smoke-test.sh https://budget-et-compte.pages.dev
#   scripts/smoke-test.sh http://127.0.0.1:4173   # after `vite preview`
#
# Retries absorb the first deploy's propagation window (the Pages project
# is created by that same deploy), so the test waits for the site instead
# of racing it. Markers are verified against dist/ artifacts, not guessed.
set -eu

BASE="${1:?usage: smoke-test.sh <base-url>}"
BASE="${BASE%/}"   # tolerate a trailing slash from hand-written URLs
ATTEMPTS="${SMOKE_RETRIES:-6}"
WAIT_SECS="${SMOKE_WAIT:-10}"

run_checks() {
  # The page shell, carrying the brand (which is a French proper name in
  # every locale — see the decision log).
  body=$(curl -fsSL --max-time 30 "$BASE/") || return 1
  printf %s "$body" | grep -qF "Budget et Compte" || {
    echo "✗ app shell: brand marker missing"; return 1
  }
  echo "✓ app shell serves the branded page"

  # The webmanifest, with the same name (installed-app identity).
  manifest=$(curl -fsSL --max-time 30 "$BASE/manifest.webmanifest") || return 1
  printf %s "$manifest" | grep -qF '"name":"Budget et Compte"' || {
    echo "✗ webmanifest: brand missing from name"; return 1
  }
  echo "✓ webmanifest carries the brand"

  # The generated service worker (its shim is importScripts-based).
  sw=$(curl -fsSL --max-time 30 "$BASE/sw.js") || return 1
  printf %s "$sw" | grep -qF "importScripts" || {
    echo "✗ sw.js: not the generated Workbox bundle"; return 1
  }
  echo "✓ service worker served ($(printf %s "$sw" | wc -c | tr -d ' ') bytes)"
}

attempt=1
until run_checks; do
  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "✗ smoke test failed after $attempt attempt(s) against $BASE" >&2
    exit 1
  fi
  echo "… not ready yet (attempt $attempt/$ATTEMPTS) — retrying in ${WAIT_SECS}s"
  attempt=$((attempt + 1))
  sleep "$WAIT_SECS"
done
echo "✓ smoke test passed against $BASE"
