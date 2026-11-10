/* France's French Press — separation DSP core. No machine learning: spectral masks from
 * harmonic/percussive median filtering, a kick transient detector, stereo
 * panning and inter-channel coherence, repetition (adaptive REPET) and
 * predominant-pitch harmonic combs for the lead and the bass line.
 * Masks always sum to one, so the stems add back up to the original exactly.
 * SPDX-License-Identifier: GPL-3.0-or-later  Copyright (C) 2026 Josh Wilk */
var DSP = (function () {
  'use strict';

  // ---------- FFT (complex, radix-2, in place) ----------
  var fftCache = {};
  function getFFT(n) {
    if (fftCache[n]) return fftCache[n];
    var bits = Math.round(Math.log2(n)), rev = new Uint32Array(n);
    for (var i = 0; i < n; i++) { var r = 0, x = i; for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    var cs = new Float64Array(n / 2), sn = new Float64Array(n / 2);
    for (i = 0; i < n / 2; i++) { cs[i] = Math.cos(2 * Math.PI * i / n); sn[i] = Math.sin(2 * Math.PI * i / n); }
    return (fftCache[n] = { n: n, rev: rev, cs: cs, sn: sn });
  }
  function fft(F, re, im, inverse) {
    var n = F.n, rev = F.rev, cs = F.cs, sn = F.sn, i, j, t;
    for (i = 0; i < n; i++) { j = rev[i]; if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    var sg = inverse ? 1 : -1;
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var start = 0; start < n; start += size) {
        for (var k = 0, ti = 0; k < half; k++, ti += step) {
          var a = start + k, b = a + half;
          var wr = cs[ti], wi = sg * sn[ti];
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
    if (inverse) { var s = 1 / n; for (i = 0; i < n; i++) { re[i] *= s; im[i] *= s; } }
  }

  var winCache = {};
  function sqrtHann(N) {
    if (winCache[N]) return winCache[N];
    var w = new Float64Array(N);
    for (var i = 0; i < N; i++) w[i] = Math.sqrt(0.5 - 0.5 * Math.cos(2 * Math.PI * i / N));
    return (winCache[N] = w);
  }

  // Analyse two real channels with one complex FFT. seg* = samples, segStart = x-index of seg[0].
  // Frame k starts at x-index k*H - N (so the signal is fully covered with N of padding each side).
  function Analyzer(N) {
    this.N = N; this.nb = N / 2 + 1; this.F = getFFT(N); this.w = sqrtHann(N);
    this.re = new Float64Array(N); this.im = new Float64Array(N);
  }
  Analyzer.prototype.frame = function (L, R, segStart, x0, outL, outR, off) {
    // outL/outR: Float32Array, interleaved [re,im] per bin at offset off (2*nb floats)
    var N = this.N, w = this.w, re = this.re, im = this.im, len = L.length;
    for (var j = 0; j < N; j++) {
      var s = x0 + j - segStart;
      if (s >= 0 && s < len) { re[j] = L[s] * w[j]; im[j] = R[s] * w[j]; } else { re[j] = 0; im[j] = 0; }
    }
    fft(this.F, re, im, false);
    var nb = this.nb;
    for (var k = 0; k < nb; k++) {
      var nk = k === 0 ? 0 : N - k;
      var a = re[k], b = im[k], c = re[nk], d = im[nk];
      outL[off + 2 * k] = (a + c) * 0.5; outL[off + 2 * k + 1] = (b - d) * 0.5;
      outR[off + 2 * k] = (b + d) * 0.5; outR[off + 2 * k + 1] = (c - a) * 0.5;
    }
  };
  // Synthesize masked spectra of both channels; overlap-add into oL/oR (x-index oStart). Normalised for H=N/4.
  Analyzer.prototype.synth = function (XL, XR, off, mask, moff, x0, oL, oR, oStart) {
    var N = this.N, nb = this.nb, re = this.re, im = this.im, w = this.w;
    for (var k = 0; k < nb; k++) {
      var m = mask[moff + k];
      var lr = XL[off + 2 * k] * m, li = XL[off + 2 * k + 1] * m, rr = XR[off + 2 * k] * m, ri = XR[off + 2 * k + 1] * m;
      re[k] = lr - ri; im[k] = li + rr;
      if (k > 0 && k < nb - 1) { re[N - k] = lr + ri; im[N - k] = -li + rr; }
    }
    fft(this.F, re, im, true);
    var len = oL.length;
    for (var j = 0; j < N; j++) {
      var s = x0 + j - oStart;
      if (s >= 0 && s < len) { var g = w[j] * 0.5; oL[s] += re[j] * g; oR[s] += im[j] * g; }
    }
  };

  // ---------- sliding median along a strided line (window shrinks at the edges) ----------
  function medianLine(src, dst, count, stride, offset, k) {
    var h = k >> 1, buf = new Float64Array(k + 1), len = 0, i;
    function ins(v) { var lo = 0, hi = len; while (lo < hi) { var mid = (lo + hi) >> 1; if (buf[mid] < v) lo = mid + 1; else hi = mid; } buf.copyWithin(lo + 1, lo, len); buf[lo] = v; len++; }
    function rem(v) { var lo = 0, hi = len; while (lo < hi) { var mid = (lo + hi) >> 1; if (buf[mid] < v) lo = mid + 1; else hi = mid; } buf.copyWithin(lo, lo + 1, len); len--; }
    for (i = 0; i < Math.min(h, count); i++) ins(src[offset + i * stride]);
    for (i = 0; i < count; i++) {
      var inI = i + h; if (inI < count) ins(src[offset + inI * stride]);
      var outI = i - h - 1; if (outI >= 0) rem(src[offset + outI * stride]);
      dst[offset + i * stride] = (len & 1) ? buf[len >> 1] : 0.5 * (buf[(len >> 1) - 1] + buf[len >> 1]);
    }
  }
  function minmaxLine(src, dst, count, stride, offset, k, isMax) {
    var h = k >> 1;
    for (var i = 0; i < count; i++) {
      var a = Math.max(0, i - h), b = Math.min(count - 1, i + h), v = src[offset + a * stride];
      for (var j = a + 1; j <= b; j++) { var x = src[offset + j * stride]; if (isMax ? x > v : x < v) v = x; }
      dst[offset + i * stride] = v;
    }
  }
  function odd(x) { x = Math.max(1, Math.round(x)); return x | 1; }

  // ---------- parameters ----------
  var DEFAULTS = {
    stems: 4,
    // stage A (drums)
    aTk: 0.20, aTkLow: 0.40, aFk: 400, beta: 1.5, kick: 1.0, kickLen: 0.16, kickHi: 200,
    // stage B
    width: 0.25, vocalPan: 0, phaseK: 2, ambience: 1.0, ambG: 2,
    bassFc: 250, vlo: 160, vhi: 14000, rep: 0.3, repK: 2,
    mel: 0.7, melW: 0.015, melWidth: 0.6, salPow: 0.75, hDecay: 0.85,
    bmel: 0.6, bassTop: 1200, bassNh: 12, bassW: 0.02,
    voicePct: 35, bassVoicePct: 20, smooth: 1
  };
  function sizes(sr) {
    var scale = sr > 64000 ? 2 : 1;
    return { aN: 2048 * scale, aH: 512 * scale, bN: 4096 * scale, bH: 1024 * scale };
  }
  function nFrames(len, N, H) { return Math.ceil((len + N) / H) + 1; }

  // ---------- Stage A: drums (HPSS + kick transient capture) ----------
  // job: {L,R (segment), segStart, sr, f0, f1 (core frames), fa, fb (analysed frames), p, N, H}
  function stageA(job) {
    var p = job.p, N = job.N, H = job.H, sr = job.sr, nb = N / 2 + 1, an = new Analyzer(N);
    var fa = job.fa, fb = job.fb, F = fb - fa;
    var XL = new Float32Array(F * nb * 2), XR = new Float32Array(F * nb * 2), M = new Float32Array(F * nb);
    var t, k;
    for (t = 0; t < F; t++) {
      an.frame(job.L, job.R, job.segStart, (fa + t) * H - N, XL, XR, t * nb * 2);
      for (k = 0; k < nb; k++) {
        var o = t * nb * 2 + 2 * k;
        M[t * nb + k] = Math.sqrt((XL[o] * XL[o] + XL[o + 1] * XL[o + 1] + XR[o] * XR[o] + XR[o + 1] * XR[o + 1]) * 0.5);
      }
    }
    var fr = sr / H, df = sr / N;
    var ks = odd(p.aTk * fr), kl = odd(p.aTkLow * fr), kf = odd(p.aFk / df);
    var Hm = new Float32Array(F * nb), Hl = new Float32Array(F * nb), Pm = new Float32Array(F * nb);
    var lowTop = Math.min(nb, Math.ceil(250 / df) + 1);
    for (k = 0; k < nb; k++) { medianLine(M, Hm, F, nb, k, ks); if (k < lowTop) medianLine(M, Hl, F, nb, k, kl); }
    for (t = 0; t < F; t++) medianLine(M, Pm, nb, 1, t * nb, kf);
    var mask = new Float32Array(F * nb), beta = p.beta;
    for (t = 0; t < F; t++) for (k = 0; k < nb; k++) {
      var i = t * nb + k, f = k * df, lm = Math.min(1, Math.max(0, (250 - f) / 100));
      var h = Hm[i] * (1 - lm) + (lm > 0 ? Hl[i] * lm : 0), pp = Pm[i];
      mask[i] = pp * pp / (pp * pp + beta * beta * h * h + 1e-20);
    }
    if (p.kick > 0) {
      var kk = odd(p.kickLen * fr), kTop = Math.min(nb, Math.ceil((p.kickHi + 1) / df) + 1);
      var E1 = new Float32Array(F * nb), B = new Float32Array(F * nb);
      for (k = 0; k < kTop; k++) { minmaxLine(M, E1, F, nb, k, kk, false); minmaxLine(E1, B, F, nb, k, kk, true); }
      for (t = 0; t < F; t++) for (k = 0; k < kTop; k++) {
        var j = t * nb + k, lb = Math.min(1, Math.max(0, (p.kickHi - k * df) / 60));
        if (lb <= 0) continue;
        var kfrac = Math.min(1, Math.max(0, (M[j] - B[j]) / (M[j] + 1e-20))) * lb * p.kick;
        if (kfrac > mask[j]) mask[j] = kfrac;
      }
    }
    var o0 = job.f0 * H - N, olen = (job.f1 - job.f0 - 1) * H + N;
    var oL = new Float32Array(olen), oR = new Float32Array(olen);
    for (t = job.f0; t < job.f1; t++) an.synth(XL, XR, (t - fa) * nb * 2, mask, (t - fa) * nb, t * H - N, oL, oR, o0);
    return { start: o0, L: oL, R: oR };
  }

  // ---------- Stage B pass 1: magnitudes, salience, band energies ----------
  var NCAND = 180;
  function bandShape(f, p) { var a = p.vlo / Math.max(f, 1), b = f / p.vhi; return 1 / (1 + a * a * a * a) / (1 + b * b * b * b); }
  function salienceRow(C, nb, df, fmin, nh, decay, out, off) {
    for (var c = 0; c < NCAND; c++) {
      var f0 = fmin * Math.pow(2, c * 20 / 1200), s = 0, wgt = 1;
      for (var h = 1; h <= nh; h++, wgt *= decay) {
        var fb = f0 * h / df; if (fb >= nb - 1) break;
        var i0 = fb | 0, fr = fb - i0;
        s += (C[i0] * (1 - fr) + C[i0 + 1] * fr) * wgt;
      }
      out[off + c] = s;
    }
  }
  function stageB1(job) {
    var p = job.p, N = job.N, H = job.H, sr = job.sr, nb = N / 2 + 1, an = new Analyzer(N), df = sr / N;
    var F = job.f1 - job.f0, X1 = new Float32Array(nb * 2), X2 = new Float32Array(nb * 2);
    var V = new Uint16Array(F * nb), salV = new Float32Array(F * NCAND), salB = new Float32Array(F * NCAND);
    var NBANDS = 96, bands = new Float32Array(F * NBANDS), bandOf = new Uint8Array(nb);
    for (var k = 0; k < nb; k++) { var f = Math.max(k * df, 20); bandOf[k] = Math.min(NBANDS - 1, Math.max(0, Math.floor(Math.log2(f / 20) / Math.log2(20000 / 20) * NBANDS))); }
    var C = new Float64Array(nb), CB = new Float64Array(nb), bshape = new Float64Array(nb);
    for (k = 0; k < nb; k++) bshape[k] = bandShape(k * df, p);
    var maxC = 0, maxB = 0, sp = p.salPow, mw = p.melWidth;
    for (var t = 0; t < F; t++) {
      an.frame(job.L, job.R, job.segStart, (job.f0 + t) * H - N, X1, X2, 0);
      for (k = 0; k < nb; k++) {
        var a = X1[2 * k], b = X1[2 * k + 1], c = X2[2 * k], d = X2[2 * k + 1];
        var PL = a * a + b * b, PR = c * c + d * d, E = PL + PR + 1e-20, mag = Math.sqrt(E);
        V[t * nb + k] = encodeMag(mag);
        bands[t * NBANDS + bandOf[k]] += E;
        var pan = (PR - PL) / E, ph = (a * c + b * d) / Math.sqrt(PL * PR + 1e-30);
        var cw = Math.exp(-0.5 * (pan / mw) * (pan / mw)) * (ph > 0 ? Math.min(ph, 1) : 0);
        var cv = mag * cw * bshape[k]; if (cv > maxC) maxC = cv;
        C[k] = Math.pow(cv, sp);
        var lv = k * df < 400 ? mag : 0; if (lv > maxB) maxB = lv;
        CB[k] = Math.pow(lv, sp);
      }
      salienceRow(C, nb, df, 80, 8, p.hDecay, salV, t * NCAND);
      salienceRow(CB, nb, df, 30, 6, p.hDecay, salB, t * NCAND);
    }
    return { V: V, salV: salV, salB: salB, bands: bands, nbands: NBANDS, maxC: maxC, maxB: maxB };
  }
  // magnitude <-> uint16 (log scale, -120..+100 dB, 0.0034 dB steps)
  function encodeMag(m) { var db = 20 * Math.log10(m + 1e-12); var q = Math.round((db + 120) * 297.88); return q < 0 ? 0 : q > 65535 ? 65535 : q; }
  var decTab = null;
  function decodeTable() { if (decTab) return decTab; decTab = new Float32Array(65536); for (var q = 0; q < 65536; q++) decTab[q] = Math.pow(10, (q / 297.88 - 120) / 20); return decTab; }

  // ---------- global analysis on the main thread: period + pitch tracks ----------
  function estimatePeriod(bands, nbands, T, sr, H) {
    var fr = sr / H, lo = Math.round(1.0 * fr), hi = Math.min(Math.round(8.0 * fr), Math.floor(T / 3));
    if (hi <= lo + 2) return 0;
    var n = 1; while (n < 2 * T) n <<= 1;
    var Fh = getFFT(n), re = new Float64Array(n), im = new Float64Array(n), ac = new Float64Array(T);
    for (var b = 0; b < nbands; b++) {
      var mean = 0, t; for (t = 0; t < T; t++) mean += Math.sqrt(bands[t * nbands + b]); mean /= T;
      re.fill(0); im.fill(0);
      for (t = 0; t < T; t++) re[t] = Math.sqrt(bands[t * nbands + b]) - mean;
      fft(Fh, re, im, false);
      for (var i = 0; i < n; i++) { re[i] = re[i] * re[i] + im[i] * im[i]; im[i] = 0; }
      fft(Fh, re, im, true);
      if (re[0] > 1e-20) for (t = 0; t < T; t++) ac[t] += re[t] / re[0];
    }
    var best = lo, bv = -Infinity;
    for (var l = lo; l <= hi; l++) { var v = ac[l] / nbands; if (v > bv) { bv = v; best = l; } }
    return bv > 0.15 ? best : 0;
  }
  function viterbi(sal, T, norm, pct, fmin) {
    var nc = NCAND, R = 15, lt = new Float64Array(2 * R + 1);
    for (var d = -R; d <= R; d++) lt[d + R] = Math.log(Math.exp(-Math.pow(d * 20 / 100, 2)) + 1e-6);
    var dp = new Float64Array(nc), nd = new Float64Array(nc), back = new Uint8Array(T * nc), t, c;
    var ls = function (t, c) { return Math.log(sal[t * nc + c] * norm + 1e-6); };
    for (c = 0; c < nc; c++) dp[c] = ls(0, c);
    for (t = 1; t < T; t++) {
      for (c = 0; c < nc; c++) {
        var bv = -Infinity, bi = c;
        for (d = -R; d <= R; d++) { var j = c + d; if (j < 0 || j >= nc) continue; var v = dp[j] + lt[d + R]; if (v > bv) { bv = v; bi = j; } }
        nd[c] = bv + ls(t, c); back[t * nc + c] = bi;
      }
      var tmp = dp; dp = nd; nd = tmp;
      // keep numbers bounded
      var mx = -Infinity; for (c = 0; c < nc; c++) if (dp[c] > mx) mx = dp[c]; for (c = 0; c < nc; c++) dp[c] -= mx;
    }
    var path = new Uint8Array(T), bc = 0, bvv = -Infinity;
    for (c = 0; c < nc; c++) if (dp[c] > bvv) { bvv = dp[c]; bc = c; }
    path[T - 1] = bc;
    for (t = T - 1; t > 0; t--) path[t - 1] = back[t * nc + path[t]];
    var ps = new Float64Array(T); for (t = 0; t < T; t++) ps[t] = sal[t * nc + path[t]];
    var sorted = Array.from(ps).sort(function (a, b) { return a - b; });
    var thr = sorted[Math.min(T - 1, Math.floor(pct / 100 * (T - 1)))];
    var f0 = new Float32Array(T);
    for (t = 0; t < T; t++) f0[t] = ps[t] > thr ? fmin * Math.pow(2, path[t] * 20 / 1200) : 0;
    return f0;
  }

  // ---------- Stage B pass 2: masks and synthesis ----------
  // job: {L,R (residual segment), segStart, sr, f0,f1, fa,fb, p, N,H, V (Uint16, frames va..vb), va, per, f0V, f0B (frames fa..fb), T}
  function stageB2(job) {
    var p = job.p, N = job.N, H = job.H, sr = job.sr, nb = N / 2 + 1, an = new Analyzer(N), df = sr / N;
    var fa = job.fa, fb = job.fb, F = fb - fa, T = job.T, t, k, i;
    var XL = new Float32Array(F * nb * 2), XR = new Float32Array(F * nb * 2);
    var PL = new Float32Array(F * nb), PR = new Float32Array(F * nb), CRr = new Float32Array(F * nb), CRi = new Float32Array(F * nb);
    for (t = 0; t < F; t++) {
      an.frame(job.L, job.R, job.segStart, (fa + t) * H - N, XL, XR, t * nb * 2);
      for (k = 0; k < nb; k++) {
        var o = t * nb * 2 + 2 * k, j = t * nb + k, a = XL[o], b = XL[o + 1], c = XR[o], d = XR[o + 1];
        PL[j] = a * a + b * b; PR[j] = c * c + d * d; CRr[j] = a * c + b * d; CRi[j] = b * c - a * d;
      }
    }
    var NS = p.stems === 2 ? 1 : (p.stems === 5 ? 3 : 2); // synthesized masks: vocals, bass, (ambience)
    var masks = new Float32Array(NS * F * nb);
    var bshape = new Float64Array(nb), lpS = new Float64Array(nb);
    for (k = 0; k < nb; k++) { var f = k * df, r8 = Math.pow(f / p.bassFc, 8); bshape[k] = bandShape(f, p); lpS[k] = 1 / (1 + r8); }
    var dec = decodeTable(), per = job.per, K = p.repK, va = job.va, V = job.V, nvf = V ? V.length / nb : 0;
    var useAmb = p.stems === 5 && p.ambience > 0, med = new Float64Array(2 * K + 1);
    for (t = 0; t < F; t++) {
      var gt = fa + t;
      // coherence smoothing window (+-2 frames, within chunk)
      var t0 = Math.max(0, t - 2), t1 = Math.min(F - 1, t + 2);
      var f0v = job.f0V[t], f0b = job.f0B[t];
      for (k = 0; k < nb; k++) {
        i = t * nb + k;
        var pl = PL[i], pr = PR[i], E = pl + pr + 1e-20, mag = Math.sqrt(E);
        var amb = 0;
        if (useAmb) {
          var sr_ = 0, si = 0, sl = 0, sR = 0;
          for (var u = t0; u <= t1; u++) { var q = u * nb + k; sr_ += CRr[q]; si += CRi[q]; sl += PL[q]; sR += PR[q]; }
          var coh = Math.sqrt(sr_ * sr_ + si * si) / Math.sqrt(sl * sR + 1e-30); if (coh > 1) coh = 1;
          amb = Math.pow(1 - coh, p.ambG) * p.ambience; if (amb > 1) amb = 1;
        }
        var direct = 1 - amb;
        var pan = (pr - pl) / E, ph = CRr[i] / Math.sqrt(pl * pr + 1e-30); if (ph < 0) ph = 0; else if (ph > 1) ph = 1;
        var dp = (pan - p.vocalPan) / p.width;
        var center = Math.exp(-0.5 * dp * dp) * Math.pow(ph, p.phaseK);
        var cwp = (pan - p.vocalPan) / p.melWidth, cw = Math.exp(-0.5 * cwp * cwp) * ph;
        var rpen = 1;
        if (p.rep > 0 && per > 0) {
          var nm = 0; med[nm++] = mag;
          for (var kk = 1; kk <= K; kk++) {
            var tp = gt + kk * per, tm = gt - kk * per;
            if (tp < T && tp - va < nvf) med[nm++] = dec[V[(tp - va) * nb + k]];
            if (tm >= 0 && tm >= va) med[nm++] = dec[V[(tm - va) * nb + k]];
          }
          if (nm >= 3) {
            var arr = med.subarray(0, nm); arr.sort();
            var Wm = (nm & 1) ? arr[nm >> 1] : 0.5 * (arr[nm / 2 - 1] + arr[nm / 2]);
            var rf = Math.min(Wm, mag) / mag; rpen = 1 - p.rep * rf;
          }
        }
        var Mm = 0;
        if (f0v > 0) {
          var hh = k * df / f0v, rr = Math.round(hh);
          if (rr >= 1 && rr <= 40) { var wid = p.melW * rr + df / f0v * 0.6, dd = Math.abs(hh - rr) / wid; Mm = Math.exp(-0.5 * dd * dd); }
        }
        var vs = bshape[k] * ((1 - p.mel) * center * rpen + p.mel * Mm * cw);
        if (vs > 1) vs = 1; else if (vs < 0) vs = 0;
        var lp = lpS[k];
        if (f0b > 0 && k * df < p.bassTop) {
          var hb = k * df / f0b, rb = Math.round(hb);
          if (rb >= 1 && rb <= p.bassNh) { var wb = p.bassW * rb + df / f0b * 0.6, db = Math.abs(hb - rb) / wb, bm = p.bmel * Math.exp(-0.5 * db * db); if (bm > lp) lp = bm; }
        }
        var mv = direct * vs, mb = direct * (1 - vs) * lp;
        var base = t * nb + k;
        if (NS === 1) masks[base] = p.stems === 2 ? mv : mv;
        else { masks[base] = mv; masks[F * nb + base] = mb; if (NS === 3) masks[2 * F * nb + base] = amb; }
      }
    }
    // temporal smoothing of masks (3 frames) - sum stays <= 1 because each is an average of fractions summing to 1
    if (p.smooth) {
      var tmp = new Float32Array(F * nb);
      for (var s = 0; s < NS; s++) {
        var m = masks.subarray(s * F * nb, (s + 1) * F * nb);
        for (t = 0; t < F; t++) {
          var ta = Math.max(0, t - 1), tb = Math.min(F - 1, t + 1), inv = 1 / (tb - ta + 1);
          for (k = 0; k < nb; k++) { var acc = 0; for (var u2 = ta; u2 <= tb; u2++) acc += m[u2 * nb + k]; tmp[t * nb + k] = acc * inv; }
        }
        m.set(tmp);
      }
    }
    var o0 = job.f0 * H - N, olen = (job.f1 - job.f0 - 1) * H + N, outs = [];
    for (s = 0; s < NS; s++) {
      var oL = new Float32Array(olen), oR = new Float32Array(olen);
      for (t = job.f0; t < job.f1; t++) an.synth(XL, XR, (t - fa) * nb * 2, masks, s * F * nb + (t - fa) * nb, t * H - N, oL, oR, o0);
      outs.push(oL, oR);
    }
    // the rest ("other" / instrumental) = residual * window coverage - synthesized stems; exact and cheap
    var w = an.w, cov = new Float32Array(olen);
    for (t = job.f0; t < job.f1; t++) { var x0 = t * H - N - o0; for (var jj = 0; jj < N; jj++) { var sidx = x0 + jj; if (sidx >= 0 && sidx < olen) cov[sidx] += w[jj] * w[jj] * 0.5; } }
    var rL = new Float32Array(olen), rR = new Float32Array(olen), L = job.L, R = job.R, ss = job.segStart;
    for (i = 0; i < olen; i++) {
      var xi = o0 + i - ss, lv = (xi >= 0 && xi < L.length) ? L[xi] : 0, rv = (xi >= 0 && xi < R.length) ? R[xi] : 0;
      var l2 = lv * cov[i], r2 = rv * cov[i];
      for (s = 0; s < NS; s++) { l2 -= outs[2 * s][i]; r2 -= outs[2 * s + 1][i]; }
      rL[i] = l2; rR[i] = r2;
    }
    outs.push(rL, rR);
    return { start: o0, outs: outs };
  }

  // ---------- display spectrogram (log-frequency, uint8) ----------
  var SPEC_ROWS = 160;
  function spectrogram(job) {
    // job: {L,R,segStart, c0, c1 (columns), hop, N, sr}
    var N = job.N, an = new Analyzer(N), nb = N / 2 + 1, df = job.sr / N, hop = job.hop;
    var X1 = new Float32Array(nb * 2), X2 = new Float32Array(nb * 2), cols = job.c1 - job.c0;
    var out = new Uint8Array(cols * SPEC_ROWS), lo = Math.log2(30), hi = Math.log2(Math.min(18000, job.sr / 2 - 100));
    var rowA = new Int32Array(SPEC_ROWS + 1);
    for (var r = 0; r <= SPEC_ROWS; r++) rowA[r] = Math.min(nb - 1, Math.max(1, Math.round(Math.pow(2, lo + (hi - lo) * r / SPEC_ROWS) / df)));
    var ref = N / 4;
    for (var c = 0; c < cols; c++) {
      var x0 = (job.c0 + c) * hop - N / 2;
      an.frame(job.L, job.R, job.segStart, x0, X1, X2, 0);
      for (r = 0; r < SPEC_ROWS; r++) {
        var a = rowA[r], b = Math.max(a + 1, rowA[r + 1]), m = 0;
        for (var k = a; k < b && k < nb; k++) { var e = X1[2 * k] * X1[2 * k] + X1[2 * k + 1] * X1[2 * k + 1] + X2[2 * k] * X2[2 * k] + X2[2 * k + 1] * X2[2 * k + 1]; if (e > m) m = e; }
        var db = 10 * Math.log10(m / 2 + 1e-20) - 20 * Math.log10(ref);
        var v = Math.round((db + 96) / 96 * 255); out[c * SPEC_ROWS + r] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return { out: out, rows: SPEC_ROWS };
  }

  // ---------- spectral region move (time x frequency rectangle) ----------
  // job: {L,R (segment of source stem), segStart, sr, x0, x1 (samples), flo, fhi, N}
  // returns the part of the segment inside the soft rectangle
  function spectralPart(job) {
    var N = job.N, H = N / 4, an = new Analyzer(N), nb = N / 2 + 1, df = job.sr / N, len = job.L.length;
    var outL = new Float32Array(len), outR = new Float32Array(len), X1 = new Float32Array(nb * 2), X2 = new Float32Array(nb * 2);
    var mask = new Float32Array(nb), lo = Math.log2(Math.max(job.flo, 10)), hi = Math.log2(Math.max(job.fhi, job.flo + 1)), edge = 1 / 6;
    for (var k = 0; k < nb; k++) {
      var lf = Math.log2(Math.max(k * df, 1)), g;
      if (job.flo <= 0 && lf < hi) g = 1;
      else if (lf < lo - edge || lf > hi + edge) g = 0;
      else if (lf < lo) g = 0.5 - 0.5 * Math.cos(Math.PI * (lf - lo + edge) / edge);
      else if (lf > hi) g = 0.5 + 0.5 * Math.cos(Math.PI * (lf - hi) / edge);
      else g = 1;
      mask[k] = g;
    }
    var fadeS = Math.round(0.01 * job.sr), seg = job.segStart, ft0 = Math.floor((seg) / H) - 4, ft1 = Math.ceil((seg + len + N) / H) + 4;
    var tm = new Float32Array(nb);
    for (var t = ft0; t < ft1; t++) {
      var xc = t * H - N / 2; // frame centre
      var tg;
      if (xc < job.x0 - fadeS || xc > job.x1 + fadeS) continue;
      else if (xc < job.x0) tg = 0.5 + 0.5 * Math.cos(Math.PI * (job.x0 - xc) / fadeS);
      else if (xc > job.x1) tg = 0.5 + 0.5 * Math.cos(Math.PI * (xc - job.x1) / fadeS);
      else tg = 1;
      for (k = 0; k < nb; k++) tm[k] = mask[k] * tg;
      an.frame(job.L, job.R, seg, t * H - N, X1, X2, 0);
      an.synth(X1, X2, 0, tm, 0, t * H - N, outL, outR, seg);
    }
    return { L: outL, R: outR };
  }

  // ---------- loudness (ITU-R BS.1770-4) and true peak ----------
  function kWeightCoefs(sr) {
    // pre-filter (high shelf) and RLB high-pass, derived for any rate (as in pyloudnorm)
    var G = 3.999843853973347, Q1 = 0.7071752369554196, fc1 = 1681.974450955533;
    var A = Math.pow(10, G / 40), w0 = 2 * Math.PI * fc1 / sr, al = Math.sin(w0) / (2 * Q1), cw = Math.cos(w0);
    var sh = norm([A * ((A + 1) + (A - 1) * cw + 2 * Math.sqrt(A) * al), -2 * A * ((A - 1) + (A + 1) * cw), A * ((A + 1) + (A - 1) * cw - 2 * Math.sqrt(A) * al),
      (A + 1) - (A - 1) * cw + 2 * Math.sqrt(A) * al, 2 * ((A - 1) - (A + 1) * cw), (A + 1) - (A - 1) * cw - 2 * Math.sqrt(A) * al]);
    var fc2 = 38.13547087602444, Q2 = 0.5003270373238773, w2 = 2 * Math.PI * fc2 / sr, a2 = Math.sin(w2) / (2 * Q2), c2 = Math.cos(w2);
    var hp = norm([(1 + c2) / 2, -(1 + c2), (1 + c2) / 2, 1 + a2, -2 * c2, 1 - a2]);
    function norm(c) { return [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[4] / c[3], c[5] / c[3]]; }
    return [sh, hp];
  }
  function biquadRun(x, c, y) {
    var b0 = c[0], b1 = c[1], b2 = c[2], a1 = c[3], a2 = c[4], x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (var i = 0; i < x.length; i++) { var v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  }
  function loudness(chans, sr) {
    var cf = kWeightCoefs(sr), n = chans[0].length, blk = Math.round(0.4 * sr), hop = Math.round(0.1 * sr);
    var pw = new Float64Array(n), tmp = new Float32Array(n), tmp2 = new Float32Array(n);
    chans.forEach(function (x) { biquadRun(x, cf[0], tmp); biquadRun(tmp, cf[1], tmp2); for (var i = 0; i < n; i++) pw[i] += tmp2[i] * tmp2[i]; });
    var cum = new Float64Array(n + 1); for (var i = 0; i < n; i++) cum[i + 1] = cum[i] + pw[i];
    var blocks = [];
    for (var s = 0; s + blk <= n; s += hop) blocks.push((cum[s + blk] - cum[s]) / blk);
    if (!blocks.length) blocks.push(cum[n] / Math.max(1, n));
    var L = function (z) { return -0.691 + 10 * Math.log10(z + 1e-30); };
    var g1 = blocks.filter(function (z) { return L(z) > -70; });
    if (!g1.length) return { integrated: -Infinity, lra: 0 };
    var m1 = g1.reduce(function (a, b) { return a + b; }, 0) / g1.length, rel = L(m1) - 10;
    var g2 = g1.filter(function (z) { return L(z) > rel; }), m2 = g2.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, g2.length);
    // loudness range from 3 s short-term blocks
    var st = [], sb = Math.round(3 * sr), sh = Math.round(1 * sr);
    for (s = 0; s + sb <= n; s += sh) st.push(L((cum[s + sb] - cum[s]) / sb));
    st = st.filter(function (v) { return v > -70; });
    var lra = 0;
    if (st.length > 2) { var ab = st.reduce(function (a, b) { return a + Math.pow(10, (b + 0.691) / 10); }, 0) / st.length; var rg = L(ab) - 20; st = st.filter(function (v) { return v > rg; }).sort(function (a, b) { return a - b; }); if (st.length > 2) lra = st[Math.floor(0.95 * (st.length - 1))] - st[Math.floor(0.1 * (st.length - 1))]; }
    return { integrated: L(m2), lra: lra };
  }
  // 4x oversampling interpolator (windowed sinc, 48 taps)
  var tpTaps = null;
  function tpFilter() {
    if (tpTaps) return tpTaps;
    var taps = 12, ph = [];
    for (var p = 0; p < 4; p++) {
      var h = new Float64Array(taps), s = 0;
      for (var j = 0; j < taps; j++) { var x = (j - taps / 2 + 1) - p / 4, sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x), w = 0.5 + 0.5 * Math.cos(Math.PI * x / (taps / 2)); h[j] = sinc * w; s += h[j]; }
      for (j = 0; j < taps; j++) h[j] /= s; ph.push(h);
    }
    return (tpTaps = ph);
  }
  function truePeakAt(x, i, ph) {
    var m = Math.abs(x[i]);
    for (var p = 1; p < 4; p++) { var h = ph[p], s = 0; for (var j = 0; j < 12; j++) { var k = i + j - 5; if (k >= 0 && k < x.length) s += x[k] * h[j]; } if (Math.abs(s) > m) m = Math.abs(s); }
    return m;
  }
  function truePeak(chans) { var ph = tpFilter(), m = 0; chans.forEach(function (x) { for (var i = 0; i < x.length; i++) { if (Math.abs(x[i]) * 1.2 + 1e-9 < m) continue; var v = truePeakAt(x, i, ph); if (v > m) m = v; } }); return m; }
  // look-ahead true-peak limiter (in place, offline: reads ahead instead of delaying). ceiling linear.
  function limit(chans, sr, ceiling, releaseMs) {
    var n = chans[0].length, la = Math.round(0.0015 * sr) + 1, ph = tpFilter(), i, c;
    var need = new Float32Array(n);
    for (i = 0; i < n; i++) {
      var pk = 0; for (c = 0; c < chans.length; c++) { var a = Math.abs(chans[c][i]); if (a > pk) pk = a; }
      if (pk * 1.3 > ceiling) { pk = 0; for (c = 0; c < chans.length; c++) { var v = truePeakAt(chans[c], i, ph); if (v > pk) pk = v; } }
      need[i] = pk > ceiling ? ceiling / pk : 1;
    }
    // gmin[i] = min(need[i .. i+la-1]) (monotone deque, scanning backwards)
    var gmin = new Float32Array(n), dq = new Int32Array(n), h = 0, t = 0;
    for (i = n - 1; i >= 0; i--) {
      while (t > h && need[dq[t - 1]] >= need[i]) t--;
      dq[t++] = i;
      while (dq[h] > i + la - 1) h++;
      gmin[i] = need[dq[h]];
    }
    // attack: moving average of gmin over the previous la samples (always <= need[i]); release: one-pole
    var rel = Math.exp(-1 / (sr * (releaseMs || 80) / 1000)), acc = 0, r = 1;
    for (i = 0; i < n; i++) {
      acc += gmin[i] - (i >= la ? gmin[i - la] : 1);
      var ga = (acc + la) / la; // acc = window sum - la (unity padding before the start)
      if (i < la && ga > gmin[i]) ga = gmin[i];
      r = ga < r ? ga : ga + (r - ga) * rel;
      var g = Math.min(r, ga);
      for (c = 0; c < chans.length; c++) chans[c][i] *= g;
    }
    return chans;
  }

  // ---------- WAV, zip ----------
  function wav(chans, sr, bits, dither) {
    var n = chans[0].length, nc = chans.length, bps = bits / 8, fmt = bits === 32 ? 3 : 1, dl = n * nc * bps;
    var buf = new ArrayBuffer(44 + dl), dv = new DataView(buf), o = 0;
    function s(str) { for (var i = 0; i < str.length; i++) dv.setUint8(o++, str.charCodeAt(i)); }
    s('RIFF'); dv.setUint32(o, 36 + dl, true); o += 4; s('WAVEfmt '); dv.setUint32(o, 16, true); o += 4;
    dv.setUint16(o, fmt, true); o += 2; dv.setUint16(o, nc, true); o += 2; dv.setUint32(o, sr, true); o += 4;
    dv.setUint32(o, sr * nc * bps, true); o += 4; dv.setUint16(o, nc * bps, true); o += 2; dv.setUint16(o, bits, true); o += 2;
    s('data'); dv.setUint32(o, dl, true); o += 4;
    var seed = 22222;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    for (var i = 0; i < n; i++) for (var c = 0; c < nc; c++) {
      var v = chans[c][i];
      if (bits === 32) { dv.setFloat32(o, v, true); o += 4; }
      else if (bits === 24) { var q = Math.round(Math.max(-1, Math.min(1, v)) * 8388607); dv.setUint8(o, q & 255); dv.setUint8(o + 1, (q >> 8) & 255); dv.setUint8(o + 2, (q >> 16) & 255); o += 3; }
      else { var d = dither ? (rnd() - rnd()) : 0; var q2 = Math.round(Math.max(-1, Math.min(1, v)) * 32767 + d); dv.setInt16(o, Math.max(-32768, Math.min(32767, q2)), true); o += 2; }
    }
    return new Uint8Array(buf);
  }
  var crcT = null;
  function crc32(u) { if (!crcT) { crcT = new Uint32Array(256); for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; } } var c2 = 0xFFFFFFFF; for (var i = 0; i < u.length; i++) c2 = crcT[(c2 ^ u[i]) & 255] ^ (c2 >>> 8); return (c2 ^ 0xFFFFFFFF) >>> 0; }
  function zip(files) { // [{name, data:Uint8Array}] -> array of Uint8Array parts (STORE)
    var parts = [], cen = [], off = 0, enc = function (s) { return new TextEncoder().encode(s); };
    files.forEach(function (f) {
      var nm = enc(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint32(14, crc, true);
      h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
      parts.push(new Uint8Array(h.buffer), nm, f.data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint32(16, crc, true);
      c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nm);
      off += 30 + nm.length + f.data.length;
    });
    var cs = cen.reduce(function (a, b) { return a + b.length; }, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
    return parts.concat(cen, [new Uint8Array(e.buffer)]);
  }
  function unzip(u8) { // STORE-only reader for our own files
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = {}, o = 0, dec = new TextDecoder();
    while (o + 30 <= u8.length && dv.getUint32(o, true) === 0x04034b50) {
      var method = dv.getUint16(o + 8, true), size = dv.getUint32(o + 18, true), nl = dv.getUint16(o + 26, true), el = dv.getUint16(o + 28, true);
      var name = dec.decode(u8.subarray(o + 30, o + 30 + nl)), start = o + 30 + nl + el;
      if (method !== 0) throw new Error('Compressed zip entries are not supported');
      out[name] = u8.subarray(start, start + size); o = start + size;
    }
    return out;
  }

  // ---------- worker dispatcher ----------
  function handle(msg) {
    switch (msg.op) {
      case 'A': return stageA(msg.job);
      case 'B1': return stageB1(msg.job);
      case 'B2': return stageB2(msg.job);
      case 'SPEC': return spectrogram(msg.job);
      case 'SPART': return spectralPart(msg.job);
      case 'LIMIT': {
        var j = msg.job, ch = j.chans;
        if (j.gain !== 1) ch.forEach(function (x) { for (var i = 0; i < x.length; i++) x[i] *= j.gain; });
        if (j.ceiling) limit(ch, j.sr, j.ceiling, j.release);
        var L = loudness(ch, j.sr);
        return { chans: ch, lufs: L.integrated, lra: L.lra, tp: truePeak(ch) };
      }
      case 'MP3': {
        var m = msg.job;
        if (typeof lamejs === 'undefined') throw new Error('MP3 encoder not loaded');
        if ([32000, 44100, 48000, 22050, 24000, 16000].indexOf(m.sr) < 0) throw new Error('MP3 needs a 48 kHz or lower sample rate: choose WAV for this song');
        var enc = new lamejs.Mp3Encoder(2, m.sr, m.kbps), parts = [], total = 0, BL = 1152 * 8, l16 = new Int16Array(BL), r16 = new Int16Array(BL);
        for (var i = 0; i < m.L.length; i += BL) {
          var n = Math.min(BL, m.L.length - i);
          for (var k = 0; k < n; k++) { var a = m.L[i + k], b = m.R[i + k]; l16[k] = a >= 1 ? 32767 : a <= -1 ? -32768 : a * 32767; r16[k] = b >= 1 ? 32767 : b <= -1 ? -32768 : b * 32767; }
          var out = enc.encodeBuffer(n === BL ? l16 : l16.subarray(0, n), n === BL ? r16 : r16.subarray(0, n));
          if (out.length) { parts.push(new Uint8Array(out)); total += out.length; }
        }
        var fl = enc.flush(); if (fl.length) { parts.push(new Uint8Array(fl)); total += fl.length; }
        var data = new Uint8Array(total), o = 0; parts.forEach(function (p) { data.set(p, o); o += p.length; });
        return { data: data };
      }
      case 'LOUD': { var r = loudness(msg.job.chans, msg.job.sr); return { lufs: r.integrated, lra: r.lra, tp: truePeak(msg.job.chans) }; }
    }
    throw new Error('unknown op ' + msg.op);
  }
  function transferables(res) {
    var t = [];
    (function walk(v) { if (!v) return; if (ArrayBuffer.isView(v)) { if (t.indexOf(v.buffer) < 0) t.push(v.buffer); } else if (Array.isArray(v)) v.forEach(walk); else if (typeof v === 'object') for (var k in v) walk(v[k]); })(res);
    return t;
  }
  if (typeof self !== 'undefined' && typeof window === 'undefined' && typeof importScripts === 'function') {
    self.onmessage = function (e) {
      var id = e.data.id;
      try { var res = handle(e.data); self.postMessage({ id: id, res: res }, transferables(res)); }
      catch (err) { self.postMessage({ id: id, err: String(err && err.stack || err) }); }
    };
  }

  return {
    DEFAULTS: DEFAULTS, sizes: sizes, nFrames: nFrames, NCAND: NCAND,
    stageA: stageA, stageB1: stageB1, stageB2: stageB2, estimatePeriod: estimatePeriod, viterbi: viterbi,
    spectrogram: spectrogram, spectralPart: spectralPart, SPEC_ROWS: SPEC_ROWS,
    loudness: loudness, truePeak: truePeak, limit: limit, wav: wav, zip: zip, unzip: unzip, crc32: crc32,
    handle: handle, transferables: transferables, getFFT: getFFT, fft: fft, kWeightCoefs: kWeightCoefs
  };
})();
if (typeof module !== 'undefined') module.exports = DSP;
