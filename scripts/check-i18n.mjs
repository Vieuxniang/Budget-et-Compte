// Verifies that every i18n key referenced in src/ exists in the fr, en and es
// dictionaries. Run: node scripts/check-i18n.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const ts = fs.readFileSync(path.join(root, 'src/i18n/translations.ts'), 'utf8');

const extract = (body) => {
  const d = {};
  const re = /'([\w.]+)':\s*["']/g;
  let m;
  while ((m = re.exec(body))) d[m[1]] = true;
  return d;
};

const fr = extract(ts.split('export const en')[0]);
const en = extract(ts.split('export const en')[1].split('export const es')[0]);
const es = extract(ts.split('export const es')[1].split('export const DICTIONARIES')[0]);

// All source files (excluding the i18n module itself and test files).
const files = [];
const walk = (dir) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.includes('.test.')) files.push(p);
  }
};
walk(path.join(root, 'src'));

const used = new Set();
const dynamicPrefixes = new Set();
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const re = /\bt\('([\w.]+)'/g;
  let m;
  while ((m = re.exec(text))) used.add(m[1]);
  // Dynamic template keys: t(`meta.${x}`), t(`currencies.${x}`), t(`months.${n}`)
  const re2 = /\bt\(`([\w.]+)\$\{/g;
  while ((m = re2.exec(text))) dynamicPrefixes.add(m[1]);
}

// A dynamic prefix like `meta.` counts every key under that namespace as used.
for (const prefix of dynamicPrefixes) {
  for (const k of Object.keys(fr)) if (k.startsWith(prefix)) used.add(k);
}

// Variable-key call sites: t(labelKey) over data-driven key lists, and
// t(accountTypeLabelKey(type)) which yields meta.* keys.
const allSrc = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
if (allSrc.includes('t(labelKey)')) {
  for (const k of Object.keys(fr)) if (k.startsWith('app.tab.') || k.startsWith('settings.security.autoLock.')) used.add(k);
}
if (allSrc.includes('accountTypeLabelKey')) {
  for (const k of Object.keys(fr)) if (k.startsWith('meta.')) used.add(k);
}

const missing = [...used].filter((k) => !fr[k] || !en[k] || !es[k]);
const unused = Object.keys(fr).filter((k) => !used.has(k));

console.log(`keys used: ${used.size} · defined fr: ${Object.keys(fr).length} / en: ${Object.keys(en).length} / es: ${Object.keys(es).length}`);
let ok = true;
if (missing.length) {
  ok = false;
  console.log('MISSING from at least one dict:', missing.join(', '));
}
if (unused.length) {
  ok = false;
  console.log('UNUSED keys:', unused.join(', '));
}
if (ok) console.log('All keys present in fr/en/es; no unused keys.');
process.exit(ok ? 0 : 1);