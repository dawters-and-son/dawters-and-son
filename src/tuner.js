// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — Tuner: a simple, accessible instrument tuner that lives inside the studio.
// Pitch by YIN (cumulative-mean-normalised difference) on the live input. Plain DSP, no models.
'use strict';
const TUNER = {
  NAMES: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
  SPOKEN: ['C', 'C sharp', 'D', 'D sharp', 'E', 'F', 'F sharp', 'G', 'G sharp', 'A', 'A sharp', 'B'],
  MODES: {
    chrom: ['Chromatic', null],
    guitar: ['Guitar · standard', [40, 45, 50, 55, 59, 64]],
    dropd: ['Guitar · drop D', [38, 45, 50, 55, 59, 64]],
    bass: ['Bass · 4-string', [28, 33, 38, 43]],
    bass5: ['Bass · 5-string', [23, 28, 33, 38, 43]],
    uke: ['Ukulele · GCEA', [67, 60, 64, 69]],
    violin: ['Violin · GDAE', [55, 62, 69, 76]],
    mando: ['Mandolin · GDAE', [55, 62, 69, 76]],
  },
  st: null, // { el, an, buf, raf, hist, lock, osc, ... }
  cfg() { let c = {}; try { c = JSON.parse(localStorage.getItem('dawters.tuner') || '{}'); } catch (e) { /* */ } return Object.assign({ mode: 'chrom', a4: 440 }, c); },
  saveCfg(c) { try { localStorage.setItem('dawters.tuner', JSON.stringify(c)); } catch (e) { /* */ } },
  noteName(n) { return this.NAMES[((n % 12) + 12) % 12] + Math.floor(n / 12 - 1); },
  freq(n, a4) { return a4 * Math.pow(2, (n - 69) / 12); },
  // YIN pitch on a time-domain frame; returns { f, conf } or null
  yin(x, sr, fmin, fmax) {
    let d = x, rate = sr;
    if (sr > 32000) { const h = new Float32Array(x.length >> 1); for (let i = 0; i < h.length; i++) h[i] = (x[2 * i] + x[2 * i + 1]) * 0.5; d = h; rate = sr / 2; }
    const W = d.length >> 1, tMin = Math.max(2, Math.floor(rate / fmax)), tMax = Math.min(W - 1, Math.ceil(rate / fmin));
    const df = this._df && this._df.length >= tMax + 2 ? this._df : (this._df = new Float32Array(tMax + 2));
    df[0] = 1; let run = 0;
    for (let t = 1; t <= tMax; t++) {
      let s = 0; for (let i = 0; i < W; i++) { const q = d[i] - d[i + t]; s += q * q; }
      run += s; df[t] = run > 0 ? s * t / run : 1;
    }
    let tau = -1;
    for (let t = tMin; t < tMax; t++) if (df[t] < 0.12) { while (t + 1 < tMax && df[t + 1] < df[t]) t++; tau = t; break; }
    if (tau < 0) { let best = 1, bt = -1; for (let t = tMin; t < tMax; t++) if (df[t] < best) { best = df[t]; bt = t; } if (best > 0.3) return null; tau = bt; }
    const a = df[tau - 1], b = df[tau], c = df[tau + 1], den = a - 2 * b + c;
    const sh = den !== 0 ? 0.5 * (a - c) / den : 0;
    return { f: rate / (tau + sh), conf: 1 - b };
  },
  async open(solo) {
    if (this.st) return;
    const h = K.h, c = this.cfg(), E = A.eng;
    const note = h('div', { class: 'tn-note', 'aria-hidden': 'true' }, '—'), oct = h('sub'), hz = h('div', { class: 'tn-hz' }, 'Play a single note');
    const dir = h('div', { class: 'tn-dir' }, ' '), live = h('div', { class: 'tn-live', 'aria-live': 'polite', role: 'status' });
    const cv = h('canvas', { class: 'tn-meter', 'aria-hidden': 'true' });
    const strings = h('div', { class: 'tn-strings', role: 'group', 'aria-label': 'Strings' });
    const modeSel = K.select(Object.entries(this.MODES).map(([k, v]) => [k, v[0]]), c.mode, (v) => { c.mode = v; this.saveCfg(c); s.lock = null; paintStrings(); this.toneOff(); });
    const a4v = h('b', null, c.a4 + ' Hz');
    const a4 = (d) => { c.a4 = U.clamp(c.a4 + d, 415, 466); a4v.textContent = c.a4 + ' Hz'; this.saveCfg(c); if (s.osc) this.tone(s.lock !== null ? s.lock : 69); };
    const toneBtn = h('button', { class: 'btn', 'aria-pressed': 'false', onclick: () => { if (s.osc) this.toneOff(); else this.tone(s.lock !== null ? s.lock : (this.MODES[c.mode][1] ? this.MODES[c.mode][1][0] : 69)); } }, '♪ Reference tone');
    const paintStrings = () => {
      strings.textContent = ''; const list = this.MODES[c.mode][1];
      strings.style.display = list ? '' : 'none';
      (list || []).forEach((n, i) => strings.append(h('button', { class: 'tn-str' + (s.lock === n ? ' lock' : ''), 'data-n': n, 'aria-pressed': s.lock === n ? 'true' : 'false', title: 'Lock to this string and hear it', onclick: () => { s.lock = s.lock === n ? null : n; paintStrings(); if (s.lock !== null) this.tone(n); else this.toneOff(); } },
        h('b', null, this.NAMES[n % 12]), h('span', null, (list.length - i) + ''))));
    };
    const close = () => this.close();
    const el = h('div', { class: 'tuner' + (solo ? ' solo' : ''), role: 'dialog', 'aria-label': 'Tuner' },
      h('div', { class: 'tn-head' }, h('div', { class: 'tn-title' }, 'Tuner', h('small', null, 'by DAWters & Son')), h('div', { class: 'spacer' }),
        solo ? h('button', { class: 'btn', onclick: () => { location.hash = ''; this.close(); } }, 'Open the studio') : h('button', { class: 'btn icon', 'aria-label': 'Close tuner', onclick: close }, '✕')),
      h('div', { class: 'tn-body' }, h('div', { class: 'tn-readout' }, h('div', { class: 'tn-notewrap' }, note, oct), dir, hz), cv, strings, live),
      h('div', { class: 'tn-foot' }, h('div', { class: 'field' }, h('label', null, 'Tune'), modeSel),
        h('div', { class: 'tn-a4' }, h('span', null, 'A4'), h('button', { class: 'btn sm icon', 'aria-label': 'Lower A4 by 1 hertz', onclick: () => a4(-1) }, '−'), a4v, h('button', { class: 'btn sm icon', 'aria-label': 'Raise A4 by 1 hertz', onclick: () => a4(1) }, '+')),
        toneBtn));
    const s = this.st = { el, note, oct, hz, dir, live, cv, strings, toneBtn, c, lock: null, hist: [], needle: 0, lastSay: 0, lastSaid: '', ownInput: !E.input, paintStrings };
    document.body.append(el);
    paintStrings();
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape' && !solo) return close();
      const list = this.MODES[c.mode][1];
      if ((e.key === 'ArrowRight' || e.key === 'ArrowLeft') && list) { e.preventDefault(); const i = list.indexOf(s.lock); const j = i < 0 ? 0 : (i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length; s.lock = list[j]; paintStrings(); this.tone(s.lock); }
      if (e.key === '+' || e.key === '=') a4(1); if (e.key === '-') a4(-1);
      if (e.key === 't' || e.key === 'T') toneBtn.click();
    });
    setTimeout(() => el.querySelector('select').focus(), 50);
    try {
      if (E.ctx.state !== 'running') await E.ctx.resume();
      const inp = await E.openInput();
      const an = E.ctx.createAnalyser(); an.fftSize = 4096; inp.src.connect(an);
      s.an = an; s.buf = new Float32Array(an.fftSize);
      const loop = () => { if (this.st !== s) return; this.tick(); s.raf = requestAnimationFrame(loop); };
      s.raf = requestAnimationFrame(loop);
    } catch (err) {
      hz.textContent = 'No microphone: ' + (err.message || err) + '. You can still use the reference tones.';
    }
  },
  tick() {
    const s = this.st, E = A.eng, c = s.c; s.frame = (s.frame || 0) + 1;
    this.draw();
    if (s.frame % 2) return; // pitch about 30 times a second is plenty
    s.an.getFloatTimeDomainData(s.buf);
    let e = 0; for (let i = 0; i < s.buf.length; i++) e += s.buf[i] * s.buf[i];
    const lvl = U.db(Math.sqrt(e / s.buf.length));
    const list = this.MODES[c.mode][1];
    const fmin = list ? this.freq(Math.min(...list) - 4, c.a4) : 30, fmax = list ? this.freq(Math.max(...list) + 7, c.a4) : 2100;
    const r = lvl > -55 ? this.yin(s.buf, E.ctx.sampleRate, fmin, fmax) : null;
    if (!r || r.conf < 0.85) { s.miss = (s.miss || 0) + 1; if (s.miss > 12) { s.hist = []; s.cur = null; this.show(null); } return; }
    s.miss = 0;
    s.hist.push(r.f); if (s.hist.length > 5) s.hist.shift();
    const f = s.hist.slice().sort((a, b) => a - b)[s.hist.length >> 1]; // median steadies the reading
    const nf = 69 + 12 * Math.log2(f / c.a4);
    let n = Math.round(nf);
    if (list) n = s.lock !== null ? s.lock : list.reduce((a, b) => (Math.abs(b - nf) < Math.abs(a - nf) ? b : a), list[0]);
    const cents = (nf - n) * 100;
    s.cur = { n, cents, f };
    this.show(s.cur);
  },
  show(cur) {
    const s = this.st, list = this.MODES[s.c.mode][1];
    s.el.classList.toggle('live', !!cur);
    if (!cur) { s.note.textContent = '—'; s.oct.textContent = ''; s.dir.textContent = ' '; s.hz.textContent = 'Play a single note'; s.el.classList.remove('intune'); return; }
    const pc = ((cur.n % 12) + 12) % 12, ok = Math.abs(cur.cents) < 3, far = Math.abs(cur.cents) > 50;
    s.note.textContent = this.NAMES[pc]; s.oct.textContent = String(Math.floor(cur.n / 12 - 1));
    s.hz.textContent = cur.f.toFixed(1) + ' Hz · target ' + this.freq(cur.n, s.c.a4).toFixed(1) + ' Hz';
    s.dir.textContent = ok ? 'In tune' : far ? (cur.cents < 0 ? 'Much too low — tighten' : 'Much too high — loosen') : (cur.cents < 0 ? '♭ ' + Math.round(-cur.cents) + ' cents low · tune up' : '♯ ' + Math.round(cur.cents) + ' cents high · tune down');
    s.el.classList.toggle('intune', ok);
    if (list) s.strings.querySelectorAll('.tn-str').forEach((b) => b.classList.toggle('near', +b.dataset.n === cur.n));
    // screen readers: say the note and how far off, at most every 1.5 s and only when it changes
    const now = performance.now(), say = this.SPOKEN[pc] + ' ' + Math.floor(cur.n / 12 - 1) + ', ' + (ok ? 'in tune' : Math.round(Math.abs(cur.cents)) + ' cents ' + (cur.cents < 0 ? 'flat' : 'sharp'));
    if (now - s.lastSay > 1500 && say !== s.lastSaid) { s.live.textContent = say; s.lastSay = now; s.lastSaid = say; }
  },
  draw() {
    const s = this.st, cv = s.cv, dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'), T = K.T || {}; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const tgt = s.cur ? U.clamp(s.cur.cents, -50, 50) : 0; s.needle += (tgt - s.needle) * 0.25;
    const ink = T.vuInk || '#1A1611', face = T.vu || '#F1E6C4', red = T.acc || '#C8231B';
    g.fillStyle = face; g.beginPath(); g.roundRect ? g.roundRect(1, 1, w - 2, h - 2, 14) : g.rect(1, 1, w - 2, h - 2); g.fill();
    const cx = w / 2, cy = h * 0.95, R = Math.min(h * 0.8, w * 0.45), ang = (c) => -Math.PI / 2 + c / 50 * 0.95;
    // in-tune window
    g.strokeStyle = ink; g.globalAlpha = 0.18; g.lineWidth = 16; g.beginPath(); g.arc(cx, cy, R - 4, ang(-3), ang(3)); g.stroke(); g.globalAlpha = 1;
    g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, R, ang(-50), ang(50)); g.stroke();
    g.font = '700 ' + Math.max(11, Math.round(h * 0.07)) + 'px "Courier Prime", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillStyle = ink;
    for (let c = -50; c <= 50; c += 5) {
      const a = ang(c), L = c % 25 === 0 ? 16 : c % 10 === 0 ? 10 : 6;
      g.lineWidth = c === 0 ? 3 : 1.4; g.beginPath(); g.moveTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); g.lineTo(cx + Math.cos(a) * (R + L), cy + Math.sin(a) * (R + L)); g.stroke();
      if (c % 25 === 0) g.fillText(c === 0 ? '0' : (c > 0 ? '+' : '−') + Math.abs(c), cx + Math.cos(a) * (R + 30), cy + Math.sin(a) * (R + 26));
    }
    g.font = '600 ' + Math.round(h * 0.09) + 'px Oswald, sans-serif'; g.fillText('♭', cx - R * 0.72, cy - R * 0.25); g.fillText('♯', cx + R * 0.72, cy - R * 0.25);
    if (s.cur) {
      const a = ang(s.needle), ok = Math.abs(s.cur.cents) < 3;
      g.strokeStyle = ok ? ink : red; g.lineWidth = ok ? 5 : 3.5; g.lineCap = 'round';
      g.beginPath(); g.moveTo(cx + Math.cos(a) * R * 0.1, cy + Math.sin(a) * R * 0.1); g.lineTo(cx + Math.cos(a) * (R + 10), cy + Math.sin(a) * (R + 10)); g.stroke();
    }
    g.fillStyle = ink; g.beginPath(); g.arc(cx, cy, 10, 0, Math.PI * 2); g.fill();
  },
  tone(n) {
    this.toneOff(); const E = A.eng, s = this.st; if (!s) return;
    const f = this.freq(n, s.c.a4), o = E.ctx.createOscillator(), o2 = E.ctx.createOscillator(), g = E.ctx.createGain(), t = E.ctx.currentTime;
    o.type = 'triangle'; o.frequency.value = f; o2.type = 'sine'; o2.frequency.value = f * 2;
    const g2 = E.ctx.createGain(); g2.gain.value = 0.25; o2.connect(g2); g2.connect(g); o.connect(g);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.18, t + 0.04); g.connect(E.ctx.destination);
    o.start(); o2.start(); s.osc = { o, o2, g };
    s.toneBtn.classList.add('on'); s.toneBtn.setAttribute('aria-pressed', 'true'); s.toneBtn.textContent = '♪ ' + this.noteName(n) + ' playing';
  },
  toneOff() {
    const s = this.st; if (!s || !s.osc) return;
    const { o, o2, g } = s.osc, t = A.eng.ctx.currentTime; g.gain.setTargetAtTime(0, t, 0.03); o.stop(t + 0.2); o2.stop(t + 0.2); s.osc = null;
    s.toneBtn.classList.remove('on'); s.toneBtn.setAttribute('aria-pressed', 'false'); s.toneBtn.textContent = '♪ Reference tone';
  },
  close() {
    const s = this.st; if (!s) return;
    this.toneOff(); cancelAnimationFrame(s.raf);
    try { s.an && s.an.disconnect(); A.eng.input && A.eng.input.src.disconnect(s.an); } catch (e) { /* */ }
    const E = A.eng; if (s.ownInput && E.input && !E.recording && !A.settings.capListen && !A.proj.tracks.some((t) => t.arm || t.mon)) E.closeInput();
    s.el.remove(); this.st = null;
  },
};
