// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — the suite host: Eleosynth and Esperanza's Drum Kit running inside the studio.
//
// Each plugin is the real app, built into this file and opened in a same-origin frame (its editor). In plugin
// mode the app makes no AudioContext of its own: it builds its engine on ours and connects it to the node we hand
// it, so it plays through a track's strip, inserts and sends, is recorded, bounced, exported and mastered like
// anything else. We drive its notes (Eleosynth) or its pattern clips (Esperanza's Drum Kit) from our timeline with
// sample-accurate timestamps, keep its state inside the song, and for offline renders it builds a second engine
// on the offline context with the same sound.
//
//   Eleosynth instrument  a track of kind 'inst' with inst.type 'eleo'      state: t.inst.state
//   Eleosynth pedalboard  an insert effect of type 'eleopedals'              state: f.state
//   Beat track            a track of kind 'beat' (Esperanza's Drum Kit)      state: t.beat.state; clips { beat: true, src }
'use strict';
const SUITE = {
  KINDS: { eleo: { name: 'Eleosynth', el: 'suite-eleo' }, edk: { name: "Esperanza's Drum Kit", el: 'suite-edk' } },
  hosts: {}, inst: new Map(), loaded: new WeakMap(), pend: new WeakMap(), _html: {}, hitCache: new Map(),

  has(kind) { return !!document.getElementById(this.KINDS[kind].el); },
  // the plugin pages travel inside this file gzip-compressed and base64-encoded
  async html(kind) {
    if (this._html[kind]) return this._html[kind];
    const el = document.getElementById(this.KINDS[kind].el);
    if (!el) throw new Error(this.KINDS[kind].name + ' is not included in this build');
    const s = atob(el.textContent.trim()), bin = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bin[i] = s.charCodeAt(i);
    const txt = await new Response(new Blob([bin]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    return (this._html[kind] = txt);
  },

  // ---------- worklet modules: loaded once per context (offline renders get their own) ----------
  addModule(ctx, key, code) {
    let m = this.loaded.get(ctx); if (!m) this.loaded.set(ctx, (m = new Map()));
    if (!m.has(key)) {
      m.set(key, (async () => {
        const url = URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
        try { await ctx.audioWorklet.addModule(url); }
        catch (e) { await ctx.audioWorklet.addModule('data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(code)))); }
      })());
    }
    return m.get(key);
  },
  // our own processors (ds-channel, ds-inst, …) are already in this context: Esperanza's Drum Kit shares them
  markLoaded(ctx, key) { let m = this.loaded.get(ctx); if (!m) this.loaded.set(ctx, (m = new Map())); m.set(key, Promise.resolve()); },
  // offline renders wait until every plugin has built its engine on the offline context
  pending(ctx, p) { let a = this.pend.get(ctx); if (!a) this.pend.set(ctx, (a = [])); a.push(p.catch((e) => console.warn('plugin render', e))); return p; },
  settle(ctx) { return Promise.all(this.pend.get(ctx) || []); },

  // ---------- who owns an instance: a track or an insert, found fresh each time (undo replaces objects) ----------
  owners(P) {
    const out = [];
    P = P || A.proj; if (!P) return out;
    const fxOf = (list, where) => (list || []).forEach((f) => { if (f && f.type === 'eleopedals') out.push({ key: f.id, kind: 'eleo', mode: 'fx', obj: f, where }); });
    for (const t of P.tracks) {
      if (t.kind === 'inst' && t.inst && t.inst.type === 'eleo') out.push({ key: t.id, kind: 'eleo', mode: 'inst', obj: t.inst, track: t });
      if (t.kind === 'beat') out.push({ key: t.id, kind: 'edk', mode: 'beat', obj: t.beat || (t.beat = {}), track: t });
      fxOf(t.fx, t);
    }
    P.buses.forEach((b) => fxOf(b.fx, b)); fxOf(P.master.fx, P.master);
    return out;
  },
  owner(key) { return this.owners().find((o) => o.key === key) || null; },

  // ---------- instances ----------
  ensure(key) {
    let inst = this.inst.get(key); if (inst) return inst;
    const o = this.owner(key); if (!o || !this.has(o.kind)) return null;
    const ctx = A.eng.ctx, id = 'h' + Math.random().toString(36).slice(2, 10);
    inst = { key, kind: o.kind, mode: o.mode, hostId: id, out: ctx.createGain(), inp: o.mode === 'beat' ? null : ctx.createGain(), api: null, lastState: o.obj.state || null };
    inst.ready = new Promise((res) => { inst._res = res; });
    this.hosts[id] = {
      mode: o.mode, ctx, output: inst.out, input: inst.inp, state: o.obj.state || null,
      addModule: (c, k, code) => this.addModule(c, k, code),
      bpm: () => A.proj.bpm,
      tempo: (v) => { if (Math.abs(v - A.proj.bpm) > 1e-6) A.setTempo(v); },
      changed: () => this.changed(inst),
      // notes played on the plugin's own keys go through our engine: recorded, captured, sustained
      note: (on, n, v) => { const ow = this.owner(key); if (ow && ow.track) A.eng.liveNote(ow.track.id, on, n, v); else if (inst.api) inst.api.note(on, n, v); },
      ready: (api) => { inst.api = api; inst._res(api); this.readied(inst); },
    };
    this.inst.set(key, inst);
    this.buildEditor(inst);
    return inst;
  },
  readied(inst) {
    const o = this.owner(inst.key); if (!o) return;
    if (inst.api.bpm) inst.api.bpm(A.proj.bpm);
    // a fresh Beat track (no state yet) starts with its song placed on the timeline
    if (inst.mode === 'beat' && o.track && !o.track.clips.length && inst.api.info) {
      const info = inst.api.info(), sd = 60 / A.proj.bpm / 4, bar = sd * 16;
      const at = Math.max(0, Math.floor(A.eng.pos() / bar + 1e-6) * bar);
      o.track.clips.push({ id: U.uid('c'), beat: true, src: 'song', start: at, off: 0, len: info.songLen * sd, gain: 1, fi: 0, fo: 0, name: info.name || 'Beat' });
      this.changed(inst, true);
      A.changed({ clips: true });
    }
    if (!o.obj.state) this.changed(inst, true);
    this.hitCache.clear(); ARR.dirty = true; if (window.DECK) DECK.dirty = true;
    A.eng.reschedule();
    if (inst.wrap) inst.wrap.querySelector('.st').textContent = '';
  },
  // the plugin changed its sound / beat: keep its state in the song (saved with it; not an undo step)
  changed(inst, now) {
    clearTimeout(inst.chT);
    const go = () => {
      const o = this.owner(inst.key); if (!o || !inst.api) return;
      const st = inst.api.getState(); o.obj.state = st; inst.lastState = st;
      if (o.mode === 'beat') { this.hitCache.clear(); ARR.dirty = true; if (window.DECK) DECK.dirty = true; if (inst.wrap) this.editorTitle(inst); }
      if (o.mode !== 'beat' && inst.wrap) this.editorTitle(inst);
      A.save();
    };
    if (now) go(); else inst.chT = setTimeout(go, 300);
  },
  dispose(key) {
    const inst = this.inst.get(key); if (!inst) return;
    try { if (inst.api && inst.api.dispose) inst.api.dispose(); } catch (e) { /* frame gone */ }
    try { inst.out.disconnect(); } catch (e) { /* */ } try { if (inst.inp) inst.inp.disconnect(); } catch (e) { /* */ }
    if (inst.wrap) inst.wrap.remove();
    delete this.hosts[inst.hostId]; this.inst.delete(key);
  },
  // after a song loads or changes: every owner has an instance, orphans go, undone states are applied
  sync() {
    if (!A.eng || !A.eng.ctx) return;
    const want = this.owners(), keys = new Set(want.map((o) => o.key));
    for (const k of Array.from(this.inst.keys())) if (!keys.has(k)) this.dispose(k);
    for (const o of want) {
      const inst = this.ensure(o.key); if (!inst) continue;
      if (inst.api && o.obj.state && o.obj.state !== inst.lastState) { inst.lastState = o.obj.state; inst.api.setState(o.obj.state); }
    }
  },
  tempo(bpm) { for (const i of this.inst.values()) if (i.api && i.api.bpm) i.api.bpm(bpm); },
  transportStarted() { for (const i of this.inst.values()) if (i.api && i.api.stopPreview) i.api.stopPreview(); },
  flush() { for (const i of this.inst.values()) if (i.api) { clearTimeout(i.chT); const o = this.owner(i.key); if (o) { o.obj.state = i.api.getState(); i.lastState = o.obj.state; } } },

  // ---------- engine glue ----------
  // the node our graph connects for an Eleosynth / Beat track (live)
  liveNode(t) {
    const inst = this.ensure(t.id);
    const px = { dest: null,
      port: { postMessage: (m) => { const a = inst && inst.api; if (!a) return;
        if (m.t === 'ev') { if (a.schedule) a.schedule(m.ev); } else if (m.t === 'clear') a.clear(); else if (m.t === 'panic') { if (a.allOff) a.allOff(); else a.clear(); } else if (m.t === 'now') a.note(!!m.k, m.n, m.v); } },
      connect: (d) => { if (inst) { inst.out.connect(d); px.dest = d; } },
      disconnect: () => { if (inst && px.dest) { try { inst.out.disconnect(px.dest); } catch (e) { /* */ } px.dest = null; } },
      beatWindow: (clips, a, b, ca) => { if (inst && inst.api && inst.api.window) inst.api.window(clips, a, b, ca); },
    };
    return px;
  },
  // offline: a gain the plugin's second engine plays into once it is built
  offlineNode(t, ctx, o) {
    const g = ctx.createGain(), inst = this.ensure(t.id);
    if (inst) {
      this.pending(ctx, inst.ready.then((api) => (t.kind === 'beat'
        ? api.render(ctx, { output: g, clips: this.beatClips(t), s: o.s, e: o.e })
        : api.render(ctx, { output: g, events: o.events || [], bpm: A.proj.bpm }))));
    }
    return { port: { postMessage() {} }, connect: (d) => g.connect(d), disconnect: () => { try { g.disconnect(); } catch (e) { /* */ } } };
  },
  beatClips(t) { return t.clips.filter((c) => c.beat).map((c) => ({ src: c.src, start: c.start, len: c.len, off: c.off || 0, mute: !!c.mute })); },
  // an Eleosynth pedalboard insert (FX registry)
  fxNode(ctx, env) {
    const input = ctx.createGain(), output = ctx.createGain();
    const inst = env.id && env.id !== 'aud' ? this.ensure(env.id) : null;
    if (!inst) { input.connect(output); return { input, output, set() {}, dispose() { try { input.disconnect(); } catch (e) { /* */ } } }; }
    if (env.offline) this.pending(ctx, inst.ready.then((api) => api.render(ctx, { input, output, bpm: env.bpm })));
    else { input.connect(inst.inp); inst.out.connect(output); }
    return { input, output, set() {}, dispose() {
      try { input.disconnect(); } catch (e) { /* */ }
      if (!env.offline) try { inst.out.disconnect(output); } catch (e) { /* */ }
    } };
  },
  // what a beat clip shows on the timeline (cached until the beat changes)
  hits(t, src) {
    const k = t.id + '|' + src; if (this.hitCache.has(k)) return this.hitCache.get(k);
    const inst = this.inst.get(t.id); if (!inst || !inst.api || !inst.api.hits) return null;
    const h = inst.api.hits(src, 2048); this.hitCache.set(k, h); return h;
  },
  info(t) { const inst = this.inst.get(t.id); return inst && inst.api && inst.api.info ? inst.api.info() : null; },

  // ---------- editors ----------
  buildEditor(inst) {
    const h = K.h, name = this.KINDS[inst.kind].name;
    const title = h('b', { class: 'ttl' }, name), st = h('span', { class: 'st' }, 'Starting ' + name + '…');
    const extra = h('span', { class: 'ex' });
    const close = h('button', { class: 'btn on', onclick: () => this.hide() }, 'Done');
    const bar = h('div', { class: 'suite-bar' }, title, st, extra, h('span', { style: 'flex:1' }), close);
    const frame = h('iframe', { title: name + ' editor', allow: 'microphone; midi; autoplay' });
    const wrap = h('div', { class: 'suite-ed', 'data-kind': inst.kind, 'aria-hidden': 'true' }, bar, frame);
    document.body.append(wrap);
    inst.wrap = wrap; inst.frame = frame; inst.extra = extra;
    if (inst.mode === 'beat') extra.append(h('button', { class: 'btn', onclick: (e) => this.placeMenu(inst, e.clientX, e.clientY) }, '+ Put on the timeline'));
    this.editorTitle(inst);
    this.html(inst.kind).then((html) => {
      frame.srcdoc = html.replace(/<head>/i, '<head><script>window.SUITE_HOST = parent.SUITE.hosts[' + JSON.stringify(inst.hostId) + '];<\/script>');
    }).catch((e) => { st.textContent = e.message; });
  },
  editorTitle(inst) {
    const o = this.owner(inst.key); if (!o || !inst.wrap) return;
    const where = o.track ? o.track.name : o.where === A.proj.master ? 'Master' : o.where ? o.where.name : '';
    const what = inst.api && inst.api.name ? inst.api.name() : '';
    inst.wrap.querySelector('.ttl').textContent = (inst.mode === 'fx' ? 'Eleosynth Pedalboard' : this.KINDS[inst.kind].name) + ' · ' + where + (what ? ' · ' + what : '');
  },
  show(key) {
    const inst = this.ensure(key); if (!inst) return K.toast('This instrument is not available in this build');
    this.hide();
    const top = document.querySelector('.topbar, #top, header');
    inst.wrap.style.top = (top ? Math.round(top.getBoundingClientRect().bottom) : 0) + 'px';
    inst.wrap.classList.add('open'); inst.wrap.setAttribute('aria-hidden', 'false');
    this.cur = inst;
    if (inst.api && inst.api.redraw) inst.api.redraw();
    if (inst.api && inst.api.show && inst.mode === 'fx') inst.api.show('pedals');
    try { inst.frame.focus(); } catch (e) { /* */ }
  },
  hide() { if (this.cur) { this.cur.wrap.classList.remove('open'); this.cur.wrap.setAttribute('aria-hidden', 'true'); this.cur = null; ARR.dirty = true; } },
  open(t) { this.show(t.id); },
  // a Beat track's clips: the whole song, one pattern or one section, at the playhead
  placeMenu(inst, x, y) {
    const o = this.owner(inst.key); if (!o || !inst.api) return;
    const info = inst.api.info(), sd = 60 / A.proj.bpm / 4, bar = sd * 16, t = o.track;
    const at = () => Math.max(0, Math.floor(A.eng.pos() / bar + 1e-6) * bar);
    const put = (src, len, name, off) => { A.commit('Place beat'); const c = { id: U.uid('c'), beat: true, src, start: at(), off: off || 0, len, gain: 1, fi: 0, fo: 0, name }; t.clips.push(c); A.ui.sel = new Set([c.id]); A.changed({ clips: true }); K.toast('Placed ' + name + ' at bar ' + (Math.round(c.start / bar) + 1)); };
    K.menu([
      { head: 'Put on the timeline at the playhead' },
      { label: 'The whole song (' + Math.round(info.songLen / 16) + ' bars)', act: () => put('song', info.songLen * sd, info.name || 'Song') },
      ...(info.sections.length ? [{ head: 'Sections' }] : []),
      ...info.sections.map((s) => ({ label: s.name + ' (' + Math.round(s.len / 16) + ' bars)', act: () => put('song', s.len * sd, s.name, s.start * sd) })),
      { head: 'Patterns' },
      ...info.patterns.map((p) => ({ label: p.name + ' (' + (p.len / 16) + ' bar' + (p.len === 16 ? '' : 's') + ')', act: () => put(p.id, p.len * sd, p.name) })),
    ], x, y);
  },
};
window.SUITE = SUITE; // the plugin frames reach their host as parent.SUITE
