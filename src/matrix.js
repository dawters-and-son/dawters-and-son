// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — GrooveMatrix: launch patterns per track and per scene, quantized to the bar
'use strict';
const MTX = {
  init() {
    this.view = document.getElementById('matrix');
    A.eng.on('matrix', () => this.paint());
    // record launches into the arrangement while the transport rolls
    A.eng.onMatrixRec = (trackId, cur, until) => {
      if (!A.proj.matrixRec || !A.eng.playing || until <= cur.from + 0.01) return;
      const t = A.proj.tracks.find((x) => x.id === trackId), p = A.proj.patterns[cur.pat]; if (!t || !p) return;
      A.commit('Matrix record', true);
      t.clips.push({ id: U.uid('c'), pat: p.id, start: cur.from, off: 0, len: until - cur.from, gain: 1, fi: 0, fo: 0, name: p.name });
      A.changed({ clips: true });
    };
  },
  shown() { return this.view.classList.contains('show'); },
  cells(t) { const P = A.proj; const c = P.cells[t.id] || (P.cells[t.id] = []); while (c.length < P.scenes) c.push(null); return c; },
  render() {
    const h = K.h, v = this.view, P = A.proj;
    v.textContent = '';
    const tracks = P.tracks.filter((t) => t.kind === 'inst');
    const bar = h('div', { class: 'mx-bar' },
      h('button', { class: 'btn' + (P.matrixRec ? ' on rec' : ''), title: 'Write every launch into the arrangement while playing', onclick: () => { P.matrixRec = !P.matrixRec; A.save(); this.render(); } }, (P.matrixRec ? '● ' : '○ ') + 'Rec to arrangement'),
      h('button', { class: 'btn', title: 'Stop every pattern and go back to the arrangement', onclick: () => A.eng.matrixClear() }, '■ Stop all · back to arrangement'),
      h('button', { class: 'btn', onclick: () => { A.commit('Add scene'); P.scenes++; this.render(); A.save(); } }, '+ Scene'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'mx-note' }, 'Launches start on the next bar.'));
    v.append(bar);
    if (!tracks.length) {
      v.append(h('div', { class: 'pt-empty', style: 'display:block' }, h('b', null, 'No instrument tracks.'), h('div', null, 'The GrooveMatrix launches patterns on instrument tracks.'),
        h('div', { class: 'pt-new' }, ...Object.keys(INST.TYPES).map((k) => h('button', { class: 'btn', onclick: () => { A.addInstTrack(k); this.render(); } }, '+ ' + INST.TYPES[k])))));
      return;
    }
    const grid = h('div', { class: 'mx-grid', style: 'grid-template-columns: 64px repeat(' + tracks.length + ', minmax(130px, 1fr))' });
    grid.append(h('div', { class: 'mx-corner' }, 'SCENE'));
    tracks.forEach((t) => {
      const head = h('div', { class: 'mx-head', style: '--tc:' + t.color },
        h('button', { class: 'mx-name', onclick: () => { A.ui.patTrack = t.id; A.setView('pattern'); } }, t.name),
        h('button', { class: 'mx-stop', title: 'Stop this track', 'aria-label': 'Stop ' + t.name, 'data-stop': t.id, onclick: () => A.eng.stopCell(t.id) }, '■'));
      grid.append(head);
    });
    for (let s = 0; s < P.scenes; s++) {
      grid.append(h('button', { class: 'mx-scene', title: 'Launch scene ' + (s + 1), onclick: () => this.launchScene(s) }, '▶ ' + (s + 1)));
      tracks.forEach((t) => {
        const pid = this.cells(t)[s], p = pid && P.patterns[pid];
        const cell = h('button', { class: 'mx-cell' + (p ? '' : ' empty'), 'data-t': t.id, 'data-s': s, 'data-p': p ? p.id : '' }, p ? h('span', null, p.name) : '+', p ? h('i', { class: 'mx-prog' }) : null);
        cell.addEventListener('click', () => this.tap(t, s));
        cell.addEventListener('contextmenu', (e) => { e.preventDefault(); this.menu(t, s, e); });
        let lp = null;
        cell.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') lp = setTimeout(() => { lp = 'fired'; this.menu(t, s, e); }, 520); });
        cell.addEventListener('pointerup', () => { if (lp && lp !== 'fired') clearTimeout(lp); });
        cell.addEventListener('click', (e) => { if (lp === 'fired') { e.stopImmediatePropagation(); lp = null; } }, true);
        grid.append(cell);
      });
    }
    v.append(h('div', { class: 'mx-scroll' }, grid));
    this.paint();
  },
  tap(t, s) {
    const pid = this.cells(t)[s];
    if (!pid || !A.proj.patterns[pid]) return this.menu(t, s);
    const cur = A.eng.matrix.active[t.id], q = A.eng.matrix.queue[t.id];
    if ((cur && cur.pat === pid && cur.until === undefined && !q) || (q && q.pat === pid)) A.eng.stopCell(t.id);
    else { A.eng.launch(t.id, pid); if (!A.eng.playing) A.eng.play(); }
    this.paint();
  },
  launchScene(s) {
    const tracks = A.proj.tracks.filter((t) => t.kind === 'inst');
    for (const t of tracks) { const pid = this.cells(t)[s]; if (pid && A.proj.patterns[pid]) A.eng.launch(t.id, pid); else if (A.eng.matrix.active[t.id]) A.eng.stopCell(t.id); }
    if (!A.eng.playing) A.eng.play();
    this.paint();
  },
  menu(t, s, e) {
    const P = A.proj, pid = this.cells(t)[s], pats = Object.values(P.patterns).filter((p) => p.track === t.id);
    const items = [{ head: t.name + ' · scene ' + (s + 1) }];
    items.push({ label: 'New pattern here', act: () => { const p = A.newPatternFor(t, false); this.assign(t, s, p.id); A.ui.patTrack = t.id; A.ui.pat = p.id; A.setView('pattern'); } });
    if (pid) items.push({ label: 'Edit this pattern', act: () => { A.ui.patTrack = t.id; A.ui.pat = pid; A.setView('pattern'); } }, { label: 'Clear cell', act: () => this.assign(t, s, null) });
    if (pats.length) { items.push({ head: 'Use a pattern' }); pats.forEach((p) => items.push({ label: p.name, check: p.id === pid, act: () => this.assign(t, s, p.id) })); }
    const r = e && e.clientX !== undefined ? e : { clientX: innerWidth / 2 - 120, clientY: innerHeight / 3 };
    K.menu(items, r.clientX, r.clientY);
  },
  assign(t, s, pid) { A.commit('Matrix cell'); this.cells(t)[s] = pid; A.save(); this.render(); },
  paint() {
    if (!this.shown()) return;
    const E = A.eng;
    this.view.querySelectorAll('.mx-cell').forEach((c) => {
      const tid = c.dataset.t, pid = c.dataset.p, cur = E.matrix.active[tid], q = E.matrix.queue[tid];
      c.classList.toggle('play', !!(pid && cur && cur.pat === pid && cur.until === undefined));
      c.classList.toggle('queued', !!(pid && q && q.pat === pid));
      c.classList.toggle('ending', !!(pid && cur && cur.pat === pid && cur.until !== undefined));
    });
  },
  frame() {
    if (!this.shown()) return;
    const E = A.eng, pos = E.pos(), beat = E.beat();
    this.view.querySelectorAll('.mx-cell.play .mx-prog, .mx-cell.ending .mx-prog').forEach((i) => {
      const c = i.parentElement, cur = E.matrix.active[c.dataset.t], p = A.proj.patterns[c.dataset.p];
      if (!cur || !p || !E.playing || pos < cur.from) { i.style.width = '0'; return; }
      i.style.width = (((pos - cur.from) % (p.len * beat)) / (p.len * beat) * 100) + '%';
    });
    if (this._q !== Object.keys(E.matrix.queue).length + '|' + Object.keys(E.matrix.active).length) { this._q = Object.keys(E.matrix.queue).length + '|' + Object.keys(E.matrix.active).length; this.paint(); }
  },
};
