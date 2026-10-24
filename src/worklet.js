// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — AudioWorklet processors
// ds-channel : console channel (trim, polarity, HPF/LPF, 4-band EQ, gate, compressor, tape) for tracks, buses and master
// ds-fader   : fader + pan + mute + post-fader meter, outputs [post, pre]
// ds-rec     : sample-accurate input capture + input meters

const DB = (x) => 20 * Math.log10(x + 1e-20);
const UNDB = (d) => Math.pow(10, d / 20);

class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [0, 0, 0, 0]; this.on = false; }
  set(type, f, q, g, fs) {
    f = Math.max(5, Math.min(f, fs * 0.49));
    const w = 2 * Math.PI * f / fs, cw = Math.cos(w), sw = Math.sin(w);
    const A = Math.pow(10, g / 40), al = sw / (2 * q);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    else if (type === 'ls') { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; }
    else { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  setRaw(b0, b1, b2, a1, a2) { this.b0 = b0; this.b1 = b1; this.b2 = b2; this.a1 = a1; this.a2 = a2; }
  run(x, c) { // c = channel 0/1, transposed direct form II
    const i = c * 2, z = this.z;
    const y = this.b0 * x + z[i];
    z[i] = this.b1 * x - this.a1 * y + z[i + 1];
    z[i + 1] = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z.fill(0); }
}

// 23-tap half-band FIR for 2x oversampled tape saturation
const HB = (() => {
  const N = 23, M = 11, h = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const t = n - M;
    const s = t === 0 ? 0.5 : Math.sin(Math.PI * t / 2) / (Math.PI * t);
    const w = 0.42 - 0.5 * Math.cos(2 * Math.PI * n / (N - 1)) + 0.08 * Math.cos(4 * Math.PI * n / (N - 1));
    h[n] = s * w;
  }
  let sum = 0; for (let n = 0; n < N; n++) sum += h[n];
  for (let n = 0; n < N; n++) h[n] /= sum;
  return h;
})();

class Tape {
  constructor(fs) {
    this.fs = fs; this.drive = 0;
    this.xh = [new Float64Array(16), new Float64Array(16)]; this.xi = 0;
    this.zh = [new Float64Array(32), new Float64Array(32)]; this.zi = 0;
    this.lp = [0, 0]; this.dc = [0, 0, 0, 0];
  }
  sat(x) {
    const d = this.drive, k = 1 + d * 3.5, b = 0.1 * d;
    const tb = Math.tanh(k * b), norm = k * (1 - tb * tb);
    return (Math.tanh(k * (x + b)) - tb) / norm;
  }
  // process one stereo frame in place via arrays
  run(L, R, out) {
    const xi = this.xi = (this.xi + 1) & 15;
    const zi0 = this.zi;
    for (let c = 0; c < 2; c++) {
      const xh = this.xh[c], zh = this.zh[c];
      xh[xi] = c ? R : L;
      // up: even sample = 2 * sum h[2k] x[n-k]; odd sample = x[n-5]
      let e = 0;
      for (let k = 0; k < 12; k++) e += HB[2 * k] * xh[(xi - k) & 15];
      e *= 2;
      const o = xh[(xi - 5) & 15];
      let zi = zi0;
      zi = (zi + 1) & 31; zh[zi] = this.sat(e);
      zi = (zi + 1) & 31; zh[zi] = this.sat(o);
      // down: d = sum_j h[j] z[m - j], m = zi (newest, odd position) -> use parity as derived
      let d = 0;
      for (let j = 0; j < 23; j++) { const hj = HB[j]; if (hj !== 0) d += hj * zh[(zi - j) & 31]; }
      // gentle HF loss and DC block
      const a = Math.exp(-2 * Math.PI * (19000 - this.drive * 9000) / this.fs);
      this.lp[c] = d + (this.lp[c] - d) * a;
      const y = this.lp[c];
      const dcx = this.dc[c * 2], dcy = this.dc[c * 2 + 1];
      const out1 = y - dcx + 0.9995 * dcy;
      this.dc[c * 2] = y; this.dc[c * 2 + 1] = out1;
      out[c] = out1;
    }
    this.zi = (zi0 + 2) & 31;
  }
}

class Comp {
  constructor(fs) { this.fs = fs; this.env = 0; this.rms = 0; this.gr = 0; this.set('compressor', -20, 4, 10, 120, 0); }
  set(mode, thresh, ratio, att, rel, makeup) {
    this.mode = mode; this.T = thresh; this.makeup = UNDB(makeup);
    const fs = this.fs;
    if (mode === 'leveler') { this.R = 3; this.W = 12; att = 15; rel = 900; }
    else if (mode === 'limiter') { this.R = 30; this.W = 2; att = 0.4; rel = Math.max(40, rel * 0.6); }
    else { this.R = Math.max(1, ratio); this.W = 6; }
    this.ac = Math.exp(-1 / (fs * att / 1000));
    this.rc = Math.exp(-1 / (fs * rel / 1000));
    this.rmsc = Math.exp(-1 / (fs * 0.03));
  }
  gain(l, r) {
    let lvl;
    if (this.mode === 'leveler') { const p = 0.5 * (l * l + r * r); this.rms = p + (this.rms - p) * this.rmsc; lvl = Math.sqrt(this.rms); }
    else lvl = Math.max(Math.abs(l), Math.abs(r));
    const over = DB(lvl) - this.T, W = this.W, s = 1 / this.R - 1;
    let g = 0;
    if (2 * over <= -W) g = 0;
    else if (2 * Math.abs(over) <= W) g = s * (over + W / 2) * (over + W / 2) / (2 * W);
    else g = s * over;
    const e = this.env;
    this.env = g < e ? g + (e - g) * this.ac : g + (e - g) * this.rc;
    if (this.env < this.gr) this.gr = this.env;
    return UNDB(this.env) * this.makeup;
  }
}

class Gate {
  constructor(fs) { this.fs = fs; this.g = 1; this.open = false; this.hold = 0; this.lvl = 0; this.T = -80;
    this.ac = Math.exp(-1 / (fs * 0.0005)); this.rc = Math.exp(-1 / (fs * 0.09)); this.holdN = Math.round(fs * 0.03); this.floor = UNDB(-40); }
  run(l, r) {
    const a = Math.max(Math.abs(l), Math.abs(r));
    this.lvl = a > this.lvl ? a : this.lvl * 0.9995;
    const d = DB(this.lvl);
    if (d > this.T) { this.open = true; this.hold = this.holdN; }
    else if (d < this.T - 4) { if (this.hold > 0) this.hold--; else this.open = false; }
    const t = this.open ? 1 : this.floor;
    this.g = t > this.g ? t + (this.g - t) * this.ac : t + (this.g - t) * this.rc;
    return this.g;
  }
}

// ---------- BS.1770 loudness ----------
class Loudness {
  constructor(fs) {
    this.fs = fs;
    this.pre = new Biquad(); this.rlb = new Biquad();
    { const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
      const K = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
      const a0 = 1 + K / Q + K * K;
      this.pre.setRaw((Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0); }
    { const f0 = 38.13547087602444, Q = 0.5003270373238773, K = Math.tan(Math.PI * f0 / fs);
      const a0 = 1 + K / Q + K * K;
      this.rlb.setRaw(1, -2, 1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0); }
    this.sub = Math.round(fs * 0.1); this.n = 0; this.acc = 0;
    this.ring = new Float64Array(30); this.ri = 0; this.filled = 0;
    this.blocks = []; this.short = [];
  }
  reset() { this.n = 0; this.acc = 0; this.ring.fill(0); this.filled = 0; this.blocks = []; this.short = []; this.pre.reset(); this.rlb.reset(); }
  push(l, r) {
    const a = this.rlb.run(this.pre.run(l, 0), 0), b = this.rlb.run(this.pre.run(r, 1), 1);
    this.acc += a * a + b * b;
    if (++this.n >= this.sub) {
      this.ring[this.ri] = this.acc / this.n; this.ri = (this.ri + 1) % 30; this.filled = Math.min(30, this.filled + 1);
      this.n = 0; this.acc = 0;
      if (this.filled >= 4) { const m = this.mean(4); this.blocks.push(m); }
      if (this.filled >= 30 && (this.blocks.length % 10 === 0)) this.short.push(this.mean(30));
      if (this.blocks.length > 36000) this.blocks.splice(0, 6000);
      if (this.short.length > 4000) this.short.splice(0, 1000);
    }
  }
  mean(k) { let s = 0; for (let i = 1; i <= k; i++) s += this.ring[(this.ri - i + 30) % 30]; return s / k; }
  L(e) { return -0.691 + 10 * Math.log10(e + 1e-20); }
  report() {
    const M = this.filled >= 4 ? this.L(this.mean(4)) : -Infinity;
    const S = this.filled >= 30 ? this.L(this.mean(30)) : -Infinity;
    let I = -Infinity, LRA = 0;
    const abs = this.blocks.filter((e) => this.L(e) > -70);
    if (abs.length) {
      const m1 = abs.reduce((a, b) => a + b, 0) / abs.length;
      const rel = this.L(m1) - 10;
      const g = abs.filter((e) => this.L(e) > rel);
      if (g.length) I = this.L(g.reduce((a, b) => a + b, 0) / g.length);
    }
    const sa = this.short.filter((e) => this.L(e) > -70);
    if (sa.length > 2) {
      const m1 = sa.reduce((a, b) => a + b, 0) / sa.length;
      const rel = this.L(m1) - 20;
      const g = sa.map((e) => this.L(e)).filter((v) => v > rel).sort((a, b) => a - b);
      if (g.length > 2) LRA = g[Math.floor(g.length * 0.95) - 1 < 0 ? 0 : Math.floor(g.length * 0.95) - 1] - g[Math.floor(g.length * 0.1)];
    }
    return { M, S, I, LRA };
  }
}

class Limiter {
  // look-ahead brickwall: sliding minimum of the required gain, then a moving average over the look-ahead
  // (lands exactly on the needed gain when the peak comes out), 4x intersample detection with a small margin
  constructor(fs) {
    this.fs = fs; this.L = Math.max(10, Math.round(fs * 0.0015));
    this.dl = [new Float32Array(this.L), new Float32Array(this.L)]; this.req = new Float32Array(this.L + 1); this.i = 0; this.ri = 0;
    this.avg = new Float64Array(this.L); this.ai = 0; this.asum = this.L; this.avg.fill(1); this.req.fill(1);
    this.g = 1; this.ceiling = UNDB(-1); this.rc = Math.exp(-1 / (fs * 0.06)); this.gr = 0;
    this.h = [new Float64Array(12), new Float64Array(12)]; this.K = [];
    for (let ph = 1; ph < 4; ph++) { const k = []; let sum = 0; for (let t = 0; t < 12; t++) { const x = t - 5 - ph / 4; const w = 0.42 + 0.5 * Math.cos(Math.PI * x / 6) + 0.08 * Math.cos(2 * Math.PI * x / 6); const v = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w; k.push(v); sum += v; } this.K.push(k.map((v) => v / sum)); }
  }
  tp(c, x) {
    const h = this.h[c]; h.copyWithin(0, 1); h[11] = x; let m = Math.abs(x);
    for (let ph = 0; ph < 3; ph++) { const k = this.K[ph]; let y = 0; for (let t = 0; t < 12; t++) y += k[t] * h[t]; const a = Math.abs(y); if (a > m) m = a; }
    return m;
  }
  run(l, r, out) {
    const L = this.L, N = L + 1, c = this.ceiling, cc = c * 0.966;
    const a = Math.max(this.tp(0, l), this.tp(1, r));
    this.req[this.ri] = a > cc ? cc / a : 1; this.ri = (this.ri + 1) % N;
    let mn = 1; const req = this.req; for (let k = 0; k < N; k++) if (req[k] < mn) mn = req[k];
    // output is delayed L-1 samples, so averaging over L held values still covers each output sample's own peak
    this.asum += mn - this.avg[this.ai]; this.avg[this.ai] = mn; this.ai = (this.ai + 1) % L;
    if (this.ai === 0) { let sm = 0; for (let k = 0; k < L; k++) sm += this.avg[k]; this.asum = sm; }
    const tg = Math.min(1, this.asum / L);
    this.g = tg < this.g ? tg : tg + (this.g - tg) * this.rc;
    const i = this.i, j = (i + 1) % L, ol = this.dl[0][j], or = this.dl[1][j];
    this.dl[0][i] = l; this.dl[1][i] = r; this.i = j;
    let yl = ol * this.g, yr = or * this.g;
    if (yl > c) yl = c; else if (yl < -c) yl = -c;
    if (yr > c) yr = c; else if (yr < -c) yr = -c;
    out[0] = yl; out[1] = yr;
    if (this.g < 1) { const d = DB(this.g); if (d < this.gr) this.gr = d; }
  }
}

class DSChannel extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'gain', defaultValue: 1, minValue: 0, maxValue: 16, automationRate: 'a-rate' }]; }
  constructor(opt) {
    super();
    const po = (opt && opt.processorOptions) || {};
    this.kind = po.kind || 'track'; this.metering = po.meter !== false;
    const fs = sampleRate; this.fs = fs;
    this.hp = new Biquad(); this.lp = new Biquad();
    this.eq = [new Biquad(), new Biquad(), new Biquad(), new Biquad()];
    this.gate = new Gate(fs); this.comp = new Comp(fs); this.tape = new Tape(fs);
    this.lim = this.kind === 'master' ? new Limiter(fs) : null;
    this.loud = this.kind === 'master' ? new Loudness(fs) : null;
    this.p = { trim: 0, phase: false, hpf: 20, lpf: 20000, eqOn: true, lsF: 80, lsG: 0, lmF: 400, lmG: 0, hmF: 2500, hmG: 0, hsF: 10000, hsG: 0,
      gate: -80, compOn: true, mode: 'compressor', thresh: 0, ratio: 4, attack: 10, release: 120, makeup: 0, tape: 0, limOn: true, ceiling: -1, bypass: false };
    if (po.p) Object.assign(this.p, po.p);
    this.cur = Object.assign({}, this.p); this.dirty = true;
    this.mframes = 0; this.mevery = Math.round(fs / 30);
    this.pk = [0, 0]; this.tp = [0, 0]; this.rmsA = [0, 0]; this.rmsc = Math.exp(-1 / (fs * 0.3));
    this.hist = [new Float32Array(4), new Float32Array(4)]; this.corr = [0, 0, 0];
    this.tmp = [0, 0];
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'set') { Object.assign(this.p, m.p); this.dirty = true; }
      else if (m.type === 'resetLoud' && this.loud) this.loud.reset();
      else if (m.type === 'reset') { this.hp.reset(); this.lp.reset(); this.eq.forEach((b) => b.reset()); }
    };
  }
  updateCoefs() {
    const c = this.cur, p = this.p, fs = this.fs;
    let still = false;
    const glide = (k, f) => { const d = p[k] - c[k]; if (Math.abs(d) > (f || 0.01)) { c[k] += d * 0.35; still = true; } else c[k] = p[k]; };
    ['hpf', 'lpf', 'lsF', 'lmF', 'hmF', 'hsF'].forEach((k) => glide(k, 0.5));
    ['lsG', 'lmG', 'hmG', 'hsG', 'trim'].forEach((k) => glide(k, 0.01));
    ['phase', 'eqOn', 'gate', 'compOn', 'mode', 'thresh', 'ratio', 'attack', 'release', 'makeup', 'tape', 'limOn', 'ceiling', 'bypass'].forEach((k) => (c[k] = p[k]));
    this.hp.on = c.hpf > 21; if (this.hp.on) this.hp.set('hp', c.hpf, 0.707, 0, fs);
    this.lp.on = c.lpf < 19900; if (this.lp.on) this.lp.set('lp', c.lpf, 0.707, 0, fs);
    const q = (g) => 0.55 + Math.min(1, Math.abs(g) / 15) * 0.9;
    const bands = this.kind === 'track'
      ? [['ls', c.lsF, 0.707, c.lsG], ['peak', c.lmF, q(c.lmG), c.lmG], ['peak', c.hmF, q(c.hmG), c.hmG], ['hs', c.hsF, 0.707, c.hsG]]
      : [['ls', 90, 0.6, c.lsG], ['peak', 700, 0.7, c.lmG], ['peak', 3500, 0.8, c.hmG], ['hs', 9000, 0.6, c.hsG]];
    bands.forEach((b, i) => { this.eq[i].on = c.eqOn && Math.abs(b[3]) > 0.05; if (this.eq[i].on) this.eq[i].set(b[0], b[1], b[2], b[3], fs); });
    this.gate.T = c.gate;
    this.compActive = c.compOn && c.thresh < -0.05;
    this.comp.set(c.mode, c.thresh, c.ratio, c.attack, c.release, this.compActive ? c.makeup : 0);
    this.tape.drive = c.tape;
    if (this.lim) this.lim.ceiling = UNDB(c.ceiling);
    this.trimG = UNDB(c.trim) * (c.phase ? -1 : 1);
    this.dirty = still;
  }
  process(inputs, outputs, params) {
    const out = outputs[0]; if (!out || !out[0]) return true;
    const oL = out[0], oR = out[1] || out[0];
    const inp = inputs[0];
    const n = oL.length;
    const iL = inp && inp[0] ? inp[0] : null, iR = inp && inp[1] ? inp[1] : iL;
    if (this.dirty) this.updateCoefs();
    const c = this.cur, gainP = params.gain, gk = gainP.length === 1;
    if (!iL) { oL.fill(0); if (oR !== oL) oR.fill(0); }
    const hp = this.hp, lp = this.lp, eq = this.eq, gate = this.gate, comp = this.comp, tape = this.tape, lim = this.lim, loud = this.loud;
    const gateOn = c.gate > -79.5, tapeOn = c.tape > 0.001, trimG = this.trimG, tmp = this.tmp, bypass = c.bypass;
    const meter = this.metering;
    for (let i = 0; i < n; i++) {
      let l = iL ? iL[i] : 0, r = iR ? iR[i] : 0;
      if (!bypass) {
        l *= trimG; r *= trimG;
        if (hp.on) { l = hp.run(l, 0); r = hp.run(r, 1); }
        if (lp.on) { l = lp.run(l, 0); r = lp.run(r, 1); }
        for (let b = 0; b < 4; b++) if (eq[b].on) { l = eq[b].run(l, 0); r = eq[b].run(r, 1); }
        if (gateOn) { const g = gate.run(l, r); l *= g; r *= g; }
        if (this.compActive) { const g = comp.gain(l, r); l *= g; r *= g; }
        if (tapeOn) { tape.run(l, r, tmp); l = tmp[0]; r = tmp[1]; }
      }
      if (lim) {
        const g = gk ? gainP[0] : gainP[i]; l *= g; r *= g;
        if (c.limOn && !bypass) { lim.run(l, r, tmp); l = tmp[0]; r = tmp[1]; }
        if (meter) this.masterMeter(l, r);
      }
      oL[i] = l; if (oR !== oL) oR[i] = r;
    }
    if (meter) {
      this.mframes += n;
      if (this.mframes >= this.mevery) {
        this.mframes = 0;
        if (lim) {
          const lr = loud.report();
          const cr = this.corr, den = Math.sqrt(cr[1] * cr[2]);
          this.port.postMessage({ t: 'm', pk: this.pk, tp: this.tp, rms: [Math.sqrt(this.rmsA[0]), Math.sqrt(this.rmsA[1])], gr: comp.gr, lim: lim.gr, M: lr.M, S: lr.S, I: lr.I, LRA: lr.LRA, corr: den > 1e-9 ? cr[0] / den : 0 });
          this.pk = [0, 0]; this.tp = [0, 0]; lim.gr = 0; this.corr = [0, 0, 0];
        } else {
          this.port.postMessage({ t: 'm', gr: this.compActive ? comp.gr : 0, gate: gateOn ? gate.g : 1 });
        }
        comp.gr = 0;
      }
    }
    return true;
  }
  masterMeter(l, r) {
    const al = Math.abs(l), ar = Math.abs(r);
    if (al > this.pk[0]) this.pk[0] = al; if (ar > this.pk[1]) this.pk[1] = ar;
    // true-peak estimate: Catmull-Rom 4x between samples
    for (let c = 0; c < 2; c++) {
      const h = this.hist[c]; h[0] = h[1]; h[1] = h[2]; h[2] = h[3]; h[3] = c ? r : l;
      const p0 = h[0], p1 = h[1], p2 = h[2], p3 = h[3];
      for (let k = 1; k <= 3; k++) {
        const t = k / 4, t2 = t * t, t3 = t2 * t;
        const v = Math.abs(0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3));
        if (v > this.tp[c]) this.tp[c] = v;
      }
      if (Math.abs(p2) > this.tp[c]) this.tp[c] = Math.abs(p2);
    }
    const rc = this.rmsc;
    this.rmsA[0] = l * l + (this.rmsA[0] - l * l) * rc; this.rmsA[1] = r * r + (this.rmsA[1] - r * r) * rc;
    this.corr[0] += l * r; this.corr[1] += l * l; this.corr[2] += r * r;
    this.loud.push(l, r);
  }
}

class DSFader extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [
    { name: 'gain', defaultValue: 1, minValue: 0, maxValue: 4, automationRate: 'a-rate' },
    { name: 'pan', defaultValue: 0, minValue: -1, maxValue: 1, automationRate: 'a-rate' }]; }
  constructor(opt) {
    super();
    const po = (opt && opt.processorOptions) || {};
    this.mono = !!po.mono; this.metering = po.meter !== false;
    this.mute = po.mute ? 0 : 1; this.muteT = this.mute; this.mc = Math.exp(-1 / (sampleRate * 0.005));
    this.pk = [0, 0]; this.sq = [0, 0]; this.cnt = 0; this.mevery = Math.round(sampleRate / 30); this.mf = 0;
    this.port.onmessage = (e) => { const m = e.data; if (m.type === 'mute') this.muteT = m.on ? 0 : 1; else if (m.type === 'mono') this.mono = !!m.on; };
  }
  process(inputs, outputs, params) {
    const post = outputs[0], pre = outputs[1];
    const inp = inputs[0];
    const iL = inp && inp[0] ? inp[0] : null, iR = inp && inp[1] ? inp[1] : iL;
    const n = post[0].length;
    const G = params.gain, P = params.pan, gk = G.length === 1, pk = P.length === 1;
    const HP = Math.PI / 2, QP = Math.PI / 4;
    for (let i = 0; i < n; i++) {
      this.mute = this.muteT + (this.mute - this.muteT) * this.mc;
      let l = iL ? iL[i] * this.mute : 0, r = iR ? iR[i] * this.mute : 0;
      if (pre) { pre[0][i] = l; if (pre[1]) pre[1][i] = r; }
      const g = gk ? G[0] : G[i], p = pk ? P[0] : P[i];
      let ol, or;
      if (this.mono) { const m = 0.5 * (l + r), th = (p + 1) * QP; ol = m * Math.cos(th) * g; or = m * Math.sin(th) * g; }
      else if (p > 0) { ol = l * Math.cos(p * HP) * g; or = r * g; }
      else { ol = l * g; or = r * Math.cos(-p * HP) * g; }
      post[0][i] = ol; if (post[1]) post[1][i] = or;
      if (this.metering) {
        const a = Math.abs(ol), b = Math.abs(or);
        if (a > this.pk[0]) this.pk[0] = a; if (b > this.pk[1]) this.pk[1] = b;
        this.sq[0] += ol * ol; this.sq[1] += or * or;
      }
    }
    if (this.metering) {
      this.cnt += n; this.mf += n;
      if (this.mf >= this.mevery) {
        this.port.postMessage({ t: 'm', pk: this.pk, rms: [Math.sqrt(this.sq[0] / this.cnt), Math.sqrt(this.sq[1] / this.cnt)] });
        this.pk = [0, 0]; this.sq = [0, 0]; this.cnt = 0; this.mf = 0;
      }
    }
    return true;
  }
}

class DSRec extends AudioWorkletProcessor {
  constructor() {
    super();
    this.rec = false; this.at = 0; this.buf = null; this.bi = 0; this.bstart = 0; this.CH = 16384;
    this.pk = []; this.mf = 0; this.mevery = Math.round(sampleRate / 25);
    // always-on capture ring: the last 90 seconds of the input, whether or not anything is recording
    this.RL = Math.round(sampleRate * 90); this.ring = null; this.rw = 0; this.rn = 0; this.rend = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'grab') {
        const ch = []; const n = this.rn;
        if (this.ring) for (const r of this.ring) { const o = new Float32Array(n); const s0 = (this.rw - n + this.RL) % this.RL; const a = Math.min(n, this.RL - s0); o.set(r.subarray(s0, s0 + a)); if (a < n) o.set(r.subarray(0, n - a), a); ch.push(o); }
        this.port.postMessage({ t: 'grab', end: this.rend, ch }, ch.map((c) => c.buffer)); return;
      }
      if (m.type === 'start') { this.rec = true; this.at = m.at; this.buf = null; }
      else if (m.type === 'stop') { this.flush(); this.rec = false; this.port.postMessage({ t: 'stopped' }); }
    };
  }
  flush() {
    if (this.buf && this.bi > 0) {
      const ch = this.buf.map((b) => b.slice(0, this.bi));
      this.port.postMessage({ t: 'chunk', frame: this.bstart, ch }, ch.map((c) => c.buffer));
    }
    this.buf = null; this.bi = 0;
  }
  process(inputs, outputs) {
    const inp = inputs[0];
    const nch = inp ? inp.length : 0;
    if (nch === 0) return true;
    const n = inp[0].length;
    while (this.pk.length < nch) this.pk.push(0);
    for (let c = 0; c < nch; c++) { const d = inp[c]; let m = this.pk[c]; for (let i = 0; i < n; i++) { const a = Math.abs(d[i]); if (a > m) m = a; } this.pk[c] = m; }
    if (!this.ring || this.ring.length !== nch) { this.ring = []; for (let c = 0; c < nch; c++) this.ring.push(new Float32Array(this.RL)); this.rw = 0; this.rn = 0; }
    for (let c = 0; c < nch; c++) { const r = this.ring[c], d = inp[c]; let w = this.rw; for (let i = 0; i < n; i++) { r[w] = d[i]; if (++w >= this.RL) w = 0; } }
    this.rw = (this.rw + n) % this.RL; this.rn = Math.min(this.RL, this.rn + n); this.rend = currentFrame + n;
    this.mf += n;
    if (this.mf >= this.mevery) { this.port.postMessage({ t: 'lvl', pk: this.pk.slice(0, nch) }); this.pk.fill(0); this.mf = 0; }
    if (this.rec) {
      const f0 = currentFrame;
      let s = 0;
      if (f0 + n <= this.at) return true;
      if (f0 < this.at) s = this.at - f0;
      for (let i = s; i < n; i++) {
        if (!this.buf) { this.buf = []; for (let c = 0; c < nch; c++) this.buf.push(new Float32Array(this.CH)); this.bi = 0; this.bstart = f0 + i; }
        for (let c = 0; c < nch; c++) this.buf[c][this.bi] = inp[c][i];
        if (++this.bi >= this.CH) this.flush();
      }
    }
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0);
    return true;
  }
}

registerProcessor('ds-channel', DSChannel);
registerProcessor('ds-fader', DSFader);
registerProcessor('ds-rec', DSRec);

// ds-crush: bit depth + sample-rate reduction for the Distortion insert's bitcrush mode
class DSCrush extends AudioWorkletProcessor {
  constructor(opt) { super(); const po = (opt && opt.processorOptions) || {}; this.bits = po.bits || 8; this.rate = po.rate || 0.25; this.ph = 0; this.h = [0, 0]; this.port.onmessage = (e) => { if (e.data.bits) this.bits = e.data.bits; if (e.data.rate) this.rate = e.data.rate; }; }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0]; if (!out[0]) return true;
    const q = Math.pow(2, this.bits - 1);
    for (let c = 0; c < out.length; c++) {
      const i = inp[c] || inp[0], o = out[c];
      if (!i) { o.fill(0); continue; }
      let ph = this.ph, h = this.h[c] || 0;
      for (let k = 0; k < o.length; k++) { ph += this.rate; if (ph >= 1) { ph -= 1; h = Math.round(i[k] * q) / q; } o[k] = h; }
      this.h[c] = h; if (c === out.length - 1) this.ph = ph;
    }
    return true;
  }
}
registerProcessor('ds-crush', DSCrush);
