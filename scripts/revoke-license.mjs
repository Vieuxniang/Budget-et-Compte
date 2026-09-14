// Adds a license id to the embedded revocation list (`src/services/
// revocations.json`). Purely offline, like everything else in the licensing
// chain: the list ships with the next app build, and every device verifies
// against it from then on.
//
// Usage:
//   node scripts/revoke-license.mjs lic_aymeric
//   node scripts/revoke-license.mjs --undo lic_aymeric   # remove from the list
//
// After revoking, the release notes are the buyer's only notification — the
// app simply stops recognizing the key.
import fs from 'node:fs';

const LIST_PATH = 'src/services/revocations.json';

const [rawId] = process.argv.slice(2).filter((a) => a !== '--undo');
const undo = process.argv.includes('--undo');

if (!rawId) {
  console.error('Usage: node scripts/revoke-license.mjs [--undo] <license-id>');
  process.exit(1);
}
const id = rawId.trim();

const list = JSON.parse(fs.readFileSync(LIST_PATH, 'utf8'));
const revoked = new Set(list.revoked);

if (undo) {
  if (!revoked.delete(id)) {
    console.error(`${id} was not on the list.`);
    process.exit(1);
  }
} else if (revoked.has(id)) {
  console.log(`${id} is already revoked — nothing to do.`);
  process.exit(0);
} else {
  revoked.add(id);
}

// Stable order: the file diffs read as a ledger, not a shuffle.
const next = { v: 1, revoked: [...revoked].sort() };
fs.writeFileSync(LIST_PATH, `${JSON.stringify(next, null, 2)}\n`);
console.log(
  `${undo ? 'Restored' : 'Revoked'}: ${id}\n` +
  `List now holds ${next.revoked.length} id(s). ` +
  'Commit the change and ship an app update — devices re-check on every boot.'
);
