import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { TxModal } from './TransactionsView';
import { Account, Transaction } from '../types';

// No jsdom in the project: the modal is rendered with react-dom/server and the
// test observes the real markup — which is what determines the pixels. The
// transfer branch is reached the honest way: an editing fixture whose type is
// 'transfer' (the same path transactionToDraft takes for a real edit).
const account = (id: string, name: string): Account => ({
  id,
  name,
  type: 'checking',
  institution: 'X',
  holder: 'Famille',
  initialBalance: 0,
  currency: 'XOF',
});

const transferTx = (from: string, to?: string): Transaction => ({
  id: 'tx-fix',
  date: '2026-09-13',
  title: 'Virement test',
  amount: 5000,
  type: 'transfer',
  category: 'Transferts',
  accountId: from,
  toAccountId: to,
  member: 'Famille',
});

const renderTransferModal = (accounts: Account[], editing: Transaction) =>
  renderToStaticMarkup(
    <I18nProvider language="fr" onLanguageChange={() => {}}>
      <TxModal
        modalRef={React.createRef()}
        accounts={accounts}
        categorySuggestions={[]}
        memberSuggestions={[]}
        currency="XOF"
        editing={editing}
        onCancel={() => {}}
        onSubmit={() => {}}
        onGoToAccounts={vi.fn()}
      />
    </I18nProvider>,
  );

describe('TxModal — transfer destination when accounts are missing', () => {
  it('explains the missing receiving wallet and offers the jump (0 or 1 account)', () => {
    for (const n of [0, 1]) {
      const accounts = Array.from({ length: n }, (_, i) => account(`a${i}`, `C${i}`));
      const html = renderTransferModal(accounts, transferTx('a0'));
      expect(html).toContain('Virements');
      expect(html).toContain('Aucun portefeuille de réception');
      expect(html).toContain('Configurer');
    }
  });

  it('renders the destination select once two accounts exist', () => {
    const html = renderTransferModal(
      [account('a', 'A'), account('b', 'B')],
      transferTx('a', 'b'),
    );
    expect(html).toContain('Vers le compte');
    expect(html).not.toContain('Aucun portefeuille de réception');
    expect(html).not.toContain('Configurer');
  });
});
