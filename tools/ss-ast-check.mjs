// Semantic equivalence checker: compares normalized ASTs (acorn) of two
// .mjs/.js trees, ignoring formatting (tsc's printer canonicalizes indentation
// and line breaks) and trailing no-op `export {}`. For refactoring verification:
//   node tools/ss-ast-check.mjs <baselineDir> <currentDir>
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as acorn from 'acorn';

const baseline = process.argv[2];
const target = process.argv[3];
if (!baseline || !target) { console.error('usage: node ss-mig-ast.mjs <baselineDir> <scriptsDir>'); process.exit(2); }

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(mjs|js)$/.test(f)) out.push(p);
  }
  return out;
}

// Normalization: strip source positions and raw lexemes (formatting),
// keeping only AST structure and values.
const STRIP = new Set(['start', 'end', 'loc', 'range', 'raw', 'cooked']);
function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) {
      if (STRIP.has(k)) continue;
      out[k] = normalize(node[k]);
    }
    return out;
  }
  return node;
}

function parse(src, file) {
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', preserveParens: false });
  // `export {}` is a no-op module marker emitted by tsc for files without
  // exports; semantically empty, so strip it from comparison.
  ast.body = ast.body.filter(n => !(n.type === 'ExportNamedDeclaration' && !n.declaration && n.specifiers.length === 0 && !n.source));
  return ast;
}

let pass = 0, fail = 0, missing = 0;
const failures = [];
for (const bp of walk(baseline)) {
  const rel = relative(baseline, bp);
  const tp = join(target, rel);
  if (!existsSync(tp)) { missing++; console.log('MISS ' + rel); continue; }
  let a, b;
  try { a = normalize(parse(readFileSync(bp, 'utf8'), bp)); } catch (e) { fail++; failures.push([rel, 'baseline parse: ' + e.message]); continue; }
  try { b = normalize(parse(readFileSync(tp, 'utf8'), tp)); } catch (e) { fail++; failures.push([rel, 'EMITTED parse: ' + e.message]); continue; }
  const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja === jb) pass++;
  else {
    fail++;
    // Find the first point of divergence for a readable diff report
    let i = 0; const n = Math.min(ja.length, jb.length);
    while (i < n && ja[i] === jb[i]) i++;
    failures.push([rel, `first divergence at json offset ${i}:\n  BASE: ...${ja.slice(Math.max(0, i - 80), i + 80)}...\n  EMIT: ...${jb.slice(Math.max(0, i - 80), i + 80)}...`]);
  }
}
console.log(`AST-equivalent: ${pass}`);
console.log(`AST-DIFF: ${fail}`);
console.log(`MISSING: ${missing}`);
for (const [f, msg] of failures) console.log(`\n[${f}]\n${msg}`);
process.exit(fail || missing ? 1 : 0);
