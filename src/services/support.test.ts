/**
 * Support-link tests.
 *
 * `SUPPORT_EMAIL` is read from `VITE_SUPPORT_EMAIL` **at module load**, so each
 * case stubs the variable (or leaves it unset for the default) and re-imports
 * the module — the only honest way to cover the configured and unconfigured
 * builds in one process (same pattern as `shop.test.ts`).
 *
 * The guarantee under test: a wronged buyer always gets a working one-tap
 * contact by default, a deployment can repoint it without a code change, and an
 * explicitly empty address produces *nothing* rather than a broken link.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

async function withSupport(email?: string) {
  if (email !== undefined) vi.stubEnv('VITE_SUPPORT_EMAIL', email);
  vi.resetModules();
  return import('./support');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('with no build override', () => {
  it('defaults to the publisher inbox with a working mailto link', async () => {
    const support = await withSupport();
    expect(support.hasSupport()).toBe(true);
    expect(support.SUPPORT_EMAIL).toBe('vieuxn33@gmail.com');
    expect(support.supportLink('Clé résiliée — lic_x')).toBe(
      'mailto:vieuxn33@gmail.com?subject=Cl%C3%A9%20r%C3%A9sili%C3%A9e%20%E2%80%94%20lic_x',
    );
  });
});

describe('with a build override', () => {
  it('repoints the inbox without a code change', async () => {
    const support = await withSupport('  support@budgetetcompte.ci  ');
    expect(support.SUPPORT_EMAIL).toBe('support@budgetetcompte.ci');
    expect(support.supportLink('Revoked key')).toBe(
      'mailto:support@budgetetcompte.ci?subject=Revoked%20key',
    );
  });
});

describe('with an explicitly empty override', () => {
  it('reports no support and produces no link', async () => {
    const support = await withSupport('');
    expect(support.hasSupport()).toBe(false);
    expect(support.SUPPORT_EMAIL).toBe('');
    expect(support.supportLink('anything')).toBe('');
  });
});
