// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — application controller
'use strict';
const PLAT = {
  kind: window.dawNative ? 'electron' : window.DawAndroid ? 'android' : 'web',
  async save(name, blob) {
    if (this.kind === 'electron') {
      const ab = await blob.arrayBuffer();
      const r = await window.dawNative.saveFile(name, ab);
      return r ? 'Saved ' + r : null;
    }
    if (this.kind === 'android') {
      const u8 = new Uint8Array(await blob.arrayBuffer());
      const id = window.DawAndroid.begin(name);
      if (id < 0) throw new Error('Could not create the file on this device');
      const CH = 3 * 256 * 1024;
      for (let i = 0; i < u8.length; i += CH) {
        const part = u8.subarray(i, Math.min(u8.length, i + CH));
        let s = ''; for (let k = 0; k < part.length; k += 32768) s += String.fromCharCode.apply(null, part.subarray(k, k + 32768));
        window.DawAndroid.append(id, btoa(s));
        if ((i / CH) % 8 === 7) await new Promise((r) => setTimeout(r, 0));
      }
      const path = window.DawAndroid.finish(id);
      return path ? 'Saved to ' + path : null;
    }
    U.download(blob, name); return 'Downloaded ' + name;
  },
};

const A = {
  ui: { sel: new Set(), range: null, selTrack: null, snap: 'beat', follow: true, view: 'tracks', kmeter: 'peak', lcdBars: true },
  history: new M.History(), clipboard: null, lastCommit: { label: '', t: 0 },
  async boot() {
    this.settings = Object.assign({ latency: 'interactive', click: false, countIn: true, theme: 'day', recNudgeMs: 0, recLatCal: null, clickVol: 0.5, follow: true }, JSON.parse(localStorage.getItem('dawters.settings') || '{}'));
    document.documentElement.dataset.theme = this.settings.theme === 'night' ? 'night' : 'day';
    document.documentElement.dataset.grain = this.settings.grain === false ? 'off' : 'on';
    this.titleCard();
    this.ui.snap = localStorage.getItem('dawters.snap') || 'beat';
    this.ui.kmeter = localStorage.getItem('dawters.kmeter') || 'peak';
    this.ui.follow = this.settings.follow;
    this.buildChrome();
    ARR.init(); CON.init(); DECK.init(); PAT.init();
    ARR.corner.append(K.h('div', { class: 'field', title: 'Snap grid (hold Alt while dragging to ignore)' }, K.h('label', null, 'SNAP'), this.el.snap));
    ARR.theme();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { ARR.dirty = true; DECK.render(); });
    this.eng = new Engine();
    await this.eng.init(this.settings);
    // VST3 plug-ins (desktop builds): ready before the song loads, so its plug-ins start with it
    try { await Promise.race([PLUG.init(), new Promise((r) => setTimeout(r, 4000))]); } catch (e) { console.warn('plug-ins unavailable', e); }
    this.eng.clickOut.gain.value = this.settings.clickVol;
    this.eng.on('state', () => this.syncTransport());
    this.eng.on('take', (list) => this.applyTake(list));
    this.eng.on('midiTake', (m) => this.applyMidiTake(m));
    this.eng.on('note', (m) => PAT.noteFlash(m.n, m.on));
    this.eng.midiTarget = () => { const P = this.proj, arm = P.tracks.find((t) => t.kind === 'inst' && t.arm); if (arm) return arm.id; if (this.ui.view === 'pattern' && PAT.track()) return PAT.track().id; const s = this.sel(); return s && s.kind === 'inst' ? s.id : (P.tracks.find((t) => t.kind === 'inst') || {}).id; };
    MTX.init();
    document.addEventListener('pointerdown', () => this.eng.initMidi(), { once: true });
    this.eng.on('input', () => this.syncTransport());
    let p = null;
    try { const s = await U.idb.get('kv', 'project'); if (s) p = JSON.parse(s); } catch (e) { console.warn(e); }
    if (p && p.v === 1) {
      M.migrate(p); const need = M.bufRefs(p);
      let missing = 0;
      for (const id of need) { try { if (!(await this.eng.loadBufferFromDb(id))) missing++; } catch (e) { missing++; } }
      p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => !c.buf || this.eng.buffers.has(c.buf))));
      if (missing) setTimeout(() => K.toast(missing + ' audio file(s) could not be restored'), 800);
      this.gcBuffers(need);
    } else p = M.newProject(this.eng.sr);
    this.load(p, true);
    const small = window.matchMedia('(pointer: coarse)').matches || innerWidth < 900;
    this.setView(localStorage.getItem('dawters.view') || (small ? 'deck' : 'tracks'));
    // the tuner can be opened on its own: index.html#tuner (and the Android "D&S Tuner" icon)
    // Listen for Capture: the browser only opens the input after a click or key, so wait for the first one
    if (this.settings.capListen) { const go = () => { window.removeEventListener('pointerdown', go, true); window.removeEventListener('keydown', go, true); this.eng.openInput().catch(() => {}); }; window.addEventListener('pointerdown', go, true); window.addEventListener('keydown', go, true); }
    this.listenSuite();
    if (location.hash === '#tuner') setTimeout(() => TUNER.open(true), 300); else if (location.hash !== '#receive') setTimeout(() => this.firstRun(), 1200);
    window.addEventListener('hashchange', () => { if (location.hash === '#tuner') TUNER.open(true); });
    this.keys();
    this.dropZone();
    const loop = () => { try { this.frame(); } catch (e) { console.error(e); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    if (window.dawNative && window.dawNative.onMenu) window.dawNative.onMenu((c) => this.cmd(c));
    if (window.dawNative && window.dawNative.onOpenFile) window.dawNative.onOpenFile((name, data) => this.openProject(new File([data], name)));
    window.addEventListener('beforeunload', () => this.saveNow());
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveNow(); });
    const resume = () => { if (this.eng.ctx.state !== 'running') this.eng.ctx.resume(); };
    document.addEventListener('pointerdown', resume, { once: true }); document.addEventListener('keydown', resume, { once: true });
    this.status('Ready — ' + Math.round(this.eng.sr / 100) / 10 + ' kHz · ' + (PLAT.kind === 'electron' ? 'Mac app' : PLAT.kind === 'android' ? 'Android' : 'Browser'));
  },
  async gcBuffers(keep) { try { const ks = await U.idb.keys('buffers'); for (const k of ks) if (!keep.has(k)) await U.idb.del('buffers', k); } catch (e) { /* */ } },
  load(p, first) {
    this.proj = M.migrate(p);
    this.ui.sel = new Set(); this.ui.range = null;
    this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    this.eng.setProject(p);
    if (!first) this.history.clear();
    this.refreshAll();
  },
  refreshAll() {
    ARR.renderHeads(); ARR.layout(); CON.render(); DECK.render(); this.syncTransport(); this.inspector();
    this.el.name.textContent = this.proj.name; document.title = this.proj.name + ' — DAWters and Son';
  },
  // ---------- undo / change plumbing ----------
  commit(label, coalesce) {
    const now = performance.now();
    if (coalesce && this.lastCommit.label === label && now - this.lastCommit.t < 900) { this.lastCommit.t = now; return; }
    this.history.push(this.proj, label); this.lastCommit = { label, t: now };
  },
  undo() { if (this.eng.recording) return; const r = this.history.undo(this.proj); if (!r) return K.toast('Nothing to undo'); this.restore(r.p); this.status('Undo ' + r.label); },
  redo() { if (this.eng.recording) return; const r = this.history.redo(this.proj); if (!r) return K.toast('Nothing to redo'); this.restore(r.p); this.status('Redo ' + r.label); },
  restore(p) {
    const sel = this.ui.selTrack;
    this.proj = p; this.eng.setProject(p);
    if (!p.tracks.find((t) => t.id === sel)) this.ui.selTrack = p.tracks[0] ? p.tracks[0].id : null;
    const ids = new Set(); p.tracks.forEach((t) => t.clips.forEach((c) => ids.add(c.id)));
    this.ui.sel = new Set([...this.ui.sel].filter((i) => ids.has(i)));
    this.closeFx(); this.refreshAll(); this.save();
  },
  changed(f = {}) {
    if (f.graph) this.eng.sync();
    else if (f.clips) this.eng.clipsChanged();
    if (f.heads) ARR.renderHeads();
    if (f.clips || f.heads || f.graph) ARR.layout();
    ARR.dirty = true;
    if (f.console) CON.render();
    if (f.heads || f.graph || f.console) { DECK.focusStale = true; DECK.render(); }
    DECK.dirty = true;
    if (f.transport) this.syncTransport();
    this.inspector();
    this.save();
  },
  save: null, // set below (debounced)
  async saveNow() { try { SUITE.flush(); await U.idb.put('kv', 'project', JSON.stringify(this.proj)); } catch (e) { console.warn('autosave failed', e); } },
  status(msg) { if (this.el) this.el.status.textContent = msg; },
  // ---------- chrome ----------
  buildChrome() {
    const h = K.h, top = document.getElementById('top'), bottom = document.getElementById('bottom');
    const el = this.el = {};
    const brand = h('div', { class: 'brand', title: 'DAWters and Son' }); brand.innerHTML = K.LOGO;
    brand.append(h('div', { class: 'wordmark' }, h('b', null, 'DAWters & Son'), h('i', null, '★ Good to the last take ★')));
    const menus = h('div', { class: 'menus' });
    const mk = (label, items) => { const b = h('button', { class: 'menu-btn', 'aria-haspopup': 'true' }, label); b.addEventListener('click', () => { if (b.classList.contains('open')) return K.closeMenus(); const r = b.getBoundingClientRect(); K.menu(items(), r.left, r.bottom + 6, b); }); menus.append(b); };
    mk('File', () => this.menuFile()); mk('Edit', () => this.menuEdit()); mk('Track', () => this.menuTrack()); mk('View', () => this.menuView()); mk('Help', () => this.menuHelp());
    const tb = (cls, icon, title, fn) => { const b = h('button', { class: 'btn tb ' + cls, title, 'aria-label': title }); b.innerHTML = icon; b.addEventListener('click', fn); return b; };
    el.home = tb('', K.ICON.home, 'Go to start (Home)', () => this.locate(0));
    el.rew = tb('hide-sm hide-md', K.ICON.rew, 'Back one bar', () => this.nudgeBars(-1));
    el.stop = tb('stop', K.ICON.stop, 'Stop (Space)', () => this.stop());
    el.play = tb('play', K.ICON.play, 'Play (Space)', () => this.togglePlay());
    el.rec = tb('rec', K.ICON.rec, 'Record (R)', () => this.record());
    el.ffw = tb('hide-sm hide-md', K.ICON.ffw, 'Forward one bar', () => this.nudgeBars(1));
    const tog = (cls, label, title, fn) => { const b = h('button', { class: 'btn tog ' + cls, title, 'aria-pressed': 'false' }, label); b.addEventListener('click', fn); return b; };
    el.loop = tog('loop', 'Loop', 'Loop (L)', () => this.toggleLoop());
    el.punch = tog('punch hide-sm', 'Punch', 'Punch in/out (P) — Shift-drag on the ruler to set', () => { this.commit('Punch'); this.proj.punch.on = !this.proj.punch.on; this.changed({ transport: true }); });
    el.click = tog('click', 'Click', 'Metronome (C)', () => { this.settings.click = !this.settings.click; this.saveSettings(); this.syncTransport(); });
    el.cap = tog('cap', 'Capture', 'Capture what you just played, even if you weren’t recording (Shift+C)', () => this.capture());
    el.count = tog('count hide-sm', 'Count', 'One bar count-in before recording', () => { this.settings.countIn = !this.settings.countIn; this.saveSettings(); this.syncTransport(); });
    el.lcd = h('div', { class: 'lcd', title: 'Click to swap bars / time', role: 'timer' }, h('div', { class: 'big' }, '001.1.000'), h('div', { class: 'small' }, '00:00.000'));
    el.lcd.addEventListener('click', () => { this.ui.lcdBars = !this.ui.lcdBars; });
    el.bpm = h('input', { type: 'number', min: 20, max: 300, step: 0.1, 'aria-label': 'Tempo' });
    el.bpm.addEventListener('change', () => { const v = U.clamp(parseFloat(el.bpm.value) || 120, 20, 300); this.commit('Tempo'); this.eng.setBpm(v); this.changed({}); });
    el.sig = K.select([['4/4', '4/4'], ['3/4', '3/4'], ['2/4', '2/4'], ['6/8', '6/8'], ['5/4', '5/4'], ['7/8', '7/8'], ['12/8', '12/8']], '4/4', (v) => { this.commit('Time signature'); this.proj.sig = v.split('/').map(Number); this.changed({}); });
    el.snap = K.select([['off', 'Snap off'], ['bar', 'Bar'], ['beat', 'Beat'], ['1/8', '1/8'], ['1/16', '1/16'], ['1/32', '1/32']], this.ui.snap, (v) => { this.ui.snap = v; localStorage.setItem('dawters.snap', v); ARR.dirty = true; });
    el.inm = h('canvas', { title: 'Input level' }); this.inSt = K.meterState();
    el.seg = h('div', { class: 'seg', role: 'tablist' });
    el.vDeck = h('button', { role: 'tab', onclick: () => this.setView('deck') }, 'Deck');
    el.vTracks = h('button', { role: 'tab', onclick: () => this.setView('tracks') }, 'Tracks');
    el.vConsole = h('button', { role: 'tab', onclick: () => this.setView('console') }, 'Console');
    el.vMatrix = h('button', { role: 'tab', onclick: () => this.setView('matrix') }, 'Matrix');
    el.vPattern = h('button', { role: 'tab', onclick: () => this.setView('pattern') }, 'Pattern');
    el.vMaster = h('button', { role: 'tab', onclick: () => this.setView('master') }, 'Master');
    el.seg.append(el.vDeck, el.vTracks, el.vMatrix, el.vPattern, el.vConsole, el.vMaster);
    top.append(brand, menus,
      h('div', { class: 'tgroup' }, el.home, el.rew, el.stop, el.play, el.rec, el.ffw),
      h('div', { class: 'tgroup' }, el.loop, el.punch, el.click, el.count, el.cap),
      el.lcd,
      h('div', { class: 'field' }, h('label', null, 'BPM'), el.bpm, h('span', { class: 'hide-sm', style: 'display:contents' }, el.sig)),
      h('div', { class: 'spacer' }),
      h('div', { class: 'inmeter hide-sm', title: 'Input level' }, el.inm),
      el.seg);
    el.status = h('span', { class: 'info' }, '');
    el.name = h('span', { class: 'muted', style: 'cursor:pointer', title: 'Rename song' }, '');
    el.name.addEventListener('click', () => this.renameSong());
    el.insp = h('span', { class: 'muted' }, '');
    el.follow = h('button', { class: 'btn sm', title: 'Keep the playhead in view' }, 'Follow');
    el.follow.addEventListener('click', () => { this.ui.follow = this.settings.follow = !this.ui.follow; this.saveSettings(); this.syncTransport(); });
    el.lat = h('span', { class: 'muted hide-sm' });
    el.name.classList.add('hide-xs'); el.status.classList.add('hide-xs'); el.insp.classList.add('hide-xs');
    bottom.append(el.name, h('span', { class: 'muted hide-xs' }, '·'), el.status, h('div', { class: 'spacer' }), el.insp, el.lat, el.follow,
      h('div', { class: 'zoom' }, h('button', { class: 'btn sm icon', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => ARR.zoom(1 / 1.5) }, '−'), h('button', { class: 'btn sm icon', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => ARR.zoom(1.5) }, '+'), h('button', { class: 'btn sm icon', title: 'Zoom to song (F)', 'aria-label': 'Zoom to song', onclick: () => ARR.fit() }, '↔')),
      h('div', { class: 'zoom' }, h('button', { class: 'btn sm icon', title: 'Undo (Ctrl+Z)', 'aria-label': 'Undo', onclick: () => this.undo() }, '↶'), h('button', { class: 'btn sm icon', title: 'Redo', 'aria-label': 'Redo', onclick: () => this.redo() }, '↷')));
    this.save = U.debounce(() => this.saveNow(), 700);
  },
  zoom(f) { if (this.ui.view === 'deck') DECK.zoom(1 / f); else if (this.ui.view === 'pattern' && window.PAT) PAT.zoom(f); else ARR.zoom(f); },
  setView(v) {
    if (!['deck', 'tracks', 'matrix', 'pattern', 'console', 'master'].includes(v)) v = 'tracks';
    this.ui.view = v; localStorage.setItem('dawters.view', v);
    document.body.dataset.view = v;
    document.getElementById('deck').classList.toggle('show', v === 'deck');
    document.getElementById('arrange').classList.toggle('show', v === 'tracks');
    document.getElementById('console').classList.toggle('show', v === 'console');
    document.getElementById('matrix').classList.toggle('show', v === 'matrix');
    document.getElementById('pattern').classList.toggle('show', v === 'pattern');
    document.getElementById('master').classList.toggle('show', v === 'master');
    [['deck', this.el.vDeck], ['tracks', this.el.vTracks], ['matrix', this.el.vMatrix], ['pattern', this.el.vPattern], ['console', this.el.vConsole], ['master', this.el.vMaster]].forEach(([k, b]) => { b.classList.toggle('on', v === k); b.setAttribute('aria-selected', v === k); });
    if (v === 'tracks') { ARR.layout(); ARR.renderHeads(); } else if (v === 'console') CON.render(); else if (v === 'matrix') MTX.render(); else if (v === 'pattern') PAT.render(); else if (v === 'master') MST.render(); else DECK.render();
    if (v !== 'master' && this.eng && this.eng.graph) MST.setCompare(false);
  },
  cycleView(d) { const vs = ['deck', 'tracks', 'matrix', 'pattern', 'console', 'master']; this.setView(vs[(vs.indexOf(this.ui.view) + (d || 1) + vs.length) % vs.length]); },
  syncTransport() {
    const E = this.eng, P = this.proj, el = this.el; if (!P) return;
    el.play.classList.toggle('on', E.playing && !E.recording);
    el.rec.classList.toggle('on', E.recording);
    const set = (b, on) => { b.classList.toggle('on', !!on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); };
    set(el.loop, P.loop.on); set(el.punch, P.punch.on); set(el.click, this.settings.click); set(el.count, this.settings.countIn); set(el.follow, this.ui.follow);
    if (document.activeElement !== el.bpm) el.bpm.value = P.bpm;
    el.sig.value = P.sig.join('/');
    const ms = Math.round(((E.ctx.baseLatency || 0) + (E.ctx.outputLatency || 0)) * 1000);
    DECK.syncBar();
    el.lat.textContent = 'Out ' + ms + ' ms' + (E.input ? ' · In: ' + (E.input.label || 'mic').slice(0, 22) : '');
    ARR.dirty = true;
  },
  saveSettings() { localStorage.setItem('dawters.settings', JSON.stringify(this.settings)); this.eng.settings = this.settings; },
  frame() {
    const E = this.eng, pos = E.pos();
    const big = this.el.lcd.firstChild, small = this.el.lcd.lastChild;
    const bars = U.fmtBars(pos, this.proj.bpm, this.proj.sig), tm = U.fmtTime(pos);
    big.textContent = this.ui.lcdBars ? bars : tm; small.textContent = this.ui.lcdBars ? tm : bars;
    ARR.frame(); CON.frame(); DECK.frame(); PAT.frame(); MTX.frame(); MST.frame();
    if (E.input) K.drawMeter(this.el.inm, this.inSt, E.inLevels.length ? E.inLevels : [0], { noScale: true });
    // stop at punch end + 1 bar when recording with punch
    if (E.recording && this.proj.punch.on && pos > this.proj.punch.e + 60 / this.proj.bpm * this.proj.sig[0] && !this.proj.loop.on) this.stop();
  },
  // ---------- transport ----------
  async togglePlay() { if (this.eng.playing) await this.stop(); else await this.eng.play(); },
  async stop() { await this.eng.stop(); ARR.dirty = true; ARR.layout(); },
  locate(t) { this.eng.locate(Math.max(0, t)); ARR.dirty = true; },
  nudgeBars(n) { const bar = 60 / this.proj.bpm * this.proj.sig[0]; const p = this.eng.pos(); this.locate(Math.max(0, (Math.round(p / bar) + n) * bar)); },
  toggleLoop() { this.commit('Loop'); const L = this.proj.loop; L.on = !L.on; if (L.on && L.e - L.s < 0.1) { const bar = 60 / this.proj.bpm * this.proj.sig[0]; L.s = 0; L.e = bar * 4; } this.changed({ transport: true }); if (this.eng.playing) this.eng.reschedule(); },
  setLoop(s, e, on) { this.commit('Loop range'); Object.assign(this.proj.loop, { s, e, on }); this.changed({ transport: true }); if (this.eng.playing) this.eng.reschedule(); },
  async record() {
    const E = this.eng;
    if (E.recording) return this.stop();
    if (!this.proj.tracks.some((t) => t.arm)) {
      const t = this.proj.tracks.find((x) => x.id === this.ui.selTrack) || this.proj.tracks.find((x) => !x.clips.length) || this.proj.tracks[0];
      if (!t) return K.toast('Add a track first');
      t.arm = true; ARR.renderHeads(); CON.render();
      K.toast('Armed ' + t.name);
    }
    try { await E.record(); ARR.layout(); }
    catch (e) { E.recording = false; E.take = null; this.syncTransport(); K.toast(e && e.name === 'NotAllowedError' ? 'Microphone permission was blocked — allow it in your settings and try again' : (e.message || String(e)), 4200); }
  },
  applyTake(list) {
    if (!list || !list.length) return;
    this.commit('Record');
    let n = 0;
    for (const it of list) {
      const t = this.proj.tracks.find((x) => x.id === it.trackId); if (!t) continue;
      const id = this.eng.addBuffer(it.ab, t.name + ' take');
      if (!t.clips.length && it.stereo) t.stereo = true;
      const base = t.clips.filter((c) => /take/i.test(c.name || '')).length;
      it.plan.forEach((p, k) => { t.clips.push({ id: U.uid('c'), buf: id, start: p.s, off: p.off, len: p.len, gain: 1, fi: 0.002, fo: 0.002, name: t.name + ' take ' + (base + k + 1) }); n++; });
    }
    this.changed({ clips: true, console: false });
    this.status('Recorded ' + n + ' clip' + (n === 1 ? '' : 's'));
  },
  // ---------- tracks ----------
  sel() { return this.proj.tracks.find((t) => t.id === this.ui.selTrack) || null; },
  selectTrack(id, quiet) {
    if (this.ui.selTrack === id) return;
    this.ui.selTrack = id;
    document.querySelectorAll('.th').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
    document.querySelectorAll('.strip[data-id]').forEach((e) => e.classList.toggle('sel', e.dataset.id === id));
    DECK.selected(id);
    ARR.dirty = true; void quiet;
  },
  addTrack(opts) {
    this.commit('Add track');
    const P = this.proj, t = M.newTrack(P.tracks.length, opts || {});
    const used = new Set(P.tracks.map((x) => x.color)); const free = M.COLORS.find((c) => !used.has(c)); if (free) t.color = free;
    const i = this.sel() ? P.tracks.indexOf(this.sel()) + 1 : P.tracks.length;
    P.tracks.splice(i, 0, t); this.ui.selTrack = t.id;
    this.changed({ graph: true, heads: true, console: true });
    return t;
  },
  // instrument tracks start with an empty pattern so there is something to write into
  addInstTrack(type) {
    if (type === 'eleo' && !SUITE.has('eleo')) { K.toast('Eleosynth is not included in this build'); return null; }
    const t = this.addTrack({ kind: 'inst', inst: INST.make(type), stereo: true, input: '1+2' });
    this.newPatternFor(t, true);
    this.ui.patTrack = t.id;
    if (type === 'eleo') SUITE.show(t.id);
    return t;
  },
  // a Beat track: Esperanza's Drum Kit, its song placed at the playhead, its editor open
  addBeatTrack() {
    if (!SUITE.has('edk')) return K.toast("Esperanza's Drum Kit is not included in this build");
    const t = this.addTrack({ kind: 'beat', stereo: true, input: '1+2' });
    SUITE.show(t.id);
    return t;
  },
  // ---------- the suite: ideas sent over from Eleosynth, Esperanza's Drum Kit and The Increaser ----------
  // On the web, those apps open DAWters at #receive and post the idea once it says it is ready. Only the
  // suite's own sites (and this one) are listened to. In the desktop and Android builds they save a
  // .dawsuite.json file instead, which File → Import takes (as it does .edk projects and Eleosynth sounds).
  suiteOrigin(o) { return o === location.origin || /^https:\/\/(eleosynth|esperanza-s-drum-kit|dawters-and-son)\.github\.io$/.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o); },
  listenSuite() {
    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.type !== 'dawters-send' || !this.suiteOrigin(e.origin)) return;
      this.receiveSuite(d).then((ok) => { try { e.source.postMessage({ type: 'dawters-got', ok: !!ok }, e.origin); } catch (er) { /* sender closed */ } });
    });
    const hello = () => {
      if (location.hash !== '#receive') return;
      history.replaceState(null, '', location.pathname + location.search);
      if (window.opener) try { window.opener.postMessage('dawters-ready', '*'); } catch (e) { /* no opener */ }
    };
    hello(); window.addEventListener('hashchange', hello);
  },
  async receiveSuite(d) {
    const P = this.proj, nm = String(d.name || '').slice(0, 40);
    const place = (t) => { const used = new Set(P.tracks.map((x) => x.color)); t.color = M.COLORS.find((c) => !used.has(c)) || t.color; const i = this.sel() ? P.tracks.indexOf(this.sel()) + 1 : P.tracks.length; P.tracks.splice(i, 0, t); this.ui.selTrack = t.id; };
    try {
      if (d.kind === 'eleo') {
        if (!SUITE.has('eleo')) { K.toast('Eleosynth is not included in this build'); return false; }
        this.commit('From Eleosynth');
        const t = M.newTrack(P.tracks.length, { kind: 'inst', inst: INST.make('eleo'), stereo: true, input: '1+2', name: nm || 'Eleosynth' });
        t.inst.state = d.state || null; place(t);
        this.newPatternFor(t, true); this.ui.patTrack = t.id;
        this.changed({ graph: true, heads: true, console: true, clips: true });
        K.toast('Eleosynth sound “' + (nm || 'Eleosynth') + '” is on a new track — play it, or write notes in its pattern', 4500);
      } else if (d.kind === 'edk') {
        if (!SUITE.has('edk')) { K.toast("Esperanza's Drum Kit is not included in this build"); return false; }
        if (!d.state || !d.state.proj) throw new Error('empty');
        this.commit('From the Drum Kit');
        const empty = !P.tracks.some((t) => t.clips.length);
        if (empty && d.state.proj.bpm) this.eng.setBpm(U.clamp(+d.state.proj.bpm, 20, 300)); this.syncTransport();
        const t = M.newTrack(P.tracks.length, { kind: 'beat', beat: { state: d.state }, stereo: true, input: '1+2', name: nm || d.state.proj.name || 'Beat' });
        place(t);
        this.changed({ graph: true, heads: true, console: true, clips: true });
        K.toast('“' + t.name + '” is on a Beat track — its song is placed at the playhead. Double-click it to edit.', 4500);
      } else if (d.kind === 'stems') {
        // The Increaser: one track per loop cup, all starting together, at the looper's tempo when the song is empty
        const list = (d.tracks || []).filter((x) => x && x.audio && x.audio.ch && x.audio.ch.length);
        if (!list.length) throw new Error('empty');
        this.commit('From The Increaser');
        const empty = !P.tracks.some((t) => t.clips.length);
        if (empty && d.bpm) this.eng.setBpm(U.clamp(+d.bpm, 20, 300));
        if (empty && d.bpb >= 2 && d.bpb <= 12 && P.sig) P.sig = [d.bpb, P.sig[1] || 4];
        this.syncTransport();
        const at = empty ? 0 : this.eng.pos();
        for (const x of list) {
          const chs = x.audio.ch.map((c) => U.b64f32(c));
          const ab = this.eng.makeBuffer(chs, x.audio.sr || this.eng.sr);
          const name = String(x.name || 'Loop').slice(0, 40);
          const t = M.newTrack(P.tracks.length, { name, stereo: chs.length > 1, input: chs.length > 1 ? '1+2' : '1' });
          const id = this.eng.addBuffer(ab, name);
          t.clips.push({ id: U.uid('c'), buf: id, start: at, off: 0, len: ab.duration, gain: 1, fi: 0, fo: 0, name });
          place(t);
        }
        this.changed({ graph: true, heads: true, console: true, clips: true });
        K.toast(list.length + (list.length === 1 ? ' loop' : ' loops') + ' from The Increaser ' + (list.length === 1 ? 'is' : 'are') + ' on new tracks' + (empty ? ', from bar 1 at its tempo' : ' at the playhead'), 4500);
      } else if (d.kind === 'audio') {
        const a = d.audio; if (!a || !a.ch || !a.ch.length) throw new Error('empty');
        const chs = a.ch.map((b) => U.b64f32(b));
        const ab = this.eng.makeBuffer(chs, a.sr || this.eng.sr);
        this.commit('From the suite');
        const t = M.newTrack(P.tracks.length, { name: nm || 'Take', stereo: chs.length > 1, input: chs.length > 1 ? '1+2' : '1' });
        const id = this.eng.addBuffer(ab, t.name);
        t.clips.push({ id: U.uid('c'), buf: id, start: this.eng.pos(), off: 0, len: ab.duration, gain: 1, fi: 0, fo: 0, name: t.name });
        place(t);
        this.changed({ graph: true, heads: true, console: true, clips: true });
        K.toast('“' + t.name + '” is on a new track at the playhead');
      } else return false;
      this.status('Received ' + (nm || d.kind));
      return true;
    } catch (e) { K.toast('That idea could not be brought in'); return false; }
  },
  // File → Import for suite files: .dawsuite.json (sent from the suite), .edk projects, .eleosynth.json sounds
  async importSuiteFile(f) {
    const low = f.name.toLowerCase();
    try {
      if (low.endsWith('.edk')) {
        let z = await U.unzip(f);
        if (!z['project.json']) { const inner = Object.keys(z).find((n) => /\.edk$/i.test(n)); if (inner) z = await U.unzip(z[inner]); }
        const proj = JSON.parse(new TextDecoder().decode(z['project.json']));
        const samples = {};
        for (const name in z) {
          const m = /^samples\/(.+)\.wav$/.exec(name); if (!m) continue;
          const w = U.decodeWav(z[name]); if (!w) continue;
          const label = z['samples/' + m[1] + '.txt'];
          samples[m[1]] = { sr: w.sr, name: label ? new TextDecoder().decode(label) : m[1], ch: w.ch.map((c) => U.f32b64(c)) };
        }
        return this.receiveSuite({ kind: 'edk', name: proj.name && proj.name !== 'Untitled' ? proj.name : f.name.replace(/\.edk$/i, ''), state: { app: 'edk', v: 1, proj, samples } });
      }
      const j = JSON.parse(await f.text());
      if (j.type === 'dawters-send') return this.receiveSuite(j);
      if (j.app === 'Eleosynth' && j.p) return this.receiveSuite({ kind: 'eleo', name: j.name, state: { app: 'Eleosynth', v: 1, sound: j } });
      throw new Error('unknown');
    } catch (e) { K.toast('Could not read ' + f.name, 3500); return false; }
  },
  isSuiteFile(f) { return /\.(edk|dawsuite\.json|eleosynth\.json)$/i.test(f.name); },
  newPatternFor(t, silent) {
    if (!silent) this.commit('New pattern');
    const n = Object.values(this.proj.patterns).filter((p) => p.track === t.id).length + 1, bpb = this.proj.sig[0];
    const p = M.newPattern(t.id, (t.inst.type === 'drums' ? 'Beat ' : 'Pattern ') + n, t.inst.type === 'drums' ? bpb : bpb * 2, t.inst.type);
    this.proj.patterns[p.id] = p; this.ui.pat = p.id;
    this.save();
    return p;
  },
  placePattern(t, p) {
    this.commit('Place pattern');
    const bar = this.eng.beat() * this.proj.sig[0], at = Math.max(0, Math.floor(this.eng.pos() / bar + 1e-6) * bar);
    const c = { id: U.uid('c'), pat: p.id, start: at, off: 0, len: p.len * this.eng.beat(), gain: 1, fi: 0, fo: 0, name: p.name };
    t.clips.push(c); this.ui.sel = new Set([c.id]); this.ui.selTrack = t.id;
    this.changed({ clips: true });
    K.toast('Placed ' + p.name + ' at bar ' + (Math.round(at / bar) + 1));
  },
  addTrackMenu(x, y) {
    K.menu([{ head: 'Add a track' },
      { label: 'Audio (mono)', act: () => this.addTrack() }, { label: 'Audio (stereo)', act: () => this.addTrack({ stereo: true, input: '1+2' }) },
      { label: 'Synth', act: () => this.addInstTrack('synth') }, { label: 'Drums', act: () => this.addInstTrack('drums') }, { label: 'Sampler', act: () => this.addInstTrack('sampler') },
      { head: 'The suite' },
      { label: 'Eleosynth (synth + guitar pedals)', disabled: !SUITE.has('eleo'), act: () => this.addInstTrack('eleo') },
      { label: "Beat · Esperanza's Drum Kit", disabled: !SUITE.has('edk'), act: () => this.addBeatTrack() },
      ...this.plugInstItems().map((it) => Object.assign({}, it, { label: 'VST3 instrument…' }))], x, y);
  },
  // MIDI recorded while transport ran -> a new pattern + clip per armed instrument track
  applyMidiTake(m) {
    const P = this.proj, beat = this.eng.beat(), bpb = P.sig[0], bar = beat * bpb;
    const start = Math.max(0, Math.floor(m.recStart / bar + 1e-6) * bar);
    let made = 0;
    for (const tid of m.tracks) {
      const t = P.tracks.find((x) => x.id === tid); if (!t) continue;
      const evs = m.notes.filter((x) => x[4] === tid).sort((a, b) => a[0] - b[0]);
      const open = new Map(), notes = [];
      for (let [time, on, n, v] of evs) {
        if (time < m.recStart - 0.5) continue;
        if (time < m.recStart) time = m.recStart; // played a hair early, right as recording began
        if (on) open.set(n, { t: time, v }); else if (open.has(n)) { const o = open.get(n); open.delete(n); notes.push({ t: (o.t - start) / beat, d: Math.max(0.05, (time - o.t) / beat), n, v: o.v }); }
      }
      for (const [n, o] of open) notes.push({ t: (o.t - start) / beat, d: Math.max(0.05, (m.end - o.t) / beat), n, v: o.v });
      if (!notes.length) continue;
      if (!made) this.commit(m.label || 'Record MIDI');
      const bars = Math.max(1, Math.ceil(Math.max(m.end - start, ...notes.map((x) => (x.t + x.d) * beat)) / bar - 1e-6));
      const p = M.newPattern(t.id, 'Take ' + (Object.values(P.patterns).filter((x) => x.track === t.id).length + 1), bars * bpb, t.inst.type);
      p.notes = notes.map((x) => ({ t: Math.max(0, x.t), d: x.d, n: x.n, v: Math.max(0.05, Math.min(1, x.v)) }));
      P.patterns[p.id] = p;
      t.clips.push({ id: U.uid('c'), pat: p.id, start, off: 0, len: bars * bar, gain: 1, fi: 0, fo: 0, name: p.name });
      this.ui.pat = p.id; this.ui.patTrack = t.id; made++;
    }
    if (made) { this.changed({ clips: true }); PAT.render(); if (!m.quiet) this.status('Recorded notes into ' + made + ' pattern' + (made === 1 ? '' : 's')); }
    return made;
  },
  async deleteTrack(t) {
    if (t.clips.length && !(await K.confirm('Delete track', 'Delete “' + t.name + '” and its ' + t.clips.length + ' clip(s)? You can undo this.', 'Delete'))) return;
    this.commit('Delete track');
    const P = this.proj, i = P.tracks.indexOf(t); P.tracks.splice(i, 1);
    this.ui.selTrack = P.tracks[Math.min(i, P.tracks.length - 1)] ? P.tracks[Math.min(i, P.tracks.length - 1)].id : null;
    this.closeFx(); this.changed({ graph: true, heads: true, console: true });
  },
  duplicateTrack(t) {
    this.commit('Duplicate track');
    const n = JSON.parse(JSON.stringify(t)); n.id = U.uid('t'); n.name = t.name + ' copy'; n.arm = false; n.solo = false;
    n.clips.forEach((c) => (c.id = U.uid('c'))); n.fx.forEach((f) => (f.id = U.uid('f')));
    const P = this.proj; P.tracks.splice(P.tracks.indexOf(t) + 1, 0, n); this.ui.selTrack = n.id;
    this.changed({ graph: true, heads: true, console: true });
  },
  moveTrack(t, d) { const P = this.proj, i = P.tracks.indexOf(t), j = i + d; if (j < 0 || j >= P.tracks.length) return; this.commit('Move track'); P.tracks.splice(i, 1); P.tracks.splice(j, 0, t); this.changed({ heads: true, console: true }); },
  toggleTrack(t, k) {
    if (k === 'arm' && this.eng.recording) return K.toast('Stop recording first');
    this.commit(k === 'arm' ? 'Arm' : k === 'mon' ? 'Monitor' : k === 'mute' ? 'Mute' : 'Solo', false);
    t[k] = !t[k];
    if (k === 'mute' || k === 'solo') this.eng.graph.mutes();
    if (k === 'mon') { this.eng.openInput().then(() => this.eng.updateMonitors()).catch((e) => K.toast(e.message || 'No input')); }
    if (k === 'arm' && t.arm && t.kind !== 'inst') this.eng.openInput().catch(() => {});
    if (k === 'arm' && t.arm && t.kind === 'inst') this.eng.initMidi();
    document.querySelectorAll('.th[data-id="' + t.id + '"] .mini.' + k + ', .strip[data-id="' + t.id + '"] .mini.' + k).forEach((b) => { b.classList.toggle('on', t[k]); b.setAttribute('aria-pressed', t[k] ? 'true' : 'false'); });
    DECK.syncButtons(t);
    ARR.dirty = true; this.save();
  },
  // ---------- clips ----------
  allClips() { const out = []; this.proj.tracks.forEach((t, ti) => t.clips.forEach((c) => out.push({ t, ti, c }))); return out; },
  selected() { return this.allClips().filter((x) => this.ui.sel.has(x.c.id)); },
  splitClip(t, c, at) {
    if (at <= c.start + 0.002 || at >= c.start + c.len - 0.002) return null;
    const n = Object.assign({}, c, { id: U.uid('c'), start: at, off: c.off + (at - c.start), len: c.start + c.len - at, fi: 0, fo: c.fo });
    c.len = at - c.start; c.fo = 0; c.fi = Math.min(c.fi, c.len);
    n.fo = Math.min(n.fo, n.len);
    t.clips.splice(t.clips.indexOf(c) + 1, 0, n);
    return n;
  },
  split(at) {
    at = at === undefined ? this.eng.pos() : at;
    let targets = this.selected();
    if (!targets.length) { const t = this.sel(); if (t) targets = t.clips.filter((c) => at > c.start && at < c.start + c.len).map((c) => ({ t, c })); }
    targets = targets.filter((x) => at > x.c.start + 0.002 && at < x.c.start + x.c.len - 0.002);
    if (!targets.length) return K.toast('Put the playhead over a clip to split it (click the ruler to move the playhead)');
    this.commit('Split');
    let n = 0; for (const x of targets) if (this.splitClip(x.t, x.c, at)) n++;
    this.changed({ clips: true }); this.status('Split ' + n + ' clip' + (n === 1 ? '' : 's'));
  },
  deleteSel() {
    if (this.hasRange()) return this.deleteRange(this.ui.range, true);
    const s = this.selected(); if (!s.length) return;
    this.commit('Delete clips');
    for (const x of s) x.t.clips.splice(x.t.clips.indexOf(x.c), 1);
    this.ui.sel = new Set(); this.changed({ clips: true });
  },
  copy(cut) {
    if (this.hasRange()) return cut ? this.cutRange(this.ui.range) : this.copyRange(this.ui.range);
    const s = this.selected(); if (!s.length) return K.toast('Select clips to ' + (cut ? 'cut' : 'copy'));
    const t0 = Math.min(...s.map((x) => x.c.start)), ti0 = Math.min(...s.map((x) => x.ti));
    this.clipboard = s.map((x) => ({ c: JSON.parse(JSON.stringify(x.c)), dt: x.c.start - t0, dti: x.ti - ti0 }));
    if (cut) { this.commit('Cut'); for (const x of s) x.t.clips.splice(x.t.clips.indexOf(x.c), 1); this.ui.sel = new Set(); this.changed({ clips: true }); }
    this.status((cut ? 'Cut ' : 'Copied ') + s.length + ' clip(s)');
  },
  paste(at) {
    if (!this.clipboard) return;
    at = at === undefined ? this.eng.pos() : at;
    this.commit('Paste');
    const P = this.proj, base = Math.max(0, P.tracks.indexOf(this.sel()));
    this.ui.sel = new Set();
    for (const it of this.clipboard) {
      const ti = base + it.dti;
      while (P.tracks.length <= ti) P.tracks.push(M.newTrack(P.tracks.length));
      const c = Object.assign({}, it.c, { id: U.uid('c'), start: at + it.dt });
      P.tracks[ti].clips.push(c); this.ui.sel.add(c.id);
    }
    this.changed({ graph: true, heads: true, clips: true, console: true });
  },
  duplicate() {
    const s = this.selected(); if (!s.length) return K.toast('Select clips to duplicate');
    this.commit('Duplicate');
    const t0 = Math.min(...s.map((x) => x.c.start)), t1 = Math.max(...s.map((x) => x.c.start + x.c.len)), span = t1 - t0;
    this.ui.sel = new Set();
    for (const x of s) { const c = Object.assign({}, x.c, { id: U.uid('c'), start: x.c.start + span }); x.t.clips.push(c); this.ui.sel.add(c.id); }
    this.changed({ clips: true });
  },
  nudge(dir) {
    const s = this.selected(); if (!s.length) return false;
    const g = ARR.grid() || 0.01;
    this.commit('Nudge', true);
    for (const x of s) x.c.start = Math.max(0, x.c.start + dir * g);
    this.changed({ clips: true }); return true;
  },
  clipPeak(c) {
    const b = this.eng.buffers.get(c.buf); if (!b) return 0;
    const sr = b.ab.sampleRate, s = Math.floor(c.off * sr), e = Math.min(b.ab.length, Math.ceil((c.off + c.len) * sr));
    let mx = 0; for (let ch = 0; ch < b.ab.numberOfChannels; ch++) { const d = b.ab.getChannelData(ch); for (let i = s; i < e; i++) { const a = Math.abs(d[i]); if (a > mx) mx = a; } }
    return mx;
  },
  normalize(list, quiet) {
    list = (list || this.selected()).filter((x) => x.c.buf); if (!list.length) return;
    if (!quiet) this.commit('Normalize');
    for (const x of list) { const pk = this.clipPeak(x.c); if (pk > 1e-6) x.c.gain = U.undb(-1) / pk; }
    this.changed({ clips: true });
  },
  reverse(list, quiet) {
    list = (list || this.selected()).filter((x) => x.c.buf); if (!list.length) return;
    if (!quiet) this.commit('Reverse');
    for (const x of list) {
      const c = x.c, b = this.eng.buffers.get(c.buf); if (!b) continue;
      const sr = b.ab.sampleRate, s = Math.floor(c.off * sr), n = Math.max(1, Math.round(c.len * sr));
      const chs = [];
      for (let ch = 0; ch < b.ab.numberOfChannels; ch++) { const d = b.ab.getChannelData(ch), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = d[s + n - 1 - i] || 0; chs.push(o); }
      const id = this.eng.addBuffer(this.eng.makeBuffer(chs, sr), (b.name || 'clip') + ' reversed');
      c.buf = id; c.off = 0; c.rev = !c.rev; const f = c.fi; c.fi = c.fo; c.fo = f;
    }
    this.changed({ clips: true });
  },
  clipMenu(c, t, at, x, y) {
    const list = this.selected();
    K.menu([
      { head: c.name || 'Clip' },
      c.pat ? { label: 'Edit pattern', act: () => { this.ui.patTrack = t.id; this.ui.pat = c.pat; this.setView('pattern'); } } : null,
      c.pat ? { label: 'Make unique (own copy of the pattern)', act: () => { this.commit('Make unique'); const p = this.proj.patterns[c.pat], n = JSON.parse(JSON.stringify(p)); n.id = U.uid('p'); n.name = p.name + ' (unique)'; this.proj.patterns[n.id] = n; c.pat = n.id; c.name = n.name; this.changed({ clips: true }); } } : null,
      c.beat ? { label: "Edit in Esperanza's Drum Kit", act: () => SUITE.open(t) } : null,
      c.beat ? { label: 'Plays: ' + this.beatSrcName(t, c) + ' — change…', act: () => this.beatSrcMenu(t, c, x, y) } : null,
      c.beat ? { label: 'Fit clip to whole loops', act: () => { const L = this.beatLen(t, c); if (!L) return; this.commit('Fit clip'); c.len = Math.max(1, Math.round(c.len / L)) * L; this.changed({ clips: true }); } } : null,
      c.pat ? { label: 'Fit clip to whole loops', act: () => { this.commit('Fit clip'); const per = this.proj.patterns[c.pat].len * this.eng.beat(); c.len = Math.max(1, Math.round(c.len / per)) * per; this.changed({ clips: true }); } } : null,
      { label: 'Split here', key: 'S', act: () => { this.commit('Split'); this.splitClip(t, c, ARR.snap(at)); this.changed({ clips: true }); } },
      { label: 'Split at playhead', act: () => this.split() },
      { label: 'Duplicate', key: 'Ctrl+D', act: () => this.duplicate() },
      { label: 'Copy', key: 'Ctrl+C', act: () => this.copy(false) },
      { label: 'Cut', key: 'Ctrl+X', act: () => this.copy(true) },
      { label: 'Delete', key: 'Del', act: () => this.deleteSel() },
      { sep: true },
      c.buf ? { label: 'Normalize to −1 dB', act: () => this.normalize(list) } : null,
      c.buf ? { label: 'Reverse', act: () => this.reverse(list) } : null,
      c.buf ? { label: 'Remove noise…', act: () => NR.dialog() } : null,
      { label: c.mute ? 'Unmute clip' : 'Mute clip', act: () => { this.commit('Mute clip'); const v = !c.mute; list.forEach((x2) => (x2.c.mute = v)); this.changed({ clips: true }); } },
      { label: 'Fade in & out 10 ms', act: () => { this.commit('Fades'); list.forEach((x2) => { x2.c.fi = Math.min(0.01, x2.c.len / 2); x2.c.fo = Math.min(0.01, x2.c.len / 2); }); this.changed({ clips: true }); } },
      { label: 'Remove fades', act: () => { this.commit('Fades'); list.forEach((x2) => { x2.c.fi = 0; x2.c.fo = 0; }); this.changed({ clips: true }); } },
      { label: 'Bring to front', act: () => { this.commit('Bring to front'); t.clips.splice(t.clips.indexOf(c), 1); t.clips.push(c); this.changed({ clips: true }); } },
      { label: 'Clip properties…', act: () => this.clipDialog(c) },
      c.buf ? { label: 'Export clip as WAV', act: () => this.exportClip(c) } : null,
    ], x, y);
  },
  // ---------- beat clips (Esperanza's Drum Kit) ----------
  beatLen(t, c) { const i = SUITE.info(t); if (!i) return 0; const sd = 60 / this.proj.bpm / 4; if (c.src === 'song') return i.songLen * sd; const p = i.patterns.find((x) => x.id === c.src); return p ? p.len * sd : 0; },
  beatSrcName(t, c) { const i = SUITE.info(t); if (c.src === 'song') return 'the song'; const p = i && i.patterns.find((x) => x.id === c.src); return p ? p.name : 'a pattern'; },
  beatSrcMenu(t, c, x, y) {
    const i = SUITE.info(t); if (!i) return K.toast('Still starting…');
    const set = (src, name) => { this.commit('Beat clip'); c.src = src; c.off = 0; c.name = name; SUITE.hitCache.clear(); this.changed({ clips: true }); };
    K.menu([{ head: 'This clip plays' }, { label: 'The whole song', check: c.src === 'song', act: () => set('song', i.name || 'Song') },
      ...i.patterns.map((p) => ({ label: p.name, check: c.src === p.id, act: () => set(p.id, p.name) }))], x, y);
  },
  clipDialog(c) {
    const h = K.h;
    const name = h('input', { type: 'text', value: c.name || '' });
    const gain = h('input', { type: 'number', step: 0.1, value: U.db(c.gain).toFixed(1) });
    const fi = h('input', { type: 'number', step: 1, min: 0, value: Math.round(c.fi * 1000) });
    const fo = h('input', { type: 'number', step: 1, min: 0, value: Math.round(c.fo * 1000) });
    const b = this.eng.buffers.get(c.buf);
    K.dialog('Clip properties', [
      K.row('Name', name), K.row('Gain (dB)', gain), K.row('Fade in (ms)', fi), K.row('Fade out (ms)', fo),
      h('div', { class: 'note' }, 'Starts ' + U.fmtTime(c.start) + ' · length ' + c.len.toFixed(3) + ' s · source ' + (b ? (b.ab.sampleRate / 1000) + ' kHz, ' + (b.ab.numberOfChannels === 2 ? 'stereo' : 'mono') : 'missing') + ' · peak ' + U.fmtDb(U.db(this.clipPeak(c))) + ' dBFS'),
    ], [{ label: 'Cancel' }, { label: 'Apply', primary: true, act: () => {
      this.commit('Clip properties');
      c.name = name.value; c.gain = U.undb(U.clamp(parseFloat(gain.value) || 0, -60, 24));
      c.fi = U.clamp((parseFloat(fi.value) || 0) / 1000, 0, c.len); c.fo = U.clamp((parseFloat(fo.value) || 0) / 1000, 0, c.len - c.fi);
      this.changed({ clips: true });
    } }]);
  },
  async exportClip(c) {
    const b = this.eng.buffers.get(c.buf); if (!b) return;
    const sr = b.ab.sampleRate, s = Math.floor(c.off * sr), n = Math.round(c.len * sr), chs = [];
    for (let ch = 0; ch < b.ab.numberOfChannels; ch++) { const o = b.ab.getChannelData(ch).slice(s, s + n); for (let i = 0; i < o.length; i++) o[i] *= M.clipGainAt(c, c.start + i / sr); chs.push(o); }
    const msg = await PLAT.save((c.name || 'clip').replace(/[^\w\- ]+/g, '') + '.wav', new Blob([U.encodeWav(chs, sr, 24)], { type: 'audio/wav' }));
    if (msg) K.toast(msg);
  },
  // ---------- ranges (Audacity-style: drag across a waveform, then edit just that stretch) ----------
  rangeTracks(R) { return this.proj.tracks.slice(R.t0, R.t1 + 1); },
  hasRange() { const R = this.ui.range; return !!(R && R.e - R.s > 0.0005); },
  rangeLabel(R) { return U.fmtTime(R.s) + ' → ' + U.fmtTime(R.e) + ' (' + (R.e - R.s).toFixed(3) + ' s)'; },
  // split every clip on the range's tracks at the range edges; returns the pieces that now sit inside it
  rangePieces(R) {
    const out = [];
    this.rangeTracks(R).forEach((t, k) => {
      for (const c of t.clips.slice()) { const n = this.splitClip(t, c, R.s); this.splitClip(t, n || c, R.e); }
      for (const c of t.clips) if (c.start >= R.s - 1e-6 && c.start + c.len <= R.e + 1e-6) out.push({ t, c, ti: R.t0 + k });
    });
    return out;
  },
  // run an edit on just the range: one undo step, clips split at its edges first
  rangeOp(R, label, fn) {
    if (!(R && R.e - R.s > 0.0005)) return K.toast('Drag across a waveform to select a range first');
    this.commit(label);
    const pieces = this.rangePieces(R);
    fn(pieces);
    this.ui.sel = new Set(pieces.map((x) => x.c.id));
    this.changed({ clips: true }); this.status(label + ': ' + this.rangeLabel(R));
  },
  // copy what is inside the range without touching the song (clips are trimmed to the range in the clipboard)
  copyRange(R) {
    const out = [];
    this.rangeTracks(R).forEach((t, k) => {
      for (const c of t.clips) {
        const s = Math.max(R.s, c.start), e = Math.min(R.e, c.start + c.len); if (e - s < 0.001) continue;
        const n = JSON.parse(JSON.stringify(c)); n.start = s; n.off = c.off + (s - c.start); n.len = e - s;
        n.fi = s === c.start ? Math.min(c.fi, n.len) : 0; n.fo = e === c.start + c.len ? Math.min(c.fo, n.len - n.fi) : 0;
        out.push({ c: n, dt: s - R.s, dti: k });
      }
    });
    if (!out.length) return K.toast('Nothing to copy in that range');
    this.clipboard = out; this.status('Copied ' + this.rangeLabel(R));
    return true;
  },
  cutRange(R) { if (this.copyRange(R)) { this.deleteRange(R, true); this.status('Cut ' + (R.e - R.s).toFixed(3) + ' s — Ctrl+V pastes it at the playhead'); } },
  // keep only the range in the clips it touches (Audacity's Trim Audio)
  trimToRange(R) {
    if (!this.hasRange()) return;
    this.commit('Trim to range');
    for (const t of this.rangeTracks(R)) for (const c of t.clips) {
      const s = Math.max(R.s, c.start), e = Math.min(R.e, c.start + c.len); if (e - s < 0.001) continue;
      const fiKeep = s === c.start, foKeep = e === c.start + c.len;
      c.off += s - c.start; c.start = s; c.len = e - s; c.fi = fiKeep ? Math.min(c.fi, c.len) : 0; c.fo = foKeep ? Math.min(c.fo, c.len - c.fi) : 0;
    }
    this.changed({ clips: true }); this.status('Trimmed to ' + this.rangeLabel(R));
  },
  // Shift-click: stretch the range (or make one from the playhead) to the clicked time and track
  extendRange(t, ti) {
    const R = this.ui.range, P = this.proj;
    const tiSel = Math.max(0, P.tracks.indexOf(this.sel()));
    if (R) { if (Math.abs(t - R.s) < Math.abs(t - R.e)) R.s = t; else R.e = t; if (R.s > R.e) { const x = R.s; R.s = R.e; R.e = x; } R.t0 = Math.min(R.t0, ti); R.t1 = Math.max(R.t1, ti); }
    else { const p = this.eng.pos(); this.ui.range = { s: Math.min(p, t), e: Math.max(p, t), t0: Math.min(tiSel, ti), t1: Math.max(tiSel, ti) }; }
    this.status('Range ' + this.rangeLabel(this.ui.range));
  },
  // [ and ]: set the range start / end at the playhead (works while playing, like in and out points)
  rangeEdgeAtPlayhead(which) {
    const p = this.eng.pos(), P = this.proj;
    let R = this.ui.range;
    if (!R) { const ti = Math.max(0, P.tracks.indexOf(this.sel())); R = this.ui.range = { s: p, e: p, t0: ti, t1: ti }; }
    if (which === 's') { R.s = p; if (R.e < p) R.e = p; } else { R.e = p; if (R.s > p) R.s = p; }
    ARR.dirty = true; if (window.DECK) DECK.dirty = true;
    this.status((which === 's' ? 'Range start ' : 'Range end ') + U.fmtTime(p) + (R.e > R.s ? ' · ' + this.rangeLabel(R) : ' — now press ] at the end'));
  },
  async amplifyRange(R) {
    const v = await K.prompt('Amplify range', 'Gain (dB)', '3'); if (v === null || v === undefined) return;
    const db = U.clamp(parseFloat(v) || 0, -60, 24);
    this.rangeOp(R, 'Amplify ' + (db > 0 ? '+' : '') + db + ' dB', (L) => L.forEach((x) => { x.c.gain = (x.c.gain === undefined ? 1 : x.c.gain) * U.undb(db); }));
  },
  async exportRange(R) {
    if (!this.hasRange()) return;
    K.toast('Rendering the range…');
    const buf = await this.eng.render({ s: R.s, e: R.e });
    const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
    const msg = await PLAT.save((this.proj.name || 'Song').replace(/[^\w\- ]+/g, '') + ' range ' + R.s.toFixed(1) + '-' + R.e.toFixed(1) + 's.wav', new Blob([U.encodeWav(chs, buf.sampleRate, 24)], { type: 'audio/wav' }));
    if (msg) K.toast(msg);
  },
  // the range menu (right-click inside a range, Edit menu, long-press on touch)
  rangeItems(R) {
    const hasAudio = this.rangeTracks(R).some((t) => t.clips.some((c) => c.buf && c.start < R.e && c.start + c.len > R.s));
    return [
      { head: 'Range ' + this.rangeLabel(R) },
      { label: 'Cut', key: 'Ctrl+X', act: () => this.cutRange(R) },
      { label: 'Copy', key: 'Ctrl+C', act: () => this.copyRange(R) },
      { label: 'Delete (close the gap)', key: 'Del', act: () => this.deleteRange(R, true) },
      { label: 'Silence (leave a gap)', key: 'Ctrl+L', act: () => this.deleteRange(R, false) },
      { label: 'Trim to range (keep only this)', act: () => this.trimToRange(R) },
      { label: 'Split at range edges', act: () => this.splitRange(R) },
      { sep: true },
      { label: 'Get noise profile from range', disabled: !hasAudio, act: () => { const err = NR.capture(); if (err) K.toast(err); else { K.toast('Noise profile taken from the range. Now select what to clean and choose Remove noise.'); } } },
      { label: 'Remove noise in range…', disabled: !hasAudio, act: () => NR.dialog() },
      { label: 'Fade in over range', disabled: !hasAudio, act: () => this.rangeOp(R, 'Fade in', (L) => L.forEach((x) => { if (x.c.buf) { x.c.fi = x.c.len; x.c.fo = 0; } })) },
      { label: 'Fade out over range', disabled: !hasAudio, act: () => this.rangeOp(R, 'Fade out', (L) => L.forEach((x) => { if (x.c.buf) { x.c.fo = x.c.len; x.c.fi = 0; } })) },
      { label: 'Amplify range…', disabled: !hasAudio, act: () => this.amplifyRange(R) },
      { label: 'Normalize range to −1 dB', disabled: !hasAudio, act: () => this.rangeOp(R, 'Normalize range', (L) => this.normalize(L, true)) },
      { label: 'Reverse range', disabled: !hasAudio, act: () => this.rangeOp(R, 'Reverse range', (L) => this.reverse(L, true)) },
      { sep: true },
      { label: 'Loop this range', act: () => this.setLoop(R.s, R.e, true) },
      { label: 'Punch-record this range', act: () => { this.commit('Punch range'); this.proj.punch = { on: true, s: R.s, e: R.e }; this.changed({ transport: true }); } },
      { label: 'Insert silence of this length', act: () => this.insertSilence(R) },
      { label: 'Zoom to range', act: () => ARR.zoomRange(R) },
      { label: 'Export range as WAV', act: () => this.exportRange(R) },
    ];
  },
  splitRange(R) { this.commit('Split range'); for (const t of this.rangeTracks(R)) for (const c of t.clips.slice()) { const n = this.splitClip(t, c, R.s); this.splitClip(t, n || c, R.e); } this.changed({ clips: true }); },
  deleteRange(R, ripple) {
    this.commit(ripple ? 'Delete range (ripple)' : 'Delete range');
    const len = R.e - R.s;
    for (const t of this.rangeTracks(R)) {
      for (const c of t.clips.slice()) { const n = this.splitClip(t, c, R.s); this.splitClip(t, n || c, R.e); }
      t.clips = t.clips.filter((c) => !(c.start >= R.s - 1e-6 && c.start + c.len <= R.e + 1e-6));
      if (ripple) {
        t.clips.forEach((c) => { if (c.start >= R.e - 1e-6) c.start -= len; });
        for (const k of ['vol', 'pan']) { const env = t.env[k]; env.pts = env.pts.filter((p) => p.t < R.s || p.t > R.e).map((p) => (p.t > R.e ? { t: p.t - len, v: p.v } : p)); }
      }
    }
    this.ui.range = null; this.changed({ clips: true });
  },
  insertSilence(R) {
    this.commit('Insert silence');
    const len = R.e - R.s;
    for (const t of this.rangeTracks(R)) {
      for (const c of t.clips.slice()) this.splitClip(t, c, R.s);
      t.clips.forEach((c) => { if (c.start >= R.s - 1e-6) c.start += len; });
      for (const k of ['vol', 'pan']) t.env[k].pts.forEach((p) => { if (p.t >= R.s) p.t += len; });
    }
    this.changed({ clips: true });
  },
  // ---------- markers ----------
  addMarker(t) {
    this.commit('Add marker');
    const P = this.proj; P.markers.push({ t, name: 'M' + (P.markers.length + 1) }); P.markers.sort((a, b) => a.t - b.t);
    this.changed({}); this.status('Marker added — double-click the ruler to add more');
  },
  jumpMarker(dir) {
    const p = this.eng.pos(), ms = this.proj.markers.map((m) => m.t).concat([0, M.songEnd(this.proj)]).sort((a, b) => a - b);
    const t = dir > 0 ? ms.find((m) => m > p + 0.01) : ms.reverse().find((m) => m < p - 0.05);
    if (t !== undefined) this.locate(t);
  },
  // ---------- import ----------
  async importAudio(files) {
    files = files || (await U.pickFile('audio/*,.wav,.mp3,.ogg,.flac,.m4a,.aif,.aiff,.edk,.json', true));
    if (!files.length) return;
    const suite = files.filter((f) => this.isSuiteFile(f));
    for (const f of suite) await this.importSuiteFile(f);
    files = files.filter((f) => !this.isSuiteFile(f));
    if (!files.length) return;
    const P = this.proj, at = this.eng.pos();
    let ti = Math.max(0, P.tracks.indexOf(this.sel()));
    this.commit('Import audio');
    let ok = 0;
    for (const f of files) {
      this.status('Decoding ' + f.name + '…');
      try {
        const ab = await this.eng.decodeFile(f);
        const id = this.eng.addBuffer(ab, f.name);
        if (!P.tracks[ti]) P.tracks.push(M.newTrack(P.tracks.length));
        const t = P.tracks[ti];
        if (!t.clips.length) { t.stereo = ab.numberOfChannels > 1; t.input = t.stereo ? '1+2' : '1'; if (/^Track \d+$/.test(t.name)) t.name = f.name.replace(/\.[^.]+$/, '').slice(0, 24); }
        t.clips.push({ id: U.uid('c'), buf: id, start: at, off: 0, len: ab.duration, gain: 1, fi: 0, fo: 0, name: f.name.replace(/\.[^.]+$/, '') });
        ok++; ti++;
      } catch (e) { K.toast('Could not read ' + f.name, 3500); }
    }
    this.changed({ graph: true, heads: true, clips: true, console: true });
    this.status('Imported ' + ok + ' file' + (ok === 1 ? '' : 's'));
  },
  dropZone() {
    const d = K.h('div', { class: 'drop' }, 'Drop it right in!'); document.body.append(d);
    let n = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) { n++; d.classList.add('show'); e.preventDefault(); } });
    window.addEventListener('dragleave', () => { if (--n <= 0) { n = 0; d.classList.remove('show'); } });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => {
      e.preventDefault(); n = 0; d.classList.remove('show');
      const files = Array.from(e.dataTransfer.files || []);
      const proj = files.find((f) => /\.(dawters|zip)$/i.test(f.name));
      if (proj) return this.openProject(proj);
      if (files.length) this.importAudio(files);
    });
  },
  // ---------- project files ----------
  async newProject() {
    if (this.proj.tracks.some((t) => t.clips.length) && !(await K.confirm('New song', 'Start a new song? Save this one first if you want to keep it (File → Save song).', 'Start new'))) return;
    await this.stop();
    this.load(M.newProject(this.eng.sr));
    this.eng.buffers.clear(); try { await U.idb.clear('buffers'); } catch (e) { /* */ }
    this.saveNow(); K.toast('New song');
  },
  async renameSong() { const v = await K.prompt('Song name', 'Name', this.proj.name); if (v) { this.commit('Rename song'); this.proj.name = v; this.refreshAll(); this.save(); } },
  async saveProject() {
    this.status('Packing song…');
    SUITE.flush();
    await PLUG.flush();
    const used = M.bufRefs(this.proj);
    const files = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(this.proj, null, 1)) }];
    for (const id of used) {
      const b = this.eng.buffers.get(id); if (!b) continue;
      const chs = []; for (let c = 0; c < b.ab.numberOfChannels; c++) chs.push(b.ab.getChannelData(c));
      files.push({ name: 'audio/' + id + '.wav', data: U.encodeWav(chs, b.ab.sampleRate, 32) });
      files.push({ name: 'audio/' + id + '.txt', data: new TextEncoder().encode(b.name || '') });
    }
    const blob = U.zip(files);
    const msg = await PLAT.save(this.proj.name.replace(/[\\/:*?"<>|]+/g, '_') + '.dawters', blob);
    this.status(msg || 'Save cancelled'); if (msg) K.toast(msg);
  },
  async openProject(file) {
    if (!file) { const f = await U.pickFile('.dawters,.zip,application/zip,application/octet-stream'); file = f[0]; if (!file) return; }
    try {
      this.status('Opening ' + file.name + '…');
      const z = await U.unzip(file);
      const p = M.migrate(JSON.parse(new TextDecoder().decode(z['project.json'])));
      if (!p || p.v !== 1) throw new Error('Not a DAWters song');
      await this.stop();
      this.eng.buffers.clear(); await U.idb.clear('buffers');
      for (const k in z) {
        const m = k.match(/^audio\/(.+)\.wav$/); if (!m) continue;
        const w = U.decodeWav(z[k]); if (!w) continue;
        const nm = z['audio/' + m[1] + '.txt'] ? new TextDecoder().decode(z['audio/' + m[1] + '.txt']) : m[1];
        this.eng.addBuffer(this.eng.makeBuffer(w.ch, w.sr), nm, m[1]);
      }
      p.tracks.forEach((t) => (t.clips = t.clips.filter((c) => !c.buf || this.eng.buffers.has(c.buf))));
      this.load(p); this.saveNow();
      K.toast('Opened ' + p.name); this.status('Opened ' + file.name);
    } catch (e) { K.toast('Could not open: ' + (e.message || e), 4000); }
  },
  // ---------- export: mix / stems / bus stems, mastered to a loudness target, WAV or ffmpeg-compressed ----------
  exportDialog(pre) {
    const h = K.h, P = this.proj, end = M.songEnd(P);
    if (end <= 0) return K.toast('Nothing to export yet — record or import some audio');
    let last = {}; try { last = JSON.parse(localStorage.getItem('dawters.export') || '{}'); } catch (e) { /* */ }
    const o = Object.assign({ what: 'mix', fmt: 'wav24', sr: String(this.eng.sr), tail: 1, loud: 'mix', artist: '' }, last, { range: P.loop.on ? 'loop' : 'song', title: P.name }, pre || {});
    if (!ENC.FORMATS[o.fmt]) o.fmt = 'wav24';
    const prog = h('div', { class: 'prog' }, h('i')), note = h('div', { class: 'note' }), size = h('div', { class: 'note size' });
    const t = MST.target();
    const usedBuses = P.buses.map((b, i) => i).filter((i) => P.tracks.some((x) => x.out === 'bus' + i || (x.sends[i] && x.sends[i].lvl > 0)));
    const span = () => { if (o.range === 'loop') return P.loop.e - P.loop.s; if (o.range === 'sel' && this.ui.range) return this.ui.range.e - this.ui.range.s; return end; };
    const files = () => (o.what === 'mix' ? 1 : 0) + (o.what === 'stems' || o.what === 'all' ? P.tracks.filter((x) => x.clips.length).length : 0) + (o.what === 'buses' || o.what === 'all' ? usedBuses.length : 0);
    const upd = () => {
      const n = files(), secs = span() + o.tail;
      size.textContent = 'About ' + ENC.fmtSize(ENC.estimate(o.fmt, secs, +o.sr) * n) + (n > 1 ? ' for ' + n + ' files, zipped' : '') + ' · ' + secs.toFixed(1) + ' s';
      note.textContent = o.what !== 'mix' && o.loud === 'target' ? 'Stems and bus stems skip the master, so they are not loudness-matched; only the mix is mastered.' : ENC.isWav(o.fmt) ? 'Renders offline through the full console — faster than real time.' : 'Encoded with ffmpeg after the render. Smaller files; a little quality traded for size.';
      meta.style.display = ENC.isWav(o.fmt) ? 'none' : '';
    };
    const fmtSel = K.select(Object.entries(ENC.FORMATS).map(([k, v]) => [k, v[0]]), o.fmt, (v) => { o.fmt = v; upd(); });
    const ti = h('input', { type: 'text', value: o.title, oninput: (e) => (o.title = e.target.value) });
    const ar = h('input', { type: 'text', value: o.artist, placeholder: 'Artist', oninput: (e) => (o.artist = e.target.value) });
    const meta = h('div', { class: 'meta2' }, K.row('Title', ti), K.row('Artist', ar));
    const whatOpts = [['mix', 'Stereo mix'], ['stems', 'Stems — every track (zip)']];
    if (usedBuses.length) whatOpts.push(['buses', 'Bus stems — each mixbus (zip)'], ['all', 'Everything — mix, stems and buses (zip)']);
    else whatOpts.push(['all', 'Mix and stems (zip)']);
    const d = K.dialog('Export', [
      K.row('What', K.select(whatOpts, o.what, (v) => { o.what = v; upd(); })),
      K.row('Range', K.select([['song', 'Whole song (' + end.toFixed(1) + ' s)'], ['loop', 'Loop region'], ['sel', 'Selected range']], o.range, (v) => { o.range = v; upd(); })),
      K.row('Format', fmtSel),
      K.row('Loudness', K.select([['mix', 'As mixed'], ['target', 'Master to ' + t[0].replace(' · ', ' ') + ', ' + t[2] + ' dBTP'], ['-1', 'Normalise peak to −1 dBFS'], ['-0.3', 'Normalise peak to −0.3 dBFS']], o.loud, (v) => { o.loud = v; upd(); })),
      K.row('Sample rate', K.select([[String(this.eng.sr), this.eng.sr + ' Hz (project)'], ['44100', '44100 Hz'], ['48000', '48000 Hz'], ['96000', '96000 Hz']], o.sr, (v) => { o.sr = v; upd(); })),
      K.row('Tail', K.select([[0, 'None'], [1, '1 s'], [3, '3 s'], [6, '6 s']], o.tail, (v) => { o.tail = +v; upd(); })),
      meta, size, note, prog,
    ], [{ label: 'Close' }, { label: 'Export', primary: true, act: async () => { try { localStorage.setItem('dawters.export', JSON.stringify({ what: o.what, fmt: o.fmt, sr: o.sr, tail: o.tail, loud: o.loud, artist: o.artist })); } catch (e) { /* */ } await this.runExport(o, prog.firstChild, note); return false; } }]);
    upd();
    return d;
  },
  async runExport(o, bar, note) {
    const P = this.proj, end = M.songEnd(P), E = this.eng;
    let s = 0, e = end;
    if (o.range === 'loop') { s = P.loop.s; e = P.loop.e; }
    if (o.range === 'sel') { if (!this.ui.range) { note.textContent = 'No range selected — drag across the tracks to make one.'; return; } s = this.ui.range.s; e = this.ui.range.e; }
    if (e - s < 0.01) { note.textContent = 'That range is empty.'; return; }
    if (E.playing) await this.stop();
    const sr = +o.sr, safe = (o.title || P.name).replace(/[\\/:*?"<>|]+/g, '_') || 'Untitled', ext = ENC.ext(o.fmt), wav = ENC.isWav(o.fmt);
    const meta = { title: o.title || P.name, artist: o.artist, comment: 'Made with DAWters and Son' };
    const pct = (v) => (bar.style.width = Math.round(v * 100) + '%');
    // buffer -> file bytes in the chosen format
    const toFile = async (buf, norm, title, p0, p1) => {
      const chs = [buf.getChannelData(0), buf.getChannelData(1)];
      if (norm) { let pk = 0; for (const d of chs) for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > pk) pk = a; } if (pk > 1e-6) { const g = U.undb(norm) / pk; for (const d of chs) for (let i = 0; i < d.length; i++) d[i] *= g; } }
      if (wav) return new Uint8Array(U.encodeWav(chs, sr, ENC.bits(o.fmt), ENC.bits(o.fmt) === 16));
      const src = U.encodeWav(chs, sr, 24, false);
      return ENC.encode(src, o.fmt, Object.assign({}, meta, { title }), (p) => pct(p0 + (p1 - p0) * p), (t) => (note.textContent = t));
    };
    const peakNorm = o.loud === '-1' || o.loud === '-0.3' ? +o.loud : 0;
    pct(0.03);
    try {
      const out = []; let report = '';
      const tracks = o.what === 'stems' || o.what === 'all' ? P.tracks.filter((t) => t.clips.length) : [];
      const buses = o.what === 'buses' || o.what === 'all' ? P.buses.map((b, i) => i).filter((i) => P.tracks.some((x) => x.out === 'bus' + i || (x.sends[i] && x.sends[i].lvl > 0))) : [];
      const jobs = (o.what === 'mix' || o.what === 'all' ? 1 : 0) + tracks.length + buses.length;
      let done = 0; const step = () => done / jobs;
      if (o.what === 'mix' || o.what === 'all') {
        let buf, st;
        if (o.loud === 'target') {
          const t = MST.target();
          st = await MST.fit({ s, e }, sr, o.tail, t[1], t[2], (m) => (note.textContent = m));
          buf = st.buf;
        } else { note.textContent = 'Rendering the mix…'; buf = await E.render({ s, e, sr, tail: o.tail }); }
        pct(0.03 + 0.5 * (1 / jobs));
        const data = await toFile(buf, peakNorm, meta.title, step() + 0.5 / jobs, step() + 1 / jobs);
        st = st || MST.stats(buf);
        report = ' — ' + (st.I > -70 ? st.I.toFixed(1) + ' LUFS, ' : '') + st.tp.toFixed(1) + ' dBTP' + (o.loud === 'target' ? ' (drive ' + (st.drive >= 0 ? '+' : '') + st.drive.toFixed(1) + ' dB)' : '');
        out.push({ name: safe + '.' + ext, data }); done++; pct(step());
      }
      for (let i = 0; i < tracks.length; i++) {
        note.textContent = 'Rendering stem ' + (i + 1) + ' of ' + tracks.length + ': ' + tracks[i].name;
        const buf = await E.render({ s, e, sr, tail: o.tail, solo: tracks[i].id, bypassMaster: true });
        const nm = String(i + 1).padStart(2, '0') + ' ' + tracks[i].name.replace(/[\\/:*?"<>|]+/g, '_');
        out.push({ name: 'Stems/' + nm + '.' + ext, data: await toFile(buf, peakNorm, nm, step(), step() + 1 / jobs) }); done++; pct(step());
      }
      for (const bi of buses) {
        const b = P.buses[bi]; note.textContent = 'Rendering bus stem: ' + b.name;
        const buf = await E.render({ s, e, sr, tail: o.tail, busOnly: new Set([bi]), only: new Set(), bypassMaster: true });
        const nm = 'Bus ' + (bi + 1) + ' ' + b.name.replace(/[\\/:*?"<>|]+/g, '_');
        out.push({ name: 'Buses/' + nm + '.' + ext, data: await toFile(buf, peakNorm, nm, step(), step() + 1 / jobs) }); done++; pct(step());
      }
      let msg, total = out.reduce((a, f) => a + f.data.length, 0);
      if (out.length === 1) msg = await PLAT.save(out[0].name, new Blob([out[0].data], { type: ENC.MIME[ext] }));
      else msg = await PLAT.save(safe + (o.what === 'stems' ? ' stems' : o.what === 'buses' ? ' bus stems' : ' export') + '.zip', U.zip(out));
      pct(1);
      note.textContent = (msg || 'Cancelled') + (msg ? ' · ' + ENC.fmtSize(total) + (out.length > 1 ? ' in ' + out.length + ' files' : '') + report : '');
    } catch (err) { console.error(err); note.textContent = 'Export failed: ' + (err.message || err); }
  },
  lufs(chs, sr) { // BS.1770-4 integrated loudness
    const kf = (fs) => {
      let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196, K2 = Math.tan(Math.PI * f0 / fs), Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416), a0 = 1 + K2 / Q + K2 * K2;
      const pre = [(Vh + Vb * K2 / Q + K2 * K2) / a0, 2 * (K2 * K2 - Vh) / a0, (Vh - Vb * K2 / Q + K2 * K2) / a0, 2 * (K2 * K2 - 1) / a0, (1 - K2 / Q + K2 * K2) / a0];
      f0 = 38.13547087602444; Q = 0.5003270373238773; K2 = Math.tan(Math.PI * f0 / fs); const b0 = 1 + K2 / Q + K2 * K2;
      return [pre, [1, -2, 1, 2 * (K2 * K2 - 1) / b0, (1 - K2 / Q + K2 * K2) / b0]];
    };
    const [p1, p2] = kf(sr), n = chs[0].length, blk = Math.round(sr * 0.1);
    const sub = new Float64Array(Math.ceil(n / blk));
    for (const d of chs) {
      let z1 = 0, z2 = 0, w1 = 0, w2 = 0;
      for (let i = 0; i < n; i++) {
        const x = d[i]; let y = p1[0] * x + z1; z1 = p1[1] * x - p1[3] * y + z2; z2 = p1[2] * x - p1[4] * y;
        const u = p2[0] * y + w1; w1 = p2[1] * y - p2[3] * u + w2; w2 = p2[2] * y - p2[4] * u;
        sub[(i / blk) | 0] += u * u;
      }
    }
    const L = (e) => -0.691 + 10 * Math.log10(e + 1e-20);
    const blocks = []; for (let i = 3; i < sub.length; i++) blocks.push((sub[i] + sub[i - 1] + sub[i - 2] + sub[i - 3]) / (4 * blk));
    const a = blocks.filter((e) => L(e) > -70); if (!a.length) return -Infinity;
    const rel = L(a.reduce((x, y) => x + y, 0) / a.length) - 10, g = a.filter((e) => L(e) > rel);
    return g.length ? L(g.reduce((x, y) => x + y, 0) / g.length) : -Infinity;
  },
  // ---------- FX editor ----------
  fxOwnerName(o) { return o === this.proj.master ? 'Master' : o.name; },
  openFx(o, k) {
    const f = o.fx[k]; if (!f) return;
    this.closeFx();
    if (FX.types[f.type].suite) { SUITE.show(f.id); return; } // Eleosynth Pedalboard: its own editor
    if (FX.types[f.type].plugin) { this.openPlugFx(o, k); return; } // a VST3 plug-in: its own window
    const def = FX.types[f.type], h = K.h, G = () => this.eng.graph.refreshFx(o), title = def.name + ' · ' + this.fxOwnerName(o);
    const kids = def.params.map((s) => {
      if (s.opts) {
        const sel = K.select(s.opts.map((x, i) => [i, x]), f.p[s.k], (v) => { this.commit(def.short + ' ' + s.n, true); f.p[s.k] = +v; G(); AUD.update(f); this.save(); });
        return h('div', { class: 'opt' }, K.row(s.n, sel));
      }
      return K.knob(Object.assign({}, s, { get: () => f.p[s.k], begin: () => this.commit(def.short + ' ' + s.n, true), set: (v, fin) => { f.p[s.k] = v; G(); AUD.update(f); if (fin) this.save(); } }));
    });
    let timer = null;
    if (AUD.cur && AUD.cur.f !== f) AUD.stop();
    kids.unshift(AUD.bar(o, f));
    if (def.about) kids.unshift(h('div', { class: 'opt note fx-about' }, def.about));
    if (def.gr || def.create.toString().includes('gr:')) { // dynamics: live gain-reduction readout (per band for the multiband)
      const rows = (f.type === 'mband' ? ['LOW', 'MID', 'HIGH'] : ['GAIN REDUCTION']).map((lab) => { const bar = h('i'), val = h('span', null, '0.0 dB'); kids.push(h('div', { class: 'opt fx-gr' }, h('span', null, lab), h('div', { class: 'grbar' }, bar), val)); return { bar, val }; });
      timer = setInterval(() => {
        const n = AUD.active(f) && AUD.cur.fx ? AUD.cur.fx : this.eng.graph.fxNode(f.id); const b = n && n.bands && n.bands();
        const ds = rows.length > 1 ? (b || [0, 0, 0]).map((x) => -x) : [n && n.gr ? -n.gr() : 0];
        rows.forEach((r, i) => { const d = ds[i] || 0; r.bar.style.width = Math.min(100, d / 24 * 100) + '%'; r.val.textContent = '-' + d.toFixed(1) + ' dB'; });
      }, 60);
    }
    const acts = [
      { label: f.on ? 'Switch off' : 'Switch on', act: () => { this.commit('FX bypass'); f.on = !f.on; this.changed({ graph: true, console: true }); this.openFx(o, k); return false; } },
      { label: 'Remove', act: () => { AUD.stop(); this.commit('Remove FX'); o.fx.splice(k, 1); this.changed({ graph: true, console: true }); } },
      { label: 'Done', primary: true },
    ];
    const onClose = () => { this.fxWin = null; clearInterval(timer); if (AUD.active(f)) AUD.stop(); };
    if (K.isTouch() || this.ui.view === 'deck') {
      kids.forEach((kn) => kn.classList && kn.classList.contains('knob') && kn.classList.add('lg'));
      this.fxWin = K.sheet(title, kids, acts, { grid: true, light: true, onClose });
      return;
    }
    const r = document.querySelector('.strip[data-id="' + (o.id || 'master') + '"]');
    const x = r ? Math.min(innerWidth - 360, r.getBoundingClientRect().right + 10) : 120;
    this.fxWin = K.dialog(title, kids, acts, { float: true, x, y: 110, onClose });
  },
  // a VST3 insert: a small panel (status, its window, on/off, remove); the plug-in's controls are in its own window
  openPlugFx(o, k) {
    const f = o.fx[k], h = K.h, plug = f.plug;
    const st = h('div', { class: 'note' }, 'Starting…');
    const show = () => {
      const w = PLUG.liveFor(f);
      if (!PLUG.ok) st.textContent = 'This song uses ' + PLUG.label(plug) + '. VST3 plug-ins run in the desktop app (Mac, Windows, Linux); here it is passed through untouched.';
      else if (!w) st.textContent = f.on ? 'Not running.' : 'Switched off.';
      else if (w.error) st.textContent = 'Could not load: ' + w.error + '. Check it is still installed, then rescan in Settings › Plug-ins.';
      else if (!w.id) st.textContent = 'Loading ' + plug.name + '…';
      else st.textContent = 'Running in its own process' + (w.info && w.info.latency ? ' · adds ' + (w.info.latency / this.eng.sr * 1000).toFixed(1) + ' ms (compensated)' : '') + (w.late ? ' · ' + w.late + ' late blocks — raise the plug-in buffer in Settings if you hear clicks' : '') + '.';
    };
    show(); const timer = setInterval(show, 500);
    const kids = [h('div', { style: 'grid-column:1/-1;display:flex;flex-direction:column;gap:10px;min-width:0' }, h('div', { class: 'note' }, PLUG.label(plug)), st)];
    const acts = [
      { label: 'Plug-in window', primary: true, act: () => { PLUG.openEditor(f); return false; } },
      { label: f.on ? 'Switch off' : 'Switch on', act: () => { this.commit('FX bypass'); f.on = !f.on; this.changed({ graph: true, console: true }); this.openFx(o, k); return false; } },
      { label: 'Remove', act: () => { this.commit('Remove FX'); o.fx.splice(k, 1); this.changed({ graph: true, console: true }); } },
      { label: 'Done' },
    ];
    const onClose = () => { this.fxWin = null; clearInterval(timer); };
    this.fxWin = K.isTouch() ? K.sheet(plug.name + ' · ' + this.fxOwnerName(o), kids, acts, { light: true, onClose }) : K.dialog(plug.name + ' · ' + this.fxOwnerName(o), kids, acts, { float: true, x: 140, y: 110, onClose, width: 'min(520px,100%)' });
    if (PLUG.ok && f.on) PLUG.openEditor(f);
  },
  // VST3 plug-ins in the add-an-effect / add-a-track menus
  plugFxItems(o, k, replace) {
    if (!PLUG.ok) return [];
    const items = [{ head: 'VST3 plug-ins' }];
    const add = (p) => { this.commit('Insert plug-in'); const nf = { id: U.uid('f'), type: 'vst3', on: true, p: {}, plug: { path: p.path, cid: p.cid, name: p.name, vendor: p.vendor }, state: null }; if (replace) o.fx[k] = nf; else o.fx.push(nf); this.changed({ graph: true, console: true }); DECK.render(); ARR.renderHeads(); this.openFx(o, replace ? k : o.fx.length - 1); };
    const fx = PLUG.effects();
    if (!fx.length) items.push({ label: PLUG.list.length ? 'No effects found' : 'Find my plug-ins…', act: async () => { await PLUG.scan(); } });
    else {
      // group by maker when there are many
      const byV = new Map(); fx.forEach((p) => { const v = p.vendor || 'Other'; if (!byV.has(v)) byV.set(v, []); byV.get(v).push(p); });
      if (fx.length <= 14) fx.forEach((p) => items.push({ label: p.name, act: () => add(p) }));
      else for (const [v, list] of byV) items.push({ label: v + ' ›', sub: list.map((p) => ({ label: p.name, act: () => add(p) })), act: (e) => K.menu([{ head: v }, ...list.map((p) => ({ label: p.name, act: () => add(p) }))], innerWidth / 2 - 120, 120) });
      items.push({ label: 'Rescan plug-ins…', act: () => PLUG.scan() });
    }
    return items;
  },
  plugInstItems() {
    if (!PLUG.ok) return [];
    const ins = PLUG.instruments();
    if (!ins.length) return [{ label: 'Add VST3 instrument track… (find my plug-ins)', act: async () => { await PLUG.scan(); if (PLUG.instruments().length) K.menu([{ head: 'VST3 instruments' }, ...this.plugInstList()], innerWidth / 2 - 120, 120); } }];
    return [{ label: 'Add VST3 instrument track…', act: () => K.menu([{ head: 'VST3 instruments' }, ...this.plugInstList()], innerWidth / 2 - 120, 120) }];
  },
  plugInstList() { return PLUG.instruments().map((p) => ({ label: p.name + (p.vendor ? ' — ' + p.vendor : ''), act: () => this.addPlugInstTrack(p) })); },
  addPlugInstTrack(p) {
    const inst = INST.make('vst3'); inst.plug = { path: p.path, cid: p.cid, name: p.name, vendor: p.vendor };
    const t = this.addTrack({ kind: 'inst', inst, stereo: true, input: '1+2', name: p.name.slice(0, 24) });
    this.newPatternFor(t, true);
    this.ui.patTrack = t.id;
    setTimeout(() => PLUG.openEditor(t.inst), 300);
    return t;
  },
  // grouped "add an effect" items
  fxItems(o, k, replace) {
    const items = [];
    for (const [g, all] of FX.GROUPS) {
      const keys = all.filter((key) => !FX.types[key].suite || SUITE.has(FX.types[key].suite)); if (!keys.length) continue;
      items.push({ head: g });
      for (const key of keys) if (!FX.types[key].plugin) items.push({ label: FX.types[key].name, act: () => { this.commit('Insert FX'); const nf = { id: U.uid('f'), type: key, on: true, p: FX.defaults(key) }; if (replace) o.fx[k] = nf; else o.fx.push(nf); this.changed({ graph: true, console: true }); DECK.render(); ARR.renderHeads(); this.openFx(o, replace ? k : o.fx.length - 1); } });
    }
    return items.concat(this.plugFxItems(o, k, replace));
  },
  closeFx() { if (this.fxWin) { this.fxWin.close(); this.fxWin = null; } },
  setInput(t, v) { this.commit('Track input'); t.input = v; t.stereo = v === '1+2'; this.changed({ graph: true, heads: true, console: true }); this.eng.updateMonitors(); },
  // ---------- quick idea: one tap grabs a free track and records ----------
  // ---------- capture: nothing was recording, but DAWters was listening ----------
  // Notes from any instrument (keyboard, MIDI, Eleosynth's own keys) and the open input are kept for the last
  // minute or so. Capture pulls the last phrase — everything since a silence of a few seconds — into the song.
  async capture() {
    const E = this.eng, P = this.proj, GAP = 6;
    const out = [];
    // ---- notes ----
    const ev = E.capNotes(GAP);
    if (ev) {
      const live = ev.filter((e) => e[1]).every((e) => E.songAt(e[0]) !== null);
      const at = E.playing ? null : E.position, c0 = ev[0][0];
      const notes = ev.map((e) => [live ? E.songAt(e[0]) : at + (e[0] - c0), e[1], e[2], e[3], e[4]]);
      const ons = notes.filter((x) => x[1]);
      const recStart = Math.max(0, Math.min(...ons.map((x) => x[0])));
      const end = Math.max(...notes.map((x) => x[0])) + 0.05;
      const tracks = [...new Set(ev.map((e) => e[4]))].filter((id) => P.tracks.some((t) => t.id === id));
      const made = this.applyMidiTake({ notes, recStart, end, tracks, label: 'Capture', quiet: true });
      if (made) { out.push(made + ' pattern' + (made === 1 ? '' : 's')); E.cap.splice(E.cap.length - ev.length, ev.length); }
    }
    // ---- audio from the open input ----
    if (E.input) {
      const g = await E.grabAudio();
      const seg = g && this.capSegment(g.ch, E.sr, GAP);
      if (seg) {
        const P2 = this.proj;
        let t = P2.tracks.find((x) => x.kind === 'audio' && x.arm) || P2.tracks.find((x) => x.kind === 'audio' && x.mon);
        if (!out.length) this.commit('Capture');
        if (!t) { t = M.newTrack(P2.tracks.length, { name: 'Capture ' + (P2.tracks.filter((x) => /^Capture \d+$/.test(x.name)).length + 1), stereo: E.input.nch > 1, input: E.input.nch > 1 ? '1+2' : '1' }); const used = new Set(P2.tracks.map((x) => x.color)); t.color = M.COLORS.find((c) => !used.has(c)) || t.color; P2.tracks.push(t); }
        const chs = E.chanFor(t).map((c) => g.ch[c] || g.ch[0]);
        const ab = E.makeBuffer(chs.map((c) => c.slice(seg[0], seg[1])), E.sr);
        const ct = g.c0 + seg[0] / E.sr - g.lat, sp = E.songAt(ct);
        const start = sp !== null ? Math.max(0, sp) : E.position;
        const id = E.addBuffer(ab, t.name + ' capture');
        t.clips.push({ id: U.uid('c'), buf: id, start, off: 0, len: ab.duration, gain: 1, fi: 0.005, fo: 0.02, name: t.name + ' capture' });
        this.ui.selTrack = t.id;
        this.changed({ graph: true, heads: true, clips: true, console: true });
        out.push(U.fmtTime ? U.fmtTime(ab.duration) + ' of audio' : ab.duration.toFixed(1) + ' s of audio');
      }
    }
    if (!out.length) {
      K.toast(E.input ? 'Nothing to capture yet — play something, then press Capture.' : 'Nothing to capture yet. Notes are always caught; for audio, turn on Track → Listen for Capture (or arm/monitor a track).', 4500);
      return;
    }
    K.toast('Captured ' + out.join(' and '));
    this.status('Captured ' + out.join(' and '));
  },
  // the last loud stretch of a capture buffer: [start, end) samples, or null if it's all quiet
  capSegment(ch, sr, gap) {
    const W = Math.round(sr * 0.05), n = ch[0].length, nw = Math.floor(n / W); if (nw < 2) return null;
    const thr = U.undb(-48), loud = new Uint8Array(nw);
    for (let w = 0; w < nw; w++) { let m = 0; for (const c of ch) { const d = c; for (let i = w * W, e = i + W; i < e; i++) { const a = Math.abs(d[i]); if (a > m) m = a; } } loud[w] = m > thr ? 1 : 0; }
    let last = nw - 1; while (last >= 0 && !loud[last]) last--;
    if (last < 0) return null;
    const gw = Math.round(gap / 0.05); let first = last, quiet = 0;
    for (let w = last; w >= 0; w--) { if (loud[w]) { first = w; quiet = 0; } else if (++quiet > gw) break; }
    const pad = Math.round(0.3 * sr);
    return [Math.max(0, first * W - pad), Math.min(n, (last + 1) * W + pad)];
  },
  async setCaptureListen(on) {
    this.settings.capListen = on; this.saveSettings();
    if (on) { try { await this.eng.openInput(); K.toast('Listening — press Capture (Shift+C) to keep what you just played'); } catch (e) { K.toast(e.message || 'Could not open the input', 4000); } }
    else if (!this.proj.tracks.some((t) => (t.arm && t.kind === 'audio') || t.mon)) this.eng.closeInput();
  },
  // ---------- freeze: print a track (instrument, beat or effects) to audio and mute the original ----------
  async freeze(t) {
    if (t.frozen) return this.unfreeze(t);
    const P = this.proj, before = new Set(P.tracks.map((x) => x.id));
    await this.bounce([t.id], 'mute');
    const nt = P.tracks.find((x) => !before.has(x.id)); if (!nt) return;
    nt.name = (t.name + ' (frozen)').slice(0, 40); nt.frozenFrom = t.id; nt.color = t.color; t.frozen = nt.id;
    this.changed({ heads: true, console: true, clips: true });
    K.toast('Froze “' + t.name + '” to audio — the original is muted. Unfreeze from the Track menu to edit it again.', 4500);
  },
  unfreeze(t) {
    const P = this.proj; this.commit('Unfreeze');
    P.tracks = P.tracks.filter((x) => !(x.id === t.frozen || x.frozenFrom === t.id));
    t.mute = false; delete t.frozen;
    this.ui.selTrack = t.id;
    this.changed({ graph: true, heads: true, clips: true, console: true });
    this.status('Unfroze ' + t.name);
  },
  async quickIdea() {
    const E = this.eng;
    if (E.recording) return this.stop();
    if (E.playing) await this.stop();
    const P = this.proj;
    let t = P.tracks.find((x) => !x.clips.length);
    if (!t) t = this.addTrack();
    P.tracks.forEach((x) => (x.arm = x === t));
    this.selectTrack(t.id);
    ARR.renderHeads(); CON.render(); DECK.render();
    this.status('Quick idea on ' + t.name);
    await this.record();
  },
  // ---------- bounce: mix tracks through their strips and effects down to one new track ----------
  bounceDialog(pre) {
    const P = this.proj, h = K.h;
    const cands = P.tracks.filter((t) => t.clips.length);
    if (!cands.length) return K.toast('Nothing to bounce yet');
    const busUsed = P.buses.map((b, i) => i).filter((i) => P.tracks.some((x) => x.clips.length && (x.out === 'bus' + i || (x.sends[i] && x.sends[i].lvl > 0))));
    const chosen = new Set(pre || cands.map((t) => t.id)), buses = new Set();
    let after = 'mute';
    const chip = (key, set, label, color) => {
      const b = h('button', { class: 'bn-t' + (set.has(key) ? ' on' : ''), style: '--tc:' + color, 'aria-pressed': set.has(key) ? 'true' : 'false' }, label);
      b.addEventListener('click', () => { if (set.has(key)) set.delete(key); else set.add(key); b.classList.toggle('on', set.has(key)); b.setAttribute('aria-pressed', set.has(key) ? 'true' : 'false'); });
      return b;
    };
    const list = h('div', { class: 'bn-list' }, cands.map((t) => chip(t.id, chosen, t.name, t.color)));
    const blist = busUsed.length ? h('div', { class: 'bn-list' }, busUsed.map((i) => chip(i, buses, P.buses[i].name, P.buses[i].color))) : null;
    const aft = K.select([['mute', 'Mute the originals'], ['delete', 'Delete the original tracks'], ['keep', 'Leave the originals playing']], after, (v) => (after = v));
    const note = h('div', { class: 'note' }, 'Tracks go through their own strips and inserts. A mixbus bounce prints everything feeding that bus, through the bus strip. The master stays out of it, so you can keep mixing the bounce.');
    const body = [h('div', { class: 'sh-sub' }, 'Tracks'), list, blist ? h('div', { class: 'sh-sub' }, 'Mixbuses') : null, blist, K.row('Afterwards', aft), note].filter(Boolean);
    const go = async () => { if (!chosen.size && !buses.size) { K.toast('Pick at least one track or bus'); return false; } await this.bounce(Array.from(chosen), after, Array.from(buses)); };
    if (K.isTouch() || this.ui.view === 'deck') K.sheet('Bounce', body, [{ label: 'Cancel' }, { label: 'Bounce', primary: true, act: go }], { light: true });
    else K.dialog('Bounce', body, [{ label: 'Cancel' }, { label: 'Bounce', primary: true, act: go }]);
  },
  async bounce(ids, after, busIds) {
    const P = this.proj, E = this.eng, set = new Set(ids), bset = new Set(busIds || []);
    const tracks = P.tracks.filter((t) => set.has(t.id));
    // a bus bounce takes in every track feeding that bus
    const feeders = P.tracks.filter((t) => [...bset].some((i) => t.out === 'bus' + i || (t.sends[i] && t.sends[i].lvl > 0)));
    let end = 0; [...tracks, ...feeders].forEach((t) => t.clips.forEach((c) => (end = Math.max(end, c.start + c.len))));
    if (end <= 0) return;
    if (E.playing) await this.stop();
    const label = [tracks.length ? tracks.length + ' track' + (tracks.length === 1 ? '' : 's') : '', bset.size ? bset.size + ' bus' + (bset.size === 1 ? '' : 'es') : ''].filter(Boolean).join(' + ');
    this.status('Bouncing ' + label + '…');
    const sr = E.sr;
    const buf = await E.render(bset.size ? { s: 0, e: end, sr, tail: 1.5, only: set, busOnly: bset, bypassMaster: true } : { s: 0, e: end, sr, tail: 1.5, only: set, bypassMaster: true });
    const L = buf.getChannelData(0), R = buf.getChannelData(1), thr = U.undb(-90);
    let first = 0, last = L.length - 1;
    while (first < L.length && Math.abs(L[first]) < thr && Math.abs(R[first]) < thr) first++;
    while (last > first && Math.abs(L[last]) < thr && Math.abs(R[last]) < thr) last--;
    if (first >= L.length) { K.toast('That bounce came out silent — are those tracks muted or empty?'); this.status('Bounce was silent'); return; }
    this.commit('Bounce');
    const nm = bset.size && !tracks.length && bset.size === 1 ? P.buses[[...bset][0]].name + ' print' : 'Bounce ' + (P.tracks.filter((t) => /^Bounce \d+$/.test(t.name)).length + 1);
    const id = E.addBuffer(E.makeBuffer([L.slice(), R.slice()], sr), nm);
    const t = M.newTrack(P.tracks.length, { name: nm, stereo: true, input: '1+2' });
    const used = new Set(P.tracks.map((x) => x.color)); t.color = M.COLORS.find((c) => !used.has(c)) || t.color;
    const st = first / sr, len = (last + 1 - first) / sr;
    t.clips.push({ id: U.uid('c'), buf: id, start: st, off: st, len, gain: 1, fi: 0, fo: 0, name: nm });
    const anchor = [...tracks, ...feeders];
    const lastIdx = anchor.length ? Math.max(...anchor.map((x) => P.tracks.indexOf(x))) : P.tracks.length - 1;
    P.tracks.splice(lastIdx + 1, 0, t);
    if (after !== 'keep') { bset.forEach((i) => (P.buses[i].mute = true)); }
    if (after === 'mute') tracks.forEach((x) => (x.mute = true));
    if (after === 'delete') P.tracks = P.tracks.filter((x) => !set.has(x.id));
    this.ui.selTrack = t.id;
    this.changed({ graph: true, heads: true, clips: true, console: true });
    this.status('Bounced ' + label + ' to ' + t.name);
    K.toast('Bounced to ' + t.name + (after === 'mute' ? ' — originals muted' : after === 'delete' ? ' — originals removed (undo brings them back)' : '') + (bset.size && after !== 'keep' ? '; bus muted' : ''));
  },
  // ---------- first run: offer the latency calibration on phones and tablets ----------
  firstRun() {
    const S = this.settings;
    if (S.calAsked || !(PLAT.kind === 'android' || K.isTouch())) return;
    S.calAsked = true; this.saveSettings();
    const h = K.h, res = h('div', { class: 'note' }, 'Phones and tablets add a delay between what you hear and what gets recorded. A quick test measures it so your takes line up with the beat.');
    const steps = h('div', { class: 'note' }, '1. Turn the volume up (speaker, not headphones).  2. Keep the room quiet.  3. Tap Measure — you will hear five clicks.');
    const run = async () => {
      res.textContent = 'Listening…';
      try { const v = await this.eng.calibrate(); S.recLatCal = v; this.saveSettings(); res.textContent = 'Measured ' + Math.round(v * 1000) + ' ms — recordings will be shifted by that much. You can redo this any time in Settings.'; }
      catch (e) { res.textContent = (e.message || 'Calibration failed') + '. You can try again later in Settings.'; }
      return false;
    };
    K.sheet('Line up your recordings', [res, steps], [{ label: 'Later' }, { label: 'Measure', primary: true, act: run }], { light: true });
  },
  // ---------- settings ----------
  async settingsDialog() {
    const h = K.h, S = this.settings, E = this.eng;
    const { ins, outs } = await E.listInputs();
    const inSel = K.select([['', 'System default'], ...ins.map((d, i) => [d.deviceId, d.label || 'Input ' + (i + 1)])], S.inDev || '', (v) => { S.inDev = v || null; this.saveSettings(); E.closeInput(); E.openInput().catch((e) => K.toast(e.message || 'Input failed')); });
    const outSel = E.ctx.setSinkId ? K.select([['', 'System default'], ...outs.filter((d) => d.deviceId !== 'default').map((d, i) => [d.deviceId, d.label || 'Output ' + (i + 1)])], S.outDev || '', async (v) => { S.outDev = v || null; this.saveSettings(); try { await E.ctx.setSinkId(v || ''); this.syncTransport(); } catch (e) { K.toast('Could not switch output'); } }) : h('div', { class: 'note' }, 'Uses the system output');
    const lat = K.select([['interactive', 'Lowest latency'], ['balanced', 'Balanced'], ['playback', 'Safest (big buffer)']], S.latency, (v) => { S.latency = v; this.saveSettings(); K.toast('Restart DAWters to apply the new buffer size'); });
    const srSel = K.select([['', 'Device rate (' + E.sr + ')'], [44100, '44100 Hz'], [48000, '48000 Hz'], [96000, '96000 Hz']], S.sr || '', (v) => { S.sr = v ? +v : null; this.saveSettings(); K.toast('Restart DAWters to apply the new sample rate'); });
    const latInfo = h('div', { class: 'note' });
    const showLat = () => { latInfo.textContent = 'Recording offset now ' + Math.round(E.latency() * 1000) + ' ms ' + (S.recLatCal != null ? '(calibrated ' + Math.round(S.recLatCal * 1000) + ' ms' : '(estimated') + (S.recNudgeMs ? ', nudge ' + S.recNudgeMs + ' ms)' : ')') + '.'; };
    showLat();
    const nudge = h('input', { type: 'number', step: 1, value: S.recNudgeMs || 0 });
    nudge.addEventListener('change', () => { S.recNudgeMs = parseFloat(nudge.value) || 0; this.saveSettings(); showLat(); });
    const cal = h('button', { class: 'btn' }, 'Calibrate with speakers + mic');
    cal.addEventListener('click', async () => { cal.textContent = 'Listening… keep quiet'; try { const v = await E.calibrate(); S.recLatCal = v; this.saveSettings(); showLat(); K.toast('Measured ' + Math.round(v * 1000) + ' ms round trip'); } catch (e) { K.toast(e.message || 'Calibration failed', 4000); } cal.textContent = 'Calibrate with speakers + mic'; });
    const clear = h('button', { class: 'btn sm' }, 'Use estimate'); clear.addEventListener('click', () => { S.recLatCal = null; this.saveSettings(); showLat(); });
    const grain = K.select([['on', 'On'], ['off', 'Off']], S.grain === false ? 'off' : 'on', (v) => { S.grain = v === 'on'; this.saveSettings(); document.documentElement.dataset.grain = S.grain ? 'on' : 'off'; });
    const theme = K.select([['day', 'Daytime (paper)'], ['night', 'Late show (dark)']], S.theme, (v) => { S.theme = v; this.saveSettings(); document.documentElement.dataset.theme = v === 'night' ? 'night' : 'day'; ARR.theme(); CON.render(); DECK.render(); });
    const cv = h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: S.clickVol });
    cv.addEventListener('input', () => { S.clickVol = +cv.value; E.clickOut.gain.value = S.clickVol; this.saveSettings(); });
    K.dialog('Settings', [
      K.row('Input device', inSel), K.row('Output device', outSel), K.row('Buffer', lat), K.row('Sample rate', srSel),
      K.row('Record latency', h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, cal, clear)),
      K.row('Nudge (ms)', nudge), latInfo,
      K.row('Metronome level', cv), K.row('Look', theme), K.row('Film grain', grain),
      h('div', { class: 'note' }, 'Tip: for a USB audio interface, choose it as both input and output. Inputs 1 and 2 are the interface’s first two channels.'),
      ...this.plugSettings(),
    ], [{ label: 'Done', primary: true }], { width: 'min(620px,100%)' });
  },
  // Settings › Plug-ins (desktop builds)
  plugSettings() {
    if (!PLUG.ok) return [];
    const h = K.h, S = this.settings;
    S.plugDirs = S.plugDirs || [];
    const dirs = h('div', { class: 'note' });
    const info = h('div', { class: 'note' });
    const showInfo = () => { info.textContent = PLUG.effects().length + ' effects and ' + PLUG.instruments().length + ' instruments' + (PLUG.failed.length ? ' · ' + PLUG.failed.length + ' could not load: ' + PLUG.failed.slice(0, 4).map((f) => f.path.split(/[\\/]/).pop()).join(', ') + (PLUG.failed.length > 4 ? '…' : '') : '') + '. The standard VST3 folders are always searched.'; };
    const showDirs = () => {
      dirs.textContent = '';
      if (!S.plugDirs.length) dirs.append('No extra folders.');
      S.plugDirs.forEach((d, i) => { const x = h('button', { class: 'btn sm', title: 'Stop searching this folder' }, '×'); x.addEventListener('click', () => { S.plugDirs.splice(i, 1); this.saveSettings(); showDirs(); }); dirs.append(h('div', { style: 'display:flex;gap:6px;align-items:center' }, h('span', null, d), x)); });
    };
    showDirs(); showInfo();
    const addDir = h('button', { class: 'btn' }, 'Add a folder…');
    addDir.addEventListener('click', async () => { const d = await window.dawNative.plugins.pickFolder(); if (d && !S.plugDirs.includes(d)) { S.plugDirs.push(d); this.saveSettings(); showDirs(); await PLUG.scan(); showInfo(); } });
    const rescan = h('button', { class: 'btn' }, 'Rescan');
    rescan.addEventListener('click', async () => { rescan.textContent = 'Scanning…'; await PLUG.scan(true); rescan.textContent = 'Rescan'; showInfo(); });
    const ms = (b) => (b * 128 / this.eng.sr * 1000).toFixed(1) + ' ms';
    const buf = K.select([[2, 'Tightest'], [4, 'Tight'], [8, 'Safe (default)'], [16, 'Safest']].map(([b, n]) => [b, n + ' · ' + ms(b)]), S.plugBlocks || 8, (v) => { S.plugBlocks = +v; this.saveSettings(); K.toast('Applies to plug-ins as they are next loaded (reopen the song to apply everywhere)'); });
    return [
      h('div', { class: 'note', style: 'margin-top:10px;font-weight:600' }, 'VST3 plug-ins'),
      K.row('Plug-in folders', h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' }, addDir, rescan)), dirs, info,
      K.row('Plug-in buffer', buf),
      h('div', { class: 'note' }, 'Plug-ins run in their own process, so one that crashes can’t take your song with it. A smaller buffer plays VST instruments with less delay; raise it if you hear clicks. Delay is compensated on every track.'),
    ];
  },
  // ---------- menus ----------
  menuFile() {
    return [
      { label: 'New song', act: () => this.newProject() },
      { label: 'Open song…', key: 'Ctrl+O', act: () => this.openProject() },
      { label: 'Save song (.dawters)', key: 'Ctrl+S', act: () => this.saveProject() },
      { label: 'Rename song…', act: () => this.renameSong() },
      { sep: true },
      { label: 'Import audio…', key: 'Ctrl+I', act: () => this.importAudio() },
      { label: 'Import from the suite (.edk, Eleosynth sound, .dawsuite)…', act: async () => { const f = await U.pickFile('.edk,.json,application/json,application/zip', true); for (const x of f) await this.importSuiteFile(x); } },
      { label: 'Export mix / stems / buses…', key: 'Ctrl+E', act: () => this.exportDialog() },
      { label: 'Mastering', key: 'Shift+M', act: () => this.setView('master') },
      { sep: true },
      { label: 'Settings…', key: 'Ctrl+,', act: () => this.settingsDialog() },
    ];
  },
  menuEdit() {
    const s = this.selected().length, R = this.hasRange() ? this.ui.range : null;
    if (R) return [
      { label: 'Undo' + (this.history.u.length ? ' ' + this.history.u[this.history.u.length - 1].label : ''), key: 'Ctrl+Z', disabled: !this.history.u.length, act: () => this.undo() },
      { label: 'Redo', key: 'Ctrl+Shift+Z', disabled: !this.history.r.length, act: () => this.redo() },
      { sep: true },
      ...this.rangeItems(R),
      { sep: true },
      { label: 'Paste at playhead', key: 'Ctrl+V', disabled: !this.clipboard, act: () => this.paste() },
      { label: 'Clear the range', key: 'Esc', act: () => { this.ui.range = null; ARR.dirty = true; if (window.DECK) DECK.dirty = true; } },
    ];
    return [
      { label: 'Undo' + (this.history.u.length ? ' ' + this.history.u[this.history.u.length - 1].label : ''), key: 'Ctrl+Z', disabled: !this.history.u.length, act: () => this.undo() },
      { label: 'Redo', key: 'Ctrl+Shift+Z', disabled: !this.history.r.length, act: () => this.redo() },
      { sep: true },
      { label: 'Cut', key: 'Ctrl+X', disabled: !s, act: () => this.copy(true) },
      { label: 'Copy', key: 'Ctrl+C', disabled: !s, act: () => this.copy(false) },
      { label: 'Paste at playhead', key: 'Ctrl+V', disabled: !this.clipboard, act: () => this.paste() },
      { label: 'Duplicate', key: 'Ctrl+D', disabled: !s, act: () => this.duplicate() },
      { label: 'Delete', key: 'Del', disabled: !s && !this.ui.range, act: () => this.deleteSel() },
      { label: 'Split at playhead', key: 'S', act: () => this.split() },
      { label: 'Range start at playhead', key: '[', act: () => this.rangeEdgeAtPlayhead('s') },
      { label: 'Range end at playhead', key: ']', act: () => this.rangeEdgeAtPlayhead('e') },
      { sep: true },
      { label: 'Normalize selected', disabled: !s, act: () => this.normalize() },
      { label: 'Reverse selected', disabled: !s, act: () => this.reverse() },
      { label: 'Noise removal…', act: () => NR.dialog() },
      { label: 'Select all clips', key: 'Ctrl+A', act: () => { this.ui.sel = new Set(this.allClips().map((x) => x.c.id)); ARR.dirty = true; } },
      { label: 'Add marker at playhead', key: 'M', act: () => this.addMarker(this.eng.pos()) },
    ];
  },
  menuTrack() {
    const t = this.sel();
    return [
      { label: 'Add track', key: 'Ctrl+T', act: () => this.addTrack() },
      { label: 'Add stereo track', act: () => this.addTrack({ stereo: true, input: '1+2' }) },
      { label: 'Add synth track', act: () => this.addInstTrack('synth') },
      { label: 'Add drum track', act: () => this.addInstTrack('drums') },
      { label: 'Add sampler track', act: () => this.addInstTrack('sampler') },
      { label: 'Add Eleosynth track', disabled: !SUITE.has('eleo'), act: () => this.addInstTrack('eleo') },
      { label: "Add Beat track (Esperanza's Drum Kit)", disabled: !SUITE.has('edk'), act: () => this.addBeatTrack() },
      ...this.plugInstItems(),
      t && t.kind === 'beat' ? { label: "Open Esperanza's Drum Kit for “" + t.name + '”', act: () => SUITE.open(t) } : null,
      t && t.kind === 'inst' ? { label: 'Instrument for “' + t.name + '”…', act: () => INSTUI.open(t) } : null,
      { label: 'Panic — silence all instruments', act: () => this.eng.panicInst() },
      t ? { label: 'Duplicate “' + t.name + '”', act: () => this.duplicateTrack(t) } : null,
      t ? { label: 'Delete “' + t.name + '”', act: () => this.deleteTrack(t) } : null,
      { label: 'Bounce tracks…', key: 'B', act: () => this.bounceDialog() },
      { label: 'Quick idea (record on a free track)', key: 'Q', act: () => this.quickIdea() },
      { label: 'Capture what I just played', key: 'Shift+C', act: () => this.capture() },
      { label: 'Listen for Capture (keep the input open)', check: !!this.settings.capListen, act: () => this.setCaptureListen(!this.settings.capListen) },
      t && (t.kind !== 'audio' || t.fx.some((f) => f.type === 'eleopedals')) && !t.frozenFrom ? { label: (t.frozen ? 'Unfreeze “' : 'Freeze “') + t.name + '”' + (t.frozen ? '' : ' to audio'), act: () => this.freeze(t) } : null,
      t && t.frozenFrom ? { label: 'Unfreeze — back to the original', act: () => { const o = this.proj.tracks.find((x) => x.id === t.frozenFrom); if (o) this.unfreeze(o); } } : null,
      { sep: true },
      { label: 'Unmute all', act: () => { this.commit('Unmute all'); this.proj.tracks.forEach((x) => (x.mute = false)); this.eng.graph.mutes(); ARR.renderHeads(); CON.render(); } },
      { label: 'Unsolo all', act: () => { this.commit('Unsolo all'); this.proj.tracks.forEach((x) => (x.solo = false)); this.eng.graph.mutes(); ARR.renderHeads(); CON.render(); } },
      { label: 'Disarm all', act: () => { this.proj.tracks.forEach((x) => (x.arm = false)); ARR.renderHeads(); CON.render(); this.save(); } },
    ];
  },
  menuView() {
    return [
      { label: 'Deck', key: 'Tab', check: this.ui.view === 'deck', act: () => this.setView('deck') },
      { label: 'Tracks', key: 'Tab', check: this.ui.view === 'tracks', act: () => this.setView('tracks') },
      { label: 'Console', key: 'Tab', check: this.ui.view === 'console', act: () => this.setView('console') },
      { label: 'Master', key: 'Shift+M', check: this.ui.view === 'master', act: () => this.setView('master') },
      { label: 'Tuner', key: 'U', act: () => TUNER.open() },
      { sep: true },
      { label: 'Zoom in', key: '+', act: () => this.zoom(1.5) },
      { label: 'Zoom out', key: '−', act: () => this.zoom(1 / 1.5) },
      { label: 'Zoom to song', key: 'F', act: () => ARR.fit() },
      { label: 'Follow playhead', check: this.ui.follow, act: () => { this.ui.follow = this.settings.follow = !this.ui.follow; this.saveSettings(); this.syncTransport(); } },
      { label: 'Late-show look (dark)', check: this.settings.theme === 'night', act: () => { this.settings.theme = this.settings.theme === 'night' ? 'day' : 'night'; this.saveSettings(); document.documentElement.dataset.theme = this.settings.theme === 'night' ? 'night' : 'day'; ARR.theme(); CON.render(); DECK.render(); } },
      { label: 'Full screen', act: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen && document.documentElement.requestFullscreen().catch(() => {})) },
    ];
  },
  menuHelp() {
    return [
      { label: 'Keyboard shortcuts', key: '?', act: () => this.helpKeys() },
      { label: 'About DAWters and Son', act: () => this.about() },
    ];
  },
  helpKeys() {
    const rows = [['Space', 'Play / stop'], ['R', 'Record'], ['Home / End', 'Start / end of song'], ['← →', 'Nudge selected clips by the snap grid (or move a bar)'], [', .', 'Previous / next marker'], ['L', 'Loop on/off'], ['P', 'Punch on/off'], ['C', 'Metronome'], ['Shift+C', 'Capture what you just played'], ['S', 'Split at playhead'], ['Del', 'Delete clips or range'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'], ['Ctrl+C X V D', 'Copy, cut, paste, duplicate'], ['Ctrl+A', 'Select all clips'], ['Ctrl+T', 'Add track'], ['Ctrl+S / O', 'Save / open song'], ['Ctrl+I / E', 'Import / export'], ['Tab', 'Tracks ⇄ Console'], ['+ − F', 'Zoom in, out, fit'], ['M', 'Add marker'],
      ['A W S E D F T G Y H U J K', 'Play notes in the Pattern view (Z / X: octave)'], ['Pattern view: click', 'Add a note (drag to set its length); double-click or right-click deletes'], ['Pattern view: ↑ ↓ ← →', 'Transpose / nudge selected notes'], ['Drag across a waveform', 'Select a range, as in Audacity (right-click it for range tools)'], ['Shift-click', 'Stretch the range (or make one from the playhead)'], ['[ / ]', 'Range start / end at the playhead (also while playing)'], ['Del · Ctrl+L', 'Delete the range and close the gap · silence it'], ['Drag a clip by its name bar', 'Move it (edges trim, top corners fade)'], ['Ctrl-drag a name bar', 'Copy the clip'], ['Alt while dragging', 'Ignore snap'], ['Drag the ruler top', 'Set the loop (Shift: punch range)'], ['Double-click ruler', 'Add marker'], ['Double-click a knob or fader', 'Reset it'], ['Shift-drag a knob or fader', 'Fine adjust']];
    K.dialog('Keyboard & mouse', K.h('div', { class: 'keys' }, rows.flatMap(([k, v]) => [K.h('kbd', null, k), K.h('span', null, v)])), [{ label: 'Close', primary: true }], { width: 'min(640px,100%)' });
  },
  about() {
    K.dialog('About', [
      K.h('div', { style: 'display:flex;align-items:center;gap:16px' }, K.h('div', { html: K.LOGO, style: 'width:84px;height:84px;flex:none' }),
        K.h('div', { style: 'flex:1' }, K.h('div', { style: 'font:400 46px/1 var(--script)' }, 'DAWters & Son'), K.h('div', { style: 'font:500 12px var(--head);letter-spacing:3px;text-transform:uppercase;color:var(--muted)' }, '★ Good to the last take ★')),
        K.h('div', { class: 'burst' }, 'New 2.5')),
      K.h('div', { class: 'note' }, 'Version 2.5.0 — VST3 plug-ins in the desktop apps (Mac, Windows, Linux): any VST3 effect on a track, mixbus or the master, and VST3 instrument tracks, each in its own crash-proof process, with delay compensation on every track and its settings saved in the song (Settings › Plug-ins to find them). 2.4.0: the suite comes in: Eleosynth tracks (play it, write notes for it, or put its guitar pedalboard on any audio track as an insert), Beat tracks that hold a whole Esperanza\'s Drum Kit project (its song, sections and patterns become clips; double-click to edit), Send to DAWters from both apps, Capture (Shift+C) for what you played without recording, and Freeze to print a track to audio. 2.3.5: Audacity-style editing: drag across any waveform to select a range, then cut, copy, delete, silence, trim, fade, amplify or reverse just that stretch, or take a noise profile from it; drag a clip by its name bar to move it. 2.3.4: the drum synth has a crash and a ride cymbal, and a pattern placed on the timeline now plays where it sits even after you used Loop. 2.3.3: DAWters and Son is free software, released under the GNU General Public License, version 3 or later. 2.3.2: recording over a track silences its old audio while you record. 2.3.1: hear any effect live with Audition (test sounds, your own track, the song or the mic). 2.3: a Master tab with 16 mastering recipes, level-matched A/B and a spectrum view; a built-in Tuner; noise removal from a noise sample; and a studio set of effects: true-peak limiter, multiband, FET / opto / bus compressors, saturator, tube EQ, de-esser, transient shaper, doubler, imager, tape echo and new reverb rooms. Everything is plain signal processing — no AI.'),
      K.h('div', { class: 'note' }, 'Still here from 2.2: the On the Air look, loudness-target exports, bus bounces and bus stems, ffmpeg exports (MP3, AAC, Ogg, Opus, FLAC), instruments, piano roll, GrooveMatrix and MIDI.'),
      K.h('div', { class: 'note' }, 'A multitrack studio in the spirit of the classic home-recording DAWs: unlimited tracks, a knob-per-function console with four mixbuses, a master with true-peak limiting, loudness and VU metering. Works without an internet connection; your current song autosaves on this device.'),
      K.h('div', { class: 'note' }, 'Fonts: Yesteryear, Oswald and Courier Prime — SIL Open Font License 1.1. Encoding: FFmpeg (LGPL/GPL), LAME, libvorbis, Opus.'),
      K.h('div', { class: 'note' }, 'Copyright © 2026 Josh Wilk. This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version. It comes with ABSOLUTELY NO WARRANTY. Source code: ' + SOURCE_URL),
    ], [{ label: 'License', act: () => { this.licenseDialog(); return false; } }, { label: 'Close', primary: true }]);
  },
  licenseDialog() {
    K.dialog('GNU General Public License v3', K.h('pre', { style: 'white-space:pre-wrap;font:12px/1.45 var(--mono);max-height:60vh;overflow:auto;margin:0;user-select:text;-webkit-user-select:text' }, LICENSE_TXT), [{ label: 'Close', primary: true }], { width: 'min(720px,100%)' });
  },
  // the opening title card — gone in about a second and never blocks a click
  titleCard() {
    if (sessionStorage.getItem('dawters.tc') || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;
    try { sessionStorage.setItem('dawters.tc', '1'); } catch (e) { /* */ }
    const c = K.h('div', { class: 'titlecard', 'aria-hidden': 'true' }, K.h('small', null, 'Stay tuned for'), K.h('b', null, 'DAWters & Son'), K.h('em', null, 'Good to the last take'));
    document.body.append(c); setTimeout(() => c.remove(), 1900);
  },
  inspector() {
    if (!this.el) return;
    const s = this.selected();
    if (s.length === 1) { const c = s[0].c; this.el.insp.textContent = (c.name || 'Clip') + ' · ' + U.fmtTime(c.start) + ' · ' + c.len.toFixed(2) + ' s' + (c.gain !== 1 ? ' · ' + U.fmtDb(U.db(c.gain)) + ' dB' : ''); }
    else if (s.length > 1) this.el.insp.textContent = s.length + ' clips selected';
    else this.el.insp.textContent = '';
  },
  cmd(c) {
    const ed = document.activeElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable);
    if (ed && ['cut', 'copy', 'paste', 'selectAll', 'undo', 'redo'].includes(c)) { document.execCommand(c === 'selectAll' ? 'selectAll' : c); return; }
    if (document.querySelector('.scrim') && !['about', 'help'].includes(c)) return;
    const more = { cut: () => this.copy(true), copy: () => this.copy(false), paste: () => this.paste(), duplicate: () => this.duplicate(), selectAll: () => { this.ui.sel = new Set(this.allClips().map((x) => x.c.id)); ARR.dirty = true; this.inspector(); }, addTrack: () => this.addTrack() };
    if (more[c]) return more[c]();
    const m = { new: () => this.newProject(), open: () => this.openProject(), save: () => this.saveProject(), import: () => this.importAudio(), export: () => this.exportDialog(), settings: () => this.settingsDialog(), undo: () => this.undo(), redo: () => this.redo(), help: () => this.helpKeys(), about: () => this.about(), tracks: () => this.setView('tracks'), console: () => this.setView('console'), deck: () => this.setView('deck'), bounce: () => this.bounceDialog(), idea: () => this.quickIdea(), master: () => this.setView('master'), tuner: () => TUNER.open(), matrix: () => this.setView('matrix'), pattern: () => this.setView('pattern') };
    if (m[c]) m[c]();
  },
  keys() {
    document.addEventListener('keydown', (e) => {
      const tg = e.target;
      if (tg && (tg.tagName === 'INPUT' || tg.tagName === 'SELECT' || tg.tagName === 'TEXTAREA' || tg.isContentEditable)) return;
      if (document.querySelector('.scrim')) return;
      const mod = e.ctrlKey || e.metaKey, k = e.key;
      const go = (fn) => { e.preventDefault(); fn(); };
      if (this.ui.view === 'pattern') {
        if (PAT.keydown(e)) { e.preventDefault(); return; }
        // computer keyboard as a piano: A W S E D F T G Y H U J K, Z / X octave
        const map = 'awsedftgyhujk', ix = map.indexOf(k.toLowerCase());
        if (!mod && !e.repeat && (ix >= 0 || k === 'z' || k === 'x') && PAT.track()) {
          e.preventDefault();
          if (k === 'z') { PAT.oct = Math.max(0, (PAT.oct || 4) - 1); return PAT.render(); }
          if (k === 'x') { PAT.oct = Math.min(8, (PAT.oct || 4) + 1); return PAT.render(); }
          const n = PAT.isDrum() ? INST.PADS[ix % INST.PADS.length] : ((PAT.oct || 4) + 1) * 12 + ix;
          this.eng.liveNote(PAT.track().id, true, n, PAT.defVel); PAT.noteFlash(n, true);
          const upk = (ev) => { if (ev.key.toLowerCase() !== k.toLowerCase()) return; this.eng.liveNote(PAT.track().id, false, n, 0); PAT.noteFlash(n, false); document.removeEventListener('keyup', upk); };
          document.addEventListener('keyup', upk); return;
        }
      }
      if (mod) {
        const kk = k.toLowerCase();
        if (kk === 'z' && !e.shiftKey) return go(() => this.undo());
        if ((kk === 'z' && e.shiftKey) || kk === 'y') return go(() => this.redo());
        if (kk === 'c') return go(() => this.copy(false));
        if (kk === 'x') return go(() => this.copy(true));
        if (kk === 'v') return go(() => this.paste());
        if (kk === 'l') return go(() => { if (this.hasRange()) this.deleteRange(this.ui.range, false); });
        if (kk === 'd') return go(() => this.duplicate());
        if (kk === 'a') return go(() => { this.ui.sel = new Set(this.allClips().map((x) => x.c.id)); ARR.dirty = true; this.inspector(); });
        if (kk === 's') return go(() => this.saveProject());
        if (kk === 'o') return go(() => this.openProject());
        if (kk === 'i') return go(() => this.importAudio());
        if (kk === 'e') return go(() => this.exportDialog());
        if (kk === 't') return go(() => this.addTrack());
        if (kk === ',') return go(() => this.settingsDialog());
        return;
      }
      if (k === ' ') return go(() => this.togglePlay());
      if (k === 'r' || k === 'R' || k === '*') return go(() => this.record());
      if (k === 'Home') return go(() => this.locate(0));
      if (k === 'End') return go(() => this.locate(M.songEnd(this.proj)));
      if (k === 'ArrowLeft' || k === 'ArrowRight') return go(() => { if (!this.nudge(k === 'ArrowLeft' ? -1 : 1)) this.nudgeBars(k === 'ArrowLeft' ? -1 : 1); });
      if (k === ',') return go(() => this.jumpMarker(-1));
      if (k === '.') return go(() => this.jumpMarker(1));
      if (k === 'l' || k === 'L') return go(() => this.toggleLoop());
      if (k === 'p' || k === 'P') return go(() => { this.commit('Punch'); this.proj.punch.on = !this.proj.punch.on; this.changed({ transport: true }); });
      if (k === 'C' && e.shiftKey) return go(() => this.capture());
      if (k === 'c' || k === 'C') return go(() => { this.settings.click = !this.settings.click; this.saveSettings(); this.syncTransport(); });
      if (k === 's' || k === 'S') return go(() => this.split());
      if (k === 'M' && e.shiftKey) return go(() => this.setView('master'));
      if (k === 'm' || k === 'M') return go(() => this.addMarker(this.eng.pos()));
      if (k === 'Delete' || k === 'Backspace') return go(() => this.deleteSel());
      if (k === '[') return go(() => this.rangeEdgeAtPlayhead('s'));
      if (k === ']') return go(() => this.rangeEdgeAtPlayhead('e'));
      if (k === 'Tab') return go(() => this.cycleView(e.shiftKey ? -1 : 1));
      if (k === 'q' || k === 'Q') return go(() => this.quickIdea());
      if (k === 'u' || k === 'U') return go(() => TUNER.open());
      if (k === 'b' || k === 'B') return go(() => this.bounceDialog());
      if (k === '+' || k === '=') return go(() => this.zoom(1.5));
      if (k === '-' || k === '_') return go(() => this.zoom(1 / 1.5));
      if (k === 'f' || k === 'F') return go(() => ARR.fit());
      if (k === '?') return go(() => this.helpKeys());
      if (k === 'Escape') { this.ui.sel = new Set(); this.ui.range = null; ARR.dirty = true; if (window.DECK) DECK.dirty = true; this.inspector(); }
    });
  },
};

window.addEventListener('DOMContentLoaded', () => {
  A.boot().catch((e) => {
    console.error(e);
    document.body.insertAdjacentHTML('beforeend', '<div class="scrim"><div class="dlg"><div class="dh">Audio could not start</div><div class="db">' + U.esc(e.message || String(e)) + '<div class="note">DAWters needs a browser with AudioWorklet support (Chrome, Edge, or the Mac/Android app). If you opened the file directly, try the localhost launcher instead.</div></div></div></div>');
  });
});
