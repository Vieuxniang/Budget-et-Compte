#!/bin/sh
# Pre-push gate — the local stand-in for GitHub branch protection, which is a
# Pro-plan feature on private repositories. Runs the same four gates as CI
# before any push to main and refuses the push if one fails.
#
# Install:  install -m 755 scripts/pre-push-gate.sh .git/hooks/pre-push
# Caveats:  local to this machine, and bypassable with `git push --no-verify`
#           — it catches the accident, not the adversary.
# When the plan allows real protection, replace this with a ruleset requiring
# the `verify` check (scripts in the repo, the gate in .git/hooks stays too).

set -e
cd "$(git rev-parse --show-toplevel)"

echo "▶ pre-push gate: typecheck → i18n → tests → build"

echo "— typecheck"
npm run typecheck

echo "— i18n keys (fr/en/es)"
node scripts/check-i18n.mjs

echo "— tests"
npm test

echo "— build"
npm run build

echo "✓ all gates green — push allowed"
