/*
 * FECRS verification.
 *
 * Verification is deliberately layered, because a hand-written RS decoder that is
 * merely self-consistent proves nothing:
 *
 *   A. GF(2^8) algebra identities
 *   B. systematic encode: message preserved, all syndromes zero
 *   C. AC3 randomized round trip, clean and with up to t random errors
 *   D. AC4 erasure recovery at the 10% level and up to the full nsym budget
 *   E. errors AND erasures together, within 2e + f <= nsym
 *   F. beyond-capability behaviour: does it ever CLAIM success with wrong data?
 *      (reported as a measured rate, not asserted to be zero - RS can genuinely
 *       mis-correct, which is why a frame CRC is mandatory)
 *   G. INDEPENDENT second decoder - exhaustive position search + GF linear solve,
 *      sharing none of the Berlekamp-Massey / Forney-syndrome logic - cross-checked
 *      against the production decoder on a shortened RS(20,10).
 *
 * On external validation: cross-checking against Python's `reedsolo` was planned,
 * but this machine's Python is the Microsoft Store stub (no output, exit 1) and
 * `pip install reedsolo` cannot run. That is reported rather than glossed over; test
 * G is the independent implementation instead.
 *
 * Usage: node tests/fec-rs.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'fec-rs.js'));
const FECRS = globalThis.FECRS;
const I = FECRS._internal;

let failures = 0, passes = 0;
function check(ok, label, detail) {
  if (ok) passes++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function allZero(a) { for (let i = 0; i < a.length; i++) if (a[i]) return false; return true; }
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ---------------------------------------------------------------- test G helper
/** Exhaustive-search decoder: independent of BM / Forney syndromes. */
function bruteForceDecode(received, k, nsym, erasurePos, maxE) {
  const n = k + nsym;
  const syn = I.syndromes(received, nsym);
  if (allZero(syn)) return { ok: true, msg: received.slice(0, k), positions: [] };
  const free = [];
  for (let i = 0; i < n; i++) if (erasurePos.indexOf(i) < 0) free.push(i);

  let found = null;
  function tryCombo(combo) {
    const positions = erasurePos.concat(combo);
    if (positions.length > nsym) return;
    const mags = I.solveMagnitudes(syn, positions, n);
    if (!mags) return;
    const r2 = Uint8Array.from(received);
    for (let i = 0; i < positions.length; i++) r2[positions[i]] ^= mags[i];
    if (allZero(I.syndromes(r2, nsym))) found = { ok: true, msg: r2.slice(0, k), positions: positions.slice() };
  }
  function choose(start, need, combo) {
    if (found) return;
    if (need === 0) { tryCombo(combo); return; }
    for (let i = start; i <= free.length - need; i++) {
      combo.push(free[i]);
      choose(i + 1, need - 1, combo);
      combo.pop();
      if (found) return;
    }
  }
  for (let e = 0; e <= maxE && !found; e++) choose(0, e, []);
  return found || { ok: false };
}

// ================================================================ tests
console.log('FECRS verification\n');

// ---------------- A. GF algebra ----------------
console.log('=== A. GF(2^8) algebra ===');
{
  let distinct = new Set();
  for (let i = 0; i < 255; i++) distinct.add(I.EXP[i]);
  check(distinct.size === 255, 'EXP table has 255 distinct non-zero values');
  check(I.EXP[255] === 1, 'alpha^255 = 1 (period 255)');
  check(I.LOG[1] === 0, 'log(1) = 0');
  check(FECRS.PRIM === 0x11D && FECRS.FCR === 0, 'parameters match reedsolo defaults (prim 0x11D, fcr 0)');
  let algOk = true, invOk = true;
  for (let a = 1; a < 256; a++) {
    for (let b = 1; b < 256; b += 7) {
      const p = I.gfMul(a, b);
      if (I.gfDiv(p, b) !== a) algOk = false;
    }
    if (I.gfMul(a, I.gfInv(a)) !== 1) invOk = false;
  }
  check(algOk, 'a*b/b = a for all a, sampled b');
  check(invOk, 'a * a^-1 = 1 for all a');
}

// ---------------- B. systematic encode ----------------
console.log('\n=== B. systematic encode ===');
{
  const rnd = mulberry32(1);
  const msg = new Uint8Array(223);
  for (let i = 0; i < msg.length; i++) msg[i] = Math.floor(rnd() * 256);
  const cw = FECRS.encode(msg, 32);
  check(cw.length === 255, 'RS(255,223) codeword length', `${cw.length}`);
  check(eq(cw.slice(0, 223), msg), 'message is systematic (first K bytes unchanged)');
  check(allZero(I.syndromes(cw, 32)), 'encoded codeword has all-zero syndromes');
  check(eq(FECRS.encode(msg, 32), cw), 'encoding is deterministic');
  let threw = false;
  try { FECRS.encode(new Uint8Array(240), 32); } catch (e) { threw = /too long/.test(e.message); }
  check(threw, 'K + nsym > 255 is rejected with a clear error');
}

// ---------------- C. AC3 randomized round trip ----------------
console.log('\n=== C. AC3 randomized round trip ===');
{
  const rnd = mulberry32(7);
  const cases = [[223, 32], [191, 64], [100, 20], [10, 10], [1, 4], [200, 55]];
  let cleanFail = 0, errTrials = 0, errFail = 0;
  for (const [k, nsym] of cases) {
    for (let trial = 0; trial < 12; trial++) {
      const msg = new Uint8Array(k);
      for (let i = 0; i < k; i++) msg[i] = Math.floor(rnd() * 256);
      const cw = FECRS.encode(msg, nsym);
      // clean
      const r0 = FECRS.decode(cw, k, nsym);
      if (!r0.success || !eq(r0.srcBytes, msg)) cleanFail++;
      // inject up to t random errors
      const t = FECRS.maxErrors(nsym);
      const nErr = trial % (t + 1);
      const rx = Uint8Array.from(cw);
      const used = new Set();
      for (let e = 0; e < nErr; e++) {
        let p;
        do { p = Math.floor(rnd() * cw.length); } while (used.has(p));
        used.add(p);
        rx[p] ^= 1 + Math.floor(rnd() * 255);
      }
      const r1 = FECRS.decode(rx, k, nsym);
      errTrials++;
      if (!r1.success || !eq(r1.srcBytes, msg)) errFail++;
    }
  }
  check(cleanFail === 0, 'clean round trip exact for every (K, nsym)', `${cases.length * 12} trials`);
  check(errFail === 0, 'corrects every random error pattern within t = floor(nsym/2)', `${errTrials} trials`);
}

// ---------------- D. AC4 erasures ----------------
console.log('\n=== D. AC4 erasure recovery ===');
{
  const rnd = mulberry32(11);
  const k = 191, nsym = 64, n = k + nsym;
  let fail10 = 0, failMax = 0, trials = 0;
  for (let trial = 0; trial < 20; trial++) {
    const msg = new Uint8Array(k);
    for (let i = 0; i < k; i++) msg[i] = Math.floor(rnd() * 256);
    const cw = FECRS.encode(msg, nsym);

    // 10% of the symbols erased (spec's AC4), damaged AND flagged
    const pct = Math.floor(n * 0.10);
    const rx = Uint8Array.from(cw), er = new Uint8Array(n);
    const pos = new Set();
    while (pos.size < pct) pos.add(Math.floor(rnd() * n));
    for (const p of pos) { rx[p] = Math.floor(rnd() * 256); er[p] = 1; }
    const r1 = FECRS.decode(rx, k, nsym, er);
    trials++;
    if (!r1.success || !eq(r1.srcBytes, msg)) fail10++;

    // full nsym erasure budget, no random errors
    const rx2 = Uint8Array.from(cw), er2 = new Uint8Array(n);
    const pos2 = new Set();
    while (pos2.size < nsym) pos2.add(Math.floor(rnd() * n));
    for (const p of pos2) { rx2[p] = Math.floor(rnd() * 256); er2[p] = 1; }
    const r2 = FECRS.decode(rx2, k, nsym, er2);
    if (!r2.success || !eq(r2.srcBytes, msg)) failMax++;
  }
  check(fail10 === 0, 'AC4: recovers from 10% erased symbols', `${trials} trials, ${Math.floor(n * 0.1)} erasures of ${n}`);
  check(failMax === 0, 'recovers from the full nsym erasure budget', `${nsym} erasures of ${n}`);
}

// ---------------- E. errors + erasures ----------------
console.log('\n=== E. errors AND erasures within 2e + f <= nsym ===');
{
  const rnd = mulberry32(13);
  const k = 191, nsym = 64, n = k + nsym;
  let fail = 0, trials = 0;
  for (let trial = 0; trial < 20; trial++) {
    const msg = new Uint8Array(k);
    for (let i = 0; i < k; i++) msg[i] = Math.floor(rnd() * 256);
    const cw = FECRS.encode(msg, nsym);
    const f = 10 + (trial % 20);
    const e = Math.floor((nsym - f) / 2);
    const rx = Uint8Array.from(cw), er = new Uint8Array(n);
    const used = new Set();
    let placed = 0;
    while (placed < f) { const p = Math.floor(rnd() * n); if (!used.has(p)) { used.add(p); er[p] = 1; rx[p] = Math.floor(rnd() * 256); placed++; } }
    placed = 0;
    while (placed < e) { const p = Math.floor(rnd() * n); if (!used.has(p)) { used.add(p); rx[p] ^= 1 + Math.floor(rnd() * 255); placed++; } }
    const r = FECRS.decode(rx, k, nsym, er);
    trials++;
    if (!r.success || !eq(r.srcBytes, msg)) fail++;
  }
  check(fail === 0, 'mixed errors and erasures decoded exactly', `${trials} trials`);
  // over-budget erasures are rejected up front
  const bigEr = new Uint8Array(n);
  for (let i = 0; i < nsym + 1; i++) bigEr[i] = 1;
  const rb = FECRS.decode(FECRS.encode(new Uint8Array(k), nsym), k, nsym, bigEr);
  check(!rb.success && /more erasures/.test(rb.reason), 'rejects more erasures than parity symbols', rb.reason);
}

// ---------------- F. beyond capability ----------------
console.log('\n=== F. beyond capability: does it ever claim success with WRONG data? ===');
{
  const rnd = mulberry32(17);
  const k = 191, nsym = 64, n = k + nsym;
  const t = FECRS.maxErrors(nsym);
  let claimed = 0, claimedWrong = 0, detected = 0, trials = 400;
  for (let trial = 0; trial < trials; trial++) {
    const msg = new Uint8Array(k);
    for (let i = 0; i < k; i++) msg[i] = Math.floor(rnd() * 256);
    const cw = FECRS.encode(msg, nsym);
    const rx = Uint8Array.from(cw);
    const used = new Set();
    const nErr = t + 1 + Math.floor(rnd() * 4);   // just past the bound
    for (let e = 0; e < nErr; e++) {
      let p; do { p = Math.floor(rnd() * n); } while (used.has(p));
      used.add(p); rx[p] ^= 1 + Math.floor(rnd() * 255);
    }
    const r = FECRS.decode(rx, k, nsym);
    if (r.success) {
      claimed++;
      if (!eq(r.srcBytes, msg)) claimedWrong++;
    } else detected++;
  }
  console.log(`  ${trials} trials with t+1..t+4 errors (t=${t}): detected ${detected}, claimed success ${claimed}, of which WRONG ${claimedWrong}`);
  console.log(`  => silent mis-correction rate ${(100 * claimedWrong / trials).toFixed(1)}% of over-budget frames`);
  check(detected > trials * 0.5, 'the syndrome check rejects most over-budget frames', `${detected}/${trials}`);
  console.log('  NOTE: RS can mis-correct beyond its bound; this is why the frame MUST carry a CRC32.');
}

// ---------------- G. independent decoder cross-check ----------------
console.log('\n=== G. independent cross-check (exhaustive search + linear solve) ===');
{
  const rnd = mulberry32(23);
  const k = 10, nsym = 10, n = k + nsym;   // shortened RS(20,10), t = 5: brute force is cheap
  let agree = 0, disagree = 0, bothFail = 0, trials = 0;
  for (let trial = 0; trial < 120; trial++) {
    const msg = new Uint8Array(k);
    for (let i = 0; i < k; i++) msg[i] = Math.floor(rnd() * 256);
    const cw = FECRS.encode(msg, nsym);
    const rx = Uint8Array.from(cw), er = new Uint8Array(n);
    const used = new Set();
    const f = trial % 3;
    const e = 1 + (trial % 3);
    let placed = 0;
    while (placed < f) { const p = Math.floor(rnd() * n); if (!used.has(p)) { used.add(p); er[p] = 1; rx[p] = Math.floor(rnd() * 256); placed++; } }
    placed = 0;
    while (placed < e) { const p = Math.floor(rnd() * n); if (!used.has(p)) { used.add(p); rx[p] ^= 1 + Math.floor(rnd() * 255); placed++; } }

    const erasePos = [];
    for (let i = 0; i < n; i++) if (er[i]) erasePos.push(i);
    const prod = FECRS.decode(rx, k, nsym, er);
    const bf = bruteForceDecode(rx, k, nsym, erasePos, FECRS.maxErrors(nsym));
    trials++;
    if (prod.success && bf.ok) {
      if (eq(prod.srcBytes, bf.msg)) agree++; else disagree++;
    } else if (!prod.success && !bf.ok) bothFail++;
    else disagree++;
    // and both must equal the original when within the bound
    if (2 * e + f <= nsym) {
      if (!prod.success || !eq(prod.srcBytes, msg)) disagree++;
    }
  }
  check(disagree === 0, 'production decoder agrees with the independent search decoder', `${agree} agree, ${bothFail} both-fail, ${trials} trials`);
}

console.log('\n================================');
console.log(`${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'FECRS VERIFIED' : 'FECRS FAILED');
process.exitCode = failures === 0 ? 0 : 1;
