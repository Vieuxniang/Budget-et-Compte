#!/bin/sh
# Is the domain actually live yet? Run this instead of re-diagnosing DNS by
# hand — it walks the three gates in order and prints the first blocker:
#
#   1. registry delegation  — NS records at the .ci nameservers themselves
#                             (what every resolver on earth eventually says);
#   2. public resolution    — the same NS answer through 1.1.1.1 (catches
#                             fresh registrations stuck in negative caches);
#   3. GitHub's edge        — the four Pages IPs answering the apex A query
#                             from their own addresses (what custom-domain.sh
#                             actually waits for).
#
#   scripts/domain-status.sh [domain]     # default: budgetetcompte.ci
#
# Exit 0 + "READY" only when scripts/custom-domain.sh can run without its
# propagation wait. Exit 1 otherwise, with the reason and where to look.
set -eu

DOMAIN="${1:-budgetetcompte.ci}"
TLD="${DOMAIN##*.}"
OWNER="Vieuxniang"
IP4="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"
digs() { dig +short +time=4 +tries=1 "$@"; }

echo "=== 1. Registry delegation ($TLD nameservers) ==="
DELEG=$(digs "@any.nic.$TLD" NS "$DOMAIN" || true)
if [ -z "$DELEG" ]; then
  echo "  NOT DELEGATED — the registry has no NS records for $DOMAIN."
  echo "  Confirm with:  whois -h whois.nic.$TLD $DOMAIN"
  echo "  If the whois says 'No Object Found', the registration is not yet"
  echo "  active at the registry — check the order status in the registrar"
  echo "  account (.ci adds 1–3 business days of manual validation)."
  exit 1
fi
echo "$DELEG" | sed 's/^/  NS: /'

echo "=== 2. Public resolution (1.1.1.1) ==="
PUBLIC=$(digs "@1.1.1.1" NS "$DOMAIN" || true)
if [ -z "$PUBLIC" ]; then
  echo "  Registered but not resolving publicly yet — negative caches from"
  echo "  before the delegation can hold for up to the zone's negative TTL."
  echo "  This clears on its own; re-run in 30–60 minutes."
  exit 1
fi
echo "$PUBLIC" | sed 's/^/  NS: /'

echo "=== 3. GitHub Pages edge (apex A records) ==="
MISSING=""
for IP in $IP4; do
  if digs "@$IP" "$DOMAIN" A | grep -q "$IP"; then
    echo "  A $IP: ok"
  else
    MISSING="$MISSING $IP"
  fi
done
if [ -n "$MISSING" ]; then
  echo "  Not answering yet:$MISSING"
  echo "  Add the A records (and CNAME www -> $OWNER.github.io.) in the DNS"
  echo "  panel, DNS-only (no proxy), then re-run this script."
  exit 1
fi

echo "READY — run: scripts/custom-domain.sh $DOMAIN"
