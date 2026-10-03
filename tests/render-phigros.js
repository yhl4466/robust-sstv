/*
 * Render the phigros S1 recording through the PRODUCTION decoder path and write a PNG.
 *
 * Why this exists: every earlier phigros measurement in this project was taken through a diagnostic
 * that re-derived the colour planes from the decoder's per-line references, so it could not answer
 * "what does the browser actually show?". This calls the same Decode.decode() the browser calls and
 * dumps the resulting RGBA raster, so the picture under discussion is the picture the user sees.
 *
 * Usage: node tests/render-phigros.js [out.png]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'diag-timing', 'phigros-48k-mono.wav');
const OUT = process.argv[2] ? path.resolve(process.argv[2])
  : path.join(__dirname, 'diag-quality', 'phigros-decoded.png');

require(path.join(ROOT, 'js', 'lib', 'fft.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-modes.js'));
require(path.join(ROOT, 'js', 'lib', 'wav.js'));
require(path.join(ROOT, 'js', 'lib', 'sstv-decode.js'));
const Wav = globalThis.SSTVWav, Decode = globalThis.SSTVDecode;

// ---------------------------------------------------------------- minimal PNG writer
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function writePNG(file, width, height, rgba) {
  const raw = Buffer.alloc((width * 3 + 1) * height);
  let p = 0;
  for (let y = 0; y < height; y++) {
    raw[p++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[p++] = rgba[i]; raw[p++] = rgba[i + 1]; raw[p++] = rgba[i + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]));
}

(async function main() {
  if (!fs.existsSync(SRC)) {
    console.log('missing ' + path.relative(ROOT, SRC));
    process.exitCode = 1; return;
  }
  const buf = fs.readFileSync(SRC);
  const info = Wav.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const t0 = Date.now();
  const dec = await Decode.decode(info.samples, info.sampleRate, { quality: 'standard', yieldEvery: 0 });
  const img = dec.imageData || dec;
  console.log('ok=' + dec.ok + '  mode=' + (dec.mode && dec.mode.name) +
    '  ' + img.width + 'x' + img.height + '  (' + ((Date.now() - t0) / 1000).toFixed(1) + ' s)');
  writePNG(OUT, img.width, img.height, img.data);
  console.log('-> ' + path.relative(ROOT, OUT));
})().catch((e) => { console.error(e && e.stack || e); process.exitCode = 1; });
