#!/usr/bin/env node
// CPU profile of the built app in a real Chrome — one command for any
// performance regression:
//
//   npm run profile                       # build (with sourcemaps), serve dist/,
//                                         # profile a fresh load, print the table
//   npm run profile -- --url http://127.0.0.1:4174/   # profile an already-running server
//   npm run profile -- --out .freebuff/profile.json   # also save the raw trace
//   npm run profile -- --slices 1000,2500             # busy-ms table at custom marks
//
// Method (the one that produced the Intl.NumberFormat find and the deferred-
// startup A/B): a real Chrome-for-Testing load under 4x CPU throttle, the CDP
// `Profiler` domain started before navigation (samples, unlike the trace
// profiler's CPU category), service worker bypassed so the profiled bytes are
// the ones just built, and self-time resolved through sourcemaps to ORIGINAL
// function names — minified `qg @ index-*.js:1:88213` is not a finding,
// `detectCurrency @ services/currency.ts` is. The busy-ms-by-window table is
// the honest A/B metric: total busy is dominated by idle time, and cross-run
// machine load makes raw totals incomparable; cumulative busy within a fixed
// window from load is not.
//
// Prereqs: CHROME_PATH pointing at a Chrome binary (any recent Chrome works,
// e.g. `npx @puppeteer/browsers install chrome@stable --path /tmp/cft`);
// build artifacts in dist/ unless --url is given.
import puppeteer from 'puppeteer-core';
import { SourceMapConsumer } from 'source-map';
import { spawn, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

// --- CLI -------------------------------------------------------------------

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const urlArg = flag('--url');
const outPath = flag('--out') ?? '.freebuff/profile.json';
const slices = (flag('--slices') ?? '1000,2500,5000').split(',').map(Number);
const throttle = Number(flag('--throttle') ?? 4);
const settleMs = Number(flag('--settle') ?? 1500);

const chromePath = process.env.CHROME_PATH;
if (!chromePath || !existsSync(chromePath)) {
  console.error(`CHROME_PATH must point at a Chrome binary (got: ${chromePath ?? 'unset'}).`);
  console.error('  npx @puppeteer/browsers install chrome@stable --path /tmp/cft');
  process.exit(1);
}

// --- Build + serve dist/ (skipped when --url targets a running server) ------

let server = null;
let baseUrl = urlArg;

if (!baseUrl) {
  execSync('npm run build -- --sourcemap', { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = 4175;
  // Bind 127.0.0.1 explicitly: `vite preview` defaults to `localhost`, which
  // Node 17+ resolves to ::1 first — then 127.0.0.1 refuses connections.
  server = spawn('npx', ['vite', 'preview', '--port', String(port), '--strictPort', '--host', '127.0.0.1'], {
    stdio: 'ignore',
  });
  baseUrl = `http://127.0.0.1:${port}/`;
  // Wait for the server to answer.
  for (let i = 0; i < 40; i += 1) {
    try {
      const res = await fetch(baseUrl);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

const entryScript = readdirSync('dist/assets').find((f) => /^index-.*\.js$/.test(f));
if (!entryScript) {
  console.error('dist/assets/index-*.js not found — run a build first.');
  process.exit(1);
}
const sourceDir = resolve('dist');

// --- Load maps -------------------------------------------------------------

// Node ships a sourceMappingURL-agnostic consumer; feed it every map Vite
// emitted. Builds without --sourcemap still profile — names just stay minified.
const maps = new Map(); // generated file basename -> SourceMapConsumer
const collectMaps = (dir) => {
  for (const entry of readdirSync(dir)) {
    const p = resolve(dir, entry);
    if (statSync(p).isDirectory()) collectMaps(p);
    else if (entry.endsWith('.map')) maps.set(entry, null); // lazy-loaded below
  }
};
if (existsSync('dist/assets')) collectMaps('dist/assets');
const mapCount = maps.size;

async function resolveName(url, line1based, col1based) {
  const base = url.split('/').pop() ?? '';
  const mapName = `${base}.map`;
  if (!maps.has(mapName)) return null;
  let consumer = maps.get(mapName);
  if (!consumer) {
    consumer = await new SourceMapConsumer(readFileSync(resolve('dist/assets', mapName), 'utf8'));
    maps.set(mapName, consumer);
  }
  const pos = consumer.originalPositionFor({
    line: line1based,
    column: col1based - 1,
    bias: SourceMapConsumer.LEAST_UPPER_BOUND,
  });
  if (!pos || !pos.source) return null;
  const src = pos.source.replace(/^.*\/src\//, 'src/');
  const fn = pos.name ? `${pos.name} @ ${src}:${pos.line}` : `@ ${src}:${pos.line}`;
  return fn;
}

// --- Profile ---------------------------------------------------------------

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--no-first-run', '--no-default-browser-check'],
  userDataDir: `/tmp/bc-profile-${Date.now()}`,
});
const page = await browser.newPage();
const client = await page.target().createCDPSession();
await client.send('Emulation.setCPUThrottlingRate', { rate: throttle });
await client.send('Network.setBypassServiceWorker', { bypass: true });

await client.send('Profiler.enable');
await client.send('Profiler.setSamplingInterval', { interval: 100 }); // µs
await client.send('Profiler.start');

await page.goto(baseUrl, { waitUntil: 'networkidle0' });
await new Promise((r) => setTimeout(r, settleMs));

const { profile } = await client.send('Profiler.stop');
await browser.close();
server?.kill();

// --- Aggregate -------------------------------------------------------------

const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
const selfUsByNode = new Map();
let t = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i] ?? 0;
  t += dt;
  selfUsByNode.set(profile.samples[i], (selfUsByNode.get(profile.samples[i]) ?? 0) + dt);
}

// Self-time per (url, function) — the main table.
const selfByFn = new Map(); // key -> { us, urls }
for (const [id, us] of selfUsByNode) {
  const cf = nodes.get(id)?.callFrame;
  if (!cf) continue;
  const fn = cf.functionName || '(anonymous)';
  const key = `${fn} @ ${cf.url ? cf.url.split('/').pop() : '(program)'}`;
  const cur = selfByFn.get(key) ?? { us: 0, cf };
  cur.us += us;
  selfByFn.set(key, cur);
}

// Busy (non-idle) time in fixed windows from load — the A/B metric.
let cumBusy = 0;
const busyAt = new Map(slices.map((s) => [s, 0]));
let tt = 0;
for (let i = 0; i < profile.samples.length; i += 1) {
  const dt = profile.timeDeltas[i] ?? 0;
  const cf = nodes.get(profile.samples[i])?.callFrame;
  const isIdle = !cf || cf.functionName === '(idle)';
  tt += dt;
  for (const s of slices) {
    if (tt <= s * 1000 && !isIdle) busyAt.set(s, (busyAt.get(s) ?? 0) + dt);
  }
  if (!isIdle) cumBusy += dt;
}

const durMs = t / 1000;
const busyMs = cumBusy / 1000;

console.log(`\nCPU profile — fresh load of ${baseUrl}`);
console.log(`throttle ${throttle}x · window ${Math.round(durMs)} ms · busy ${Math.round(busyMs)} ms (${Math.round((busyMs / durMs) * 100)}%) · ${mapCount} sourcemaps loaded\n`);

const rows = [...selfByFn.entries()]
  .filter(([k]) => !k.startsWith('(idle)'))
  .sort((a, b) => b[1].us - a[1].us)
  .slice(0, 15);

console.log('Top self-time (original names where sourcemaps allow):');
for (const [key, { us }] of rows) {
  const [fn, file] = key.split(' @ ');
  if (file?.startsWith('index-')) {
    // Resolve through the sourcemap: cf has line/column of the generated code.
    const { cf } = selfByFn.get(key);
    const resolved = await resolveName(cf.url, (cf.lineNumber ?? 0) + 1, (cf.columnNumber ?? 0) + 1);
    if (resolved) {
      console.log(`  ${String(Math.round(us / 1000)).padStart(6)} ms  ${resolved}`);
      continue;
    }
  }
  console.log(`  ${String(Math.round(us / 1000)).padStart(6)} ms  ${key}`);
}

console.log('\nBusy ms within fixed windows from load (the A/B-comparable metric):');
for (const s of slices) console.log(`  first ${String(s).padStart(5)} ms: ${Math.round((busyAt.get(s) ?? 0) / 1000)} ms busy`);

if (outPath) {
  writeFileSync(outPath, JSON.stringify(profile));
  console.log(`\nraw profile saved: ${outPath}`);
}
