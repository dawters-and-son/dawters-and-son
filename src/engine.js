// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — audio engine: mixer graph, transport, scheduler, recording, rendering
'use strict';

const WNODE = (ctx, name, outs, po) => new AudioWorkletNode(ctx, name, {
  numberOfInputs: 1, numberOfOutputs: outs, outputChannelCount: Array(outs).fill(2),
  channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers', processorOptions: po || {},
});

// ---------------- Mixer graph (built for the live context and again for offline renders) ----------------
class Graph {
  constructor(eng, ctx, proj, offline, opt) {
    this.eng = eng; this.ctx = ctx; this.offline = offline; this.opt = opt || {};
    this.tracks = new Map(); this.buses = [];
    const meter = !offline;
    this.mIn = ctx.createGain();
    this.mChan = WNODE(ctx, 'ds-channel', 1, { kind: 'master', meter, p: this.masterP(proj.master) });
    this.mIn.connect(this.mChan); this.mFx = { fx: [], fxSig: '' };
    if (offline) this.mChan.connect(ctx.destination);
    else {
      // live only: analysers before and after mastering, and a level-matched bypass path for A/B
      this.mOut = ctx.createGain(); this.mChan.connect(this.mOut); this.mOut.connect(eng.outNode);
      this.anPost = ctx.createAnalyser(); this.anPost.fftSize = 8192; this.anPost.smoothingTimeConstant = 0.82; this.mChan.connect(this.anPost);
      this.anPre = ctx.createAnalyser(); this.anPre.fftSize = 8192; this.anPre.smoothingTimeConstant = 0.82; this.mIn.connect(this.anPre);
      this.abPath = ctx.createGain(); this.abPath.gain.value = 0; this.mIn.connect(this.abPath); this.abPath.connect(eng.outNode);
    }
    if (meter) this.mChan.port.onmessage = (e) => { eng.meters.master = e.data; };
    for (let i = 0; i < M.NBUS; i++) {
      const pb = proj.buses[i];
      const b = { in: ctx.createGain(), chan: WNODE(ctx, 'ds-channel', 1, { kind: 'bus', meter, p: pb.ch }), fader: WNODE(ctx, 'ds-fader', 2, { meter, mute: pb.mute || !!(this.opt.busOnly && !this.opt.busOnly.has(i)) }) };
      b.in.connect(b.chan); b.chan.connect(b.fader); b.fader.connect(this.mIn, 0); b.fx = []; b.fxSig = '';
      if (meter) { const id = 'bus' + i; b.fader.port.onmessage = (e) => { eng.meters[id] = Object.assign(eng.meters[id] || {}, e.data); }; b.chan.port.onmessage = (e) => { const m = eng.meters[id] || (eng.meters[id] = {}); m.gr = e.data.gr; }; }
      this.buses.push(b);
    }
    this.sync(proj, true);
  }
  sync(proj, first) {
    this.proj = proj;
    const seen = new Set();
    for (const t of proj.tracks) { seen.add(t.id); if (!this.tracks.has(t.id)) this.addTrack(t); }
    for (const id of Array.from(this.tracks.keys())) if (!seen.has(id)) this.removeTrack(id);
    proj.buses.forEach((b, i) => { this.busParams(b, i); this.chainFx(this.buses[i], b.fx || [], this.buses[i].chan, this.buses[i].fader); });
    this.masterParams(proj.master);
    this.chainFx(this.mFx, proj.master.fx || [], this.mIn, this.mChan);
    for (const t of proj.tracks) { this.trackFx(t); this.trackRouting(t); this.trackParams(t); if (t.kind === 'inst') this.instParams(t); }
    this.mutes();
    void first;
  }
  addTrack(t) {
    const ctx = this.ctx, meter = !this.offline;
    const muted = this.isMuted(t);
    const n = { in: ctx.createGain(), chan: WNODE(ctx, 'ds-channel', 1, { kind: 'track', meter, p: t.ch }), fader: WNODE(ctx, 'ds-fader', 2, { meter, mono: !t.stereo, mute: muted }),
      fx: [], fxSig: '', sends: [], route: '' };
    n.in.connect(n.chan); n.chan.connect(n.fader);
    for (let i = 0; i < M.NSEND; i++) n.sends.push(ctx.createGain());
    if (t.kind === 'inst') this.makeInst(t, n);
    if (meter) {
      const eng = this.eng, id = t.id;
      n.fader.port.onmessage = (e) => { const m = eng.meters[id] || (eng.meters[id] = {}); m.pk = e.data.pk; m.rms = e.data.rms; };
      n.chan.port.onmessage = (e) => { const m = eng.meters[id] || (eng.meters[id] = {}); m.gr = e.data.gr; m.gate = e.data.gate; };
    }
    this.tracks.set(t.id, n);
  }
  makeInst(t, n) {
    if (n.inst) { try { n.inst.disconnect(); } catch (e) { /* */ } n.inst.port.postMessage({ t: 'panic' }); }
    const ev = this.opt.instEvents && this.opt.instEvents[t.id];
    n.inst = new AudioWorkletNode(this.ctx, 'ds-inst', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { type: t.inst.type, p: t.inst.p, samples: INST.samplePayload(this.eng, t.inst), events: ev || [] } });
    n.inst.connect(n.in);
    n.instSig = this.instSig(t);
  }
  instSig(t) { return t.inst.type + '|' + (t.inst.sample || '') + '|' + JSON.stringify(t.inst.padSamples || {}); }
  instParams(t) {
    const n = this.tracks.get(t.id); if (!n || t.kind !== 'inst') return;
    if (!n.inst || n.instSig !== this.instSig(t)) { this.makeInst(t, n); return; }
    n.inst.port.postMessage({ t: 'set', p: t.inst.p });
  }
  removeTrack(id) {
    const n = this.tracks.get(id); if (!n) return;
    if (n.inst) { try { n.inst.disconnect(); } catch (e) { /* */ } }
    [n.in, n.chan, n.fader, ...n.sends].forEach((x) => { try { x.disconnect(); } catch (e) { /* */ } });
    n.fx.forEach((f) => f.dispose());
    this.tracks.delete(id);
  }
  trackFx(t) { const n = this.tracks.get(t.id); if (n) this.chainFx(n, t.fx, n.chan, n.fader); }
  // insert chain: src -> fx... -> dst, rebuilt only when the list of effects changes
  chainFx(n, list, src, dst) {
    const active = list.filter((f) => f && f.on && FX.types[f.type]);
    const sig = active.map((f) => f.type + ':' + f.id).join(',');
    if (sig === n.fxSig && n.fxDst === dst) { active.forEach((f, i) => n.fx[i].set(Object.assign({}, f.p))); return; }
    try { src.disconnect(dst); } catch (e) { /* not connected directly */ }
    n.fx.forEach((f) => { try { src.disconnect(f.input); } catch (e) { /* */ } try { f.output.disconnect(); } catch (e) { /* */ } f.dispose(); });
    n.fx = active.map((f) => { const o = FX.types[f.type].create(this.ctx, Object.assign({}, f.p), { bpm: this.proj.bpm, eng: this.eng, id: f.id, offline: this.offline }); o.id = f.id; return o; });
    let prev = src;
    n.fx.forEach((f) => { prev.connect(f.input); prev = f.output; });
    prev.connect(dst);
    n.fxSig = sig; n.fxDst = dst;
  }
  // re-apply the insert chain of a track, mixbus or the master
  refreshFx(o) {
    if (this.tracks.has(o.id)) return this.trackFx(o);
    const i = this.proj.buses.indexOf(o);
    if (i >= 0) return this.chainFx(this.buses[i], o.fx, this.buses[i].chan, this.buses[i].fader);
    if (o === this.proj.master) this.chainFx(this.mFx, o.fx, this.mIn, this.mChan);
  }
  fxNode(id) { for (const n of [...this.tracks.values(), ...this.buses, this.mFx]) for (const f of n.fx) if (f.id === id) return f; return null; }
  tempo() { const all = [...this.tracks.values(), ...this.buses, this.mFx]; for (const n of all) n.fx.forEach((f) => f.tempo && f.tempo()); }
  dest(out) { if (out && out.startsWith('bus')) { const b = this.buses[+out.slice(3)]; if (b) return b.in; } return this.mIn; }
  trackRouting(t) {
    const n = this.tracks.get(t.id); if (!n) return;
    const sig = t.out + '|' + t.sends.map((s) => (s.pre ? 1 : 0)).join('');
    if (sig !== n.route) {
      try { n.fader.disconnect(); } catch (e) { /* */ }
      // bus-only renders keep a track's sends but drop its direct path to the master (unless that track was picked too)
      const direct = !(t.out && t.out.startsWith('bus'));
      if (!(this.opt.busOnly && direct && !(this.opt.only && this.opt.only.has(t.id)))) n.fader.connect(this.dest(t.out), 0);
      n.sends.forEach((g, i) => { try { g.disconnect(); } catch (e) { /* */ } n.fader.connect(g, t.sends[i].pre ? 1 : 0); g.connect(this.buses[i].in); });
      n.route = sig;
    }
    n.sends.forEach((g, i) => this.setP(g.gain, t.sends[i].lvl));
  }
  trackParams(t, skipAuto) {
    const n = this.tracks.get(t.id); if (!n) return;
    n.chan.port.postMessage({ type: 'set', p: t.ch });
    n.fader.port.postMessage({ type: 'mono', on: !t.stereo });
    if (skipAuto) return;
    const now = this.ctx.currentTime, auto = this.eng.playing && !this.offline;
    if (!(auto && t.env.vol.on)) { const g = n.fader.parameters.get('gain'); g.cancelScheduledValues(now); this.setP(g, t.env.vol.on ? M.envAt(t.env.vol, this.offline ? 0 : this.eng.pos(), 1) : t.fader); }
    if (!(auto && t.env.pan.on)) { const p = n.fader.parameters.get('pan'); p.cancelScheduledValues(now); this.setP(p, t.env.pan.on ? M.envAt(t.env.pan, this.offline ? 0 : this.eng.pos(), 0) : t.pan); }
  }
  busParams(b, i) {
    const n = this.buses[i]; if (!n) return;
    n.chan.port.postMessage({ type: 'set', p: b.ch });
    this.setP(n.fader.parameters.get('gain'), b.fader);
    this.setP(n.fader.parameters.get('pan'), b.pan);
    n.fader.port.postMessage({ type: 'mute', on: b.mute || !!(this.opt.busOnly && !this.opt.busOnly.has(i)) });
  }
  // renders can override the master: bypass it (stems, bounces) or drive it into the limiter (loudness mastering)
  masterP(m) {
    const o = this.opt, p = Object.assign({}, m.ch, { bypass: !!o.bypassMaster || m.ch.bypass });
    if (o.ceiling !== undefined && !o.bypassMaster) { p.ceiling = o.ceiling; p.limOn = true; p.bypass = false; }
    return p;
  }
  masterParams(m) {
    this.mChan.port.postMessage({ type: 'set', p: this.masterP(m) });
    this.setP(this.mChan.parameters.get('gain'), this.opt.bypassMaster ? 1 : Math.min(16, m.fader * U.undb(this.opt.driveDb !== undefined ? this.opt.driveDb : (m.drive || 0))));
  }
  isMuted(t) {
    if (this.opt.only && !this.opt.busOnly) return !this.opt.only.has(t.id);
    const only = this.opt.solo;
    if (only) return t.id !== only;
    return t.mute || (this.proj.tracks.some((x) => x.solo) && !t.solo);
  }
  mutes() {
    for (const t of this.proj.tracks) {
      const n = this.tracks.get(t.id); if (!n) continue;
      n.fader.port.postMessage({ type: 'mute', on: this.isMuted(t) });
    }
  }
  setP(par, v) { if (this.offline) { par.cancelScheduledValues(0); par.setValueAtTime(v, 0); } else par.setTargetAtTime(v, this.ctx.currentTime, 0.008); }
  dispose() {
    for (const id of Array.from(this.tracks.keys())) this.removeTrack(id);
    [...this.buses, this.mFx].forEach((b) => b.fx.forEach((f) => f.dispose()));
    this.buses.forEach((b) => [b.in, b.chan, b.fader].forEach((x) => x.disconnect()));
    [this.mIn, this.mChan, this.mOut, this.anPre, this.anPost, this.abPath].forEach((x) => x && x.disconnect());
  }
}

// ---------------- Engine ----------------
class Engine {
  constructor() {
    this.buffers = new Map(); this.meters = {}; this.segs = new Map();
    this.playing = false; this.recording = false; this.position = 0; this.anchors = [];
    this.sources = []; this.input = null; this.inLevels = []; this.take = null;
    this.listeners = {}; this.matrix = { active: {}, queue: {} }; this.sustained = new Set(); this.sustain = false;
  }
  on(ev, fn) { (this.listeners[ev] || (this.listeners[ev] = [])).push(fn); }
  emit(ev, a) { (this.listeners[ev] || []).forEach((f) => f(a)); }
  async init(settings) {
    this.settings = settings;
    const opts = { latencyHint: settings.latency || 'interactive' };
    if (settings.sr) opts.sampleRate = settings.sr;
    try { this.ctx = new AudioContext(opts); } catch (e) { this.ctx = new AudioContext(); }
    this.wurl = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    try { await this.ctx.audioWorklet.addModule(this.wurl); }
    catch (err) { // file:// pages can't load blob: worklets in some browsers — fall back to a data: URL
      this.wurl = 'data:application/javascript;base64,' + btoa(unescape(encodeURIComponent(WORKLET_SRC)));
      await this.ctx.audioWorklet.addModule(this.wurl);
    }
    this.outNode = this.ctx.createGain(); this.outNode.connect(this.ctx.destination);
    this.clickOut = this.ctx.createGain(); this.clickOut.gain.value = 0.5; this.clickOut.connect(this.ctx.destination);
    this.makeClicks();
    if (settings.outDev && this.ctx.setSinkId) { try { await this.ctx.setSinkId(settings.outDev); } catch (e) { /* device gone */ } }
    this.timer = setInterval(() => this.tick(), 25);
    document.addEventListener('visibilitychange', () => this.tick());
  }
  get sr() { return this.ctx.sampleRate; }
  setProject(p) {
    this.proj = p;
    if (this.graph) this.graph.sync(p); else this.graph = new Graph(this, this.ctx, p, false);
    this.clipsChanged();
  }
  sync() { this.graph.sync(this.proj); this.clipsChanged(); }
  clipsChanged() {
    this.segs = new Map();
    for (const t of this.proj.tracks) this.segs.set(t.id, M.flatten(t.clips.filter((c) => this.buffers.has(c.buf))));
    if (this.playing) this.reschedule();
  }
  makeClicks() {
    const mk = (f, a) => { const sr = this.sr, n = Math.round(sr * 0.04), b = this.ctx.createBuffer(1, n, sr), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.sin(2 * Math.PI * f * i / sr) * Math.exp(-i / (sr * 0.008)) * a; return b; };
    this.clickHi = mk(1760, 0.9); this.clickLo = mk(1175, 0.6);
  }
  // ------- buffers -------
  addBuffer(ab, name, id, persist = true) {
    id = id || U.uid('b');
    this.buffers.set(id, { ab, name, peaks: U.computePeaks(ab) });
    if (persist) this.persistBuffer(id);
    return id;
  }
  async persistBuffer(id) {
    const b = this.buffers.get(id); if (!b) return;
    const ch = []; for (let c = 0; c < b.ab.numberOfChannels; c++) ch.push(b.ab.getChannelData(c));
    try { await U.idb.put('buffers', id, { sr: b.ab.sampleRate, name: b.name, ch }); } catch (e) { console.warn('buffer save failed', e); }
  }
  makeBuffer(chs, sr) {
    const ab = this.ctx.createBuffer(chs.length, Math.max(1, chs[0].length), sr || this.sr);
    chs.forEach((d, c) => ab.copyToChannel(d, c));
    return ab;
  }
  async loadBufferFromDb(id) {
    const r = await U.idb.get('buffers', id); if (!r) return false;
    this.addBuffer(this.makeBuffer(r.ch, r.sr), r.name, id, false); return true;
  }
  async decodeFile(file) {
    const ab = await file.arrayBuffer();
    if (/\.wav$/i.test(file.name)) { const w = U.decodeWav(new Uint8Array(ab)); if (w && w.ch.length) return this.makeBuffer(w.ch.slice(0, 2), w.sr); }
    const dec = await this.ctx.decodeAudioData(ab);
    if (dec.numberOfChannels > 2) { const ch = [dec.getChannelData(0), dec.getChannelData(1)]; return this.makeBuffer(ch, dec.sampleRate); }
    return dec;
  }
  // ------- transport -------
  pos() {
    if (!this.playing) return this.position;
    const now = this.ctx.currentTime - (this.ctx.outputLatency || 0) * 0;
    let a = this.anchors[0];
    for (const x of this.anchors) if (x.ct <= now) a = x; else break;
    return a ? a.sp + (now - a.ct) : this.position;
  }
  locate(t) {
    if (this.playing) { this.position = t; this.restartAt(t); } else { this.position = t; this.graph.sync(this.proj); }
    this.emit('locate', t);
  }
  async play(from) {
    if (this.ctx.state !== 'running') await this.ctx.resume();
    if (this.playing) return;
    const t = from !== undefined ? from : this.position;
    this.playing = true;
    this.restartAt(t);
    this.emit('state');
    return this.sct0;
  }
  restartAt(t) {
    this.killSources();
    const st = this.ctx.currentTime + 0.06;
    this.sp = t; this.sct = st; this.sct0 = st; this.fresh = true;
    this.anchors = [{ ct: st, sp: t }];
    this.tick();
  }
  reschedule() { if (this.playing) this.restartAt(this.pos() + 0.06); }
  async stop() {
    if (this.recording) await this.stopRecording();
    if (!this.playing) { this.position = 0; this.emit('locate', 0); this.emit('state'); return; }
    this.position = this.pos();
    this.playing = false;
    this.killSources();
    if (this.position < 0) this.position = 0;
    this.graph.sync(this.proj);
    this.emit('state');
  }
  killSources() {
    const now = this.ctx.currentTime;
    for (const s of this.sources) {
      try { s.g.gain.cancelScheduledValues(now); s.g.gain.setValueAtTime(s.g.gain.value, now); s.g.gain.linearRampToValueAtTime(0, now + 0.012); s.src.stop(now + 0.02); } catch (e) { /* already stopped */ }
    }
    this.sources = [];
    for (const n of this.graph.tracks.values()) { ['gain', 'pan'].forEach((k) => n.fader.parameters.get(k).cancelScheduledValues(now)); if (n.inst) n.inst.port.postMessage({ t: 'clear' }); }
  }
  tick() {
    if (!this.playing) return;
    if (Object.keys(this.matrix.queue).length || Object.values(this.matrix.active).some((c) => c.until !== undefined)) this.matrixTick(false);
    const ctx = this.ctx, look = document.hidden ? 1.6 : 0.25;
    const target = ctx.currentTime + look;
    const L = this.proj.loop;
    let guard = 0;
    while (this.sct < target && guard++ < 64) {
      let a = this.sp, b = a + (target - this.sct);
      const looping = L.on && L.e - L.s > 0.05 && a < L.e;
      if (looping && b >= L.e) {
        this.window(this.graph, ctx, a, L.e, this.sct, this.fresh, L.e, true);
        this.sct += L.e - a; this.sp = L.s; this.fresh = true;
        this.anchors.push({ ct: this.sct, sp: L.s });
        if (this.anchors.length > 64) this.anchors.splice(0, this.anchors.length - 64);
      } else {
        this.window(this.graph, ctx, a, b, this.sct, this.fresh, looping ? L.e : Infinity, false);
        this.sct += b - a; this.sp = b; this.fresh = false;
      }
    }
    // tidy finished sources
    const now = ctx.currentTime;
    if (this.sources.length > 200) this.sources = this.sources.filter((s) => s.end > now);
  }
  // schedule everything that happens in song window [a,b) beginning at ctx time ca
  window(graph, ctx, a, b, ca, fresh, cap, endsAtLoop) {
    const live = graph === this.graph;
    for (const t of this.proj.tracks) {
      const n = graph.tracks.get(t.id); if (!n) continue;
      if (t.kind === 'inst' && live && n.inst) {
        const sr = ctx.sampleRate, ev = this.noteEvents(t, a, b, cap).map((x) => [Math.round((ca + (x[0] - a)) * sr), x[1], x[2], x[3]]);
        if (ev.length) n.inst.port.postMessage({ t: 'ev', ev });
      }
      const segs = this.segs.get(t.id) || [];
      const cov = live ? this.recCover(t) : null; // recording over this track: its old audio is silent there, like tape
      for (const g of segs) {
        let from;
        if (g.s >= a && g.s < b) from = g.s;
        else if (fresh && g.s < a && g.e > a) from = a;
        else if (cov && g.s < a && g.e > a && cov[1] > a && cov[1] < b) from = a; // the old audio comes back after a punch-out
        else continue;
        const to = Math.min(g.e, cap);
        if (to - from < 1e-5) continue;
        if (!cov) { this.startSeg(ctx, n.in, g.c, from, to, ca + (from - a), live); continue; }
        // play only the parts outside the covered range [cov0, cov1)
        if (from < cov[0]) { const e = Math.min(to, cov[0]); if (e - from > 1e-5) this.startSeg(ctx, n.in, g.c, from, e, ca + (from - a), live); }
        if (to > cov[1]) { const st = Math.max(from, cov[1]); if (to - st > 1e-5 && st >= a - 1e-9 && st < b) this.startSeg(ctx, n.in, g.c, st, to, ca + (st - a), live); }
      }
      // envelopes
      for (const k of ['vol', 'pan']) {
        const env = t.env[k]; if (!env.on) continue;
        const par = n.fader.parameters.get(k === 'vol' ? 'gain' : 'pan'), def = k === 'vol' ? 1 : 0;
        if (fresh) { par.cancelScheduledValues(ca); par.setValueAtTime(M.envAt(env, a, def), ca); }
        for (const p of env.pts) if (p.t > a && p.t < b) par.linearRampToValueAtTime(p.v, ca + (p.t - a));
        if (endsAtLoop || b === cap) par.linearRampToValueAtTime(M.envAt(env, b, def), ca + (b - a) - 1e-4);
      }
    }
    // metronome / count-in
    if (live) {
      const st = this.settings, beat = 60 / this.proj.bpm, bpb = this.proj.sig[0];
      const countTo = this.take ? this.take.recStart : -Infinity;
      if (st.click || this.countIn) {
        for (let k = Math.ceil(a / beat - 1e-9); k * beat < b; k++) {
          const tt = k * beat;
          if (!(st.click || (this.countIn && tt < countTo - 1e-6))) continue;
          const s = ctx.createBufferSource(); s.buffer = ((k % bpb) + bpb) % bpb === 0 ? this.clickHi : this.clickLo;
          s.connect(this.clickOut); s.start(ca + (tt - a));
        }
      }
    }
  }
  // song-time range where an armed audio track's existing clips are silenced while recording
  recCover(t) {
    const tk = this.take; if (!this.recording || !tk || t.kind === 'inst' || !tk.armed.some((x) => x.id === t.id)) return null;
    if (tk.punch) return [tk.punch[0], tk.punch[1]];
    const L = this.proj.loop;
    return [L.on ? Math.min(tk.recStart, L.s) : tk.recStart, Infinity];
  }
  startSeg(ctx, dest, c, from, to, at, live) {
    const b = this.buffers.get(c.buf); if (!b) return;
    const src = ctx.createBufferSource(); src.buffer = b.ab;
    const g = ctx.createGain(); src.connect(g); g.connect(dest);
    const micro = 0.003, end = c.start + c.len;
    const mi = from > c.start + 1e-4, mo = to < end - 1e-4;
    const v = (t) => { let x = M.clipGainAt(c, t); if (mi && t < from + micro) x *= Math.max(0, (t - from) / micro); if (mo && t > to - micro) x *= Math.max(0, (to - t) / micro); return x; };
    const pts = new Set([from, to]);
    if (mi) pts.add(Math.min(to, from + micro));
    if (mo) pts.add(Math.max(from, to - micro));
    if (c.fi > 0) pts.add(c.start + c.fi);
    if (c.fo > 0) pts.add(end - c.fo);
    const arr = Array.from(pts).filter((t) => t >= from && t <= to).sort((x, y) => x - y);
    arr.forEach((t, i) => { const ct = Math.max(0, at + (t - from)); if (i === 0) g.gain.setValueAtTime(v(t), ct); else g.gain.linearRampToValueAtTime(v(t), ct); });
    const off = c.off + (from - c.start);
    const dur = to - from;
    if (off >= b.ab.duration) return;
    src.start(Math.max(0, at), Math.max(0, off), dur);
    if (live) this.sources.push({ src, g, end: at + dur });
  }
  // ------- patterns & instruments -------
  beat() { return 60 / this.proj.bpm; }
  // note events [songTime, on(1)/off(0), note, vel] with ons in [a,b); offs may fall later (queued in the worklet)
  noteEvents(t, a, b, cap) {
    const out = [], P = this.proj, beat = this.beat(), mx = this.matrix.active[t.id];
    const play = (c) => {
      if (c.mute) return;
      const pat = P.patterns[c.pat]; if (!pat || !pat.notes.length) return;
      const per = pat.len * beat, base = c.start - c.off, cEnd = c.start + c.len;
      const lo = Math.max(a, c.start), hi = Math.min(b, cEnd); if (hi <= lo) return;
      const vs = U.clamp(c.gain === undefined ? 1 : c.gain, 0, 2);
      for (let k = Math.floor((lo - base) / per) - 1; base + k * per < hi; k++) {
        for (const nt of pat.notes) {
          const on = base + k * per + nt.t * beat;
          if (on < lo - 1e-9 || on >= hi || on < c.start - 1e-9) continue;
          const off = Math.min(on + Math.max(0.01, nt.d * beat), cEnd, cap) - 0.0005;
          if (off <= on) continue;
          const v = Math.min(1, nt.v * vs);
          out.push([on, 1, nt.n, v], [off, 0, nt.n, 0]);
        }
      }
    };
    if (mx) { if (mx.pat && P.patterns[mx.pat]) play({ pat: mx.pat, start: mx.from, len: (mx.until || Infinity) - mx.from, off: 0, gain: 1 }); }
    else for (const c of t.clips) if (c.pat) play(c);
    return out;
  }
  instEventsAll(s, e, cap, sr) { // for offline renders: frames relative to s
    const o = {};
    for (const t of this.proj.tracks) if (t.kind === 'inst') o[t.id] = this.noteEvents(t, s, e, cap).map((x) => [Math.round((x[0] - s) * sr), x[1], x[2], x[3]]);
    return o;
  }
  liveNote(trackId, on, n, v) {
    const g = this.graph.tracks.get(trackId); if (!g || !g.inst) return;
    g.inst.port.postMessage({ t: 'now', k: on ? 1 : 0, n, v });
    if (this.recording && this.take && this.take.midi) {
      const t = this.proj.tracks.find((x) => x.id === trackId);
      if (t && t.arm) this.take.midi.push([this.pos() - (this.ctx.outputLatency || 0), on ? 1 : 0, n, v, trackId]);
    }
  }
  panicInst() { for (const n of this.graph.tracks.values()) if (n.inst) n.inst.port.postMessage({ t: 'panic' }); }
  // GrooveMatrix: launch / stop patterns per track, quantized to the next bar while playing
  nextBar(t) { const bar = this.beat() * this.proj.sig[0]; return Math.ceil((t - 1e-6) / bar) * bar; }
  launch(trackId, patId) {
    const now = this.pos(), at = this.playing ? this.nextBar(now + 0.35) : this.position;
    const cur = this.matrix.active[trackId];
    if (cur && cur.until === undefined) cur.until = at;
    this.matrix.queue[trackId] = { pat: patId, from: at };
    this.matrixTick(!this.playing);
    this.emit('matrix');
    return at;
  }
  stopCell(trackId) {
    const cur = this.matrix.active[trackId], at = this.playing ? this.nextBar(this.pos() + 0.35) : this.position;
    delete this.matrix.queue[trackId];
    if (cur) { if (this.playing) cur.until = at; else delete this.matrix.active[trackId]; }
    this.matrixTick(!this.playing); this.emit('matrix');
  }
  matrixTick(force) { // promote queued launches whose time has come (or immediately when stopped)
    const now = this.playing ? this.pos() : Infinity;
    let changed = false;
    for (const id in this.matrix.queue) {
      const q = this.matrix.queue[id];
      if (!this.playing || q.from <= now + 0.3) {
        const cur = this.matrix.active[id];
        if (this.onMatrixRec && cur) this.onMatrixRec(id, cur, q.from);
        this.matrix.active[id] = { pat: q.pat, from: q.from };
        delete this.matrix.queue[id]; changed = true;
      }
    }
    for (const id in this.matrix.active) { const c = this.matrix.active[id]; if (c.until !== undefined && c.until <= now) { if (this.onMatrixRec) this.onMatrixRec(id, c, c.until); delete this.matrix.active[id]; changed = true; } }
    if (changed) this.emit('matrix');
    void force;
  }
  matrixClear() { if (this.onMatrixRec) for (const id in this.matrix.active) this.onMatrixRec(id, this.matrix.active[id], this.pos()); this.matrix = { active: {}, queue: {} }; this.reschedule(); this.emit('matrix'); }
  // ------- MIDI input -------
  async initMidi() {
    if (this.midi !== undefined) return this.midi;
    this.midi = null;
    if (!navigator.requestMIDIAccess) return null;
    try {
      this.midi = await navigator.requestMIDIAccess({ sysex: false });
      const hook = () => { for (const inp of this.midi.inputs.values()) inp.onmidimessage = (m) => this.midiMsg(m.data); this.emit('midi'); };
      hook(); this.midi.onstatechange = hook;
    } catch (e) { this.midi = null; }
    return this.midi;
  }
  midiMsg(d) {
    const st = d[0] & 0xf0, target = this.midiTarget ? this.midiTarget() : null;
    if (!target) return;
    if (st === 0x90 && d[2] > 0) { if (this.sustain) this.sustained.delete(d[1]); this.liveNote(target, true, d[1], d[2] / 127); this.emit('note', { n: d[1], on: true }); }
    else if (st === 0x80 || (st === 0x90 && d[2] === 0)) { if (this.sustain) this.sustained.add(d[1]); else this.liveNote(target, false, d[1], 0); this.emit('note', { n: d[1], on: false }); }
    else if (st === 0xb0 && d[1] === 64) { const on = d[2] >= 64; if (!on && this.sustain) { for (const n of this.sustained) this.liveNote(target, false, n, 0); this.sustained.clear(); } this.sustain = on; }
    else if (st === 0xb0 && (d[1] === 123 || d[1] === 120)) this.panicInst();
  }
  setBpm(bpm) { this.proj.bpm = bpm; this.graph.tempo(); this.reschedule(); }
  // ------- input & recording -------
  async listInputs() {
    try { const d = await navigator.mediaDevices.enumerateDevices(); return { ins: d.filter((x) => x.kind === 'audioinput'), outs: d.filter((x) => x.kind === 'audiooutput') }; } catch (e) { return { ins: [], outs: [] }; }
  }
  async openInput() {
    if (this.input) return this.input;
    const st = this.settings;
    const c = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (st.inDev) c.deviceId = { exact: st.inDev };
    let stream;
    if (window.dawNative && window.dawNative.micAccess) { const ok = await window.dawNative.micAccess(); if (!ok) throw new Error('Microphone access is off for DAWters — turn it on in System Settings → Privacy & Security → Microphone'); }
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: c }); }
    catch (e) { if (st.inDev) { delete c.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio: c }); } else throw e; }
    const tr = stream.getAudioTracks()[0], s = tr.getSettings ? tr.getSettings() : {};
    const nch = Math.max(1, Math.min(2, s.channelCount || 2));
    const src = this.ctx.createMediaStreamSource(stream);
    const rec = new AudioWorkletNode(this.ctx, 'ds-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: nch, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    const sink = this.ctx.createGain(); sink.gain.value = 0;
    src.connect(rec); rec.connect(sink); sink.connect(this.ctx.destination);
    const split = this.ctx.createChannelSplitter(2); src.connect(split);
    rec.port.onmessage = (e) => this.recMsg(e.data);
    this.input = { stream, src, rec, sink, split, nch, inLat: s.latency || 0, label: tr.label, monitors: new Map() };
    this.updateMonitors();
    this.emit('input');
    return this.input;
  }
  closeInput() {
    const i = this.input; if (!i) return;
    i.stream.getTracks().forEach((t) => t.stop());
    [i.src, i.rec, i.sink, i.split].forEach((n) => n.disconnect());
    i.monitors.forEach((m) => m.g.disconnect());
    this.input = null; this.emit('input');
  }
  chanFor(t) { const i = this.input; const n = i ? i.nch : 2; return t.input === '2' && n > 1 ? [1] : t.input === '1+2' ? (n > 1 ? [0, 1] : [0, 0]) : [0]; }
  updateMonitors() {
    const i = this.input; if (!i) return;
    const want = new Set(this.proj.tracks.filter((t) => t.mon).map((t) => t.id));
    for (const [id, m] of i.monitors) {
      const t = this.proj.tracks.find((x) => x.id === id);
      if (!want.has(id) || !t || m.key !== t.input) { m.g.disconnect(); m.merge.disconnect(); i.monitors.delete(id); }
    }
    for (const t of this.proj.tracks) {
      if (!want.has(t.id) || i.monitors.has(t.id)) continue;
      const n = this.graph.tracks.get(t.id); if (!n) continue;
      const ch = this.chanFor(t), merge = this.ctx.createChannelMerger(2), g = this.ctx.createGain();
      if (ch.length === 1) { i.split.connect(merge, ch[0], 0); i.split.connect(merge, ch[0], 1); }
      else { i.split.connect(merge, ch[0], 0); i.split.connect(merge, ch[1], 1); }
      merge.connect(g); g.connect(n.in);
      i.monitors.set(t.id, { g, merge, key: t.input });
    }
  }
  recMsg(m) {
    if (m.t === 'lvl') this.inLevels = m.pk;
    else if (m.t === 'chunk' && this.take) {
      this.take.chunks.push(m);
      // live overview peaks
      const blk = 512;
      for (let i = 0; i < m.ch[0].length; i += blk) {
        let mx = 0; for (const d of m.ch) for (let k = i; k < Math.min(i + blk, d.length); k++) { const a = Math.abs(d[k]); if (a > mx) mx = a; }
        this.take.peaks.push(mx);
      }
    } else if (m.t === 'stopped' && this._stopRes) { this._stopRes(); this._stopRes = null; }
  }
  latency() {
    const st = this.settings;
    if (st.recLatCal != null) return st.recLatCal + this.limLatency(this.sr) / this.sr + (st.recNudgeMs || 0) / 1000;
    const est = (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0) + (this.input ? this.input.inLat : 0) + this.limLatency(this.sr) / this.sr;
    return est + (st.recNudgeMs || 0) / 1000;
  }
  async record() {
    const armedAll = this.proj.tracks.filter((t) => t.arm);
    if (!armedAll.length) throw new Error('Arm a track first (the red ● on a track).');
    const armed = armedAll.filter((t) => t.kind !== 'inst');
    if (armed.length) await this.openInput();
    if (this.playing) await this.stop();
    const P = this.proj, bar = 60 / P.bpm * P.sig[0];
    const recStart = P.punch.on ? P.punch.s : this.position;
    let from = recStart;
    this.countIn = false;
    if (P.punch.on) from = Math.max(P.loop.on ? recStart : -bar, recStart - bar);
    else if (this.settings.countIn) { from = recStart - bar; this.countIn = true; }
    this.take = { chunks: [], peaks: [], recStart, armed: armed.map((t) => ({ id: t.id, ch: this.chanFor(t), name: t.name })), lat: armed.length ? this.latency() : 0, punch: P.punch.on ? [P.punch.s, P.punch.e] : null, midi: [], midiTracks: armedAll.filter((t) => t.kind === 'inst').map((t) => t.id) };
    this.recording = true;
    const ct0 = await this.play(from);
    const ctxRec = ct0 + (recStart - from);
    this.take.c0 = ctxRec;
    if (armed.length) this.input.rec.port.postMessage({ type: 'start', at: Math.round(ctxRec * this.sr) });
    this.emit('state');
  }
  async stopRecording() {
    if (!this.recording) return;
    this.recording = false;
    const audio = this.take && this.take.armed.length && this.input;
    const done = audio ? new Promise((r) => { this._stopRes = r; setTimeout(r, 1500); }) : Promise.resolve();
    if (audio) this.input.rec.port.postMessage({ type: 'stop' });
    const anchors = this.anchors.slice(), endCt = this.ctx.currentTime, endPos = this.pos();
    await done;
    const take = this.take; this.take = null; this.countIn = false;
    this.emit('state');
    if (!take) return;
    if (take.midi && take.midiTracks.length) this.emit('midiTake', { notes: take.midi, recStart: take.recStart, end: endPos, tracks: take.midiTracks, punch: take.punch });
    if (!take.chunks.length) return;
    this.emit('take', this.finishTake(take, anchors, endCt));
  }
  finishTake(take, anchors, endCt) {
    const sr = this.sr, f0 = take.chunks[0].frame;
    const total = take.chunks.reduce((a, c) => Math.max(a, c.frame + c.ch[0].length), 0) - f0;
    const nch = take.chunks[0].ch.length;
    const raw = []; for (let c = 0; c < nch; c++) raw.push(new Float32Array(total));
    for (const ck of take.chunks) for (let c = 0; c < nch; c++) raw[c].set(ck.ch[c], ck.frame - f0);
    const c0 = f0 / sr, cEnd = c0 + total / sr, lat = take.lat;
    // song-time runs from transport anchors
    const runs = [];
    anchors.forEach((a, i) => { const ce = i + 1 < anchors.length ? anchors[i + 1].ct : Math.max(endCt, cEnd); runs.push({ ct: a.ct, sp: a.sp, ce }); });
    const clipsPlan = [];
    let takeNo = 0;
    for (const r of runs) {
      // audio captured at ctx c maps to song r.sp + (c - lat - r.ct)
      let s = r.sp + Math.max(0, c0 - lat - r.ct);
      let e = r.sp + (Math.min(r.ce, cEnd - lat) - r.ct);
      s = Math.max(s, take.recStart); if (take.punch) { s = Math.max(s, take.punch[0]); e = Math.min(e, take.punch[1]); }
      if (e - s < 0.02) continue;
      const off = (s - r.sp) + r.ct + lat - c0;
      if (off < 0) continue;
      takeNo++;
      clipsPlan.push({ s, len: e - s, off, take: takeNo });
    }
    const out = [];
    for (const a of take.armed) {
      let chs;
      if (a.ch.length === 2) chs = [raw[a.ch[0]] || raw[0], raw[a.ch[1]] || raw[0]];
      else chs = [raw[a.ch[0]] || raw[0]];
      const ab = this.makeBuffer(chs, sr);
      out.push({ trackId: a.id, ab, name: a.name, plan: clipsPlan, stereo: chs.length === 2 });
    }
    return out;
  }
  async calibrate() {
    await this.openInput();
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const sr = this.sr, t0 = this.ctx.currentTime + 0.3, gap = 0.5, N = 5;
    const pulses = [];
    for (let k = 0; k < N; k++) {
      const s = this.ctx.createBufferSource(); s.buffer = this.clickHi; s.connect(this.clickOut); s.start(t0 + k * gap); pulses.push(t0 + k * gap);
    }
    this.take = { chunks: [], peaks: [], recStart: 0, armed: [] };
    this.input.rec.port.postMessage({ type: 'start', at: Math.round(t0 * sr) });
    await new Promise((r) => setTimeout(r, (N * gap + 0.6) * 1000));
    const done = new Promise((r) => { this._stopRes = r; setTimeout(r, 1000); });
    this.input.rec.port.postMessage({ type: 'stop' });
    await done;
    const take = this.take; this.take = null;
    if (!take.chunks.length) throw new Error('No input received');
    const f0 = take.chunks[0].frame, total = take.chunks.reduce((a, c) => Math.max(a, c.frame + c.ch[0].length), 0) - f0;
    const d = new Float32Array(total);
    for (const ck of take.chunks) d.set(ck.ch[0], ck.frame - f0);
    let mx = 0; for (let i = 0; i < d.length; i++) mx = Math.max(mx, Math.abs(d[i]));
    if (mx < 0.01) throw new Error('Too quiet — turn the speakers up or hold the mic near them');
    const res = [];
    for (const p of pulses) {
      const st = Math.round((p - f0 / sr) * sr), lim = Math.min(d.length, st + Math.round(sr * 0.4));
      let local = 0; for (let i = st; i < lim; i++) local = Math.max(local, Math.abs(d[i]));
      for (let i = Math.max(0, st); i < lim; i++) if (Math.abs(d[i]) > local * 0.5) { res.push((i - st) / sr); break; }
    }
    if (res.length < 3) throw new Error('Could not hear the clicks clearly');
    res.sort((a, b) => a - b);
    return res[Math.floor(res.length / 2)];
  }
  // ------- offline rendering -------
  async render(o) {
    const sr = o.sr || this.sr, s = o.s, e = o.e, tail = o.tail || 0;
    const lat = this.limLatency(sr, o.bypassMaster, o.ceiling !== undefined);
    const len = Math.max(1, Math.ceil((e - s + tail) * sr));
    const oc = new OfflineAudioContext(2, len + lat, sr);
    await oc.audioWorklet.addModule(this.wurl);
    const g = new Graph(this, oc, this.proj, true, { solo: o.solo, only: o.only, busOnly: o.busOnly, bypassMaster: o.bypassMaster, driveDb: o.driveDb, ceiling: o.ceiling, instEvents: this.instEventsAll(s, e + tail, e, sr) });
    this.window(g, oc, s, e + tail, 0, true, e, false);
    const raw = await oc.startRendering();
    g.dispose();
    if (!lat) return raw;
    const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: sr });
    for (let c = 0; c < 2; c++) buf.copyToChannel(raw.getChannelData(c).subarray(lat, lat + len), c);
    return buf;
  }
  // the master limiter looks ahead; its delay is compensated in renders and recording offsets
  limLatency(sr, bypass, forceLim) { const m = this.proj.master.ch; return !bypass && (forceLim || (m.limOn && !m.bypass)) ? Math.max(8, Math.round(sr * 0.0015)) : 0;
  }
}
