// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — studio effect processors (v2.3): character compressors, multiband, de-esser,
// transient shaper, saturator, true-peak limiter, doubler, imager. Pure DSP, no analysis models.
const FXdB = (x) => 20 * Math.log10(Math.max(x, 1e-12));
const FXg = (d) => Math.pow(10, d / 20);
const FXtc = (ms, fs) => Math.exp(-1 / (Math.max(0.005, ms) * 0.001 * fs));
const FXZ = new Float32Array(128);
// RBJ biquad, per-channel state
class FXBQ {
  constructor(nch) { this.n = nch || 2; this.z1 = new Float64Array(this.n); this.z2 = new Float64Array(this.n); this.b0 = 1; this.b1 = this.b2 = this.a1 = this.a2 = 0; }
  set(type, f, Q, gain, fs) {
    f = Math.min(f, fs * 0.49); const w = 2 * Math.PI * f / fs, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * (Q || 0.7071)), A = Math.pow(10, (gain || 0) / 40);
    let b0, b1, b2, a0, a1, a2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'hp') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = b0; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * cw; a2 = 1 - al; }
    else if (type === 'peak') { b0 = 1 + al * A; b1 = -2 * cw; b2 = 1 - al * A; a0 = 1 + al / A; a1 = -2 * cw; a2 = 1 - al / A; }
    else if (type === 'ls') { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) - (A - 1) * cw + s); b1 = 2 * A * ((A - 1) - (A + 1) * cw); b2 = A * ((A + 1) - (A - 1) * cw - s); a0 = (A + 1) + (A - 1) * cw + s; a1 = -2 * ((A - 1) + (A + 1) * cw); a2 = (A + 1) + (A - 1) * cw - s; }
    else { const s = 2 * Math.sqrt(A) * al; b0 = A * ((A + 1) + (A - 1) * cw + s); b1 = -2 * A * ((A - 1) + (A + 1) * cw); b2 = A * ((A + 1) + (A - 1) * cw - s); a0 = (A + 1) - (A - 1) * cw + s; a1 = 2 * ((A - 1) - (A + 1) * cw); a2 = (A + 1) - (A - 1) * cw - s; }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0; return this;
  }
  run(x, c) { const y = this.b0 * x + this.z1[c]; this.z1[c] = this.b1 * x - this.a1 * y + this.z2[c]; this.z2[c] = this.b2 * x - this.a2 * y; return y; }
}
// Linkwitz-Riley 4th order (two Butterworth biquads)
class FXLR4 {
  constructor(type, nch) { this.a = new FXBQ(nch); this.b = new FXBQ(nch); this.type = type; }
  set(f, fs) { this.a.set(this.type, f, 0.7071, 0, fs); this.b.set(this.type, f, 0.7071, 0, fs); return this; }
  run(x, c) { return this.b.run(this.a.run(x, c), c); }
}
// static gain computer: gain change in dB (<= 0) for a level in dB
const FXgc = (x, thr, R, knee) => {
  const o = x - thr;
  if (knee > 0 && 2 * Math.abs(o) <= knee) return (1 / R - 1) * (o + knee / 2) * (o + knee / 2) / (2 * knee);
  return o > 0 ? (1 / R - 1) * o : 0;
};

class FXProc extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const po = (o && o.processorOptions) || {};
    this.fs = sampleRate; this.p = Object.assign({}, po.p || {}); this.meter = !!po.meter;
    this.mf = 0; this.every = Math.round(this.fs / 30); this.grMin = 0;
    this.port.onmessage = (e) => { const d = e.data; if (d && d.p) { Object.assign(this.p, d.p); this.update(); } else if (d && d.t && this.msg) this.msg(d); };
    this.init(); this.update();
  }
  init() {} update() {}
  report(n, extra) {
    if (!this.meter) return;
    this.mf += n;
    if (this.mf >= this.every) { this.mf = 0; this.port.postMessage(Object.assign({ gr: this.grMin }, extra ? extra() : {})); this.grMin = 0; }
  }
  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0], n = out[0].length;
    const iL = inp && inp[0] ? inp[0] : FXZ, iR = inp && inp[1] ? inp[1] : iL;
    const oL = out[0], oR = out[1] || out[0];
    this.run(iL, iR, oL, oR, n);
    this.report(n, this.extra && (() => this.extra()));
    return true;
  }
}

// ---------- character compressor: 0 FET, 1 Opto, 2 VCA bus ----------
class DSVComp extends FXProc {
  init() { this.g = 0; this.env = 0; this.comp = 0; this.sc = new FXBQ(2); this.dc = new FXBQ(2); this.dc.set('hp', 12, 0.7, 0, this.fs); }
  update() {
    const p = this.p, fs = this.fs;
    this.inG = FXg(p.inDb || 0); this.outG = FXg(p.out || 0);
    this.at = FXtc(p.att || 1, fs); this.rt = FXtc(p.rel || 100, fs);
    if (p.scHp > 0) this.sc.set('hp', p.scHp, 0.7071, 0, fs);
    this.det = FXtc(p.model === 1 ? 8 : 2, fs);
  }
  run(iL, iR, oL, oR, n) {
    const p = this.p, m = p.model | 0, thr = p.thr, R = p.ratio, knee = p.knee || 0, col = p.color || 0, mix = p.mix === undefined ? 1 : p.mix, fs = this.fs;
    const all = m === 0 && p.all;
    for (let i = 0; i < n; i++) {
      const dl = iL[i], dr = iR[i];
      let l = dl * this.inG, r = dr * this.inG;
      let sl = l, sr = r; if (p.scHp > 0) { sl = this.sc.run(l, 0); sr = this.sc.run(r, 1); }
      let lvl;
      if (m === 1) { const pw = (sl * sl + sr * sr) * 0.5; this.env = this.det * this.env + (1 - this.det) * pw; lvl = 0.5 * FXdB(this.env) + 3; }
      else { const a = Math.max(Math.abs(sl), Math.abs(sr)); if (m === 2) { this.env = Math.max(a, this.env * this.det); lvl = FXdB(this.env); } else lvl = FXdB(a); }
      let tgt = FXgc(lvl, all ? thr - 3 : thr, all ? 20 : R, all ? 0 : knee);
      if (all) tgt *= 1.25;
      if (tgt < this.g) this.g = this.at * this.g + (1 - this.at) * tgt;
      else {
        let rc = this.rt;
        if (m === 1) { // program-dependent: the longer it has been squeezing, the slower it lets go
          this.comp = this.g < -1 ? Math.min(1, this.comp + 1 / (fs * 2)) : Math.max(0, this.comp - 1 / (fs * 4));
          rc = FXtc(60 + 2400 * this.comp * this.comp, fs);
        } else if (m === 2 && p.auto) rc = FXtc(tgt - this.g > 3 ? 120 : 700, fs);
        this.g = rc * this.g + (1 - rc) * tgt;
      }
      if (this.g < this.grMin) this.grMin = this.g;
      const gg = FXg(this.g);
      l *= gg; r *= gg;
      if (col > 0) {
        if (m === 0) { const k = 1 + col * 3; l = Math.tanh(l * k) / k * (1 + col * 0.3); r = Math.tanh(r * k) / k * (1 + col * 0.3); }
        else if (m === 1) { l = this.dc.run(l + col * 0.25 * l * l, 0); r = this.dc.run(r + col * 0.25 * r * r, 1); }
        else { const k = 1 + col; l = Math.tanh(l * k) / k; r = Math.tanh(r * k) / k; }
      }
      l *= this.outG; r *= this.outG;
      oL[i] = dl * (1 - mix) + l * mix; if (oR !== oL) oR[i] = dr * (1 - mix) + r * mix;
    }
  }
}
registerProcessor('ds-vcomp', DSVComp);

// ---------- 3-band compressor with phase-aligned Linkwitz-Riley crossovers ----------
class DSMBand extends FXProc {
  init() {
    this.lp1 = new FXLR4('lp'); this.hp1 = new FXLR4('hp'); this.lp2 = new FXLR4('lp'); this.hp2 = new FXLR4('hp');
    this.apl = new FXLR4('lp'); this.aph = new FXLR4('hp'); this.g = [0, 0, 0]; this.grs = [0, 0, 0];
  }
  update() {
    const p = this.p, fs = this.fs, x1 = Math.min(p.x1, p.x2 * 0.8);
    this.lp1.set(x1, fs); this.hp1.set(x1, fs); this.lp2.set(p.x2, fs); this.hp2.set(p.x2, fs); this.apl.set(p.x2, fs); this.aph.set(p.x2, fs);
    this.at = FXtc(p.att, fs); this.rt = FXtc(p.rel, fs); this.outG = FXg(p.out || 0);
    this.B = [[p.t1, p.r1, FXg(p.g1)], [p.t2, p.r2, FXg(p.g2)], [p.t3, p.r3, FXg(p.g3)]];
  }
  extra() { const r = { bands: this.grs.slice() }; this.grs = [0, 0, 0]; return r; }
  run(iL, iR, oL, oR, n) {
    const B = this.B, solo = this.p.solo | 0;
    const band = [[0, 0], [0, 0], [0, 0]];
    for (let i = 0; i < n; i++) {
      const xl = iL[i], xr = iR[i];
      // low band gets the x2 allpass so the three bands sum flat
      let ll = this.lp1.run(xl, 0), lr = this.lp1.run(xr, 1);
      ll = this.apl.run(ll, 0) + this.aph.run(ll, 0); lr = this.apl.run(lr, 1) + this.aph.run(lr, 1);
      const rl = this.hp1.run(xl, 0), rr = this.hp1.run(xr, 1);
      band[0][0] = ll; band[0][1] = lr;
      band[1][0] = this.lp2.run(rl, 0); band[1][1] = this.lp2.run(rr, 1);
      band[2][0] = this.hp2.run(rl, 0); band[2][1] = this.hp2.run(rr, 1);
      let yl = 0, yr = 0;
      for (let k = 0; k < 3; k++) {
        const b = band[k], lvl = FXdB(Math.max(Math.abs(b[0]), Math.abs(b[1])));
        const tgt = FXgc(lvl, B[k][0], B[k][1], 6);
        this.g[k] = tgt < this.g[k] ? this.at * this.g[k] + (1 - this.at) * tgt : this.rt * this.g[k] + (1 - this.rt) * tgt;
        if (this.g[k] < this.grs[k]) this.grs[k] = this.g[k];
        if (this.g[k] < this.grMin) this.grMin = this.g[k];
        if (solo && solo !== k + 1) continue;
        const gg = FXg(this.g[k]) * B[k][2]; yl += b[0] * gg; yr += b[1] * gg;
      }
      oL[i] = yl * this.outG; if (oR !== oL) oR[i] = yr * this.outG;
    }
  }
}
registerProcessor('ds-mband', DSMBand);

// ---------- de-esser: split (dynamic cut of the sibilant band) or wideband ----------
class DSDeess extends FXProc {
  init() { this.det = new FXBQ(2); this.band = new FXBQ(2); this.env = 0; this.g = 0; }
  update() { const p = this.p, fs = this.fs; this.det.set('hp', p.freq, 0.9, 0, fs); this.band.set('lp', p.freq, 0.7071, 0, fs); this.at = FXtc(0.5, fs); this.rt = FXtc(60, fs); this.envr = FXtc(20, fs); }
  run(iL, iR, oL, oR, n) {
    const p = this.p, thr = p.thr, rng = p.range, split = !(p.mode | 0), listen = p.listen | 0;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      const dl = this.det.run(l, 0), dr = this.det.run(r, 1), a = Math.max(Math.abs(dl), Math.abs(dr));
      this.env = a > this.env ? a : this.env * this.envr;
      const tgt = Math.max(-rng, FXgc(FXdB(this.env), thr, 5, 4));
      this.g = tgt < this.g ? this.at * this.g + (1 - this.at) * tgt : this.rt * this.g + (1 - this.rt) * tgt;
      if (this.g < this.grMin) this.grMin = this.g;
      const gg = FXg(this.g);
      let yl, yr;
      const hl = l - this.band.run(l, 0), hr = r - this.band.run(r, 1);
      if (listen) { yl = hl; yr = hr; }
      else if (split) { yl = l + (gg - 1) * hl; yr = r + (gg - 1) * hr; }
      else { yl = l * gg; yr = r * gg; }
      oL[i] = yl; if (oR !== oL) oR[i] = yr;
    }
  }
}
registerProcessor('ds-deess', DSDeess);

// ---------- transient shaper: attack and sustain from the gap between fast and slow envelopes ----------
class DSTrans extends FXProc {
  init() { this.e = [0, 0, 0, 0]; this.g = 0; }
  update() { const fs = this.fs; this.c = { fa: FXtc(0.5, fs), sa: FXtc(25, fs), r1: FXtc(120, fs), fr: FXtc(25, fs), sr: FXtc(350, fs), sm: FXtc(0.8, fs) }; this.outG = FXg(this.p.out || 0); }
  run(iL, iR, oL, oR, n) {
    const p = this.p, c = this.c, e = this.e, A = (p.attack || 0) / 100, S = (p.sustain || 0) / 100, mix = p.mix === undefined ? 1 : p.mix;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i], x = Math.max(Math.abs(l), Math.abs(r));
      e[0] = x > e[0] ? c.fa * e[0] + (1 - c.fa) * x : c.r1 * e[0] + (1 - c.r1) * x; // fast attack
      e[1] = x > e[1] ? c.sa * e[1] + (1 - c.sa) * x : c.r1 * e[1] + (1 - c.r1) * x; // slow attack
      e[2] = x > e[2] ? c.fa * e[2] + (1 - c.fa) * x : c.sr * e[2] + (1 - c.sr) * x; // slow release
      e[3] = x > e[3] ? c.fa * e[3] + (1 - c.fa) * x : c.fr * e[3] + (1 - c.fr) * x; // fast release
      const dT = Math.min(24, Math.max(0, FXdB(e[0]) - FXdB(e[1]))), dS = Math.min(24, Math.max(0, FXdB(e[2]) - FXdB(e[3])));
      const tgt = Math.max(-18, Math.min(18, A * dT * 1.2 + S * dS * 0.8));
      this.g = c.sm * this.g + (1 - c.sm) * tgt;
      if (this.g < this.grMin) this.grMin = this.g;
      const gg = FXg(this.g) * this.outG;
      oL[i] = l * (1 - mix) + l * gg * mix; if (oR !== oL) oR[i] = r * (1 - mix) + r * gg * mix;
    }
  }
}
registerProcessor('ds-trans', DSTrans);

// ---------- saturator: Tape / Tube / Transformer / Console / Punish, 4x oversampled ----------
class DSSatur extends FXProc {
  init() {
    this.lc = new FXBQ(2); this.hc = new FXBQ(2); this.ls = new FXBQ(2); this.hs = new FXBQ(2); this.xl = new FXBQ(2);
    this.up = [new FXBQ(2), new FXBQ(2)]; this.dn = [new FXBQ(2), new FXBQ(2)]; this.dc = new FXBQ(2);
    this.ri = 0; this.ro = 0; this.ag = 1;
  }
  update() {
    const p = this.p, fs = this.fs;
    this.lc.set('hp', Math.max(10, p.lowcut || 10), 0.7071, 0, fs); this.hc.set('lp', p.highcut || 20000, 0.7071, 0, fs);
    this.ls.set('ls', 700, 0.7, -(p.tone || 0) * 6, fs); this.hs.set('hs', 1400, 0.7, (p.tone || 0) * 6, fs); this.xl.set('lp', 220, 0.7071, 0, fs * 4);
    for (const f of [...this.up, ...this.dn]) f.set('lp', fs * 0.45, 0.7071, 0, fs * 4);
    this.dc.set('hp', 10, 0.7071, 0, fs);
    const nd = FXg(p.drive || 0); if (nd !== this.drv) this.ag = 1 / nd; // auto gain starts from the inverse of the drive
    this.drv = nd; this.outG = FXg(p.out || 0); this.avg = FXtc(300, fs);
  }
  shape(x, c) {
    switch (this.p.style | 0) {
      case 0: return Math.tanh(x + 0.08 * x * x) * 0.95; // tape: soft, a touch asymmetric
      case 1: return x >= 0 ? 1 - Math.exp(-x) : -(1 - Math.exp(x * 1.4)) / 1.4; // tube: even harmonics
      case 2: { const lo = this.xl.run(x, c); return (x - lo) * 0.9 + Math.tanh(lo * 1.8) / 1.4; } // transformer: lows saturate first
      case 3: return Math.sin(Math.max(-1.5707963, Math.min(1.5707963, x))); // console
      default: return Math.max(-1, Math.min(1, Math.tanh(x * 2.2) * 1.15)); // punish
    }
  }
  run(iL, iR, oL, oR, n) {
    const p = this.p, mix = p.mix === undefined ? 1 : p.mix, auto = p.auto === undefined ? 1 : p.auto;
    for (let i = 0; i < n; i++) {
      const dl = iL[i], dr = iR[i]; const ys = [0, 0];
      for (let c = 0; c < 2; c++) {
        let x = this.lc.run(c ? dr : dl, c) * this.drv, acc = 0;
        for (let k = 0; k < 4; k++) {
          let u = this.up[1].run(this.up[0].run(k === 0 ? x * 4 : 0, c), c);
          u = this.shape(u, c);
          acc = this.dn[1].run(this.dn[0].run(u, c), c);
        }
        let y = this.dc.run(acc, c); y = this.hc.run(y, c); y = this.hs.run(this.ls.run(y, c), c); ys[c] = y;
      }
      // auto gain: match the processed level to the input level
      const pin = (dl * dl + dr * dr) * 0.5, pout = (ys[0] * ys[0] + ys[1] * ys[1]) * 0.5;
      this.ri = this.avg * this.ri + (1 - this.avg) * pin; this.ro = this.avg * this.ro + (1 - this.avg) * pout;
      if (auto) { const b = 1 / this.drv, t = Math.min(b * 8, Math.max(b / 8, Math.sqrt((this.ri + 1e-7) / (this.ro + 1e-7)))); this.ag = 0.9995 * this.ag + 0.0005 * t; } else this.ag = 1;
      const g = this.ag * this.outG;
      oL[i] = dl * (1 - mix) + ys[0] * g * mix; if (oR !== oL) oR[i] = dr * (1 - mix) + ys[1] * g * mix;
    }
  }
}
registerProcessor('ds-satur', DSSatur);

// ---------- true-peak limiter: look-ahead, sliding-minimum gain, intersample detection ----------
class DSTPLim extends FXProc {
  init() {
    this.MAX = Math.ceil(this.fs * 0.0051) + 2;
    this.dl = [new Float32Array(this.MAX), new Float32Array(this.MAX)]; this.req = new Float32Array(this.MAX);
    this.dq = new Int32Array(this.MAX); this.qh = 0; this.qt = 0; this.w = 0; this.g = 1; this.t = 0;
    this.hist = [new Float64Array(12), new Float64Array(12)];
    this.avg = new Float64Array(this.MAX); this.ai = 0; this.asum = 0; this.aL = 0; this.grel = 1;
    this.K = [];
    for (let ph = 1; ph < 4; ph++) { const k = []; let sum = 0; for (let t = 0; t < 12; t++) { const x = t - 5 - ph / 4; const w = 0.42 + 0.5 * Math.cos(Math.PI * x / 6) + 0.08 * Math.cos(2 * Math.PI * x / 6); const v = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w; k.push(v); sum += v; } this.K.push(k.map((v) => v / sum)); }
  }
  update() {
    const p = this.p, fs = this.fs;
    this.L = Math.max(10, Math.min(this.MAX - 2, Math.round((p.look || 1.5) * 0.001 * fs)));
    this.c = FXg(p.ceil === undefined ? -1 : p.ceil); this.inG = FXg(p.gain || 0);
    const st = p.style | 0, rel = (p.rel || 80) * [1.4, 0.8, 0.45][st];
    this.rc = FXtc(rel, fs); this.rcSlow = FXtc(rel * 6, fs); this.ac = Math.exp(-1 / (this.L / 3));
  }
  // peak of this sample and of the 4x-oversampled points 6 samples back (windowed-sinc, 12 taps);
  // the look-ahead (at least 10 samples) still covers those older points
  tp(c, x) {
    const h = this.hist[c]; h.copyWithin(0, 1); h[11] = x;
    let m = Math.abs(x);
    if (this.p.tp !== 0) for (let ph = 0; ph < 3; ph++) { const k = this.K[ph]; let y = 0; for (let t = 0; t < 12; t++) y += k[t] * h[t]; const a = Math.abs(y); if (a > m) m = a; }
    return m;
  }
  run(iL, iR, oL, oR, n) {
    const L = this.L, MAX = this.MAX, c = this.c, st = this.p.style | 0;
    for (let i = 0; i < n; i++) {
      let l = iL[i] * this.inG, r = iR[i] * this.inG;
      if (st === 2) { const k = 1 / c; l = Math.tanh(l * k * 0.9) / (k * 0.9); r = Math.tanh(r * k * 0.9) / (k * 0.9); }
      const pk = Math.max(this.tp(0, l), this.tp(1, r));
      const cc = this.p.tp !== 0 ? c * 0.966 : c, q = pk > cc ? cc / pk : 1, t = this.t++; // 0.3 dB margin covers what 4x interpolation misses
      this.req[t % MAX] = q;
      // monotonic deque: minimum of req over the last L+1 samples
      while (this.qt > this.qh && this.req[this.dq[(this.qt - 1) % MAX] % MAX] >= q) this.qt--;
      this.dq[this.qt++ % MAX] = t;
      while (this.dq[this.qh % MAX] < t - L) this.qh++;
      const mn = this.req[this.dq[this.qh % MAX] % MAX];
      // moving average of the held minimum over the look-ahead: reaches the required gain exactly when the peak comes out
      const N = L + 1;
      if (this.aL !== N) { this.aL = N; this.avg.fill(mn, 0, N); this.asum = mn * N; this.ai = 0; }
      this.asum += mn - this.avg[this.ai]; this.avg[this.ai] = mn; this.ai = (this.ai + 1) % N;
      if (this.ai === 0) { let sm = 0; for (let k = 0; k < N; k++) sm += this.avg[k]; this.asum = sm; }
      const a = Math.min(1, this.asum / N);
      this.grel = a < this.grel ? a : a + (this.grel - a) * (st === 0 && this.grel < 0.7 ? this.rcSlow : this.rc);
      this.g = this.grel;
      const w = this.w; this.dl[0][w] = l; this.dl[1][w] = r;
      const rd = (w - L + MAX) % MAX; this.w = (w + 1) % MAX;
      let yl = this.dl[0][rd] * this.g, yr = this.dl[1][rd] * this.g;
      if (yl > c) yl = c; else if (yl < -c) yl = -c;
      if (yr > c) yr = c; else if (yr < -c) yr = -c;
      const gd = FXdB(this.g); if (gd < this.grMin) this.grMin = gd;
      oL[i] = yl; if (oR !== oL) oR[i] = yr;
    }
    if (this.qh > 1e9) { this.qh -= 5e8; this.qt -= 5e8; this.t -= 5e8; for (let k = 0; k < MAX; k++) this.dq[k] -= 5e8; }
  }
}
registerProcessor('ds-tplim', DSTPLim);

// ---------- doubler: two micro-pitch-shifted, slightly delayed voices spread left and right ----------
class DSDoubler extends FXProc {
  init() { this.N = Math.ceil(this.fs * 0.25); this.buf = [new Float32Array(this.N), new Float32Array(this.N)]; this.w = 0; this.ph = [0, 0.5]; this.lp = 0; }
  update() {
    const p = this.p, fs = this.fs;
    this.W = 0.035 * fs; this.base = (p.delay || 12) * 0.001 * fs;
    const c = p.detune || 9; this.rate = [1 - Math.pow(2, c / 1200), 1 - Math.pow(2, -c / 1200)].map((x) => x / this.W);
    this.mod = [0, 0.0012, 0.003][p.style | 0] * fs; this.lr = 2 * Math.PI * 0.45 / fs;
  }
  read(ch, d) { const N = this.N, pos = this.w - d; const i = Math.floor(pos), f = pos - i; const b = this.buf[ch]; const a = b[((i % N) + N) % N], c = b[(((i + 1) % N) + N) % N]; return a + (c - a) * f; }
  voice(ch, v, md) {
    // two taps half a window apart, crossfaded with a triangle, sweep the delay to shift pitch
    let ph = this.ph[v]; let y = 0;
    for (let k = 0; k < 2; k++) { const q = (ph + k * 0.5) % 1; const win = 1 - Math.abs(2 * q - 1); y += win * this.read(ch, this.base + md + q * this.W); }
    return y;
  }
  run(iL, iR, oL, oR, n) {
    const p = this.p, mix = p.mix === undefined ? 0.5 : p.mix, wd = p.width === undefined ? 1 : p.width;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      this.buf[0][this.w % this.N] = l; this.buf[1][this.w % this.N] = r;
      this.lp += this.lr; const md = this.mod * (1 + Math.sin(this.lp)) * 0.5, md2 = this.mod * (1 + Math.cos(this.lp * 1.3)) * 0.5;
      const a = this.voice(0, 0, md), b = this.voice(1, 1, md2);
      for (let v = 0; v < 2; v++) { this.ph[v] += this.rate[v]; if (this.ph[v] >= 1) this.ph[v] -= 1; else if (this.ph[v] < 0) this.ph[v] += 1; }
      this.w = (this.w + 1) % (this.N * 1000);
      const m = (a + b) / 2, s = (a - b) / 2 * wd;
      oL[i] = l * (1 - mix) + (m + s) * mix; if (oR !== oL) oR[i] = r * (1 - mix) + (m - s) * mix;
    }
  }
}
registerProcessor('ds-doubler', DSDoubler);

// ---------- imager: separate low/high stereo width around a crossover (low width 0 = mono bass) ----------
class DSImager extends FXProc {
  init() { this.lp = new FXLR4('lp'); this.hp = new FXLR4('hp'); }
  update() { this.lp.set(this.p.xover || 200, this.fs); this.hp.set(this.p.xover || 200, this.fs); this.outG = FXg(this.p.out || 0); }
  run(iL, iR, oL, oR, n) {
    const lw = this.p.lowW === undefined ? 1 : this.p.lowW, hw = this.p.highW === undefined ? 1 : this.p.highW, g = this.outG;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      const al = this.lp.run(l, 0), ar = this.lp.run(r, 1), bl = this.hp.run(l, 0), br = this.hp.run(r, 1);
      const am = (al + ar) / 2, as = (al - ar) / 2 * lw, bm = (bl + br) / 2, bs = (bl - br) / 2 * hw;
      oL[i] = (am + as + bm + bs) * g; if (oR !== oL) oR[i] = (am - as + bm - bs) * g;
    }
  }
}
registerProcessor('ds-imager', DSImager);
