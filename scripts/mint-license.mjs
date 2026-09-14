// Signs a Pro license key with the ECDSA P-256 private key produced by
// `scripts/license-keygen.mjs`. Purely offline: no server, no database.
//
// A key is `BCP1.<payload>.<signature>` where payload is base64url(JSON) and
// the signature covers that exact base64url text — so verification never
// depends on JSON key order or whitespace.
//
// Usage:
//   node scripts/mint-license.mjs --id lic_famille01 --name "Famille Diallo"
//   node scripts/mint-license.mjs --id lic_x --plan pro --expires 2027-12-31
//
// Options: --key <private-key-path>  (default .freebuff/license-private.jwk.json)
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const keyPath = flag('key', '.freebuff/license-private.jwk.json');
const id = flag('id', null);
const plan = flag('plan', 'pro');
const name = flag('name', undefined);
const expires = flag('expires', null);

if (!id) {
  console.error('Missing --id (a stable identifier for the buyer, e.g. --id lic_aymeric).');
  process.exit(1);
}
if (!fs.existsSync(keyPath)) {
  console.error(`Private key not found at ${keyPath}. Run: node scripts/license-keygen.mjs`);
  process.exit(1);
}

// A revoked id must never be minted again: the app would refuse the key on
// sight, and the buyer would pay for a licence that cannot activate.
const revocationsPath = 'src/services/revocations.json';
const revokedIds = new Set(
  JSON.parse(fs.readFileSync(revocationsPath, 'utf8')).revoked
);
if (revokedIds.has(id)) {
  console.error(`Refusing: ${id} is revoked (see ${revocationsPath}). Choose a fresh id for the new buyer.`);
  process.exit(1);
}

const payload = {
  v: 1,
  id,
  plan,
  ...(name ? { name } : {}),
  issued: new Date().toISOString().slice(0, 10),
  expires,
};

const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
const privateKey = await crypto.subtle.importKey(
  'jwk',
  JSON.parse(fs.readFileSync(keyPath, 'utf8')),
  { name: 'ECDSA', namedCurve: 'P-256' },
  false,
  ['sign']
);
const signature = new Uint8Array(
  await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    new TextEncoder().encode(encodedPayload)
  )
);

const key = `BCP1.${encodedPayload}.${Buffer.from(signature).toString('base64url')}`;
console.log(key);
