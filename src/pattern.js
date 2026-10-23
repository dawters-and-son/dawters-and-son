// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — pattern editor (piano roll + step grid), instrument panel, playable keys
'use strict';
const PAT = {
  ppb: 80, sb: 0, top: 0, rh: 16, KEYW: 64, VELH: 70, mode: 'roll', grid: 0.25, sel: new Set(), drag: null, dirty: true, lastLen: 0.25, defVel: 0.8, held: new Map(),
  init() {
    this.view = document.getElementById('pattern');
    const h = K.h;
    this.bar = h('div', { class: 'pt-bar', role: 'toolbar', 'aria-label': 'Pattern tools' });
    this.wrap = h('div', { class: 'pt-wrap' });
    this.cv = h('canvas', { class: 'pt-cv', tabindex: 0, 'aria-label': 'Pattern editor' });
    this.wrap.append(this.cv);
    this.keys = h('div', { class: 'pt-keys' });
    this.empty = h('div', { class: 'pt-empty' });
    this.view.append(this.bar, this.wrap, this.keys, this.empty);
    new ResizeObserver(() => { this.size(); this.dirty = true; }).observe(this.wrap);
    const c = this.cv;
    c.addEventListener('pointerdown', (e) => this.down(e));
    c.addEventListener('pointermove', (e) => this.move(e));
    c.addEventListener('pointerup', (e) => this.up(e));
    c.addEventListener('pointercancel', (e) => this.up(e, true));
    c.addEventListener('dblclick', (e) => this.dbl(e));
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); this.rclick(e); });
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) return this.zoom(e.deltaY < 0 ? 1.15 : 1 / 1.15);
      if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) this.sb = Math.max(0, this.sb + (e.deltaX || e.deltaY) / this.ppb);
      else this.top = U.clamp(this.top + e.deltaY / this.rh * 0.6, 0, Math.max(0, this.rows().length - this.visRows()));
      this.dirty = true;
    }, { passive: false });
    this.touches = new Map();
  },
  shown() { return this.view.classList.contains('show'); },
  track() { const t = A.proj.tracks.find((x) => x.id === A.ui.patTrack && x.kind === 'inst'); return t || A.proj.tracks.find((x) => x.id === A.ui.selTrack && x.kind === 'inst') || A.proj.tracks.find((x) => x.kind === 'inst') || null; },
  pats(t) { return Object.values(A.proj.patterns).filter((p) => p.track === t.id); },
  pat() { const t = this.track(); if (!t) return null; let p = A.proj.patterns[A.ui.pat]; if (!p || p.track !== t.id) { p = this.pats(t)[0] || null; A.ui.pat = p ? p.id : null; } return p; },
  isDrum() { const t = this.track(); return t && t.inst.type === 'drums'; },
  // ---------- toolbar ----------
  render() {
    const h = K.h, t = this.track(), b = this.bar;
    b.textContent = ''; this.keys.textContent = '';
    if (!t) {
      this.wrap.style.display = 'none'; this.keys.style.display = 'none'; this.empty.style.display = '';
      this.empty.innerHTML = '';
      this.empty.append(h('b', null, 'No instrument tracks.'), h('div', null, 'Add one to write patterns:'),
        h('div', { class: 'pt-new' }, ...Object.keys(INST.TYPES).map((k) => h('button', { class: 'btn', onclick: () => { const nt = A.addInstTrack(k); A.ui.patTrack = nt.id; this.render(); } }, '+ ' + INST.TYPES[k]))));
      return;
    }
    this.wrap.style.display = ''; this.keys.style.display = ''; this.empty.style.display = 'none';
    const changed = this._lt !== t.id || this._lp !== A.ui.pat;
    if (this._lt !== t.id) this.mode = t.inst.type === 'drums' ? 'steps' : 'roll';
    A.ui.patTrack = t.id; this._lt = t.id;
    let p = this.pat();
    if (!p) { p = A.newPatternFor(t, true); }
    const trSel = K.select(A.proj.tracks.filter((x) => x.kind === 'inst').map((x) => [x.id, x.name]), t.id, (v) => { A.ui.patTrack = v; A.ui.pat = null; this.sel.clear(); this.render(); });
    const patSel = K.select(this.pats(t).map((x) => [x.id, x.name]), p.id, (v) => { A.ui.pat = v; this.sel.clear(); this.fitRows(); this.render(); });
    const lenSel = K.select([[4, '1 bar'], [8, '2 bars'], [16, '4 bars'], [32, '8 bars'], [64, '16 bars']].map(([v, l]) => [v * A.proj.sig[0] / 4, l]).concat([[p.len, p.len + ' beats']]).filter((x, i, arr) => arr.findIndex((y) => +y[0] === +x[0]) === i), p.len, (v) => { A.commit('Pattern length'); p.len = +v; this.dirty = true; A.changed({ clips: true }); });
    const gridSel = K.select([[1, '1/4'], [0.5, '1/8'], [0.25, '1/16'], [0.125, '1/32'], [1 / 3, '1/8 T'], [1 / 6, '1/16 T']], this.grid, (v) => { this.grid = +v; this.dirty = true; });
    const fld = (lab, ctl) => h('div', { class: 'field' }, h('label', null, lab), ctl);
    const btn = (label, title, fn, cls) => h('button', { class: 'btn' + (cls ? ' ' + cls : ''), title, onclick: fn }, label);
    this.bRoll = btn('Roll', 'Piano roll', () => { this.mode = 'roll'; this.fitRows(); this.render(); }, this.mode === 'roll' ? 'on' : '');
    this.bSteps = btn('Steps', 'Step grid', () => { this.mode = 'steps'; this.fitRows(); this.render(); }, this.mode === 'steps' ? 'on' : '');
    this.bLoop = btn('▶ Loop', 'Loop this pattern (GrooveMatrix launch)', () => this.audition(), A.eng.matrix.active[t.id] && A.eng.matrix.active[t.id].pat === p.id ? 'on' : '');
    b.append(
      fld('TRACK', trSel), fld('PATTERN', patSel),
      h('div', { class: 'tgroup' }, btn('+ New', 'New pattern', () => { A.newPatternFor(t, false); this.render(); }), btn('Copy', 'Duplicate pattern', () => this.dupPattern()), btn('Rename', 'Rename pattern', () => this.renamePattern()), btn('Del', 'Delete pattern', () => this.delPattern())),
      fld('LENGTH', lenSel), fld('GRID', gridSel),
      h('div', { class: 'tgroup' }, this.bRoll, this.bSteps),
      h('div', { class: 'tgroup' }, btn('Quantize', 'Snap selected (or all) notes to the grid', () => this.quantize()), btn('−12', 'Octave down', () => this.transpose(-12)), btn('−1', 'Semitone down', () => this.transpose(-1)), btn('+1', 'Semitone up', () => this.transpose(1)), btn('+12', 'Octave up', () => this.transpose(12))),
      h('div', { class: 'tgroup' }, this.bLoop, btn('Place', 'Put this pattern on the timeline at the playhead', () => A.placePattern(t, p)), btn('Instrument', 'Edit the instrument', () => INSTUI.open(t), 'inv')),
    );
    this.renderKeys(t);
    this.size();
    if (changed) { this._lp = A.ui.pat; requestAnimationFrame(() => { this.size(); this.fitRows(); }); }
    this.dirty = true;
  },
  // playable keys (bottom): pads for drums, a piano for melodic instruments
  renderKeys(t) {
    const h = K.h, k = this.keys;
    k.textContent = '';
    if (t.inst.type === 'drums') {
      INST.PADS.forEach((n, i) => { const b = h('button', { class: 'pad', 'data-n': n }, INST.PAD_NAMES[i].toUpperCase()); this.bindKey(b, t, n); k.append(b); });
      return;
    }
    if (this.oct === undefined) this.oct = 4;
    const oc = h('div', { class: 'oct' }, h('button', { class: 'btn icon', 'aria-label': 'Octave down', onclick: () => { this.oct = Math.max(0, this.oct - 1); this.renderKeys(t); } }, '◀'), h('span', null, 'C' + this.oct), h('button', { class: 'btn icon', 'aria-label': 'Octave up', onclick: () => { this.oct = Math.min(8, this.oct + 1); this.renderKeys(t); } }, '▶'));
    const piano = h('div', { class: 'piano' });
    const span = innerWidth < 700 ? 1 : 2;
    for (let n = (this.oct + 1) * 12; n <= (this.oct + 1 + span) * 12; n++) {
      const black = [1, 3, 6, 8, 10].includes(n % 12);
      const key = h('button', { class: 'pk' + (black ? ' b' : ''), 'data-n': n, 'aria-label': INST.noteName(n) }, n % 12 === 0 ? INST.noteName(n) : '');
      this.bindKey(key, t, n); piano.append(key);
    }
    k.append(oc, piano);
  },
  bindKey(el, t, n) {
    const on = (e) => { e.preventDefault(); el.setPointerCapture && el.setPointerCapture(e.pointerId); el.classList.add('down'); A.eng.liveNote(t.id, true, n, this.defVel); this.held.set(e.pointerId, n); };
    const off = (e) => { if (!this.held.has(e.pointerId)) return; el.classList.remove('down'); A.eng.liveNote(t.id, false, n, 0); this.held.delete(e.pointerId); };
    el.addEventListener('pointerdown', on); el.addEventListener('pointerup', off); el.addEventListener('pointercancel', off); el.addEventListener('pointerleave', off);
  },
  // ---------- pattern management ----------
  async renamePattern() { const p = this.pat(); if (!p) return; const v = await K.prompt('Rename pattern', 'Name', p.name); if (v) { A.commit('Rename pattern'); p.name = v; A.changed({ clips: true }); this.render(); } },
  dupPattern() { const p = this.pat(); if (!p) return; A.commit('Duplicate pattern'); const n = JSON.parse(JSON.stringify(p)); n.id = U.uid('p'); n.name = p.name + ' copy'; A.proj.patterns[n.id] = n; A.ui.pat = n.id; A.changed({}); this.render(); },
  async delPattern() {
    const p = this.pat(); if (!p) return;
    const uses = A.proj.tracks.reduce((s, t) => s + t.clips.filter((c) => c.pat === p.id).length, 0);
    if (!(await K.confirm('Delete pattern', 'Delete “' + p.name + '”' + (uses ? ' and its ' + uses + ' clip(s) on the timeline' : '') + '? You can undo this.', 'Delete'))) return;
    A.commit('Delete pattern');
    delete A.proj.patterns[p.id];
    A.proj.tracks.forEach((t) => (t.clips = t.clips.filter((c) => c.pat !== p.id)));
    for (const id in A.proj.cells) A.proj.cells[id] = A.proj.cells[id].map((x) => (x === p.id ? null : x));
    A.ui.pat = null; A.changed({ clips: true }); this.render(); MTX.render();
  },
  audition() {
    const t = this.track(), p = this.pat(); if (!t || !p) return;
    const cur = A.eng.matrix.active[t.id];
    if (cur && cur.pat === p.id) { A.eng.stopCell(t.id); }
    else { A.eng.launch(t.id, p.id); if (!A.eng.playing) A.eng.play(); }
    setTimeout(() => this.render(), 50);
  },
  quantize() {
    const p = this.pat(); if (!p) return;
    A.commit('Quantize');
    const g = this.grid, list = this.sel.size ? p.notes.filter((n) => this.sel.has(n)) : p.notes;
    list.forEach((n) => { n.t = Math.round(n.t / g) * g; n.d = Math.max(g, Math.round(n.d / g) * g); if (n.t >= p.len) n.t -= p.len; });
    this.dirty = true; A.changed({ clips: true });
  },
  transpose(d) {
    const p = this.pat(); if (!p) return;
    A.commit('Transpose');
    (this.sel.size ? p.notes.filter((n) => this.sel.has(n)) : p.notes).forEach((n) => (n.n = U.clamp(n.n + d, 0, 127)));
    this.dirty = true; A.changed({ clips: true });
  },
  // ---------- geometry ----------
  rows() { // array of note numbers top→bottom
    if (this.isDrum()) { const p = this.pat(); const extra = p ? [...new Set(p.notes.map((n) => n.n))].filter((n) => !INST.PADS.includes(n)).sort((a, b) => b - a) : []; return INST.PADS.slice().concat(extra); }
    const r = []; for (let n = 108; n >= 21; n--) r.push(n); return r;
  },
  rowH() { return this.isDrum() ? (this.coarse() ? 46 : 34) : this.mode === 'steps' ? (this.coarse() ? 30 : 22) : (this.coarse() ? 24 : 16); },
  coarse() { return K.isTouch() || innerWidth < 700; },
  visRows() { return Math.floor((this.H - this.VELH) / this.rowH()); },
  size() {
    const w = this.wrap.clientWidth, hgt = this.wrap.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !hgt) return;
    this.W = w; this.H = hgt; this.KEYW = this.isDrum() ? (innerWidth < 700 ? 84 : 110) : (innerWidth < 700 ? 44 : 64);
    this.VELH = innerWidth < 700 ? 54 : 70;
    this.cv.width = Math.round(w * dpr); this.cv.height = Math.round(hgt * dpr); this.cv.style.width = w + 'px'; this.cv.style.height = hgt + 'px';
    const p = this.pat();
    if (p && !this.fitted) { this.fitted = true; this.fitX(); }
  },
  fitX() { const p = this.pat(); if (!p || !this.W) return; this.ppb = U.clamp((this.W - this.KEYW - 10) / p.len, 6, 600); this.sb = 0; this.dirty = true; },
  fitRows() {
    this.fitted = false; this.rh = this.rowH();
    const p = this.pat(), rows = this.rows();
    if (this.isDrum()) { this.top = 0; return; }
    let mid = 60; if (p && p.notes.length) mid = Math.round(p.notes.reduce((a, n) => a + n.n, 0) / p.notes.length);
    const idx = rows.indexOf(U.clamp(mid, 21, 108));
    const vr = this.H ? this.visRows() : 20;
    this.top = Math.max(0, idx - Math.floor(vr / 2));
    this.size(); this.fitX();
  },
  zoom(f) { const p = this.pat(); const minPpb = p ? (this.W - this.KEYW) / Math.max(4, p.len * 4) : 6; this.ppb = U.clamp(this.ppb * f, Math.max(4, minPpb), 800); this.dirty = true; },
  bToX(b) { return this.KEYW + (b - this.sb) * this.ppb; },
  xToB(x) { return this.sb + (x - this.KEYW) / this.ppb; },
  rowAt(y) { const r = Math.floor(y / this.rowH() + this.top); const rows = this.rows(); return r >= 0 && r < rows.length ? rows[r] : null; },
  rowY(n) { const i = this.rows().indexOf(n); return i < 0 ? null : (i - this.top) * this.rowH(); },
  snap(b, e) { return e && e.altKey ? b : Math.floor(b / this.grid + 1e-6) * this.grid; },
  noteAt(x, y) {
    const p = this.pat(); if (!p) return null;
    const n = this.rowAt(y), b = this.xToB(x); if (n === null) return null;
    for (let i = p.notes.length - 1; i >= 0; i--) { const nt = p.notes[i]; if (nt.n === n && b >= nt.t - 1e-6 && b <= nt.t + nt.d + 1e-6) return nt; }
    return null;
  },
  // ---------- pointer ----------
  pos(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; },
  down(e) {
    const p = this.pat(); if (!p) return;
    this.cv.focus({ preventScroll: true });
    const touch = e.pointerType !== 'mouse';
    if (touch) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size === 2) { this.drag = null; const [a, b] = [...this.touches.values()]; this.pinch = { d0: Math.abs(a.x - b.x) || 1, ppb0: this.ppb, b: this.xToB(((a.x + b.x) / 2) - this.cv.getBoundingClientRect().left), sb0: this.sb, top0: this.top, y0: (a.y + b.y) / 2 }; return; }
    }
    this.cv.setPointerCapture(e.pointerId);
    const { x, y } = this.pos(e);
    if (y > this.H - this.VELH) { A.commit('Velocity'); this.drag = { kind: 'vel' }; this.velAt(x, y); return; }
    if (x < this.KEYW) { const n = this.rowAt(y); if (n !== null) { A.eng.liveNote(this.track().id, true, n, this.defVel); this.drag = { kind: 'key', n }; } return; }
    const nt = this.noteAt(x, y);
    const edge = touch ? 14 : 7;
    if (nt) {
      const xe = this.bToX(nt.t + nt.d);
      if (!this.sel.has(nt)) { if (!e.shiftKey) this.sel.clear(); this.sel.add(nt); }
      const resize = Math.abs(x - xe) < edge && this.mode === 'roll';
      this.drag = { kind: resize ? 'resize' : 'move', nt, x0: x, y0: y, b0: nt.t, n0: nt.n, d0: nt.d, moved: false, touch, items: [...this.sel].map((q) => ({ q, t: q.t, n: q.n, d: q.d })) };
      A.eng.liveNote(this.track().id, true, nt.n, nt.v); setTimeout(() => A.eng.liveNote(this.track().id, false, nt.n, 0), 160);
    } else {
      if (!e.shiftKey) this.sel.clear();
      const n = this.rowAt(y); if (n === null) return;
      const b = Math.max(0, this.snap(this.xToB(x), e)); if (b >= p.len) return;
      A.commit('Add note');
      const d = this.mode === 'steps' || this.isDrum() ? this.grid : this.lastLen;
      const nt2 = { t: b, d: Math.min(d, p.len - b), n, v: this.defVel };
      p.notes.push(nt2); this.sel.add(nt2);
      A.eng.liveNote(this.track().id, true, n, nt2.v); setTimeout(() => A.eng.liveNote(this.track().id, false, n, 0), 160);
      this.drag = { kind: 'new', nt: nt2, x0: x, b0: b, moved: false, touch, created: true };
    }
    this.dirty = true;
  },
  move(e) {
    if (this.pinch && this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.touches.size < 2) return;
      const [a, b] = [...this.touches.values()], rect = this.cv.getBoundingClientRect(), cx = (a.x + b.x) / 2 - rect.left;
      this.ppb = U.clamp(this.pinch.ppb0 * (Math.abs(a.x - b.x) || 1) / this.pinch.d0, 4, 800);
      this.sb = Math.max(0, this.pinch.b - (cx - this.KEYW) / this.ppb);
      this.top = U.clamp(this.pinch.top0 - ((a.y + b.y) / 2 - this.pinch.y0) / this.rowH(), 0, Math.max(0, this.rows().length - this.visRows()));
      this.dirty = true; return;
    }
    const d = this.drag; if (!d) return;
    const { x, y } = this.pos(e), p = this.pat();
    if (d.kind === 'vel') { this.velAt(x, y); return; }
    if (d.kind === 'key') return;
    if (!d.moved && Math.abs(x - d.x0) < (d.touch ? 8 : 3) && Math.abs(y - (d.y0 || y)) < (d.touch ? 8 : 3)) return;
    if (!d.moved) { d.moved = true; if (!d.created) A.commit(d.kind === 'resize' ? 'Resize note' : 'Move notes'); }
    if (d.kind === 'new') { const end = Math.max(d.b0 + this.grid, this.snap(this.xToB(x), e) + this.grid); d.nt.d = Math.min(end, p.len) - d.b0; this.lastLen = d.nt.d; }
    else if (d.kind === 'resize') { const end = Math.max(d.b0 + Math.min(this.grid, 0.05), this.snap(this.xToB(x) + this.grid / 2, e)); d.nt.d = Math.max(0.03, Math.min(p.len, end) - d.nt.t); this.lastLen = d.nt.d; }
    else if (d.kind === 'move') {
      const db = this.snap(this.xToB(x) - this.xToB(d.x0) + this.grid / 2, e);
      const rows = this.rows(), r0 = rows.indexOf(d.n0), r1 = Math.floor(y / this.rowH() + this.top), dr = this.isDrum() ? 0 : r1 - r0;
      const nr = this.isDrum() ? this.rowAt(y) : null;
      for (const it of d.items) {
        it.q.t = U.clamp(it.t + db, 0, p.len - 0.01);
        if (this.isDrum()) { if (d.items.length === 1 && nr !== null) it.q.n = nr; }
        else { const ri = U.clamp(rows.indexOf(it.n) + dr, 0, rows.length - 1); it.q.n = rows[ri]; }
      }
    }
    this.dirty = true;
  },
  up(e, cancel) {
    if (this.touches.has(e.pointerId)) { this.touches.delete(e.pointerId); if (this.pinch) { if (this.touches.size < 2) { this.pinch = null; this.touches.clear(); } return; } }
    const d = this.drag; this.drag = null; if (!d) return;
    if (d.kind === 'key') { A.eng.liveNote(this.track().id, false, d.n, 0); return; }
    if (cancel) return;
    // a tap on an existing note (no drag) deletes it on touch screens and in the step grid
    if ((d.kind === 'move' || d.kind === 'resize') && !d.moved && (d.touch || this.mode === 'steps')) { A.commit('Delete note'); this.deleteNotes([d.nt]); }
    this.dirty = true; A.changed({ clips: true });
  },
  dbl(e) { const { x, y } = this.pos(e), nt = this.noteAt(x, y); if (nt) { A.commit('Delete note'); this.deleteNotes([nt]); A.changed({ clips: true }); } },
  rclick(e) { const { x, y } = this.pos(e), nt = this.noteAt(x, y); if (nt) { A.commit('Delete note'); this.deleteNotes([nt]); A.changed({ clips: true }); } },
  deleteNotes(list) { const p = this.pat(); const s = new Set(list); p.notes = p.notes.filter((n) => !s.has(n)); list.forEach((n) => this.sel.delete(n)); this.dirty = true; },
  velAt(x, y) {
    const p = this.pat(), v = U.clamp(1 - (y - (this.H - this.VELH) - 6) / (this.VELH - 12), 0.05, 1), b = this.xToB(x);
    const hits = p.notes.filter((n) => Math.abs(this.bToX(n.t) - x) < Math.max(4, this.ppb * this.grid / 2));
    (hits.length ? hits : []).forEach((n) => { if (!this.sel.size || this.sel.has(n) || hits.length === 1) n.v = v; });
    this.defVel = v; void b;
    this.dirty = true;
  },
  keydown(e) {
    const p = this.pat(); if (!p) return false;
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel.size) { A.commit('Delete notes'); this.deleteNotes([...this.sel]); A.changed({ clips: true }); return true; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { this.sel = new Set(p.notes); this.dirty = true; return true; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { if (!this.sel.size) return false; A.commit('Transpose', true); this.sel.forEach((n) => (n.n = U.clamp(n.n + (e.key === 'ArrowUp' ? 1 : -1) * (e.shiftKey ? 12 : 1), 0, 127))); this.dirty = true; A.changed({ clips: true }); return true; }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { if (!this.sel.size) return false; A.commit('Nudge notes', true); this.sel.forEach((n) => (n.t = U.clamp(n.t + (e.key === 'ArrowRight' ? 1 : -1) * this.grid, 0, p.len - 0.01))); this.dirty = true; A.changed({ clips: true }); return true; }
    return false;
  },
  // ---------- drawing ----------
  draw() {
    const p = this.pat(), T = ARR.T; if (!p || !T || !this.W) return;
    const g = this.cv.getContext('2d'), dpr = window.devicePixelRatio || 1, W = this.W, H = this.H, KW = this.KEYW, rh = this.rowH(), VH = this.VELH;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = T.surface; g.fillRect(0, 0, W, H);
    const rows = this.rows(), gh = H - VH, drum = this.isDrum();
    // rows
    for (let i = Math.floor(this.top); i < rows.length; i++) {
      const y = (i - this.top) * rh; if (y > gh) break; if (y + rh < 0) continue;
      const n = rows[i], black = !drum && [1, 3, 6, 8, 10].includes(n % 12);
      g.fillStyle = black ? T.laneB : T.laneA; g.fillRect(KW, y, W - KW, rh);
      g.fillStyle = (n % 12 === 0 && !drum) || drum ? T.line : T.grid2; g.fillRect(KW, y + rh - 1, W - KW, (n % 12 === 0 && !drum) ? 1.5 : 1);
    }
    // beyond the pattern end
    const xe = this.bToX(p.len); if (xe < W) { g.fillStyle = T.surface2; g.fillRect(Math.max(KW, xe), 0, W - xe, gh); ARR.hatch(g, Math.max(KW, xe), 0, W - xe, gh, T.grid2, 10); }
    // grid
    const b0 = Math.max(0, Math.floor(this.sb)), b1 = this.xToB(W), bpb = A.proj.sig[0];
    if (this.grid * this.ppb >= 6) { g.fillStyle = T.grid; for (let b = Math.ceil(this.sb / this.grid) * this.grid; b <= b1; b += this.grid) g.fillRect(Math.round(this.bToX(b)), 0, 1, gh); }
    for (let b = b0; b <= b1; b++) { g.fillStyle = b % bpb === 0 ? T.line : T.grid2; g.fillRect(Math.round(this.bToX(b)), 0, b % bpb === 0 ? 2 : 1, gh); }
    // notes
    for (const nt of p.notes) {
      const y = this.rowY(nt.n); if (y === null || y < -rh || y > gh) continue;
      const x1 = Math.round(this.bToX(nt.t)), x2 = Math.round(this.bToX(nt.t + nt.d)); if (x2 < KW || x1 > W) continue;
      const sel = this.sel.has(nt);
      g.fillStyle = sel ? T.acc : T.text; g.fillRect(Math.max(KW, x1), y + 1, Math.max(3, x2 - Math.max(KW, x1) - 1), rh - 2);
      // velocity as an inner bar
      g.fillStyle = T.bg; g.fillRect(Math.max(KW, x1) + 2, y + rh - 4, Math.max(1, (x2 - Math.max(KW, x1) - 5) * nt.v), 2);
      if (!drum && rh >= 16 && x2 - x1 > 28) { g.fillStyle = T.bg; g.font = ARR.FONT; g.textBaseline = 'middle'; g.fillText(INST.noteName(nt.n), Math.max(KW, x1) + 4, y + rh / 2 - 1); }
    }
    // keys / pad names column
    g.fillStyle = T.surface; g.fillRect(0, 0, KW, gh);
    for (let i = Math.floor(this.top); i < rows.length; i++) {
      const y = (i - this.top) * rh; if (y > gh) break; if (y + rh < 0) continue;
      const n = rows[i];
      if (drum) { const pi = INST.PADS.indexOf(n); g.fillStyle = T.text; g.font = ARR.FONT; g.textBaseline = 'middle'; g.fillText(pi >= 0 ? INST.PAD_NAMES[pi].toUpperCase() : INST.noteName(n), 8, y + rh / 2); }
      else {
        const black = [1, 3, 6, 8, 10].includes(n % 12);
        g.fillStyle = black ? T.text : T.surface; g.fillRect(0, y, black ? KW * 0.62 : KW, rh);
        if (n % 12 === 0) { g.fillStyle = T.text; g.font = ARR.FONT; g.textBaseline = 'middle'; g.fillText(INST.noteName(n), KW - 30, y + rh / 2); }
      }
      g.fillStyle = T.grid2; g.fillRect(0, y + rh - 1, KW, 1);
    }
    g.fillStyle = T.line; g.fillRect(KW - 2, 0, 2, gh);
    // velocity lane
    g.fillStyle = T.surface2; g.fillRect(0, gh, W, VH);
    g.fillStyle = T.line; g.fillRect(0, gh, W, 2);
    g.fillStyle = T.text; g.font = ARR.FONT; g.textBaseline = 'middle'; g.fillText('VELOCITY', 8, gh + VH / 2);
    for (const nt of p.notes) { const x = Math.round(this.bToX(nt.t)); if (x < KW || x > W) continue; const hh = (VH - 12) * nt.v; g.fillStyle = this.sel.has(nt) ? T.acc : T.text; g.fillRect(x, gh + VH - 4 - hh, Math.max(3, Math.min(10, this.ppb * this.grid * 0.6)), hh); }
    // bar numbers
    g.fillStyle = T.muted; g.font = ARR.FONT; g.textBaseline = 'top';
    for (let b = Math.ceil(this.sb / bpb) * bpb; b <= Math.min(b1, p.len); b += bpb) g.fillText(String(b / bpb + 1), Math.round(this.bToX(b)) + 4, 3);
    this.dirty = false;
  },
  // where is this pattern playing right now? (in beats within the pattern)
  playPos() {
    const t = this.track(), p = this.pat(); if (!t || !p || !A.eng.playing) return null;
    const pos = A.eng.pos(), beat = A.eng.beat(), per = p.len * beat, mx = A.eng.matrix.active[t.id];
    if (mx) { if (mx.pat !== p.id || pos < mx.from) return null; return ((pos - mx.from) % per) / beat; }
    for (const c of t.clips) if (c.pat === p.id && pos >= c.start && pos < c.start + c.len) return (((pos - c.start + c.off) % per) + per) % per / beat;
    return null;
  },
  frame() {
    if (!this.shown()) return;
    if (this.dirty) this.draw();
    const pp = this.playPos();
    if (pp !== null || this._pp !== null) { this.draw(); if (pp !== null) { const g = this.cv.getContext('2d'), x = Math.round(this.bToX(pp)); g.fillStyle = A.eng.recording ? ARR.T.acc : ARR.T.text; g.fillRect(x - 1, 0, 2, this.H - this.VELH); } }
    this._pp = pp;
  },
  noteFlash(n, on) { const el = this.keys.querySelector('[data-n="' + n + '"]'); if (el) el.classList.toggle('down', on); },
};

// ---------- instrument panel ----------
const INSTUI = {
  open(t) {
    const h = K.h, inst = t.inst;
    const body = h('div', { class: 'in-body' });
    const draw = () => {
      body.textContent = '';
      const typeSeg = h('div', { class: 'sh-seg' }, ...Object.keys(INST.TYPES).map((k) => {
        const b = h('button', { class: 'act' + (inst.type === k ? ' on' : '') }, INST.TYPES[k]);
        b.addEventListener('click', () => { if (inst.type === k) return; A.commit('Instrument type'); const n = INST.make(k); Object.assign(inst, n); A.eng.graph.instParams(t); A.changed({ heads: true, console: true }); PAT.render(); draw(); });
        return b;
      }));
      body.append(h('div', { class: 'sh-sub' }, 'Instrument'), typeSeg);
      if (inst.type === 'synth') this.synth(t, body, draw);
      else if (inst.type === 'drums') this.drums(t, body, draw);
      else this.sampler(t, body, draw);
    };
    draw();
    if (K.isTouch() || innerWidth < 900) K.sheet('Instrument · ' + t.name, body, [{ label: 'Done', primary: true }], { light: true });
    else K.dialog('Instrument · ' + t.name, body, [{ label: 'Done', primary: true }], { width: 'min(860px, 96vw)' });
  },
  knobs(t, obj, spec, apply) {
    const h = K.h, wrap = h('div', { class: 'in-sec' });
    for (const [title, items] of spec) {
      const row = h('div', { class: 'in-row' });
      for (const [k, label, s] of items) {
        if (s.opts) {
          const seg = h('div', { class: 'in-opt' }, h('label', null, label));
          s.opts.forEach((o, i) => { const b = h('button', { class: 'mini' + (obj[k] === o ? ' on' : '') }, s.lab ? s.lab[i] : String(o)); b.addEventListener('click', () => { A.commit(label, true); obj[k] = o; seg.querySelectorAll('.mini').forEach((x, j) => x.classList.toggle('on', s.opts[j] === obj[k])); apply(); A.save(); }); seg.append(b); });
          row.append(seg);
        } else {
          row.append(K.knob(Object.assign({ n: label }, s, { get: () => obj[k], begin: () => A.commit(label, true), set: (v, fin) => { obj[k] = s.step ? Math.round(v / s.step) * s.step : v; apply(); if (fin) A.save(); } })));
        }
      }
      wrap.append(h('div', { class: 'in-grp' }, h('div', { class: 'in-t' }, title), row));
    }
    return wrap;
  },
  synth(t, body) {
    const h = K.h, inst = t.inst, apply = () => A.eng.graph.instParams(t);
    const pre = K.select(INST.SYNTH_PRESETS.map((x, i) => [i, x[0]]).concat(inst.preset < 0 ? [[-1, 'Custom']] : []), inst.preset, (v) => { A.commit('Preset'); inst.preset = +v; inst.p = Object.assign(INST.synthDefault(), JSON.parse(JSON.stringify(INST.SYNTH_PRESETS[+v][1]))); apply(); INSTUI.open(t); });
    body.append(h('div', { class: 'sh-sub' }, 'Preset'), K.row('Sound', pre), this.knobs(t, inst.p, INST.SYNTH_UI, () => { inst.preset = inst.preset; apply(); }), this.playRow(t));
  },
  drums(t, body, redraw) {
    const h = K.h, inst = t.inst, apply = () => A.eng.graph.instParams(t);
    const kit = K.select(INST.KITS.map((x, i) => [i, x[0]]), inst.p.kit, (v) => { A.commit('Drum kit'); inst.p.kit = +v; inst.p.pads = INST.kitPads(+v); apply(); redraw(); });
    body.append(h('div', { class: 'sh-sub' }, 'Kit'), K.row('Kit', kit), K.row('Volume', K.knob({ n: 'Volume', min: -30, max: 6, def: -2, u: 'dB', get: () => inst.p.vol, begin: () => A.commit('Drum volume', true), set: (v, fin) => { inst.p.vol = v; apply(); if (fin) A.save(); } })));
    if (this.pad === undefined) this.pad = 0;
    const tabs = h('div', { class: 'in-pads' }, ...INST.PADS.map((n, i) => { const b = h('button', { class: 'pad' + (this.pad === i ? ' on' : '') }, INST.PAD_NAMES[i].toUpperCase() + (inst.padSamples && inst.padSamples[n] ? ' ◼' : '')); b.addEventListener('pointerdown', () => { A.eng.liveNote(t.id, true, n, 0.9); }); b.addEventListener('click', () => { this.pad = i; redraw(); }); return b; }));
    const pp = inst.p.pads[this.pad], n = INST.PADS[this.pad];
    const smpName = inst.padSamples && inst.padSamples[n] && A.eng.buffers.get(inst.padSamples[n]) ? A.eng.buffers.get(inst.padSamples[n]).name : null;
    body.append(h('div', { class: 'sh-sub' }, 'Pads — tap to play, pick one to edit'), tabs,
      this.knobs(t, pp, [[INST.PAD_NAMES[this.pad].toUpperCase(), INST.PAD_UI.map(([k, l, s]) => [k, l, s])]], apply),
      h('div', { class: 'in-row' },
        h('button', { class: 'btn', onclick: async () => { const id = await this.loadSample(); if (id) { A.commit('Pad sample'); inst.padSamples = inst.padSamples || {}; inst.padSamples[n] = id; apply(); A.save(); redraw(); } } }, smpName ? 'Replace sample' : 'Load a sample on this pad'),
        smpName ? h('span', { class: 'in-note' }, smpName) : h('span', { class: 'in-note' }, 'Synthesised'),
        smpName ? h('button', { class: 'btn', onclick: () => { A.commit('Pad sample'); delete inst.padSamples[n]; apply(); A.save(); redraw(); } }, 'Back to synth') : null));
  },
  sampler(t, body, redraw) {
    const h = K.h, inst = t.inst, apply = () => A.eng.graph.instParams(t);
    const b = inst.sample && A.eng.buffers.get(inst.sample);
    body.append(h('div', { class: 'sh-sub' }, 'Sample'), h('div', { class: 'in-row' },
      h('button', { class: 'btn on', onclick: async () => { const id = await this.loadSample(); if (id) { A.commit('Sampler sample'); inst.sample = id; apply(); A.save(); redraw(); } } }, b ? 'Replace sample' : 'Load a sample'),
      h('span', { class: 'in-note' }, b ? b.name + ' · ' + b.ab.duration.toFixed(2) + ' s' : 'No sample loaded — WAV, MP3, OGG, FLAC, M4A')),
    this.knobs(t, inst.p, INST.SAMPLER_UI, apply), this.playRow(t));
  },
  playRow(t) { const h = K.h; return h('div', { class: 'in-row' }, h('button', { class: 'btn', onclick: () => { A.eng.liveNote(t.id, true, 60, 0.8); setTimeout(() => A.eng.liveNote(t.id, false, 60, 0), 500); } }, 'Play C4'), h('button', { class: 'btn', onclick: () => { [60, 64, 67].forEach((n) => A.eng.liveNote(t.id, true, n, 0.7)); setTimeout(() => [60, 64, 67].forEach((n) => A.eng.liveNote(t.id, false, n, 0)), 900); } }, 'Play chord')); },
  async loadSample() {
    const f = (await U.pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff'))[0]; if (!f) return null;
    try { const ab = await A.eng.decodeFile(f); return A.eng.addBuffer(ab, f.name.replace(/\.[^.]+$/, '')); } catch (e) { K.toast('Could not read ' + f.name); return null; }
  },
};
