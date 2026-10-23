// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — the console: track strips, mixbuses, master with limiter and loudness metering
'use strict';
const CON = {
  folded: {}, meters: [],
  init() {
    this.view = document.getElementById('console');
    try { this.folded = JSON.parse(localStorage.getItem('dawters.folded') || '{}'); } catch (e) { this.folded = {}; }
  },
  P: {
    trim: { n: 'Trim', min: -20, max: 20, def: 0, u: 'dB', bipolar: true },
    hpf: { n: 'HPF', min: 20, max: 1000, def: 20, u: 'Hz', log: true, fmt: (v) => (v <= 21 ? 'off' : K.fmt({ u: 'Hz' }, v)) },
    lpf: { n: 'LPF', min: 1000, max: 20000, def: 20000, u: 'Hz', log: true, fmt: (v) => (v >= 19900 ? 'off' : K.fmt({ u: 'Hz' }, v)) },
    lsF: { n: 'Lo Hz', min: 30, max: 500, def: 80, u: 'Hz', log: true }, lsG: { n: 'Lo dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
    lmF: { n: 'LM Hz', min: 100, max: 2000, def: 400, u: 'Hz', log: true }, lmG: { n: 'LM dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
    hmF: { n: 'HM Hz', min: 500, max: 10000, def: 2500, u: 'Hz', log: true }, hmG: { n: 'HM dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
    hsF: { n: 'Hi Hz', min: 2000, max: 18000, def: 10000, u: 'Hz', log: true }, hsG: { n: 'Hi dB', min: -15, max: 15, def: 0, u: 'dB', bipolar: true },
    thresh: { n: 'Thresh', min: -40, max: 0, def: 0, u: 'dB', fmt: (v) => (v > -0.05 ? 'off' : v.toFixed(1)) },
    ratio: { n: 'Ratio', min: 1, max: 20, def: 4, log: true, fmt: (v) => v.toFixed(1) + ':1' },
    attack: { n: 'Attack', min: 0.1, max: 100, def: 10, u: 'ms', log: true },
    release: { n: 'Release', min: 20, max: 2000, def: 120, u: 'ms', log: true },
    makeup: { n: 'Makeup', min: 0, max: 24, def: 0, u: 'dB' },
    gate: { n: 'Gate', min: -80, max: 0, def: -80, u: 'dB', fmt: (v) => (v <= -79.5 ? 'off' : v.toFixed(0)) },
    tape: { n: 'Drive', min: 0, max: 1, def: 0 },
    ceiling: { n: 'Ceiling', min: -6, max: 0, def: -1, u: 'dB' },
    pan: { n: 'Pan', min: -1, max: 1, def: 0, bipolar: true, fmt: (v) => (Math.abs(v) < 0.01 ? 'C' : v < 0 ? Math.round(-v * 100) + 'L' : Math.round(v * 100) + 'R') },
    send: { n: 'Send', min: 0, max: 1.4, def: 0, fmt: (v) => U.fmtDb(U.db(v)) },
  },
  // knob bound to obj[key]
  kb(obj, key, spec, opt = {}) {
    const s = Object.assign({}, spec, opt, {
      get: () => obj[key],
      begin: () => A.commit((spec.n || key) + ' change', true),
      set: (v, fin) => { obj[key] = v; if (opt.on) opt.on(v, fin); else this.push(opt.target); if (fin) A.save(); },
    });
    const k = K.knob(s); k.dataset.key = key; return k;
  },
  push(target) {
    const G = A.eng.graph, P = A.proj;
    if (!target) return;
    if (target.kind === 'track') G.trackParams(target.t, true);
    else if (target.kind === 'bus') G.busParams(P.buses[target.i], target.i);
    else G.masterParams(P.master);
  },
  sec(id, cls, title, kids, lamp) {
    const key = cls;
    const s = K.h('div', { class: 'sec ' + cls + (this.folded[key] ? ' folded' : '') });
    const st = K.h('div', { class: 'st', title: 'Click to fold' }, title);
    if (lamp) { const l = K.h('span', { class: 'lamp' + (lamp.get() ? ' on' : ''), role: 'switch', 'aria-checked': lamp.get() ? 'true' : 'false', title: 'In / out' }); l.addEventListener('click', (e) => { e.stopPropagation(); A.commit(title + ' in/out'); lamp.set(!lamp.get()); l.classList.toggle('on', lamp.get()); A.save(); }); st.append(l); }
    st.addEventListener('click', () => { s.classList.toggle('folded'); this.folded[key] = s.classList.contains('folded'); localStorage.setItem('dawters.folded', JSON.stringify(this.folded)); });
    s.append(st, K.h('div', { class: 'sb' }, kids));
    void id;
    return s;
  },
  modes(ch, target, color) {
    const wrap = K.h('div', { class: 'modes' });
    [['leveler', 'LEV'], ['compressor', 'COMP'], ['limiter', 'LIM']].forEach(([m, l]) => {
      const b = K.h('button', { class: ch.mode === m ? 'on' : '', title: m[0].toUpperCase() + m.slice(1) }, l);
      b.addEventListener('click', () => { A.commit('Compressor mode'); ch.mode = m; wrap.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); this.push(target); A.save(); });
      wrap.append(b);
    });
    void color;
    return wrap;
  },
  dynSec(ch, target, gr) {
    const c = '#FF7A1A', sm = { size: 'sm', color: c, target };
    return this.sec(target.id, 'dyn', 'DYNAMICS', [
      this.modes(ch, target),
      this.kb(ch, 'thresh', this.P.thresh, sm), this.kb(ch, 'ratio', this.P.ratio, sm),
      this.kb(ch, 'attack', this.P.attack, sm), this.kb(ch, 'release', this.P.release, sm),
      this.kb(ch, 'makeup', this.P.makeup, sm), target.kind === 'track' ? this.kb(ch, 'gate', this.P.gate, sm) : K.h('span'),
      gr,
    ], { get: () => ch.compOn, set: (v) => { ch.compOn = v; this.push(target); } });
  },
  eqSec(ch, target, full) {
    const c = '#E8327C', sm = { size: 'sm', color: c, target };
    const kids = full
      ? [this.kb(ch, 'lsF', this.P.lsF, sm), this.kb(ch, 'lsG', this.P.lsG, sm), this.kb(ch, 'lmF', this.P.lmF, sm), this.kb(ch, 'lmG', this.P.lmG, sm),
        this.kb(ch, 'hmF', this.P.hmF, sm), this.kb(ch, 'hmG', this.P.hmG, sm), this.kb(ch, 'hsF', this.P.hsF, sm), this.kb(ch, 'hsG', this.P.hsG, sm)]
      : [this.kb(ch, 'lsG', Object.assign({}, this.P.lsG, { n: 'Bass' }), sm), this.kb(ch, 'lmG', Object.assign({}, this.P.lmG, { n: 'Body' }), sm),
        this.kb(ch, 'hmG', Object.assign({}, this.P.hmG, { n: 'Presence' }), sm), this.kb(ch, 'hsG', Object.assign({}, this.P.hsG, { n: 'Air' }), sm)];
    return this.sec(target.id, 'eq', full ? 'EQ' : 'TONE', kids, { get: () => ch.eqOn, set: (v) => { ch.eqOn = v; this.push(target); } });
  },
  // processing sections scroll together above the pinned fader row
  upper(...kids) {
    const u = K.h('div', { class: 'upper' }, ...kids);
    u.addEventListener('scroll', () => {
      if (this._sync) return; this._sync = true; this.scrollTop = u.scrollTop;
      this.view.querySelectorAll('.upper').forEach((o) => { if (o !== u) o.scrollTop = u.scrollTop; });
      requestAnimationFrame(() => { this._sync = false; });
    }, { passive: true });
    return u;
  },
  render() {
    const P = A.proj, v = this.view;
    const keepX = v.scrollLeft;
    v.textContent = '';
    this.meters = []; this.grs = []; this.faders = [];
    const desk = K.h('div', { class: 'desk' });
    const tg = K.h('div', { class: 'group' });
    P.tracks.forEach((t, i) => tg.append(this.trackStrip(t, i)));
    tg.append(K.h('button', { class: 'btn', style: 'align-self:flex-start;writing-mode:vertical-rl;padding:14px 6px;min-height:120px', onclick: (e) => A.addTrackMenu(e.clientX, e.clientY) }, '+ Add track'));
    const bg = K.h('div', { class: 'group' });
    P.buses.forEach((b, i) => bg.append(this.busStrip(b, i)));
    desk.append(tg, K.h('div', { class: 'divider', 'aria-hidden': 'true' }), bg, K.h('div', { class: 'divider', 'aria-hidden': 'true' }), this.masterStrip(P.master));
    v.append(desk);
    v.scrollLeft = keepX;
    if (this.scrollTop) v.querySelectorAll('.upper').forEach((o) => (o.scrollTop = this.scrollTop));
  },
  bottom(obj, target, color, extra, meterId, opts = {}) {
    const fz = K.h('div', { class: 'fz' });
    const dbv = K.h('div', { class: 'dbv' });
    const isTrack = target.kind === 'track';
    const fader = K.fader({
      n: 'Fader',
      get: () => (isTrack && obj.env.vol.on ? M.envAt(obj.env.vol, A.eng.pos(), 1) : obj.fader),
      begin: () => { if (isTrack && obj.env.vol.on) { K.toast('Volume envelope is on — edit it in the track lane or switch it off'); return; } A.commit('Fader', true); },
      set: (g, fin) => { if (isTrack && obj.env.vol.on) return; obj.fader = g; if (target.kind === 'master') A.eng.graph.masterParams(obj); else if (target.kind === 'bus') A.eng.graph.busParams(A.proj.buses[target.i], target.i); else A.eng.graph.trackParams(obj); if (fin) A.save(); },
      onShow: () => { dbv.textContent = U.fmtDb(U.db(isTrack && obj.env.vol.on ? M.envAt(obj.env.vol, A.eng.pos(), 1) : obj.fader)); },
    });
    this.faders.push({ el: fader, track: isTrack ? obj : null });
    const mcv = K.h('canvas', { class: 'mtr', style: opts.meterW ? 'width:' + opts.meterW + 'px' : '' });
    this.meters.push({ id: meterId, cv: mcv, st: K.meterState(), master: target.kind === 'master' });
    fz.append(fader, mcv);
    return K.h('div', { class: 'bottom' }, extra.top || null, fz, dbv, extra.bottom || null);
  },
  trackStrip(t, i) {
    const target = { kind: 'track', t, id: t.id };
    const sel = A.ui.selTrack === t.id;
    const s = K.h('div', { class: 'strip' + (sel ? ' sel' : ''), 'data-id': t.id });
    const name = K.h('div', { class: 'name', style: '--tc:' + t.color, title: t.name }, (i + 1) + ' · ' + t.name);
    name.addEventListener('click', () => A.selectTrack(t.id));
    name.addEventListener('dblclick', async () => { const v2 = await K.prompt('Rename track', 'Name', t.name); if (v2) { A.commit('Rename track'); t.name = v2; A.changed({ heads: true, console: true }); } });
    name.addEventListener('contextmenu', (e) => { e.preventDefault(); ARR.trackMenu(t, e); });
    const ch = t.ch, sky = { size: 'sm', color: '#2EA8E6', target };
    const phase = K.h('button', { class: 'mini' + (ch.phase ? ' on solo' : ''), title: 'Polarity invert' }, 'Ø');
    phase.addEventListener('click', () => { A.commit('Polarity'); ch.phase = !ch.phase; phase.classList.toggle('on', ch.phase); phase.classList.toggle('solo', ch.phase); this.push(target); A.save(); });
    const input = this.sec(t.id, 'input', 'INPUT', [this.kb(ch, 'trim', this.P.trim, sky), K.h('div', { style: 'display:flex;align-items:center;justify-content:center;width:40px' }, phase), this.kb(ch, 'hpf', this.P.hpf, sky), this.kb(ch, 'lpf', this.P.lpf, sky)]);
    if (t.kind === 'inst') input.querySelector('.sb').prepend(K.h('button', { class: 'slot full inst-btn', title: 'Edit the instrument', onclick: () => INSTUI.open(t) }, INST.TYPES[t.inst.type] + ' ▸'));
    const gr = K.h('div', { class: 'grbar', title: 'Gain reduction' }, K.h('i')); this.grs.push({ id: t.id, el: gr.firstChild });
    const tape = this.sec(t.id, 'tape', 'TAPE', [K.h('div', { class: 'full' }, this.kb(ch, 'tape', this.P.tape, { color: '#13A3A0', target }))]);
    // sends
    const sendKids = [];
    t.sends.forEach((sd, k) => {
      sendKids.push(this.kb(sd, 'lvl', Object.assign({}, this.P.send, { n: 'MB' + (k + 1) + (sd.pre ? ' pre' : '') }), { size: 'sm', color: M.BUS_COLORS[k], on: () => A.eng.graph.trackRouting(t) }));
    });
    const preRow = K.h('div', { class: 'row full', style: 'gap:2px' }, ...t.sends.map((sd, k) => {
      const b = K.h('button', { class: 'mini' + (sd.pre ? ' on mon' : ''), title: 'Mixbus ' + (k + 1) + ' pre-fader', style: 'width:20px;height:18px;font-size:9px' }, 'P' + (k + 1));
      b.addEventListener('click', () => { A.commit('Send pre/post'); sd.pre = !sd.pre; A.eng.graph.trackRouting(t); A.changed({ console: true }); });
      return b;
    }));
    const sends = this.sec(t.id, 'sends', 'SENDS', [...sendKids, preRow]);
    const fx = this.fxSec(t, t.id);
    const out = K.select([['master', '→ Master'], ...A.proj.buses.map((b, k) => ['bus' + k, '→ ' + b.name])], t.out, (val) => { A.commit('Output'); t.out = val; A.eng.graph.trackRouting(t); A.save(); });
    out.className = 'out'; out.title = 'Output';
    const mini = (cls, label, key, title) => { const b = K.h('button', { class: 'mini ' + cls + (t[key] ? ' on' : ''), title }, label); b.addEventListener('click', () => A.toggleTrack(t, key)); return b; };
    const bottom = this.bottom(t, target, t.color, {
      top: K.h('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:4px' }, this.kb(t, 'pan', this.P.pan, { color: t.color, on: () => A.eng.graph.trackParams(t) }), out),
      bottom: K.h('div', { class: 'row' }, mini('arm', '●', 'arm', 'Arm'), mini('mute', 'M', 'mute', 'Mute'), mini('solo', 'S', 'solo', 'Solo')),
    }, t.id);
    s.append(name, this.upper(input, this.eqSec(ch, target, true), this.dynSec(ch, target, gr), tape, sends, fx), bottom);
    s.addEventListener('pointerdown', () => { if (A.ui.selTrack !== t.id) A.selectTrack(t.id, true); });
    return s;
  },
  fxMenu(o, k, e) {
    const f = o.fx[k];
    const items = [{ head: f ? FX.types[f.type].name : 'Insert ' + (k + 1) }];
    if (f) {
      items.push({ label: 'Open editor', act: () => A.openFx(o, k) });
      items.push({ label: f.on ? 'Bypass' : 'Enable', act: () => { A.commit('FX bypass'); f.on = !f.on; A.changed({ graph: true, console: true }); } });
      items.push({ label: 'Remove', act: () => { A.commit('Remove FX'); o.fx.splice(k, 1); A.changed({ graph: true, console: true }); } });
      items.push({ sep: true });
    }
    K.menu(items.concat(A.fxItems(o, k, !!f)), e.clientX, e.clientY);
  },
  fxSec(o, key) {
    const fxs = [];
    for (let k = 0; k < M.NFX; k++) {
      const f = o.fx[k];
      const b = K.h('button', { class: 'slot' + (f ? '' : ' empty') + (f && !f.on ? ' off' : ''), title: f ? FX.types[f.type].name : 'Add an effect' }, f ? FX.types[f.type].short : '+ insert');
      b.addEventListener('click', (e) => (f ? A.openFx(o, k) : this.fxMenu(o, k, e)));
      b.addEventListener('contextmenu', (e) => { e.preventDefault(); this.fxMenu(o, k, e); });
      fxs.push(b);
      if (!f) break;
    }
    return this.sec(key, 'fx', 'INSERTS', fxs);
  },
  busStrip(b, i) {
    const target = { kind: 'bus', i, id: b.id };
    const s = K.h('div', { class: 'strip bus', 'data-id': b.id });
    const name = K.h('div', { class: 'name', style: '--tc:' + b.color, title: 'Double-click to rename' }, b.name);
    name.addEventListener('dblclick', async () => { const v2 = await K.prompt('Rename mixbus', 'Name', b.name); if (v2) { A.commit('Rename bus'); b.name = v2; A.changed({ console: true }); } });
    const gr = K.h('div', { class: 'grbar' }, K.h('i')); this.grs.push({ id: b.id, el: gr.firstChild });
    const tape = this.sec(b.id, 'tape', 'TAPE', [K.h('div', { class: 'full' }, this.kb(b.ch, 'tape', Object.assign({}, this.P.tape, { n: 'Saturate' }), { color: '#13A3A0', target }))]);
    const mute = K.h('button', { class: 'mini mute' + (b.mute ? ' on' : ''), title: 'Mute' }, 'M');
    mute.addEventListener('click', () => { A.commit('Mute bus'); b.mute = !b.mute; mute.classList.toggle('on', b.mute); A.eng.graph.busParams(b, i); A.save(); });
    const bottom = this.bottom(b, target, b.color, { top: this.kb(b, 'pan', this.P.pan, { color: b.color, on: () => A.eng.graph.busParams(b, i) }), bottom: K.h('div', { class: 'row' }, mute) }, b.id);
    s.append(name, this.upper(this.eqSec(b.ch, target, false), this.dynSec(b.ch, target, gr), tape, this.fxSec(b, b.id)), bottom);
    return s;
  },
  masterStrip(m) {
    const target = { kind: 'master', id: 'master' };
    const s = K.h('div', { class: 'strip master', 'data-id': 'master' });
    const name = K.h('div', { class: 'name' }, 'Master', K.h('button', { class: 'mst-open', title: 'Mastering — loudness target, drive, chains', onclick: () => A.setView('master') }, 'Mastering ▸'));
    this.vu = K.h('canvas', { class: 'vu', title: 'VU — 0 VU = −14 dBFS RMS, the streaming reference' }); this.vuSt = {};
    const gr = K.h('div', { class: 'grbar' }, K.h('i')); this.grs.push({ id: 'master', el: gr.firstChild });
    const lgr = K.h('div', { class: 'grbar', title: 'Limiter gain reduction' }, K.h('i')); this.grs.push({ id: 'masterLim', el: lgr.firstChild });
    const tape = this.sec('master', 'tape', 'TAPE', [K.h('div', { class: 'full' }, this.kb(m.ch, 'tape', Object.assign({}, this.P.tape, { n: 'Saturate' }), { color: '#13A3A0', target }))]);
    const lim = this.sec('master', 'lim', 'LIMITER', [K.h('div', { class: 'full' }, this.kb(m.ch, 'ceiling', this.P.ceiling, { color: '#E63B2E', target })), lgr], { get: () => m.ch.limOn, set: (v) => { m.ch.limOn = v; this.push(target); } });
    this.lufs = {};
    const L = K.h('div', { class: 'lufs', title: 'BS.1770 loudness' });
    [['M', 'Momentary'], ['S', 'Short-term'], ['I', 'Integrated'], ['LRA', 'Range'], ['TP', 'True peak']].forEach(([k, t2]) => { L.append(K.h('b', { title: t2 }, k)); const sp = K.h('span', null, '—'); this.lufs[k] = sp; L.append(sp); });
    const corr = K.h('div', { class: 'corr', title: 'Stereo correlation (−1 … +1)' }, K.h('i')); this.corrEl = corr.firstChild;
    const scale = K.select([['peak', 'Peak dBFS'], ['k20', 'K-20'], ['k14', 'K-14'], ['k12', 'K-12']], A.ui.kmeter, (v2) => { A.ui.kmeter = v2; localStorage.setItem('dawters.kmeter', v2); });
    scale.className = 'out';
    const reset = K.h('button', { class: 'btn sm', onclick: () => { A.eng.graph.mChan.port.postMessage({ type: 'resetLoud' }); this.meters.forEach((x) => (x.st = K.meterState())); } }, 'Reset');
    const bottom = this.bottom(m, target, '#E8327C', {
      top: K.h('div', { class: 'mm' }, this.vu, L, corr, K.h('div', { class: 'row' }, scale, reset)),
    }, 'master', { meterW: 34 });
    s.append(name, this.upper(this.fxSec(m, 'master'), this.eqSec(m.ch, target, false), this.dynSec(m.ch, target, gr), tape, lim), bottom);
    return s;
  },
  frame() {
    if (!this.view.classList.contains('show')) return;
    const E = A.eng;
    this.drawSet(this);
    const mm = E.meters.master;
    if (this.vu && this.vu.isConnected) K.vu(this.vu, this.vuSt, mm ? mm.rms : [0, 0], { ref: -14 });
    if (mm && this.lufs.M) {
      const f = (v) => (v === -Infinity || v < -70 || isNaN(v) ? '—' : v.toFixed(1));
      this.lufs.M.textContent = f(mm.M); this.lufs.S.textContent = f(mm.S); this.lufs.I.textContent = f(mm.I) + (mm.I > -70 ? ' LUFS' : '');
      this.lufs.LRA.textContent = mm.LRA ? mm.LRA.toFixed(1) + ' LU' : '—';
      const tp = Math.max(mm.tp[0], mm.tp[1]); this.tpHold = Math.max(this.tpHold || -Infinity, U.db(tp));
      this.lufs.TP.textContent = this.tpHold > -70 ? this.tpHold.toFixed(1) + ' dB' : '—';
      this.lufs.TP.style.color = this.tpHold > -1 ? 'var(--acc)' : '';
      this.corrEl.style.left = ((mm.corr + 1) / 2 * 100) + '%';
    }
  },
  // draw a set of meters / gain-reduction bars / envelope-following faders (used by the console and by Deck)
  drawSet(set) {
    const E = A.eng;
    for (const m of set.meters) {
      const mt = E.meters[m.id];
      if (m.master) {
        const mm = E.meters.master;
        if (!mm) { K.drawMeter(m.cv, m.st, [0, 0]); continue; }
        const kmode = A.ui.kmeter;
        if (kmode === 'peak') K.drawMeter(m.cv, m.st, mm.pk);
        else { const off = { k20: 20, k14: 14, k12: 12 }[kmode]; K.drawMeter(m.cv, m.st, mm.rms.map((r) => r * U.undb(off - 6)), {}); }
      } else K.drawMeter(m.cv, m.st, mt && mt.pk ? mt.pk : [0, 0]);
    }
    for (const g of set.grs) {
      let d = 0;
      if (g.id === 'master') d = E.meters.master ? -E.meters.master.gr : 0;
      else if (g.id === 'masterLim') d = E.meters.master ? -E.meters.master.lim : 0;
      else d = E.meters[g.id] ? -(E.meters[g.id].gr || 0) : 0;
      g.v = Math.max(d, (g.v || 0) * 0.85);
      g.el.style.width = Math.min(100, g.v / 20 * 100) + '%';
    }
    if (E.playing) for (const f of set.faders) if (f.track && f.track.env.vol.on) f.el.refresh();
  },
};
