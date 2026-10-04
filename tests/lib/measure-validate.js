/*
 * A minimal harness for validating MEASUREMENT tools against known ground truth.
 *
 * WHY THIS EXISTS
 *   Phase 49 lost most of a session to three measurement failures, not to decoder failures:
 *
 *     1. a dominant-frequency window read a 1200 Hz sync at +100..150 Hz off, but the same procedure
 *        read +94 Hz on a synthetic signal whose true offset is 0.000 Hz - a bias of the same size as
 *        the effect it was reporting;
 *     2. a long-window spectrum reported up to +395 Hz, and its own control read +22.5 Hz on a
 *        known-zero signal;
 *     3. tests/verify-freqshift.js contained a "reference" implementation that shifted nothing at all
 *        (frequency-domain bookkeeping error) and was used to judge a correct implementation.
 *
 *   In each case the tool produced plausible numbers and the control experiment is what exposed it. The
 *   lesson is that a measurement tool needs the same treatment the impairment MODELS got in
 *   tests/model-selftest.js: a synthetic case with a known answer, checked against the tool, before any
 *   real-world number it produces is believed.
 *
 * WHAT IT DOES
 *   `validate(name, cases, opts)` runs a measurement function over synthetic inputs of KNOWN frequency
 *   and reports measured vs expected with an error, a bias and a spread. It returns a verdict, and a
 *   failed verdict means the tool must not be used for that purpose - which is the whole point: a tool
 *   that cannot measure a signal it was built by is not evidence about a signal it was not.
 *
 *   The scale matters for interpreting the result: a tool whose bias is 20 Hz cannot measure a 30 Hz
 *   effect, and `usableFor(effectHz)` states that explicitly rather than leaving it to the reader.
 *
 * Usage (as a library):
 *   const { makeTone, validate } = require('./lib/measure-validate');
 *   const v = validate('my tone finder', [1200, 1500, 1900].map(makeTone), (x) => myFinder(x));
 *   v.report();
 */
'use strict';

const SR = 48000;

/**
 * A pure windowed tone. `len` sets the duration the measurement tool will see, so the tool's own
 * resolution limits are exercised rather than hidden by an unfairly long input.
 */
function makeTone(freq, len, opts) {
  const o = opts || {};
  const sr = o.sampleRate || SR;
  const amp = o.amp == null ? 0.5 : o.amp;
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    x[i] = amp * Math.sin(2 * Math.PI * freq * i / sr + (o.phase || 0));
  }
  if (o.noiseDb != null) {
    // deterministic LCG, so a validation run is reproducible
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    const noiseAmp = amp * Math.pow(10, -o.noiseDb / 20);
    for (let i = 0; i < len; i++) x[i] += noiseAmp * rnd();
  }
  return x;
}

/** Two tones at once, for tools that must resolve a component near a stronger neighbour. */
function makeTwoTones(f1, f2, len, opts) {
  const o = opts || {};
  const sr = o.sampleRate || SR;
  const x = new Float32Array(len);
  const a1 = o.amp1 == null ? 0.5 : o.amp1;
  const a2 = o.amp2 == null ? 0.5 : o.amp2;
  for (let i = 0; i < len; i++) {
    x[i] = a1 * Math.sin(2 * Math.PI * f1 * i / sr) + a2 * Math.sin(2 * Math.PI * f2 * i / sr);
  }
  return x;
}

/** Median and MAD, the two robust statistics every report here uses. */
function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}
function mad(a, med) {
  if (!a.length) return null;
  const m = med == null ? median(a) : med;
  const s = a.map((v) => Math.abs(v - m)).sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
}

/**
 * Run a measurement tool over known-truth inputs and judge it.
 *
 * @param {string} name            tool name, for the report
 * @param {Array}  cases           each {signal, truth} - one measurement per case
 * @param {function} measure       (signal, truth) -> number, the tool's reading
 * @param {object} [opts]          {toleranceHz, repeats, notes}
 * @returns {{rows, bias, spread, maxAbsErr, verdict, report}}
 *   `verdict` is 'pass' when every case is inside tolerance. `bias` is the median signed error, and it
 *   is the number that decides whether the tool can be used for a given effect size - a 20 Hz bias means
 *   any claim smaller than ~40 Hz is unsupported no matter how many samples were averaged.
 */
function validate(name, cases, measure, opts) {
  const o = opts || {};
  const tol = o.toleranceHz == null ? 1 : o.toleranceHz;
  const repeats = o.repeats || 1;
  const rows = [];
  for (const c of cases) {
    const errs = [];
    for (let r = 0; r < repeats; r++) {
      if (!(c.truth > 0)) throw new Error('validate: every case needs a numeric truth');
      errs.push(measure(c.signal, c.truth) - c.truth);
    }
    rows.push({ truth: c.truth, measured: c.truth + median(errs), error: median(errs),
      spread: errs.length > 1 ? mad(errs) : 0, label: c.label });
  }
  const errors = rows.map((r) => r.error);
  const b = median(errors);
  const sp = mad(errors, b);
  const maxAbsErr = Math.max.apply(null, errors.map(Math.abs));
  const within = errors.filter((e) => Math.abs(e) <= tol).length;
  const verdict = within === rows.length ? 'pass' : 'fail';
  return {
    name: name, rows: rows, bias: b, spread: sp, maxAbsErr: maxAbsErr,
    toleranceHz: tol, casesWithinTolerance: within, caseCount: rows.length,
    verdict: verdict,
    /** Can this tool support a claim about an effect of `effectHz`? Requires bias and spread well below. */
    usableFor: function (effectHz, factor) {
      const f = factor == null ? 3 : factor;
      const lim = Math.max(Math.abs(b), sp) * f;
      return { usable: effectHz > lim, limitHz: lim,
        reason: effectHz > lim
          ? 'ok'
          : 'effect ' + effectHz + ' Hz is within ' + f + 'x the tool\'s own error (' +
            lim.toFixed(2) + ' Hz)' };
    },
    report: function () {
      const lines = [];
      lines.push('  ' + name + '  [' + verdict.toUpperCase() + ']  容差 +/-' + tol + ' Hz');
      for (const r of rows) {
        lines.push('    真值 ' + String(r.truth).padStart(8) + ' Hz → 读数 ' +
          r.measured.toFixed(2).padStart(9) + ' Hz · 误差 ' + r.error.toFixed(3).padStart(8) +
          ' Hz · 离散 ' + r.spread.toFixed(3).padStart(7) + (r.label ? '   ' + r.label : ''));
      }
      lines.push('    偏置(中位) ' + b.toFixed(3) + ' Hz · MAD ' + sp.toFixed(3) +
        ' Hz · 最大绝对误差 ' + maxAbsErr.toFixed(3) + ' Hz · 通过 ' + within + '/' + rows.length);
      return lines.join('\n');
    }
  };
}

/** Sum of several verdicts, for a one-line summary at the end of a diagnostic script. */
function summarise(results) {
  const bad = results.filter((r) => r.verdict !== 'pass');
  if (!bad.length) return '测量工具校验: 全部通过 (' + results.length + ' 项)';
  return '测量工具校验: ' + bad.length + '/' + results.length + ' 项未通过 → ' +
    bad.map((r) => r.name).join(', ') + ' 的结论不可用';
}

/**
 * Contamination cases: the target tone with a strong neighbour nearby.
 *
 * This is the tier that matters for SSTV, and the tier that was missing. Every method validated here
 * passed the clean-tone test except the crudest, yet two of them disagreed by 200 Hz on the real
 * recording. The reason is structural: in an SSTV line the 1200 Hz sync is IMMEDIATELY followed by the
 * porch and then the scan, so any window long enough to resolve the sync also contains image content.
 * A method that reads a clean tone perfectly can still be pulled by a neighbour 100-200 Hz away, and a
 * clean-tone control cannot detect that.
 *
 * `spacingHz` is how far the interferer sits from the target, `ampRatio` its amplitude relative to the
 * target's. The default pair (150 Hz, equal amplitude) is roughly what the porch and the start of a
 * bright scan present.
 */
function makeContaminated(freq, len, opts) {
  const o = opts || {};
  const spacing = o.spacingHz == null ? 150 : o.spacingHz;
  const ratio = o.ampRatio == null ? 1.0 : o.ampRatio;
  const dir = o.above === false ? -1 : 1;
  return makeTwoTones(freq, freq + dir * spacing, len,
    { amp1: 0.5, amp2: 0.5 * ratio });
}

module.exports = exports = {
  SR: SR, makeTone: makeTone, makeTwoTones: makeTwoTones,
  makeContaminated: makeContaminated, median: median, mad: mad,
  validate: validate, summarise: summarise
};
