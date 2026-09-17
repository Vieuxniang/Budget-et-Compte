import { describe, expect, it } from 'vitest';
import { PLANS } from '../purchase/core.js';
import { handleCheckout, handleStripeWebhook, readiness } from '../purchase/worker.js';

function fakeKV() {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string, type?: string) {
      const value = map.get(key);
      return value === undefined ? null : type === 'json' ? JSON.parse(value) : value;
    },
    async put(key: string, value: string) { map.set(key, value); },
    async list() { return { keys: [], list_complete: true, cursor: '' }; },
  };
}

function response(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
}

async function environment() {
  const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const privateJwk = await crypto.subtle.exportKey('jwk', key.privateKey);
  const orders = fakeKV();
  return {
    env: {
      STRIPE_SECRET_KEY: 'sk_test_checkout',
      STRIPE_WEBHOOK_SECRET: 'whsec_test',
      SITE_URL: 'https://example.com',
      EMAIL_PROVIDER: 'none',
      EMAIL_FROM: 'licences@example.com',
      LICENSE_PRIVATE_JWK: JSON.stringify(privateJwk),
      ORDERS: orders,
    } as any,
    orders,
  };
}

describe('Stripe subscription checkout', () => {
  it('uses catalogue pricing and Stripe subscription mode', async () => {
    const { env, orders } = await environment();
    let requestBody = '';
    const result = await handleCheckout(
      { plan: 'pro-monthly', country: 'SN', email: 'kofi@example.com', amount: 1 },
      env,
      {
        now: new Date('2026-09-12T10:00:00Z'),
        fetchImpl: async (_url: string, init: RequestInit) => {
          requestBody = String(init.body);
          return response({ id: 'cs_test_123', url: 'https://checkout.stripe.com/test' });
        },
      },
    );

    expect(result.status).toBe(201);
    expect(result.body.amount).toBe(PLANS['pro-monthly'].price);
    expect(result.body.paymentUrl).toBe('https://checkout.stripe.com/test');
    expect(requestBody).toContain('mode=subscription');
    expect(requestBody).toContain('line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=500');
    expect(orders.map.size).toBe(1);
  });

  it('rejects unknown plans before contacting Stripe', async () => {
    const { env } = await environment();
    let called = false;
    const result = await handleCheckout({ plan: 'pro', country: 'SN', email: 'kofi@example.com' }, env, {
      fetchImpl: async () => { called = true; return response({}); },
    });
    expect(result.body.error).toBe('plan-not-sellable');
    expect(called).toBe(false);
  });
});

describe('Stripe webhook configuration', () => {
  it('reports required Stripe configuration', () => {
    expect(readiness({ STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'whsec', LICENSE_PRIVATE_JWK: '{}', ORDERS: {}, EMAIL_FROM: 'x@y.z', EMAIL_PROVIDER: 'none' })).toEqual({ ready: true, missing: [] });
  });

  it('ignores events with an invalid signature', async () => {
    const { env } = await environment();
    const request = new Request('https://example.com/api/stripe-webhook', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=bad' },
      body: '{}',
    });
    const result = await handleStripeWebhook(request, env);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe('invalid-signature');
  });
});
