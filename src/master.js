// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — mastering: loudness targets, drive into the limiter, master-chain presets, VU and analysis
'use strict';
const MST = {
  // id: [label, integrated LUFS, true-peak ceiling]
  TARGETS: {
    stream: ['Streaming · −14 LUFS', -14, -1],
    apple: ['Apple Music · −16 LUFS', -16, -1],
    loud: ['CD / club · −9 LUFS', -9, -0.3],
    podcast: ['Podcast · −16 LUFS', -16, -1],
    broadcast: ['Broadcast EBU R128 · −23 LUFS', -23, -1],
    dynamic: ['Dynamic (jazz, classical) · −18 LUFS', -18, -1],
  },
  target(P) { return MST.TARGETS[(P || A.proj).master.target] || MST.TARGETS.stream; },
  // ---- 4× oversampled true peak (BS.1770 style), only evaluated near the loud samples ----
  truePeak(chs) {
    const PH = 4, TAPS = 12, h = [];
    for (let p = 1; p < PH; p++) {
      const k = []; let sum = 0;
      for (let t = 0; t < TAPS; t++) { const x = t - TAPS / 2 + 1 - p / PH; const w = 0.42 + 0.5 * Math.cos(Math.PI * x / (TAPS / 2)) + 0.08 * Math.cos(2 * Math.PI * x / (TAPS / 2)); const v = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * w; k.push(v); sum += v; }
      h.push(k.map((v) => v / sum));
    }
    let tp = 0;
    for (const d of chs) {
      let sp = 0; for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > sp) sp = a; }
      tp = Math.max(tp, sp); const gate = sp * 0.6;
      for (let i = TAPS; i < d.length - TAPS; i++) {
        if (Math.abs(d[i]) < gate && Math.abs(d[i + 1]) < gate) continue;
        for (let p = 0; p < PH - 1; p++) { const k = h[p]; let y = 0; for (let t = 0; t < TAPS; t++) y += k[t] * d[i - TAPS / 2 + 1 + t]; const a = Math.abs(y); if (a > tp) tp = a; }
      }
    }
    return tp;
  },
  stats(buf) {
    const chs = [buf.getChannelData(0), buf.getChannelData(1)];
    let pk = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; }
    return { I: A.lufs(chs, buf.sampleRate), tp: U.db(MST.truePeak(chs)), pk: U.db(pk) };
  },
  // render the song through the master, finding the drive that lands on the target loudness (2–4 renders)
  async fit(r, sr, tail, tgt, ceil, note) {
    const P = A.proj, E = A.eng;
    let d = P.master.drive || 0, best = null, c = ceil;
    for (let pass = 0; pass < 4; pass++) {
      note && note('Mastering pass ' + (pass + 1) + ' — drive ' + (d >= 0 ? '+' : '') + d.toFixed(1) + ' dB…');
      const buf = await E.render({ s: r.s, e: r.e, sr, tail, driveDb: d, ceiling: c });
      const st = MST.stats(buf); st.drive = d; st.buf = buf; st.ceiling = c;
      if (!best || Math.abs(st.I - tgt) < Math.abs(best.I - tgt) || (st.tp <= ceil + 0.1 && best.tp > ceil + 0.1)) best = st;
      if (!(st.I > -70)) break; // silence
      const off = tgt - st.I, tpOver = st.tp - ceil;
      if (Math.abs(off) <= 0.3 && tpOver <= 0.1) break;
      if (tpOver > 0.1) c = Math.max(-6, c - tpOver - 0.05);
      // pushing into the limiter gives back less than it takes, so overshoot a little when raising
      d = U.clamp(d + off * (off > 0 && pass > 0 ? 1.25 : 1), -24, 24);
    }
    return best;
  },
};

// ---------- mastering recipes: complete starting points, all ordinary editable inserts ----------
// fx: [type, params]; target: loudness target id; tape: master tape amount. Drive is then set by Match target.
MST.RECIPES = [
  ['By genre', [
    ['pop', 'Pop & streaming', 'Clean top end, bus glue, gentle multiband, tidy low end, ready for the playlists.', 'stream', 0, [['peq', { hp: 25, m1f: 300, m1g: -1, hf: 11000, hg: 1.5 }], ['buscomp', { thr: -14, ratio: 0, att: 4, rel: 4, make: 2, hpf: 1 }], ['mband', { t1: -22, r1: 2, t2: -24, r2: 1.8, t3: -26, r3: 2, g3: 0.5 }], ['imager', { xover: 150, lowW: 0.3, highW: 1.15 }], ['tplim', { gain: 2, ceil: -1 }]]],
    ['hiphop', 'Hip-hop & trap', 'Big, mono sub; Pultec-style low trick; harder bus compression and a little tube grit. Loud.', 'loud', 0, [['peq', { hp: 22, m1f: 350, m1g: -1.5 }], ['tubeeq', { lf: 2, lb: 3, la: 2, hf: 4, hb: 2, bw: 6 }], ['buscomp', { thr: -16, ratio: 1, att: 5, rel: 1, make: 3, hpf: 1 }], ['satur', { style: 1, drive: 4, mix: 0.5 }], ['imager', { xover: 120, lowW: 0, highW: 1.2 }], ['tplim', { gain: 4, ceil: -1, style: 1 }]]],
    ['rock', 'Rock & band', 'Less boxiness, more bite, console-style bus compression and tape warmth.', 'stream', 0.15, [['peq', { hp: 30, m1f: 400, m1g: -1.5, m2f: 3000, m2g: 1 }], ['buscomp', { thr: -16, ratio: 1, att: 5, rel: 4, make: 3, hpf: 1 }], ['satur', { style: 0, drive: 6, mix: 0.6 }], ['tplim', { gain: 3, style: 1 }]]],
    ['edm', 'EDM & club', 'Tight multiband, mono bass, wide highs, console drive, aggressive limiting to club level.', 'loud', 0, [['peq', { hp: 28, lf: 55, lg: 1, hf: 12000, hg: 2 }], ['mband', { t1: -20, r1: 3, g1: 1, t2: -22, r2: 2.5, t3: -24, r3: 2.5, g3: 1, att: 5, rel: 120 }], ['satur', { style: 3, drive: 6, mix: 0.5 }], ['imager', { xover: 150, lowW: 0, highW: 1.3 }], ['tplim', { gain: 6, style: 2, ceil: -0.3 }]]],
    ['rnb', 'R&B & soul', 'Silky: tube EQ air and warmth, opto smoothing, a touch of de-essing.', 'stream', 0.1, [['tubeeq', { lf: 1, lb: 3, la: 1, hf: 5, hb: 3, bw: 8, tube: 0.4 }], ['opto', { peak: 30, gain: 3, mix: 0.8 }], ['deess', { freq: 7000, thr: -30, range: 4 }], ['imager', { xover: 150, lowW: 0.4, highW: 1.1 }], ['tplim', { gain: 2 }]]],
    ['acoustic', 'Acoustic & folk', 'Light touch: clear the low mids, open the top, gentle levelling, plenty of dynamics.', 'apple', 0, [['peq', { hp: 35, m1f: 250, m1g: -1, hf: 12000, hg: 1 }], ['opto', { peak: 20, gain: 2 }], ['tplim', { gain: 1, rel: 200 }]]],
    ['jazz', 'Jazz & classical', 'Almost nothing: a whisper of air and a transparent safety limiter. Keeps the dynamics.', 'dynamic', 0, [['peq', { hp: 20, hf: 14000, hg: 0.5 }], ['tplim', { gain: 0, rel: 300 }]]],
    ['lofi', 'Lo-fi & chill', 'Dark, saturated tape, soft bus compression. Dusty on purpose.', 'stream', 0.3, [['peq', { hp: 60, hf: 9000, hg: -4 }], ['satur', { style: 0, drive: 10, tone: -0.4, highcut: 12000, mix: 0.7 }], ['buscomp', { thr: -18, ratio: 0, att: 5, rel: 4, make: 2 }], ['tplim', { gain: 2 }]]],
  ]],
  ['By approach', [
    ['transparent', 'Transparent polish', 'Only a low cut and a clean true-peak limiter. The mix, just louder and safe.', 'stream', 0, [['peq', { hp: 20 }], ['tplim', { gain: 1, rel: 150, style: 0 }]]],
    ['glue', 'Glue & cohesion', 'A slow 2:1 bus compressor with sidechain filter: the parts start to feel like one record.', 'stream', 0, [['buscomp', { thr: -16, ratio: 0, att: 4, rel: 4, make: 2, hpf: 2 }], ['tplim', { gain: 1 }]]],
    ['loud', 'Loud & competitive', 'Multiband control, console saturation and punchy limiting. Use with care.', 'loud', 0, [['mband', { t1: -20, r1: 3, t2: -22, r2: 2.5, t3: -22, r3: 2.5, att: 8, rel: 120 }], ['satur', { style: 3, drive: 5, mix: 0.4 }], ['tplim', { gain: 6, style: 1 }]]],
    ['warm', 'Warm analog', 'Tube EQ curves, opto levelling and tape: rounder, softer, older.', 'stream', 0.35, [['tubeeq', { lb: 2, hb: 2, tube: 0.6 }], ['opto', { peak: 25, gain: 2 }], ['satur', { style: 0, drive: 6, mix: 0.5 }], ['tplim', { gain: 1 }]]],
    ['wide', 'Wide & airy', 'Air shelf, cleared mud, mono bass and wider highs.', 'stream', 0, [['peq', { m1f: 300, m1g: -1, hf: 12000, hg: 2 }], ['imager', { xover: 250, lowW: 0.2, highW: 1.35 }], ['buscomp', { thr: -14, ratio: 0, att: 4, rel: 4, make: 1 }], ['tplim', { gain: 1 }]]],
    ['podcast', 'Podcast & voice', 'Rumble cut, de-mud, presence, de-essing and firm opto levelling for speech.', 'podcast', 0, [['peq', { hp: 80, m1f: 250, m1g: -2, m2f: 3500, m2g: 2 }], ['deess', { freq: 6500, thr: -26, range: 8 }], ['opto', { peak: 45, gain: 6 }], ['tplim', { gain: 2 }]]],
    ['demo', 'Demo quick-master', 'Two steps, fast: bus glue and a limiter. Good for sending a rough mix.', 'stream', 0, [['buscomp', { thr: -14, ratio: 0, att: 4, rel: 4, make: 2 }], ['tplim', { gain: 3 }]]],
    ['radio', 'Radio 1955', 'Band-limited, near-mono, FET-squashed, tube and tape. A sound, not a polish.', 'stream', 0.4, [['peq', { hp: 120, m1f: 1200, m1g: 3, m1q: 0.7, hf: 7000, hg: -8 }], ['fet', { input: 18, ratio: 1, att: 0.4, rel: 300, color: 0.6 }], ['satur', { style: 1, drive: 8 }], ['imager', { xover: 4000, lowW: 0, highW: 0.3 }], ['tplim', { gain: 1 }]]],
  ]],
];
MST.recipe = (id) => { for (const [, list] of MST.RECIPES) for (const r of list) if (r[0] === id) return r; return null; };
MST.applyRecipe = (id) => {
  const r = MST.recipe(id), P = A.proj, m = P.master; if (!r) return;
  A.commit('Mastering recipe');
  m.fx = r[5].map(([type, p]) => ({ id: U.uid('f'), type, on: true, p: Object.assign(FX.defaults(type), p) }));
  m.recipe = id; m.target = r[3]; m.ch.tape = r[4]; m.drive = 0; m.ch.limOn = true; m.ch.ceiling = MST.TARGETS[r[3]][2];
  A.changed({ graph: true, console: true });
};

// ---------- the Master view ----------
Object.assign(MST, {
  view: null, compare: false, rms: { pre: 0, post: 0 }, ui: null,
  shown() { return this.view && this.view.classList.contains('show'); },
  setCompare(on) {
    this.compare = !!on; const G = A.eng && A.eng.graph; if (!G || !G.mOut) return;
    const t = A.eng.ctx.currentTime;
    G.mOut.gain.setTargetAtTime(on ? 0 : 1, t, 0.015);
    G.abPath.gain.setTargetAtTime(on ? this.matchGain() : 0, t, 0.015);
    if (this.ui && this.ui.ab) { this.ui.ab.classList.toggle('on', this.compare); this.ui.ab.textContent = this.compare ? 'B · Unmastered (level-matched)' : 'A · Mastered — tap to compare'; }
  },
  // gain that makes the unmastered mix as loud as the mastered one, so the comparison is about sound, not level
  matchGain() { const a = this.rms.pre, b = this.rms.post; return a > 1e-7 && b > 1e-7 ? U.clamp(Math.sqrt(b / a), 0.05, 20) : 1; },
  render() {
    const h = K.h, v = this.view || (this.view = document.getElementById('master')), P = A.proj, m = P.master, E = A.eng;
    v.textContent = '';
    const target = MST.target();
    const tgtSel = K.select(Object.entries(MST.TARGETS).map(([k, x]) => [k, x[0]]), m.target, (val) => { A.commit('Loudness target'); m.target = val; m.ch.ceiling = MST.TARGETS[val][2]; E.graph.masterParams(m); A.save(); this.render(); });
    const ab = h('button', { class: 'btn ab-btn' + (this.compare ? ' on' : ''), title: 'Switch between the mastered sound and the unmastered mix at the same loudness', onclick: () => this.setCompare(!this.compare) }, this.compare ? 'B · Unmastered (level-matched)' : 'A · Mastered — tap to compare');
    const res = h('div', { class: 'note ms-res' }, m.recipe ? 'Recipe: ' + (MST.recipe(m.recipe) || [, ''])[1] + '. Press Match target to set the drive for ' + target[1] + ' LUFS.' : 'Pick a recipe, or build your own chain. Then Match target sets the loudness.');
    const prog = h('div', { class: 'prog' }, h('i'));
    const busy = (b) => v.querySelectorAll('.ms-bar .btn').forEach((x) => (x.disabled = b));
    const match = async () => {
      const end = M.songEnd(P); if (end <= 0) { res.textContent = 'Nothing to master yet.'; return; }
      if (E.playing) await A.stop(); busy(true); prog.firstChild.style.width = '8%';
      try {
        const t = MST.target();
        const st = await MST.fit({ s: 0, e: end }, E.sr, 0.5, t[1], t[2], (s) => { res.textContent = s; prog.firstChild.style.width = Math.min(92, parseFloat(prog.firstChild.style.width) + 22) + '%'; });
        A.commit('Match loudness'); m.drive = Math.round(st.drive * 10) / 10; m.ch.ceiling = Math.round(st.ceiling * 10) / 10; m.ch.limOn = true;
        E.graph.masterParams(m); A.changed({ console: true }); this.render();
        this.report(st, 'Matched');
      } catch (e) { res.textContent = 'Could not analyse: ' + (e.message || e); }
      busy(false);
    };
    const analyse = async () => {
      const end = M.songEnd(P); if (end <= 0) { res.textContent = 'Nothing to analyse yet.'; return; }
      if (E.playing) await A.stop(); busy(true); res.textContent = 'Rendering the whole song through the master…'; prog.firstChild.style.width = '30%';
      try { const buf = await E.render({ s: 0, e: end, sr: E.sr, tail: 0.5 }); const st = MST.stats(buf); st.drive = m.drive || 0; this.report(st, 'Analysis'); }
      catch (e) { res.textContent = 'Could not analyse: ' + (e.message || e); }
      busy(false);
    };
    const bar = h('div', { class: 'ms-bar' },
      h('div', { class: 'field' }, h('label', null, 'Target'), tgtSel), ab,
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: analyse }, 'Analyse'),
      h('button', { class: 'btn', onclick: () => A.exportDialog({ loud: 'target' }) }, 'Export master…'),
      h('button', { class: 'btn on primary', onclick: match }, 'Match target'));
    // recipes
    const lib = h('div', { class: 'ms-col ms-lib' }, h('div', { class: 'ms-h' }, 'Recipes'));
    MST.RECIPES.forEach(([grp, list]) => {
      lib.append(h('div', { class: 'sh-sub' }, grp));
      list.forEach(([id, name, about, tg]) => lib.append(h('button', { class: 'ms-card' + (m.recipe === id ? ' on' : ''), onclick: () => { MST.applyRecipe(id); this.render(); } },
        h('b', null, name), h('span', { class: 'ms-tag' }, MST.TARGETS[tg][1] + ' LUFS'), h('i', null, about))));
    });
    // chain rack
    const rack = h('div', { class: 'ms-col ms-rack' }, h('div', { class: 'ms-h' }, 'Chain', h('span', null, 'signal flows top to bottom')));
    const G = () => E.graph.refreshFx(m);
    m.fx.forEach((f, k) => {
      const def = FX.types[f.type]; if (!def) return;
      const knobs = h('div', { class: 'ms-knobs' });
      def.params.forEach((s) => {
        if (s.opts) knobs.append(h('label', { class: 'ms-opt' }, h('span', null, s.n), K.select(s.opts.map((x, i) => [i, x]), f.p[s.k], (val) => { A.commit(def.short + ' ' + s.n, true); f.p[s.k] = +val; G(); A.save(); })));
        else knobs.append(K.knob(Object.assign({}, s, { size: 'sm', get: () => f.p[s.k], begin: () => A.commit(def.short + ' ' + s.n, true), set: (val, fin) => { f.p[s.k] = val; G(); if (fin) A.save(); } })));
      });
      const lamp = h('button', { class: 'lamp' + (f.on ? ' on' : ''), title: f.on ? 'On — click to bypass' : 'Bypassed — click to enable', 'aria-label': 'Bypass', onclick: () => { A.commit('FX bypass'); f.on = !f.on; A.changed({ graph: true, console: true }); this.render(); } });
      const mv = (d) => { const j = k + d; if (j < 0 || j >= m.fx.length) return; A.commit('Move FX'); const [x] = m.fx.splice(k, 1); m.fx.splice(j, 0, x); A.changed({ graph: true, console: true }); this.render(); };
      const gr = def.gr ? h('div', { class: 'grbar', 'data-fx': f.id }, h('i')) : null;
      rack.append(h('div', { class: 'ms-unit' + (f.on ? '' : ' off') },
        h('div', { class: 'ms-uh' }, lamp, h('b', null, (k + 1) + ' · ' + def.name), gr, h('div', { class: 'spacer' }),
          h('button', { class: 'mini', title: 'Move up', onclick: () => mv(-1) }, '↑'), h('button', { class: 'mini', title: 'Move down', onclick: () => mv(1) }, '↓'),
          h('button', { class: 'mini', title: 'Remove', onclick: () => { A.commit('Remove FX'); m.fx.splice(k, 1); A.changed({ graph: true, console: true }); this.render(); } }, '✕')),
        knobs));
    });
    if (m.fx.length < M.NFX) rack.append(h('button', { class: 'act add', onclick: (e) => K.menu([{ head: 'Add to the master' }, ...A.fxItems(m, m.fx.length, false).map((it) => it.act ? Object.assign({}, it, { act: () => { it.act(); A.closeFx(); this.render(); } }) : it)], e.clientX, e.clientY) }, '+ Add a processor'));
    // final stage (the master strip's own limiter)
    const fin = h('div', { class: 'ms-unit ms-final' }, h('div', { class: 'ms-uh' }, h('b', null, 'Final stage · drive into the limiter'), h('div', { class: 'grbar', 'data-fx': 'masterLim' }, h('i'))),
      h('div', { class: 'ms-knobs' },
        K.knob({ n: 'Drive', min: -12, max: 24, def: 0, u: 'dB', bipolar: true, get: () => m.drive || 0, begin: () => A.commit('Drive', true), set: (val, f2) => { m.drive = Math.round(val * 10) / 10; E.graph.masterParams(m); if (f2) A.save(); } }),
        K.knob({ n: 'Ceiling', min: -6, max: 0, def: -1, u: 'dB', get: () => m.ch.ceiling, begin: () => A.commit('Ceiling', true), set: (val, f2) => { m.ch.ceiling = Math.round(val * 10) / 10; m.ch.limOn = true; E.graph.masterParams(m); if (f2) { A.save(); A.changed({ console: true }); } } }),
        K.knob({ n: 'Tape', min: 0, max: 1, def: 0, get: () => m.ch.tape, begin: () => A.commit('Tape', true), set: (val, f2) => { m.ch.tape = val; E.graph.masterParams(m); if (f2) { A.save(); A.changed({ console: true }); } } })));
    rack.append(fin);
    // meters
    const vu = h('canvas', { class: 'vu big' }), spec = h('canvas', { class: 'ms-spec', 'aria-label': 'Spectrum: mastered (solid) and unmastered (dotted)' });
    const rd = {}, read = h('div', { class: 'mst-read' });
    [['M', 'Momentary'], ['S', 'Short-term'], ['I', 'Integrated'], ['TP', 'True peak'], ['LRA', 'Range'], ['GR', 'Limiter']].forEach(([k, n]) => { const x = h('b', null, '—'); rd[k] = x; read.append(h('div', null, h('span', null, n), x)); });
    const tline = h('div', { class: 'mst-target' }, h('i')); tline.style.setProperty('--t', ((target[1] + 40) / 40 * 100) + '%');
    const rep = h('div', { class: 'ms-report' });
    const meters = h('div', { class: 'ms-col ms-meters' }, h('div', { class: 'ms-h' }, 'Meters'), h('div', { class: 'vuwrap' }, vu), read,
      tline, h('div', { class: 'mst-cap' }, 'Short-term loudness · target ' + target[1] + ' LUFS · ceiling ' + target[2] + ' dBTP'),
      h('div', { class: 'ms-h sm' }, 'Spectrum', h('span', null, 'solid = mastered · dotted = before')), spec, rep);
    v.append(bar, h('div', { class: 'ms-status' }, res, prog), h('div', { class: 'ms-grid' }, lib, rack, meters));
    this.ui = { vu, vst: this.ui && this.ui.vst || {}, rd, tline, spec, rep, res, ab };
    if (this.lastReport) this.report(this.lastReport.st, this.lastReport.kind, true);
  },
  report(st, kind, quiet) {
    this.lastReport = { st: { I: st.I, tp: st.tp, pk: st.pk, drive: st.drive }, kind };
    const u = this.ui; if (!u) return;
    const t = MST.target(), plr = st.tp - st.I;
    const row = (k, val, note) => K.h('div', null, K.h('span', null, k), K.h('b', null, val), note ? K.h('em', null, note) : null);
    u.rep.textContent = '';
    u.rep.append(K.h('div', { class: 'ms-h sm' }, kind === 'Matched' ? 'Match report' : 'Analysis'),
      row('Integrated', st.I > -70 ? st.I.toFixed(1) + ' LUFS' : '—', st.I > -70 ? (Math.abs(st.I - t[1]) <= 0.5 ? 'on target' : (st.I - t[1] > 0 ? '+' : '') + (st.I - t[1]).toFixed(1) + ' LU vs target') : ''),
      row('True peak', st.tp.toFixed(1) + ' dBTP', st.tp > t[2] + 0.1 ? 'over the ceiling' : 'safe'),
      row('Peak-to-loudness', st.I > -70 ? plr.toFixed(1) + ' dB' : '—', st.I > -70 ? (plr < 8 ? 'very squashed' : plr < 11 ? 'dense' : plr < 15 ? 'balanced' : 'very dynamic') : ''),
      row('Drive', (st.drive >= 0 ? '+' : '') + (st.drive || 0).toFixed(1) + ' dB', st.drive > 12 ? 'heavy' : ''));
    if (!quiet) u.res.textContent = kind === 'Matched' ? 'Matched to ' + t[0] + '. Play it back and use A/B to judge the change at equal loudness.' : 'Analysis done (current settings, nothing changed).';
  },
  frame() {
    if (!this.shown() || !this.ui) return;
    const E = A.eng, G = E.graph, u = this.ui, mm = E.meters.master;
    // running RMS of the mix before and after mastering (about 3 s), for the level-matched A/B
    if (G && G.anPre && E.playing) {
      const td = this._td || (this._td = new Float32Array(2048));
      const pw = (an) => { an.getFloatTimeDomainData(td); let s = 0; for (let i = 0; i < td.length; i++) s += td[i] * td[i]; return s / td.length; };
      const a = pw(G.anPre), b = pw(G.anPost), k = 0.02;
      if (a > 1e-9) { this.rms.pre += (a - this.rms.pre) * k; this.rms.post += (b - this.rms.post) * k; }
      if (this.compare) G.abPath.gain.setTargetAtTime(this.matchGain(), E.ctx.currentTime, 0.2);
    }
    K.vu(u.vu, u.vst, mm ? mm.rms : [0, 0], { ref: -14 });
    if (mm) {
      const f = (x) => (x === -Infinity || x < -70 || isNaN(x) ? '—' : x.toFixed(1));
      u.rd.M.textContent = f(mm.M); u.rd.S.textContent = f(mm.S); u.rd.I.textContent = f(mm.I);
      const tp = U.db(Math.max(mm.tp[0], mm.tp[1])); this.tpHold = E.playing ? Math.max(this.tpHold || -Infinity, tp) : this.tpHold; u.rd.TP.textContent = f(this.tpHold);
      u.rd.LRA.textContent = mm.LRA ? mm.LRA.toFixed(1) : '—'; u.rd.GR.textContent = mm.lim < -0.05 ? mm.lim.toFixed(1) : '0.0';
      const s = mm.S > -70 ? mm.S : -70, t = MST.target()[1];
      u.tline.firstChild.style.width = U.clamp((s + 40) / 40, 0, 1) * 100 + '%'; u.tline.firstChild.classList.toggle('hot', s > t + 1);
    }
    this.view.querySelectorAll('.grbar[data-fx]').forEach((b) => {
      const id = b.dataset.fx; let d = 0;
      if (id === 'masterLim') d = mm ? -mm.lim : 0; else { const n = G && G.fxNode(id); d = n && n.gr ? -n.gr() : 0; }
      b.firstChild.style.width = Math.min(100, Math.max(0, d) / 12 * 100) + '%';
    });
    this.drawSpec();
  },
  drawSpec() {
    const cv = this.ui.spec, G = A.eng.graph; if (!G || !G.anPost) return;
    const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'), T = K.T || {}; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    g.fillStyle = T.surface2 || '#E8E0CF'; g.fillRect(0, 0, w, h);
    const sr = A.eng.sr, fx = (f) => Math.log(f / 20) / Math.log(sr / 2 / 20) * w, fy = (db) => h - (db + 96) / 90 * h;
    g.fillStyle = T.grid2 || 'rgba(0,0,0,.2)'; g.font = "500 9px Oswald, sans-serif"; g.textBaseline = 'top';
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach((f) => { const x = Math.round(fx(f)); g.fillRect(x, 0, 1, h); g.fillText(f >= 1000 ? f / 1000 + 'k' : String(f), x + 2, 2); });
    const bins = this._fb || (this._fb = new Float32Array(G.anPost.frequencyBinCount));
    const curve = (an, dash, col, fill) => {
      an.getFloatFrequencyData(bins); const n = bins.length; g.beginPath(); let started = false;
      for (let px = 0; px <= w; px += 2) {
        const f = 20 * Math.pow(sr / 2 / 20, px / w), k = Math.min(n - 1, Math.round(f / (sr / 2) * n)), k2 = Math.min(n - 1, Math.round(20 * Math.pow(sr / 2 / 20, (px + 2) / w) / (sr / 2) * n));
        let mx = -200; for (let q = k; q <= Math.max(k, k2); q++) if (bins[q] > mx) mx = bins[q];
        const y = fy(Math.max(-96, mx + 3 * Math.log2(Math.max(1, f / 1000)))); // +3 dB/octave tilt so a balanced mix reads flat
        if (!started) { g.moveTo(px, y); started = true; } else g.lineTo(px, y);
      }
      g.setLineDash(dash); g.strokeStyle = col; g.lineWidth = dash.length ? 1.2 : 2; g.stroke(); g.setLineDash([]);
      if (fill) { g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.globalAlpha = 0.12; g.fillStyle = col; g.fill(); g.globalAlpha = 1; }
    };
    curve(G.anPre, [2, 3], T.muted || '#6E6657', false);
    curve(G.anPost, [], this.compare ? (T.muted || '#6E6657') : (T.text || '#1A1611'), true);
  },
  open() { A.setView('master'); },
});
