/**
 * Encrypted data vault — AES-GCM via WebCrypto (see services/crypto.ts).
 *
 * At rest, localStorage holds ONLY `pfvault1$<saltB64>$<ivB64>$<ctB64>`:
 * accounts, transactions, budgets and goals are unreadable without the
 * password. The AES key is derived from the password (PBKDF2, vault-owned
 * salt) and kept in memory only — locking the app drops it.
 *
 * Wrong-password decryption and ciphertext tampering are both caught by the
 * GCM auth tag and surface as `VaultResult.kind === 'decrypt-error'`.
 * A fresh IV is generated on every save; the salt only changes on setup or
 * password change (it must stay stable for existing ciphertexts' key).
 */

import {
  deriveVaultKey,
  encryptString,
  decryptString,
  toBase64,
  fromBase64,
} from './crypto';
import {
  AppData,
  loadLegacyPlaintextData,
  clearLegacyPlaintextData,
  INITIAL_BUDGET_CATEGORIES,
  INITIAL_GOALS,
} from './storage';

const VAULT_KEY = 'patrifamille_fcfa_vault_v1';
/** Old plaintext key — read once for migration, then deleted. */
const PLAINTEXT_KEY = 'patrifamille_fcfa_data_v2';
const VAULT_PREFIX = 'pfvault1';

export interface VaultEnvelope {
  saltB64: string;
  ivB64: string;
  ctB64: string;
}

export function parseEnvelope(raw: string): VaultEnvelope | null {
  const parts = raw.split('$');
  if (parts.length !== 4 || parts[0] !== VAULT_PREFIX) return null;
  try {
    fromBase64(parts[1]);
    fromBase64(parts[2]);
    fromBase64(parts[3]);
  } catch {
    return null;
  }
  return { saltB64: parts[1], ivB64: parts[2], ctB64: parts[3] };
}

export function readEnvelope(): VaultEnvelope | null {
  const raw = localStorage.getItem(VAULT_KEY);
  return raw ? parseEnvelope(raw) : null;
}

/**
 * Coerce a decrypted payload into a safe AppData shape (defense in depth).
 * Optional collections stay absent when empty, so an install that never opened
 * the tontine module (or never synced) keeps its payload exactly as it was.
 */
export function normalizeVaultData(parsed: unknown): AppData {
  const p = (parsed ?? {}) as Partial<AppData>;
  const identified = <T extends { id?: unknown }>(value: unknown): T[] =>
    Array.isArray(value) ? (value.filter((entry) => Boolean(entry) && typeof (entry as T).id === 'string') as T[]) : [];

  const conflicts = Array.isArray(p.syncConflicts)
    ? p.syncConflicts.filter(
        (entry) => Boolean(entry) && typeof entry.id === 'string' && typeof entry.target === 'string'
      )
    : [];
  return {
    accounts: Array.isArray(p.accounts) ? p.accounts : [],
    transactions: Array.isArray(p.transactions) ? p.transactions : [],
    budgetCategories: Array.isArray(p.budgetCategories) ? p.budgetCategories : INITIAL_BUDGET_CATEGORIES,
    goals: Array.isArray(p.goals) ? p.goals : INITIAL_GOALS,
    ...(conflicts.length > 0 ? { syncConflicts: conflicts } : {}),
    ...(hasItems(p.tontineGroups) ? { tontineGroups: identified(p.tontineGroups) } : {}),
    ...(hasItems(p.tontineMembers) ? { tontineMembers: identified(p.tontineMembers) } : {}),
    ...(hasItems(p.tontineRounds) ? { tontineRounds: identified(p.tontineRounds) } : {}),
    ...(hasItems(p.tontinePayments) ? { tontinePayments: identified(p.tontinePayments) } : {}),
    ...(hasItems(p.installedPacks) ? { installedPacks: identified(p.installedPacks) } : {}),
  };
}

function hasItems(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

// ---------------------------------------------------------------------------
// Core operations — every caller receives the in-memory CryptoKey it must keep
// for the session (App holds it in a ref; locking drops it).
// ---------------------------------------------------------------------------

export type VaultResult =
  | { kind: 'ok'; data: AppData; key: CryptoKey }
  | { kind: 'decrypt-error' };

/** Encrypt and persist app data under the session key. Fresh IV every save. */
export async function encryptAndStore(
  key: CryptoKey,
  saltB64: string,
  data: AppData
): Promise<void> {
  const payload = await encryptString(key, JSON.stringify(data));
  localStorage.setItem(
    VAULT_KEY,
    `${VAULT_PREFIX}$${saltB64}$${toBase64(payload.iv)}$${toBase64(payload.ciphertext)}`
  );
}

/** Derive the key from password + stored salt and decrypt. */
export async function unlockVault(
  password: string,
  envelope: VaultEnvelope
): Promise<VaultResult> {
  try {
    const key = await deriveVaultKey(password, fromBase64(envelope.saltB64));
    const plaintext = await decryptString(key, {
      iv: fromBase64(envelope.ivB64),
      ciphertext: fromBase64(envelope.ctB64),
    });
    const data = normalizeVaultData(JSON.parse(plaintext));
    return { kind: 'ok', data, key };
  } catch {
    // GCM auth failure (wrong password / corrupted envelope) or invalid JSON.
    return { kind: 'decrypt-error' };
  }
}

export interface VaultSession {
  key: CryptoKey;
  /** Base64 salt this key was derived from — required to build envelopes on save. */
  saltB64: string;
}

/**
 * First-time setup: derive a key with a fresh salt and encrypt the given dataset.
 */
export async function setupVault(password: string, data: AppData): Promise<VaultSession> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveVaultKey(password, salt);
  const saltB64 = toBase64(salt);
  await encryptAndStore(key, saltB64, data);
  return { key, saltB64 };
}

/**
 * Password change: encrypt the current data under a new key (fresh salt) and
 * persist. Read-input → write-output, so a failure never destroys data.
 */
export async function rekeyVault(
  newPassword: string,
  data: AppData
): Promise<VaultSession> {
  return setupVault(newPassword, data);
}

// ---------------------------------------------------------------------------
// Migration: existing installs have plaintext v2 data and no vault.
// ---------------------------------------------------------------------------

export function hasPlainLegacyData(): boolean {
  return localStorage.getItem(PLAINTEXT_KEY) !== null;
}

/**
 * One-time migration: encrypt the existing plaintext payload (v2 key, or v1 via
 * storage's legacy migration) into the vault and delete the plaintext keys.
 * Returns the new session, or null when there is nothing to migrate.
 */
export async function migratePlainToVault(
  password: string
): Promise<(VaultSession & { data: AppData }) | null> {
  const data = loadLegacyPlaintextData();
  if (!data) return null;
  const session = await setupVault(password, data);
  clearLegacyPlaintextData();
  return { ...session, data };
}
