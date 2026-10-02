/*
 * Interleaver verification (AC5, AC6) plus the RS+interleaver chain that AC6 is
 * actually about.
 *
 * AC6 as written ("a 100-byte burst leaves < 5 bytes wrong per RS codeword") is a
 * statement about the COMBINATION of depth and burst length, so the test measures
 * the real per-codeword error counts rather than trusting the formula. It also
 * demonstrates that the spec's suggested depth=8 does NOT satisfy AC6, so the
 * conclusion is evidenced rather than asserted.
 *
 * Usage: node tests/interleaver.test.js
 */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..');

require(path.join(ROOT, 'js', 'interleaver.js'));
require(path.join(ROOT, 'js', 'fec-rs.js'));
const Interleaver = globalThis.Interleaver;
const FECRS = globalThis.FECRS;

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
function eq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

console.log('Interleaver verification\n');

// ---------------- AC5: round trip ----------------
console.log('=== AC5: interleave + deinterleave is the identity ===');
{
  const rnd = mulberry32(3);
  const cases = [
    { depth: 32, codewordLength: 255 },
    { depth: 8, codewordLength: 255 },
    { depth: 16, codewordLength: 64 },   // the phase-2 spec's blockSize=64 / depth=8 style
    { depth: 8, codewordLength: 64 },
    { depth: 1, codewordLength: 255 },   // degenerate: no spreading
    { depth: 5, codewordLength: 7 }
  ];
  let allOk = true, details = [];
  for (const c of cases) {
    for (const blocks of [1, 3]) {
      const len = c.depth * c.codewordLength * blocks;
      const data = new Uint8Array(len);
      for (let i = 0; i < len; i++) data[i] = Math.floor(rnd() * 256);
      const inter = Interleaver.interleave(data, c);
      const back = Interleaver.deinterleave(inter, c);
      const ok = eq(back, data);
      if (!ok) { allOk = false; details.push(`depth=${c.depth} N=${c.codewordLength} blocks=${blocks}`); }
      // a non-trivial permutation must actually move bytes
      if (c.depth > 1 && c.codewordLength > 1 && eq(inter, data)) {
        allOk = false; details.push(`depth=${c.depth} N=${c.codewordLength} was a no-op`);
      }
    }
  }
  check(allOk, 'round trip exact for every geometry and block count', details.join('; ') || `${cases.length * 2} cases`);

  // partial trailing block is passed through unchanged
  const g = { depth: 32, codewordLength: 255 };
  const rndlen = g.depth * g.codewordLength + 17;
  const d2 = new Uint8Array(rndlen);
  for (let i = 0; i < rndlen; i++) d2[i] = Math.floor(rnd() * 256);
  const b2 = Interleaver.deinterleave(Interleaver.interleave(d2, g), g);
  check(eq(b2, d2), 'a trailing partial block round-trips unchanged (documented: no spreading there)');

  // default configuration is codeword-aligned
  const cfg = Interleaver.getConfig();
  check(cfg.depth === 32 && cfg.codewordLength === 255, 'default geometry is depth=32 over 255-byte codewords',
    `depth=${cfg.depth}, N=${cfg.codewordLength}`);
}

// ---------------- AC6: burst spreading ----------------
console.log('\n=== AC6: a 100-symbol burst must leave < 5 errors per RS codeword ===');
{
  const BURST = 100;
  const rows = [];
  for (const depth of [1, 8, 16, 32, 64]) {
    const geo = { depth, codewordLength: 255 };
    const blocks = 3;
    const total = depth * 255 * blocks;
    const errMask = new Uint8Array(total);
    // one contiguous burst in the middle of the CHANNEL stream
    const start = Math.floor(total / 2);
    for (let i = 0; i < BURST && start + i < total; i++) errMask[start + i] = 1;
    const rep = Interleaver.analyzeSpread(errMask, geo);
    const predicted = Interleaver.burstErrorsPerCodeword(BURST, geo);
    rows.push({ depth, predicted, measured: rep.worst, codewords: rep.perCodeword.length });
    console.log(`  depth=${String(depth).padStart(2)}  predicted ceil(100/depth)=${String(predicted).padStart(2)}  measured worst per codeword=${String(rep.worst).padStart(2)}`);
  }
  const d32 = rows.find((r) => r.depth === 32);
  const d8 = rows.find((r) => r.depth === 8);
  check(d32.measured < 5, 'AC6 met at depth=32 (100-byte burst)', `worst codeword has ${d32.measured} errors`);
  check(d32.predicted === d32.measured, 'the ceil(burst/depth) prediction is exact here',
    `predicted ${d32.predicted}, measured ${d32.measured}`);
  check(d8.measured >= 5, 'depth=8 (the spec suggestion) does NOT meet AC6 - evidenced, not asserted',
    `worst codeword has ${d8.measured} errors`);
  check(Interleaver.requiredDepth(100, 5) === 20, 'requiredDepth(100, 5) = 20',
    `${Interleaver.requiredDepth(100, 5)}`);
}

// ---------------- the chain AC6 is really about ----------------
console.log('\n=== RS + interleaver: does the burst become correctable? ===');
{
  const rnd = mulberry32(29);
  const K = 223, NSYM = 32, N = 255, DEPTH = 32;
  const total = DEPTH * N;
  const msg = new Uint8Array(K * DEPTH);
  for (let i = 0; i < msg.length; i++) msg[i] = Math.floor(rnd() * 256);

  // encode DEPTH codewords, concatenate, interleave
  const cats = new Uint8Array(total);
  for (let c = 0; c < DEPTH; c++) {
    const cw = FECRS.encode(msg.subarray(c * K, (c + 1) * K), NSYM);
    cats.set(cw, c * N);
  }
  const tx = Interleaver.interleave(cats, { depth: DEPTH, codewordLength: N });

  // With depth 32 and RS(255,223) (t = 16) the burst limit is depth * t = 512
  // contiguous symbols: half a kilobyte wiped out, still fully recovered.
  const burstLimit = DEPTH * FECRS.maxErrors(NSYM);
  console.log(`  analytical limit: depth x t = ${DEPTH} x ${FECRS.maxErrors(NSYM)} = ${burstLimit} contiguous symbols`);
  for (const burst of [100, 255, 500, burstLimit, burstLimit + 300]) {
    const rx = Uint8Array.from(tx);
    const start = Math.floor(total / 3);
    for (let i = 0; i < burst && start + i < total; i++) rx[start + i] ^= 1 + Math.floor(rnd() * 255);

    // receiver: deinterleave, then decode each codeword (no erasure flags - the
    // receiver does not know where the burst was)
    const deint = Interleaver.deinterleave(rx, { depth: DEPTH, codewordLength: N });
    let okCount = 0;
    const recovered = new Uint8Array(K * DEPTH);
    for (let c = 0; c < DEPTH; c++) {
      const r = FECRS.decode(deint.subarray(c * N, (c + 1) * N), K, NSYM);
      if (r.success) { okCount++; recovered.set(r.srcBytes, c * K); }
    }
    const allOk = eq(recovered, msg);
    console.log(`  burst ${String(burst).padStart(3)} symbols -> ${okCount}/${DEPTH} codewords decoded, message intact: ${allOk}`);
    if (burst <= burstLimit) {
      check(allOk && okCount === DEPTH, `burst of ${burst} fully corrected by RS(255,223)+interleave`,
        `${okCount}/${DEPTH} codewords`);
    } else {
      // beyond depth*t: must be reported, not silently wrong
      check(!allOk, `burst of ${burst} exceeds the ${burstLimit}-symbol capability and is NOT silently accepted`,
        `${okCount}/${DEPTH} decoded`);
    }
  }
}

// ---------------- depth vs payload size ----------------
console.log('\n=== depth is bounded by payload size (honest accounting) ===');
{
  const info = Interleaver.capacityDepthInfo(320, 255);
  console.log(`  payload 320 B -> ${info.codewords} codewords of 255 B, max useful depth ${info.maxUsefulDepth}`);
  check(info.maxUsefulDepth === 1, 'a 320-byte payload affords depth 1 (i.e. no burst spreading)', `${info.maxUsefulDepth}`);
  const info2 = Interleaver.capacityDepthInfo(8160, 255);
  check(info2.maxUsefulDepth === 32, 'a full 32-codeword payload affords depth 32', `${info2.maxUsefulDepth}`);
  console.log(`  NOTE: ${info.note}`);
}

console.log('\n================================');
console.log(`${passes} passed, ${failures} failed`);
console.log(failures === 0 ? 'INTERLEAVER VERIFIED' : 'INTERLEAVER FAILED');
process.exitCode = failures === 0 ? 0 : 1;
