/* France's French Press — separation orchestrator: chunks the song, runs the DSP stages on a
 * pool of workers and overlap-adds the results into the stem buffers.
 * SPDX-License-Identifier: GPL-3.0-or-later  Copyright (C) 2026 Josh Wilk */
var ENGINE = (function () {
  'use strict';
  var D = (typeof DSP !== 'undefined') ? DSP : require('./dsp.js');

  var STEM_SETS = {
    2: ['vocals', 'instrumental'],
    4: ['vocals', 'drums', 'bass', 'other'],
    5: ['vocals', 'drums', 'bass', 'other', 'ambience']
  };

  function addInto(dst, src, start) {
    var n = dst.length, a = Math.max(0, -start), b = Math.min(src.length, n - start);
    for (var i = a; i < b; i++) dst[start + i] += src[i];
  }
  function slice(x, a, b) { // zero-padded copy of x[a..b)
    var out = new Float32Array(b - a), s = Math.max(0, a), e = Math.min(x.length, b);
    if (e > s) out.set(x.subarray(s, e), s - a);
    return out;
  }

  // pool: {run(op, job) -> Promise(result), size}
  // alloc(name) -> [Float32Array L, Float32Array R] of song length, zero-filled
  async function separate(L, R, sr, params, pool, alloc, onProgress, isCancelled) {
    var p = Object.assign({}, D.DEFAULTS, params || {});
    var len = L.length, sz = D.sizes(sr), names = STEM_SETS[p.stems] || STEM_SETS[4];
    var out = {}; names.forEach(function (n) { out[n] = alloc(n); });
    var prog = function (stage, frac) { if (onProgress) onProgress(stage, frac); };
    var check = function () { if (isCancelled && isCancelled()) throw new Error('cancelled'); };
    var t0 = Date.now(), timing = {};

    // ---- Stage A: drums ----
    var NA = sz.aN, HA = sz.aH, TA = D.nFrames(len, NA, HA), CA = 384, MA = 40;
    var drums = (p.stems === 2) ? [new Float32Array(len), new Float32Array(len)] : out.drums;
    var jobsA = [];
    for (var f0 = 0; f0 < TA; f0 += CA) {
      var f1 = Math.min(TA, f0 + CA), fa = Math.max(0, f0 - MA), fb = Math.min(TA, f1 + MA);
      jobsA.push({ f0: f0, f1: f1, fa: fa, fb: fb });
    }
    var doneA = 0;
    await runAll(pool, jobsA.map(function (j) {
      return function () {
        check();
        var s0 = j.fa * HA - NA, s1 = (j.fb - 1) * HA;
        var job = { L: slice(L, s0, s1 + NA), R: slice(R, s0, s1 + NA), segStart: s0, sr: sr, f0: j.f0, f1: j.f1, fa: j.fa, fb: j.fb, p: p, N: NA, H: HA };
        return pool.run('A', job).then(function (res) {
          addInto(drums[0], res.L, res.start); addInto(drums[1], res.R, res.start);
          prog('Pressing out the drums', ++doneA / jobsA.length);
        });
      };
    }));
    timing.drums = Date.now() - t0;

    // residual (song without drums) — computed lazily per chunk
    function residual(a, b) {
      var oL = slice(L, a, b), oR = slice(R, a, b), dL = slice(drums[0], a, b), dR = slice(drums[1], a, b);
      for (var i = 0; i < oL.length; i++) { oL[i] -= dL[i]; oR[i] -= dR[i]; }
      return [oL, oR];
    }

    // ---- Stage B pass 1: magnitudes + pitch salience ----
    var NB = sz.bN, HB = sz.bH, TB = D.nFrames(len, NB, HB), nb = NB / 2 + 1, CB1 = 256;
    var V = new Uint16Array(TB * nb), salV = new Float32Array(TB * D.NCAND), salB = new Float32Array(TB * D.NCAND), bands = null, nbands = 0;
    var maxC = 0, maxB = 0, jobsB1 = [], doneB1 = 0;
    for (f0 = 0; f0 < TB; f0 += CB1) jobsB1.push({ f0: f0, f1: Math.min(TB, f0 + CB1) });
    await runAll(pool, jobsB1.map(function (j) {
      return function () {
        check();
        var s0 = j.f0 * HB - NB, s1 = (j.f1 - 1) * HB + NB, rs = residual(s0, s1);
        return pool.run('B1', { L: rs[0], R: rs[1], segStart: s0, sr: sr, f0: j.f0, f1: j.f1, p: p, N: NB, H: HB }).then(function (res) {
          V.set(res.V, j.f0 * nb); salV.set(res.salV, j.f0 * D.NCAND); salB.set(res.salB, j.f0 * D.NCAND);
          if (!bands) { nbands = res.nbands; bands = new Float32Array(TB * nbands); }
          bands.set(res.bands, j.f0 * nbands);
          maxC = Math.max(maxC, res.maxC); maxB = Math.max(maxB, res.maxB);
          prog('Listening for the melody', ++doneB1 / jobsB1.length);
        });
      };
    }));
    timing.listen = Date.now() - t0 - timing.drums;

    // ---- global analysis ----
    check();
    prog('Following the singer and the bass line', 0);
    var per = p.rep > 0 ? D.estimatePeriod(bands, nbands, TB, sr, HB) : 0;
    var f0V = p.mel > 0 ? D.viterbi(salV, TB, 1 / Math.pow(maxC + 1e-20, p.salPow), p.voicePct, 80) : new Float32Array(TB);
    await tick();
    var f0B = p.bmel > 0 && p.stems !== 2 ? D.viterbi(salB, TB, 1 / Math.pow(maxB + 1e-20, p.salPow), p.bassVoicePct, 30) : new Float32Array(TB);
    salV = salB = null;
    prog('Following the singer and the bass line', 1);

    // ---- Stage B pass 2: masks + synthesis ----
    var CB2 = 160, MB = 4, jobsB2 = [], doneB2 = 0, K = p.repK;
    for (f0 = 0; f0 < TB; f0 += CB2) {
      var e = Math.min(TB, f0 + CB2);
      jobsB2.push({ f0: f0, f1: e, fa: Math.max(0, f0 - MB), fb: Math.min(TB, e + MB) });
    }
    var targets = p.stems === 2 ? [out.vocals] : (p.stems === 5 ? [out.vocals, out.bass, out.ambience] : [out.vocals, out.bass]);
    var restT = p.stems === 2 ? out.instrumental : out.other;
    await runAll(pool, jobsB2.map(function (j) {
      return function () {
        check();
        var s0 = j.fa * HB - NB, s1 = (j.fb - 1) * HB + NB, rs = residual(s0, s1);
        var va = per > 0 ? Math.max(0, j.fa - K * per) : j.fa, vb = per > 0 ? Math.min(TB, j.fb + K * per) : j.fa;
        var Vs = per > 0 ? V.slice(va * nb, vb * nb) : null;
        var job = { L: rs[0], R: rs[1], segStart: s0, sr: sr, f0: j.f0, f1: j.f1, fa: j.fa, fb: j.fb, p: p, N: NB, H: HB,
          V: Vs, va: va, per: per, f0V: f0V.slice(j.fa, j.fb), f0B: f0B.slice(j.fa, j.fb), T: TB };
        return pool.run('B2', job).then(function (res) {
          for (var s = 0; s < targets.length; s++) { addInto(targets[s][0], res.outs[2 * s], res.start); addInto(targets[s][1], res.outs[2 * s + 1], res.start); }
          var r = res.outs.length - 2; addInto(restT[0], res.outs[r], res.start); addInto(restT[1], res.outs[r + 1], res.start);
          prog('Separating the layers', ++doneB2 / jobsB2.length);
        });
      };
    }));
    if (p.stems === 2) { for (var i = 0; i < len; i++) { out.instrumental[0][i] += drums[0][i]; out.instrumental[1][i] += drums[1][i]; } }
    timing.total = Date.now() - t0;

    // voicing summary for the report
    var voiced = 0; for (i = 0; i < TB; i++) if (f0V[i] > 0) voiced++;
    return { stems: out, names: names, period: per ? per * HB / sr : 0, timing: timing, voicedFrac: voiced / TB, f0V: f0V, frameHop: HB / sr };
  }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  // run thunks with at most pool.size in flight
  function runAll(pool, thunks) {
    return new Promise(function (resolve, reject) {
      var next = 0, active = 0, failed = false;
      function launch() {
        if (failed) return;
        if (next >= thunks.length && active === 0) return resolve();
        while (active < pool.size && next < thunks.length) {
          var th = thunks[next++]; active++;
          Promise.resolve().then(th).then(function () { active--; launch(); }, function (e) { failed = true; reject(e); });
        }
      }
      launch();
    });
  }

  // a pool that runs in-process (Node tests, or fallback)
  function localPool() { return { size: 1, run: function (op, job) { return new Promise(function (res, rej) { setTimeout(function () { try { res(D.handle({ op: op, job: job })); } catch (e) { rej(e); } }, 0); }); } }; }

  return { separate: separate, STEM_SETS: STEM_SETS, runAll: runAll, localPool: localPool };
})();
if (typeof module !== 'undefined') module.exports = ENGINE;
