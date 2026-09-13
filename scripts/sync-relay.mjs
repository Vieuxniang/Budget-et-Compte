// Reference sync relay — the *blind* half of the E2EE sync.
//
// It stores one opaque, versioned blob per channel and knows nothing else: no
// accounts, no names, no amounts, not even which app version wrote a blob. The
// channel id is derived on the client from the sync phrase, so the relay cannot
// relate a channel to a user, and the blob it holds is AES-GCM ciphertext whose
// auth tag also covers the channel and the version (see src/services/sync/crypto.ts).
//
// What it *does* enforce, because a relay is the untrusted component:
//
//   * a channel is claimed by the first token that writes to it (stored only as
//     a SHA-256 hash), so a stranger who guesses a channel id cannot clobber it;
//   * every write must be the exact next version (`If-Match`/`If-None-Match`),
//     so two devices racing cannot overwrite each other — the loser gets 409
//     with the current slot and merges;
//   * a version can never go backwards, so a compromised relay cannot roll a
//     device back to an older snapshot it kept.
//
// Usage:
//   node scripts/sync-relay.mjs [--port 8787] [--dir .freebuff/sync-relay] [--host 127.0.0.1]
//
// Endpoints:
//   GET  /healthz                → { ok, channels }
//   GET  /v1/channels/<id>       → { version, etag, blob }  (0/null/null when empty)
//   PUT  /v1/channels/<id>       → { version, etag }  with If-Match or If-None-Match
//
// Everything is a single JSON file per channel, so the whole relay is auditable
// in one sitting — which is the point of a reference implementation.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const port = Number(process.env.PORT ?? flag('port', 8787));
const host = flag('host', '127.0.0.1');
const dir = flag('dir', '.freebuff/sync-relay');
// The app runs in a browser, so it needs CORS to reach the relay at all. `*` is
// safe here: authorization is a bearer token, never a cookie, so a page can only
// read a channel if it already knows both the derived id and the token — and
// neither is guessable. Narrow it with --allow-origin for a private deployment.
const allowOrigin = flag('allow-origin', '*');
const MAX_BODY = 4 * 1024 * 1024; // a family ledger is orders of magnitude smaller
const CHANNEL_RE = /^[A-Za-z0-9_-]{16,64}$/;

fs.mkdirSync(dir, { recursive: true });

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fileFor = (channelId) => path.join(dir, `${channelId}.json`);
const etagFor = (version) => `r${version}`;

function readChannel(channelId) {
  try {
    const raw = fs.readFileSync(fileFor(channelId), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: Number(parsed.version) || 0,
      etag: typeof parsed.etag === 'string' ? parsed.etag : null,
      blob: parsed.blob ?? null,
      tokenHash: typeof parsed.tokenHash === 'string' ? parsed.tokenHash : null,
    };
  } catch {
    return { version: 0, etag: null, blob: null, tokenHash: null };
  }
}

function writeChannel(channelId, record) {
  fs.writeFileSync(fileFor(channelId), JSON.stringify(record));
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'access-control-allow-origin': allowOrigin,
    'access-control-allow-methods': 'GET,PUT,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,if-match,if-none-match',
    'access-control-max-age': '600',
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('trop volumineux'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  // Preflight (the app sends Authorization + If-Match, so one is always made).
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': allowOrigin,
      'access-control-allow-methods': 'GET,PUT,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type,if-match,if-none-match',
      'access-control-max-age': '600',
    });
    return res.end();
  }

  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const stem = url.pathname;

  if (stem === '/healthz') {
    const channels = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).length;
    return send(res, 200, { ok: true, channels });
  }

  const match = stem.match(/^\/v1\/channels\/([^/]+)$/);
  if (!match) return send(res, 404, { error: 'route inconnue' });

  const channelId = decodeURIComponent(match[1]);
  if (!CHANNEL_RE.test(channelId)) return send(res, 400, { error: 'identifiant de canal invalide' });

  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) return send(res, 401, { error: 'jeton manquant' });

  const existing = readChannel(channelId);
  const tokenHash = sha256(token);
  if (existing.tokenHash && existing.tokenHash !== tokenHash) {
    return send(res, 403, { error: 'canal déjà réclamé par un autre jeton' });
  }
  const publicSlot = { version: existing.version, etag: existing.etag, blob: existing.blob };

  if (req.method === 'GET') {
    return send(res, 200, publicSlot);
  }

  if (req.method === 'PUT') {
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'corps invalide' });
    }
    const version = Number(body?.version);
    const blob = body?.blob;
    if (!Number.isInteger(version) || version < 1 || !blob || typeof blob.iv !== 'string' || typeof blob.ct !== 'string') {
      return send(res, 400, { error: 'blob ou version invalide' });
    }

    const ifMatch = req.headers['if-match'];
    const ifNoneMatch = req.headers['if-none-match'];
    const expectedMatch = typeof ifMatch === 'string' ? ifMatch : null;
    const expectsEmpty = ifNoneMatch === '*';
    // No precondition at all means "overwrite whatever is there": refused, so a
    // buggy or hostile client cannot erase a family's history by accident.
    if (!expectsEmpty && !expectedMatch) {
      return send(res, 428, { error: 'en-tête If-Match ou If-None-Match requis' });
    }

    const staleEnough =
      (expectsEmpty && existing.version !== 0) ||
      (!expectsEmpty && expectedMatch !== existing.etag);
    // A version must always be exactly the next one: no gaps, no rewinds.
    if (staleEnough || version !== existing.version + 1) {
      return send(res, 409, publicSlot);
    }

    const record = { version, etag: etagFor(version), blob, tokenHash };
    writeChannel(channelId, record);
    console.log(`PUT   ${channelId.slice(0, 6)}…  v${version}  ${Buffer.byteLength(blob.ct)} o`);
    return send(res, 200, { version: record.version, etag: record.etag });
  }

  return send(res, 405, { error: 'méthode non autorisée' });
});

server.listen(port, host, () => {
  // Report the port actually bound, so `--port 0` (used by the tests) is usable.
  const address = server.address();
  const bound = typeof address === 'object' && address ? address.port : port;
  console.log(`Relais de synchronisation sur http://${host}:${bound} (données : ${path.resolve(dir)})`);
  console.log('Il ne stocke que des blobs chiffrés — aucun compte, aucun compte à rebours, aucune donnée lisible.');
});
