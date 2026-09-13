/**
 * Sync cryptography — the relay never learns anything about the contents.
 *
 * Sharing model: one device creates a **sync code** (`BSC1.<salt>.<phrase>`) and
 * the other pastes it. The code carries the salt, so both devices derive the
 * same keys from a high-entropy phrase (PBKDF2, 150k) without either of them
 * ever sending a secret to the relay.
 *
 * From those 32 bytes we derive three independent values by domain separation:
 *
 *   key         AES-GCM key that encrypts the snapshot (never leaves the device)
 *   channelId   the relay's row key — knowing the phrase is required just to
 *               *find* the family's data, let alone read it
 *   writeToken  a bearer token that keeps stray writes out of the channel
 *
 * Blobs are AES-GCM with the channel id **and the slot version** as additional
 * authenticated data: the relay therefore cannot move a blob to another channel
 * or replay an old one into a newer slot without the auth tag failing. That is
 * what makes a hostile (or merely buggy) relay unable to silently revert a
 * device — the anti-rollback check in the engine relies on it.
 */

import { fromBase64, toBase64, toBase64Url } from '../crypto';
import type { CipherBlob, Snapshot } from './types';

export const INVITE_PREFIX = 'BSC1';
export const SYNC_ITERATIONS = 150_000;
export const SYNC_SALT_BYTES = 16;

const LABEL_CHANNEL = 'budget-et-compte/sync1/channel';
const LABEL_TOKEN = 'budget-et-compte/sync1/token';
const LABEL_AAD = 'budget-et-compte/sync1/slot';

export interface SyncKeys {
  /** AES-GCM key over snapshot snapshots. Non-extractable. */
  key: CryptoKey;
  /** Relay row key (base64url, 22 chars) — not a secret in itself, but a locator. */
  channelId: string;
  /** Bearer token presented on writes. */
  writeToken: string;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
}

async function label(labelName: string, bits: Uint8Array): Promise<Uint8Array> {
  return sha256(concat(new TextEncoder().encode(`${labelName}|`), bits));
}

async function pbkdf2Bits(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: salt as unknown as BufferSource, iterations, hash: 'SHA-256' },
    material,
    256
  );
  return new Uint8Array(bits);
}

/** Derives the three sync values from the shared code. */
export async function deriveSyncKeys(
  passphrase: string,
  saltText: string,
  iterations: number = SYNC_ITERATIONS
): Promise<SyncKeys> {
  const salt = decodeBase32(saltText) ?? new Uint8Array(SYNC_SALT_BYTES);
  const bits = await pbkdf2Bits(passphrase, salt, iterations);
  const key = await crypto.subtle.importKey('raw', bits as unknown as BufferSource, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
  return {
    key,
    channelId: toBase64Url((await label(LABEL_CHANNEL, bits)).slice(0, 16)),
    writeToken: toBase64Url(await label(LABEL_TOKEN, bits)),
  };
}

/** The AAD binds a blob to one channel *and* one version (see file header). */
function aad(channelId: string, version: number): Uint8Array {
  return new TextEncoder().encode(`${LABEL_AAD}|${channelId}|${version}`);
}

export async function sealSnapshot(
  keys: SyncKeys,
  version: number,
  snapshot: Snapshot
): Promise<CipherBlob> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: iv as unknown as BufferSource, additionalData: aad(keys.channelId, version) as unknown as BufferSource },
    keys.key,
    new TextEncoder().encode(JSON.stringify(snapshot))
  );
  return { v: 1, iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Returns null for a wrong phrase, a tampered blob, or a transplanted slot. */
export async function openSnapshot(
  keys: SyncKeys,
  version: number,
  blob: CipherBlob
): Promise<Snapshot | null> {
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: fromBase64(blob.iv) as unknown as BufferSource,
        additionalData: aad(keys.channelId, version) as unknown as BufferSource,
      },
      keys.key,
      fromBase64(blob.ct) as unknown as BufferSource
    );
    const parsed = JSON.parse(new TextDecoder().decode(plain)) as Snapshot;
    if (!parsed || parsed.v !== 1 || typeof parsed.records !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Sync code: what the user copies from one device to the other
// ---------------------------------------------------------------------------

/**
 * Crockford base32: 0-9 and A-Z without I, L, O and U. The code is meant to be
 * copied between phones by hand — a case-sensitive alphabet (base64) silently
 * derives a *different* channel when a keyboard or a chat app changes the case,
 * so the whole code is decoded case-insensitively and 'I'/'L'/'O' are folded
 * onto '1'/'0' the way Crockford specifies.
 */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SALT_CHARS = Math.ceil((SYNC_SALT_BYTES * 8) / 5);
export const PASSPHRASE_GROUPS = 4;
export const PASSPHRASE_GROUP_SIZE = 5;

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let buffer = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(buffer << (5 - bits)) & 31];
  return out;
}

/** Returns null on any character outside the alphabet. */
function decodeBase32(text: string): Uint8Array | null {
  let bits = 0;
  let buffer = 0;
  const out: number[] = [];
  for (const raw of text.toUpperCase()) {
    const char = raw === 'O' ? '0' : raw === 'I' || raw === 'L' ? '1' : raw;
    const index = CROCKFORD.indexOf(char);
    if (index < 0) return null;
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/**
 * A high-entropy phrase (~100 bits) — the user never has to invent one, and a
 * human-picked phrase would be the weakest link in the whole scheme.
 */
export function randomPassphrase(groups = PASSPHRASE_GROUPS, size = PASSPHRASE_GROUP_SIZE): string {
  const bytes = crypto.getRandomValues(new Uint8Array(groups * size));
  const chars: string[] = [];
  for (const byte of bytes) chars.push(CROCKFORD[byte % CROCKFORD.length]);
  const out: string[] = [];
  for (let i = 0; i < groups; i += 1) {
    out.push(chars.slice(i * size, (i + 1) * size).join(''));
  }
  return out.join('-');
}

export function newSyncSalt(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(SYNC_SALT_BYTES)));
}

/** `BSC1.<salt>.<phrase>` — safe to send over any channel the user trusts. */
export function formatSyncCode(saltText: string, passphrase: string): string {
  return `${INVITE_PREFIX}.${saltText}.${passphrase}`;
}

export interface ParsedSyncCode {
  saltB64: string;
  passphrase: string;
}

/** Tolerant of spaces, case and the letters Crockford folds; null when malformed. */
export function parseSyncCode(raw: string): ParsedSyncCode | null {
  const parts = raw.trim().split('.');
  if (parts.length !== 3 || parts[0].toUpperCase() !== INVITE_PREFIX) return null;
  const saltText = parts[1].trim().toUpperCase();
  const passphrase = parts[2].trim().toUpperCase();
  if (saltText.length !== SALT_CHARS) return null;
  // A salt of the wrong length would silently derive another channel.
  const salt = decodeBase32(saltText);
  if (!salt || salt.length !== SYNC_SALT_BYTES) return null;
  if (passphrase.replace(/-/g, '').length < PASSPHRASE_GROUPS * PASSPHRASE_GROUP_SIZE) return null;
  if (!decodeBase32(passphrase.replace(/-/g, ''))) return null;
  return { saltB64: saltText, passphrase };
}
