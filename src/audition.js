// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — Audition: hear an effect right now, while you turn its knobs.
// A private copy of the effect runs on a looping source (the track's own audio, a built-in test sound,
// or the microphone); "Song" plays the real mix from the playhead instead. Bypass flips to the dry sound.
'use strict';
const AUD = {
  SOURCES: [
    ['clip', 'This track’s audio (loop)'], ['song', 'The song, from the playhead'],
    ['drums', 'Test · drum loop'], ['snare', 'Test · snare hits (hear the tails)'], ['vocal', 'Test · voice'],
    ['guitar', 'Test · guitar chords'], ['keys', 'Test · keys'], ['bass', 'Test · bass line'], ['beat', 'Test · full beat'], ['mic', 'Microphone (live — use headphones)'],
  ],
  // a sensible first sound for each effect, when the track has no audio of its own
  PICK: { reverb: 'snare', delay: 'snare', deess: 'vocal', doubler: 'vocal', opto: 'vocal', fet: 'drums', buscomp: 'beat', comp: 'drums', mband: 'beat', tplim: 'beat', trans: 'drums', gate: 'drums', satur: 'guitar', drive: 'guitar', dist: 'guitar', tubeeq: 'beat', peq: 'beat', geq: 'beat', imager: 'beat', width: 'keys', chorus: 'guitar', phaser: 'guitar', tremolo: 'keys', filter: 'beat' },
  cache: {}, cur: null, // { o, f, kind, src, fx, wet, dry, out, mic, song, bypass, an }
  active(f) { return !!(this.cur && this.cur.f === f); },
  defaultSource(o, f) {
    if (o.clips && o.clips.some((c) => c.buf)) return 'clip';
    if (!o.clips) return 'song'; // mixbus or master: hear the real mix
    return this.PICK[f.type] || 'beat';
  },
  // ---------- built-in test sounds (synthesised once, about 4.8 s loops at 100 BPM) ----------
  make(kind) {
    const E = A.eng, sr = E.ctx.sampleRate;
    if (this.cache[kind + sr]) return this.cache[kind + sr];
    const beat = 0.6, len = Math.round(sr * beat * 8), L = new Float32Array(len), R = new Float32Array(len);
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x3fffffff - 1; };
    const add = (t0, fn, dur, pan = 0) => { const a = Math.round(t0 * sr), n = Math.round(dur * sr), gl = Math.cos((pan + 1) * Math.PI / 4) * 1.41, gr = Math.sin((pan + 1) * Math.PI / 4) * 1.41; for (let i = 0; i < n && a + i < len; i++) { const v = fn(i / sr); L[a + i] += v * gl; R[a + i] += v * gr; } };
    const kick = (t) => Math.sin(2 * Math.PI * (45 * t + 75 * 0.06 * (1 - Math.exp(-t / 0.06)))) * Math.exp(-t / 0.28) * 0.9;
    const bp = (() => { let a = 0, b = 0; return (x, f, q) => { const w = 2 * Math.PI * f / sr; a += w * (x - a - b / q); b += w * a; return a; }; });
    const snare = () => { const f = bp(); return (t) => (f(rnd(), 1800, 0.8) * 0.9 + Math.sin(2 * Math.PI * 185 * t) * 0.5) * Math.exp(-t / 0.13); };
    const hat = () => { let p = 0; return (t) => { const x = rnd(), y = x - p; p = x; return y * 0.25 * Math.exp(-t / 0.03); }; };
    const mtof = (n) => 440 * Math.pow(2, (n - 69) / 12);
    const pluck = (n, dur) => { // Karplus–Strong string
      const p = Math.max(2, Math.round(sr / mtof(n))), buf = new Float32Array(p); for (let i = 0; i < p; i++) buf[i] = rnd(); let i = 0;
      return () => { const j = (i + 1) % p, v = buf[i]; buf[i] = 0.4985 * (buf[i] + buf[j]); i = j; return v * 0.5; };
    };
    const keys = (n) => (t) => { const f = mtof(n); let v = 0; for (let k = 1; k <= 6; k++) v += Math.sin(2 * Math.PI * f * k * t) / (k * k) * Math.exp(-t * (0.8 + k * 0.7)); return v * 0.35 * Math.min(1, t / 0.004); };
    const bass = (n, d) => { let ph = 0, lp = 0; const f = mtof(n); return (t) => { ph = (ph + f / sr) % 1; lp += (ph * 2 - 1 - lp) * 0.06; return lp * 0.55 * Math.min(1, t / 0.005) * Math.max(0, Math.min(1, (d - t) / 0.03)); }; };
    const drums = () => { for (let b = 0; b < 8; b++) { const t = b * beat; if (b % 4 === 0 || b === 6 || b === 3.5) add(t, kick, 0.6); if (b % 2 === 1) add(t, snare(), 0.4, 0.05); add(t, hat(), 0.1, 0.3); add(t + beat / 2, hat(), 0.1, 0.3); } add(3.5 * beat, kick, 0.6); };
    if (kind === 'drums') drums();
    else if (kind === 'snare') { add(0.1, snare(), 0.4); add(beat * 4 + 0.1, snare(), 0.4); add(beat * 2 + 0.1, kick, 0.6); add(beat * 6 + 0.1, (t) => Math.sin(2 * Math.PI * 900 * t) * Math.exp(-t / 0.02) * 0.6, 0.1); }
    else if (kind === 'guitar') { [[40, 47, 52, 56, 59, 64], [45, 52, 57, 61, 64], [50, 57, 62, 66], [43, 47, 50, 55, 59, 67]].forEach((ch, ci) => ch.forEach((n, si) => { const s = pluck(n); add(ci * beat * 2 + si * 0.018, s, beat * 2, (si / ch.length - 0.5) * 0.4); })); }
    else if (kind === 'keys') { [[48, 55, 59, 64], [45, 52, 55, 60], [41, 48, 52, 57], [43, 50, 53, 59]].forEach((ch, ci) => ch.forEach((n) => add(ci * beat * 2, keys(n), beat * 2.2))); }
    else if (kind === 'bass') { [36, 36, 43, 41, 33, 33, 40, 38].forEach((n, i) => add(i * beat, bass(n, beat * 0.9), beat * 0.95)); }
    else if (kind === 'beat') { drums(); [36, 36, 43, 41, 33, 33, 40, 38].forEach((n, i) => add(i * beat, bass(n, beat * 0.9), beat * 0.95)); [[60, 64, 67, 71], [57, 60, 64, 67]].forEach((ch, ci) => ch.forEach((n) => add(ci * beat * 4, keys(n), beat * 3.5, 0.2))); }
    else if (kind === 'vocal') { // a sung "ah-eh-oh" phrase with vibrato and a few sibilants
      const F = { a: [800, 1150, 2900], e: [500, 1750, 2600], o: [450, 800, 2830], i: [300, 2200, 3000] };
      const notes = [[57, 'a', 0.9], [60, 'e', 0.9], [62, 'o', 1.4], [60, 'i', 0.6], [57, 'a', 0.9]];
      let t0 = 0.15;
      notes.forEach(([n, v, d], ni) => {
        const fm = F[v], rs = fm.map(() => bp()); let ph = 0;
        if (ni % 2 === 0) { let p = 0; add(t0 - 0.09, (t) => { const x = rnd(), y = x - p; p = x; return y * 0.35 * Math.sin(Math.PI * t / 0.09); }, 0.09); } // "s"
        add(t0, (t) => { const f = mtof(n) * (1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * t) * Math.min(1, t / 0.3)); ph = (ph + f / sr) % 1; const src = ph * 2 - 1; let y = 0; rs.forEach((r, k) => { y += r(src, fm[k], 12) * [1, 0.6, 0.3][k]; }); return y * 0.6 * Math.min(1, t / 0.05) * Math.min(1, (d - t) / 0.08); }, d);
        t0 += d + 0.08;
      });
    }
    let pk = 0; for (let i = 0; i < len; i++) pk = Math.max(pk, Math.abs(L[i]), Math.abs(R[i]));
    const g = pk > 0 ? 0.5 / pk : 1; for (let i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
    return (this.cache[kind + sr] = E.makeBuffer([L, R], sr));
  },
  clipBuffer(o) {
    const E = A.eng, pos = E.pos(), cs = o.clips.filter((c) => c.buf && E.buffers.get(c.buf));
    const c = cs.find((x) => pos >= x.start && pos < x.start + x.len) || cs.find((x) => x.start >= pos) || cs[0]; if (!c) return null;
    const b = E.buffers.get(c.buf).ab, sr = b.sampleRate, from = pos >= c.start && pos < c.start + c.len ? pos - c.start : 0;
    const a = Math.floor((c.off + from) * sr), n = Math.min(Math.floor(sr * 8), Math.floor((c.off + c.len) * sr) - a);
    if (n < sr * 0.2) return null;
    const chs = []; for (let ch = 0; ch < b.numberOfChannels; ch++) chs.push(b.getChannelData(ch).slice(a, a + n));
    return { buf: E.makeBuffer(chs, sr), name: c.name || 'clip' };
  },
  async start(o, f, kind) {
    this.stop();
    const E = A.eng, ctx = E.ctx; if (ctx.state !== 'running') await ctx.resume();
    const cur = { o, f, kind, bypass: false };
    if (kind === 'song') { // the real mix, with the effect in its real place
      cur.song = true; cur.wasOn = f.on;
      if (!f.on) { f.on = true; E.graph.refreshFx(o); }
      if (!E.playing) await E.play();
      this.cur = cur; return 'Playing the song through the mix — the effect is in its real place.';
    }
    const fx = FX.types[f.type].create(ctx, Object.assign({}, f.p), { bpm: A.proj.bpm, eng: E, id: 'aud', offline: false });
    const wet = ctx.createGain(), dry = ctx.createGain(), out = ctx.createGain(); dry.gain.value = 0;
    let src, msg;
    if (kind === 'mic') {
      const inp = await E.openInput(); src = ctx.createGain(); inp.src.connect(src); cur.mic = inp; cur.ownMic = true;
      msg = 'Live from ' + (inp.label || 'the microphone') + '. Use headphones to avoid feedback.';
    } else {
      let b = null;
      if (kind === 'clip') { const r = this.clipBuffer(o); if (r) { b = r.buf; msg = 'Looping “' + r.name + '” from the playhead (dry, before the strip).'; } else { kind = this.PICK[f.type] || 'beat'; cur.kind = kind; } }
      if (!b) { b = this.make(kind); msg = msg || 'Looping the ' + this.SOURCES.find((s) => s[0] === kind)[1].replace(/^Test · /, '') + '.'; }
      src = ctx.createBufferSource(); src.buffer = b; src.loop = true; src.start();
    }
    src.connect(fx.input); src.connect(dry); fx.output.connect(wet); wet.connect(out); dry.connect(out); out.connect(E.outNode);
    const an = ctx.createAnalyser(); an.fftSize = 1024; out.connect(an);
    Object.assign(cur, { src, fx, wet, dry, out, an });
    this.cur = cur;
    return msg;
  },
  update(f) { const c = this.cur; if (c && c.f === f && c.fx) c.fx.set(Object.assign({}, f.p)); },
  setBypass(on) {
    const c = this.cur; if (!c) return; c.bypass = on;
    if (c.song) { c.f.on = !on; A.eng.graph.refreshFx(c.o); return; }
    const t = A.eng.ctx.currentTime; c.wet.gain.setTargetAtTime(on ? 0 : 1, t, 0.01); c.dry.gain.setTargetAtTime(on ? 1 : 0, t, 0.01);
  },
  level() { const c = this.cur; if (!c || !c.an) return 0; const d = this._d || (this._d = new Float32Array(1024)); c.an.getFloatTimeDomainData(d); let m = 0; for (const v of d) m = Math.max(m, Math.abs(v)); return m; },
  stop() {
    const c = this.cur; if (!c) return; this.cur = null;
    if (c.song) { c.f.on = c.wasOn; A.eng.graph.refreshFx(c.o); if (A.eng.playing) A.stop(); return; }
    try { if (c.src.stop) c.src.stop(); } catch (e) { /* */ }
    try { if (c.mic) c.mic.src.disconnect(c.src); } catch (e) { /* */ }
    [c.src, c.fx.output, c.wet, c.dry, c.out, c.an].forEach((n) => { try { n.disconnect(); } catch (e) { /* */ } });
    try { c.fx.dispose(); } catch (e) { /* */ }
    const E = A.eng; if (c.mic && E.input && !E.recording && !A.proj.tracks.some((t) => t.arm || t.mon) && !(typeof TUNER !== 'undefined' && TUNER.st)) E.closeInput();
  },
  // the strip shown at the top of every effect panel
  bar(o, f) {
    const h = K.h;
    let kind = this.active(f) ? this.cur.kind : this.defaultSource(o, f);
    const opts = this.SOURCES.filter(([k]) => (k !== 'clip' || (o.clips && o.clips.some((c) => c.buf))));
    const sel = K.select(opts, kind, (v) => { kind = v; if (this.cur && this.cur.f === f) go(); });
    const play = h('button', { class: 'btn aud-play' }), byp = h('button', { class: 'btn aud-byp', 'aria-pressed': 'false', title: 'Compare: hear the sound without the effect' }, 'Hear dry');
    const lvl = h('div', { class: 'aud-lvl' }, h('i')), note = h('div', { class: 'aud-note' });
    const paint = () => { const on = this.active(f); play.textContent = on ? '■ Stop' : '▶ Listen'; play.classList.toggle('on', on); byp.disabled = !on; byp.classList.toggle('on', on && this.cur.bypass); byp.setAttribute('aria-pressed', on && this.cur.bypass ? 'true' : 'false'); };
    const go = async () => { try { note.textContent = await this.start(o, f, kind); } catch (e) { note.textContent = 'Could not start: ' + (e.message || e); this.stop(); } paint(); };
    play.addEventListener('click', async () => { if (this.active(f)) { this.stop(); note.textContent = ''; paint(); } else await go(); });
    byp.addEventListener('click', () => { if (!this.active(f)) return; this.setBypass(!this.cur.bypass); paint(); });
    const el = h('div', { class: 'opt aud' }, h('div', { class: 'aud-row' }, h('span', { class: 'aud-t' }, 'Audition'), sel), h('div', { class: 'aud-row' }, play, byp, lvl), note);
    const tick = setInterval(() => { if (!el.isConnected) { clearInterval(tick); return; } const v = this.active(f) ? this.level() : 0; lvl.firstChild.style.width = Math.min(100, Math.max(0, (U.db(v) + 48) / 48 * 100)) + '%'; lvl.firstChild.classList.toggle('hot', v > 0.89); if (!this.active(f) && play.classList.contains('on')) paint(); }, 60);
    paint();
    return el;
  },
};
