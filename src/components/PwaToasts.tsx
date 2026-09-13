import React from 'react';
import { RefreshCw, X, WifiOff } from 'lucide-react';
import { usePwaUpdate } from '../hooks/usePwaUpdate';
import { useI18n } from '../i18n/useI18n';

/**
 * Bottom toast stack for PWA lifecycle events:
 * - "Nouvelle version disponible" → applies the waiting service worker, then reloads.
 * - "Prête hors ligne" → shown once when the precache completes.
 * Rendered outside the lock gate so updates surface even on the lock screen.
 */
export const PwaToasts: React.FC = () => {
  const { t } = useI18n();
  const { needRefresh, offlineReady, acceptUpdate, dismiss } = usePwaUpdate();
  const visible = needRefresh || offlineReady;
  if (!visible) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 md:left-auto md:translate-x-0 md:right-4 z-50 flex flex-col gap-2 w-[calc(100%-2rem)] max-w-sm">
      {needRefresh && (
        <Toast onClose={dismiss}>
          <RefreshCw className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t('pwa.newVersion')}</span>
          <button
            onClick={acceptUpdate}
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-500 text-slate-950 hover:bg-emerald-400 transition whitespace-nowrap"
          >
            {t('pwa.update')}
          </button>
        </Toast>
      )}
      {offlineReady && !needRefresh && (
        <Toast onClose={dismiss}>
          <WifiOff className="h-4 w-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <span className="flex-1">{t('pwa.offlineReady')}</span>
        </Toast>
      )}
    </div>
  );
};

const Toast: React.FC<{ children: React.ReactNode; onClose: () => void }> = ({ children, onClose }) => {
  const { t } = useI18n();
  return (
    <div role="status" className="p-3 bg-slate-900 border border-slate-700 rounded-xl shadow-xl text-sm text-slate-200 flex items-center gap-2">{children}
      <button
        onClick={onClose}
        aria-label={t('common.close')}
        className="p-1 text-slate-400 hover:text-slate-300 transition shrink-0"
      >
        <X className="h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
};