/**
 * Backup / restore service — portable JSON files, optionally encrypted.
 *
 * Plain backup: human-readable JSON (AppData + metadata). Choose this when the
 * file will stay on a trusted device.
 * Encrypted backup: the same JSON payload encrypted with AES-GCM under a key
 * derived (PBKDF2, dedicated salt) from a passphrase that MAY differ from the
 * app password — the file is self-contained and safe to send/store anywhere.
 *
 * File shape (versioned for future migrations):
 *   { app, kind: 'plain', version: 1, exportedAt, data }
 *   { app, kind: 'encrypted', version: 1, exportedAt, envelope: 'pfbak1$salt$iv$ct' }
 */

import { AppData } from './storage';
import { normalizeVaultData } from './vault';
import { frTranslate, Translate } from '../i18n/translations';
import {
  deriveVaultKey,
  encryptString,
  decryptString,
  toBase64,
  fromBase64,
} from './crypto';

const BACKUP_PREFIX = 'pfbak1';
export const BACKUP_APP_ID = 'patrifamille-fcfa';
export const BACKUP_VERSION = 1;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export interface PlainBackupFile {
  app: typeof BACKUP_APP_ID;
  kind: 'plain';
  version: number;
  exportedAt: string;
  data: AppData;
}

export interface EncryptedBackupFile {
  app: typeof BACKUP_APP_ID;
  kind: 'encrypted';
  version: number;
  exportedAt: string;
  /** `pfbak1$<saltB64>$<ivB64>$<ctB64>` — same envelope format as the vault. */
  envelope: string;
}

export type BackupFile = PlainBackupFile | EncryptedBackupFile;

export type BackupParseResult =
  | { kind: 'ok'; file: BackupFile }
  | { kind: 'invalid'; reason: string };

export type BackupReadResult =
  | { kind: 'ok'; data: AppData }
  | { kind: 'wrong-passphrase' }
  | { kind: 'invalid'; reason: string };

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

export function buildBackup(data: AppData, now: Date = new Date()): PlainBackupFile {
  return {
    app: BACKUP_APP_ID,
    kind: 'plain',
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    data,
  };
}

export async function buildEncryptedBackup(
  data: AppData,
  passphrase: string,
  now: Date = new Date()
): Promise<EncryptedBackupFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await deriveVaultKey(passphrase, salt);
  const payload = await encryptString(key, JSON.stringify(data));
  return {
    app: BACKUP_APP_ID,
    kind: 'encrypted',
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    envelope: `${BACKUP_PREFIX}$${toBase64(salt)}$${toBase64(payload.iv)}$${toBase64(payload.ciphertext)}`,
  };
}

/** `budget-et-compte-sauvegarde[-chiffree]-2026-09-10.json` (brand slug, see the decision log) */
export function backupFilename(file: Pick<BackupFile, 'kind'>, now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `budget-et-compte-sauvegarde${file.kind === 'encrypted' ? '-chiffree' : ''}-${day}.json`;
}

/** Trigger a browser download of a serialized backup. No-op outside a browser. */
export function downloadBackup(json: string, filename: string): void {
  if (typeof document === 'undefined') return;
  const blob = new Blob([`\uFEFF${json}`], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// Parsing + reading (import side)
// ---------------------------------------------------------------------------

export function parseBackup(text: string, t: Translate = frTranslate): BackupParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'invalid', reason: t('backup.invalidJson') };
  }
  const f = parsed as Partial<BackupFile>;
  if (!f || typeof f !== 'object') {
    return { kind: 'invalid', reason: t('backup.unexpectedContent') };
  }
  if (f.app !== BACKUP_APP_ID) {
    return { kind: 'invalid', reason: t('backup.notBackup') };
  }
  if (f.kind !== 'plain' && f.kind !== 'encrypted') {
    return { kind: 'invalid', reason: t('backup.unknownType') };
  }
  if (typeof f.version !== 'number' || f.version > BACKUP_VERSION) {
    return { kind: 'invalid', reason: t('backup.tooRecent') };
  }
  if (!f.exportedAt || typeof f.exportedAt !== 'string') {
    return { kind: 'invalid', reason: t('backup.missingDate') };
  }
  if (f.kind === 'plain' && !f.data) {
    return { kind: 'invalid', reason: t('backup.missingData') };
  }
  if (f.kind === 'encrypted' && (typeof f.envelope !== 'string' || !f.envelope.startsWith(`${BACKUP_PREFIX}$`))) {
    return { kind: 'invalid', reason: t('backup.missingEnvelope') };
  }
  return { kind: 'ok', file: parsed as BackupFile };
}

export function readPlainBackup(file: PlainBackupFile): BackupReadResult {
  // normalizeVaultData coerces shape + heals missing sections.
  return { kind: 'ok', data: normalizeVaultData(file.data) };
}

export async function readEncryptedBackup(
  file: EncryptedBackupFile,
  passphrase: string,
  t: Translate = frTranslate
): Promise<BackupReadResult> {
  const parts = file.envelope.split('$');
  if (parts.length !== 4) {
    return { kind: 'invalid', reason: t('backup.malformedEnvelope') };
  }
  try {
    const salt = fromBase64(parts[1]);
    const key = await deriveVaultKey(passphrase, salt);
    const plaintext = await decryptString(key, {
      iv: fromBase64(parts[2]),
      ciphertext: fromBase64(parts[3]),
    });
    return { kind: 'ok', data: normalizeVaultData(JSON.parse(plaintext)) };
  } catch {
    // GCM auth failure: wrong passphrase or corrupted file — indistinguishable by design.
    return { kind: 'wrong-passphrase' };
  }
}

/** Small human-readable summary shown before an import is confirmed. */
export function backupSummary(data: AppData, t: Translate = frTranslate): string {
  const tx = data.transactions.length;
  const acc = data.accounts.length;
  const groups = data.tontineGroups?.length ?? 0;
  const packs = data.installedPacks?.length ?? 0;
  return t('backup.summary', {
    accounts: acc,
    s: acc > 1 ? 's' : '',
    txs: tx,
    goals: data.goals.length,
    cats: data.budgetCategories.length,
    groups,
    groupsPlural: groups > 1 ? 's' : '',
    packs,
    packsPlural: packs > 1 ? 's' : '',
  });
}
