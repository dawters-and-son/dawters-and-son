// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — arrange view: track headers, ruler, timeline canvas, clip/envelope/range editing
'use strict';
const ARR = {
  pps: 40, tops: [], HDR: 18, dirty: true, drag: null,
  init() {
    const v = this.view = document.getElementById('arrange');
    this.corner = K.h('div', { class: 'corner' });
    this.rulerwrap = K.h('div', { class: 'rulerwrap' });
    this.ruler = K.h('canvas', { 'aria-label': 'Timeline ruler' }); this.rulerwrap.append(this.ruler);
    this.heads = K.h('div', { class: 'heads' }); this.headsInner = K.h('div', { class: 'heads-inner' }); this.heads.append(this.headsInner);
    this.lanes = K.h('div', { class: 'lanes', tabindex: 0, 'aria-label': 'Tracks timeline' });
    this.content = K.h('div', { style: 'position:relative' });
    this.vp = K.h('div', { style: 'position:sticky;left:0;top:0;overflow:hidden' });
    this.cv = K.h('canvas', { style: 'position:absolute;left:0;top:0' });
    this.ov = K.h('canvas', { style: 'position:absolute;left:0;top:0;pointer-events:none' });
    this.vp.append(this.cv, this.ov); this.content.append(this.vp); this.lanes.append(this.content);
    this.hint = K.h('div', { class: 'empty-hint' }, K.h('b', null, 'Fresh tape, ready to roll.'), 'Arm a track and press R. Or drop audio files here.');
    this.vp.append(this.hint);
    v.append(this.corner, this.rulerwrap, this.heads, this.lanes);
    this.corner.append(K.h('button', { class: 'btn sm', title: 'Add track (Ctrl+T)', 'aria-label': 'Add track', onclick: (e) => A.addTrackMenu(e.clientX, e.clientY) }, '+', K.h('span', { class: 'hide-sm' }, ' Track')));
    this.lanes.addEventListener('scroll', () => { this.headsInner.style.transform = 'translateY(' + -this.lanes.scrollTop + 'px)'; this.dirty = true; });
    new ResizeObserver(() => this.layout()).observe(this.lanes);
    const T = (e) => e.pointerType === 'touch' || e.pointerType === 'pen';
    this.cv.addEventListener('pointerdown', (e) => (T(e) ? this.tdown(e) : this.down(e)));
    this.cv.addEventListener('pointermove', (e) => (T(e) ? this.tmove(e) : this.move(e)));
    this.cv.addEventListener('pointerup', (e) => (T(e) ? this.tup(e) : this.up(e)));
    this.cv.addEventListener('pointercancel', (e) => (T(e) ? this.tup(e, true) : this.up(e, true)));
    this.cv.addEventListener('dblclick', (e) => this.dbl(e));
    this.cv.addEventListener('contextmenu', (e) => { e.preventDefault(); this.ctx(e); });
    this.lanes.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15); }
    }, { passive: false });
    this.ruler.addEventListener('pointerdown', (e) => this.rdown(e));
    this.ruler.addEventListener('pointermove', (e) => this.rmove(e));
    this.ruler.addEventListener('pointerup', (e) => this.rup(e));
    this.ruler.addEventListener('dblclick', (e) => { const t = this.xToT(e.offsetX); A.addMarker(t); });
    this.cv.style.touchAction = 'none';
    this.touches = new Map();
  },
  // ---------- touch gestures: one finger on a clip edits it, on empty space scrolls; two fingers pan + pinch-zoom; long-press opens a sheet ----------
  tdown(e) {
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.cv.setPointerCapture(e.pointerId);
    clearTimeout(this.lpT);
    if (this.touches.size === 2) {
      if (this.drag) { if (this.drag.moved) this.up(e); this.drag = null; }
      this.tpan = null;
      const [a, b] = Array.from(this.touches.values()), r = this.cv.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2;
      this.pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, pps0: this.pps, t: this.xToT(cx), cx, cy, st: this.lanes.scrollTop };
      return;
    }
    if (this.touches.size > 2) return;
    const h = this.hit(e.offsetX, e.offsetY, true);
    const ev = { clientX: e.clientX, clientY: e.clientY, offsetX: e.offsetX, offsetY: e.offsetY };
    this.lpT = setTimeout(() => {
      if ((this.drag && this.drag.moved) || (this.tpan && this.tpan.moved) || this.pinch) return;
      this.drag = null; this.tpan = null; this.ctx(ev);
    }, 520);
    if (h.clip || h.zone === 'envpt' || h.zone === 'envline') { this.down(e, true); return; }
    this.tpan = { x0: e.clientX, y0: e.clientY, sl: this.lanes.scrollLeft, st: this.lanes.scrollTop, moved: false, h };
  },
  tmove(e) {
    if (!this.touches.has(e.pointerId)) return;
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch && this.touches.size >= 2) {
      const [a, b] = Array.from(this.touches.values()), r = this.cv.getBoundingClientRect();
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1, cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2;
      this.pps = U.clamp(this.pinch.pps0 * d / this.pinch.d0, 2, 4000);
      this.layout();
      this.lanes.scrollLeft = Math.max(0, this.pinch.t * this.pps - cx);
      this.lanes.scrollTop = Math.max(0, this.pinch.st - (cy - this.pinch.cy));
      this.dirty = true; return;
    }
    const p = this.tpan;
    if (p) {
      const dx = e.clientX - p.x0, dy = e.clientY - p.y0;
      if (!p.moved && Math.hypot(dx, dy) > 8) { p.moved = true; clearTimeout(this.lpT); }
      if (p.moved) { this.lanes.scrollLeft = Math.max(0, p.sl - dx); this.lanes.scrollTop = Math.max(0, p.st - dy); }
      return;
    }
    if (this.drag) { if (this.drag.moved) clearTimeout(this.lpT); this.move(e); }
  },
  tup(e, cancel) {
    this.touches.delete(e.pointerId);
    if (this.pinch) { if (this.touches.size < 2) { this.pinch = null; this.touches.clear(); } return; }
    clearTimeout(this.lpT);
    const p = this.tpan; this.tpan = null;
    if (p) {
      if (!p.moved && !cancel) { // tap on empty: deselect and move the playhead
        A.ui.sel = new Set(); A.ui.range = null;
        if (p.h.track) A.selectTrack(p.h.track.id, true);
        A.locate(Math.max(0, this.snap(p.h.t)));
        this.dirty = true; A.changed({ inspector: true });
      }
      return;
    }
    if (this.drag) this.up(e, cancel);
  },
  // ---------- geometry ----------
  get vw() { return this.lanes.clientWidth; },
  get vh() { return this.lanes.clientHeight; },
  tToX(t) { return t * this.pps - this.lanes.scrollLeft; },
  xToT(x) { return (x + this.lanes.scrollLeft) / this.pps; },
  layout() {
    const P = A.proj; if (!P) return;
    this.tops = []; let y = 0;
    for (const t of P.tracks) { this.tops.push(y); y += t.height; }
    this.totalH = y;
    const end = Math.max(M.songEnd(P), P.loop.e, A.eng.pos(), 60) + 120;
    const W = Math.max(this.vw, end * this.pps), H = Math.max(this.vh, y + 120);
    this.content.style.width = W + 'px'; this.content.style.height = H + 'px';
    const dpr = window.devicePixelRatio || 1, vw = this.vw, vh = this.vh;
    this.vp.style.width = vw + 'px'; this.vp.style.height = vh + 'px';
    for (const c of [this.cv, this.ov]) { c.width = Math.round(vw * dpr); c.height = Math.round(vh * dpr); c.style.width = vw + 'px'; c.style.height = vh + 'px'; }
    const rw = this.rulerwrap.clientWidth, rh = this.rulerwrap.clientHeight;
    this.ruler.width = Math.round(rw * dpr); this.ruler.height = Math.round(rh * dpr);
    this.headsInner.style.height = H + 'px';
    this.positionHeads();
    this.hint.style.display = P.tracks.some((t) => t.clips.length) || A.eng.recording ? 'none' : '';
    this.dirty = true;
  },
  // zoom keeps the playhead in the middle of the view (pinch passes its own anchor)
  zoom(f, anchorX) {
    this.pps = U.clamp(this.pps * f, 2, 4000);
    this.layout();
    if (anchorX === undefined) this.lanes.scrollLeft = Math.max(0, A.eng.pos() * this.pps - this.vw / 2);
    else { const t = this.xToT(anchorX); this.lanes.scrollLeft = Math.max(0, t * this.pps - anchorX); }
    this.dirty = true;
  },
  fit() {
    const e = Math.max(M.songEnd(A.proj), 10);
    this.pps = U.clamp((this.vw - 40) / e, 2, 4000); this.layout(); this.lanes.scrollLeft = 0;
  },
  trackAt(y) { // y in content coords
    const P = A.proj;
    for (let i = 0; i < P.tracks.length; i++) if (y >= this.tops[i] && y < this.tops[i] + P.tracks[i].height) return i;
    return -1;
  },
  grid() {
    const P = A.proj, beat = 60 / P.bpm, bar = beat * P.sig[0];
    const s = A.ui.snap;
    return s === 'bar' ? bar : s === 'beat' ? beat : s === '1/8' ? beat / 2 : s === '1/16' ? beat / 4 : s === '1/32' ? beat / 8 : 0;
  },
  snap(t, e) { const g = this.grid(); if (!g || (e && e.altKey)) return t; return Math.round(t / g) * g; },
  // ---------- headers ----------
  renderHeads() {
    const P = A.proj, hi = this.headsInner;
    hi.textContent = '';
    this.meters = [];
    P.tracks.forEach((t, i) => {
      const sel = A.ui.selTrack === t.id;
      const el = K.h('div', { class: 'th' + (sel ? ' sel' : ''), 'data-id': t.id });
      const cb = K.h('div', { class: 'cb', style: 'background:' + t.color, title: 'Track colour' });
      cb.addEventListener('click', (e) => this.colorMenu(t, e));
      const nm = K.h('div', { class: 'nm', title: 'Double-click to rename', spellcheck: 'false' }, t.name);
      nm.addEventListener('dblclick', () => { nm.contentEditable = 'true'; nm.focus(); document.getSelection().selectAllChildren(nm); });
      const done = () => { if (nm.contentEditable !== 'true') return; nm.contentEditable = 'false'; const v = nm.textContent.trim(); if (v && v !== t.name) { A.commit('Rename track'); t.name = v; A.changed({ heads: true, console: true }); } else nm.textContent = t.name; };
      nm.addEventListener('blur', done); nm.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); nm.blur(); } if (e.key === 'Escape') { nm.textContent = t.name; nm.blur(); } });
      const mini = (cls, label, on, title, fn) => K.h('button', { class: 'mini ' + cls + (on ? ' on' : ''), title, 'aria-pressed': on ? 'true' : 'false', onclick: fn }, label);
      const inp = K.select([['1', 'In 1'], ['2', 'In 2'], ['1+2', 'In 1+2']], t.input, (v) => { A.commit('Track input'); t.input = v; t.stereo = v === '1+2'; A.changed({ graph: true, heads: true, console: true }); A.eng.updateMonitors(); });
      inp.className = 'inp'; inp.title = 'Recording input';
      const isI = t.kind === 'inst';
      const instBtn = isI ? K.h('button', { class: 'mini wide', title: 'Instrument', onclick: () => INSTUI.open(t) }, INST.TYPES[t.inst.type].toUpperCase()) : null;
      const patBtn = isI ? K.h('button', { class: 'mini wide', title: 'Edit patterns', onclick: () => { A.ui.patTrack = t.id; A.setView('pattern'); } }, 'PAT') : null;
      const meter = K.h('canvas', { class: 'hm' }); this.meters.push({ id: t.id, cv: meter, st: K.meterState() });
      const body = K.h('div', { class: 'body' },
        K.h('div', { class: 'row' }, K.h('span', { class: 'num' }, String(i + 1)), nm),
        K.h('div', { class: 'row' },
          mini('arm', '●', t.arm, 'Arm for recording', () => A.toggleTrack(t, 'arm')),
          isI ? null : mini('mon', 'IN', t.mon, 'Listen to input through this track', () => A.toggleTrack(t, 'mon')),
          mini('mute', 'M', t.mute, 'Mute', () => A.toggleTrack(t, 'mute')),
          mini('solo', 'S', t.solo, 'Solo', () => A.toggleTrack(t, 'solo')),
          mini('fx wide', 'FX' + (t.fx.length ? ' ' + t.fx.length : ''), t.fx.some((f) => f.on), 'Effects on this track', () => { A.selectTrack(t.id); DECK.fxSheet(t); }),
          mini('env wide', t.show === 'vol' ? 'Vol' : t.show === 'pan' ? 'Pan' : '∿', t.show !== 'none', 'Show volume / pan envelope', (e) => this.envMenu(t, e))),
        K.h('div', { class: 'row r3' }, isI ? instBtn : inp, isI ? patBtn : null, meter));
      el.append(cb, body);
      const grip = K.h('div', { class: 'grip', title: 'Drag to resize track' });
      let gy = null, gh = 0;
      grip.addEventListener('pointerdown', (e) => { grip.setPointerCapture(e.pointerId); gy = e.clientY; gh = t.height; e.stopPropagation(); });
      grip.addEventListener('pointermove', (e) => { if (gy === null) return; t.height = U.clamp(gh + e.clientY - gy, 52, 320); this.layout(); });
      grip.addEventListener('pointerup', () => { gy = null; A.save(); });
      el.append(grip);
      el.addEventListener('pointerdown', (e) => { if (!e.target.closest('button,select,.nm[contenteditable=true],.grip')) A.selectTrack(t.id); });
      el.addEventListener('contextmenu', (e) => { e.preventDefault(); this.trackMenu(t, e); });
      hi.append(el);
    });
    hi.append(K.h('button', { class: 'btn sm addtrack', onclick: (e) => A.addTrackMenu(e.clientX, e.clientY) }, '+ Add track'));
    this.positionHeads();
  },
  positionHeads() {
    const P = A.proj; if (!P) return;
    const els = this.headsInner.querySelectorAll('.th');
    els.forEach((el, i) => { const t = P.tracks[i]; if (!t) return; el.style.top = this.tops[i] + 'px'; el.style.height = t.height + 'px'; el.querySelector('.r3').style.display = t.height < 84 ? 'none' : ''; });
    const add = this.headsInner.querySelector('.addtrack'); if (add) add.style.top = (this.totalH + 10) + 'px';
  },
  colorMenu(t, e) {
    K.menu(M.COLORS.map((c) => ({ label: '■ ' + c, act: () => { A.commit('Track colour'); t.color = c; A.changed({ heads: true, console: true }); } })), e.clientX, e.clientY);
    document.querySelectorAll('.dd .it').forEach((b, i) => { b.style.color = M.COLORS[i]; b.style.fontWeight = '900'; });
  },
  envMenu(t, e) {
    const r = e.currentTarget.getBoundingClientRect();
    K.menu([
      { head: 'Show envelope' },
      { label: 'None', check: t.show === 'none', act: () => { t.show = 'none'; A.changed({ heads: true }); } },
      { label: 'Volume', check: t.show === 'vol', act: () => { t.show = 'vol'; if (!t.env.vol.on) { A.commit('Volume envelope'); t.env.vol.on = true; } A.changed({ heads: true, graph: true }); } },
      { label: 'Pan', check: t.show === 'pan', act: () => { t.show = 'pan'; if (!t.env.pan.on) { A.commit('Pan envelope'); t.env.pan.on = true; } A.changed({ heads: true, graph: true }); } },
      { sep: true },
      { label: 'Volume envelope active', check: t.env.vol.on, act: () => { A.commit('Volume envelope'); t.env.vol.on = !t.env.vol.on; A.changed({ graph: true }); } },
      { label: 'Pan envelope active', check: t.env.pan.on, act: () => { A.commit('Pan envelope'); t.env.pan.on = !t.env.pan.on; A.changed({ graph: true }); } },
      { label: 'Clear shown envelope', disabled: t.show === 'none', act: () => { A.commit('Clear envelope'); t.env[t.show].pts = []; A.changed({ graph: true }); } },
    ], r.left, r.bottom + 4);
  },
  trackMenu(t, e) {
    const P = A.proj, i = P.tracks.indexOf(t);
    K.menu([
      { head: t.name },
      { label: 'Effects…', act: () => { A.selectTrack(t.id); DECK.fxSheet(t); } },
      { label: 'Rename…', act: async () => { const v = await K.prompt('Rename track', 'Name', t.name); if (v) { A.commit('Rename track'); t.name = v; A.changed({ heads: true, console: true }); } } },
      { label: 'Duplicate track', act: () => A.duplicateTrack(t) },
      { label: 'Move up', disabled: i === 0, act: () => A.moveTrack(t, -1) },
      { label: 'Move down', disabled: i === P.tracks.length - 1, act: () => A.moveTrack(t, 1) },
      { label: t.stereo ? 'Make mono (centre-panned)' : 'Make stereo', act: () => { A.commit('Track width'); t.stereo = !t.stereo; A.changed({ graph: true, console: true }); } },
      { label: 'Select all clips on track', act: () => { A.ui.sel = new Set(t.clips.map((c) => c.id)); this.dirty = true; } },
      { label: 'Import audio to this track…', act: () => { A.selectTrack(t.id); A.importAudio(); } },
      { sep: true },
      { label: 'Delete track', act: () => A.deleteTrack(t) },
    ], e.clientX, e.clientY);
  },
  // ---------- hit testing ----------
  hit(ox, oy, touch) {
    const EDGE = touch ? 16 : 7;
    const P = A.proj, y = oy + this.lanes.scrollTop, t = this.xToT(ox), ti = this.trackAt(y);
    const r = { ti, t, x: ox, y, zone: 'empty' };
    if (ti < 0) { r.zone = y >= this.totalH ? 'below' : 'empty'; return r; }
    const tr = P.tracks[ti], top = this.tops[ti], h = tr.height; r.track = tr;
    // envelope
    if (tr.show !== 'none') {
      const env = tr.env[tr.show];
      for (let k = 0; k < env.pts.length; k++) { const p = env.pts[k], px = this.tToX(p.t), py = top + this.envY(tr, p.v, h); if (Math.abs(px - ox) < 7 && Math.abs(py - y) < 7) { r.zone = 'envpt'; r.pi = k; return r; } }
      const ly = top + this.envY(tr, M.envAt(env, t, tr.show === 'vol' ? 1 : 0), h);
      if (Math.abs(ly - y) < 5) { r.zone = 'envline'; return r; }
    }
    for (let k = tr.clips.length - 1; k >= 0; k--) {
      const c = tr.clips[k], x1 = this.tToX(c.start), x2 = this.tToX(c.start + c.len);
      if (ox < x1 - 1 || ox > x2 + 1) continue;
      r.clip = c; r.ci = k;
      const yy = y - top;
      const fx1 = this.tToX(c.start + c.fi), fx2 = this.tToX(c.start + c.len - c.fo);
      const sel = A.ui.sel.has(c.id) || !touch;
      if (sel && yy < this.HDR + (touch ? 18 : 8) && Math.abs(ox - fx1) < EDGE && ox - x1 < (x2 - x1) / 2) r.zone = 'fadein';
      else if (sel && yy < this.HDR + (touch ? 18 : 8) && Math.abs(ox - fx2) < EDGE && x2 - ox < (x2 - x1) / 2) r.zone = 'fadeout';
      else if (sel && ox - x1 < EDGE && x2 - x1 > EDGE * 3) r.zone = 'trimL';
      else if (sel && x2 - ox < EDGE && x2 - x1 > EDGE * 3) r.zone = 'trimR';
      else r.zone = 'body';
      return r;
    }
    return r;
  },
  envY(tr, v, h) {
    const pad = 8, inner = h - pad * 2;
    if (tr.show === 'vol') return pad + (1 - K.dbToPos(U.db(v))) * inner;
    return pad + (1 - (v + 1) / 2) * inner;
  },
  envV(tr, yy, h) {
    const pad = 8, n = U.clamp(1 - (yy - pad) / (h - pad * 2), 0, 1);
    return tr.show === 'vol' ? Math.min(2, U.undb(K.posToDb(n))) : n * 2 - 1;
  },
  cursorFor(z) { return { trimL: 'ew-resize', trimR: 'ew-resize', fadein: 'nesw-resize', fadeout: 'nwse-resize', body: 'grab', envpt: 'move', envline: 'copy' }[z] || 'crosshair'; },
  // ---------- pointer ----------
  down(e, viaTouch) {
    if (!viaTouch) this.lanes.focus({ preventScroll: true });
    if (e.button === 2) return;
    const h = this.hit(e.offsetX, e.offsetY, viaTouch);
    this.cv.setPointerCapture(e.pointerId);
    const d = { h, x0: e.offsetX, y0: e.offsetY, moved: false, t0: h.t };
    if (h.track) A.selectTrack(h.track.id, true);
    if (h.zone === 'envpt' || h.zone === 'envline') {
      A.commit('Edit envelope');
      const tr = h.track, env = tr.env[tr.show];
      if (h.zone === 'envline') { const p = { t: Math.max(0, this.snap(h.t, e)), v: this.envV(tr, h.y - this.tops[h.ti], tr.height) }; env.pts.push(p); env.pts.sort((a, b) => a.t - b.t); d.pi = env.pts.indexOf(p); }
      else d.pi = h.pi;
      d.kind = 'env'; d.env = env; d.tr = tr;
      if (!env.on) env.on = true;
    } else if (h.clip && !e.shiftKey) {
      const c = h.clip;
      if (!A.ui.sel.has(c.id)) { if (!(e.ctrlKey || e.metaKey) || h.zone !== 'body') A.ui.sel = new Set(); A.ui.sel.add(c.id); }
      else if ((e.ctrlKey || e.metaKey) && h.zone === 'body' && false) A.ui.sel.delete(c.id);
      A.ui.range = null;
      d.kind = h.zone === 'body' ? 'move' : h.zone; d.clip = c;
      d.snap0 = { start: c.start, off: c.off, len: c.len, fi: c.fi, fo: c.fo };
      d.copy = (e.ctrlKey || e.metaKey) && h.zone === 'body';
      this.cv.style.cursor = h.zone === 'body' ? 'grabbing' : this.cursorFor(h.zone);
    } else {
      d.kind = 'range';
      if (!(e.ctrlKey || e.metaKey)) A.ui.sel = new Set();
      d.ti0 = h.ti < 0 ? A.proj.tracks.length - 1 : h.ti;
    }
    this.drag = d; this.dirty = true;
    A.changed({ inspector: true });
  },
  move(e) {
    const d = this.drag;
    if (!d) { const h = this.hit(e.offsetX, e.offsetY); this.cv.style.cursor = this.cursorFor(h.zone); return; }
    if (d.kind === 'tap') { if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) > 8) { d.moved = true; } return; }
    const dx = e.offsetX - d.x0, dy = e.offsetY - d.y0;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      if (d.kind === 'move' || d.kind === 'trimL' || d.kind === 'trimR' || d.kind === 'fadein' || d.kind === 'fadeout') {
        A.commit(d.kind === 'move' ? (d.copy ? 'Copy clips' : 'Move clips') : d.kind.startsWith('fade') ? 'Fade' : 'Trim clip');
        if (d.kind === 'move') {
          if (d.copy) { // leave originals, drag copies
            const newSel = new Set();
            for (const tr of A.proj.tracks) for (const c of tr.clips.slice()) if (A.ui.sel.has(c.id)) { const n = Object.assign({}, c, { id: U.uid('c') }); tr.clips.push(n); newSel.add(n.id); if (c === d.clip) d.clip = n; }
            A.ui.sel = newSel;
          }
          d.items = [];
          A.proj.tracks.forEach((tr, ti) => tr.clips.forEach((c) => { if (A.ui.sel.has(c.id)) d.items.push({ c, ti, start: c.start }); }));
        }
      }
    }
    const P = A.proj, c = d.clip, dt = dx / this.pps;
    if (d.kind === 'move') {
      const anchor = d.items.find((it) => it.c === d.clip);
      let ns = this.snap(anchor.start + dt, e); const shift = ns - anchor.start;
      const minStart = Math.min(...d.items.map((it) => it.start));
      const sh = Math.max(shift, -minStart);
      const y = e.offsetY + this.lanes.scrollTop; let tiNow = this.trackAt(y); if (tiNow < 0) tiNow = y < 0 ? 0 : P.tracks.length - 1;
      let dti = tiNow - anchor.ti;
      const minTi = Math.min(...d.items.map((it) => it.ti)), maxTi = Math.max(...d.items.map((it) => it.ti));
      dti = U.clamp(dti, -minTi, P.tracks.length - 1 - maxTi);
      for (const it of d.items) {
        it.c.start = it.start + sh;
        const want = P.tracks[it.ti + dti], cur = P.tracks.find((tr) => tr.clips.includes(it.c));
        if (want !== cur) { cur.clips.splice(cur.clips.indexOf(it.c), 1); want.clips.push(it.c); }
      }
    } else if (d.kind === 'trimL') {
      const s0 = d.snap0, minS = c.pat ? 0 : s0.start - s0.off, end = s0.start + s0.len;
      const ns = U.clamp(this.snap(s0.start + dt, e), Math.max(0, minS), end - 0.01);
      c.start = ns; c.off = s0.off + (ns - s0.start); c.len = end - ns; c.fi = Math.min(c.fi, c.len); c.fo = Math.min(c.fo, c.len - c.fi);
    } else if (d.kind === 'trimR') {
      const s0 = d.snap0, b = A.eng.buffers.get(c.buf), maxLen = c.pat ? 3600 : b ? b.ab.duration - s0.off : s0.len;
      const ne = this.snap(s0.start + s0.len + dt, e);
      c.len = U.clamp(ne - s0.start, 0.01, maxLen); c.fo = Math.min(c.fo, c.len); c.fi = Math.min(c.fi, c.len - c.fo);
    } else if (d.kind === 'fadein') {
      c.fi = U.clamp(d.snap0.fi + dt, 0, c.len - c.fo);
    } else if (d.kind === 'fadeout') {
      c.fo = U.clamp(d.snap0.fo - dt, 0, c.len - c.fi);
    } else if (d.kind === 'env') {
      const tr = d.tr, p = d.env.pts[d.pi];
      const top = this.tops[P.tracks.indexOf(tr)];
      p.t = Math.max(0, this.snap(this.xToT(e.offsetX), e));
      p.v = this.envV(tr, e.offsetY + this.lanes.scrollTop - top, tr.height);
      d.env.pts.sort((a, b) => a.t - b.t); d.pi = d.env.pts.indexOf(p);
      A.status(tr.show === 'vol' ? U.fmtDb(U.db(p.v)) + ' dB' : (p.v === 0 ? 'C' : p.v < 0 ? Math.round(-p.v * 100) + ' L' : Math.round(p.v * 100) + ' R'));
    } else if (d.kind === 'range') {
      const a = this.snap(Math.max(0, d.t0), e), b = this.snap(Math.max(0, this.xToT(e.offsetX)), e);
      const y = e.offsetY + this.lanes.scrollTop; let ti = this.trackAt(y); if (ti < 0) ti = y < 0 ? 0 : P.tracks.length - 1;
      A.ui.range = { s: Math.min(a, b), e: Math.max(a, b), t0: Math.min(d.ti0, ti), t1: Math.max(d.ti0, ti) };
      A.status('Range ' + U.fmtTime(A.ui.range.s) + ' → ' + U.fmtTime(A.ui.range.e) + '  (' + (A.ui.range.e - A.ui.range.s).toFixed(3) + ' s)');
    }
    if (d.kind !== 'range') A.eng.clipsChanged();
    // auto-scroll near edges
    if (e.offsetX > this.vw - 30) this.lanes.scrollLeft += 12; else if (e.offsetX < 20 && this.lanes.scrollLeft > 0) this.lanes.scrollLeft -= 12;
    this.dirty = true;
  },
  up(e, cancel) {
    const d = this.drag; this.drag = null; this.cv.style.cursor = '';
    if (!d) return;
    if (d.kind === 'tap') {
      if (cancel || d.moved) return;
      const h = d.h;
      if (h.clip) { A.ui.sel = new Set([h.clip.id]); A.selectTrack(h.track.id, true); }
      else { A.ui.sel = new Set(); A.ui.range = null; if (h.track) A.selectTrack(h.track.id, true); A.locate(Math.max(0, this.snap(h.t))); }
      this.dirty = true; A.changed({ inspector: true }); return;
    }
    if (d.kind === 'range' && !d.moved) {
      A.ui.range = null;
      if (d.h.zone === 'below') { /* nothing */ }
      A.locate(Math.max(0, this.snap(d.h.t, e)));
    } else if (d.moved && d.kind !== 'range') {
      A.changed({ clips: true, graph: d.kind === 'env' });
      if (d.kind === 'env') A.eng.graph.sync(A.proj);
    } else if (!d.moved && d.kind === 'move' && !(e.ctrlKey || e.metaKey)) {
      A.ui.sel = new Set([d.clip.id]);
    }
    if (d.kind === 'move' && !d.moved && (e.ctrlKey || e.metaKey) && !d.copy) { /* toggled on down */ }
    if (d.moved && d.kind === 'move' && !d.copy && A.history.u.length) { /* committed */ }
    if (d.kind === 'env' && !d.moved) A.changed({ graph: true });
    this.dirty = true; A.changed({ inspector: true });
  },
  dbl(e) {
    const h = this.hit(e.offsetX, e.offsetY);
    if (h.zone === 'envpt') { A.commit('Delete envelope point'); h.track.env[h.track.show].pts.splice(h.pi, 1); A.changed({ graph: true }); this.dirty = true; return; }
    if (h.clip && h.clip.pat) { A.ui.patTrack = h.track.id; A.ui.pat = h.clip.pat; A.setView('pattern'); return; }
    if (h.clip) { A.ui.sel = new Set([h.clip.id]); A.clipDialog(h.clip); return; }
    if (h.zone === 'below') A.addTrack();
  },
  ctx(e) {
    const h = this.hit(e.offsetX, e.offsetY);
    if (h.zone === 'envpt') { K.menu([{ label: 'Delete point', act: () => { A.commit('Delete envelope point'); h.track.env[h.track.show].pts.splice(h.pi, 1); A.changed({ graph: true }); } }, { label: 'Reset point to ' + (h.track.show === 'vol' ? '0 dB' : 'centre'), act: () => { A.commit('Envelope point'); h.track.env[h.track.show].pts[h.pi].v = h.track.show === 'vol' ? 1 : 0; A.changed({ graph: true }); } }], e.clientX, e.clientY); return; }
    if (h.clip) {
      if (!A.ui.sel.has(h.clip.id)) A.ui.sel = new Set([h.clip.id]);
      this.dirty = true; A.clipMenu(h.clip, h.track, h.t, e.clientX, e.clientY); return;
    }
    const R = A.ui.range;
    K.menu([
      R ? { head: 'Range ' + (R.e - R.s).toFixed(2) + ' s' } : { head: h.track ? h.track.name : 'Timeline' },
      R ? { label: 'Loop this range', act: () => A.setLoop(R.s, R.e, true) } : null,
      R ? { label: 'Punch-record this range', act: () => { A.commit('Punch range'); A.proj.punch = { on: true, s: R.s, e: R.e }; A.changed({ transport: true }); } } : null,
      R ? { label: 'Split clips at range edges', act: () => A.splitRange(R) } : null,
      R ? { label: 'Delete audio in range', key: 'Del', act: () => A.deleteRange(R, false) } : null,
      R ? { label: 'Delete range and close gap', act: () => A.deleteRange(R, true) } : null,
      R ? { label: 'Insert silence of this length', act: () => A.insertSilence(R) } : null,
      R ? { sep: true } : null,
      { label: 'Paste here', key: 'Ctrl+V', disabled: !A.clipboard, act: () => { if (h.track) A.selectTrack(h.track.id, true); A.paste(Math.max(0, this.snap(h.t))); } },
      { label: 'Import audio here…', act: () => { if (h.track) A.selectTrack(h.track.id, true); A.locate(Math.max(0, this.snap(h.t))); A.importAudio(); } },
      { label: 'Add marker here', act: () => A.addMarker(Math.max(0, this.snap(h.t))) },
      { label: 'Add track', act: () => A.addTrack() },
    ], e.clientX, e.clientY);
  },
  // ---------- ruler ----------
  rdown(e) {
    this.ruler.setPointerCapture(e.pointerId);
    const t = Math.max(0, this.xToT(e.offsetX)), h = this.rulerwrap.clientHeight, P = A.proj;
    const upper = e.offsetY < h * 0.48;
    const reg = e.shiftKey ? P.punch : P.loop;
    if (upper) {
      const xs = this.tToX(reg.s), xe = this.tToX(reg.e);
      A.commit(e.shiftKey ? 'Punch range' : 'Loop range');
      let mode = 'new';
      if ((reg.on || !e.shiftKey) && Math.abs(e.offsetX - xs) < 7) mode = 's'; else if ((reg.on || !e.shiftKey) && Math.abs(e.offsetX - xe) < 7) mode = 'e'; else if (e.offsetX > xs && e.offsetX < xe && reg.on) mode = 'mv';
      this.rdrag = { kind: 'reg', reg, mode, t0: t, s0: reg.s, e0: reg.e, moved: false, punch: e.shiftKey };
    } else {
      this.rdrag = { kind: 'loc' }; A.locate(this.snap(t, e));
    }
  },
  rmove(e) {
    const d = this.rdrag;
    if (!d) { const h = this.rulerwrap.clientHeight; this.ruler.style.cursor = e.offsetY < h * 0.48 ? 'col-resize' : 'pointer'; return; }
    const t = Math.max(0, this.xToT(e.offsetX));
    if (d.kind === 'loc') { if (!A.eng.playing) A.locate(this.snap(t, e)); return; }
    d.moved = true;
    const r = d.reg, st = this.snap(t, e);
    if (d.mode === 'new') { r.s = Math.min(this.snap(d.t0, e), st); r.e = Math.max(this.snap(d.t0, e), st); }
    else if (d.mode === 's') r.s = Math.min(st, r.e - 0.05);
    else if (d.mode === 'e') r.e = Math.max(st, r.s + 0.05);
    else { const dt = this.snap(d.s0 + (t - d.t0), e) - d.s0; r.s = Math.max(0, d.s0 + dt); r.e = r.s + (d.e0 - d.s0); }
    if (r.e - r.s > 0.05) r.on = true;
    this.dirty = true; A.changed({ transport: true });
  },
  rup(e) {
    const d = this.rdrag; this.rdrag = null; if (!d) return;
    if (d.kind === 'loc' && A.eng.playing) A.locate(this.snap(Math.max(0, this.xToT(e.offsetX)), e));
    if (d.kind === 'reg') {
      if (!d.moved && d.mode !== 'new') { d.reg.on = !d.reg.on; }
      else if (!d.moved) { A.history.u.pop(); A.locate(this.snap(Math.max(0, this.xToT(e.offsetX)), e)); }
      A.changed({ transport: true }); if (A.eng.playing) A.eng.reschedule();
    }
    this.dirty = true;
  },
  // ---------- drawing ----------
  css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); },
  theme() {
    const s = getComputedStyle(document.documentElement), g = (n) => s.getPropertyValue(n).trim();
    this.T = { laneA: g('--lane-a'), laneB: g('--lane-b'), grid: g('--grid'), grid2: g('--grid-strong'), line: g('--line'), text: g('--text'), muted: g('--muted'),
      surface: g('--surface'), surface2: g('--surface-2'), sel: g('--sel'), range: g('--range'), acc: g('--acc'), clip: g('--clip'), wave: g('--wave'), bg: g('--bg'),
      vu: g('--vu'), vuInk: g('--vu-ink'), night: document.documentElement.dataset.theme === 'night' };
    this._pats = {};
    K.T = this.T; this.dirty = true;
  },
  FONT: "500 11px Oswald, 'Arial Narrow', sans-serif",
  rrect(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect && w > 2 && h > 2) g.roundRect(x, y, w, h, Math.min(r, w / 2, h / 2)); else g.rect(x, y, w, h); },
  NUMFONT: "700 11px 'Courier Prime', 'Courier New', monospace",
  // shade a region with a printed halftone screen (a cached dot pattern per colour and pitch)
  hatch(g, x, y, w, h, color, step) {
    if (w <= 0 || h <= 0) return;
    const st = Math.max(4, Math.round((step || 8) * 0.8)), key = color + '|' + st;
    this._pats = this._pats || {};
    let pat = this._pats[key];
    if (!pat) {
      const c = document.createElement('canvas'); c.width = c.height = st * 2;
      const q = c.getContext('2d'); q.fillStyle = color; const r = Math.max(1, st * 0.2);
      [[st / 2, st / 2], [st * 1.5, st * 1.5]].forEach(([a, b]) => { q.beginPath(); q.arc(a, b, r, 0, Math.PI * 2); q.fill(); });
      pat = this._pats[key] = g.createPattern(c, 'repeat');
    }
    g.save(); g.fillStyle = pat; g.fillRect(x, y, w, h); g.restore();
  },
  gridSteps() {
    const P = A.proj, beat = 60 / P.bpm, bar = beat * P.sig[0];
    let barStep = 1; while (bar * barStep * this.pps < 48) barStep *= 2;
    const showBeats = beat * this.pps >= 14, showSub = beat / 4 * this.pps >= 10;
    return { beat, bar, barStep, showBeats, showSub };
  },
  draw() {
    const P = A.proj; if (!P || !this.T) return;
    const g = this.cv.getContext('2d'), dpr = window.devicePixelRatio || 1, W = this.vw, H = this.vh, T = this.T;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.surface; g.fillRect(0, 0, W, H);
    const sy = this.lanes.scrollTop, t0 = this.xToT(0), t1 = this.xToT(W), lanesH = Math.min(H, this.totalH - sy);
    P.tracks.forEach((tr, i) => {
      const y = this.tops[i] - sy; if (y > H || y + tr.height < 0) return;
      g.fillStyle = i % 2 ? T.laneB : T.laneA; g.fillRect(0, y, W, tr.height);
      if (A.ui.selTrack === tr.id) { g.fillStyle = T.sel; g.fillRect(0, y, W, tr.height); }
      g.fillStyle = T.line; g.fillRect(0, y + tr.height - 2, W, 2);
    });
    if (P.loop.on) this.hatch(g, this.tToX(P.loop.s), 0, (P.loop.e - P.loop.s) * this.pps, lanesH, T.grid2, 10);
    if (P.punch.on) { g.globalAlpha = 0.5; this.hatch(g, this.tToX(P.punch.s), 0, (P.punch.e - P.punch.s) * this.pps, lanesH, T.acc, 6); g.globalAlpha = 1; }
    const gs = this.gridSteps();
    if (gs.showSub && A.ui.snap !== 'off') { g.fillStyle = T.grid; for (let k = Math.floor(t0 / (gs.beat / 4)); k * gs.beat / 4 <= t1; k++) { if (k % 4 === 0) continue; g.fillRect(Math.round(this.tToX(k * gs.beat / 4)), 0, 1, H); } }
    if (gs.showBeats) { g.fillStyle = T.grid2; for (let k = Math.floor(t0 / gs.beat); k * gs.beat <= t1; k++) g.fillRect(Math.round(this.tToX(k * gs.beat)), 0, 1, H); }
    g.fillStyle = T.line; for (let k = Math.floor(t0 / gs.bar / gs.barStep) * gs.barStep; k * gs.bar <= t1; k += gs.barStep) g.fillRect(Math.round(this.tToX(k * gs.bar)), 0, 1, H);
    g.fillStyle = T.acc; for (const m of P.markers) { const x = this.tToX(m.t); if (x >= -2 && x <= W) g.fillRect(Math.round(x), 0, 2, H); }
    P.tracks.forEach((tr, i) => {
      const y = this.tops[i] - sy; if (y > H || y + tr.height < 0) return;
      for (const c of tr.clips) { if (c.start + c.len < t0 || c.start > t1) continue; this.drawClip(g, tr, c, y); }
      if (tr.show !== 'none') this.drawEnv(g, tr, y);
    });
    const R = A.ui.range;
    if (R && R.e > R.s) {
      const x = this.tToX(R.s), w = (R.e - R.s) * this.pps, y0 = this.tops[R.t0] - sy, y1 = this.tops[R.t1] + P.tracks[R.t1].height - sy;
      g.fillStyle = T.range; g.fillRect(x, y0, w, y1 - y0);
      g.strokeStyle = T.text; g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeRect(x + 1, y0 + 1, w - 2, y1 - y0 - 2); g.setLineDash([]);
    }
    this.drawRuler();
    this.dirty = false;
  },
  shade(hex, f) {
    const n = parseInt(hex.slice(1), 16); let r = n >> 16, gg = (n >> 8) & 255, b = n & 255;
    if (f > 0) { r += (255 - r) * f; gg += (255 - gg) * f; b += (255 - b) * f; } else { r *= 1 + f; gg *= 1 + f; b *= 1 + f; }
    return 'rgb(' + (r | 0) + ',' + (gg | 0) + ',' + (b | 0) + ')';
  },
  drawClip(g, tr, c, y) {
    const T = this.T, x1 = Math.round(this.tToX(c.start)), x2 = Math.round(this.tToX(c.start + c.len)), w = Math.max(2, x2 - x1);
    const top = y + 4, h = tr.height - 9, sel = A.ui.sel.has(c.id), HD = this.HDR;
    g.save();
    g.beginPath(); if (g.roundRect) g.roundRect(x1, top, w, h, Math.min(5, w / 2)); else g.rect(x1, top, w, h); g.fillStyle = T.clip; g.fill(); g.clip();
    // name band: solid ink with a track-colour block
    g.fillStyle = sel ? T.acc : T.text; g.fillRect(x1, top, w, HD);
    g.fillStyle = c.color || tr.color; g.beginPath(); g.arc(x1 + HD / 2, top + HD / 2, HD / 2 - 3, 0, Math.PI * 2); g.fill();
    if (c.mute) this.hatch(g, x1, top + HD, w, h - HD, T.text, 6);
    const b = A.eng.buffers.get(c.buf);
    const wy = top + HD + 2, wh = h - HD - 4, mid = Math.round(wy + wh / 2);
    if (c.pat && wh > 6) ARR.drawNotes(g, c, x1, x2, wy, wh, this.pps, T, (t) => this.tToX(t), (x) => this.xToT(x), this.vw);
    if (b && wh > 6) {
      const sr = b.ab.sampleRate, spp = sr / this.pps;
      let lvl = 0; while (lvl + 1 < U.LEVELS.length && U.LEVELS[lvl + 1] <= spp) lvl++;
      const pk = b.peaks[lvl], L = U.LEVELS[lvl], npk = pk.length / 2;
      const xa = Math.max(Math.floor(x1), -2), xb = Math.min(Math.ceil(x2), this.vw + 2);
      g.fillStyle = T.wave; g.beginPath();
      const amp = (wh / 2) * Math.min(4, c.gain);
      for (let x = xa; x < xb; x++) {
        const ta = c.off + (x - x1) / this.pps, tb = c.off + (x + 1 - x1) / this.pps;
        let ia = Math.floor(ta * sr / L), ib = Math.max(ia + 1, Math.ceil(tb * sr / L));
        if (ib <= 0 || ia >= npk) continue;
        ia = Math.max(0, ia); ib = Math.min(npk, ib);
        let mn = 0, mx = 0; for (let k = ia; k < ib; k++) { if (pk[k * 2] < mn) mn = pk[k * 2]; if (pk[k * 2 + 1] > mx) mx = pk[k * 2 + 1]; }
        const fg = M.clipGainAt(c, c.start + (x + 0.5 - x1) / this.pps) / (c.gain || 1);
        const y1 = mid - Math.min(1, mx) * amp * fg, y2 = mid - Math.max(-1, mn) * amp * fg;
        g.rect(x, y1, 1, Math.max(1, y2 - y1));
      }
      g.fill();
      g.fillStyle = T.grid2; g.fillRect(x1, mid, w, 1);
    }
    g.strokeStyle = T.text; g.lineWidth = 1.5;
    const by = top + h;
    if (c.fi > 0) { const fx = this.tToX(c.start + c.fi); g.beginPath(); g.moveTo(x1, by); g.lineTo(fx, top + HD); g.stroke(); }
    if (c.fo > 0) { const fx = this.tToX(c.start + c.len - c.fo); g.beginPath(); g.moveTo(fx, top + HD); g.lineTo(x2, by); g.stroke(); }
    if (w > 30) {
      g.fillStyle = T.bg; g.font = this.FONT; g.textBaseline = 'middle';
      const lab = (c.name || 'Clip').toUpperCase() + (c.gain !== 1 ? '  ' + U.fmtDb(U.db(c.gain)) + 'DB' : '') + (c.rev ? '  REV' : '') + (c.mute ? '  MUTED' : '');
      g.fillText(lab, Math.max(x1, 0) + HD + 2, top + HD / 2 + 1);
    }
    g.restore();
    if (w > 24) { // fade handles: plain squares
      g.fillStyle = T.surface; g.strokeStyle = T.text; g.lineWidth = 2;
      [this.tToX(c.start + c.fi), this.tToX(c.start + c.len - c.fo)].forEach((hx) => { g.beginPath(); g.arc(Math.round(hx), top + HD, 4.5, 0, Math.PI * 2); g.fill(); g.stroke(); });
    }
    g.lineWidth = sel ? 3 : 2; g.strokeStyle = sel ? T.acc : T.line;
    ARR.rrect(g, x1 + g.lineWidth / 2, top + g.lineWidth / 2, w - g.lineWidth, h - g.lineWidth, 5); g.stroke();
  },
  // mini piano roll for pattern clips, with a rule at every loop point
  drawNotes(g, c, x1, x2, wy, wh, pps, T, tToX, xToT, vw) {
    const p = A.proj.patterns[c.pat]; if (!p) return;
    const beat = A.eng.beat(), per = p.len * beat, base = c.start - c.off;
    let lo = 127, hi = 0; for (const n of p.notes) { lo = Math.min(lo, n.n); hi = Math.max(hi, n.n); }
    if (lo > hi) { lo = 48; hi = 72; }
    const span = Math.max(12, hi - lo + 1), rh = Math.max(1.5, Math.min(6, (wh - 4) / span)), y0 = wy + (wh - rh * span) / 2;
    const vx1 = Math.max(x1, -4), vx2 = Math.min(x2, vw + 4);
    for (let k = Math.floor((xToT(vx1) - base) / per) - 1; base + k * per < xToT(vx2); k++) {
      const lx = tToX(base + k * per);
      if (lx > x1 + 1 && lx < x2 - 1) { g.fillStyle = T.grid2; g.fillRect(Math.round(lx), wy, 1, wh); }
      g.fillStyle = T.wave;
      for (const n of p.notes) {
        const nx = tToX(base + k * per + n.t * beat), nw = Math.max(2, n.d * beat * pps - 1);
        if (nx + nw < x1 || nx > x2) continue;
        const sx = Math.max(nx, x1), ew = Math.min(nx + nw, x2) - sx; if (ew <= 0) continue;
        g.fillRect(sx, y0 + (hi - n.n) * rh, ew, Math.max(1.5, rh - 0.5));
      }
    }
  },
  drawEnv(g, tr, y) {
    const T = this.T, env = tr.env[tr.show], h = tr.height, col = tr.show === 'vol' ? T.text : T.acc, W = this.vw;
    g.save();
    g.strokeStyle = col; g.lineWidth = 2; if (!env.on) g.setLineDash([6, 5]);
    g.beginPath();
    const def = tr.show === 'vol' ? 1 : 0, pts = env.pts;
    g.moveTo(0, y + this.envY(tr, M.envAt(env, this.xToT(0), def), h));
    for (const p of pts) { const x = this.tToX(p.t); if (x < 0 || x > W) continue; g.lineTo(x, y + this.envY(tr, p.v, h)); }
    g.lineTo(W, y + this.envY(tr, M.envAt(env, this.xToT(W), def), h));
    g.stroke(); g.setLineDash([]);
    for (const p of pts) { const x = this.tToX(p.t); if (x < -6 || x > W + 6) continue; const py = y + this.envY(tr, p.v, h); g.fillStyle = col; g.fillRect(Math.round(x) - 5, Math.round(py) - 5, 10, 10); g.fillStyle = T.surface; g.fillRect(Math.round(x) - 2, Math.round(py) - 2, 4, 4); }
    const label = (tr.show === 'vol' ? 'VOLUME' : 'PAN') + (env.on ? '' : ' (OFF)') + (pts.length ? '' : ' / CLICK THE LINE TO ADD POINTS');
    g.font = this.FONT; const tw = g.measureText(label).width;
    g.fillStyle = col; g.fillRect(6, y + h - 22, tw + 10, 15); g.fillStyle = T.bg; g.textBaseline = 'middle'; g.fillText(label, 11, y + h - 14);
    g.restore();
  },
  drawRuler() {
    const P = A.proj, cv = this.ruler, dpr = window.devicePixelRatio || 1, W = this.rulerwrap.clientWidth, H = this.rulerwrap.clientHeight, T = this.T;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const t0 = this.xToT(0), t1 = this.xToT(W), gs = this.gridSteps(), half = Math.round(H * 0.48);
    g.fillStyle = T.surface; g.fillRect(0, 0, W, half);
    const bar = (r, c1, fg, label) => { const x = Math.round(this.tToX(r.s)), w = Math.round((r.e - r.s) * this.pps); g.globalAlpha = r.on ? 1 : 0.25; g.fillStyle = c1; g.fillRect(x, 3, w, half - 5); g.fillStyle = fg; g.font = this.FONT; g.textBaseline = 'middle'; if (w > 44) g.fillText(label, x + 6, half / 2 + 1); g.globalAlpha = 1; };
    bar(P.loop, T.text, T.bg, 'LOOP');
    if (P.punch.on) bar(P.punch, T.acc, '#fff', 'PUNCH');
    g.fillStyle = T.text; g.font = this.NUMFONT; g.textBaseline = 'alphabetic';
    for (let k = Math.max(0, Math.floor(t0 / gs.bar / gs.barStep) * gs.barStep); k * gs.bar <= t1; k += gs.barStep) {
      const x = Math.round(this.tToX(k * gs.bar)); g.fillRect(x, half, 2, H - half); g.fillText(String(k + 1), x + 5, H - 6);
    }
    if (gs.showBeats) { for (let k = Math.max(0, Math.floor(t0 / gs.beat)); k * gs.beat <= t1; k++) { const x = Math.round(this.tToX(k * gs.beat)); g.fillRect(x, H - 6, 1, 6); } }
    for (const m of P.markers) { const x = Math.round(this.tToX(m.t)); if (x < -60 || x > W) continue; g.font = this.FONT; const tw = g.measureText(m.name).width; g.fillStyle = T.acc; g.fillRect(x, half + 1, tw + 8, 13); g.fillStyle = '#fff'; g.textBaseline = 'middle'; g.fillText(m.name, x + 4, half + 8); g.textBaseline = 'alphabetic'; }
    g.fillStyle = T.line; g.fillRect(0, half, W, 2);
  },
  drawOverlay() {
    const P = A.proj; if (!P) return;
    const T = this.T, g = this.ov.getContext('2d'), dpr = window.devicePixelRatio || 1, W = this.vw, H = this.vh;
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const E = A.eng, pos = E.pos(), sy = this.lanes.scrollTop;
    // recording over a track: veil its old audio in the covered range (it is silent there and will be replaced)
    if (E.recording && E.take) for (const a of E.take.armed) {
      const i = P.tracks.findIndex((t) => t.id === a.id); if (i < 0) continue;
      const cov = E.recCover(P.tracks[i]); if (!cov) continue;
      const xa = Math.max(0, this.tToX(cov[0])), xb = Math.min(W, cov[1] === Infinity ? W : this.tToX(cov[1])); if (xb <= xa) continue;
      const y = this.tops[i] - sy + 2, h = P.tracks[i].height - 5;
      g.globalAlpha = 0.72; g.fillStyle = T.surface; g.fillRect(xa, y, xb - xa, h); g.globalAlpha = 1;
      g.fillStyle = T.acc; g.font = this.FONT; g.textBaseline = 'top';
      if (xb - xa > 150) g.fillText('● RECORDING OVER — OLD AUDIO MUTED', Math.max(xa, this.tToX(pos)) + 8, y + 4);
    }
    if (E.recording && E.take && pos > E.take.recStart) {
      const tk = E.take, x1 = this.tToX(tk.recStart), x2 = this.tToX(pos);
      for (const a of tk.armed) {
        const i = P.tracks.findIndex((t) => t.id === a.id); if (i < 0) continue;
        const y = this.tops[i] - sy + 4, h = P.tracks[i].height - 9;
        g.fillStyle = T.surface; g.fillRect(x1, y, x2 - x1, h);
        g.globalAlpha = 0.6; this.hatch(g, x1, y, x2 - x1, h, T.acc, 6); g.globalAlpha = 1;
        g.strokeStyle = T.acc; g.lineWidth = 3; g.strokeRect(x1 + 1.5, y + 1.5, x2 - x1 - 3, h - 3);
        g.fillStyle = T.acc;
        const mid = y + h / 2, pk = tk.peaks, sr = E.sr, perPk = 512 / sr, lat = tk.lat;
        for (let x = Math.max(0, Math.floor(x1)); x < Math.min(W, x2); x += 2) {
          const t = this.xToT(x) - tk.recStart + lat, k = Math.floor(t / perPk);
          if (k < 0 || k >= pk.length) continue;
          const a2 = Math.min(1, pk[k]) * h / 2; g.fillRect(x, mid - a2, 1.5, a2 * 2 + 1);
        }
      }
    }
    const x = this.tToX(pos);
    if (x >= -2 && x <= W + 2) { g.fillStyle = E.recording ? T.acc : T.text; g.fillRect(Math.round(x) - 1, 0, 2, H); }
    if (E.playing && A.ui.follow && !this.drag) {
      if (x > W * 0.92 || x < 0) { this.lanes.scrollLeft = Math.max(0, pos * this.pps - W * 0.08); this.dirty = true; }
    }
    if (E.playing && pos * this.pps > parseFloat(this.content.style.width) - W) this.layout();
    if (this.meters) for (const m of this.meters) { const mt = E.meters[m.id]; K.drawMeter(m.cv, m.st, mt && mt.pk ? mt.pk : [0, 0], { horiz: true }); }
  },
  frame() {
    if (!this.view.classList.contains('show')) return;
    if (this.dirty) this.draw();
    this.drawOverlay();
    const g = this.ruler.getContext('2d'), x = Math.round(this.tToX(A.eng.pos())), H = this.rulerwrap.clientHeight, T = this.T;
    if (this._rx !== undefined && Math.abs(this._rx - x) > 0.5) this.drawRuler();
    this._rx = x;
    g.fillStyle = A.eng.recording ? T.acc : T.text;
    g.fillRect(x - 6, Math.round(H * 0.48), 12, 8); g.fillRect(x - 1, Math.round(H * 0.48), 2, H);
  },
};
