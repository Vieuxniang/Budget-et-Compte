import React, { useId, useMemo, useRef, useState } from 'react';
import {
  Settings, KeyRound, Wallet, Plus, Pencil, Trash2, X, Loader2,
  ShieldCheck, Timer, AlertTriangle, Eye, EyeOff, Save, FileDown, FileUp, Lock,
  Coins, Globe, Info,
} from 'lucide-react';
import { version as APP_VERSION } from '../../package.json';
import { Account, BudgetCategory, SavingsGoal, SecurityConfig, Transaction } from '../types';
import { AppData } from '../services/storage';
import {
  currencyChoices, currencyDisplayName, detectCurrency, formatMoney, resolveCurrency,
} from '../services/currency';
import { useI18n } from '../i18n/useI18n';
import { LANGUAGE_OPTIONS, Language } from '../i18n/translations';
import { Theme } from '../services/preferences';
import { balancesByAccountId } from '../services/ledger';
import { ACCOUNT_TYPE_META, ACCOUNT_TYPE_ORDER, accountTypeLabelKey } from '../services/accountMeta';
import { hashPassword, verifyPassword, timingSafeEqual } from '../services/crypto';
import {
  AccountDraft, emptyAccountDraft, validateAccountDraft,
  draftToAccount, accountToDraft, transactionsUsingAccount,
} from '../services/accounts';
import { useModalA11y } from '../hooks/useModalA11y';
import { ROVING_ROW_FOCUS, useRovingListNav } from '../hooks/useRovingListNav';
import { OfferView } from './OfferView';
import { SyncView } from './SyncView';
import type { SyncEngine } from '../services/sync/engine';
import {
  buildBackup, buildEncryptedBackup, parseBackup, readPlainBackup,
  readEncryptedBackup, backupFilename, backupSummary, downloadBackup,
  BackupFile,
} from '../services/backup';

// ---------------------------------------------------------------------------
// Public component
// ---------------------------------------------------------------------------

interface SettingsViewProps {
  accounts: Account[];
  transactions: Transaction[];
  budgetCategories: BudgetCategory[];
  goals: SavingsGoal[];
  security: SecurityConfig;
  /** ISO 4217 code from the Réglages preference (detected from region when unset). */
  currency: string;
  language: Language;
  onLanguageChange: (lang: Language) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
  onSecurityChange: (next: SecurityConfig) => void;
  /** Re-encrypts the data vault under a new password (App owns the session). */
  onReencrypt: (newPassword: string) => Promise<void>;
  onUpsertAccount: (acc: Account) => void;
  onDeleteAccount: (id: string) => void;
  /** Backup import: replaces all data at once. */
  onRestore: (data: AppData) => void;
  /** Multi-device sync engine (owned by App, awake only while unlocked). */
  syncEngine: SyncEngine;
  /** Applies data the engine pulled, through the vault. */
  onApplySyncedData: (data: AppData) => void;
}

const AUTO_LOCK_OPTIONS: Array<[number, string]> = [
  [1, 'settings.security.autoLock.1'],
  [5, 'settings.security.autoLock.5'],
  [10, 'settings.security.autoLock.10'],
  [30, 'settings.security.autoLock.30'],
  [0, 'settings.security.autoLock.0'],
];

export const SettingsView: React.FC<SettingsViewProps> = ({
  accounts, transactions, budgetCategories, goals, security, currency,
  language, onLanguageChange, theme, onThemeChange,
  onSecurityChange, onReencrypt, onUpsertAccount, onDeleteAccount, onRestore,
  syncEngine, onApplySyncedData,
}) => {
  const { t } = useI18n();
  const balances = useMemo(() => balancesByAccountId(accounts, transactions), [accounts, transactions]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          <Settings className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          {t('settings.title')}
        </h2>
        <p className="text-xs text-slate-400">{t('settings.subtitle')}</p>
      </div>

      <SecuritySection security={security} onSecurityChange={onSecurityChange} onReencrypt={onReencrypt} />
      <CurrencySection
        security={security}
        defaultCurrency={currency}
        onChange={(code) => onSecurityChange({ ...security, currency: code })}
      />
      <AppearanceSection
        language={language}
        onLanguageChange={onLanguageChange}
        theme={theme}
        onThemeChange={onThemeChange}
      />
      <BackupSection
        data={{ accounts, transactions, budgetCategories, goals }}
        onRestore={onRestore}
      />
      <AccountsSection
        accounts={accounts}
        balances={balances}
        defaultCurrency={currency}
        onUpsert={onUpsertAccount}
        onDelete={onDeleteAccount}
        transactions={transactions}
      />
      <SyncView engine={syncEngine} onApplyData={onApplySyncedData} />

      <OfferView currency={currency} />
      <AboutSection />
    </div>
  );
};

// ---------------------------------------------------------------------------
// About: app name, version and the 100%-local privacy note
// ---------------------------------------------------------------------------

const AboutSection: React.FC = () => {
  const { t } = useI18n();

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <Info className="h-4 w-4" /> {t('settings.about.title')}
      </h3>

      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-bold text-white">{t('app.brand')}</p>
          <p className="text-[11px] text-slate-400">{t('app.tagline')}</p>
        </div>
        <span className="shrink-0 text-[10px] uppercase font-bold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
          {t('app.localData')}
        </span>
      </div>

      <p className="text-[11px] text-slate-400">{t('settings.about.version', { version: APP_VERSION })}</p>

      <div className="space-y-1.5 text-xs text-slate-300">
        <p className="flex items-center gap-1.5">
          <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0" aria-hidden="true" />
          {t('settings.about.privacy')}
        </p>
        <p className="pl-5">{t('settings.about.encryption')}</p>
        <p className="pl-5">{t('settings.about.noAccount')}</p>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Security: password change + auto-lock
// ---------------------------------------------------------------------------

const SecuritySection: React.FC<{
  security: SecurityConfig;
  onSecurityChange: (next: SecurityConfig) => void;
  onReencrypt: (newPassword: string) => Promise<void>;
}> = ({ security, onSecurityChange, onReencrypt }) => {
  const { t } = useI18n();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [busy, setBusy] = useState(false);

  const stored = security.passwordRecord ?? security.passwordHash;

  const changePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(''); setSuccess('');

    if (!stored) { setError(t('settings.security.noPassword')); return; }
    if (next.length < 6) { setError(t('lock.passwordTooShort', { min: 6 })); return; }
    if (next !== confirm) { setError(t('lock.passwordMismatch')); return; }
    if (timingSafeEqual(next, current)) { setError(t('settings.security.sameAsCurrent')); return; }

    setBusy(true);
    try {
      const result = await verifyPassword(current, stored);
      if (result !== 'ok' && result !== 'legacy-hash') {
        setError(t('settings.security.wrongCurrent'));
        return;
      }
      // Re-encrypt the vault FIRST: if this fails, the old verifier stays valid
      // and the user can simply retry — nothing is desynced.
      await onReencrypt(next);
      const record = await hashPassword(next);
      onSecurityChange({ ...security, isPasswordSet: true, passwordRecord: record, passwordHash: undefined });
      setSuccess(t('settings.security.passwordChanged'));
      setCurrent(''); setNext(''); setConfirm('');
    } catch {
      setError(t('settings.security.reencryptFailed'));
    } finally {
      setBusy(false);
    }
  };

  const inputCls = 'w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500';

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <ShieldCheck className="h-4 w-4" /> {t('settings.security.title')}
      </h3>

      <label className="block">
        <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.security.autoLock')}</span>
        <div className="flex items-center gap-2">
          <Timer className="h-4 w-4 text-slate-400" aria-hidden="true" />
          <select
            value={String(security.autoLockMinutes)}
            onChange={(e) => onSecurityChange({ ...security, autoLockMinutes: Number(e.target.value) })}
            className="rounded-xl bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
          >
            {AUTO_LOCK_OPTIONS.map(([mins, labelKey]) => (
              <option key={mins} value={String(mins)}>{t(labelKey)}</option>
            ))}
          </select>
          <span className="text-[11px] text-slate-400">{t('settings.security.autoLockHint')}</span>
        </div>
      </label>

      <form onSubmit={changePassword} className="space-y-3 border-t border-slate-800 pt-4">
        <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
          <KeyRound className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.security.changePassword')}
        </span>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={current}
              onChange={(e) => { setCurrent(e.target.value); setError(''); setSuccess(''); }}
              placeholder={t('settings.security.currentPassword')}
              className={inputCls}
              autoComplete="current-password"
              aria-label={t('settings.security.currentPassword')}
            />
            <ToggleShow show={show} onToggle={() => setShow(!show)} />
          </div>
          <input
            type="password"
            value={next}
            onChange={(e) => { setNext(e.target.value); setError(''); setSuccess(''); }}
            placeholder={t('settings.security.newPasswordMin')}
            className={inputCls}
            autoComplete="new-password"
            aria-label={t('lock.newPassword')}
          />
          <input
            type="password"
            value={confirm}
            onChange={(e) => { setConfirm(e.target.value); setError(''); setSuccess(''); }}
            placeholder={t('settings.security.confirmNew')}
            className={inputCls}
            autoComplete="new-password"
            aria-label={t('lock.confirmPassword')}
          />
        </div>

        {error && (
          <p role="alert" className="text-xs text-red-400 p-2.5 bg-red-500/10 border border-red-500/30 rounded-lg">{error}</p>
        )}
        {success && (
          <p role="status" className="text-xs text-emerald-300 p-2.5 bg-emerald-500/10 border border-emerald-500/30 rounded-lg">{success}</p>
        )}

        <button
          type="submit"
          disabled={busy || !current || !next || !confirm}
          className="px-4 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 text-xs font-bold flex items-center gap-2 transition"
        >
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {t('settings.security.modify')}
        </button>
      </form>
    </section>
  );
};

const ToggleShow: React.FC<{ show: boolean; onToggle: () => void }> = ({ show, onToggle }) => {
  const { t } = useI18n();
  return (
  <button
    type="button"
    onClick={onToggle}
    className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
    tabIndex={-1}
    title={show ? t('lock.hidePassword') : t('lock.showPassword')}
    aria-label={show ? t('lock.hidePassword') : t('lock.showPassword')}
  >
    {show ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
  </button>
  );
};// ---------------------------------------------------------------------------
// Backup: export (plain / encrypted) + import with confirm step
// ---------------------------------------------------------------------------



const BackupSection: React.FC<{
  data: AppData;
  onRestore: (data: AppData) => void;
}> = ({ data, onRestore }) => {
  const { t } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [passphrase, setPassphrase] = useState('');
  const [exportPass, setExportPass] = useState('');
  const [showExportPass, setShowExportPass] = useState(false);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [pending, setPending] = useState<{
    file: BackupFile;
    summary: string;
    needsPass: boolean;
  } | null>(null);

  const exportPlain = () => {
    const file = buildBackup(data);
    downloadBackup(JSON.stringify(file, null, 2), backupFilename(file));
    setMessage({ tone: 'ok', text: t('settings.backup.exportedPlain') });
  };

  const exportEncrypted = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (exportPass.length < 8) {
      setMessage({ tone: 'err', text: t('settings.backup.passphraseShort') });
      return;
    }
    setBusy('export');
    setMessage(null);
    try {
      const file = await buildEncryptedBackup(data, exportPass);
      downloadBackup(JSON.stringify(file, null, 2), backupFilename(file));
      setMessage({ tone: 'ok', text: t('settings.backup.exportedEncrypted') });
      setExportPass('');
    } finally {
      setBusy('');
    }
  };

  const onFilePicked = async (f: File | null) => {
    if (!f) return;
    setMessage(null);
    setPassphrase('');
    try {
      const text = await f.text();
      const parsed = parseBackup(text, t);
      if (parsed.kind !== 'ok') {
        setPending(null);
        setMessage({ tone: 'err', text: parsed.reason });
        return;
      }
      if (parsed.file.kind === 'encrypted') {
        setPending({ file: parsed.file, summary: '', needsPass: true });
      } else {
        const read = readPlainBackup(parsed.file);
        if (read.kind !== 'ok') {
          setMessage({ tone: 'err', text: t('settings.backup.unreadable') });
          return;
        }
        setPending({ file: parsed.file, summary: backupSummary(read.data, t), needsPass: false });
      }
    } catch {
      setMessage({ tone: 'err', text: t('settings.backup.cannotRead') });
    }
  };

  const confirmImport = async () => {
    if (!pending) return;
    setBusy('import');
    setMessage(null);
    try {
      let result;      if (pending.file.kind === 'encrypted') {
        result = await readEncryptedBackup(pending.file, passphrase, t);
        if (result.kind === 'wrong-passphrase') {
          setMessage({ tone: 'err', text: t('settings.backup.wrongPassphrase') });
          return;
        }

      } else {
        result = readPlainBackup(pending.file);
      }
      if (result.kind !== 'ok') {
        setMessage({ tone: 'err', text: t('settings.backup.unreadable') });
        return;
      }
      // Read summary AFTER decryption for the confirmation card.
      if (!pending.summary) {
        setPending({ ...pending, summary: backupSummary(result.data, t) });
      }
      onRestore(result.data);
      setPending(null);
      setPassphrase('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      setMessage({ tone: 'ok', text: t('settings.backup.restored') });
    } finally {
      setBusy('');
    }
  };

  const inputCls = 'w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500';

  // One polite live region narrating async/import state for screen readers
  // (the confirm card itself appears far from the user's focus point).
  const liveAnnouncement = busy === 'export'
    ? t('settings.backup.encrypting')
    : busy === 'import'
      ? t('settings.backup.importing')
      : pending
        ? pending.needsPass
          ? t('settings.backup.encryptedNeedsPassphrase')
          : t('settings.backup.readyToImport', { summary: pending.summary })
        : '';

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <p className="sr-only" role="status" aria-live="polite">{liveAnnouncement}</p>
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <Save className="h-4 w-4" aria-hidden="true" /> {t('settings.backup.title')}
      </h3>
      <p className="text-xs text-slate-400">
        {t('settings.backup.hint')}
      </p>

      {message && (
        <p role={message.tone === 'ok' ? 'status' : 'alert'} className={`text-xs p-2.5 rounded-lg border ${message.tone === 'ok' ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-red-400 bg-red-500/10 border-red-500/30'}`}>
          {message.text}
        </p>
      )}

      {/* Export */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={exportPlain}
          className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold flex items-center gap-1.5 transition"
        >
          <FileDown className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.backup.exportJson')}
        </button>
        <span className="text-[11px] text-slate-400">{t('settings.backup.or')}</span>
      </div>
      <form onSubmit={exportEncrypted} className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1 max-w-xs">
          <input
            type={showExportPass ? 'text' : 'password'}
            value={exportPass}
            onChange={(e) => { setExportPass(e.target.value); setMessage(null); }}
            placeholder={t('settings.backup.passphraseMin')}
            className={inputCls}
            autoComplete="new-password"
            aria-label={t('settings.backup.passphraseMin')}
          />
          <button
            type="button"
            tabIndex={-1}
            onClick={() => setShowExportPass(!showExportPass)}
            aria-label={showExportPass ? t('lock.hidePassword') : t('lock.showPassword')}
            className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
          >
            {showExportPass ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
        <button
          type="submit"
          disabled={busy !== ''}
          className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
        >
          {busy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Lock className="h-3.5 w-3.5" aria-hidden="true" />}
          {t('settings.backup.exportEncrypted')}
        </button>
      </form>

      {/* Import */}
      <div className="border-t border-slate-800 pt-4 space-y-3">
        <span className="text-xs font-medium text-slate-300 flex items-center gap-2">
          <FileUp className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.backup.restore')}
        </span>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={(e) => onFilePicked(e.target.files?.[0] ?? null)}
          aria-label={t('settings.backup.fileAria')}
          className="block w-full text-xs text-slate-400 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-slate-800 file:text-slate-200 file:cursor-pointer hover:file:bg-slate-700"
        />

        {pending && (
          <div className="p-3 bg-slate-800/60 border border-slate-700 rounded-xl space-y-2">
            <p className="text-xs text-slate-300">
              {pending.needsPass
                ? t('settings.backup.encryptedDetected')
                : t('settings.backup.readOk')}
            </p>
            {pending.summary && (
              <p className="text-xs text-emerald-300 font-semibold">{pending.summary}</p>
            )}
            <p className="text-[11px] text-amber-300 flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
              {t('settings.backup.importWarning')}
            </p>
            {pending.needsPass && (
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                placeholder={t('settings.backup.passphrasePlaceholder')}
                className={inputCls}
                autoComplete="off"
                aria-label={t('settings.backup.passphrasePlaceholder')}
              />
            )}
            <div className="flex gap-2">
              <button
                onClick={() => { setPending(null); setPassphrase(''); }}
                className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmImport}
                disabled={busy !== '' || (pending.needsPass && passphrase.length === 0)}
                className="flex-1 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 text-xs font-bold transition flex items-center justify-center gap-1.5"
              >
                {busy === 'import' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                {t('settings.backup.replace')}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Currency: display currency, detected from the browser region
// ---------------------------------------------------------------------------

/** Exported so the picker's contract (every detectable code must be offered and
 * named) can be tested against the real component — there is no jsdom in the
 * project, so the test renders it server-side and reads the markup. */
export const CurrencySection: React.FC<{
  security: SecurityConfig;
  defaultCurrency: string;
  onChange: (code: string) => void;
}> = ({ security, defaultCurrency, onChange }) => {
  const { t, locale } = useI18n();
  const detected = detectCurrency();
  // Normalized so the <select>'s value is always one of the options it renders.
  const current = resolveCurrency(security.currency, defaultCurrency);

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <Coins className="h-4 w-4" /> {t('settings.currency.title')}
      </h3>

      <label className="block">
        <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.currency.display')}</span>
        <select
          value={current}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
        >
          {/* The current code is always offered, so a detected currency outside
              the curated list still shows itself instead of the first option. */}
          {currencyChoices(current, locale).map((o) => (
            <option key={o.code} value={o.code}>
              {o.code} — {o.curated ? t(`currencies.${o.code}`) : o.label}
            </option>
          ))}
        </select>
      </label>

      <p className="text-[11px] text-slate-400">
        {t('settings.currency.detected', { code: detected, label: currencyDisplayName(detected, locale) })}
      </p>
      <p className="text-[11px] text-slate-400">{t('settings.currency.allAmounts')}</p>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Language & appearance: language picker + dark/light theme
// ---------------------------------------------------------------------------

const AppearanceSection: React.FC<{
  language: Language;
  onLanguageChange: (lang: Language) => void;
  theme: Theme;
  onThemeChange: (theme: Theme) => void;
}> = ({ language, onLanguageChange, theme, onThemeChange }) => {
  const { t } = useI18n();

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <Globe className="h-4 w-4" /> {t('settings.appearance.title')}
      </h3>

      <label className="block">
        <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.appearance.language')}</span>
        <select
          value={language}
          onChange={(e) => onLanguageChange(e.target.value as Language)}
          className="w-full rounded-xl bg-slate-800 border border-slate-700 px-3 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
        >
          {LANGUAGE_OPTIONS.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
        <span className="block text-[11px] text-slate-400 mt-1">{t('settings.appearance.languageHint')}</span>
      </label>

      <div>
        <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.appearance.theme')}</span>
        <div role="radiogroup" aria-label={t('settings.appearance.theme')} className="grid grid-cols-2 gap-1 p-1 bg-slate-800 rounded-xl">
          {(['dark', 'light'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              role="radio"
              aria-checked={theme === mode}
              onClick={() => onThemeChange(mode)}
              className={`py-1.5 rounded-lg text-xs font-bold transition ${
                theme === mode ? 'bg-emerald-500 text-slate-950' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {mode === 'dark' ? t('settings.appearance.dark') : t('settings.appearance.light')}
            </button>
          ))}
        </div>
        <span className="block text-[11px] text-slate-400 mt-1">{t('settings.appearance.themeHint')}</span>
      </div>
    </section>
  );
};

// ---------------------------------------------------------------------------
// Accounts: list + add/edit modal + guarded delete
// ---------------------------------------------------------------------------

const AccountsSection: React.FC<{
  accounts: Account[];
  balances: Record<string, number>;
  transactions: Transaction[];
  /** Currency prefilled for new accounts (from the Réglages preference). */
  defaultCurrency: string;
  onUpsert: (acc: Account) => void;
  onDelete: (id: string) => void;
}> = ({ accounts, balances, transactions, defaultCurrency, onUpsert, onDelete }) => {
  const { t, locale } = useI18n();
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Account | null>(null);
  const [blockedId, setBlockedId] = useState<string | null>(null);
  const [armedId, setArmedId] = useState<string | null>(null);
  const modalRef = useRef<HTMLFormElement>(null);

  const openCreate = () => { setEditing(null); setModalOpen(true); };
  const openEdit = (acc: Account) => { setEditing(acc); setModalOpen(true); };

  const requestDelete = (acc: Account) => {
    const linked = transactionsUsingAccount(transactions, acc.id);
    if (linked.length > 0) {
      setBlockedId(acc.id);
      setArmedId(null);
      return;
    }
    setBlockedId(null);
    setArmedId(armedId === acc.id ? null : acc.id);
  };

  // Arrow keys walk the accounts (one tab stop): Enter opens a row for editing,
  // Suppr arms its deletion — or reports the ledger guard that blocks it — and
  // Escape clears whichever notice is showing.
  const hintId = useId();
  const nav = useRovingListNav({
    count: accounts.length,
    label: t('settings.accounts.listAria'),
    // Only wired up when the hint paragraph is actually rendered.
    hintId: accounts.length > 1 ? hintId : undefined,
    onActivate: (i) => {
      const acc = accounts[i];
      if (acc) openEdit(acc);
    },
    onRemove: (i) => {
      const acc = accounts[i];
      if (acc) requestDelete(acc);
    },
    onEscape: () => {
      setArmedId(null);
      setBlockedId(null);
    },
  });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
          <Wallet className="h-4 w-4" /> {t('settings.accounts.title')}
        </h3>
        <button
          onClick={openCreate}
          className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
        >
          <Plus className="h-3.5 w-3.5" /> {t('settings.accounts.new')}
        </button>
      </div>

      <div {...nav.listProps} className="divide-y divide-slate-800 border border-slate-800 rounded-xl overflow-hidden">
        {accounts.map((acc, index) => {
          const meta = ACCOUNT_TYPE_META[acc.type];
          const linkedCount = transactionsUsingAccount(transactions, acc.id).length;
          const balanceLabel = `${meta.isLiability ? '−' : ''}${formatMoney(Math.abs(balances[acc.id] ?? 0), defaultCurrency, locale)}`;
          // The focused row announces its own data plus whatever state it is in.
          const rowLabel = t('settings.accounts.rowAria', {
            name: acc.name, balance: balanceLabel, institution: acc.institution,
          })
            + (armedId === acc.id ? ` — ${t('common.confirm')}` : '')
            + (blockedId === acc.id ? ` — ${t('settings.accounts.blocked')}` : '');
          return (
            <div
              key={acc.id}
              {...nav.itemProps(index, { label: rowLabel })}
              className={`px-4 py-3 flex items-center gap-3 bg-slate-900 ${ROVING_ROW_FOCUS}`}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="text-sm font-semibold text-white truncate">{acc.name}</h4>
                  <span className={`text-[10px] uppercase font-bold px-1.5 py-0.5 rounded ${meta.badgeClass}`}>
                    {t(accountTypeLabelKey(acc.type))}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 truncate">
                  {acc.institution} · {acc.holder}
                  {linkedCount > 0 && t('settings.accounts.linked', { n: linkedCount, s: linkedCount > 1 ? 's' : '' })}
                </p>
              </div>
              <span className={`text-sm font-bold shrink-0 ${meta.balanceClass}`}>
                {balanceLabel}
              </span>
              {blockedId === acc.id ? (
                <span className="text-[10px] text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg px-2 py-1 flex items-center gap-1 max-w-[180px]">
                  <AlertTriangle className="h-3 w-3 shrink-0" /> {t('settings.accounts.blocked')}
                </span>
              ) : armedId === acc.id ? (
                <span className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => { onDelete(acc.id); setArmedId(null); }}
                    className="px-2 py-1 rounded-lg bg-red-500/20 border border-red-500/30 text-red-300 text-[10px] font-bold"
                  >
                    {t('common.confirm')}
                  </button>
                  <button onClick={() => setArmedId(null)} className="p-1 text-slate-400 hover:text-white" title={t('common.cancel')} aria-label={t('common.cancel')}>
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              ) : (
                <span className="flex items-center gap-1 shrink-0">
                  <button onClick={() => openEdit(acc)} className="p-1.5 text-slate-400 hover:text-white" title={t('common.edit')} aria-label={`${t('common.edit')} ${acc.name}`}>
                    <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                  <button onClick={() => requestDelete(acc)} className="p-1.5 text-slate-400 hover:text-red-400" title={t('common.delete')} aria-label={`${t('common.delete')} ${acc.name}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                </span>
              )}
            </div>
          );
        })}
      </div>

      {accounts.length > 1 && (
        <p id={hintId} className="text-[11px] text-slate-400">
          {t('a11y.listActionsHint')}
        </p>
      )}

      <p className="text-[11px] text-slate-400">
        {t('settings.accounts.hint')}
      </p>

      {modalOpen && (
        <AccountModal
          modalRef={modalRef}
          editing={editing}
          defaultCurrency={defaultCurrency}
          onCancel={() => setModalOpen(false)}
          onSubmit={(draft) => {
            onUpsert(draftToAccount(draft, editing?.id));
            setModalOpen(false);
          }}
        />
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Account modal
// ---------------------------------------------------------------------------

const AccountModal: React.FC<{
  modalRef: React.RefObject<HTMLFormElement>;
  editing: Account | null;
  /** Currency prefilled for new accounts (from the Réglages preference). */
  defaultCurrency: string;
  onCancel: () => void;
  onSubmit: (draft: AccountDraft) => void;
}> = ({ modalRef, editing, defaultCurrency, onCancel, onSubmit }) => {
  const { t, locale } = useI18n();
  const [draft, setDraft] = useState<AccountDraft>(() =>
    editing ? accountToDraft(editing) : emptyAccountDraft(defaultCurrency)
  );
  const [submitted, setSubmitted] = useState(false);
  useModalA11y(modalRef, onCancel);

  const errors = validateAccountDraft(draft, t);
  const errorFor = (field: string) => errors.find((e) => e.field === field)?.message;
  const show = (field: string) => (submitted ? errorFor(field) : undefined);

  const set = <K extends keyof AccountDraft>(key: K, value: AccountDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (errors.length === 0) onSubmit(draft);
  };

  const inputCls = (field: string) =>
    `w-full rounded-xl bg-slate-800 border px-3 py-2.5 text-sm text-white focus:outline-none transition ${
      submitted && errorFor(field) ? 'border-red-500/60' : 'border-slate-700 focus:border-emerald-500'
    }`;

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 p-0 sm:p-4" onClick={onCancel}>
      <form
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-modal-title"
        onSubmit={handleSubmit}
        onClick={(e) => e.stopPropagation()}
        className="w-full sm:max-w-md bg-slate-900 border border-slate-700 rounded-t-2xl sm:rounded-2xl p-5 space-y-4 max-h-[92vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h3 id="account-modal-title" className="text-base font-bold text-white">
            {editing ? t('settings.accounts.modalEdit') : t('settings.accounts.modalNew')}
          </h3>
          <button type="button" onClick={onCancel} aria-label={t('common.close')} className="p-1.5 text-slate-400 hover:text-white rounded-lg hover:bg-slate-800">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <label className="block">
          <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.accounts.type')}</span>
          <select
            value={draft.type}
            onChange={(e) => set('type', e.target.value as AccountDraft['type'])}
            className={inputCls('type')}
          >
            {ACCOUNT_TYPE_ORDER.map((type) => (
              <option key={type} value={type}>{t(accountTypeLabelKey(type))}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.accounts.name')}</span>
          <input
            value={draft.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('settings.accounts.namePlaceholder')}
            className={inputCls('name')}
            autoFocus
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">
              {draft.type === 'loan' ? t('settings.accounts.loanRemaining') : t('settings.accounts.balance')}
            </span>
            <input
              type="number"
              value={draft.initialBalance || ''}
              onChange={(e) => set('initialBalance', Number(e.target.value))}
              placeholder="0"
              className={inputCls('initialBalance')}
            />
            {show('initialBalance') && <p role="alert" className="mt-1 text-[11px] text-red-400">{show('initialBalance')}</p>}
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.accounts.currency')}</span>
            <select
              value={draft.currency}
              onChange={(e) => set('currency', e.target.value)}
              className={inputCls('currency')}
            >
              {currencyChoices(draft.currency, locale).map((o) => (
                <option key={o.code} value={o.code}>
                  {o.code} — {o.curated ? t(`currencies.${o.code}`) : o.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.accounts.institution')}</span>
            <input
              value={draft.institution}
              onChange={(e) => set('institution', e.target.value)}
              placeholder={t('settings.accounts.institutionPlaceholder')}
              className={inputCls('institution')}
            />
          </label>
          <label className="block">
            <span className="block text-xs font-medium text-slate-300 mb-1">{t('settings.accounts.holder')}</span>
            <input
              value={draft.holder}
              onChange={(e) => set('holder', e.target.value)}
              placeholder={t('settings.accounts.holderPlaceholder')}
              className={inputCls('holder')}
            />
          </label>
        </div>

        {submitted && errors.length > 0 && (
          <div role="alert" className="p-3 bg-red-500/10 border border-red-500/30 rounded-xl text-xs text-red-300">
            {errors.map((e, i) => <p key={i}>{e.message}</p>)}
          </div>
        )}

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-semibold transition"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-sm font-bold transition"
          >
            {editing ? t('common.save') : t('common.add')}
          </button>
        </div>
      </form>
    </div>
  );
};
