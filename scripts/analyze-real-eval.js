/*
 * Turn scripts/out/eval-real-decode.json into the tables the report needs.
 * Usage: node scripts/analyze-real-eval.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');
const data = JSON.parse(fs.readFileSync(path.join(OUT, 'eval-real-decode.json'), 'utf8'));
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tests', 'fixtures', 'real', 'manifest.json'), 'utf8'));
const meta = {};
for (const s of manifest.samples) meta[s.id] = s;

const CONFIGS = data.configs;
const DEF = 'affine';
const rows = data.results;
const byId = {};
for (const r of rows) (byId[r.id] = byId[r.id] || {})[r.config] = r;

const ids = Object.keys(byId);
const fmt = (v, d) => (v == null || !isFinite(v)) ? '-' : v.toFixed(d == null ? 2 : d);

console.log(`# Decode evaluation analysis (${ids.length} samples x ${CONFIGS.length} configs)\n`);

// ---------------------------------------------------------------- per-sample table
console.log('## Per-sample result under the DEFAULT configuration (affine + clock)\n');
console.log('| id | kind | group | recipe | result | VIS | a | b(Hz) | clock | syncs | mislock | sigmaHF | lag1 | PSNR | ms |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const id of ids) {
  const r = byId[id][DEF], m = meta[id] || {};
  const recipe = (m.recipe || '').replace(/\|/g, '/').slice(0, 46);
  if (!r) { console.log(`| ${id} | ${m.kind} | ${m.group || '-'} | ${recipe} | (missing) | - | - | - | - | - | - | - | - | - | - |`); continue; }
  if (!r.ok) {
    console.log(`| ${id} | ${m.kind} | ${m.group || '-'} | ${recipe} | **FAIL** (${r.stage}) | - | - | - | - | - | - | - | - | - | ${r.ms} |`);
    continue;
  }
  console.log(`| ${id} | ${m.kind} | ${m.group || '-'} | ${recipe} | OK | ${r.vis} | ${fmt(r.a, 5)} | ${fmt(r.b)} | ` +
    `${fmt(r.clockScale, 5)} | ${r.syncs} | ${r.mislockedLines} | ${fmt(r.sigmaHF)} | ${fmt(r.lag1, 3)} | ` +
    `${r.psnr != null ? fmt(r.psnr) + ' dB' : '-'} | ${r.ms} |`);
}

// ---------------------------------------------------------------- failures
console.log('\n## Failures (all configurations)\n');
const failIds = ids.filter((id) => !byId[id][DEF] || !byId[id][DEF].ok);
if (!failIds.length) console.log('  none');
for (const id of failIds) {
  const m = meta[id] || {};
  console.log(`### ${id}  [${m.kind}] group=${m.group || '-'}`);
  console.log(`  recipe: ${m.recipe}`);
  for (const c of CONFIGS) {
    const r = byId[id][c.key];
    console.log(`  ${c.label.padEnd(28)} -> ${r && r.ok ? 'OK ' + (r.psnr != null ? r.psnr.toFixed(2) + ' dB' : '') : 'FAIL stage=' + (r ? r.stage : '?')}` +
      (r && r.message ? `  msg="${r.message.slice(0, 60)}"` : ''));
  }
}

// ---------------------------------------------------------------- group aggregates
console.log('\n## Quality by impairment group (default config)\n');
console.log('| group | n | OK | mean sigmaHF | mean PSNR | mean mislock | mean lag1 |');
console.log('|---|---|---|---|---|---|---|');
const groups = {};
for (const id of ids) {
  const g = (meta[id] && meta[id].group) || (meta[id] && meta[id].kind === 'real' ? 'REAL (untouched)' : '-');
  (groups[g] = groups[g] || []).push(id);
}
const avg = (arr, f) => {
  const v = arr.map(f).filter((x) => x != null && isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
};
for (const g of Object.keys(groups)) {
  const rs = groups[g].map((id) => byId[id][DEF]).filter(Boolean);
  const oks = rs.filter((r) => r.ok);
  console.log(`| ${g} | ${rs.length} | ${oks.length} | ${fmt(avg(oks, (r) => r.sigmaHF))} | ` +
    `${avg(oks, (r) => r.psnr) != null ? fmt(avg(oks, (r) => r.psnr)) + ' dB' : '-'} | ` +
    `${fmt(avg(oks, (r) => r.mislockedLines), 1)} | ${fmt(avg(oks, (r) => r.lag1), 3)} |`);
}

// ---------------------------------------------------------------- config comparison
console.log('\n## Configuration comparison (AC3)\n');
console.log('| config | OK | mean sigmaHF | mean PSNR | delta PSNR vs raw |');
console.log('|---|---|---|---|---|');
const rawPsnr = avg(rows.filter((r) => r.config === 'raw' && r.ok), (r) => r.psnr);
for (const c of CONFIGS) {
  const rs = rows.filter((r) => r.config === c.key);
  const oks = rs.filter((r) => r.ok);
  const mp = avg(oks, (r) => r.psnr);
  console.log(`| ${c.label} | ${oks.length}/${rs.length} | ${fmt(avg(oks, (r) => r.sigmaHF))} | ` +
    `${mp != null ? fmt(mp) + ' dB' : '-'} | ${mp != null && rawPsnr != null ? (mp - rawPsnr >= 0 ? '+' : '') + (mp - rawPsnr).toFixed(3) + ' dB' : '-'} |`);
}

// ---------------------------------------------------------------- where AFC/clock SHOULD matter
console.log('\n## Cases where AFC / clock recovery is supposed to matter\n');
console.log('| id | a (raw vs affine) | b | clockScale | PSNR raw -> default | sigmaHF raw -> default |');
console.log('|---|---|---|---|---|---|');
for (const id of ids) {
  const m = meta[id] || {};
  if (!/clock|rate/i.test(m.group || '')) continue;
  const raw = byId[id].raw, def = byId[id][DEF];
  if (!raw || !raw.ok || !def || !def.ok) { console.log(`| ${id} | - | - | - | FAIL | FAIL |`); continue; }
  console.log(`| ${id} | ${fmt(raw.a, 5)} vs ${fmt(def.a, 5)} | ${fmt(def.b)} | ${fmt(def.clockScale, 5)} | ` +
    `${raw.psnr != null ? fmt(raw.psnr) : '-'} -> ${def.psnr != null ? fmt(def.psnr) : '-'} dB | ` +
    `${fmt(raw.sigmaHF)} -> ${fmt(def.sigmaHF)} |`);
}

// ---------------------------------------------------------------- ranking
console.log('\n## Samples ranked by no-reference quality (default config, worst first)\n');
const ranked = ids.map((id) => ({ id, r: byId[id][DEF], m: meta[id] || {} }))
  .filter((x) => x.r && x.r.ok)
  .sort((a, b) => (b.r.sigmaHF - a.r.sigmaHF));
console.log('| id | group | sigmaHF | lag1 | PSNR |');
console.log('|---|---|---|---|---|');
for (const x of ranked) {
  console.log(`| ${x.id} | ${x.m.group || '-'} | ${fmt(x.r.sigmaHF)} | ${fmt(x.r.lag1, 3)} | ${x.r.psnr != null ? fmt(x.r.psnr) + ' dB' : '-'} |`);
}
