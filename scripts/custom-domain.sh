#!/bin/sh
# Wire a custom domain to the GitHub Pages site, end to end, from this
# machine. Idempotent — safe to re-run after DNS changes.
#
#   scripts/custom-domain.sh <domain> [www]
#
# What it does:
#   1. prints the exact DNS records to create at the registrar;
#   2. waits for propagation, verified by dig from here;
#   3. sets the PAGES_BASE and SITE_URL repository variables and attaches
#      the domain on GitHub Pages (HTTPS enforced);
#   4. lands the CNAME file through the protected flow — branch, PR, wait
#      for the required `verify` check, merge — because the `main requires
#      verify` ruleset refuses direct pushes to main;
#   5. the merge itself triggers the deploy: the workflow builds
#      root-relative (PAGES_BASE=/) with CNAME in the tree, and the CI
#      smoke test proves the live domain. On a re-run with CNAME already
#      in place, step 4 is skipped and a deploy is dispatched instead.
#
# The user adds the DNS records in the registrar's panel — the one step
# that needs the registrar account.
set -eu

DOMAIN="${1:?usage: custom-domain.sh <domain> [www]}"
WWW="${2:-www.$DOMAIN}"
OWNER="Vieuxniang"
REPO="Budget-et-Compte"
R="$OWNER/$REPO"
IP4="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"
BRANCH="custom-domain"

echo "=== 1. Create these records at the registrar for $DOMAIN ==="
echo "    A     @     185.199.108.153"
echo "    A     @     185.199.109.153"
echo "    A     @     185.199.110.153"
echo "    A     @     185.199.111.153"
echo "    CNAME www   $OWNER.github.io."
echo "(Save, then come back here — this script will wait for propagation.)"
printf 'Press Enter once the records are saved… '
IFS= read -r DUMMY

echo "=== 2. Waiting for DNS propagation (checked with dig)… ==="
for IP in $IP4; do
  printf '  A   %s: ' "$IP"
  n=0
  until dig +short @"$IP" "$DOMAIN" A 2>/dev/null | grep -q "$IP"; do
    n=$((n + 1)); [ "$n" -gt 60 ] && { echo "TIMEOUT"; exit 1; }
    sleep 10
  done
  echo "ok"
done
printf '  CNAME %s: ' "$WWW"
n=0
until dig +short "$WWW" CNAME 2>/dev/null | grep -q "$OWNER.github.io"; do
  n=$((n + 1)); [ "$n" -gt 60 ] && { echo "TIMEOUT"; exit 1; }
  sleep 10
done
echo "ok"

echo "=== 3. Wiring the repo and GitHub Pages ==="
gh variable set SITE_URL --repo "$R" --body "https://$DOMAIN/"
gh variable set PAGES_BASE --repo "$R" --body "/"
gh api "repos/$R/pages" -X PUT \
  -F "cname=$DOMAIN" -F "https_enforced=true" >/dev/null
echo "  SITE_URL + PAGES_BASE set; domain attached with HTTPS enforced."

echo "=== 4. Landing CNAME on main through the protected flow ==="
if [ "$(cat CNAME 2>/dev/null)" = "$DOMAIN" ] \
  && git ls-files --error-unmatch CNAME >/dev/null 2>&1; then
  echo "  CNAME already tracked with the right domain — skipping the PR."
else
  printf '%s\n' "$DOMAIN" > CNAME
  # -C (re)creates the branch from HEAD; --force push is safe here: the
  # branch is this script's scratch space, nothing but CNAME ever lands
  # on it, and re-runs legitimately rewrite its history.
  git switch -C "$BRANCH"
  git add CNAME
  git commit -m "Serve the PWA on $DOMAIN"
  git push -u --force origin "$BRANCH"
  PR=$(gh pr list --repo "$R" --head "$BRANCH" \
    --json number --jq '.[0].number // empty')
  if [ -z "$PR" ]; then
    PR=$(gh pr create --repo "$R" --base main --head "$BRANCH" \
      --title "Serve the PWA on $DOMAIN" \
      --body "Adds the CNAME file for GitHub Pages. Landed through the protected flow: direct pushes to main are refused (ruleset \`main requires verify\`).")
  fi
  echo "  PR #$PR open — waiting for the required verify check…"
  if ! gh pr checks "$PR" --repo "$R" --required --watch --fail-fast; then
    echo "  verify failed — the PR is left open for inspection:" >&2
    echo "  https://github.com/$R/pull/$PR" >&2
    exit 1
  fi
  gh pr merge "$PR" --repo "$R" --merge --delete-branch
  git pull --ff-only origin main
  echo "  CNAME merged — the merge run builds root-relative and deploys."
  echo "✓ done — once that run finishes, https://$DOMAIN serves the app."
  echo "  Certificate issuance can take a few minutes; the CI smoke test"
  echo "  proves the URL, and the uptime check follows it from then on."
  exit 0
fi

echo "=== 5. Dispatching the deploy (CNAME already in place) ==="
gh workflow run CI --repo "$R" --ref main
echo "✓ done — once the run finishes, https://$DOMAIN serves the app."
echo "  Certificate issuance can take a few minutes; the uptime check and"
echo "  the CI smoke test both verify the live URL automatically."
