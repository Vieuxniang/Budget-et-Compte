#!/bin/sh
# Wire a custom domain to the GitHub Pages site, end to end, from this
# machine. Idempotent — safe to re-run after DNS changes.
#
#   scripts/custom-domain.sh <domain> [www]
#
# What it does:
#   1. prints the exact DNS records to create at the registrar;
#   2. waits for propagation, verified by dig from here;
#   3. writes the CNAME file, sets the PAGES_BASE and SITE_URL repository
#      variables, and attaches the domain on GitHub Pages (HTTPS enforced);
#   4. triggers a deploy so the build ships root-relative to the new URL.
#
# The user adds the DNS records in the registrar's panel — the one step
# that needs the registrar account.
set -eu

DOMAIN="${1:?usage: custom-domain.sh <domain> [www]}"
WWW="${2:-www.$DOMAIN}"
OWNER="Vieuxniang"
REPO="Budget-et-Compte"
IP4="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"

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
git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "run from inside the repo" >&2; exit 1; }
printf '%s\n' "$DOMAIN" > CNAME
gh variable set SITE_URL --repo "$OWNER/$REPO" --body "https://$DOMAIN/"
gh variable set PAGES_BASE --repo "$OWNER/$REPO" --body "/"
gh api "repos/$OWNER/$REPO/pages" -X PUT \
  -F "cname=$DOMAIN" -F "https_enforced=true" >/dev/null
echo "  CNAME written; SITE_URL + PAGES_BASE set; domain attached with HTTPS enforced."

echo "=== 4. Shipping the root-relative build ==="
git add CNAME && git -c user.name="$OWNER" \
  -c user.email="$(gh api user --jq '.id')+$OWNER@users.noreply.github.com" \
  commit -m "Serve the PWA on $DOMAIN" -- CNAME
git push origin main
gh workflow run CI --repo "$OWNER/$REPO" --ref main
echo "✓ done — once the run finishes, https://$DOMAIN serves the app."
echo "  Certificate issuance can take a few minutes; the uptime check and"
echo "  the CI smoke test both verify the live URL automatically."
