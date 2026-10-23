// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — noise removal: learn a noise profile from a stretch of pure noise, then take that noise out
// of clips with spectral gating (STFT 2048 / hop 512, Hann). Plain DSP, no learned models.
'use strict';
const NR = {
  N: 2048, HOP: 512,
  profile: null, // { mag: Float32Array(N/2+1), sr, secs, from }
  opts: { reduction: 12, sens: 6, smooth: 3, mode: 'remove' },
  _win: null, _tw: null,
  win() { if (!this._win) { const w = new Float32Array(this.N); for (let i = 0; i < this.N; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N); this._win = w; } return this._win; },
  // in-place radix-2 complex FFT (inv = true for inverse, unscaled)
  fft(re, im, inv) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    if (!this._tw || this._tw.n !== n) { const c = new Float64Array(n / 2), s = new Float64Array(n / 2); for (let i = 0; i < n / 2; i++) { c[i] = Math.cos(2 * Math.PI * i / n); s[i] = Math.sin(2 * Math.PI * i / n); } this._tw = { n, c, s }; }
    const C = this._tw.c, S = this._tw.s, sg = inv ? 1 : -1;
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
        const wr = C[k * step], wi = sg * S[k * step], a = i + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
      }
    }
  },
  // average magnitude spectrum of a stretch of noise (all channels)
  learn(chs, sr) {
    const N = this.N, H = this.HOP, w = this.win(), K = N / 2 + 1, acc = new Float64Array(K), len = chs[0].length;
    const re = new Float64Array(N), im = new Float64Array(N); let frames = 0;
    for (let s = 0; s + N <= Math.max(len, N); s += H) {
      // each channel on its own: mixing to mono first would hide 3 dB of uncorrelated hiss
      for (const d of chs) {
        for (let i = 0; i < N; i++) { re[i] = (d[s + i] || 0) * w[i]; im[i] = 0; }
        this.fft(re, im, false);
        for (let k = 0; k < K; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
        frames++;
      }
      if (s + N >= len) break;
    }
    const mag = new Float32Array(K); for (let k = 0; k < K; k++) mag[k] = Math.sqrt(acc[k] / Math.max(1, frames));
    return { mag, sr, secs: len / sr, frames };
  },
  // noise magnitude for bin k at sample rate sr (profiles taken at another rate are mapped by frequency)
  nmag(k, sr) {
    const P = this.profile; if (P.sr === sr) return P.mag[k];
    const f = k * sr / this.N, x = f * this.N / P.sr, i = Math.floor(x), t = x - i;
    if (i >= P.mag.length - 1) return P.mag[P.mag.length - 1];
    return P.mag[i] * (1 - t) + P.mag[i + 1] * t;
  },
  // process channels; returns new channels. onProg(0..1); yields to the UI between chunks
  async process(chs, sr, o, onProg) {
    const N = this.N, H = this.HOP, w = this.win(), K = N / 2 + 1, len = chs[0].length, F = 5, D = 2;
    const floor = Math.pow(10, -o.reduction / 20), over = Math.pow(10, o.sens / 20), sm = Math.round(o.smooth);
    const thr = new Float64Array(K); for (let k = 0; k < K; k++) thr[k] = this.nmag(k, sr) * over;
    // how fast a bin may close again after it opens: the full reduction in about 0.1 s (stops "musical noise" flutter)
    const fall = Math.pow(floor, H / (sr * 0.1));
    const out = [], total = chs.length * Math.ceil((len + 2 * N) / H); let done = 0;
    const re = new Float64Array(N), im = new Float64Array(N), g = new Float64Array(K), gs = new Float64Array(K), prev = new Float64Array(K);
    // ring of the last F frames: spectra and magnitudes; frame t is decided from frames t-2..t+2
    const SR = Array.from({ length: F }, () => new Float64Array(K)), SI = Array.from({ length: F }, () => new Float64Array(K)), MG = Array.from({ length: F }, () => new Float64Array(K));
    for (const d of chs) {
      const y = new Float32Array(len); prev.fill(1); MG.forEach((m) => m.fill(0));
      let f = 0;
      for (let s = -N; s < len + D * H; s += H, f++) {
        for (let i = 0; i < N; i++) { const j = s + i; re[i] = (j >= 0 && j < len ? d[j] : 0) * w[i]; im[i] = 0; }
        this.fft(re, im, false);
        const slot = f % F;
        for (let k = 0; k < K; k++) { SR[slot][k] = re[k]; SI[slot][k] = im[k]; MG[slot][k] = Math.hypot(re[k], im[k]); }
        if (f < D) continue;
        const cs = (f - D) % F, sc = s - D * H; // the centre frame and where it goes
        for (let k = 0; k < K; k++) {
          // second-largest magnitude of the five frames: a lone noise spike can't open the gate, a real sound can
          let m1 = 0, m2 = 0; for (let q = 0; q < F; q++) { const v = MG[q][k]; if (v > m1) { m2 = m1; m1 = v; } else if (v > m2) m2 = v; }
          g[k] = m2 >= thr[k] ? 1 : floor;
        }
        for (let k = 0; k < K; k++) { // smooth across neighbouring bins, then limit how fast each bin closes
          // geometric mean (average in dB), so one stray open bin can't lift its neighbours much
          let a = 0, c = 0; for (let q = Math.max(0, k - sm); q <= Math.min(K - 1, k + sm); q++) { a += Math.log(g[q]); c++; }
          gs[k] = Math.max(Math.exp(a / c), prev[k] * fall); prev[k] = gs[k];
        }
        for (let k = 0; k < K; k++) { const gg = o.mode === 'residue' ? 1 - gs[k] : gs[k]; re[k] = SR[cs][k] * gg; im[k] = SI[cs][k] * gg; }
        for (let k = 1; k < N / 2; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
        this.fft(re, im, true);
        // overlap-add: Hann analysis x Hann synthesis at 75% overlap sums to 1.5
        for (let i = 0; i < N; i++) { const j = sc + i; if (j >= 0 && j < len) y[j] += re[i] / N * w[i] / 1.5; }
        if (++done % 96 === 0) { onProg && onProg(done / total); await new Promise((r) => setTimeout(r, 0)); }
      }
      out.push(y);
    }
    onProg && onProg(1);
    return out;
  },
  // ---------- glue to the project ----------
  // the clips (and their source spans) a profile can be taken from: the range selection, else the selected clip's quietest 0.5 s
  sourceForProfile() {
    const A0 = A, P = A0.proj, E = A0.eng, R = A0.ui.range;
    const grab = (c, t0, t1) => { const b = E.buffers.get(c.buf); if (!b) return null; const sr = b.ab.sampleRate, a = Math.max(0, Math.floor((c.off + t0 - c.start) * sr)), z = Math.min(b.ab.length, Math.ceil((c.off + t1 - c.start) * sr)); if (z - a < 2048) return null; const chs = []; for (let ch = 0; ch < b.ab.numberOfChannels; ch++) chs.push(b.ab.getChannelData(ch).subarray(a, z)); return { chs, sr, name: c.name || 'clip' }; };
    if (R && R.e - R.s > 0.04) {
      for (let ti = R.t0; ti <= R.t1; ti++) { const t = P.tracks[ti]; if (!t) continue; for (const c of t.clips) { if (!c.buf || c.start >= R.e || c.start + c.len <= R.s) continue; const g = grab(c, Math.max(R.s, c.start), Math.min(R.e, c.start + c.len)); if (g) return Object.assign(g, { how: 'the selected range' }); } }
    }
    const sel = A0.selected().filter((x) => x.c.buf)[0];
    if (sel) {
      const c = sel.c, b = E.buffers.get(c.buf); if (!b) return null;
      const sr = b.ab.sampleRate, d = b.ab.getChannelData(0), a = Math.floor(c.off * sr), z = Math.min(d.length, a + Math.floor(c.len * sr)), W = Math.floor(sr * 0.5);
      if (z - a < W) return null;
      let best = a, bestE = Infinity; const step = Math.floor(sr * 0.05);
      for (let s = a; s + W <= z; s += step) { let e = 0; for (let i = s; i < s + W; i += 4) e += d[i] * d[i]; if (e < bestE) { bestE = e; best = s; } }
      const t0 = c.start + (best - a) / sr; const g = grab(c, t0, t0 + 0.5); return g && Object.assign(g, { how: 'the quietest half-second of ' + (c.name || 'the clip') });
    }
    return null;
  },
  capture() {
    const src = this.sourceForProfile();
    if (!src) return 'Select a stretch that is only noise (drag across a quiet gap), or select a clip so its quietest half-second can be used.';
    this.profile = Object.assign(this.learn(src.chs, src.sr), { from: src.how });
    return null;
  },
  targets() {
    const A0 = A, P = A0.proj, R = A0.ui.range;
    let list = A0.selected().filter((x) => x.c.buf);
    if (!list.length && R) { list = []; for (let ti = R.t0; ti <= R.t1; ti++) { const t = P.tracks[ti]; if (t) t.clips.forEach((c) => { if (c.buf && c.start < R.e && c.start + c.len > R.s) list.push({ c, t }); }); } }
    return list;
  },
  region(c) { const b = A.eng.buffers.get(c.buf); if (!b) return null; const sr = b.ab.sampleRate, a = Math.max(0, Math.floor(c.off * sr)), z = Math.min(b.ab.length, a + Math.ceil(c.len * sr)); const chs = []; for (let ch = 0; ch < b.ab.numberOfChannels; ch++) chs.push(b.ab.getChannelData(ch).slice(a, z)); return { chs, sr, b }; },
  async apply(list, onProg) {
    A.commit('Noise removal');
    for (let i = 0; i < list.length; i++) {
      const c = list[i].c, r = this.region(c); if (!r) continue;
      const out = await this.process(r.chs, r.sr, this.opts, (p) => onProg && onProg((i + p) / list.length));
      const id = A.eng.addBuffer(A.eng.makeBuffer(out, r.sr), (r.b.name || 'clip') + (this.opts.mode === 'residue' ? ' noise' : ' denoised'));
      c.buf = id; c.off = 0;
    }
    A.changed({ clips: true });
  },
  stopPreview() { if (this._pv) { try { this._pv.stop(); } catch (e) { /* */ } this._pv = null; } },
  async preview(list, onProg) {
    this.stopPreview();
    const c = list[0].c, b = A.eng.buffers.get(c.buf); if (!b) return;
    const sr = b.ab.sampleRate, R = A.ui.range, at = R && R.s >= c.start && R.s < c.start + c.len ? R.s : Math.max(c.start, Math.min(c.start + c.len - 0.1, A.eng.pos()));
    const a = Math.floor((c.off + at - c.start) * sr), z = Math.min(b.ab.length, a + sr * 6, Math.floor((c.off + c.len) * sr));
    const chs = []; for (let ch = 0; ch < b.ab.numberOfChannels; ch++) chs.push(b.ab.getChannelData(ch).slice(a, z));
    const out = await this.process(chs, sr, this.opts, onProg);
    const E = A.eng, src = E.ctx.createBufferSource(); src.buffer = E.makeBuffer(out, sr); src.connect(E.outNode); src.start(); this._pv = src;
    src.onended = () => { if (this._pv === src) this._pv = null; };
  },
  dialog() {
    const h = K.h, o = this.opts;
    const status = h('div', { class: 'nr-prof' });
    const paint = () => { const P = this.profile; status.textContent = P ? 'Noise profile ready: ' + P.secs.toFixed(2) + ' s from ' + P.from + '.' : 'No noise profile yet.'; status.classList.toggle('ok', !!P); };
    const note = h('div', { class: 'note' }), prog = h('div', { class: 'prog' }, h('i'));
    const pct = (v) => (prog.firstChild.style.width = Math.round(v * 100) + '%');
    const get = h('button', { class: 'btn', onclick: () => { const err = this.capture(); note.textContent = err || 'Got it. Now select the clip(s) to clean and press Remove noise.'; paint(); } }, '1 · Get noise profile');
    const knob = (k, n, min, max, u, step) => K.knob({ n, min, max, def: o[k], u, step, size: 'lg', get: () => o[k], set: (v) => (o[k] = step ? Math.round(v / step) * step : v) });
    const mode = K.select([['remove', 'Remove the noise'], ['residue', 'Keep only the noise (to check what is removed)']], o.mode, (v) => (o.mode = v));
    const need = () => { if (!this.profile) { note.textContent = 'Step 1 first: get a noise profile.'; return null; } const l = this.targets(); if (!l.length) { note.textContent = 'Select the clip(s) to clean (or drag a range across them).'; return null; } return l; };
    const body = [
      h('div', { class: 'note' }, 'Two steps, like a tape engineer would do it: let the app hear a stretch of noise on its own (a gap before the singing, room tone, hiss between takes), then take that noise out of your clips.'),
      h('div', { class: 'sh-sub' }, 'Step 1'), h('div', { class: 'nr-row' }, get, status),
      h('div', { class: 'sh-sub' }, 'Step 2'),
      h('div', { class: 'mst-knobs' }, knob('reduction', 'Reduction', 0, 36, 'dB'), knob('sens', 'Sensitivity', 0, 24, 'dB'), knob('smooth', 'Smoothing', 0, 8, '', 1)),
      K.row('Output', mode),
      h('div', { class: 'note' }, 'Start gentle: 12 dB reduction. Raise Sensitivity if noise still comes through; lower it if the sound gets watery. Smoothing evens out warbly artefacts.'),
      note, prog,
    ];
    const acts = [
      { label: 'Close', act: () => this.stopPreview() },
      { label: 'Preview', act: async () => { const l = need(); if (!l) return false; note.textContent = 'Preparing a 6-second preview…'; pct(0); await this.preview(l, pct); note.textContent = 'Playing the cleaned audio (dry, without the track’s strip). Press Preview again to restart.'; return false; } },
      { label: 'Remove noise', primary: true, act: async () => { const l = need(); if (!l) return false; this.stopPreview(); note.textContent = 'Cleaning ' + l.length + ' clip' + (l.length === 1 ? '' : 's') + '…'; pct(0); await this.apply(l, pct); note.textContent = 'Done. Undo brings the original back.'; K.toast('Noise removed from ' + l.length + ' clip' + (l.length === 1 ? '' : 's')); return false; } },
    ];
    paint();
    const d = K.isTouch() || A.ui.view === 'deck' ? K.sheet('Noise removal', body, acts, { light: true, onClose: () => this.stopPreview() }) : K.dialog('Noise removal', body, acts, { width: 'min(600px, 100%)', onClose: () => this.stopPreview() });
    d.el.classList.add('nr');
    return d;
  },
};
