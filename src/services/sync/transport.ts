/**
 * Transports — how a sealed blob reaches the other devices.
 *
 * The contract is deliberately minimal, so the relay can be replaced by any
 * dumb key/value store (object storage, Supabase, a Worker…) without touching
 * the engine:
 *
 *   pull() → the slot as it stands (version, revision token, ciphertext)
 *   push(expectEtag, version, blob) → accepted, or 409 with the current slot
 *
 * `version` is proposed by the client and must be exactly `current + 1`; the
 * etag is an opaque revision token compared for equality. Together they give
 * optimistic concurrency control: two devices pushing at once cannot overwrite
 * each other, the loser re-merges and retries. Refusals are values, not thrown
 * errors, because a 409 is a normal outcome of a race, not a failure.
 *
 * A network problem *does* throw — the engine turns that into an "offline"
 * status and keeps the pending changes locally.
 */

import type { CipherBlob, PushResult, RemoteSlot, SyncTransport } from './types';

export interface HttpTransportOptions {
  /** Relay base URL (`https://…` or `http://localhost:8787`). */
  url: string;
  channelId: string;
  writeToken: string;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
}

const EMPTY_SLOT: RemoteSlot = { version: 0, etag: null, blob: null };

function isBlob(value: unknown): value is CipherBlob {
  if (!value || typeof value !== 'object') return false;
  const blob = value as Partial<CipherBlob>;
  return blob.v === 1 && typeof blob.iv === 'string' && typeof blob.ct === 'string';
}

function readSlot(body: unknown): RemoteSlot {
  if (!body || typeof body !== 'object') return EMPTY_SLOT;
  const slot = body as Partial<RemoteSlot>;
  const version = typeof slot.version === 'number' && slot.version >= 0 ? slot.version : 0;
  const etag = typeof slot.etag === 'string' ? slot.etag : null;
  return { version, etag, blob: isBlob(slot.blob) ? slot.blob : null };
}

export function httpTransport(options: HttpTransportOptions): SyncTransport {
  const base = options.url.replace(/\/+$/, '');
  const endpoint = `${base}/v1/channels/${encodeURIComponent(options.channelId)}`;
  const doFetch = options.fetchImpl ?? fetch;
  const headers: Record<string, string> = { authorization: `Bearer ${options.writeToken}` };

  return {
    async pull() {
      const response = await doFetch(endpoint, { headers });
      if (!response.ok) throw new Error(`Relais indisponible (${response.status}).`);
      return readSlot(await response.json());
    },

    async push(expectEtag: string | null, version: number, blob: CipherBlob): Promise<PushResult> {
      const response = await doFetch(endpoint, {
        method: 'PUT',
        headers: {
          ...headers,
          'content-type': 'application/json',
          // First write targets an empty channel; later ones must match exactly.
          ...(expectEtag ? { 'if-match': expectEtag } : { 'if-none-match': '*' }),
        },
        body: JSON.stringify({ version, blob }),
      });
      if (response.status === 409) {
        return { ok: false, current: readSlot(await response.json().catch(() => null)) };
      }
      if (!response.ok) throw new Error(`Écriture refusée par le relais (${response.status}).`);
      const body = (await response.json().catch(() => ({}))) as { etag?: unknown };
      return { ok: true, etag: typeof body.etag === 'string' ? body.etag : expectEtag ?? '' };
    },
  };
}

/**
 * In-memory transport — used by the tests to run two devices against one slot,
 * with the same semantics as the relay (version must advance by exactly one,
 * etag must match). `failNext` lets a test simulate a network outage.
 */
export interface MemoryTransport extends SyncTransport {
  slot: RemoteSlot;
  /** Number of pushes and pulls served — assertions on retry behaviour. */
  stats: { pushes: number; pulls: number };
  failNext(times?: number): void;
}

export function memoryTransport(initial: RemoteSlot = EMPTY_SLOT): MemoryTransport {
  let failures = 0;
  const transport: MemoryTransport = {
    slot: { ...initial },
    stats: { pushes: 0, pulls: 0 },
    failNext(times = 1) {
      failures = times;
    },
    async pull() {
      if (failures > 0) {
        failures -= 1;
        throw new Error('réseau indisponible');
      }
      transport.stats.pulls += 1;
      return { ...transport.slot, blob: transport.slot.blob ? { ...transport.slot.blob } : null };
    },
    async push(expectEtag, version, blob) {
      if (failures > 0) {
        failures -= 1;
        throw new Error('réseau indisponible');
      }
      transport.stats.pushes += 1;
      const expected = transport.slot.etag;
      if (expectEtag !== expected) return { ok: false, current: { ...transport.slot } };
      if (version !== transport.slot.version + 1) {
        return { ok: false, current: { ...transport.slot } };
      }
      const etag = `rev-${version}`;
      transport.slot = { version, etag, blob };
      return { ok: true, etag };
    },
  };
  return transport;
}
