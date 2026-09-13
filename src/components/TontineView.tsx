import React, { useId, useMemo, useRef, useState } from 'react';
import {
  Users, Plus, Pencil, Trash2, X, Lock, HandCoins, ReceiptText, CalendarClock, Copy, Check, Sparkles,
} from 'lucide-react';
import {
  TontineFrequency, TontineGroup, TontineMember, TontinePayment, TontinePaymentMethod, TontineReceipt, TontineRound,
} from '../types';
import { formatMoney } from '../services/currency';
import { useI18n } from '../i18n/useI18n';
import { useModalA11y } from '../hooks/useModalA11y';
import { ROVING_ROW_FOCUS, useRovingListNav } from '../hooks/useRovingListNav';
import { useLicense } from '../hooks/useLicense';
import { tontineGroupLimit, tontineMemberLimit } from '../services/license';
import {
  FREQUENCIES, PAYMENT_METHODS, GroupDraft, MemberDraft, PaymentDraft,
  beneficiaryOf, buildReceipt, emptyGroupDraft, emptyMemberDraft, emptyPaymentDraft,
  expectedAmount, groupSummary, memberLedgers, receiptText, replanRounds, roundProgress,
  todayIso, validateGroupDraft, validateMemberDraft, validatePaymentDraft,
} from '../services/tontine';

/**
 * Tontine / association — the paid group module.
 *
 * The screen follows what a treasurer actually does: pick the group, see who is
 * short this round, record what came in, and hand out a receipt (a text meant to
 * be sent over WhatsApp, which is how these groups really work). Every amount is
 * derived — see services/tontine.ts — so nothing on screen can disagree with the
 * payments that were recorded.
 */
interface TontineHandlers {
  upsertGroup: (group: TontineGroup) => void;
  deleteGroup: (id: string) => void;
  upsertMember: (member: TontineMember) => void;
  deleteMember: (id: string) => void;
  /** Replaces the plan of a group (called when the rotation changes). */
  upsertRounds: (groupId: string, rounds: TontineRound[]) => void;
  upsertPayment: (payment: TontinePayment) => void;
  deletePayment: (id: string) => void;
  /** Records that the pot of a round was handed over to its beneficiary. */
  markPayout: (round: TontineRound, paidOutAt: string) => void;
}

interface TontineViewProps extends TontineHandlers {
  groups: TontineGroup[];
  members: TontineMember[];
  rounds: TontineRound[];
  payments: TontinePayment[];
  currency: string;
  /** Sends the user to Réglages → Offre (used by the upsell). */
  onSeeOffer: () => void;
}

function newId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `${prefix}-${Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

function parseAmount(value: string): number {
  return Math.round(Number(value.replace(/\s/g, '').replace(',', '.')));
}

export const TontineView: React.FC<TontineViewProps> = (props) => {
  const { t, locale } = useI18n();
  const { plan } = useLicense();
  const groupLimit = tontineGroupLimit(plan);
  const memberLimit = tontineMemberLimit(plan);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // `id` is null when creating, set when editing an existing group.
  const [groupForm, setGroupForm] = useState<{ draft: GroupDraft; id: string | null } | null>(null);
  const [memberForm, setMemberForm] = useState<{ draft: MemberDraft; id: string | null } | null>(null);
  const [paymentFor, setPaymentFor] = useState<TontineRound | null>(null);
  const [paymentForDraft, setPaymentForDraft] = useState<PaymentDraft | null>(null);
  const [receipt, setReceipt] = useState<TontineReceipt | null>(null);
  const [copied, setCopied] = useState(false);
  const [armedId, setArmedId] = useState<string | null>(null);
  const [errors, setErrors] = useState<string[]>([]);

  const groups = props.groups;
  const selected = groups.find((group) => group.id === selectedId) ?? groups[0] ?? null;
  const groupMembers = useMemo(
    () => props.members.filter((member) => member.groupId === selected?.id),
    [props.members, selected?.id]
  );
  const groupPayments = useMemo(
    () => props.payments.filter((payment) => payment.groupId === selected?.id),
    [props.payments, selected?.id]
  );
  const groupRounds = useMemo(
    () => props.rounds
      .filter((round) => round.groupId === selected?.id)
      .sort((a, b) => a.index - b.index),
    [props.rounds, selected?.id]
  );
  const summary = useMemo(
    () => (selected ? groupSummary(selected, groupMembers, groupRounds, groupPayments) : null),
    [selected, groupMembers, groupRounds, groupPayments]
  );
  const ledgers = useMemo(
    () => (selected ? memberLedgers(selected, groupMembers, groupRounds, groupPayments) : []),
    [selected, groupMembers, groupRounds, groupPayments]
  );

  // The module is the group offering: without a paid licence, it explains itself
  // and points at the offer instead of showing a locked shell.
  if (groupLimit === 0) {
    return (
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-6 space-y-3 max-w-2xl">
        <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
          <Users className="h-4 w-4" aria-hidden="true" /> {t('tontine.title')}
        </h2>
        <p className="text-xs text-slate-300">{t('tontine.gate.body')}</p>
        <ul className="space-y-1.5 text-xs text-slate-300">
          {[t('tontine.gate.benefit1'), t('tontine.gate.benefit2'), t('tontine.gate.benefit3')].map((benefit) => (
            <li key={benefit} className="flex items-start gap-2">
              <Sparkles className="h-3.5 w-3.5 text-emerald-400 shrink-0 mt-0.5" aria-hidden="true" />
              {benefit}
            </li>
          ))}
        </ul>
        <button
          onClick={props.onSeeOffer}
          className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
        >
          <Lock className="h-3.5 w-3.5" aria-hidden="true" /> {t('tontine.gate.cta')}
        </button>
      </section>
    );
  }

  const openCreateGroup = () => {
    setErrors([]);
    setGroupForm({ draft: emptyGroupDraft(props.currency, todayIso()), id: null });
  };
  const openEditGroup = (group: TontineGroup) => {
    setErrors([]);
    setGroupForm({
      id: group.id,
      draft: {
        name: group.name,
        contribution: String(group.contribution),
        currency: group.currency,
        frequency: group.frequency,
        startDate: group.startDate,
        note: group.note ?? '',
      },
    });
  };

  const saveGroup = () => {
    if (!groupForm) return;
    const problems = validateGroupDraft(groupForm.draft, t);
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    const group: TontineGroup = {
      id: groupForm.id ?? newId('grp'),
      name: groupForm.draft.name.trim(),
      contribution: parseAmount(groupForm.draft.contribution),
      currency: groupForm.draft.currency,
      frequency: groupForm.draft.frequency,
      startDate: groupForm.draft.startDate,
      ...(groupForm.draft.note.trim() ? { note: groupForm.draft.note.trim() } : {}),
    };
    props.upsertGroup(group);
    setSelectedId(group.id);
    setGroupForm(null);
  };

  const saveMember = () => {
    if (!memberForm) return;
    const others = memberForm.id
      ? groupMembers.filter((member) => member.id !== memberForm.id)
      : groupMembers;
    const problems = validateMemberDraft(memberForm.draft, others, t);
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    const member: TontineMember = {
      id: memberForm.id ?? newId('mem'),
      groupId: selected?.id ?? '',
      name: memberForm.draft.name.trim(),
      ...(memberForm.draft.phone.trim() ? { phone: memberForm.draft.phone.trim() } : {}),
      shares: Number(memberForm.draft.shares),
      position: Number(memberForm.draft.position),
      active: memberForm.draft.active,
    };
    props.upsertMember(member);
    // The rotation is the plan: changing members re-dates the rounds.
    if (selected) {
      const next = replanRounds(selected, groupMembers.some((m) => m.id === member.id)
        ? groupMembers.map((m) => (m.id === member.id ? member : m))
        : [...groupMembers, member], groupRounds);
      props.upsertRounds(selected.id, next);
    }
    setMemberForm(null);
  };

  const savePayment = () => {
    if (!paymentFor || !selected || !paymentForDraft) return;
    const member = groupMembers.find((m) => m.id === paymentForDraft.memberId);
    if (!member) return;
    const problems = validatePaymentDraft(paymentForDraft, {
      group: selected,
      member,
      round: paymentFor,
      roundPayments: groupPayments,
    }, t);
    if (problems.length > 0) {
      setErrors(problems);
      return;
    }
    props.upsertPayment({
      id: newId('pay'),
      groupId: selected.id,
      roundId: paymentFor.id,
      memberId: member.id,
      amount: parseAmount(paymentForDraft.amount),
      paidAt: paymentForDraft.paidAt,
      method: paymentForDraft.method,
      ...(paymentForDraft.note.trim() ? { note: paymentForDraft.note.trim() } : {}),
    });
    setPaymentFor(null);
    setPaymentForDraft(null);
  };

  return (
    <div className="space-y-6">
      {/* Groups */}
      <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
              <Users className="h-4 w-4" aria-hidden="true" /> {t('tontine.title')}
            </h2>
            <p className="text-[11px] text-slate-400 mt-1">{t('tontine.subtitle')}</p>
          </div>
          <button
            onClick={openCreateGroup}
            disabled={groups.length >= groupLimit}
            title={groups.length >= groupLimit ? t('tontine.groupLimit') : undefined}
            className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-950 text-xs font-bold flex items-center gap-1.5 transition"
          >
            {groups.length >= groupLimit ? <Lock className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            {t('tontine.newGroup')}
          </button>
        </div>

        {groups.length === 0 ? (
          <p className="text-xs text-slate-400">{t('tontine.noGroups')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {groups.map((group) => {
              const count = props.members.filter((member) => member.groupId === group.id).length;
              const active = selected?.id === group.id;
              return (
                <li key={group.id}>
                  <button
                    onClick={() => setSelectedId(group.id)}
                    aria-current={active ? 'true' : undefined}
                    className={`px-3 py-2 rounded-xl text-xs font-bold border transition flex items-center gap-2 ${
                      active
                        ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                        : 'bg-slate-800 border-slate-700 text-slate-200 hover:bg-slate-700'
                    }`}
                  >
                    {group.name}
                    <span className="font-normal text-slate-400">{t('tontine.groupCount', { n: count })}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        {selected && summary && (
          <div className="space-y-3 border-t border-slate-800 pt-4">
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
              <span>
                {t('tontine.planLine', {
                  amount: formatMoney(selected.contribution, selected.currency, locale),
                  period: t(`tontine.frequency.${selected.frequency}`),
                })}
              </span>
              {selected.note && <span className="text-slate-500">· {selected.note}</span>}
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {[
                { label: t('tontine.pot'), value: formatMoney(summary.pot, selected.currency, locale), icon: HandCoins },
                { label: t('tontine.shares'), value: String(summary.shares), icon: Users },
                { label: t('tontine.collected'), value: formatMoney(summary.collected, selected.currency, locale), icon: Check },
                {
                  label: t('tontine.outstanding'),
                  value: formatMoney(summary.outstandingToDate, selected.currency, locale),
                  icon: CalendarClock,
                },
              ].map(({ label, value, icon: Icon }) => (
                <div key={label} className="rounded-xl bg-slate-800/60 border border-slate-700 p-3">
                  <span className="text-[10px] uppercase tracking-wider text-slate-400 flex items-center gap-1.5">
                    <Icon className="h-3.5 w-3.5" aria-hidden="true" /> {label}
                  </span>
                  <p className="text-sm font-bold text-white mt-1">{value}</p>
                </div>
              ))}
            </div>

            <p className="text-[11px] text-slate-400">
              {t('tontine.expectedToDate', { amount: formatMoney(summary.expectedToDate, selected.currency, locale) })}
              {summary.overdueRounds.length > 0 && (
                <span className="text-amber-400"> · {t('tontine.overdue', { list: summary.overdueRounds.join(', ') })}</span>
              )}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                onClick={() => openEditGroup(selected)}
                className="text-[11px] text-slate-300 hover:text-emerald-400 underline flex items-center gap-1"
              >
                <Pencil className="h-3 w-3" aria-hidden="true" /> {t('tontine.editGroup')}
              </button>
              <button
                onClick={() => {
                  props.deleteGroup(selected.id);
                  setSelectedId(null);
                }}
                className="text-[11px] text-slate-400 hover:text-red-400 underline flex items-center gap-1"
              >
                <Trash2 className="h-3 w-3" aria-hidden="true" /> {t('tontine.deleteGroup')}
              </button>
            </div>
          </div>
        )}
      </section>

      {selected && (
        <>
          <MembersPanel
            members={groupMembers}
            ledgers={ledgers}
            currency={selected.currency}
            limit={memberLimit}
            armedId={armedId}
            setArmedId={setArmedId}
            onNew={() => {
              setErrors([]);
              setMemberForm({ draft: emptyMemberDraft(groupMembers.length + 1), id: null });
            }}
            onEdit={(member) => {
              setErrors([]);
              setMemberForm({
                id: member.id,
                draft: {
                  name: member.name,
                  phone: member.phone ?? '',
                  shares: String(member.shares),
                  position: String(member.position),
                  active: member.active,
                },
              });
            }}
            onDelete={(id) => {
              props.deleteMember(id);
              const plan = replanRounds(selected, groupMembers.filter((m) => m.id !== id), groupRounds);
              props.upsertRounds(selected.id, plan);
            }}
          />

          <RoundsPanel
            rounds={groupRounds}
            group={selected}
            members={groupMembers}
            payments={groupPayments}
            onPay={(round) => {
              setErrors([]);
              setPaymentFor(round);
              const first = groupMembers[0];
              setPaymentForDraft(
                first ? emptyPaymentDraft(first.id, expectedAmount(selected, first), todayIso()) : null
              );
            }}
            onPayout={(round) => props.markPayout(round, todayIso())}
            onDeletePayment={(id) => props.deletePayment(id)}
            onReceipt={(payment) => {
              const member = groupMembers.find((m) => m.id === payment.memberId);
              const round = groupRounds.find((r) => r.id === payment.roundId);
              if (!member || !round) return;
              setReceipt(buildReceipt(selected, member, round, payment, groupPayments));
            }}
          />
        </>
      )}

      {groupForm && (
        <Modal
          title={groupForm.id ? t('tontine.groupForm.edit') : t('tontine.groupForm.title')}
          onClose={() => setGroupForm(null)}
        >
          <Field label={t('tontine.field.name')}>
            <input
              value={groupForm.draft.name}
              onChange={(e) => setGroupForm({ ...groupForm, draft: { ...groupForm.draft, name: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.contribution')}>
            <input
              value={groupForm.draft.contribution}
              inputMode="numeric"
              onChange={(e) => setGroupForm({ ...groupForm, draft: { ...groupForm.draft, contribution: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.frequency')}>
            <select
              value={groupForm.draft.frequency}
              onChange={(e) => setGroupForm({ ...groupForm, draft: { ...groupForm.draft, frequency: e.target.value as TontineFrequency } })}
              className={inputClass}
            >
              {FREQUENCIES.map((frequency) => (
                <option key={frequency} value={frequency}>{t(`tontine.frequency.${frequency}`)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('tontine.field.startDate')}>
            <input
              type="date"
              value={groupForm.draft.startDate}
              onChange={(e) => setGroupForm({ ...groupForm, draft: { ...groupForm.draft, startDate: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.note')}>
            <input
              value={groupForm.draft.note}
              onChange={(e) => setGroupForm({ ...groupForm, draft: { ...groupForm.draft, note: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <ErrorList errors={errors} />
          <Submit onClick={saveGroup} label={t('tontine.save')} />
        </Modal>
      )}

      {memberForm && (
        <Modal title={memberForm.id ? t('tontine.memberForm.edit') : t('tontine.memberForm.title')} onClose={() => setMemberForm(null)}>
          <Field label={t('tontine.field.memberName')}>
            <input
              value={memberForm.draft.name}
              onChange={(e) => setMemberForm({ ...memberForm, draft: { ...memberForm.draft, name: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.phone')}>
            <input
              value={memberForm.draft.phone}
              onChange={(e) => setMemberForm({ ...memberForm, draft: { ...memberForm.draft, phone: e.target.value } })}
              className={inputClass}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t('tontine.field.shares')}>
              <input
                value={memberForm.draft.shares}
                inputMode="numeric"
                onChange={(e) => setMemberForm({ ...memberForm, draft: { ...memberForm.draft, shares: e.target.value } })}
                className={inputClass}
              />
            </Field>
            <Field label={t('tontine.field.position')}>
              <input
                value={memberForm.draft.position}
                inputMode="numeric"
                onChange={(e) => setMemberForm({ ...memberForm, draft: { ...memberForm.draft, position: e.target.value } })}
                className={inputClass}
              />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={memberForm.draft.active}
              onChange={(e) => setMemberForm({ ...memberForm, draft: { ...memberForm.draft, active: e.target.checked } })}
            />
            {t('tontine.field.active')}
          </label>
          <ErrorList errors={errors} />
          <Submit onClick={saveMember} label={t('tontine.save')} />
        </Modal>
      )}

      {paymentFor && paymentForDraft && selected && (
        <Modal title={t('tontine.paymentForm.title', { round: paymentFor.index })} onClose={() => { setPaymentFor(null); setPaymentForDraft(null); }}>
          <Field label={t('tontine.field.member')}>
            <select
              value={paymentForDraft.memberId}
              onChange={(e) => {
                const member = groupMembers.find((m) => m.id === e.target.value);
                setPaymentForDraft({
                  ...paymentForDraft,
                  memberId: e.target.value,
                  amount: member ? String(expectedAmount(selected, member)) : paymentForDraft.amount,
                });
              }}
              className={inputClass}
            >
              {groupMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.name} — {formatMoney(expectedAmount(selected, member), selected.currency, locale)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('tontine.field.amount')}>
            <input
              value={paymentForDraft.amount}
              inputMode="numeric"
              onChange={(e) => setPaymentForDraft({ ...paymentForDraft, amount: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.paidAt')}>
            <input
              type="date"
              value={paymentForDraft.paidAt}
              onChange={(e) => setPaymentForDraft({ ...paymentForDraft, paidAt: e.target.value })}
              className={inputClass}
            />
          </Field>
          <Field label={t('tontine.field.method')}>
            <select
              value={paymentForDraft.method}
              onChange={(e) => setPaymentForDraft({ ...paymentForDraft, method: e.target.value as TontinePaymentMethod })}
              className={inputClass}
            >
              {PAYMENT_METHODS.map((method) => (
                <option key={method} value={method}>{t(`tontine.method.${method}`)}</option>
              ))}
            </select>
          </Field>
          <Field label={t('tontine.field.note')}>
            <input
              value={paymentForDraft.note}
              onChange={(e) => setPaymentForDraft({ ...paymentForDraft, note: e.target.value })}
              className={inputClass}
            />
          </Field>
          <ErrorList errors={errors} />
          <Submit onClick={savePayment} label={t('tontine.savePayment')} />
        </Modal>
      )}

      {receipt && selected && (
        <ReceiptModal
          receipt={receipt}
          currency={selected.currency}
          copied={copied}
          onCopy={() => {
            const text = receiptText(receipt, {
              title: t('tontine.receiptTitle'),
              amount: formatMoney(receipt.amount, selected.currency, locale),
              remaining: formatMoney(receipt.remaining, selected.currency, locale),
              date: receipt.paidAt,
              lines: {
                number: t('tontine.receiptLines.number'),
                member: t('tontine.receiptLines.member'),
                round: t('tontine.receiptLines.round'),
                shares: t('tontine.receiptLines.shares'),
                amount: t('tontine.receiptLines.amount'),
                date: t('tontine.receiptLines.date'),
                method: t('tontine.receiptLines.method'),
                remaining: t('tontine.receiptLines.remaining'),
                ...PAYMENT_METHODS.reduce<Record<string, string>>((acc, method) => {
                  acc[`method.${method}`] = t(`tontine.method.${method}`);
                  return acc;
                }, {}),
              },
            });
            void navigator.clipboard?.writeText(text).then(
              () => { setCopied(true); setTimeout(() => setCopied(false), 2_000); },
              () => setCopied(false)
            );
          }}
          onClose={() => setReceipt(null)}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

const MembersPanel: React.FC<{
  members: TontineMember[];
  ledgers: ReturnType<typeof memberLedgers>;
  currency: string;
  limit: number;
  armedId: string | null;
  setArmedId: (id: string | null) => void;
  onNew: () => void;
  onEdit: (member: TontineMember) => void;
  onDelete: (id: string) => void;
}> = ({ members, ledgers, currency, limit, armedId, setArmedId, onNew, onEdit, onDelete }) => {
  const { t, locale } = useI18n();
  const hintId = useId();
  const nav = useRovingListNav<HTMLUListElement>({
    count: ledgers.length,
    label: t('tontine.memberListAria'),
    hintId: ledgers.length > 0 ? hintId : undefined,
    onActivate: (i) => {
      const ledger = ledgers[i];
      if (!ledger) return;
      if (armedId === ledger.member.id) {
        onDelete(ledger.member.id);
        setArmedId(null);
        return;
      }
      onEdit(ledger.member);
    },
    onRemove: (i) => {
      const ledger = ledgers[i];
      if (ledger) setArmedId(ledger.member.id);
    },
    onEscape: () => setArmedId(null),
  });

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
          <Users className="h-4 w-4" aria-hidden="true" /> {t('tontine.members')}
        </h3>
        <button
          onClick={onNew}
          disabled={members.length >= limit}
          className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-100 text-xs font-bold border border-slate-700 transition flex items-center gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> {t('tontine.newMember')}
        </button>
      </div>

      {members.length === 0 ? (
        <p className="text-xs text-slate-400">{t('tontine.noMembers')}</p>
      ) : (
        <ul {...nav.listProps} className="space-y-2">
          {ledgers.map((ledger, index) => (
            <li
              key={ledger.member.id}
              {...nav.itemProps(index)}
              aria-label={t('tontine.memberRowAria', {
                name: ledger.member.name,
                shares: ledger.member.shares,
                position: ledger.member.position,
                paid: formatMoney(ledger.paid, currency, locale),
                due: formatMoney(ledger.due, currency, locale),
              })}
              className={`${ROVING_ROW_FOCUS} rounded-xl bg-slate-800/60 border border-slate-700 p-3 flex flex-wrap items-center justify-between gap-3`}
            >
              <div className="min-w-0">
                <p className="text-xs font-bold text-white">
                  {ledger.member.name}
                  {!ledger.member.active && <span className="text-slate-400 font-normal"> · {t('tontine.memberInactive')}</span>}
                </p>
                <p className="text-[11px] text-slate-400">
                  {t('tontine.memberMeta', { shares: ledger.member.shares, position: ledger.member.position })}
                  {' · '}
                  {t('tontine.memberLedger', {
                    paid: formatMoney(ledger.paid, currency, locale),
                    due: formatMoney(ledger.due, currency, locale),
                  })}
                  {ledger.missingRounds.length > 0 && (
                    <span className="text-amber-400">
                      {' · '}
                      {t('tontine.memberMissing', { list: ledger.missingRounds.join(', ') })}
                    </span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => onEdit(ledger.member)}
                  aria-label={t('tontine.editMemberAria', { name: ledger.member.name })}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-emerald-400 hover:bg-slate-700"
                >
                  <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                <button
                  onClick={() => (armedId === ledger.member.id ? (onDelete(ledger.member.id), setArmedId(null)) : setArmedId(ledger.member.id))}
                  aria-label={t('tontine.deleteMemberAria', { name: ledger.member.name })}
                  className={`p-1.5 rounded-lg hover:bg-slate-700 ${armedId === ledger.member.id ? 'text-red-400' : 'text-slate-400 hover:text-red-400'}`}
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {ledgers.length > 0 && (
        <p id={hintId} className="text-[11px] text-slate-400">{t('tontine.keyboardHint')}</p>
      )}
    </section>
  );
};

const RoundsPanel: React.FC<{
  rounds: TontineRound[];
  group: TontineGroup;
  members: TontineMember[];
  payments: TontinePayment[];
  onPay: (round: TontineRound) => void;
  onPayout: (round: TontineRound) => void;
  onDeletePayment: (id: string) => void;
  onReceipt: (payment: TontinePayment) => void;
}> = ({ rounds, group, members, payments, onPay, onPayout, onDeletePayment, onReceipt }) => {
  const { t, locale } = useI18n();
  const today = todayIso();

  return (
    <section className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <h3 className="text-sm font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-2">
        <CalendarClock className="h-4 w-4" aria-hidden="true" /> {t('tontine.rounds')}
      </h3>
      {rounds.length === 0 ? (
        <p className="text-xs text-slate-400">{t('tontine.noRounds')}</p>
      ) : (
        <ul className="space-y-3">
          {rounds.map((round) => {
            const progress = roundProgress(group, members, round, payments, today);
            const beneficiary = beneficiaryOf(round, members);
            const roundPayments = payments.filter((payment) => payment.roundId === round.id);
            return (
              <li key={round.id} className="rounded-xl bg-slate-800/60 border border-slate-700 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-bold text-white">
                    {t('tontine.roundRow', {
                      index: round.index,
                      date: new Date(`${round.dueDate}T00:00:00`).toLocaleDateString(locale, {
                        day: '2-digit', month: 'short', year: 'numeric',
                      }),
                      name: beneficiary?.name ?? t('tontine.roundOrphan'),
                    })}
                  </p>
                  <span
                    className={`text-[10px] uppercase font-bold px-2 py-1 rounded border ${
                      progress.state === 'paid'
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : progress.state === 'overdue'
                          ? 'bg-red-500/10 text-red-400 border-red-500/20'
                          : 'bg-slate-800 text-slate-300 border-slate-700'
                    }`}
                  >
                    {t(`tontine.roundState.${progress.state}`)}
                  </span>
                </div>

                <div className="h-2 rounded-full bg-slate-700 overflow-hidden" aria-hidden="true">
                  <div
                    className="h-full bg-emerald-500"
                    style={{ width: `${progress.expected > 0 ? Math.min(100, Math.round((progress.collected / progress.expected) * 100)) : 0}%` }}
                  />
                </div>
                <p className="text-[11px] text-slate-400">
                  {t('tontine.roundProgress', {
                    collected: formatMoney(progress.collected, group.currency, locale),
                    expected: formatMoney(progress.expected, group.currency, locale),
                    paid: progress.paidMembers,
                    total: progress.totalMembers,
                  })}
                </p>

                {roundPayments.length > 0 && (
                  <ul className="space-y-1">
                    {roundPayments.map((payment) => {
                      const member = members.find((m) => m.id === payment.memberId);
                      return (
                        <li key={payment.id} className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300">
                          <span>
                            {t('tontine.paymentRow', {
                              member: member?.name ?? payment.memberId,
                              amount: formatMoney(payment.amount, group.currency, locale),
                              date: payment.paidAt,
                            })}
                          </span>
                          <span className="flex items-center gap-2">
                            <button onClick={() => onReceipt(payment)} className="text-emerald-400 hover:text-emerald-300 underline flex items-center gap-1">
                              <ReceiptText className="h-3 w-3" aria-hidden="true" /> {t('tontine.receipt')}
                            </button>
                            <button
                              onClick={() => onDeletePayment(payment.id)}
                              aria-label={t('tontine.deletePaymentAria', { member: member?.name ?? '' })}
                              className="text-slate-400 hover:text-red-400"
                            >
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </button>
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    onClick={() => onPay(round)}
                    className="px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-[11px] font-bold transition flex items-center gap-1.5"
                  >
                    <HandCoins className="h-3.5 w-3.5" aria-hidden="true" /> {t('tontine.pay')}
                  </button>
                  {/* Handing the pot over is the second half of a round; only the
                      round that is fully collected can be settled. */}
                  {round.paidOutAt ? (
                    <span className="text-[11px] text-emerald-400 font-bold flex items-center gap-1">
                      <Check className="h-3.5 w-3.5" aria-hidden="true" />
                      {t('tontine.paidOut', { date: round.paidOutAt })}
                    </span>
                  ) : progress.state === 'paid' ? (
                    <button
                      onClick={() => onPayout(round)}
                      className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 text-[11px] font-bold border border-emerald-500/30 transition flex items-center gap-1.5"
                    >
                      <HandCoins className="h-3.5 w-3.5" aria-hidden="true" /> {t('tontine.markPayout')}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
};

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

const inputClass =
  'w-full rounded-lg bg-slate-800 border border-slate-700 px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500';

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <label className="block">
    <span className="block text-[10px] uppercase tracking-wider text-slate-400 mb-1">{label}</span>
    {children}
  </label>
);

const ErrorList: React.FC<{ errors: string[] }> = ({ errors }) => {
  if (errors.length === 0) return null;
  return (
    <ul role="alert" className="space-y-1">
      {errors.map((message) => (
        <li key={message} className="text-[11px] text-red-400">{message}</li>
      ))}
    </ul>
  );
};

const Submit: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 pt-1">
      <button
        onClick={onClick}
        className="px-3 py-2 rounded-xl bg-emerald-500 hover:bg-emerald-600 text-slate-950 text-xs font-bold transition"
      >
        {label}
      </button>
      <span className="text-[11px] text-slate-400">{t('tontine.paymentHint')}</span>
    </div>
  );
};

const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y(ref, onClose);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/70">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl bg-slate-900 border border-slate-700 p-5 space-y-3"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-bold text-white">{title}</h3>
          <button onClick={onClose} aria-label={title} className="p-1 text-slate-400 hover:text-white">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
};

const ReceiptModal: React.FC<{
  receipt: TontineReceipt;
  currency: string;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}> = ({ receipt, currency, copied, onCopy, onClose }) => {
  const { t, locale } = useI18n();
  const money = (amount: number) => formatMoney(amount, currency, locale);
  return (
    <Modal title={t('tontine.receiptTitle')} onClose={onClose}>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-[11px]">
        <dt className="text-slate-400">{t('tontine.receiptLines.number')}</dt>
        <dd className="font-mono text-slate-200">{receipt.number}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.member')}</dt>
        <dd className="text-slate-200">{receipt.memberName}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.round')}</dt>
        <dd className="text-slate-200">{receipt.roundIndex}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.shares')}</dt>
        <dd className="text-slate-200">{receipt.shares}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.amount')}</dt>
        <dd className="text-slate-200">{money(receipt.amount)}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.date')}</dt>
        <dd className="text-slate-200">{receipt.paidAt}</dd>
        <dt className="text-slate-400">{t('tontine.receiptLines.method')}</dt>
        <dd className="text-slate-200">{t(`tontine.method.${receipt.method}`)}</dd>
      </dl>
      <p className={`text-[11px] ${receipt.complete ? 'text-emerald-400' : 'text-amber-400'}`}>
        {receipt.complete
          ? t('tontine.receiptComplete')
          : t('tontine.receiptPartial', { amount: money(receipt.remaining) })}
      </p>
      <div className="flex items-center gap-2">
        <button
          onClick={onCopy}
          className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 text-xs font-bold border border-slate-700 transition flex items-center gap-1.5"
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
          {copied ? t('tontine.copied') : t('tontine.copyReceipt')}
        </button>
      </div>
    </Modal>
  );
};


