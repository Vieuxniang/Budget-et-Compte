// Creates the ECDSA P-256 keypair used to sign Pro licenses.
//
// The PRIVATE key must never be committed or shipped: it stays on your machine
// (default `.freebuff/license-private.jwk.json`, mode 600) and is passed to
// `node scripts/mint-license.mjs`. The PUBLIC key is not a secret — it is
// embedded in `src/services/license.ts` and shipped to every install, which is
// what lets the app verify a license fully offline.
//
// Why P-256 and not Ed25519? Because the license must be verifiable *by the
// customer's browser*, and Ed25519 only reached WebCrypto in Chrome/Edge 137
// (Aug 2025), Safari 17 and Firefox 129 — Chromium ≤136 and older Android
// WebViews throw NotSupportedError. ECDSA P-256 has been verifiable in every
// engine (and in Node) for years, which matters when the key may be entered on
// a phone that updates slowly. Signatures are raw r||s (64 bytes) per the
// WebCrypto spec, not DER.
//
// Usage:
//   node scripts/license-keygen.mjs [private-key-path]
import { webcrypto as crypto } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const out = process.argv[2] ?? '.freebuff/license-private.jwk.json';

const pair = await crypto.subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
const publicRaw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(privateJwk, null, 2), { mode: 0o600 });

console.log(`private key  → ${out}   (keep it, never commit it)`);
console.log(`public key   → ${publicRaw.length} bytes, paste into src/services/license.ts:`);
console.log(Buffer.from(publicRaw).toString('base64url'));
