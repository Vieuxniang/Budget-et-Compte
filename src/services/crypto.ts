/**
 * Password hashing + vault encryption service — WebCrypto only.
 *
 * Two distinct derivations from one password:
 * 1. `hashPassword` — PBKDF2 verifier stored as `pbkdf2$<iterations>$<saltHex>$<hashHex>`.
 *    Fast "is this the right password" check; parameters evolve per install.
 * 2. `deriveVaultKey` — PBKDF2 → AES-GCM key that encrypts the financial data
 *    itself (see services/vault.ts). Uses its own salt, stored in the vault envelope.
 *
 * The salt defends against rainbow tables and cross-install reuse, not against
 * someone with device access who can keylog the password.
 */

export const PBKDF2_ITERATIONS = 150_000;
export const PBKDF2_HASH_BITS = 256;
export const SALT_BYTES = 16;
export const PBKDF2_PREFIX = 'pbkdf2';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function fromHex(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Encodage hexadécimal invalide.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function pbkdf2(
  password: string,
  salt: Uint8Array,
  iterations: number
): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  return crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    PBKDF2_HASH_BITS
  );
}

export interface HashParts {
  prefix: string;
  iterations: number;
  saltHex: string;
  hashHex: string;
}

export function parseHashRecord(stored: string): HashParts | null {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== PBKDF2_PREFIX) return null;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations <= 0) return null;
  return { prefix: parts[0], iterations, saltHex: parts[2], hashHex: parts[3] };
}

/** Hash a password for storage: `pbkdf2$iterations$salt$hash`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const bits = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(new Uint8Array(bits))}`;
}

/**
 * Constant-time-ish string compare (length-independent early exit is avoided).
 * Not secret-independent in the cryptographic sense, but prevents the classic
 * `===` short-circuit timing leak on hash comparisons.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export type VerifyResult = 'ok' | 'wrong-password' | 'legacy-hash' | 'invalid-record';

export const IV_BYTES = 12;

/**
 * Verify a password against a stored record.
 * Returns 'legacy-hash' when the record is an old bare SHA-256 hex digest and
 * the password MATCHES it — the caller must then re-hash and persist.
 */
export async function verifyPassword(
  password: string,
  stored: string | undefined
): Promise<VerifyResult> {
  if (!stored) return 'invalid-record';

  if (stored.startsWith(`${PBKDF2_PREFIX}$`)) {
    const parts = parseHashRecord(stored);
    if (!parts) return 'invalid-record';
    try {
      const bits = await pbkdf2(password, fromHex(parts.saltHex), parts.iterations);
      return timingSafeEqual(toHex(new Uint8Array(bits)), parts.hashHex.toLowerCase())
        ? 'ok'
        : 'wrong-password';
    } catch {
      return 'invalid-record';
    }
  }

  // Legacy format: bare 64-char SHA-256 hex digest (unsalted).
  if (/^[0-9a-f]{64}$/i.test(stored)) {
    const legacy = await sha256Hex(password);
    return timingSafeEqual(legacy, stored.toLowerCase()) ? 'legacy-hash' : 'wrong-password';
  }

  return 'invalid-record';
}

/** The legacy hasher, kept only to migrate existing installs. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return toHex(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Vault encryption: PBKDF2 → AES-GCM-256
// ---------------------------------------------------------------------------

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) {
    throw new Error('Encodage base64 invalide.');
  }
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Derive the AES-GCM vault key from a password. Non-extractable key: it can
 * never be read back out of memory, only used to encrypt/decrypt.
 */
export async function deriveVaultKey(
  password: string,
  salt: Uint8Array,
  iterations: number = PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource,
      iterations,
      hash: 'SHA-256',
    },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

export interface EncryptedPayload {
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

/** AES-GCM encrypt a UTF-8 string; fresh 12-byte IV on every call (GCM requirement). */
export async function encryptString(key: CryptoKey, plaintext: string): Promise<EncryptedPayload> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext)
  );
  return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * AES-GCM decrypt. Throws when the key is wrong OR the ciphertext was tampered
 * with — the auth tag gives free integrity verification.
 */
export async function decryptString(key: CryptoKey, payload: EncryptedPayload): Promise<string> {
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: payload.iv as BufferSource },
    key,
    payload.ciphertext as BufferSource
  );
  return new TextDecoder().decode(plaintext);
}

/** base64url, unpadded — compact, URL/QR-safe strings (license keys). */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inverse of `toBase64Url`; accepts padded input too. */
export function fromBase64Url(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return fromBase64(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
}

export { toBase64, fromBase64, toHex, fromHex };
