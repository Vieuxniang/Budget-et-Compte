import React, { Suspense, lazy, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Wallet, Shield, Lock, TrendingDown, Smartphone } from 'lucide-react';
import { AppData, getSecurityConfig, saveSecurityConfig } from './services/storage';
import { detectCurrency, formatMoney } from './services/currency';
import { I18nProvider } from './i18n';
import { useI18n } from './i18n/useI18n';
import { Language, localeOf } from './i18n/translations';
import { getPreferences, savePreferences, Preferences } from './services/preferences';
import { balancesByAccountId, netWorthBreakdown, validateLedger, LedgerIssue } from './services/ledger';
import { encryptAndStore, rekeyVault, VaultSession } from './services/vault';
import { SyncEngine } from './services/sync/engine';
import { ACCOUNT_TYPE_META, walletBrandColor, accountTypeLabelKey } from './services/accountMeta';
import { useInstallPrompt } from './hooks/useInstallPrompt';
import { createDataStore, useDataStore } from './hooks/useDataStore';
// BudgetView is the one heavy view (recharts, ~430 kB of the bundle). It is
// the single lazy route: the dashboard renders without it, and it streams in
// on first visit to the Budget tab. Kept eager: the locked shell and the
// LCP-critical dashboard.
const BudgetView = lazy(() =>
  import('./components/BudgetView').then((m) => ({ default: m.BudgetView })),
);
import { AuthLock, UnlockedPayload } from './components/AuthLock';
import { CareerGuideView } from './components/CareerGuideView';
import { TransactionsView } from './components/TransactionsView';
import { TontineView } from './components/TontineView';
import { PacksView } from './components/PacksView';
import { SettingsView } from './components/SettingsView';
import { PwaToasts } from './components/PwaToasts';
import { useAutoLock } from './hooks/useAutoLock';
import { ROVING_ROW_FOCUS, useRovingListNav } from './hooks/useRovingListNav';
import { Account, SecurityConfig } from './types';
import { CountryPack, TemplateAllocation, monthlyIncomeBaseline } from './services/packs';
import * as edits from './services/dataEdits';
import { GoalsSection } from './components/GoalsSection';

type Tab = 'dashboard' | 'transactions' | 'budget' | 'career' | 'tontine' | 'packs' | 'settings';

const TABS: Array<[Tab, string]> = [
  ['dashboard', 'app.tab.dashboard'],
  ['transactions', 'app.tab.transactions'],
  ['budget', 'app.tab.budget'],
  ['career', 'app.tab.career'],
  ['tontine', 'app.tab.tontine'],
  ['packs', 'app.tab.packs'],
  ['settings', 'app.tab.settings'],
];

export const App: React.FC = () => {
  const [prefs, setPrefs] = useState<Preferences>(() => getPreferences());

  useEffect(() => {
    const light = prefs.theme === 'light';
    document.documentElement.classList.toggle('light', light);
  }, [prefs.theme]);

  // Keep the document language tag in sync with the app language (SEO/a11y).
  useEffect(() => {
    document.documentElement.lang = localeOf(prefs.language);
  }, [prefs.language]);

  const setLanguage = (language: Language) => {
    const next = { ...prefs, language };
    setPrefs(next);
    savePreferences(next);
  };

  const setTheme = (theme: Preferences['theme']) => {
    const next = { ...prefs, theme };
    setPrefs(next);
    savePreferences(next);
  };

  return (
    <I18nProvider language={prefs.language} onLanguageChange={setLanguage}>
      <AppShell
        language={prefs.language}
        onLanguageChange={setLanguage}
        theme={prefs.theme}
        onThemeChange={setTheme}
      />
    </I18nProvider>
  );
};

const AppShell: React.FC<{
  language: Language;
  onLanguageChange: (lang: Language) => void;
  theme: Preferences['theme'];
  onThemeChange: (theme: Preferences['theme']) => void;
}> = ({ language, onLanguageChange, theme, onThemeChange }) => {
  const { t } = useI18n();
  const [isLocked, setIsLocked] = useState(true);
  const [security, setSecurity] = useState<SecurityConfig>(() => getSecurityConfig());
  const autoLockMinutes = security.autoLockMinutes;
  const { canInstall, installed, install } = useInstallPrompt();
  // Data exists in memory ONLY while unlocked — it is decrypted on unlock and
  // dropped on lock. At rest, storage holds AES-GCM ciphertext only. It lives
  // in `store` (hooks/useDataStore.ts), created below next to the sync engine:
  // one synchronous reader, one writer, one side-effect seam.
  const [issues, setIssues] = useState<LedgerIssue[]>([]);
  const sessionRef = useRef<VaultSession | null>(null);
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  // One engine per session. Created during render but never re-created, so its
  // timers and subscriptions survive every re-render.
  const syncRef = useRef<SyncEngine | null>(null);
  if (!syncRef.current) syncRef.current = new SyncEngine();
  const syncEngine = syncRef.current;
  // The store is the single owner of the session data. `mutate` reads it
  // synchronously, so a handler can perform several writes in a row and the
  // second one sees what the first stored — the stale-state bug that once made
  // a tontine member disappear when its rounds were recomputed in the same
  // tick. `onPersist` is the only side-effect seam (sync publish + vault
  // write); a write from empty is population (unlock), never a mutation.
  const store = useMemo(
    () =>
      createDataStore<AppData>({
        onPersist: (next) => {
          // Local-first: the engine only notes what changed and syncs in the
          // background, so a mutation never waits for the network.
          syncEngine.publish(next);
          const session = sessionRef.current;
          if (session) {
            void encryptAndStore(session.key, session.saltB64, next).catch(() => {
              // Storage write failure is non-fatal in-session; next save retries.
            });
          }
        },
      }),
    [syncEngine]
  );
  const data = useDataStore(store);
  // Currency preference from Réglages, detected from the browser region when unset.
  const currency = security.currency ?? detectCurrency();

  const handleUnlocked = (payload: UnlockedPayload) => {
    sessionRef.current = payload.session;
    setIssues(validateLedger(payload.data.accounts, payload.data.transactions));
    store.set(payload.data);
    setIsLocked(false);
    // Sync is opt-in and only awakens with the vault key: without it the sealed
    // sync phrase cannot be opened, so nothing is attempted while locked.
    void syncEngine
      .open({ vaultKey: payload.session.key, data: payload.data })
      .then((report) => {
        if (report?.data) applySynced(report.data);
      })
      .catch(() => {
        // A sync failure never blocks the session: the local data is already in.
      });
  };

  const lockSession = () => {
    // Drop the key first: without it neither storage nor memory is readable.
    syncEngine.close();
    sessionRef.current = null;
    store.clear();
    setIssues([]);
    setIsLocked(true);
  };

  /** Data the engine pulled (or restored from a conflict): goes through the vault. */
  const applySynced = (next: AppData) => {
    setIssues(validateLedger(next.accounts, next.transactions));
    store.set(next);
  };

  // Every handler below is a pure edit from services/dataEdits.ts bound to the
  // store's write path — the tested code is the code that runs.
  const upsertTransaction = store.bindEdit(edits.upsertTransaction);
  const deleteTransaction = store.bindEdit(edits.deleteTransaction);
  const upsertAccount = store.bindEdit(edits.upsertAccount);
  const deleteAccount = store.bindEdit(edits.deleteAccount);
  const upsertGoal = store.bindEdit(edits.upsertGoal);
  const deleteGoal = store.bindEdit(edits.deleteGoal);

  const updateSecurity = (next: SecurityConfig) => {
    setSecurity(next);
    saveSecurityConfig(next);
  };

  /** Password change from Settings: re-encrypt the vault under the new password. */
  const reencryptVault = async (newPassword: string) => {
    const current = store.getData();
    if (!current) return;
    sessionRef.current = await rekeyVault(newPassword, current);
  };

  // -------------------------------------------------------------------------
  // Tontine / association — the edits, including the delete cascades, live in
  // services/dataEdits.ts where the tests run them.
  // -------------------------------------------------------------------------

  const upsertTontineGroup = store.bindEdit(edits.upsertTontineGroup);
  const deleteTontineGroup = store.bindEdit(edits.deleteTontineGroup);
  const upsertTontineMember = store.bindEdit(edits.upsertTontineMember);
  const deleteTontineMember = store.bindEdit(edits.deleteTontineMember);
  const upsertTontineRounds = store.bindEdit(edits.planTontineRounds);
  const upsertTontinePayment = store.bindEdit(edits.upsertTontinePayment);
  const deleteTontinePayment = store.bindEdit(edits.deleteTontinePayment);
  const markTontinePayout = store.bindEdit(edits.settleTontineRound);

  // -------------------------------------------------------------------------
  // Country content packs — installing only records the choice; applying a
  // template writes ordinary budget categories, so the pack needs no storage
  // of its own and the vault, the backup and the sync cover it already.
  // -------------------------------------------------------------------------

  const installPack = store.bindEdit(edits.installPack);
  const uninstallPack = store.bindEdit(edits.uninstallPack);
  // The one edit that takes a renderer: category names are UI text in the
  // current language, so the view layer supplies them.
  const applyPackTemplate = (pack: CountryPack, allocations: TemplateAllocation[]) =>
    store.mutate((d) => edits.applyPackTemplate(d, pack, allocations, (key) => t(`packs.category.${key}`)));
  const removePackTemplate = store.bindEdit(edits.removePackTemplate);

  /** Backup import: replaces all data in one shot (goes through the vault). */
  const restoreData = store.bindEdit(edits.replaceData);

  useAutoLock({ isLocked, lock: lockSession, timeoutMinutes: autoLockMinutes });

  // Coming back online is the moment sync is worth retrying immediately.
  useEffect(() => {
    const retry = () => void syncEngine.sync();
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [syncEngine]);

  const balances = useMemo(
    () => balancesByAccountId(data?.accounts ?? [], data?.transactions ?? []),
    [data]
  );
  // What the packs' template tool offers as a starting income: the ledger's own
  // recent monthly income, so the user adjusts a real number instead of guessing.
  const suggestedIncome = useMemo(
    () => monthlyIncomeBaseline(data?.transactions ?? [], new Date().toISOString().slice(0, 10)),
    [data]
  );
  const worth = useMemo(
    () => netWorthBreakdown(data?.accounts ?? [], data?.transactions ?? []),
    [data]
  );

  // Ledger integrity issues are non-fatal; surface them for now.
  useEffect(() => {
    if (issues.length > 0) console.warn('Ledger integrity issues:', issues);
  }, [issues]);

  if (isLocked) {
    return (
      <>
        <AuthLock onUnlocked={handleUnlocked} />
        <PwaToasts />
      </>
    );
  }
  if (!data) {
    // Unlocked flag without data can't happen (handleUnlocked sets both);
    // this keeps TypeScript and the render honest regardless.
    return <div className="min-h-screen bg-slate-950" />;
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans">
      <a href="#contenu-principal" className="skip-link">
        {t('app.skipToContent')}
      </a>
      {/* Header Bar */}
      <header className="bg-slate-900 border-b border-slate-800 px-4 sm:px-6 py-3 sm:py-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-xl" aria-hidden="true">
            <Wallet className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white leading-none">{t('app.brand')}</h1>
            <span className="text-xs text-slate-400">{t('app.tagline')}</span>
          </div>
        </div>

        {/* Tabs: full-width scrollable strip on mobile, inline on desktop */}
        <TabBar activeTab={activeTab} onSelect={setActiveTab} />

        <div className="flex items-center gap-2">
          {canInstall && !installed && (
            <button
              onClick={install}
              className="px-3 py-2 md:py-1.5 rounded-lg text-xs font-bold bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 hover:bg-emerald-500/20 transition flex items-center gap-1.5 whitespace-nowrap"
              title={t('app.installTitle')}
            >
              <Smartphone className="h-3.5 w-3.5" aria-hidden="true" /> {t('app.install')}
            </button>
          )}
          <button
            onClick={lockSession}
            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg transition"
            title={t('app.lockSession')}
            aria-label={t('app.lockSession')}
          >
            <Lock className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main id="contenu-principal" className="flex-1 p-6 max-w-7xl mx-auto w-full">
        {activeTab === 'dashboard' ? (
          <div className="space-y-6">
            {/* Net Worth Card — assets minus liabilities, always ledger-derived */}
            <div className="p-6 rounded-2xl bg-gradient-to-r from-emerald-950/40 via-slate-900 to-slate-900 border border-emerald-800/30">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <span className="text-xs font-medium text-slate-400">{t('app.netWorth')}</span>
                  <div className={`text-3xl font-extrabold mt-1 ${worth.net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {formatMoney(worth.net, currency)}
                  </div>
                </div>
                <span className="shrink-0 whitespace-nowrap text-xs px-2.5 py-1 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-500/20 flex items-center gap-1">
                  <Shield className="h-3 w-3" /> {t('app.localData')}
                </span>
              </div>
              <div className="mt-4 flex flex-wrap gap-4 text-sm">
                <span className="text-slate-400">
                  {t('app.assets')} : <strong className="text-white">{formatMoney(worth.assets, currency)}</strong>
                </span>
                <span className="text-slate-400 flex items-center gap-1">
                  <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                  {t('app.debts')} : <strong className="text-red-400">{formatMoney(worth.liabilities, currency)}</strong>
                </span>
              </div>
            </div>

            {/* Accounts Grid — balances computed from initialBalance + transactions */}
            <AccountsGrid
              accounts={data.accounts}
              balances={balances}
              currency={currency}
              theme={theme}
            />

            {/* Savings goals — the free offer allows one; Pro lifts the limit */}
            <GoalsSection
              goals={data.goals}
              currency={currency}
              onUpsert={upsertGoal}
              onDelete={deleteGoal}
              onSeeOffer={() => setActiveTab('settings')}
            />
          </div>
        ) : activeTab === 'transactions' ? (
          <TransactionsView
            accounts={data.accounts}
            transactions={data.transactions}
            categories={data.budgetCategories}
            currency={currency}
            onUpsert={upsertTransaction}
            onDelete={deleteTransaction}
          />
        ) : activeTab === 'budget' ? (
          <Suspense
            fallback={
              <div className="flex justify-center py-16" role="status" aria-live="polite">
                <div className="animate-pulse text-sm text-slate-400">{t('app.loadingChart')}</div>
              </div>
            }
          >
            <BudgetView
            categories={data.budgetCategories}
            transactions={data.transactions}
            currency={currency}
              theme={theme}
            />
          </Suspense>
        ) : activeTab === 'tontine' ? (
          <TontineView
            groups={data.tontineGroups ?? []}
            members={data.tontineMembers ?? []}
            rounds={data.tontineRounds ?? []}
            payments={data.tontinePayments ?? []}
            currency={currency}
            onSeeOffer={() => setActiveTab('settings')}
            upsertGroup={upsertTontineGroup}
            deleteGroup={deleteTontineGroup}
            upsertMember={upsertTontineMember}
            deleteMember={deleteTontineMember}
            upsertRounds={upsertTontineRounds}
            upsertPayment={upsertTontinePayment}
            deletePayment={deleteTontinePayment}
            markPayout={markTontinePayout}
          />
        ) : activeTab === 'packs' ? (
          <PacksView
            installed={data.installedPacks ?? []}
            currency={currency}
            suggestedIncome={suggestedIncome}
            onInstall={installPack}
            onUninstall={uninstallPack}
            onApplyTemplate={applyPackTemplate}
            onRemoveTemplate={removePackTemplate}
            onSeeOffer={() => setActiveTab('settings')}
          />
        ) : activeTab === 'settings' ? (
          <SettingsView
            accounts={data.accounts}
            transactions={data.transactions}
            budgetCategories={data.budgetCategories}
            goals={data.goals}
            security={security}
            currency={currency}
            language={language}
            onLanguageChange={onLanguageChange}
            theme={theme}
            onThemeChange={onThemeChange}
            onSecurityChange={updateSecurity}
            onReencrypt={reencryptVault}
            onUpsertAccount={upsertAccount}
            onDeleteAccount={deleteAccount}
            onRestore={restoreData}
            syncEngine={syncEngine}
            onApplySyncedData={applySynced}
          />
        ) : (
          <CareerGuideView currency={currency} />
        )}
      </main>      <PwaToasts />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tab bar — a single tab stop; ← / → walk the strip and switch tab
// ---------------------------------------------------------------------------

const TabBar: React.FC<{ activeTab: Tab; onSelect: (tab: Tab) => void }> = ({ activeTab, onSelect }) => {
  const { t } = useI18n();
  // Selection follows focus: pressing → both moves to the next tab and shows
  // it, which is what a keyboard user expects from a tab strip.
  const nav = useRovingListNav<HTMLElement>({
    count: TABS.length,
    label: t('app.tabNavAria'),
    orientation: 'horizontal',
    semantics: 'buttons',
    activateOnFollow: true,
    onActivate: (i) => onSelect(TABS[i][0]),
  });

  return (
    <nav
      {...nav.listProps}
      className="order-last w-full -mx-1 px-1 flex gap-2 overflow-x-auto pb-0.5 md:order-none md:ml-auto md:w-auto md:mx-0 md:pb-0 md:overflow-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map(([tab, labelKey], index) => (
        <button
          key={tab}
          {...nav.itemProps(index)}
          onClick={() => onSelect(tab)}
          aria-current={activeTab === tab ? 'page' : undefined}
          className={`shrink-0 whitespace-nowrap px-3 py-2 md:py-1.5 rounded-lg text-xs font-medium transition ${
            activeTab === tab ? 'bg-emerald-500 text-slate-950' : 'bg-slate-800 text-slate-300'
          }`}
        >
          {t(labelKey)}
        </button>
      ))}
    </nav>
  );
};

// ---------------------------------------------------------------------------
// Dashboard accounts grid — browse-only keyboard list (no controls inside)
// ---------------------------------------------------------------------------

const AccountsGrid: React.FC<{
  accounts: Account[];
  balances: Record<string, number>;
  currency: string;
  theme: Preferences['theme'];
}> = ({ accounts, balances, currency, theme }) => {
  const { t, locale } = useI18n();
  const hintId = useId();
  // The cards are read-only, so the arrows only browse: taking focus announces
  // the account and its ledger-derived balance instead of an empty group.
  const nav = useRovingListNav({
    count: accounts.length,
    label: t('app.accountsAria'),
    orientation: 'grid',
    hintId,
  });

  return (
    <div className="space-y-2">
      <div {...nav.listProps} className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {accounts.map((acc, index) => {
          const meta = ACCOUNT_TYPE_META[acc.type];
          const bal = balances[acc.id] ?? 0;
          const brand = walletBrandColor(acc.type, theme);
          const balanceLabel = `${meta.isLiability ? '−' : ''}${formatMoney(Math.abs(bal), currency, locale)}`;
          return (
            <div
              key={acc.id}
              {...nav.itemProps(index, {
                label: t('settings.accounts.rowAria', {
                  name: acc.name, balance: balanceLabel, institution: acc.institution,
                }),
              })}
              className={`p-4 bg-slate-900 rounded-xl space-y-2 border ${meta.isLiability ? 'border-red-900/40' : 'border-slate-800'} ${ROVING_ROW_FOCUS}`}
            >
              <div className="flex justify-between items-start">
                <span className="text-xs text-slate-400">{acc.institution}</span>
                <span
                  className={`text-[10px] uppercase font-bold px-2 py-0.5 rounded ${meta.badgeClass}`}
                  style={brand && !meta.isLiability ? { color: brand } : undefined}
                >
                  {t(accountTypeLabelKey(acc.type))}
                </span>
              </div>
              <h3 className="text-sm font-semibold text-white">{acc.name}</h3>
              <p className={`text-lg font-bold ${meta.balanceClass}`}>{balanceLabel}</p>
            </div>
          );
        })}
      </div>
      <p id={hintId} className="text-[11px] text-slate-400 px-1">{t('a11y.listNavHint')}</p>
    </div>
  );
};
