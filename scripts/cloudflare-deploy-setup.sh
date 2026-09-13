#!/bin/sh
# One-time setup for the deploy job in .github/workflows/ci.yml.
#
#   1. creates the Cloudflare Pages project `budget-et-compte`;
#   2. stores CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID as GitHub
#      repository secrets so CI can publish the built site.
#
# Credentials are read from the environment or a hidden prompt — never as
# command-line arguments, which would leak through `ps` and shell history.
# Create the token with least privilege: My Profile → API Tokens →
# "Cloudflare Pages — Edit" only.
#
# Usage:
#   CLOUDFLARE_API_TOKEN=… scripts/cloudflare-deploy-setup.sh
#   scripts/cloudflare-deploy-setup.sh           # prompts for the token
#   GH_REPO=owner/name scripts/cloudflare-deploy-setup.sh
set -eu

REPO="${GH_REPO:-Vieuxniang/Budget-et-Compte}"
PROJECT="budget-et-compte"

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

echo "— creating Pages project '$PROJECT' (skipped if it exists)…"
CLOUDFLARE_API_TOKEN="$TOKEN" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID" \
  npx wrangler pages project create "$PROJECT" --production-branch=main 2>&1 |
  tail -2 || echo "  (exists already — continuing)"

echo "— storing GitHub secrets in $REPO…"
gh secret set CLOUDFLARE_API_TOKEN --repo "$REPO" --body "$TOKEN"
gh secret set CLOUDFLARE_ACCOUNT_ID --repo "$REPO" --body "$ACCOUNT_ID"
echo "✓ done — the next push to main (or a manual 'Deploy site' run) publishes."
