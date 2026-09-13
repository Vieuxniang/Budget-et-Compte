import React, { useState } from 'react';
import { Lock, KeyRound, ShieldCheck, Eye, EyeOff, Loader2 } from 'lucide-react';
import { getSecurityConfig, saveSecurityConfig, initialData } from '../services/storage';
import { hashPassword, verifyPassword, VerifyResult } from '../services/crypto';
import {
  unlockVault,
  setupVault,
  migratePlainToVault,
  readEnvelope,
  VaultSession,
} from '../services/vault';
import { AppData } from '../services/storage';
import { useI18n } from '../i18n/useI18n';

interface AuthLockProps {
  /**
   * Called once the vault is readable. Hands over the decrypted data plus the
   * session material (key + salt) App needs to persist future changes.
   */
  onUnlocked: (session: UnlockedPayload) => void;
}

export interface UnlockedPayload {
  data: AppData;
  session: VaultSession;
}

const MIN_PASSWORD_LENGTH = 6;
const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_MS = 30_000;

export const AuthLock: React.FC<AuthLockProps> = ({ onUnlocked }) => {
  const { t } = useI18n();
  const [config, setConfig] = useState(getSecurityConfig());
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPass, setShowPass] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);

  const throttled = lockedUntil > Date.now();

  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy !== '' || throttled) return;

    const stored = config.passwordRecord ?? config.passwordHash;
    if (!stored) {
      setError(t('lock.noPassword'));
      return;
    }

    const envelope = readEnvelope();
    const migrating = envelope === null;

    setBusy('unlock');
    setError('');
    try {
      const result: VerifyResult = await verifyPassword(password, stored);

      if (result === 'wrong-password' || result === 'invalid-record') {
        const attempts = failedAttempts + 1;
        setFailedAttempts(attempts);
        if (attempts >= LOCKOUT_THRESHOLD) {
          setLockedUntil(Date.now() + LOCKOUT_MS);
          setFailedAttempts(0);
          setError(t('lock.tooManyAttempts'));
        } else {
          setError(t('lock.wrongPassword', { n: attempts, max: LOCKOUT_THRESHOLD }));
        }
        return;
      }

      // 'ok' (PBKDF2) or 'legacy-hash' (old install: record upgraded below).
      let upgraded = config;
      if (result === 'legacy-hash') {
        const record = await hashPassword(password);
        upgraded = { ...config, passwordRecord: record, passwordHash: undefined };
        saveSecurityConfig(upgraded);
        setConfig(upgraded);
      }

      if (envelope) {
        const vault = await unlockVault(password, envelope);
        if (vault.kind === 'decrypt-error') {
          setError(t('lock.decryptError'));
          return;
        }
        onUnlocked({ data: vault.data, session: { key: vault.key, saltB64: envelope.saltB64 } });
        return;
      }

      // No vault yet. Prefer migrating the pre-encryption plaintext data;
      // otherwise encrypt the initial dataset (fresh install).
      if (migrating) {
        const migrated = await migratePlainToVault(password);
        if (migrated) {
          onUnlocked({ data: migrated.data, session: { key: migrated.key, saltB64: migrated.saltB64 } });
          return;
        }
      }

      const fresh = initialData();
      const session = await setupVault(password, fresh);
      onUnlocked({ data: fresh, session });
    } finally {
      setBusy('');
      setPassword('');
    }
  };

  const handleSetupPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(t('lock.passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    if (newPassword !== confirmPassword) {
      setError(t('lock.passwordMismatch'));
      return;
    }

    setBusy('setup');
    setError('');
    try {
      // Fresh install: seed data goes straight into the encrypted vault.
      const fresh = initialData();
      const session = await setupVault(newPassword, fresh);

      const record = await hashPassword(newPassword);
      const next = {
        ...config,
        isPasswordSet: true,
        passwordRecord: record,
        passwordHash: undefined, // drop any legacy hash
      };
      saveSecurityConfig(next);
      setConfig(next);

      onUnlocked({ data: fresh, session });
    } finally {
      setBusy('');
    }
  };

  const submitDisabled = busy !== '' || throttled;

  return (
    <div className="fixed inset-0 bg-slate-950 flex items-center justify-center p-4 z-50">
      <div className="w-full max-w-md bg-slate-900 border border-slate-800 rounded-2xl p-6 shadow-2xl">
        <div className="flex flex-col items-center mb-6 text-center">
          <div className="p-3 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-2xl mb-3" aria-hidden="true">
            <Lock className="h-8 w-8" />
          </div>
          <h1 className="text-xl font-bold text-white">{t('app.brand')}</h1>
          <p className="text-xs text-slate-400 mt-1">{t('lock.encryptedNote')}</p>
        </div>

        {error && (
          <div role="alert" className="mb-4 p-3 bg-red-500/10 border border-red-500/30 text-red-400 text-xs rounded-lg text-center">
            {error}
          </div>
        )}

        {throttled && (
          <div role="alert" className="mb-4 p-3 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs rounded-lg text-center">
            {t('lock.locked30s')}
          </div>
        )}

        {config.isPasswordSet ? (
          <form onSubmit={handleUnlock} className="space-y-4">
            {/* PBKDF2 derivation takes ~1s; announce it instead of a silent spinner. */}
            <p className="sr-only" role="status" aria-live="polite">
              {busy === 'unlock' ? t('lock.verifying') : busy === 'setup' ? t('lock.creatingVault') : ''}
            </p>
            <div>
              <label htmlFor="unlock-password" className="block text-xs font-medium text-slate-300 mb-1">{t('lock.unlockPassword')}</label>
              <div className="relative">
                <input
                  id="unlock-password"
                  type={showPass ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="••••••••"
                  className="w-full rounded-xl bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500 disabled:opacity-50"
                  autoFocus
                  disabled={submitDisabled}
                />
                <button
                  type="button"
                  onClick={() => setShowPass(!showPass)}
                  className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
                  tabIndex={-1}
                  aria-label={showPass ? t('lock.hidePassword') : t('lock.showPassword')}
                >
                  {showPass ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={submitDisabled}
              className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 font-semibold text-slate-950 text-sm transition flex items-center justify-center gap-2"
            >
              {busy !== '' && <Loader2 className="h-4 w-4 animate-spin" />}
              {throttled ? t('lock.wait') : t('lock.unlock')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleSetupPassword} className="space-y-4">
            <div className="p-3 bg-slate-800/60 rounded-xl border border-slate-700/50 text-xs text-slate-300 flex items-center gap-2">
              <ShieldCheck className="h-5 w-5 text-emerald-400 shrink-0" />
              <span>
                {t('lock.encryptExplain')}
                <strong className="text-amber-300">{t('lock.irrecoverable')}</strong>
              </span>
            </div>

            <div>
              <label htmlFor="setup-password" className="block text-xs font-medium text-slate-300 mb-1">{t('lock.newPassword')}</label>
              <input
                id="setup-password"
                type="password"
                value={newPassword}
                onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                placeholder={t('lock.minChars', { min: MIN_PASSWORD_LENGTH })}
                className="w-full rounded-xl bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
                autoFocus
              />
            </div>

            <div>
              <label htmlFor="setup-password-confirm" className="block text-xs font-medium text-slate-300 mb-1">{t('lock.confirmPassword')}</label>
              <input
                id="setup-password-confirm"
                type="password"
                value={confirmPassword}
                onChange={(e) => { setConfirmPassword(e.target.value); setError(''); }}
                placeholder={t('lock.repeatPassword')}
                className="w-full rounded-xl bg-slate-800 border border-slate-700 px-4 py-2.5 text-sm text-white focus:outline-none focus:border-emerald-500"
              />
            </div>

            <button
              type="submit"
              disabled={busy !== ''}
              className="w-full py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-50 font-semibold text-slate-950 text-sm transition flex items-center justify-center gap-2"
            >
              {busy !== '' ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              {t('lock.activateProtection')}
            </button>
          </form>
        )}
      </div>
    </div>
  );
};