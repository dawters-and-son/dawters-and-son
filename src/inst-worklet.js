// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — instrument processor (ds-inst): VA synth, drum synth (+ per-pad samples), sampler.
// Events are queued with absolute frame numbers, so live playback and offline renders are sample-accurate.
// Event = [frame, kind, note, velocity]  kind: 1 note on, 0 note off

const PI2 = Math.PI * 2;
const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
const blep = (t, dt) => { // polyBLEP residual
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
};

class Env { // linear-attack, exponential decay/release ADSR
  constructor() { this.v = 0; this.stage = 0; }
  on(a, d, s, r, fs) { this.stage = 1; this.ai = 1 / Math.max(1, a * fs); this.dc = Math.exp(-4.6 / Math.max(1, d * fs)); this.s = s; this.rc = Math.exp(-4.6 / Math.max(1, r * fs)); }
  off() { if (this.stage && this.stage < 4) this.stage = 4; }
  next() {
    switch (this.stage) {
      case 1: this.v += this.ai; if (this.v >= 1) { this.v = 1; this.stage = 2; } break;
      case 2: this.v = this.s + (this.v - this.s) * this.dc; if (Math.abs(this.v - this.s) < 1e-4) { this.v = this.s; this.stage = 3; } break;
      case 3: break;
      case 4: this.v *= this.rc; if (this.v < 1e-5) { this.v = 0; this.stage = 0; } break;
      default: this.v = 0;
    }
    return this.v;
  }
}

class SVF { // Simper/Cytomic trapezoidal state-variable filter
  constructor() { this.a = 0; this.b = 0; this.g = 0; this.k = 1; this.a1 = 0; this.a2 = 0; this.a3 = 0; }
  set(fc, q, fs) { const g = Math.tan(Math.PI * Math.min(fc, fs * 0.45) / fs), k = 1 / q; this.a1 = 1 / (1 + g * (g + k)); this.a2 = g * this.a1; this.a3 = g * this.a2; this.k = k; }
  run(x, mode) {
    const v3 = x - this.b, v1 = this.a1 * this.a + this.a2 * v3, v2 = this.b + this.a2 * this.a + this.a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b;
    return mode === 1 ? x - this.k * v1 - v2 : mode === 2 ? v1 : v2; // 0 low, 1 high, 2 band
  }
}

// ---------------- VA synth ----------------
const WAVES = ['saw', 'square', 'tri', 'sine'];
class SynthVoice {
  constructor() { this.amp = new Env(); this.fenv = new Env(); this.f1 = new SVF(); this.f2 = new SVF(); this.p1 = 0; this.p2 = 0; this.ps = 0; this.note = -1; this.age = 0; this.freq = 440; this.target = 440; this.vel = 1; this.ctl = 0; }
  get active() { return this.amp.stage !== 0; }
}
class Synth {
  constructor(fs, p) { this.fs = fs; this.v = Array.from({ length: 10 }, () => new SynthVoice()); this.p = p; this.lfo = 0; this.clock = 0; this.held = []; this.noise = 12345; }
  rnd() { this.noise = (this.noise * 1103515245 + 12345) & 0x7fffffff; return this.noise / 0x3fffffff - 1; }
  on(n, vel) {
    const p = this.p; this.clock++;
    if (p.mono) {
      const v = this.v[0], legato = v.active && v.amp.stage < 4;
      v.target = mtof(n);
      if (!legato || !p.glide) v.freq = v.target;
      v.note = n; v.vel = vel; v.age = this.clock;
      if (!legato) { v.amp.on(p.a, p.d, p.s, p.r, this.fs); v.fenv.on(p.fa, p.fd, p.fs, p.fr, this.fs); }
      this.held = this.held.filter((x) => x !== n); this.held.push(n);
      return;
    }
    let v = this.v.find((x) => !x.active) || this.v.reduce((a, b) => (a.amp.stage === 4 && b.amp.stage !== 4 ? a : b.amp.stage === 4 && a.amp.stage !== 4 ? b : a.age < b.age ? a : b));
    v.note = n; v.vel = vel; v.age = this.clock; v.freq = v.target = mtof(n);
    if (!v.active) { v.p1 = Math.random(); v.p2 = Math.random(); }
    v.amp.on(p.a, p.d, p.s, p.r, this.fs); v.fenv.on(p.fa, p.fd, p.fs, p.fr, this.fs);
  }
  off(n) {
    const p = this.p;
    if (p.mono) {
      this.held = this.held.filter((x) => x !== n);
      const v = this.v[0];
      if (this.held.length) { const m = this.held[this.held.length - 1]; v.note = m; v.target = mtof(m); if (!p.glide) v.freq = v.target; }
      else { v.amp.off(); v.fenv.off(); }
      return;
    }
    for (const v of this.v) if (v.note === n && v.amp.stage && v.amp.stage < 4) { v.amp.off(); v.fenv.off(); }
  }
  allOff(hard) { for (const v of this.v) { if (hard) { v.amp.stage = 0; v.amp.v = 0; } else { v.amp.off(); v.fenv.off(); } } this.held = []; }
  osc(w, ph, dt, pw) {
    if (w === 0) return 2 * ph - 1 - blep(ph, dt);
    if (w === 1) { let y = ph < pw ? 1 : -1; y += blep(ph, dt); y -= blep((ph + 1 - pw) % 1, dt); return y; }
    if (w === 2) return 1 - 4 * Math.abs(ph - 0.5);
    return Math.sin(PI2 * ph);
  }
  render(L, R, s, e) {
    const p = this.p, fs = this.fs, w1 = WAVES.indexOf(p.o1w), w2 = WAVES.indexOf(p.o2w);
    const r1 = Math.pow(2, p.o1oct + p.o1semi / 12), r2 = Math.pow(2, p.o2oct + (p.o2semi + p.o2det / 100) / 12);
    const mode = p.ftype === 'hp' ? 1 : p.ftype === 'bp' ? 2 : 0, poles = p.ftype === 'lp24' ? 2 : 1;
    const gl = p.glide > 0 ? Math.exp(-1 / (p.glide * fs)) : 0, gain = Math.pow(10, p.vol / 20) * 0.28;
    const lfoInc = p.lrate / fs, q = 0.5 + p.res * 9.5;
    const pan = p.width || 0;
    for (const v of this.v) {
      if (!v.active) continue;
      for (let i = s; i < e; i++) {
        if (((i - s) & 15) === 0) {
          const lf = this.lfoVal(i - s, lfoInc);
          const fe = v.fenv.v;
          const kt = (v.note - 60) / 12 * p.fkey;
          const oct = Math.log2(Math.max(20, p.cut) / 20) + p.fenv * 6 * fe + kt + p.lcut * lf + (v.vel - 0.7) * p.vfilt * 3;
          const fc = Math.min(fs * 0.45, 20 * Math.pow(2, oct));
          v.f1.set(fc, q, fs); if (poles === 2) { v.f2.a1 = v.f1.a1; v.f2.a2 = v.f1.a2; v.f2.a3 = v.f1.a3; v.f2.k = v.f1.k; }
          v.ctl = lf;
        }
        if (gl) v.freq = v.target + (v.freq - v.target) * gl; else v.freq = v.target;
        const pm = Math.pow(2, (p.lpitch * v.ctl) / 1200);
        const f1 = v.freq * r1 * pm, f2 = v.freq * r2 * pm;
        const d1 = f1 / fs, d2 = f2 / fs;
        let x = this.osc(w1, v.p1, d1, p.pw) * (1 - p.mix) + this.osc(w2, v.p2, d2, p.pw) * p.mix;
        if (p.sub) { x += p.sub * Math.sin(PI2 * v.ps); v.ps += d1 / 2; if (v.ps >= 1) v.ps -= 1; }
        if (p.noise) x += p.noise * this.rnd();
        v.p1 += d1; if (v.p1 >= 1) v.p1 -= 1; v.p2 += d2; if (v.p2 >= 1) v.p2 -= 1;
        let y = v.f1.run(x, mode); if (poles === 2) y = v.f2.run(y, mode);
        const fenv = v.fenv.next(); void fenv;
        const a = v.amp.next() * gain * (1 - p.vsens + p.vsens * v.vel);
        y *= a;
        L[i] += y * (1 - pan * 0.5); R[i] += y * (1 + pan * 0.5);
        if (!v.active) break;
      }
    }
    this.lfo += lfoInc * (e - s); if (this.lfo >= 1) this.lfo -= Math.floor(this.lfo);
  }
  lfoVal(off, inc) {
    const ph = (this.lfo + off * inc) % 1, sh = this.p.lshape;
    return sh === 1 ? (ph < 0.5 ? 1 : -1) : sh === 2 ? 2 * ph - 1 : Math.sin(PI2 * ph);
  }
}

// ---------------- drum synth ----------------
const PADS = [36, 38, 39, 42, 46, 45, 50, 56];
class Hit {
  constructor() { this.on = false; }
}
class Drums {
  constructor(fs, p, samples) { this.fs = fs; this.p = p; this.hits = Array.from({ length: 24 }, () => new Hit()); this.samples = samples || {}; this.seed = 777; }
  rnd() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x3fffffff - 1; }
  on(n, vel) {
    const pad = PADS.indexOf(n); if (pad < 0) return;
    const pp = this.p.pads[pad]; if (!pp) return;
    if (pad === 3) for (const h of this.hits) if (h.on && h.pad === 4) h.choke = true; // closed hat chokes open hat
    const h = this.hits.find((x) => !x.on) || this.hits.reduce((a, b) => (a.t > b.t ? a : b));
    Object.assign(h, { on: true, pad, vel, t: 0, ph: 0, ph2: 0, z1: 0, z2: 0, z3: 0, choke: false, cg: 1, hp: 0, bp1: new SVF(), bp2: new SVF(), smp: this.samples[n] || null, pos: 0 });
    const fs = this.fs, tune = Math.pow(2, pp.tune / 12);
    h.tune = tune; h.dec = Math.max(0.02, pp.decay); h.lvl = Math.pow(10, pp.level / 20); h.tone = pp.tone; h.pan = pp.pan || 0;
    if (pad === 1) h.bp1.set(1800 * tune * (0.6 + pp.tone), 0.8, fs);
    if (pad === 2) h.bp1.set(1100 * tune, 1.6, fs);
    if (pad === 3 || pad === 4) { h.bp1.set(7500 * tune, 0.9, fs); h.bp2.set(10500 * tune, 1.2, fs); }
    if (pad === 7) h.bp1.set(845 * tune, 3, fs);
  }
  off() { /* drums are one-shots */ }
  allOff(hard) { if (hard) for (const h of this.hits) h.on = false; }
  render(L, R, s, e) {
    const fs = this.fs, dt = 1 / fs, gain = Math.pow(10, this.p.vol / 20);
    for (const h of this.hits) {
      if (!h.on) continue;
      const lg = (1 - h.pan) * 0.5 + 0.5, rg = (1 + h.pan) * 0.5 + 0.5;
      for (let i = s; i < e; i++) {
        let y = 0;
        const t = h.t;
        if (h.smp) {
          const d = h.smp.ch, sr = h.smp.sr, pos = h.pos, k = pos | 0, fr = pos - k;
          if (k + 1 >= d[0].length) { h.on = false; break; }
          const a = d[0][k] + (d[0][k + 1] - d[0][k]) * fr;
          const b = d.length > 1 ? d[1][k] + (d[1][k + 1] - d[1][k]) * fr : a;
          const env = Math.min(1, Math.exp(-Math.max(0, t - h.dec) * 8));
          const g = h.lvl * h.vel * env * gain * h.cg;
          L[i] += a * g * lg; R[i] += b * g * rg;
          h.pos += h.tune * sr / fs;
          if (h.choke) { h.cg *= 0.995; if (h.cg < 1e-3) { h.on = false; break; } }
          h.t += dt; if (env < 1e-4) { h.on = false; break; }
          continue;
        }
        switch (h.pad) {
          case 0: { // kick: sine with pitch sweep + click
            const f = 48 * h.tune + 140 * h.tune * Math.exp(-t * (28 + h.tone * 30));
            h.ph += f * dt; y = Math.sin(PI2 * h.ph) * Math.exp(-t / (h.dec * 0.55));
            y += (t < 0.004 ? this.rnd() * (1 - t / 0.004) * 0.35 * h.tone : 0);
            y = Math.tanh(y * (1.2 + h.tone)); break;
          }
          case 1: { // snare: two tones + filtered noise
            h.ph += 185 * h.tune * dt; h.ph2 += 330 * h.tune * dt;
            const tone = (Math.sin(PI2 * h.ph) * 0.6 + Math.sin(PI2 * h.ph2) * 0.4) * Math.exp(-t / 0.06);
            const nz = h.bp1.run(this.rnd(), 2) * Math.exp(-t / (h.dec * 0.5));
            y = tone * (1 - h.tone * 0.6) + nz * (1.2 + h.tone); break;
          }
          case 2: { // clap: three bursts then a tail
            const nz = h.bp1.run(this.rnd(), 2);
            let env = 0; for (const o of [0, 0.011, 0.023]) if (t >= o) env = Math.max(env, Math.exp(-(t - o) / 0.009));
            if (t >= 0.031) env = Math.max(env, 0.9 * Math.exp(-(t - 0.031) / (h.dec * 0.35)));
            y = nz * env * 2.2; break;
          }
          case 3: case 4: { // hats: metallic squares through band-pass
            let m = 0; const base = 330 * h.tune;
            const ratios = [2, 3, 4.16, 5.43, 6.79, 8.21];
            if (!h.phs) h.phs = new Float64Array(6);
            for (let k = 0; k < 6; k++) { h.phs[k] += base * ratios[k] * dt; if (h.phs[k] >= 1) h.phs[k] -= 1; m += h.phs[k] < 0.5 ? 1 : -1; }
            m = m / 6 + this.rnd() * 0.3 * h.tone;
            const x = h.bp2.run(h.bp1.run(m, 1), 1);
            const d = h.pad === 3 ? h.dec * 0.12 : h.dec * 0.7;
            y = x * Math.exp(-t / d) * 1.4;
            if (h.choke) { h.cg *= 0.993; }
            y *= h.cg; break;
          }
          case 5: case 6: { // toms
            const f0 = (h.pad === 5 ? 95 : 150) * h.tune;
            const f = f0 * (1 + 0.6 * Math.exp(-t * 18));
            h.ph += f * dt; y = Math.sin(PI2 * h.ph) * Math.exp(-t / (h.dec * 0.5));
            y += this.rnd() * Math.exp(-t * 60) * 0.15 * h.tone; break;
          }
          case 7: { // cowbell / perc
            h.ph += 540 * h.tune * dt; h.ph2 += 800 * h.tune * dt;
            const x = ((h.ph % 1) < 0.5 ? 1 : -1) + ((h.ph2 % 1) < 0.5 ? 1 : -1);
            y = h.bp1.run(x * 0.5, 2) * (Math.exp(-t / 0.02) * 0.5 + 0.5 * Math.exp(-t / (h.dec * 0.4))) * 1.5; break;
          }
        }
        const g = h.lvl * h.vel * gain * 0.6;
        L[i] += y * g * lg; R[i] += y * g * rg;
        h.t += dt;
        if (h.t > 0.02 && h.t > h.dec * 3 + 0.05) { h.on = false; break; }
        if (h.cg < 1e-3) { h.on = false; break; }
      }
    }
  }
}

// ---------------- sampler ----------------
class Sampler {
  constructor(fs, p, smp) { this.fs = fs; this.p = p; this.smp = smp; this.v = Array.from({ length: 16 }, () => ({ amp: new Env(), on: false, pos: 0, f: new SVF() })); this.clock = 0; }
  on(n, vel) {
    if (!this.smp) return;
    const p = this.p; this.clock++;
    const v = this.v.find((x) => !x.amp.stage) || this.v.reduce((a, b) => (a.age < b.age ? a : b));
    v.note = n; v.vel = vel; v.age = this.clock;
    v.rate = (p.track ? Math.pow(2, (n - p.root + p.tune / 100) / 12) : Math.pow(2, p.tune / 1200)) * this.smp.sr / this.fs;
    v.pos = p.start * this.smp.ch[0].length;
    v.amp.on(p.a, p.d, p.s, p.r, this.fs);
  }
  off(n) { if (this.p.oneshot) return; for (const v of this.v) if (v.note === n && v.amp.stage && v.amp.stage < 4) v.amp.off(); }
  allOff(hard) { for (const v of this.v) { if (hard) { v.amp.stage = 0; } else v.amp.off(); } }
  render(L, R, s, e) {
    if (!this.smp) return;
    const p = this.p, d = this.smp.ch, len = d[0].length, gain = Math.pow(10, p.vol / 20);
    const ls = Math.floor(p.lstart * len), fcBase = p.cut;
    for (const v of this.v) {
      if (!v.amp.stage) continue;
      v.f.set(Math.min(this.fs * 0.45, fcBase * (0.4 + 0.6 * (1 - p.vsens + p.vsens * v.vel))), 0.5 + p.res * 6, this.fs);
      for (let i = s; i < e; i++) {
        let k = v.pos | 0;
        if (k + 1 >= len) { if (p.loop && len - ls > 64) { v.pos = ls + (v.pos - (len - 1)); k = v.pos | 0; } else { v.amp.stage = 0; break; } }
        const fr = v.pos - k;
        let a = d[0][k] + (d[0][k + 1] - d[0][k]) * fr;
        let b = d.length > 1 ? d[1][k] + (d[1][k + 1] - d[1][k]) * fr : a;
        const g = v.amp.next() * gain * (1 - p.vsens + p.vsens * v.vel);
        if (p.cut < 19000) { a = v.f.run(a, 0); b = a; }
        L[i] += a * g; R[i] += b * g;
        v.pos += v.rate;
        if (!v.amp.stage) break;
      }
    }
  }
}

class DSInst extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const po = (opt && opt.processorOptions) || {};
    this.q = (po.events || []).slice().sort((a, b) => a[0] - b[0]); this.qi = 0;
    this.build(po.type, po.p, po.samples);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'ev') { this.q = this.q.slice(this.qi).concat(m.ev).sort((a, b) => a[0] - b[0]); this.qi = 0; }
      else if (m.t === 'clear') { this.q = []; this.qi = 0; this.inst.allOff(false); }
      else if (m.t === 'panic') { this.q = []; this.qi = 0; this.inst.allOff(true); }
      else if (m.t === 'now') { if (m.k) this.inst.on(m.n, m.v); else this.inst.off(m.n); }
      else if (m.t === 'set') { Object.assign(this.inst.p, m.p); if (m.p.pads) this.inst.p.pads = m.p.pads; }
      else if (m.t === 'build') this.build(m.type, m.p, m.samples);
      else if (m.t === 'samples') { if (this.inst instanceof Drums) this.inst.samples = m.samples || {}; else if (this.inst instanceof Sampler) this.inst.smp = m.samples && m.samples.main; }
    };
  }
  build(type, p, samples) {
    p = Object.assign({}, p);
    this.type = type;
    if (type === 'drums') this.inst = new Drums(sampleRate, p, samples || {});
    else if (type === 'sampler') this.inst = new Sampler(sampleRate, p, samples && samples.main);
    else this.inst = new Synth(sampleRate, p);
  }
  process(inputs, outputs) {
    const out = outputs[0]; if (!out || !out[0]) return true;
    const L = out[0], R = out[1] || out[0], n = L.length, f0 = currentFrame;
    L.fill(0); if (R !== L) R.fill(0);
    let s = 0;
    const q = this.q;
    while (s < n) {
      while (this.qi < q.length && q[this.qi][0] <= f0 + s) { const ev = q[this.qi++]; if (ev[1]) this.inst.on(ev[2], ev[3]); else this.inst.off(ev[2]); }
      let e = n;
      if (this.qi < q.length) e = Math.min(n, Math.max(s + 1, q[this.qi][0] - f0));
      this.inst.render(L, R === L ? new Float32Array(n) : R, s, e);
      s = e;
    }
    if (this.qi > 512) { this.q = q.slice(this.qi); this.qi = 0; }
    return true;
  }
}
registerProcessor('ds-inst', DSInst);
