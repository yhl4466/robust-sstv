/*
 * Phase-5 tests for the secret-image codec and the image frame (AC1/AC2/AC7/AC8).
 *
 * Usage: node tests/image-codec.test.js
 */
'use strict';
const path = require('path');
const Codec = require(path.join(__dirname, '..', 'js', 'image-codec.js'));

let pass = 0, fail = 0;
function ok(cond, label, detail) {
  if (cond) { pass++; console.log('  OK   ' + label + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '   ' + detail : '')); }
}
const DATA_BUDGET = 200;   // 215 B payload - 15 B image header

/** Deterministic pseudo-natural grey test image (photo-like gradients + texture). */
function makeImage(w, h, seed) {
  let a = seed >>> 0;
  const rnd = () => { a = (a * 1103515245 + 12345) & 0x7fffffff; return a / 0x7fffffff; };
  const d = new Uint8ClampedArray(w * h * 4);
  // low-frequency field
  const f = new Float64Array(w * h);
  for (let k = 0; k < 18; k++) {
    const cx = rnd() * w, cy = rnd() * h, rad = 8 + rnd() * Math.max(w, h) * 0.5, amp = (rnd() - 0.5) * 120;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dd = Math.hypot(x - cx, y - cy);
      if (dd < rad) f[y * w + x] += amp * (1 - dd / rad);
    }
  }
  for (let i = 0; i < w * h; i++) {
    const v = Math.max(0, Math.min(255, Math.round(128 + f[i] + (rnd() - 0.5) * 10)));
    d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = v; d[i * 4 + 3] = 255;
  }
  return { data: d, width: w, height: h };
}

console.log('=== image codec / frame tests ===\n');

// ---------------------------------------------------------------- bit packing
console.log('[A] sub-byte bit packing round trip');
for (const bpp of [1, 2, 3, 4, 6, 8]) {
  const n = 37;
  const vals = new Uint8Array(n);
  for (let i = 0; i < n; i++) vals[i] = i % (1 << bpp);
  const packed = Codec.packBits(vals, bpp);
  const back = Codec.unpackBits(packed, n, bpp);
  let same = true;
  for (let i = 0; i < n; i++) if (back[i] !== vals[i]) { same = false; break; }
  ok(same, `bpp=${bpp} pack/unpack exact`, `${packed.length} B for ${n} samples`);
}
ok(Codec.qimgSize(20, 16, 4) === 160, 'analytic size 20x16@4bpp = 160 B', String(Codec.qimgSize(20, 16, 4)));
ok(Codec.qimgSize(32, 26, 1) === 104, 'analytic size 32x26@1bpp = 104 B', String(Codec.qimgSize(32, 26, 1)));

// ---------------------------------------------------------------- frame round trip
console.log('\n[B] image frame round trip (AC2)');
{
  const img = makeImage(64, 51, 7);
  const sel = Codec.chooseBest(img, { dataBudget: DATA_BUDGET });
  ok(sel.ok, 'chooseBest returns a candidate for a 64x51 source');
  const frame = Codec.encodeImageFrame(sel.best.gray, { bpp: sel.best.bpp, dither: true, autoScaled: sel.best.autoScaled, maxDataBytes: DATA_BUDGET, levels: sel.best.levels });
  ok(frame.ok, 'encodeImageFrame succeeds', `${frame.meta.W}x${frame.meta.H} ${frame.meta.bpp}bpp ${frame.meta.frameBytes} B`);
  ok(frame.bytes.length <= 215, 'frame fits the 215 B payload', frame.bytes.length + ' B');
  ok(frame.bytes[0] === 0x49 && frame.bytes[1] === 0x53, 'magic is 0x49 0x53 ("IS")');
  ok(frame.bytes[2] === 1, 'version byte = 1');

  const dec = Codec.decodeImageFrame(frame.bytes);
  ok(dec.ok, 'decodeImageFrame succeeds', dec.ok ? `${dec.meta.W}x${dec.meta.H}` : dec.reason);
  ok(dec.ok && dec.meta.W === frame.meta.W && dec.meta.H === frame.meta.H, 'dimensions survive');
  ok(dec.ok && dec.meta.bpp === frame.meta.bpp, 'bpp survives');
  ok(dec.ok && dec.meta.dither === true, 'dither flag survives');
  /*
   * Correct invariant: decode(encode(x)) reproduces the QUANTIZED plane exactly - i.e. it
   * equals dequantize(quantize(x)). It is NOT equal to an arbitrary pre-dequantized input,
   * because re-quantizing a dequantized plane is not idempotent once dithering is applied.
   * That is exactly why encodeImageFrame accepts a pre-quantized `levels` plane.
   */
  let exact = dec.ok;
  if (exact) for (let i = 0; i < dec.gray.data.length; i++) if (dec.gray.data[i] !== sel.best.gray.data[i]) { exact = false; break; }
  ok(exact, 'decoded grey plane equals the previewed plane (levels passed through)');

  // corruption must be caught by the header CRC
  const bad = Uint8Array.from(frame.bytes);
  bad[8] = (bad[8] ^ 0x30) & 0xFF;                 // flip the bpp/flag nibble
  const decBad = Codec.decodeImageFrame(bad);
  ok(!decBad.ok && /CRC/.test(decBad.reason), 'a flipped header byte is rejected by the header CRC', decBad.reason);

  const badMagic = Uint8Array.from(frame.bytes); badMagic[0] = 0x00;
  ok(!Codec.decodeImageFrame(badMagic).ok, 'a bad magic is rejected');

  const trunc = frame.bytes.subarray(0, Codec.HEADER_BYTES + 3);
  ok(!Codec.decodeImageFrame(trunc).ok, 'a truncated frame is rejected');
}

// ---------------------------------------------------------------- per-bpp exactness
console.log('\n[C] every (size, bpp) combination round-trips exactly');
let combos = 0, comboOk = 0;
for (const bpp of [1, 2, 4, 6, 8]) {
  for (const [w, h] of [[16, 13], [20, 16], [24, 19], [32, 26]]) {
    const size = Codec.qimgSize(w, h, bpp);
    if (size > DATA_BUDGET) continue;
    combos++;
    const g = Codec.toGray(makeImage(w * 3, h * 3, 100 + w + bpp));
    const scaled = Codec.resizeGray(g, w, h);
    const q = Codec.quantize(scaled, bpp, true);
    const back = Codec.dequantize(q, bpp);
    const fr = Codec.encodeImageFrame(back, { bpp, dither: true, maxDataBytes: DATA_BUDGET, levels: q.data });
    const de = Codec.decodeImageFrame(fr.bytes);
    let same = de.ok;
    if (same) for (let i = 0; i < back.data.length; i++) if (de.gray.data[i] !== back.data[i]) { same = false; break; }
    if (same) comboOk++;
  }
}
ok(comboOk === combos, `all ${combos} (size,bpp) combinations byte-exact`, `${comboOk}/${combos}`);

// ---------------------------------------------------------------- selection
console.log('\n[D] automatic sizing (AC7)');
{
  const img = makeImage(256, 256, 3);
  const sel = Codec.chooseBest(img, { dataBudget: DATA_BUDGET });
  ok(sel.ok, '256x256 is accepted (auto-scaled)');
  ok(sel.ok && sel.best.autoScaled, 'autoResized flag is set for 256x256');
  ok(sel.ok && sel.best.dataBytes <= DATA_BUDGET, 'chosen candidate fits the budget', sel.ok ? `${sel.best.w}x${sel.best.h} ${sel.best.bpp}bpp ${sel.best.dataBytes} B` : '');
  ok(sel.ok && sel.best.w < 256, 'chosen size is smaller than the source', sel.ok ? sel.best.w + 'x' + sel.best.h : '');
  const top = sel.candidates.slice(0, 5).map((c) => `${c.w}x${c.h}@${c.bpp}bpp ${c.psnr.toFixed(1)}dB`);
  console.log('       top candidates: ' + top.join(' | '));
}
{
  // a large but square image must still work
  const img = makeImage(512, 512, 9);
  const sel = Codec.chooseBest(img, { dataBudget: DATA_BUDGET });
  ok(sel.ok, '512x512 with autoScale enabled is accepted (auto-scaled)', sel.ok ? `${sel.best.w}x${sel.best.h}` : sel.reason);
}
{
  // without auto-scaling the same input must be refused, with a clear message
  const img = makeImage(512, 512, 9);
  const sel = Codec.chooseBest(img, { dataBudget: DATA_BUDGET, autoScale: false });
  ok(!sel.ok, '512x512 with autoScale disabled is refused (AC8)');
  ok(!sel.ok && /过大|无法嵌入/.test(sel.reason), 'the refusal message is explicit', sel && sel.reason);
}
{
  // extreme aspect ratio: a genuine geometric impossibility
  const img = makeImage(512, 4, 11);
  const sel = Codec.chooseBest(img, { dataBudget: DATA_BUDGET, minSide: 8 });
  ok(!sel.ok, 'extreme aspect ratio (512x4) is refused', sel.reason ? sel.reason.slice(0, 70) : '');
}

// ---------------------------------------------------------------- determinism
console.log('\n[E] determinism');
{
  const img = makeImage(40, 32, 5);
  const a = Codec.chooseBest(img, { dataBudget: DATA_BUDGET });
  const b = Codec.chooseBest(img, { dataBudget: DATA_BUDGET });
  ok(a.ok && b.ok && a.best.w === b.best.w && a.best.h === b.best.h && a.best.bpp === b.best.bpp,
    'chooseBest is deterministic', a.ok ? `${a.best.w}x${a.best.h}@${a.best.bpp}` : '');
  const fa = Codec.encodeImageFrame(a.best.gray, { bpp: a.best.bpp, dither: true });
  const fb = Codec.encodeImageFrame(b.best.gray, { bpp: b.best.bpp, dither: true });
  let same = fa.ok && fb.ok && fa.bytes.length === fb.bytes.length;
  if (same) for (let i = 0; i < fa.bytes.length; i++) if (fa.bytes[i] !== fb.bytes[i]) { same = false; break; }
  ok(same, 'frame encoding is deterministic');
}

// ---------------------------------------------------------------- grey conversion
console.log('\n[F] colour handling');
{
  const d = new Uint8ClampedArray(4 * 3 * 4);
  for (let i = 0; i < 3; i++) {
    const o = i * 4;
    d[o] = 255; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 255;          // pure red
  }
  const g = Codec.toGray({ data: d, width: 3, height: 1 });
  ok(g.data[0] === 76, 'pure red -> grey 76 (0.299*255)', String(g.data[0]));
}

console.log('\n================================');
console.log(`${pass} passed, ${fail} failed`);
console.log(fail === 0 ? 'IMAGECODEC VERIFIED' : 'IMAGECODEC FAILED');
process.exitCode = fail === 0 ? 0 : 1;
