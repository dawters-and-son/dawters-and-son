// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// VST3 plug-ins (Mac, Windows and Linux desktop builds). The plug-ins run in dawters-plughost, a
// separate process, so a plug-in that crashes can't take the song with it. The page talks to it in two ways:
//   • a control port (create, destroy, state, editor windows, scanning), on the main thread
//   • per AudioContext, a small worker that carries audio blocks between the ds-plug worklet nodes and
//     the relay, so the audio never waits on the main thread
// Each plug-in node delays its track by a fixed number of blocks (the bridge) plus the plug-in's own
// latency; the engine lines every track up again (plug-in delay compensation).
'use strict';
const PLUG = {
  ok: false, list: [], failed: [], ctl: null, q: 0, pend: new Map(), waiters: new Map(), tag: 0,
  ctxs: new WeakMap(), byId: new Map(), wrappers: new Set(), scanning: null, crashes: 0,
  blocksLive() { const b = (typeof A !== 'undefined' && A.settings && A.settings.plugBlocks) || 8; return Math.max(1, Math.min(32, b | 0)); },
  BLOCKS_OFFLINE: 32,
  WORKER_SRC: "let relay = null, wk = null;\n" +
    "onmessage = (e) => { const m = e.data; if (m.t !== 'init') return; relay = m.relay; wk = m.wk;\n" +
    "  relay.onmessage = (x) => { const d = x.data; wk.postMessage(d, d && d.ch ? d.ch.map((c) => c.buffer) : []); };\n" +
    "  wk.onmessage = (x) => relay.postMessage(x.data); };",

  async init() {
    const N = window.dawNative && window.dawNative.plugins;
    if (!N) return;
    try { this.ok = await N.available(); } catch (e) { this.ok = false; }
    window.addEventListener('message', (e) => {
      const d = e.data; if (!d || d.type !== 'dawters-plug-port' || !e.ports || !e.ports[0]) return;
      const w = this.waiters.get(d.tag); if (w) { this.waiters.delete(d.tag); w(e.ports[0]); }
    });
    this.ctl = await this.port('control');
    this.ctl.onmessage = (e) => this.onControl(e.data);
    const c = await this.call('cached');
    this.list = c.plugins || [];
  },
  port(kind) {
    return new Promise((res) => { const tag = 'p' + (++this.tag); this.waiters.set(tag, res); window.dawNative.plugins.requestPort(kind, tag); });
  },
  call(cmd, o, timeoutMs) {
    if (!this.ctl) return Promise.resolve({ ok: false, error: 'Plug-ins need the desktop app' });
    return new Promise((res) => {
      const q = ++this.q;
      const t = setTimeout(() => { if (this.pend.has(q)) { this.pend.delete(q); res({ ok: false, error: 'The plug-in host did not answer' }); } }, timeoutMs || 60000);
      this.pend.set(q, (m) => { clearTimeout(t); res(m); });
      this.ctl.postMessage(Object.assign({ q, cmd }, o || {}));
    });
  },
  onControl(m) {
    if (m.q && this.pend.has(m.q)) { const f = this.pend.get(m.q); this.pend.delete(m.q); f(m); return; }
    if (m.ev === 'scan') { if (typeof A !== 'undefined') A.status('Scanning plug-ins… ' + m.done + ' / ' + m.total); return; }
    const w = m.id ? this.byId.get(m.id) : null;
    if (m.ev === 'dirty' && w) w.dirty();
    else if (m.ev === 'latency' && w) { w.pluginLatency = m.latency | 0; this.latencyChanged(); }
    else if (m.ev === 'crashed') this.recover();
  },
  // the host crashed: every live plug-in is started again from its last saved state
  recover() {
    this.crashes++;
    const live = Array.from(this.wrappers).filter((w) => !w.offline && !w.disposed);
    for (const w of live) { if (w.id) this.byId.delete(w.id); w.id = 0; w.node.port.postMessage({ t: 'id', id: 0 }); }
    if (typeof K !== 'undefined') K.toast('A plug-in crashed. DAWters reloaded your plug-ins — your song is safe.', 5000);
    setTimeout(() => live.forEach((w) => !w.disposed && w.start()), 400);
  },
  latencyChanged() { if (typeof A !== 'undefined' && A.eng) A.eng.pdcChanged(); },

  // ---------- the list of installed plug-ins ----------
  effects() { return this.list.filter((p) => !p.instrument); },
  instruments() { return this.list.filter((p) => p.instrument); },
  find(plug) { return plug && this.list.find((p) => p.cid === plug.cid) || null; },
  async scan(rescan) {
    if (!this.ok) { K.toast('Plug-ins need the desktop app (Mac, Windows or Linux).'); return null; }
    if (this.scanning) return this.scanning;
    const dirs = (A.settings.plugDirs || []).slice();
    if (typeof A !== 'undefined') A.status('Scanning plug-ins…');
    this.scanning = this.call('scan', { dirs, rescan: !!rescan, retry: true }, 30 * 60000).then((r) => {
      this.scanning = null;
      if (!r.ok) { K.toast(r.error || 'The scan did not finish', 4000); return r; }
      this.list = r.plugins || []; this.failed = r.failed || [];
      const fx = this.effects().length, ins = this.instruments().length;
      A.status('Found ' + fx + ' effect' + (fx === 1 ? '' : 's') + ' and ' + ins + ' instrument' + (ins === 1 ? '' : 's') + (this.failed.length ? ' · ' + this.failed.length + ' could not load' : ''));
      return r;
    });
    return this.scanning;
  },

  // ---------- per-context plumbing ----------
  ctxState(ctx) {
    let s = this.ctxs.get(ctx);
    if (s) return s;
    s = { wrappers: new Set(), ready: null, port: null };
    s.ready = (async () => {
      const relay = await this.port('audio');
      const worker = new Worker(URL.createObjectURL(new Blob([this.WORKER_SRC], { type: 'application/javascript' })));
      const mc = new MessageChannel();
      worker.postMessage({ t: 'init', relay, wk: mc.port1 }, [relay, mc.port1]);
      s.worker = worker; s.port = mc.port2;
    })();
    this.ctxs.set(ctx, s);
    return s;
  },
  // wait for every plug-in on this context to be running (offline renders)
  async settle(ctx) {
    const s = this.ctxs.get(ctx); if (!s) return;
    await s.ready;
    await Promise.all(Array.from(s.wrappers).map((w) => w.ready));
  },
  // offline renders: wait until every plug-in on the context has answered everything sent so far
  drain(ctx) {
    const s = this.ctxs.get(ctx); if (!s) return Promise.resolve();
    return Promise.all(Array.from(s.wrappers).filter((w) => w.id && !w.disposed).map((w) => w.drain()));
  },
  has(ctx) { const s = this.ctxs.get(ctx); return !!(s && s.wrappers.size); },
  disposeCtx(ctx) { const s = this.ctxs.get(ctx); if (!s) return; for (const w of s.wrappers) w.dispose(); if (s.worker) s.worker.terminate(); this.ctxs.delete(ctx); },

  // ---------- one plug-in on one context ----------
  // owner: the project object that keeps its state (an insert {plug, state} or a track's inst {plug, state})
  create(ctx, owner, o) {
    o = o || {};
    const instrument = !!o.instrument, offline = !!o.offline, blocks = offline ? this.BLOCKS_OFFLINE : this.blocksLive();
    const s = this.ctxState(ctx), self = this;
    const node = new AudioWorkletNode(ctx, 'ds-plug', {
      numberOfInputs: instrument ? 0 : 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit',
      processorOptions: { blocks, instrument, offline, events: o.events || [] },
    });
    const w = {
      node, owner, instrument, offline, blocks, ctx, id: 0, pluginLatency: 0, disposed: false, error: null, info: null, late: 0,
      latency() { return (this.blocks * 128 + this.pluginLatency) / this.ctx.sampleRate; },
      start() {
        const plug = owner.plug;
        if (!plug || !self.ok) { this.error = plug ? 'Plug-ins need the desktop app' : 'No plug-in chosen'; this.ready = Promise.resolve(); return this.ready; }
        this.ready = (async () => {
          await s.ready;
          if (!s.given) { s.given = true; node.port.postMessage({ t: 'relay', port: s.port }, [s.port]); }
          const r = await self.call('create', { path: plug.path, cid: plug.cid, sr: ctx.sampleRate, block: 4096, state: owner.state || null });
          if (this.disposed) { if (r.ok) self.call('destroy', { id: r.id }); return; }
          if (!r.ok) {
            this.error = r.error || 'The plug-in did not load';
            if (!offline && typeof K !== 'undefined') K.toast(plug.name + ': ' + this.error, 5000);
            return;
          }
          this.id = r.id; this.info = r; this.error = null; this.pluginLatency = r.latency | 0;
          self.byId.set(r.id, this);
          node.port.postMessage({ t: 'id', id: r.id });
          if (this.pluginLatency) self.latencyChanged();
        })();
        return this.ready;
      },
      // the plug-in's settings changed (in its window): keep them in the song
      dirty() {
        clearTimeout(this.dt);
        this.dt = setTimeout(async () => {
          if (!this.id) return;
          const r = await self.call('getState', { id: this.id });
          if (r.ok && r.state) { owner.state = r.state; if (typeof A !== 'undefined') A.save(); }
        }, 400);
      },
      async saveState() { if (!this.id) return; const r = await self.call('getState', { id: this.id }); if (r.ok && r.state) owner.state = r.state; },
      drain() {
        return new Promise((res) => {
          const prev = node.port.onmessage;
          const to = setTimeout(() => { node.port.onmessage = prev; res(); }, 10000);
          node.port.onmessage = (e) => { if (e.data.t === 'drained') { clearTimeout(to); node.port.onmessage = prev; res(); } else if (prev) prev(e); };
          node.port.postMessage({ t: 'drain' });
        });
      },
      editor(open) { return this.id ? self.call('editor', { id: this.id, open: open !== false }) : Promise.resolve({ ok: false, error: this.error || 'Still loading' }); },
      transport(tp) { node.port.postMessage({ t: 'tp', tp }); },
      dispose() {
        if (this.disposed) return; this.disposed = true;
        node.port.postMessage({ t: 'bye' });
        try { node.disconnect(); } catch (e) { /* */ }
        s.wrappers.delete(this); self.wrappers.delete(this);
        if (this.id) { self.byId.delete(this.id); self.call('destroy', { id: this.id }); }
      },
    };
    node.port.onmessage = (e) => { if (e.data.t === 'late') w.late = e.data.n; };
    s.wrappers.add(w); this.wrappers.add(w);
    w.start();
    return w;
  },
  // the live wrapper that belongs to an insert or a track (for its editor window and state)
  liveFor(owner) { for (const w of this.wrappers) if (!w.offline && !w.disposed && w.owner === owner) return w; return null; },
  async openEditor(owner) {
    if (!this.ok) { K.toast('Plug-ins need the desktop app (Mac, Windows or Linux).'); return; }
    const w = this.liveFor(owner);
    if (!w) { K.toast('That plug-in is not running — is the effect switched on?'); return; }
    if (w.ready) await w.ready;
    const r = await w.editor(true);
    if (!r.ok) K.toast((owner.plug ? owner.plug.name + ': ' : '') + (r.error || 'Its window could not be opened'), 4000);
  },
  // before a song is saved: collect fresh state from every running plug-in
  async flush() { await Promise.all(Array.from(this.wrappers).filter((w) => !w.offline && w.id).map((w) => w.saveState())); },
  label(plug) { return plug ? plug.name + (plug.vendor ? ' — ' + plug.vendor : '') : 'VST3 plug-in'; },
};

// the insert effect type: { type: 'vst3', plug: {path, cid, name, vendor}, state: {c, e} }
FX.register('vst3', {
  name: 'VST3 plug-in', short: 'VST3', params: [], plugin: true,
  about: 'A VST3 plug-in, running in its own process. Use “Open plug-in window” for its controls; its settings are saved in the song.',
  create(ctx, p, env) {
    const owner = env.owner || {};
    const input = ctx.createGain(), output = ctx.createGain();
    if (!owner.plug || !PLUG.ok) { input.connect(output); return { input, output, set() {}, dispose() { try { input.disconnect(); } catch (e) { /* */ } }, latency: () => 0 }; }
    const w = PLUG.create(ctx, owner, { offline: env.offline });
    input.connect(w.node); w.node.connect(output);
    return { input, output, plug: w, set() {}, latency: () => w.latency(), dispose() { try { input.disconnect(); } catch (e) { /* */ } w.dispose(); } };
  },
});
