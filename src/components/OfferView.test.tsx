/**
 * OfferView's support path.
 *
 * No jsdom in the project: the component is rendered with react-dom/server and
 * the test observes the real markup. The asynchronous revoked flow itself is
 * proven end to end at the real surface (.freebuff/run.md documents the
 * procedure); what must hold *everywhere*, including a server render, is the
 * negative guard — a buyer who has not been refused a key never sees a support
 * block.
 */
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '../i18n';
import { OfferView } from './OfferView';

const render = () =>
  renderToStaticMarkup(
    <I18nProvider language="fr" onLanguageChange={() => {}}>
      <OfferView />
    </I18nProvider>,
  );

describe('OfferView — support contact', () => {
  it('shows no support block while checking or on the free plan', () => {
    const html = render();
    expect(html).toContain('Offre gratuite');
    expect(html).not.toContain('support@');
    expect(html).not.toContain('mailto:');
  });
});
