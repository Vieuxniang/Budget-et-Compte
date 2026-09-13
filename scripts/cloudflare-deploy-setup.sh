#!/bin/sh
# One-time setup for the deploy job in .github/workflows/ci.yml: store
# CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub repository
# secrets so CI can publish the built site.
#
# The Pages project itself is NOT created here — `wrangler pages deploy`
# auto-creates `budget-et-compte` on the first CI deploy (needs the same
# Pages:Edit grant), so this script has exactly one job and no other
# failure modes.
#
# Credentials are read from the environment or a hidden prompt — never as
# command-line arguments, which would leak through `ps` and shell history.
# Create the token with least privilege: My Profile → API Tokens →
# "Cloudflare Pages — Edit" only.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/cloudflare-deploy-setup.sh
#   scripts/cloudflare-deploy-setup.sh           # prompts for both
#   GH_REPO=owner/name scripts/cloudflare-deploy-setup.sh
set -eu

REPO="${GH_REPO:-Vieuxniang/Budget-et-Compte}"

command -v gh >/dev/null 2>&1 || { echo "gh is required" >&2; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "gh is not authenticated (gh auth login)" >&2; exit 1; }

TOKEN="${CLOUDFLARE_API_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  printf 'Cloudflare API token (input hidden): ' >&2
  stty -echo 2>/dev/null || true
  IFS= read -r TOKEN
  stty echo 2>/dev/null || true
  printf '\n' >&2
fi
[ -n "$TOKEN" ] || { echo "no token given" >&2; exit 1; }

ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
if [ -z "$ACCOUNT_ID" ]; then
  printf 'Cloudflare account id (dash → Workers & Pages → right sidebar): ' >&2
  IFS= read -r ACCOUNT_ID
fi
[ -n "$ACCOUNT_ID" ] || { echo "no account id given" >&2; exit 1; }

echo "— storing GitHub secrets in $REPO…"
gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO" --body "$TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --body "$ACCOUNT_ID"

# A receipt (names only — values are never written anywhere) so the setup
# can be verified from the shared workspace without asking anyone to trust
# a terminal they cannot see.
RECEIPT=".freebuff/cf-setup-receipt.txt"
{
  echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "gh: $(command -v gh)"
  echo "gh account: $(gh api user --jq .login 2>/dev/null || echo unknown)"
  echo "repo: $REPO"
  echo "secrets now on repo:"
  gh secret list --repo "$REPO"
} > "$RECEIPT"
echo "✓ done — receipt: $RECEIPT (names only)"
