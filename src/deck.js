// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — Deck: the one-screen, big-control, touch-first view (in the spirit of pocket 4-track apps)
'use strict';
const DECK = {
  t0: 0, span: 30, dirty: true, rows: [], fitted: false, focusId: null, extra: null,
  init() {
    this.view = document.getElementById('deck');
    this.main = K.h('div', { class: 'dk-main' });
    this.rowsEl = K.h('div', { class: 'dk-rows', role: 'list', 'aria-label': 'Tracks' });
    this.focus = K.h('aside', { class: 'dk-focus', 'aria-label': 'Selected channel' });
    this.main.append(this.rowsEl, this.focus);
    this.bar = K.h('div', { class: 'dk-bar', role: 'toolbar', 'aria-label': 'Transport' });
    this.view.append(this.main, this.bar);
    this.buildBar();
    new ResizeObserver(() => { this.sizeCanvases(); this.dirty = true; this.renderFocus(); }).observe(this.rowsEl);
  },
  shown() { return this.view.classList.contains('show'); },
  // ---------- bottom transport ----------
  buildBar() {
    const h = K.h, b = this.bar;
    const big = (cls, icon, label, fn) => { const x = h('button', { class: 'btn dk-tb ' + cls, title: label, 'aria-label': label }); x.innerHTML = icon; x.addEventListener('click', fn); return x; };
    this.bHome = big('', K.ICON.home, 'Go to start', () => A.locate(0));
    this.bStop = big('stop', K.ICON.stop, 'Stop', () => A.stop());
    this.bPlay = big('play', K.ICON.play, 'Play', () => A.togglePlay());
    this.bRec = big('rec', K.ICON.rec, 'Record', () => A.record());
    this.bIdea = h('button', { class: 'btn dk-idea', title: 'Quick idea: grab a free track and record right now' }, h('span', { class: 'dot' }), 'Quick idea');
    this.bIdea.addEventListener('click', () => A.quickIdea());
    this.lcd = h('div', { class: 'lcd dk-lcd', role: 'timer' }, h('div', { class: 'big' }, '001.1.000'), h('div', { class: 'small' }, '00:00.000'));
    this.lcd.addEventListener('click', () => { A.ui.lcdBars = !A.ui.lcdBars; });
    const tog = (cls, label, fn) => { const x = h('button', { class: 'btn tog ' + cls, 'aria-pressed': 'false' }, label); x.addEventListener('click', fn); return x; };
    this.bLoop = tog('loop', 'Loop', () => A.toggleLoop());
    this.bClick = tog('click', 'Click', () => { A.settings.click = !A.settings.click; A.saveSettings(); A.syncTransport(); });
    this.bFollow = tog('follow', 'Follow', () => { A.ui.follow = A.settings.follow = !A.ui.follow; A.saveSettings(); A.syncTransport(); });
    this.bFollow.title = 'Keep the playhead in view';
    this.bBounce = h('button', { class: 'btn', title: 'Mix tracks down to one new track' }, '⤓ Bounce');
    this.bBounce.addEventListener('click', () => A.bounceDialog());
    this.bAdd = h('button', { class: 'btn', title: 'Add track' }, '+ Track');
    this.bAdd.addEventListener('click', (e) => A.addTrackMenu(e.clientX, e.clientY));
    const undo = h('button', { class: 'btn icon', title: 'Undo', 'aria-label': 'Undo', onclick: () => A.undo() }, '↶');
    const zoomOut = h('button', { class: 'btn icon', title: 'Zoom out', 'aria-label': 'Zoom out', onclick: () => this.zoom(1.5) }, '−');
    const zoomIn = h('button', { class: 'btn icon', title: 'Zoom in', 'aria-label': 'Zoom in', onclick: () => this.zoom(1 / 1.5) }, '+');
    b.append(
      h('div', { class: 'dk-grp tp' }, this.bHome, this.bStop, this.bPlay, this.bRec),
      this.bIdea, this.lcd,
      h('div', { class: 'dk-grp tg' }, this.bLoop, this.bClick, this.bFollow),
      h('div', { class: 'spacer' }),
      h('div', { class: 'dk-grp tools' }, zoomOut, zoomIn, h('button', { class: 'btn', title: 'Tuner', onclick: () => TUNER.open() }, '♪ Tuner'), this.bBounce, this.bAdd, undo));
  },
  syncBar() {
    if (!this.bar) return;
    const E = A.eng, P = A.proj;
    this.bPlay.classList.toggle('on', E.playing && !E.recording);
    this.bRec.classList.toggle('on', E.recording);
    this.bIdea.classList.toggle('on', E.recording);
    const set = (x, on) => { x.classList.toggle('on', !!on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); };
    set(this.bLoop, P.loop.on); set(this.bClick, A.settings.click); set(this.bFollow, A.ui.follow);
  },
  // ---------- rows ----------
  hint() {
    if (this.hinted || localStorage.getItem('dawters.swipeHint')) return;
    this.hinted = true;
    setTimeout(() => { if (this.shown()) K.toast('Tip: swipe a track right for its setup, left for its effects', 4200); }, 1600);
  },
  render() {
    if (!A.proj) return;
    if (this.shown()) this.hint();
    const P = A.proj, rows = this.rowsEl;
    rows.textContent = '';
    this.rows = [];
    if (!this.fitted) { this.fit(); this.fitted = true; }
    P.tracks.forEach((t, i) => rows.append(this.row(t, i)));
    rows.append(K.h('button', { class: 'dk-add', onclick: (e) => A.addTrackMenu(e.clientX, e.clientY) }, '+ Add a track'));
    this.view.dataset.count = String(Math.min(P.tracks.length, 9));
    this.sizeCanvases();
    this.renderFocus();
    this.syncBar();
    this.dirty = true;
  },
  row(t, i) {
    const h = K.h, sel = A.ui.selTrack === t.id;
    const el = h('div', { class: 'drow' + (sel ? ' sel' : ''), role: 'listitem', 'data-id': t.id, style: '--tc:' + t.color });
    const tab = h('div', { class: 'dk-tab' }, String(i + 1));
    const name = h('button', { class: 'dk-name', title: 'Track options' }, t.name);
    name.addEventListener('click', () => { A.selectTrack(t.id); this.setupSheet(t); });
    const btn = (k, label, title) => { const b = h('button', { class: 'dk-b ' + k + (t[k] ? ' on' : ''), 'data-k': k, title, 'aria-label': title, 'aria-pressed': t[k] ? 'true' : 'false' }, label); b.addEventListener('click', () => { A.selectTrack(t.id); A.toggleTrack(t, k); }); return b; };
    const nfx = t.fx.filter((f) => f.on).length;
    const fx = h('button', { class: 'dk-b fx' + (nfx ? ' on' : ''), title: 'Effects' }, 'FX' + (nfx ? ' ' + nfx : ''));
    fx.addEventListener('click', () => { A.selectTrack(t.id); this.fxSheet(t); });
    const head = h('div', { class: 'dk-head' }, name, h('div', { class: 'dk-btns' }, btn('arm', '●', 'Arm for recording'), btn('mute', 'M', 'Mute'), btn('solo', 'S', 'Solo'), fx));
    const cv = h('canvas', { class: 'dk-wave', 'aria-label': t.name + ' timeline' });
    const dbv = h('span', { class: 'dk-db' });
    const vol = K.hfader({
      n: t.name + ' volume',
      get: () => (t.env.vol.on ? M.envAt(t.env.vol, A.eng.pos(), 1) : t.fader),
      begin: () => { if (t.env.vol.on) K.toast('Volume envelope is on for this track'); else A.commit('Fader', true); },
      set: (g, fin) => { if (t.env.vol.on) return; t.fader = g; A.eng.graph.trackParams(t); if (fin) { A.save(); CON.stale = true; } },
      onShow: () => { dbv.textContent = U.fmtDb(U.db(t.env.vol.on ? M.envAt(t.env.vol, A.eng.pos(), 1) : t.fader)) + ' dB'; },
    });
    const pan = K.knob(Object.assign({}, CON.P.pan, { size: 'sm', color: t.color, get: () => t.pan, begin: () => A.commit('Pan', true), set: (v, fin) => { t.pan = v; A.eng.graph.trackParams(t); if (fin) A.save(); } }));
    const meter = h('canvas', { class: 'dk-meter' });
    const mix = h('div', { class: 'dk-mix' }, h('div', { class: 'dk-vol' }, vol, h('div', { class: 'dk-volrow' }, meter, dbv)), pan);
    el.append(tab, head, cv, mix);
    el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button,.hfader,.knob,canvas')) A.selectTrack(t.id); });
    const wrap = h('div', { class: 'dswipe', style: '--tc:' + t.color },
      h('div', { class: 'sw-hint setup', 'aria-hidden': 'true' }, '⚙ Setup'),
      h('div', { class: 'sw-hint fx', 'aria-hidden': 'true' }, 'Effects ✦'), el);
    this.bindSwipe(t, wrap, el);
    const r = { t, el, cv, bg: document.createElement('canvas'), meter, mst: K.meterState(), vol, ptrs: new Map() };
    this.bindCanvas(r);
    this.rows.push(r);
    return wrap;
  },
  // swipe a row right for the track's setup, left for its effects (the waveform keeps its own drag/scroll)
  bindSwipe(t, wrap, el) {
    let s = null;
    const reset = () => { el.style.transition = 'transform .18s ease-out'; el.style.transform = ''; wrap.dataset.dir = ''; setTimeout(() => (el.style.transition = ''), 200); };
    el.addEventListener('pointerdown', (e) => {
      if (e.button > 0 || e.target.closest('canvas,.hfader,.knob,input,select')) return;
      s = { id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), on: false, dead: false };
    }, true);
    el.addEventListener('pointermove', (e) => {
      if (!s || e.pointerId !== s.id || s.dead) return;
      const dx = e.clientX - s.x0, dy = e.clientY - s.y0;
      if (!s.on) {
        if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) { s.dead = true; return; }
        if (Math.abs(dx) < 14 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
        s.on = true; try { el.setPointerCapture(e.pointerId); } catch (x) { /* */ }
      }
      const lim = Math.min(160, wrap.clientWidth * 0.4), x = Math.sign(dx) * Math.min(lim, Math.abs(dx));
      el.style.transform = 'translateX(' + x + 'px)';
      wrap.dataset.dir = dx > 0 ? 'right' : 'left';
      wrap.classList.toggle('armed', Math.abs(dx) > 70);
    });
    const end = (e, cancel) => {
      if (!s || e.pointerId !== s.id) return;
      const was = s; s = null;
      if (!was.on) return;
      const dx = e.clientX - was.x0, fast = Math.abs(dx) / Math.max(1, performance.now() - was.t0) > 0.6;
      this.swiped = performance.now();
      wrap.classList.remove('armed'); reset();
      if (cancel || (Math.abs(dx) < 70 && !(fast && Math.abs(dx) > 30))) return;
      A.selectTrack(t.id);
      if (dx > 0) this.setupSheet(t); else this.fxSheet(t);
      localStorage.setItem('dawters.swipeHint', '1');
    };
    el.addEventListener('pointerup', (e) => end(e));
    el.addEventListener('pointercancel', (e) => end(e, true));
    // a swipe that started on a button must not also press it
    el.addEventListener('click', (e) => { if (this.swiped && performance.now() - this.swiped < 350) { e.stopPropagation(); e.preventDefault(); } }, true);
  },
  // ---------- setup sheet (swipe right / tap the name) ----------
  setupSheet(t) {
    const h = K.h, P = A.proj;
    const seg = (opts, cur, fn) => { const w = h('div', { class: 'sh-seg', role: 'group' }); opts.forEach(([v, l]) => { const b = h('button', { class: 'act' + (String(cur()) === String(v) ? ' on' : ''), 'aria-pressed': String(cur()) === String(v) ? 'true' : 'false' }, l); b.addEventListener('click', () => { fn(v); w.querySelectorAll('button').forEach((x, i) => { const on = String(opts[i][0]) === String(cur()); x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }); w.append(b); }); return w; };
    const name = h('input', { type: 'text', value: t.name, 'aria-label': 'Track name', class: 'sh-input' });
    name.addEventListener('change', () => { const v = name.value.trim(); if (v && v !== t.name) { A.commit('Rename track'); t.name = v; A.changed({ heads: true, console: true }); } });
    const sw = h('div', { class: 'sh-swatches' }, M.COLORS.map((c) => { const b = h('button', { class: 'sw' + (t.color === c ? ' on' : ''), style: 'background:' + c, 'aria-label': 'Colour ' + c }); b.addEventListener('click', () => { A.commit('Track colour'); t.color = c; sw.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b)); A.changed({ heads: true, console: true }); }); return b; }));
    const tog = (k, on, off) => seg([[true, on], [false, off]], () => !!t[k], (v) => { if (!!t[k] !== v) A.toggleTrack(t, k); });
    const env = (k, label) => seg([[true, label + ' envelope'], [false, 'No ' + label.toLowerCase() + ' envelope']], () => t.env[k].on, (v) => { A.commit(label + ' envelope'); t.env[k].on = v; A.changed({ graph: true }); });
    const body = [
      h('div', { class: 'sh-sub' }, 'Name & colour'), name, sw,
      t.kind === 'beat' ? h('div', { class: 'sh-sub' }, 'Beat') : null,
      t.kind === 'beat' ? h('div', { class: 'sh-acts' },
        h('button', { class: 'act on', onclick: () => { s.close(); SUITE.open(t); } }, "Esperanza's Drum Kit — edit the beat"),
        h('button', { class: 'act', onclick: (e) => { const i = SUITE.inst.get(t.id); if (i && i.api) SUITE.placeMenu(i, e.clientX, e.clientY); } }, '+ Put on the timeline')) : null,
      t.kind === 'inst' ? h('div', { class: 'sh-sub' }, 'Instrument') : null,
      t.kind === 'inst' ? h('div', { class: 'sh-acts' },
        h('button', { class: 'act on', onclick: () => { s.close(); INSTUI.open(t); } }, INST.TYPES[t.inst.type] + ' — edit sound'),
        h('button', { class: 'act', onclick: () => { s.close(); A.ui.patTrack = t.id; A.setView('pattern'); } }, 'Patterns'),
        h('button', { class: 'act', onclick: () => { s.close(); A.setView('matrix'); } }, 'GrooveMatrix')) : null,
      h('div', { class: 'sh-sub' }, t.kind === 'inst' ? 'Record notes' : 'Record from'),
      t.kind === 'inst' ? null : seg([['1', 'In 1'], ['2', 'In 2'], ['1+2', 'In 1+2 stereo']], () => t.input, (v) => A.setInput(t, v)),
      t.kind === 'beat' ? null : tog('arm', '● Armed', 'Not armed'), t.kind === 'beat' || (t.kind === 'inst' && t.inst.type !== 'eleo') ? null : tog('mon', t.kind === 'inst' ? 'Guitar into Eleosynth' : 'Hear the input', 'Input silent'),
      h('div', { class: 'sh-sub' }, 'Send to'),
      seg([['master', 'Master'], ...P.buses.map((b, i) => ['bus' + i, b.name])], () => t.out, (v) => { A.commit('Output'); t.out = v; A.eng.graph.trackRouting(t); A.save(); CON.stale = true; }),
      seg([[false, 'Mono'], [true, 'Stereo']], () => t.stereo, (v) => { A.commit('Track width'); t.stereo = v; A.changed({ graph: true, console: true }); }),
      h('div', { class: 'sh-sub' }, 'Automation'), env('vol', 'Volume'), env('pan', 'Pan'),
      h('div', { class: 'sh-sub' }, 'More'),
      h('div', { class: 'sh-acts' },
        h('button', { class: 'act', onclick: () => { s.close(); this.stripSheet(t); } }, 'Channel strip — EQ, dynamics, sends'),
        h('button', { class: 'act', onclick: () => { s.close(); this.fxSheet(t); } }, 'Effects'),
        h('button', { class: 'act', onclick: () => { s.close(); A.bounceDialog([t.id]); } }, 'Bounce this track'),
        h('button', { class: 'act', onclick: () => { s.close(); A.duplicateTrack(t); } }, 'Duplicate'),
        h('button', { class: 'act', disabled: P.tracks.indexOf(t) === 0 || undefined, onclick: () => { A.moveTrack(t, -1); } }, 'Move up'),
        h('button', { class: 'act', disabled: P.tracks.indexOf(t) === P.tracks.length - 1 || undefined, onclick: () => { A.moveTrack(t, 1); } }, 'Move down'),
        h('button', { class: 'act danger', onclick: () => { s.close(); A.deleteTrack(t); } }, 'Delete track')),
    ];
    const s = K.sheet('Setup · ' + t.name, body, null, { light: true });
  },
  sizeCanvases() {
    const dpr = window.devicePixelRatio || 1;
    for (const r of this.rows) {
      const w = r.cv.clientWidth, h = r.cv.clientHeight;
      if (!w || !h) continue;
      for (const c of [r.cv, r.bg]) { c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); }
      r.w = w; r.h = h;
    }
  },
  // ---------- time mapping ----------
  tToX(r, t) { return (t - this.t0) / this.span * r.w; },
  xToT(r, x) { return this.t0 + x / r.w * this.span; },
  fit() { const e = Math.max(M.songEnd(A.proj), 16); this.span = U.clamp(e * 1.08, 4, 3600); this.t0 = 0; this.dirty = true; },
  // zoom keeps the playhead centred
  zoom(f) {
    this.span = U.clamp(this.span * f, 1, 3600);
    this.t0 = Math.max(0, A.eng.pos() - this.span / 2);
    this.dirty = true;
  },
  // ---------- clip hit-test ----------
  hit(r, x, y, touch) {
    const t = this.xToT(r, x), edge = touch ? 18 : 8;
    const clips = r.t.clips;
    for (let k = clips.length - 1; k >= 0; k--) {
      const c = clips[k], x1 = this.tToX(r, c.start), x2 = this.tToX(r, c.start + c.len);
      if (x < x1 - 2 || x > x2 + 2) continue;
      const sel = A.ui.sel.has(c.id);
      // the clip's top band (its name bar when the row is tall enough) moves it; the waveform below selects a range
      const h = r.h - 8, HD = h > 44 ? 14 : 0, band = HD ? HD + (touch ? 8 : 2) : Math.round(h * 0.32);
      let zone = y - 4 < band ? 'body' : 'wave';
      if (sel && x - x1 < edge && x2 - x1 > edge * 3) zone = 'trimL';
      else if (sel && x2 - x < edge && x2 - x1 > edge * 3) zone = 'trimR';
      return { c, zone, t };
    }
    return { c: null, zone: 'empty', t };
  },
  bindCanvas(r) {
    const cv = r.cv;
    cv.style.touchAction = 'none';
    let g = null, lp = null;
    const off = (e) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
    cv.addEventListener('pointerdown', (e) => {
      if (e.button === 2) return;
      cv.setPointerCapture(e.pointerId);
      r.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      clearTimeout(lp);
      A.selectTrack(r.t.id);
      if (r.ptrs.size === 2) {
        if (g && g.moved && g.kind !== 'pan') this.endDrag(g);
        const [a, b] = Array.from(r.ptrs.values()), bb = cv.getBoundingClientRect();
        const cx = (a.x + b.x) / 2 - bb.left;
        g = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, span0: this.span, t: this.xToT(r, cx), cx };
        return;
      }
      const o = off(e), touch = e.pointerType !== 'mouse', hh = this.hit(r, o.x, o.y, touch);
      g = { kind: hh.c ? (hh.zone === 'wave' ? 'range' : hh.zone) : 'pan', h: hh, x0: e.clientX, t0: this.t0, moved: false, touch, wasSel: hh.c && A.ui.sel.has(hh.c.id), shift: e.shiftKey };
      if (e.shiftKey && !touch) g.kind = 'range';
      if (hh.c) { g.c = hh.c; g.s0 = { start: hh.c.start, off: hh.c.off, len: hh.c.len }; if (!A.ui.sel.has(hh.c.id)) { A.ui.sel = new Set([hh.c.id]); this.dirty = true; ARR.dirty = true; A.inspector(); } }
      lp = setTimeout(() => { if (g && !g.moved && g.kind !== 'pinch') { const gg = g; g = null; r.ptrs.clear(); this.pressMenu(r, gg.h, e.clientX, e.clientY); } }, 520);
      e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!r.ptrs.has(e.pointerId) || !g) { if (!g && e.pointerType === 'mouse') { const o = off(e), hh = this.hit(r, o.x, o.y, false); cv.style.cursor = hh.zone === 'trimL' || hh.zone === 'trimR' ? 'ew-resize' : hh.zone === 'wave' ? 'text' : hh.c ? 'grab' : 'default'; } return; }
      r.ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (g.kind === 'pinch') {
        if (r.ptrs.size < 2) return;
        const [a, b] = Array.from(r.ptrs.values()), bb = cv.getBoundingClientRect();
        const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2 - bb.left;
        this.span = U.clamp(g.span0 * g.d0 / d, 1, 3600);
        this.t0 = Math.max(0, g.t - cx / r.w * this.span);
        this.dirty = true; return;
      }
      const dx = e.clientX - g.x0;
      if (!g.moved && Math.abs(dx) < (g.touch ? 8 : 4)) return;
      if (!g.moved) { g.moved = true; clearTimeout(lp); if (g.kind !== 'pan' && g.kind !== 'range') A.commit(g.kind === 'body' ? 'Move clip' : 'Trim clip'); }
      const dt = dx / r.w * this.span, c = g.c;
      if (g.kind === 'pan') { this.t0 = Math.max(0, g.t0 - dt); this.dirty = true; return; }
      if (g.kind === 'range') { // drag across the waveform: an Audacity-style range on this track
        const ti = A.proj.tracks.indexOf(r.t), a = Math.max(0, ARR.snap(g.h.t, e)), b = Math.max(0, ARR.snap(this.xToT(r, off(e).x), e));
        A.ui.range = { s: Math.min(a, b), e: Math.max(a, b), t0: ti, t1: ti }; A.ui.sel = new Set();
        A.status('Range ' + A.rangeLabel(A.ui.range)); this.dirty = true; ARR.dirty = true; return;
      }
      if (g.kind === 'body') c.start = Math.max(0, ARR.snap(g.s0.start + dt, e));
      else if (g.kind === 'trimL') { const s0 = g.s0, end = s0.start + s0.len, ns = U.clamp(ARR.snap(s0.start + dt, e), c.pat || c.beat ? 0 : Math.max(0, s0.start - s0.off), end - 0.01); c.start = ns; c.off = s0.off + (ns - s0.start); c.len = end - ns; c.fi = Math.min(c.fi, c.len); c.fo = Math.min(c.fo, c.len - c.fi); }
      else if (g.kind === 'trimR') { const s0 = g.s0, b = A.eng.buffers.get(c.buf), max = c.pat || c.beat ? 3600 : b ? b.ab.duration - s0.off : s0.len; c.len = U.clamp(ARR.snap(s0.start + s0.len + dt, e) - s0.start, 0.01, max); c.fo = Math.min(c.fo, c.len); c.fi = Math.min(c.fi, c.len - c.fo); }
      A.eng.clipsChanged(); this.dirty = true; ARR.dirty = true;
    });
    const up = (e, cancel) => {
      r.ptrs.delete(e.pointerId); clearTimeout(lp);
      if (!g) return;
      if (g.kind === 'pinch') { if (r.ptrs.size < 2) { g = null; r.ptrs.clear(); } return; }
      const gg = g; g = null;
      if (cancel) return;
      if (gg.moved) { if (gg.kind === 'range') A.inspector(); else if (gg.kind !== 'pan') this.endDrag(gg); return; }
      // taps
      if (gg.kind === 'range' && gg.shift) { A.extendRange(Math.max(0, ARR.snap(gg.h.t)), A.proj.tracks.indexOf(r.t)); this.dirty = true; ARR.dirty = true; return; }
      if (gg.kind === 'pan' || (gg.kind === 'range' && !(gg.touch && gg.wasSel))) { if (gg.kind === 'pan') A.ui.sel = new Set(); A.ui.range = null; A.locate(Math.max(0, ARR.snap(gg.h.t))); this.dirty = true; ARR.dirty = true; A.inspector(); }
      else if (gg.touch && gg.wasSel) this.pressMenu(r, gg.h, e.clientX, e.clientY);
    };
    cv.addEventListener('pointerup', (e) => up(e));
    cv.addEventListener('pointercancel', (e) => up(e, true));
    cv.addEventListener('contextmenu', (e) => { e.preventDefault(); const o = off(e); this.pressMenu(r, this.hit(r, o.x, o.y, false), e.clientX, e.clientY); });
    cv.addEventListener('dblclick', (e) => { const o = off(e), hh = this.hit(r, o.x, o.y, false); if (hh.c && hh.c.beat) SUITE.open(r.t); else if (hh.c) A.clipDialog(hh.c); });
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const o = off(e);
      if (e.ctrlKey || e.metaKey) this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15);
      else { const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; this.t0 = Math.max(0, this.t0 + d / r.w * this.span); this.dirty = true; }
    }, { passive: false });
  },
  endDrag() { A.changed({ clips: true }); this.dirty = true; },
  pressMenu(r, hh, x, y) {
    const R = A.hasRange() ? A.ui.range : null, ti = A.proj.tracks.indexOf(r.t);
    if (R && ti >= R.t0 && ti <= R.t1 && hh.t >= R.s && hh.t <= R.e) return K.menu(A.rangeItems(R), x, y);
    if (hh.c) { A.ui.sel = new Set([hh.c.id]); this.dirty = true; return A.clipMenu(hh.c, r.t, hh.t, x, y); }
    K.menu([
      { head: r.t.name + ' · ' + U.fmtTime(Math.max(0, hh.t)) },
      { label: 'Move playhead here', act: () => A.locate(Math.max(0, ARR.snap(hh.t))) },
      { label: 'Paste here', disabled: !A.clipboard, act: () => A.paste(Math.max(0, ARR.snap(hh.t))) },
      { label: 'Import audio here…', act: () => { A.locate(Math.max(0, ARR.snap(hh.t))); A.importAudio(); } },
      { label: 'Add marker here', act: () => A.addMarker(Math.max(0, ARR.snap(hh.t))) },
      { label: 'Zoom to song', act: () => this.fit() },
    ], x, y);
  },
  trackMenu(t, anchor) {
    const r = anchor.getBoundingClientRect();
    const P = A.proj, i = P.tracks.indexOf(t);
    K.menu([
      { head: t.name },
      { label: 'Channel strip (EQ, dynamics, sends)…', act: () => this.stripSheet(t) },
      { label: 'Effects…', act: () => this.fxSheet(t) },
      { label: 'Rename…', act: async () => { const v = await K.prompt('Rename track', 'Name', t.name); if (v) { A.commit('Rename track'); t.name = v; A.changed({ heads: true, console: true }); } } },
      { label: 'Colour…', act: () => ARR.colorMenu(t, { clientX: r.left, clientY: r.bottom }) },
      { label: 'Input: In 1', check: t.input === '1', act: () => A.setInput(t, '1') },
      { label: 'Input: In 2', check: t.input === '2', act: () => A.setInput(t, '2') },
      { label: 'Input: In 1+2 (stereo)', check: t.input === '1+2', act: () => A.setInput(t, '1+2') },
      { label: t.mon ? 'Stop listening to input' : 'Listen to input', act: () => A.toggleTrack(t, 'mon') },
      { label: 'Bounce this track…', act: () => A.bounceDialog([t.id]) },
      { label: 'Duplicate track', act: () => A.duplicateTrack(t) },
      { label: 'Move up', disabled: i === 0, act: () => A.moveTrack(t, -1) },
      { label: 'Move down', disabled: i === P.tracks.length - 1, act: () => A.moveTrack(t, 1) },
      { label: 'Delete track', act: () => A.deleteTrack(t) },
    ], r.left, r.bottom + 4);
  },
  // ---------- sheets ----------
  stripSheet(t) {
    const i = A.proj.tracks.indexOf(t);
    const strip = this.makeStrip(t, i, 'sheet');
    K.sheet('Channel · ' + t.name, K.h('div', { class: 'dk-stripwrap' }, strip), null, { light: true, onClose: () => { this.extra = null; } });
  },
  makeStrip(t, i, slot) {
    const save = [CON.meters, CON.grs, CON.faders];
    CON.meters = []; CON.grs = []; CON.faders = [];
    const strip = CON.trackStrip(t, i);
    const set = { meters: CON.meters, grs: CON.grs, faders: CON.faders };
    [CON.meters, CON.grs, CON.faders] = save;
    if (slot === 'sheet') this.extra = set; else this.focusSet = set;
    return strip;
  },
  renderFocus() {
    const wide = this.main.clientWidth >= 1000;
    this.main.classList.toggle('wide', wide);
    const t = A.proj && A.proj.tracks.find((x) => x.id === A.ui.selTrack);
    if (!wide || !t) { this.focus.textContent = ''; this.focusSet = null; this.focusId = null; return; }
    const key = t.id + '|' + A.proj.tracks.indexOf(t);
    if (this.focusId === key && !this.focusStale) return;
    this.focusId = key; this.focusStale = false;
    this.focus.textContent = '';
    this.focus.append(this.makeStrip(t, A.proj.tracks.indexOf(t), 'focus'));
  },
  fxSheet(t) {
    const h = K.h;
    const body = h('div', { class: 'dk-fxlist' });
    const draw = () => {
      body.textContent = '';
      for (let k = 0; k < M.NFX; k++) {
        const f = t.fx[k];
        if (!f) {
          const add = h('button', { class: 'act add' }, '+ Add an effect');
          add.addEventListener('click', () => K.sheetMenu([{ head: 'Add to ' + t.name }, ...A.fxItems(t, k, false)]));
          body.append(add);
          break;
        }
        const on = h('button', { class: 'dk-b' + (f.on ? ' on fxon' : ''), 'aria-label': f.on ? 'Bypass' : 'Enable' }, f.on ? 'ON' : 'OFF');
        on.addEventListener('click', () => { A.commit('FX bypass'); f.on = !f.on; A.changed({ graph: true, console: true }); draw(); this.render(); ARR.renderHeads(); });
        const open = h('button', { class: 'act' }, FX.types[f.type].name);
        open.addEventListener('click', () => A.openFx(t, k));
        const del = h('button', { class: 'dk-b', 'aria-label': 'Remove' }, '✕');
        del.addEventListener('click', () => { A.commit('Remove FX'); t.fx.splice(k, 1); A.changed({ graph: true, console: true }); draw(); this.render(); ARR.renderHeads(); });
        body.append(h('div', { class: 'dk-fxrow' }, on, open, del));
      }
    };
    draw();
    K.sheet('Effects · ' + t.name, body, null, { light: true, onClose: () => ARR.renderHeads() });
  },
  // ---------- drawing ----------
  drawBg(r) {
    const T = ARR.T; if (!T || !r.w) return;
    const g = r.bg.getContext('2d'), dpr = window.devicePixelRatio || 1, W = r.w, H = r.h, P = A.proj;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.laneA; g.fillRect(0, 0, W, H);
    if (P.loop.on) ARR.hatch(g, this.tToX(r, P.loop.s), 0, (P.loop.e - P.loop.s) / this.span * W, H, T.grid2, 10);
    const beat = 60 / P.bpm, bar = beat * P.sig[0];
    let step = bar; while (step / this.span * W < 22) step *= 2;
    g.fillStyle = T.grid2;
    for (let k = Math.floor(this.t0 / step); k * step <= this.t0 + this.span; k++) g.fillRect(Math.round(this.tToX(r, k * step)), 0, 1, H);
    for (const c of r.t.clips) {
      if (c.start + c.len < this.t0 || c.start > this.t0 + this.span) continue;
      this.drawClip(g, r, c, T);
    }
  },
  drawClip(g, r, c, T) {
    const tr = r.t, x1 = Math.round(this.tToX(r, c.start)), x2 = Math.round(this.tToX(r, c.start + c.len)), w = Math.max(2, x2 - x1), H = r.h, top = 4, h = H - 8;
    const sel = A.ui.sel.has(c.id), HD = h > 44 ? 14 : 0;
    g.save();
    ARR.rrect(g, x1, top, w, h, 6); g.fillStyle = T.clip; g.fill(); g.clip();
    if (HD) { g.fillStyle = sel ? T.acc : T.text; g.fillRect(x1, top, w, HD); }
    if (c.mute) ARR.hatch(g, x1, top + HD, w, h - HD, T.text, 6);
    const b = A.eng.buffers.get(c.buf);
    if (c.pat) ARR.drawNotes(g, c, x1, x2, top + HD + 2, h - HD - 4, r.w / this.span, T, (t) => this.tToX(r, t), (x) => this.xToT(r, x), r.w);
    if (c.beat) ARR.drawBeat(g, tr, c, top + HD + 2, h - HD - 4, r.w / this.span, T, (t) => this.tToX(r, t), (x) => this.xToT(r, x), r.w);
    if (b) {
      const sr = b.ab.sampleRate, pps = r.w / this.span, spp = sr / pps;
      let lvl = 0; while (lvl + 1 < U.LEVELS.length && U.LEVELS[lvl + 1] <= spp) lvl++;
      const pk = b.peaks[lvl], L = U.LEVELS[lvl], n = pk.length / 2, wy = top + HD, wh = h - HD, mid = Math.round(wy + wh / 2), amp = (wh / 2 - 3) * Math.min(4, c.gain);
      g.fillStyle = T.wave;
      g.beginPath();
      for (let x = Math.max(0, Math.floor(x1)); x < Math.min(r.w, x2); x++) {
        const ta = c.off + (x - x1) / pps, tb = c.off + (x + 1 - x1) / pps;
        let ia = Math.max(0, Math.floor(ta * sr / L)), ib = Math.min(n, Math.max(ia + 1, Math.ceil(tb * sr / L)));
        let mn = 0, mx = 0; for (let k = ia; k < ib; k++) { if (pk[k * 2] < mn) mn = pk[k * 2]; if (pk[k * 2 + 1] > mx) mx = pk[k * 2 + 1]; }
        const fg = M.clipGainAt(c, c.start + (x + 0.5 - x1) / pps) / (c.gain || 1);
        g.rect(x, mid - Math.min(1, mx) * amp * fg, 1, Math.max(1, (Math.min(1, mx) - Math.max(-1, mn)) * amp * fg));
      }
      g.fill();
    }
    if (HD && w > 46) { g.fillStyle = T.bg; g.font = ARR.FONT; g.textBaseline = 'middle'; g.fillText((c.name || 'Clip').toUpperCase(), Math.max(x1, 0) + 5, top + HD / 2 + 1); }
    g.restore();
    g.lineWidth = sel ? 3 : 2; g.strokeStyle = sel ? T.acc : T.line; ARR.rrect(g, x1 + g.lineWidth / 2, top + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth, 6); g.stroke();
    if (sel && w > 30) { g.fillStyle = T.acc; [x1 + 3, x2 - 11].forEach((gx) => g.fillRect(gx, top + h / 2 - 16, 8, 32)); }
  },
  frame() {
    if (!this.shown()) return;
    const E = A.eng, pos = E.pos();
    // follow the playhead
    if (E.playing && A.ui.follow && (pos > this.t0 + this.span * 0.94 || pos < this.t0)) { this.t0 = Math.max(0, pos - this.span * 0.06); this.dirty = true; }
    if (this.dirty) { for (const r of this.rows) this.drawBg(r); this.dirty = false; }
    const dpr = window.devicePixelRatio || 1;
    for (const r of this.rows) {
      if (!r.w) continue;
      const g = r.cv.getContext('2d');
      g.setTransform(1, 0, 0, 1, 0, 0); g.drawImage(r.bg, 0, 0);
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const R = A.ui.range, ti = A.proj.tracks.indexOf(r.t);
      if (R && R.e > R.s && ti >= R.t0 && ti <= R.t1) { const xa = this.tToX(r, R.s), xb = this.tToX(r, R.e); g.fillStyle = ARR.T.range; g.fillRect(xa, 0, Math.max(1, xb - xa), r.h); }
      const cov = E.recording && E.take ? E.recCover(r.t) : null;
      if (cov) { const xa = Math.max(0, this.tToX(r, cov[0])), xb = Math.min(r.w, cov[1] === Infinity ? r.w : this.tToX(r, cov[1])); if (xb > xa) { g.globalAlpha = 0.72; g.fillStyle = ARR.T.surface; g.fillRect(xa, 2, xb - xa, r.h - 4); g.globalAlpha = 1; } }
      if (E.recording && E.take && pos > E.take.recStart && E.take.armed.some((a) => a.id === r.t.id)) {
        const x1 = this.tToX(r, E.take.recStart), x2 = this.tToX(r, pos), tk = E.take, mid = r.h / 2, per = 512 / E.sr;
        g.fillStyle = ARR.T.surface; g.fillRect(x1, 4, x2 - x1, r.h - 8); g.globalAlpha = 0.6; ARR.hatch(g, x1, 4, x2 - x1, r.h - 8, ARR.T.acc, 6); g.globalAlpha = 1;
        g.fillStyle = ARR.T.acc;
        for (let x = Math.max(0, Math.floor(x1)); x < Math.min(r.w, x2); x += 2) { const k = Math.floor((this.xToT(r, x) - tk.recStart + tk.lat) / per); if (k < 0 || k >= tk.peaks.length) continue; const a = Math.min(1, tk.peaks[k]) * (r.h / 2 - 4); g.fillRect(x, mid - a, 1.5, a * 2 + 1); }
      }
      const x = this.tToX(r, pos);
      if (x >= -2 && x <= r.w + 2) { g.fillStyle = E.recording ? ARR.T.acc : ARR.T.text; g.fillRect(Math.round(x) - 1, 0, 2, r.h); }
      const mt = E.meters[r.t.id];
      K.drawMeter(r.meter, r.mst, mt && mt.pk ? mt.pk : [0, 0], { horiz: true });
      if (E.playing && r.t.env.vol.on) r.vol.refresh();
    }
    const big = this.lcd.firstChild, small = this.lcd.lastChild, bars = U.fmtBars(pos, A.proj.bpm, A.proj.sig), tm = U.fmtTime(pos);
    big.textContent = A.ui.lcdBars ? bars : tm; small.textContent = A.ui.lcdBars ? tm : bars;
    if (this.focusSet) CON.drawSet(this.focusSet);
    if (this.extra) CON.drawSet(this.extra);
  },
  syncButtons(t) {
    this.rowsEl.querySelectorAll('.drow[data-id="' + t.id + '"] .dk-b[data-k]').forEach((b) => { const k = b.dataset.k; b.classList.toggle('on', !!t[k]); b.setAttribute('aria-pressed', t[k] ? 'true' : 'false'); });
  },
  selected(id) {
    this.rowsEl.querySelectorAll('.drow').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
    this.focusStale = true; this.renderFocus();
  },
};
