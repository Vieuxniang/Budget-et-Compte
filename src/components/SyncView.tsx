import React, { useEffect, useState } from 'react';
import {
  RefreshCw, KeyRound, CloudOff, Cloud, AlertTriangle, ShieldCheck, Copy, Check,
  Power, Unplug, RotateCcw, History, Loader2,
} from 'lucide-react';
import { useI18n } from '../i18n/useI18n';
import type { AppData } from '../services/storage';
import type { SyncEngine } from '../services/sync/engine';
import type { ConflictRecord } from '../services/sync/types';
import { backupSummary } from '../services/backup';

/**
 * Réglages → Synchronisation.
 *
 * Everything here is deliberately explicit about the trust model: the relay
 * stores ciphertext, the code is the only secret, and a conflict is shown with
 * both versions rather than being swallowed. Sync is off until the user asks for
 * it — the app's promise is "100 % local", and sync is an opt-in exception.
 */
interface SyncViewProps {
  engine: SyncEngine;
  /** Applies data the engine pulled (the app owns the vault write). */
  onApplyData: (data: AppData) => void;
}

/** An overwrite waiting for the user's informed yes. */
interface StagedOverwrite {
  /** A pull replaces the device's data; a restore also syncs to every device. */
  kind: 'pull' | 'restore';
  /** The complete data the action would produce — the card shows its counts. */
  data: AppData;
  /** Archive entry id, for a restore. */
  restoreId?: string;
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** Human label of a contested record: its entity name when there is one. */
function recordLabel(conflict: ConflictRecord): string {
  const value = (conflict.discarded.value ?? conflict.kept.value) as { name?: unknown; title?: unknown } | undefined;
  const name = value?.name ?? value?.title;
  if (typeof name === 'string' && name.trim()) return name;
  return conflict.target.replace(':', ' · ');
}

export const SyncView: React.FC<SyncViewProps> = ({ engine, onApplyData }) => {
  const { t, lang } = useI18n();
  const [state, setState] = useState(() => engine.state());
  const [relayUrl, setRelayUrl] = useState(() => engine.state().relayUrl || 'http://127.0.0.1:8787');
  const [code, setCode] = useState('');
  const [createdCode, setCreatedCode] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  // A pull or a restore replaces data, so neither applies itself: the result is
  // staged here and the card below shows what it contains before the user
  // confirms. Leaving this screen drops the offer and changes nothing.
  const [staged, setStaged] = useState<StagedOverwrite | null>(null);

  useEffect(() => {
    setState(engine.state());
    return engine.subscribe(() => setState(engine.state()));
  }, [engine]);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
      setState(engine.state());
    }
  };

  const enable = (withCode: boolean) =>
    run(async () => {
      const result = await engine.enable({ relayUrl, ...(withCode && code.trim() ? { code: code.trim() } : {}) });
      if (!result.ok) return;
      setCreatedCode(result.code);
      setCode('');
      if (result.data) onApplyData(result.data);
    });

  const syncNow = () => run(async () => {
    const report = await engine.sync();
    // The engine has already committed its merge (declining is safe: the next
    // edit re-enters the exchange as a normal local change), so staging is only
    // about what lands in *this* device's vault.
    if (report.data) setStaged({ kind: 'pull', data: report.data });
  });

  const restore = (id: string) => {
    // Unlike a pull, a restore syncs to every device the moment it runs — so it
    // is previewed before the engine is touched at all.
    const preview = engine.previewRestore(id);
    if (preview) setStaged({ kind: 'restore', data: preview, restoreId: id });
  };

  const confirmStaged = () => run(async () => {
    if (!staged) return;
    if (staged.kind === 'restore' && staged.restoreId) {
      const data = await engine.restore(staged.restoreId);
      if (data) onApplyData(data);
    } else {
      onApplyData(staged.data);
    }
    setStaged(null);
  });

  const status = state.status;
  // Dynamic keys keep the six statuses (and the four problems) in one call each;
  // scripts/check-i18n.mjs understands this `t(`prefix.${…}`)` form.
  const statusLine =
    status.kind === 'problem'
      ? t(`settings.sync.problem.${status.problem}`)
      : t(`settings.sync.status.${status.kind}`, {
          n: 'pending' in status ? status.pending : 0,
          version: status.kind === 'synced' ? status.version : 0,
        });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      {/* The overwrite card comes first: nothing else on this screen matters
          while a replace-everything decision is pending. */}
      {staged && (
        <div role="alert" className="p-3 bg-slate-800/60 border border-amber-500/40 rounded-xl space-y-2">
          <p className="text-xs font-bold text-amber-300 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {staged.kind === 'pull' ? t('settings.sync.pullTitle') : t('settings.sync.restoreTitle')}
          </p>
          <p className="text-xs text-slate-300">
            {staged.kind === 'pull' ? t('settings.sync.pullBody') : t('settings.sync.restoreBody')}
          </p>
          <p className="text-xs text-emerald-300 font-semibold">{backupSummary(staged.data, t)}</p>
          <p className="text-[11px] text-slate-400">{t('settings.sync.confirmWarning')}</p>
          <div className="flex gap-2">
            <button
              onClick={() => setStaged(null)}
              className="flex-1 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold transition"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={confirmStaged}
              disabled={busy}
              className="flex-1 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 text-xs font-bold transition flex items-center justify-center gap-1.5"
            >
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
              {t('settings.sync.apply')}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
            <Cloud className="h-4 w-4" aria-hidden="true" /> {t('settings.sync.title')}
          </h3>
          <p className="text-[11px] text-slate-400 mt-1">{t('settings.sync.subtitle')}</p>
        </div>
        <span
          className={`shrink-0 whitespace-nowrap text-[10px] uppercase font-bold px-2 py-1 rounded flex items-center gap-1 border ${
            status.kind === 'synced'
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : status.kind === 'problem' || status.kind === 'offline'
                ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                : 'bg-slate-800 text-slate-300 border-slate-700'
          }`}
        >
          {status.kind === 'offline' ? <CloudOff className="h-3 w-3" aria-hidden="true" /> : <Cloud className="h-3 w-3" aria-hidden="true" />}
          {t('settings.sync.statusLabel')}
        </span>
      </div>

      <p role="status" className="text-xs text-slate-300">
        {statusLine}
      </p>
      {status.kind === 'problem' && (
        <p className="text-[11px] text-amber-400 flex items-start gap-1.5">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden="true" />
          {t('settings.sync.problem.hint')}
        </p>
      )}

      {/* Setup — hidden once the channel is live, unless the code must be re-entered */}
      {(!state.enabled || state.needsCode) && (
        <div className="space-y-3 border-t border-slate-800 pt-4">
          {state.needsCode && (
            <p className="text-[11px] text-amber-400">{t('settings.sync.needsCode')}</p>
          )}
          <label className="block">
            <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">
              {t('settings.sync.relayLabel')}
            </span>
            <input
              value={relayUrl}
              onChange={(event) => setRelayUrl(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('settings.sync.relayPlaceholder')}
              className="w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
          </label>
          <p className="text-[11px] text-slate-400">{t('settings.sync.relayHint')}</p>
          {state.hasSetup && (
            <p className="text-[11px] text-slate-400">{t('settings.sync.resumeHint')}</p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void enable(false)}
              disabled={busy || !relayUrl.trim()}
              className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold transition flex items-center gap-1.5"
            >
              <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
              {state.hasSetup ? t('settings.sync.resume') : t('settings.sync.create')}
            </button>
            <span className="text-[11px] text-slate-500">{t('settings.sync.or')}</span>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value)}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('settings.sync.joinPlaceholder')}
              aria-label={t('settings.sync.joinLabel')}
              className="flex-1 min-w-[12rem] rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={() => void enable(true)}
              disabled={busy || !code.trim() || !relayUrl.trim()}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed text-slate-100 text-xs font-bold transition border border-slate-700"
            >
              {t('settings.sync.join')}
            </button>
          </div>
        </div>
      )}

      {/* Live channel */}
      {state.enabled && !state.needsCode && (
        <div className="space-y-3 border-t border-slate-800 pt-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px] text-slate-400">
            <dt>{t('settings.sync.device')}</dt>
            <dd className="font-mono text-slate-300">{shortId(state.device)}</dd>
            <dt>{t('settings.sync.channel')}</dt>
            <dd className="font-mono text-slate-300">{state.channelId ? shortId(state.channelId) : '—'}</dd>
            <dt>{t('settings.sync.version')}</dt>
            <dd className="font-mono text-slate-300">{state.version}</dd>
            <dt>{t('settings.sync.lastSynced')}</dt>
            <dd className="text-slate-300">
              {state.lastSyncedAt
                ? new Date(state.lastSyncedAt).toLocaleString(lang)
                : t('settings.sync.never')}
            </dd>
          </dl>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => void syncNow()}
              disabled={busy}
              className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 text-slate-950 text-xs font-bold transition flex items-center gap-1.5"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy ? 'animate-spin' : ''}`} aria-hidden="true" />
              {t('settings.sync.now')}
            </button>
            <button
              onClick={() => void engine.disable()}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition border border-slate-700 flex items-center gap-1.5"
            >
              <Power className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.sync.disable')}
            </button>
            <button
              onClick={() => void run(async () => { await engine.resetRemote(); })}
              className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold transition border border-slate-700 flex items-center gap-1.5"
              title={t('settings.sync.republishHint')}
            >
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.sync.republish')}
            </button>
            <button
              onClick={() => void engine.forget()}
              className="text-[11px] text-slate-400 hover:text-red-400 underline flex items-center gap-1"
            >
              <Unplug className="h-3 w-3" aria-hidden="true" /> {t('settings.sync.forget')}
            </button>
          </div>

          {/* The code is the only secret: shown on demand, never stored in the clear. */}
          <div className="rounded-xl bg-slate-800/60 border border-slate-700 p-3 space-y-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] uppercase tracking-wider text-slate-400">
                {t('settings.sync.codeTitle')}
              </span>
              <button
                onClick={() => setRevealed((value) => !value)}
                className="text-[11px] text-emerald-400 hover:text-emerald-300 underline"
              >
                {revealed ? t('settings.sync.hideCode') : t('settings.sync.showCode')}
              </button>
            </div>
            {revealed && (
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all font-mono text-[11px] text-slate-200">
                  {engine.revealCode() ?? createdCode ?? t('settings.sync.codeUnavailable')}
                </code>
                <button
                  onClick={() => {
                    const value = engine.revealCode() ?? createdCode;
                    if (!value) return;
                    void navigator.clipboard?.writeText(value).then(
                      () => {
                        setCopied(true);
                        setTimeout(() => setCopied(false), 2_000);
                      },
                      () => setCopied(false)
                    );
                  }}
                  className="shrink-0 text-slate-400 hover:text-emerald-400"
                  aria-label={t('settings.sync.copy')}
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            )}
            <p className="text-[11px] text-slate-400">{t('settings.sync.codeHint')}</p>
          </div>
        </div>
      )}

      {/* Conflict archive — nothing is overwritten without leaving a trace */}
      {state.enabled && (
        <div className="border-t border-slate-800 pt-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-[10px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
              <History className="h-3.5 w-3.5" aria-hidden="true" /> {t('settings.sync.conflictsTitle')}
            </h4>
            {state.archive.length > 0 && (
              <button
                onClick={() => void run(async () => { await engine.clearConflicts(); })}
                className="text-[11px] text-slate-400 hover:text-red-400 underline"
              >
                {t('settings.sync.clearAll')}
              </button>
            )}
          </div>
          {state.archive.length === 0 ? (
            <p className="text-[11px] text-slate-400">{t('settings.sync.conflictsNone')}</p>
          ) : (
            <ul className="space-y-2">
              {state.archive.map((conflict) => (
                <li
                  key={conflict.id}
                  className="rounded-xl bg-slate-800/60 border border-slate-700 p-3 space-y-1.5"
                >
                  <p className="text-xs text-white font-bold">{recordLabel(conflict)}</p>
                  <p className="text-[11px] text-slate-400">
                    {t('settings.sync.conflictMeta', {
                      winner:
                        conflict.winner === 'local'
                          ? t('settings.sync.conflictLocal')
                          : t('settings.sync.conflictRemote'),
                      reason: t(`settings.sync.reason.${conflict.reason === 'first-join' ? 'firstJoin' : 'concurrent'}`),
                      at: new Date(conflict.at).toLocaleString(lang),
                    })}
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      onClick={() => void restore(conflict.id)}
                      disabled={busy}
                      className="text-[11px] text-emerald-400 hover:text-emerald-300 underline disabled:opacity-40"
                    >
                      {t('settings.sync.restore')}
                    </button>
                    <button
                      onClick={() => void run(async () => { await engine.dismiss(conflict.id); })}
                      className="text-[11px] text-slate-400 hover:text-red-400 underline"
                    >
                      {t('settings.sync.dismiss')}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <p className="text-[11px] text-slate-400 flex items-start gap-1.5">
        <ShieldCheck className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
        {t('settings.sync.privacy')}
      </p>
    </section>
  );
};
