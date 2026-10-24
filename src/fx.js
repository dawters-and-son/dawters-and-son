// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — insert effects registry.
// Every effect is { name, short, params:[spec], create(ctx, p, env) -> { input, output, set(p), dispose() } }.
// The registry is the plugin hook: future Web Audio Modules / native-host bridges register here.
'use strict';
const FX = {};
FX.SYNC = ['Free', '1/2', '1/4', '1/4 dot', '1/4 trip', '1/8', '1/8 dot', '1/8 trip', '1/16'];
FX.syncSec = (i, bpm) => { const q = 60 / bpm; return [0, 2 * q, q, 1.5 * q, 2 / 3 * q, q / 2, 0.75 * q, q / 3, q / 4][i] || 0; };

const lfo = (ctx, rate, type) => { const o = ctx.createOscillator(); o.type = type || 'sine'; o.frequency.value = rate; o.start(); return o; };
const mixer = (ctx) => {
  const input = ctx.createGain(), output = ctx.createGain(), dry = ctx.createGain(), wet = ctx.createGain();
  input.connect(dry); dry.connect(output); wet.connect(output);
  return { input, output, dry, wet, setMix(m) { const t = ctx.currentTime; dry.gain.setTargetAtTime(Math.cos(m * Math.PI / 2), t, 0.02); wet.gain.setTargetAtTime(Math.sin(m * Math.PI / 2), t, 0.02); } };
};

FX.types = {
  eleopedals: {
    name: 'Eleosynth Pedalboard', short: 'Pedals', suite: 'eleo', params: [],
    about: "Eleosynth's guitar pedalboard as an insert: record your guitar clean, hear it through the pedals, and change the pedals any time afterwards (re-amping). Takes are always recorded dry. When the tone is right, Track → Freeze prints the pedals to a new audio track.",
    create(ctx, p, env) { return SUITE.fxNode(ctx, env || {}); },
  },
  reverb: {
    name: 'Reverb', short: 'Reverb',
    params: [
      { k: 'room', n: 'Room', opts: ['Plate', 'Room', 'Hall', 'Cathedral', 'Spring', 'Chamber', 'Ambience'], def: 2 },
      { k: 'decay', n: 'Decay', min: 0.2, max: 8, def: 2.2, u: 's', log: true },
      { k: 'pre', n: 'Pre-delay', min: 0, max: 200, def: 20, u: 'ms' },
      { k: 'damp', n: 'Damping', min: 0, max: 1, def: 0.5 },
      { k: 'width', n: 'Width', min: 0, max: 1, def: 1 },
      { k: 'lowcut', n: 'Low cut', min: 20, max: 1000, def: 80, u: 'Hz', log: true },
      { k: 'mod', n: 'Modulation', min: 0, max: 1, def: 0.2 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 0.25 },
    ],
    about: 'Plate, rooms, halls, a boingy Spring, a dense Chamber and short Ambience. Modulation adds a lush, slightly chorused tail (think VintageVerb).',
    create(ctx, p) {
      const m = mixer(ctx), pre = ctx.createDelay(0.5), conv = ctx.createConvolver();
      const lo = ctx.createBiquadFilter(); lo.type = 'highshelf'; lo.frequency.value = 6000;
      const lc = ctx.createBiquadFilter(); lc.type = 'highpass'; lc.Q.value = 0.6;
      const md = ctx.createDelay(0.05), mo = lfo(ctx, 0.37), mg = ctx.createGain(); md.delayTime.value = 0.012; mo.connect(mg); mg.connect(md.delayTime);
      m.input.connect(pre); pre.connect(conv); conv.connect(lo); lo.connect(lc); lc.connect(md); md.connect(m.wet);
      let key = '';
      const build = () => {
        const k = [p.room, p.decay, p.damp, p.width].join('|'); if (k === key) return; key = k;
        const sr = ctx.sampleRate, dec = (p.room | 0) === 6 ? Math.min(p.decay, 0.7) : p.decay, len = Math.min(10, dec * 1.3 + 0.1) * sr | 0;
        const ir = ctx.createBuffer(2, len, sr);
        const room = p.room | 0;
        if (room === 4) { conv.buffer = FX.springIR(ctx, p); return; }
        const early = [[0.004, 0.011, 0.019, 0.027], [0.007, 0.013, 0.022, 0.031], [0.011, 0.023, 0.037, 0.051], [0.019, 0.041, 0.067, 0.089], null,
          [0.003, 0.006, 0.009, 0.013, 0.017, 0.021, 0.026, 0.032], [0.002, 0.005, 0.008, 0.012, 0.015, 0.019]][room];
        const dens = [1, 0.8, 0.7, 0.6, 1, 0.9, 0.8][room];
        let seed = 12345;
        const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
        const dataL = ir.getChannelData(0), dataR = ir.getChannelData(1);
        for (let c = 0; c < 2; c++) {
          const d = c ? dataR : dataL; let lp = 0;
          for (let i = 0; i < len; i++) {
            const t = i / sr, env = Math.pow(10, -3 * t / dec);
            const cut = 0.9 - p.damp * 0.85 * Math.min(1, t / dec * 1.5);
            const x = rnd() * dens; lp += (x - lp) * Math.max(0.03, cut);
            d[i] = lp * env;
          }
          for (const e of early) { const i = Math.floor((e + (c ? 0.0023 : 0)) * sr); if (i < len) d[i] += (c ? 0.5 : 0.6) * (0.9 - e * 4); }
        }
        // width: blend toward mono
        const w = p.width;
        for (let i = 0; i < len; i++) { const a = dataL[i], b = dataR[i], mid = (a + b) / 2; dataL[i] = mid + (a - mid) * w; dataR[i] = mid + (b - mid) * w; }
        conv.buffer = ir;
      };
      const set = () => { const t = ctx.currentTime; pre.delayTime.setTargetAtTime(p.pre / 1000, t, 0.02); lo.gain.value = -p.damp * 9; lc.frequency.setTargetAtTime(p.lowcut || 20, t, 0.02); mg.gain.setTargetAtTime((p.mod || 0) * 0.0025, t, 0.05); m.setMix(p.mix); build(); };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, dispose() { mo.stop(); [m.input, m.output, pre, conv, lo, lc, md, mo, mg].forEach((n) => n.disconnect()); } };
    },
  },
  delay: {
    name: 'Delay', short: 'Delay',
    params: [
      { k: 'sync', n: 'Sync', opts: FX.SYNC, def: 6 },
      { k: 'time', n: 'Time', min: 10, max: 2000, def: 375, u: 'ms', log: true },
      { k: 'fb', n: 'Feedback', min: 0, max: 0.95, def: 0.35 },
      { k: 'tone', n: 'Tone', min: 500, max: 16000, def: 5000, u: 'Hz', log: true },
      { k: 'pp', n: 'Ping-pong', opts: ['Off', 'On'], def: 0 },
      { k: 'style', n: 'Style', opts: ['Digital', 'Tape', 'Analog'], def: 0 },
      { k: 'wow', n: 'Wow & flutter', min: 0, max: 1, def: 0.3 },
      { k: 'sat', n: 'Saturation', min: 0, max: 1, def: 0.3 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 0.25 },
    ],
    about: 'Clean digital repeats, or Tape and Analog styles that wobble, darken and saturate with every repeat (think EchoBoy).',
    create(ctx, p, env) {
      const m = mixer(ctx), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const dL = ctx.createDelay(4), dR = ctx.createDelay(4), fL = ctx.createGain(), fR = ctx.createGain();
      const tL = ctx.createBiquadFilter(), tR = ctx.createBiquadFilter(); tL.type = tR.type = 'lowpass';
      const hL = ctx.createBiquadFilter(), hR = ctx.createBiquadFilter(); hL.type = hR.type = 'highpass'; hL.frequency.value = hR.frequency.value = 120;
      const inL = ctx.createGain(), inR = ctx.createGain();
      m.input.connect(split); split.connect(inL, 0); split.connect(inR, 1);
      inL.connect(dL); inR.connect(dR);
      dL.connect(tL); tL.connect(hL); dR.connect(tR); tR.connect(hR);
      hL.connect(merge, 0, 0); hR.connect(merge, 0, 1); merge.connect(m.wet);
      // feedback runs through a saturator; tape adds wow (slow) and flutter (fast) on the delay time
      const sL = ctx.createWaveShaper(), sR = ctx.createWaveShaper(); sL.oversample = sR.oversample = '2x';
      hL.connect(sL); sL.connect(fL); hR.connect(sR); sR.connect(fR);
      const wow = lfo(ctx, 0.55), flut = lfo(ctx, 6.3), wg = ctx.createGain(), fg = ctx.createGain();
      wow.connect(wg); flut.connect(fg); [wg, fg].forEach((g) => { g.connect(dL.delayTime); g.connect(dR.delayTime); });
      let sk = '';
      let pp = -1;
      const route = () => {
        if (pp === p.pp) return; pp = p.pp;
        try { fL.disconnect(); fR.disconnect(); } catch (e) { /* none */ }
        if (p.pp) { fL.connect(dR); fR.connect(dL); inR.gain.value = 0; inL.gain.value = 1; }
        else { fL.connect(dL); fR.connect(dR); inR.gain.value = 1; inL.gain.value = 1; }
      };
      const set = () => {
        const t = ctx.currentTime, sec = p.sync ? FX.syncSec(p.sync, env.bpm) : p.time / 1000;
        dL.delayTime.setTargetAtTime(sec, t, 0.03); dR.delayTime.setTargetAtTime(sec, t, 0.03);
        fL.gain.setTargetAtTime(p.fb, t, 0.02); fR.gain.setTargetAtTime(p.fb, t, 0.02);
        const st = p.style | 0, tone = st === 2 ? Math.min(p.tone, 3500) : p.tone;
        tL.frequency.setTargetAtTime(tone, t, 0.02); tR.frequency.setTargetAtTime(tone, t, 0.02);
        wg.gain.setTargetAtTime(st === 1 ? p.wow * 0.0035 : st === 2 ? p.wow * 0.0008 : 0, t, 0.05);
        fg.gain.setTargetAtTime(st === 1 ? p.wow * 0.00035 : 0, t, 0.05);
        const k2 = st + '|' + p.sat;
        // tanh(x·d)/d has unity slope at zero, so the feedback loop can never run away
        if (k2 !== sk) { sk = k2; const n = 1024, c = new Float32Array(n), d = st ? 1 + p.sat * 4 : 1; for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = st ? Math.tanh(x * d) / d : x; } sL.curve = c; sR.curve = c; }
        route(); m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, tempo() { set(); }, dispose() { wow.stop(); flut.stop(); [m.input, m.output, split, merge, dL, dR, fL, fR, tL, tR, hL, hR, inL, inR, sL, sR, wow, flut, wg, fg].forEach((n) => n.disconnect()); } };
    },
  },
  chorus: {
    name: 'Chorus / Flanger', short: 'Chorus',
    params: [
      { k: 'mode', n: 'Mode', opts: ['Chorus', 'Flanger'], def: 0 },
      { k: 'rate', n: 'Rate', min: 0.05, max: 8, def: 0.6, u: 'Hz', log: true },
      { k: 'depth', n: 'Depth', min: 0, max: 1, def: 0.5 },
      { k: 'fb', n: 'Feedback', min: 0, max: 0.9, def: 0.2 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 0.5 },
    ],
    create(ctx, p) {
      const m = mixer(ctx), split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
      const dL = ctx.createDelay(0.1), dR = ctx.createDelay(0.1), fL = ctx.createGain(), fR = ctx.createGain();
      const o = lfo(ctx, p.rate), gL = ctx.createGain(), gR = ctx.createGain();
      o.connect(gL); o.connect(gR);
      gL.connect(dL.delayTime); gR.connect(dR.delayTime);
      m.input.connect(split); split.connect(dL, 0); split.connect(dR, 1);
      dL.connect(merge, 0, 0); dR.connect(merge, 0, 1); merge.connect(m.wet);
      dL.connect(fL); fL.connect(dL); dR.connect(fR); fR.connect(dR);
      const set = () => {
        const t = ctx.currentTime, fl = p.mode === 1;
        const base = fl ? 0.0028 : 0.016, dep = (fl ? 0.0024 : 0.007) * p.depth;
        dL.delayTime.setTargetAtTime(base, t, 0.02); dR.delayTime.setTargetAtTime(base, t, 0.02);
        gL.gain.setTargetAtTime(dep, t, 0.02); gR.gain.setTargetAtTime(-dep, t, 0.02);
        o.frequency.setTargetAtTime(p.rate, t, 0.02);
        const fb = fl ? p.fb : p.fb * 0.5; fL.gain.setTargetAtTime(fb, t, 0.02); fR.gain.setTargetAtTime(fb, t, 0.02);
        m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, dispose() { o.stop(); [m.input, m.output, split, merge, dL, dR, fL, fR, gL, gR, o].forEach((n) => n.disconnect()); } };
    },
  },
  phaser: {
    name: 'Phaser', short: 'Phaser',
    params: [
      { k: 'rate', n: 'Rate', min: 0.05, max: 6, def: 0.4, u: 'Hz', log: true },
      { k: 'depth', n: 'Depth', min: 0, max: 1, def: 0.7 },
      { k: 'center', n: 'Center', min: 200, max: 4000, def: 900, u: 'Hz', log: true },
      { k: 'fb', n: 'Feedback', min: 0, max: 0.85, def: 0.4 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 0.5 },
    ],
    create(ctx, p) {
      const m = mixer(ctx), o = lfo(ctx, p.rate), dg = ctx.createGain();
      o.connect(dg);
      const stages = []; let prev = ctx.createGain(); const head = prev, fb = ctx.createGain(), fbd = ctx.createDelay(0.01);
      m.input.connect(head);
      for (let i = 0; i < 6; i++) { const f = ctx.createBiquadFilter(); f.type = 'allpass'; f.Q.value = 0.6; prev.connect(f); dg.connect(f.frequency); stages.push(f); prev = f; }
      prev.connect(m.wet); prev.connect(fb); fb.connect(fbd); fbd.connect(head); fbd.delayTime.value = 0;
      const set = () => {
        const t = ctx.currentTime;
        stages.forEach((f, i) => f.frequency.setTargetAtTime(p.center * (1 + i * 0.25), t, 0.02));
        dg.gain.setTargetAtTime(p.center * 0.9 * p.depth, t, 0.02);
        o.frequency.setTargetAtTime(p.rate, t, 0.02); fb.gain.setTargetAtTime(p.fb, t, 0.02); m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, dispose() { o.stop(); [m.input, m.output, dg, head, fb, fbd, ...stages].forEach((n) => n.disconnect()); } };
    },
  },
  tremolo: {
    name: 'Tremolo', short: 'Tremolo',
    params: [
      { k: 'sync', n: 'Sync', opts: FX.SYNC, def: 5 },
      { k: 'rate', n: 'Rate', min: 0.1, max: 16, def: 5, u: 'Hz', log: true },
      { k: 'depth', n: 'Depth', min: 0, max: 1, def: 0.6 },
      { k: 'shape', n: 'Shape', opts: ['Sine', 'Square', 'Triangle'], def: 0 },
    ],
    create(ctx, p, env) {
      const input = ctx.createGain(), output = ctx.createGain(), o = lfo(ctx, p.rate), dg = ctx.createGain();
      input.connect(output); o.connect(dg); dg.connect(output.gain);
      const set = () => {
        const t = ctx.currentTime, r = p.sync ? 1 / FX.syncSec(p.sync, env.bpm) : p.rate;
        o.type = ['sine', 'square', 'triangle'][p.shape]; o.frequency.setTargetAtTime(r, t, 0.02);
        output.gain.setTargetAtTime(1 - p.depth / 2, t, 0.02); dg.gain.setTargetAtTime(p.depth / 2, t, 0.02);
      };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, tempo() { set(); }, dispose() { o.stop(); [input, output, o, dg].forEach((n) => n.disconnect()); } };
    },
  },
  drive: {
    name: 'Tube Drive', short: 'Drive',
    params: [
      { k: 'drive', n: 'Drive', min: 0, max: 1, def: 0.4 },
      { k: 'bias', n: 'Warmth', min: 0, max: 1, def: 0.3 },
      { k: 'tone', n: 'Tone', min: 1000, max: 18000, def: 8000, u: 'Hz', log: true },
      { k: 'out', n: 'Output', min: -24, max: 12, def: 0, u: 'dB' },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) {
      const m = mixer(ctx), pre = ctx.createGain(), ws = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), out = ctx.createGain();
      ws.oversample = '4x'; tone.type = 'lowpass';
      m.input.connect(pre); pre.connect(ws); ws.connect(tone); tone.connect(out); out.connect(m.wet);
      let key = '';
      const set = () => {
        const t = ctx.currentTime, k = 1 + p.drive * 24, b = p.bias * 0.3;
        const kk = p.drive + '|' + p.bias;
        if (kk !== key) {
          key = kk; const n = 2048, c = new Float32Array(n), tb = Math.tanh(k * b), nm = Math.tanh(k * (1 + b)) - tb;
          for (let i = 0; i < n; i++) { const x = i / (n - 1) * 2 - 1; c[i] = (Math.tanh(k * (x + b)) - tb) / nm; }
          ws.curve = c;
        }
        tone.frequency.setTargetAtTime(p.tone, t, 0.02);
        out.gain.setTargetAtTime(Math.pow(10, p.out / 20) / (1 + p.drive * 1.5), t, 0.02);
        m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, dispose() { [m.input, m.output, pre, ws, tone, out].forEach((n) => n.disconnect()); } };
    },
  },
  geq: {
    name: 'Graphic EQ — 10 band', short: 'Graphic EQ',
    params: [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f) => ({ k: 'g' + f, n: f >= 1000 ? f / 1000 + 'k' : String(f), min: -12, max: 12, def: 0, u: 'dB', bipolar: true }))
      .concat([{ k: 'out', n: 'Output', min: -12, max: 12, def: 0, u: 'dB', bipolar: true }]),
    create(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain(); let prev = input;
      const fs = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((f, i, a) => {
        const b = ctx.createBiquadFilter(); b.type = i === 0 ? 'lowshelf' : i === a.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f; b.Q.value = 1.4; prev.connect(b); prev = b; return b;
      });
      prev.connect(output);
      const set = () => { const t = ctx.currentTime; fs.forEach((b) => b.gain.setTargetAtTime(p['g' + b.frequency.value], t, 0.02)); output.gain.setTargetAtTime(Math.pow(10, p.out / 20), t, 0.02); };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, dispose() { [input, output, ...fs].forEach((n) => n.disconnect()); } };
    },
  },
};

// Spring reverb impulse: echoes of a click every ~35 ms, each smeared by a long allpass chain (the "boing")
FX.springIR = (ctx, p) => {
  const sr = ctx.sampleRate, dec = Math.min(4, p.decay), len = Math.min(5, dec * 1.2 + 0.2) * sr | 0, ir = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c), T = Math.round((0.033 + c * 0.0041) * sr), fb = Math.pow(10, -3 * (T / sr) / dec);
    for (let k = 0, g = 1; k * T < len; k++, g *= fb) d[k * T] = g * (k % 2 ? -1 : 1);
    for (let st = 0; st < 48; st++) { const a = 0.62; let x1 = 0, y1 = 0; for (let i = 0; i < len; i++) { const x = d[i], y = -a * x + x1 + a * y1; x1 = x; y1 = y; d[i] = y; } }
    let lp = 0; const k2 = 1 - Math.exp(-2 * Math.PI * (4200 - p.damp * 2500) / sr); for (let i = 0; i < len; i++) { lp += (d[i] - lp) * k2; d[i] = lp * 2.2; }
  }
  return ir;
};
// ---------- core dynamics, distortion, EQ, filter, stereo ----------
const dbg = (d) => Math.pow(10, d / 20);
Object.assign(FX.types, {
  comp: {
    name: 'Compressor', short: 'Comp',
    params: [
      { k: 'thr', n: 'Threshold', min: -60, max: 0, def: -18, u: 'dB' },
      { k: 'ratio', n: 'Ratio', min: 1, max: 20, def: 4, log: true, fmt: (v) => v.toFixed(1) + ':1' },
      { k: 'att', n: 'Attack', min: 0.1, max: 100, def: 8, u: 'ms', log: true },
      { k: 'rel', n: 'Release', min: 20, max: 1000, def: 150, u: 'ms', log: true },
      { k: 'knee', n: 'Knee', min: 0, max: 24, def: 6, u: 'dB' },
      { k: 'make', n: 'Makeup', min: 0, max: 24, def: 4, u: 'dB' },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) {
      const m = mixer(ctx), c = ctx.createDynamicsCompressor(), mk = ctx.createGain();
      m.input.connect(c); c.connect(mk); mk.connect(m.wet);
      const set = () => { const t = ctx.currentTime; c.threshold.setValueAtTime(p.thr, t); c.ratio.setValueAtTime(p.ratio, t); c.attack.setValueAtTime(p.att / 1000, t); c.release.setValueAtTime(p.rel / 1000, t); c.knee.setValueAtTime(p.knee, t); mk.gain.setTargetAtTime(dbg(p.make), t, 0.02); m.setMix(p.mix); };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, gr: () => c.reduction, dispose() { [m.input, m.output, c, mk].forEach((n) => n.disconnect()); } };
    },
  },
  limit: {
    name: 'Limiter', short: 'Limit',
    params: [
      { k: 'thr', n: 'Threshold', min: -30, max: 0, def: -6, u: 'dB' },
      { k: 'rel', n: 'Release', min: 10, max: 500, def: 60, u: 'ms', log: true },
      { k: 'out', n: 'Output', min: -12, max: 0, def: -0.3, u: 'dB' },
    ],
    create(ctx, p) {
      const input = ctx.createGain(), pre = ctx.createGain(), c = ctx.createDynamicsCompressor(), output = ctx.createGain();
      input.connect(pre); pre.connect(c); c.connect(output);
      const set = () => { const t = ctx.currentTime; c.threshold.setValueAtTime(p.thr, t); c.ratio.setValueAtTime(20, t); c.knee.setValueAtTime(0, t); c.attack.setValueAtTime(0.001, t); c.release.setValueAtTime(p.rel / 1000, t); output.gain.setTargetAtTime(dbg(p.out - p.thr * 0.9), t, 0.02); };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, gr: () => c.reduction, dispose() { [input, pre, c, output].forEach((n) => n.disconnect()); } };
    },
  },
  gate: {
    name: 'Noise Gate', short: 'Gate',
    params: [{ k: 'thr', n: 'Threshold', min: -80, max: 0, def: -45, u: 'dB' }],
    create(ctx, p) {
      const mk = () => new AudioWorkletNode(ctx, 'ds-channel', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { kind: 'track', meter: false, p: { gate: p.thr, compOn: false, eqOn: false } } });
      const n = mk();
      return { input: n, output: n, set(np) { Object.assign(p, np); n.port.postMessage({ type: 'set', p: { gate: p.thr, compOn: false, eqOn: false } }); }, dispose() { n.disconnect(); } };
    },
  },
  dist: {
    name: 'Distortion', short: 'Dist',
    params: [
      { k: 'mode', n: 'Mode', opts: ['Overdrive', 'Fuzz', 'Rectify', 'Bitcrush'], def: 0 },
      { k: 'drive', n: 'Drive', min: 0, max: 1, def: 0.5 },
      { k: 'tone', n: 'Tone', min: 500, max: 18000, def: 6000, u: 'Hz', log: true },
      { k: 'bits', n: 'Bits', min: 2, max: 16, def: 8, step: 1, fmt: (v) => Math.round(v) + ' bit' },
      { k: 'rate', n: 'Rate', min: 0.02, max: 1, def: 0.25, log: true, fmt: (v) => Math.round(v * 100) + '%' },
      { k: 'out', n: 'Output', min: -24, max: 12, def: -3, u: 'dB' },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) {
      const m = mixer(ctx), pre = ctx.createGain(), ws = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), out = ctx.createGain();
      const crush = new AudioWorkletNode(ctx, 'ds-crush', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { bits: p.bits, rate: p.rate } });
      ws.oversample = '4x'; tone.type = 'lowpass';
      m.input.connect(pre); tone.connect(out); out.connect(m.wet);
      let mode = -1, key = '';
      const route = () => {
        if (mode === p.mode) return; mode = p.mode;
        try { pre.disconnect(); ws.disconnect(); crush.disconnect(); } catch (e) { /* */ }
        if (p.mode === 3) { pre.connect(crush); crush.connect(tone); } else { pre.connect(ws); ws.connect(tone); }
      };
      const set = () => {
        const t = ctx.currentTime, d = p.drive;
        route();
        const k = p.mode + '|' + d;
        if (k !== key && p.mode !== 3) {
          key = k; const n = 2048, c = new Float32Array(n), g = 1 + d * 40;
          for (let i = 0; i < n; i++) {
            const x = (i / (n - 1)) * 2 - 1;
            c[i] = p.mode === 0 ? Math.tanh(g * x) / Math.tanh(g)
              : p.mode === 1 ? Math.max(-0.6, Math.min(1, g * x * 1.5 + 0.15 * d)) / 1
              : Math.abs(Math.sin(x * (1 + d * 6) * Math.PI / 2)) * 2 - 1;
          }
          ws.curve = c;
        }
        pre.gain.setTargetAtTime(p.mode === 3 ? 1 + d : 1, t, 0.02);
        crush.port.postMessage({ bits: Math.round(p.bits), rate: p.rate });
        tone.frequency.setTargetAtTime(p.tone, t, 0.02);
        out.gain.setTargetAtTime(dbg(p.out), t, 0.02); m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, dispose() { [m.input, m.output, pre, ws, tone, out, crush].forEach((n) => n.disconnect()); } };
    },
  },
  peq: {
    name: 'Parametric EQ', short: 'P-EQ',
    params: [
      { k: 'hp', n: 'Low cut', min: 20, max: 1000, def: 20, u: 'Hz', log: true, fmt: (v) => (v <= 21 ? 'off' : Math.round(v) + '') },
      { k: 'lf', n: 'Low Hz', min: 30, max: 500, def: 100, u: 'Hz', log: true }, { k: 'lg', n: 'Low dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
      { k: 'm1f', n: 'Mid 1 Hz', min: 100, max: 4000, def: 500, u: 'Hz', log: true }, { k: 'm1g', n: 'Mid 1 dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true }, { k: 'm1q', n: 'Mid 1 Q', min: 0.3, max: 8, def: 1, log: true },
      { k: 'm2f', n: 'Mid 2 Hz', min: 500, max: 12000, def: 3000, u: 'Hz', log: true }, { k: 'm2g', n: 'Mid 2 dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true }, { k: 'm2q', n: 'Mid 2 Q', min: 0.3, max: 8, def: 1, log: true },
      { k: 'hf', n: 'High Hz', min: 2000, max: 18000, def: 9000, u: 'Hz', log: true }, { k: 'hg', n: 'High dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
      { k: 'out', n: 'Output', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
    ],
    create(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain();
      const mk = (type) => { const b = ctx.createBiquadFilter(); b.type = type; return b; };
      const hp = mk('highpass'), lo = mk('lowshelf'), m1 = mk('peaking'), m2 = mk('peaking'), hi = mk('highshelf');
      input.connect(hp); hp.connect(lo); lo.connect(m1); m1.connect(m2); m2.connect(hi); hi.connect(output);
      const set = () => {
        const t = ctx.currentTime, s = (par, v) => par.setTargetAtTime(v, t, 0.02);
        s(hp.frequency, p.hp <= 21 ? 5 : p.hp); hp.Q.value = 0.707;
        s(lo.frequency, p.lf); s(lo.gain, p.lg); s(m1.frequency, p.m1f); s(m1.gain, p.m1g); s(m1.Q, p.m1q);
        s(m2.frequency, p.m2f); s(m2.gain, p.m2g); s(m2.Q, p.m2q); s(hi.frequency, p.hf); s(hi.gain, p.hg); s(output.gain, dbg(p.out));
      };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, dispose() { [input, output, hp, lo, m1, m2, hi].forEach((n) => n.disconnect()); } };
    },
  },
  filter: {
    name: 'Filter', short: 'Filter',
    params: [
      { k: 'type', n: 'Type', opts: ['Low-pass', 'High-pass', 'Band-pass'], def: 0 },
      { k: 'cut', n: 'Cutoff', min: 40, max: 18000, def: 1200, u: 'Hz', log: true },
      { k: 'res', n: 'Resonance', min: 0.5, max: 18, def: 3, log: true },
      { k: 'sync', n: 'LFO sync', opts: FX.SYNC, def: 0 },
      { k: 'rate', n: 'LFO rate', min: 0.05, max: 12, def: 0.5, u: 'Hz', log: true },
      { k: 'depth', n: 'LFO depth', min: 0, max: 1, def: 0 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p, env) {
      const m = mixer(ctx), f = ctx.createBiquadFilter(), o = lfo(ctx, p.rate), dg = ctx.createGain();
      m.input.connect(f); f.connect(m.wet); o.connect(dg); dg.connect(f.detune);
      const set = () => {
        const t = ctx.currentTime, r = p.sync ? 1 / FX.syncSec(p.sync, env.bpm) : p.rate;
        f.type = ['lowpass', 'highpass', 'bandpass'][p.type];
        f.frequency.setTargetAtTime(p.cut, t, 0.02); f.Q.setTargetAtTime(p.res, t, 0.02);
        o.frequency.setTargetAtTime(r, t, 0.02); dg.gain.setTargetAtTime(p.depth * 3600, t, 0.02); m.setMix(p.mix);
      };
      set();
      return { input: m.input, output: m.output, set(np) { Object.assign(p, np); set(); }, tempo() { set(); }, dispose() { o.stop(); [m.input, m.output, f, o, dg].forEach((n) => n.disconnect()); } };
    },
  },
  width: {
    name: 'Stereo Width', short: 'Width',
    params: [{ k: 'w', n: 'Width', min: 0, max: 2, def: 1.3, fmt: (v) => Math.round(v * 100) + '%' }, { k: 'out', n: 'Output', min: -12, max: 6, def: 0, u: 'dB', bipolar: true }],
    create(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain(), sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
      const ll = ctx.createGain(), rl = ctx.createGain(), rr = ctx.createGain(), lr = ctx.createGain();
      input.connect(sp); sp.connect(ll, 0); sp.connect(lr, 0); sp.connect(rr, 1); sp.connect(rl, 1);
      ll.connect(mg, 0, 0); rl.connect(mg, 0, 0); rr.connect(mg, 0, 1); lr.connect(mg, 0, 1); mg.connect(output);
      const set = () => { const t = ctx.currentTime, a = (1 + p.w) / 2, b = (1 - p.w) / 2; [ll, rr].forEach((g) => g.gain.setTargetAtTime(a, t, 0.02)); [rl, lr].forEach((g) => g.gain.setTargetAtTime(b, t, 0.02)); output.gain.setTargetAtTime(dbg(p.out), t, 0.02); };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, dispose() { [input, output, sp, mg, ll, rl, rr, lr].forEach((n) => n.disconnect()); } };
    },
  },
});
// ---------- v2.3 studio set: worklet-based processors (see fx-worklet.js) ----------
// wfx: one AudioWorkletNode, parameters mapped from the knob values; gain reduction comes back over the port
const wfx = (ctx, proc, p, map, extra) => {
  const live = !(typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext);
  const n = new AudioWorkletNode(ctx, proc, { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', processorOptions: { p: map(p), meter: live } });
  let gr = 0, bands = null;
  n.port.onmessage = (e) => { gr = e.data.gr || 0; if (e.data.bands) bands = e.data.bands; };
  return Object.assign({ input: n, output: n, set(np) { Object.assign(p, np); n.port.postMessage({ p: map(p) }); }, gr: () => gr, bands: () => bands, dispose() { n.disconnect(); } }, extra || {});
};
const ONOFF = ['Off', 'On'];
Object.assign(FX.types, {
  fet: {
    gr: true, name: 'FET Compressor', short: 'FET', about: 'Fast, aggressive and colourful, in the spirit of the classic 1176. Turn Input up to compress harder.',
    params: [
      { k: 'input', n: 'Input', min: 0, max: 36, def: 12, u: 'dB' },
      { k: 'ratio', n: 'Ratio', opts: ['4:1', '8:1', '12:1', '20:1', 'All'], def: 0 },
      { k: 'att', n: 'Attack', min: 0.02, max: 0.8, def: 0.2, u: 'ms', log: true },
      { k: 'rel', n: 'Release', min: 50, max: 1100, def: 250, u: 'ms', log: true },
      { k: 'color', n: 'Colour', min: 0, max: 1, def: 0.3 },
      { k: 'out', n: 'Output', min: -24, max: 12, def: -6, u: 'dB', bipolar: true },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-vcomp', p, (q) => ({ model: 0, inDb: q.input, thr: -18, ratio: [4, 8, 12, 20, 20][q.ratio], all: q.ratio === 4, att: q.att, rel: q.rel, knee: 2, color: q.color, out: q.out, mix: q.mix })); },
  },
  opto: {
    gr: true, name: 'Opto Compressor', short: 'Opto', about: 'Smooth, program-dependent levelling in the spirit of the LA-2A — one knob does most of the work.',
    params: [
      { k: 'peak', n: 'Peak reduction', min: 0, max: 100, def: 40, fmt: (v) => Math.round(v) + '' },
      { k: 'mode', n: 'Mode', opts: ['Compress', 'Limit'], def: 0 },
      { k: 'gain', n: 'Gain', min: -12, max: 24, def: 4, u: 'dB', bipolar: true },
      { k: 'color', n: 'Tube', min: 0, max: 1, def: 0.35 },
      { k: 'hpf', n: 'Sidechain HPF', opts: ['Off', '60 Hz', '100 Hz', '150 Hz'], def: 0 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-vcomp', p, (q) => ({ model: 1, inDb: 0, thr: -q.peak * 0.45, ratio: q.mode ? 10 : 3, att: 10, rel: 300, knee: 10, color: q.color, out: q.gain, mix: q.mix, scHp: [0, 60, 100, 150][q.hpf] })); },
  },
  buscomp: {
    gr: true, name: 'Bus Compressor', short: 'Bus', about: 'The glue compressor of a big console’s centre section (think SSL G-bus). Gentle ratios, auto release, sidechain filter.',
    params: [
      { k: 'thr', n: 'Threshold', min: -30, max: 0, def: -12, u: 'dB' },
      { k: 'ratio', n: 'Ratio', opts: ['2:1', '4:1', '10:1'], def: 0 },
      { k: 'att', n: 'Attack', opts: ['0.1 ms', '0.3 ms', '1 ms', '3 ms', '10 ms', '30 ms'], def: 4 },
      { k: 'rel', n: 'Release', opts: ['0.1 s', '0.3 s', '0.6 s', '1.2 s', 'Auto'], def: 4 },
      { k: 'make', n: 'Makeup', min: 0, max: 15, def: 2, u: 'dB' },
      { k: 'hpf', n: 'Sidechain HPF', opts: ['Off', '60 Hz', '90 Hz', '150 Hz'], def: 1 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-vcomp', p, (q) => ({ model: 2, inDb: 0, thr: q.thr, ratio: [2, 4, 10][q.ratio], att: [0.1, 0.3, 1, 3, 10, 30][q.att], rel: [100, 300, 600, 1200, 400][q.rel], auto: q.rel === 4, knee: 4, color: 0.15, out: q.make, mix: q.mix, scHp: [0, 60, 90, 150][q.hpf] })); },
  },
  mband: {
    gr: true, name: 'Multiband Compressor', short: 'MBand', about: 'Three bands, each with its own threshold, ratio and gain. Crossovers sum flat when nothing is compressing.',
    params: [
      { k: 'x1', n: 'Low / mid', min: 60, max: 600, def: 150, u: 'Hz', log: true },
      { k: 'x2', n: 'Mid / high', min: 1000, max: 10000, def: 3500, u: 'Hz', log: true },
      { k: 't1', n: 'Low thr', min: -50, max: 0, def: -20, u: 'dB' }, { k: 'r1', n: 'Low ratio', min: 1, max: 10, def: 2.5, log: true, fmt: (v) => v.toFixed(1) + ':1' }, { k: 'g1', n: 'Low gain', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
      { k: 't2', n: 'Mid thr', min: -50, max: 0, def: -20, u: 'dB' }, { k: 'r2', n: 'Mid ratio', min: 1, max: 10, def: 2, log: true, fmt: (v) => v.toFixed(1) + ':1' }, { k: 'g2', n: 'Mid gain', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
      { k: 't3', n: 'High thr', min: -50, max: 0, def: -22, u: 'dB' }, { k: 'r3', n: 'High ratio', min: 1, max: 10, def: 2, log: true, fmt: (v) => v.toFixed(1) + ':1' }, { k: 'g3', n: 'High gain', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
      { k: 'att', n: 'Attack', min: 0.5, max: 100, def: 15, u: 'ms', log: true },
      { k: 'rel', n: 'Release', min: 20, max: 1000, def: 180, u: 'ms', log: true },
      { k: 'solo', n: 'Solo', opts: ['None', 'Low', 'Mid', 'High'], def: 0 },
      { k: 'out', n: 'Output', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-mband', p, (q) => Object.assign({}, q)); },
  },
  tplim: {
    gr: true, name: 'True-Peak Limiter', short: 'TP-Lim', about: 'Look-ahead brickwall limiter with intersample-peak detection, in the spirit of FabFilter Pro-L. Gain pushes loudness, Ceiling is the hard limit.',
    params: [
      { k: 'gain', n: 'Gain', min: 0, max: 24, def: 3, u: 'dB' },
      { k: 'ceil', n: 'Ceiling', min: -6, max: 0, def: -1, u: 'dB' },
      { k: 'rel', n: 'Release', min: 1, max: 1000, def: 80, u: 'ms', log: true },
      { k: 'look', n: 'Look-ahead', min: 0.5, max: 5, def: 1.5, u: 'ms' },
      { k: 'style', n: 'Style', opts: ['Transparent', 'Punchy', 'Aggressive'], def: 0 },
      { k: 'tp', n: 'True peak', opts: ONOFF, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-tplim', p, (q) => Object.assign({}, q)); },
  },
  satur: {
    name: 'Saturator', short: 'Satur', about: 'Five flavours of harmonic drive (think Decapitator or Saturn): Tape, Tube, Transformer, Console, Punish. Auto gain keeps the level steady while you push it.',
    params: [
      { k: 'style', n: 'Style', opts: ['Tape', 'Tube', 'Transformer', 'Console', 'Punish'], def: 0 },
      { k: 'drive', n: 'Drive', min: 0, max: 36, def: 9, u: 'dB' },
      { k: 'tone', n: 'Tone', min: -1, max: 1, def: 0, bipolar: true, fmt: (v) => (v < -0.02 ? 'dark ' : v > 0.02 ? 'bright ' : '') + Math.round(Math.abs(v) * 100) + '%' },
      { k: 'lowcut', n: 'Low cut', min: 10, max: 500, def: 10, u: 'Hz', log: true, fmt: (v) => (v <= 11 ? 'off' : Math.round(v) + '') },
      { k: 'highcut', n: 'High cut', min: 2000, max: 20000, def: 20000, u: 'Hz', log: true },
      { k: 'auto', n: 'Auto gain', opts: ONOFF, def: 1 },
      { k: 'out', n: 'Output', min: -18, max: 12, def: 0, u: 'dB', bipolar: true },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-satur', p, (q) => Object.assign({}, q)); },
  },
  deess: {
    gr: true, name: 'De-esser', short: 'De-ess', about: 'Tames harsh S and T sounds. Split mode only turns down the sibilant band; Listen lets you hear what it is catching.',
    params: [
      { k: 'freq', n: 'Frequency', min: 2500, max: 12000, def: 6000, u: 'Hz', log: true },
      { k: 'thr', n: 'Threshold', min: -60, max: 0, def: -28, u: 'dB' },
      { k: 'range', n: 'Range', min: 0, max: 24, def: 10, u: 'dB' },
      { k: 'mode', n: 'Mode', opts: ['Split', 'Wideband'], def: 0 },
      { k: 'listen', n: 'Listen', opts: ONOFF, def: 0 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-deess', p, (q) => Object.assign({}, q)); },
  },
  trans: {
    gr: true, name: 'Transient Shaper', short: 'Trans', about: 'More or less attack and sustain without thresholds (think SPL Transient Designer). Great on drums.',
    params: [
      { k: 'attack', n: 'Attack', min: -100, max: 100, def: 30, bipolar: true, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) + '%' },
      { k: 'sustain', n: 'Sustain', min: -100, max: 100, def: 0, bipolar: true, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v) + '%' },
      { k: 'out', n: 'Output', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 1 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-trans', p, (q) => Object.assign({}, q)); },
  },
  doubler: {
    name: 'Doubler', short: 'Double', about: 'Two micro-detuned, slightly delayed copies spread left and right (think MicroShift). Instant width on vocals and guitars.',
    params: [
      { k: 'style', n: 'Style', opts: ['I · still', 'II · drift', 'III · wide'], def: 1 },
      { k: 'detune', n: 'Detune', min: 1, max: 30, def: 9, fmt: (v) => Math.round(v) + ' ct' },
      { k: 'delay', n: 'Delay', min: 2, max: 40, def: 12, u: 'ms' },
      { k: 'width', n: 'Width', min: 0, max: 1, def: 1 },
      { k: 'mix', n: 'Mix', min: 0, max: 1, def: 0.4 },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-doubler', p, (q) => Object.assign({}, q)); },
  },
  imager: {
    name: 'Stereo Imager', short: 'Imager', about: 'Separate width below and above a crossover (think Ozone Imager). Low width 0% makes the bass mono — a mastering staple.',
    params: [
      { k: 'xover', n: 'Crossover', min: 60, max: 4000, def: 180, u: 'Hz', log: true },
      { k: 'lowW', n: 'Low width', min: 0, max: 2, def: 0.6, fmt: (v) => Math.round(v * 100) + '%' },
      { k: 'highW', n: 'High width', min: 0, max: 2, def: 1.15, fmt: (v) => Math.round(v * 100) + '%' },
      { k: 'out', n: 'Output', min: -12, max: 6, def: 0, u: 'dB', bipolar: true },
    ],
    create(ctx, p) { return wfx(ctx, 'ds-imager', p, (q) => Object.assign({}, q)); },
  },
  tubeeq: {
    name: 'Tube EQ', short: 'TubeEQ', about: 'Broad, musical program EQ in the spirit of the Pultec EQP-1A. Boost and cut the same low frequency together for the famous tight-but-big bottom.',
    params: [
      { k: 'lf', n: 'Low freq', opts: ['20 Hz', '30 Hz', '60 Hz', '100 Hz'], def: 2 },
      { k: 'lb', n: 'Low boost', min: 0, max: 10, def: 0, fmt: (v) => v.toFixed(1) },
      { k: 'la', n: 'Low atten', min: 0, max: 10, def: 0, fmt: (v) => v.toFixed(1) },
      { k: 'hf', n: 'High freq', opts: ['3k', '4k', '5k', '8k', '10k', '12k', '16k'], def: 4 },
      { k: 'hb', n: 'High boost', min: 0, max: 10, def: 0, fmt: (v) => v.toFixed(1) },
      { k: 'bw', n: 'Bandwidth', min: 0, max: 10, def: 5, fmt: (v) => (v < 3 ? 'sharp ' : v > 7 ? 'broad ' : '') + v.toFixed(1) },
      { k: 'af', n: 'Atten freq', opts: ['5k', '10k', '20k'], def: 1 },
      { k: 'ha', n: 'High atten', min: 0, max: 10, def: 0, fmt: (v) => v.toFixed(1) },
      { k: 'tube', n: 'Tube', min: 0, max: 1, def: 0.3 },
      { k: 'out', n: 'Output', min: -12, max: 12, def: 0, u: 'dB', bipolar: true },
    ],
    create(ctx, p) {
      const input = ctx.createGain(), output = ctx.createGain(), ws = ctx.createWaveShaper(); ws.oversample = '2x';
      const mk = (type) => { const b = ctx.createBiquadFilter(); b.type = type; return b; };
      const lb = mk('lowshelf'), la = mk('lowshelf'), hb = mk('peaking'), ha = mk('highshelf');
      input.connect(lb); lb.connect(la); la.connect(hb); hb.connect(ha); ha.connect(ws); ws.connect(output);
      let tk = -1;
      const set = () => {
        const t = ctx.currentTime, s = (par, v) => par.setTargetAtTime(v, t, 0.02), f = [20, 30, 60, 100][p.lf];
        s(lb.frequency, f * 1.6); s(lb.gain, p.lb * 1.35);
        s(la.frequency, f * 3.2); s(la.gain, -p.la * 1.1);
        s(hb.frequency, [3000, 4000, 5000, 8000, 10000, 12000, 16000][p.hf]); s(hb.gain, p.hb * 1.6); s(hb.Q, 2.6 - p.bw * 0.22);
        s(ha.frequency, [5000, 10000, 20000][p.af] * 0.8); s(ha.gain, -p.ha * 1.6);
        s(output.gain, dbg(p.out));
        if (tk !== p.tube) {
          // blend from clean to an asymmetric (even-harmonic) tube curve; unity slope at zero so the level stays put
          tk = p.tube; const n = 2048, c = new Float32Array(n), tb = (x) => (x >= 0 ? 1 - Math.exp(-2 * x) : -(1 - Math.exp(2.5 * x)) / 1.25) / 2;
          for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = (1 - p.tube) * x + p.tube * tb(x); }
          ws.curve = c;
        }
      };
      set();
      return { input, output, set(np) { Object.assign(p, np); set(); }, dispose() { [input, output, lb, la, hb, ha, ws].forEach((n) => n.disconnect()); } };
    },
  },
});
FX.types.limit.hidden = true; // superseded by the True-Peak Limiter; kept so older songs still load
FX.order = ['comp', 'dist', 'reverb', 'delay', 'peq', 'filter', 'gate', 'limit', 'chorus', 'phaser', 'tremolo', 'drive', 'geq', 'width'];
FX.GROUPS = [['Dynamics', ['comp', 'fet', 'opto', 'buscomp', 'mband', 'tplim', 'deess', 'trans', 'gate']], ['Drive', ['satur', 'dist', 'drive']], ['Space', ['reverb', 'delay']], ['Tone', ['peq', 'tubeeq', 'geq', 'filter']], ['Stereo & modulation', ['imager', 'doubler', 'width', 'chorus', 'phaser', 'tremolo']], ['The suite', ['eleopedals']]];
FX.order.push('fet', 'opto', 'buscomp', 'mband', 'tplim', 'satur', 'deess', 'trans', 'doubler', 'imager', 'tubeeq');
FX.defaults = (type) => { const o = {}; for (const s of FX.types[type].params) o[s.k] = s.def; return o; };
FX.register = (key, def) => { FX.types[key] = def; if (!FX.order.includes(key)) FX.order.push(key); };
