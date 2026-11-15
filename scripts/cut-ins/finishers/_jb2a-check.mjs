/**
 * Dev-only check: verifies ALL jb2a.* paths referenced in finisher choreographies
 * against the REAL installed JB2A database (the Sequencer DB is a plain JS object).
 *
 *   node scripts/cut-ins/finishers/_jb2a-check.mjs .
 *
 * root is the showstopper module root; the database is loaded from
 * <root>/../jb2a_patreon/scripts/jb2a_sequencer.js. Unknown paths are printed
 * as MISSING; if jb2a_patreon is not installed, the check is skipped (not an error).
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';

const root = resolve(process.cwd(), process.argv[2] ?? '.');
const dbFile = resolve(root, '../jb2a_patreon/scripts/jb2a_sequencer.js');

if (!existsSync(dbFile)) {
  console.log('jb2a_patreon not found — skip jb2a check');
  process.exit(0);
}

const { jb2aPatreonDatabase, patreonDatabase } = await import(pathToFileURL(dbFile).href);
await jb2aPatreonDatabase('modules');

const flat = [];
(function walk(obj, pre) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (k.startsWith('_')) continue;
    if (typeof v === 'string') flat.push(pre + k);
    else if (v && typeof v === 'object') walk(v, pre + k + '.');
  }
})(patreonDatabase, 'jb2a.');
console.log('JB2A DB keys:', flat.length);

// Collect all jb2a.* string literals from finisher source files
const files = [];
(function scan(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) scan(p);
    else if (p.endsWith('.mjs') && !p.includes('_smoke') && !p.includes('_jb2a-check')) files.push(p);
  }
})(join(root, 'scripts/cut-ins/finishers'));
(function scanPlus(dir) {
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) scanPlus(p);
    else if (p.endsWith('.mjs')) files.push(p);
  }
})(join(root, 'plus/scripts/cut-ins/finishers'));

const used = new Map();
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/'(jb2a\.[a-z0-9_.]+)'/g)) {
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(f.split(/[\\/]/).pop());
  }
}
console.log('Used jb2a paths:', used.size);

let missing = 0;
for (const [p, fs] of [...used].sort()) {
  const node = p.slice(5).split('.').reduce((o, k) => (o && typeof o === 'object') ? o[k] : undefined, patreonDatabase);
  if (node === undefined || node === null) {
    missing++;
    console.log(`MISSING: ${p}  (${[...new Set(fs)].join(',')})`);
  }
}
if (missing) {
  console.error(`\n${missing} jb2a paths NOT in the installed JB2A database`);
  process.exit(1);
}
console.log('\nJB2A PATHS ALL OK');
