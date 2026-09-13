#!/bin/sh
# Post-deploy smoke test: fetch the deployed site and assert the PWA
# artifacts are actually served — the page shell, the entry JavaScript
# bundle it references, the webmanifest and the service worker. Used by
# the deploy job in .github/workflows/ci.yml and rehearsable against any
# served build:
#
#   scripts/smoke-test.sh https://vieuxniang.github.io/Budget-et-Compte/
#   scripts/smoke-test.sh http://127.0.0.1:4173/Budget-et-Compte/
#
# Retries absorb a deployment's propagation window, so the test waits for
# the site instead of racing it. Markers are verified against dist/
# artifacts, not guessed. The entry-bundle check is what catches the
# "white screen behind a 200 shell" failure class: a wrong base path or a
# misrouted fallback serves HTML (or nothing) where real JS must be.
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

  # The entry bundle the shell actually references — the white-screen
  # guard. Extract the hashed asset URL from the fetched shell, fetch it,
  # and refuse a masquerading fallback (HTML) or an empty body. A stale
  # cache, a wrong base or a misrouted SPA fallback passes the shell check
  # above but dies here.
  asset=$(printf %s "$body" | grep -oE 'src="[^"]*/assets/index-[^"]*\.js"' | head -1 | sed 's/^src="//; s/"$//') || true
  [ -n "$asset" ] || { echo "✗ app shell references no entry bundle"; return 1; }
  # Assets built with a Vite base are host-absolute (/repo/assets/…): join
  # those to the scheme+host only. Relative ones join to the base URL.
  scheme_host=$(printf %s "$BASE" | sed -E 's#^(https?://[^/]+).*$#\1#')
  case "$asset" in
    http://*|https://*) asset_url="$asset" ;;
    /*) asset_url="$scheme_host$asset" ;;
    *) asset_url="$BASE/$asset" ;;
  esac
  js=$(curl -fsSL --max-time 30 "$asset_url") || {
    echo "✗ entry bundle unreachable: $asset_url"; return 1
  }
  [ -n "$js" ] || { echo "✗ entry bundle empty: $asset_url"; return 1; }
  if printf %s "$js" | grep -qF "<!DOCTYPE"; then
    echo "✗ entry bundle returned HTML (misroute/fallback): $asset_url"; return 1
  fi
  printf %s "$js" | grep -qF "Budget et Compte" || {
    echo "✗ entry bundle: brand marker missing"; return 1
  }
  echo "✓ entry bundle serves real JS ($(printf %s "$js" | wc -c | tr -d ' ') bytes)"

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
