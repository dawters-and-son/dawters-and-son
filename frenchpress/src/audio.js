/* France's French Press — Web Audio side: per-stem channel strips, master chain, transport,
 * metering and offline rendering. The same builder makes the live and the offline graphs,
 * so what you hear is what you export.
 * SPDX-License-Identifier: GPL-3.0-or-later  Copyright (C) 2026 Josh Wilk */
var AUDIO = (function () {
  'use strict';
  var db2g = function (d) { return Math.pow(10, d / 20); };

  function defaultEQ() {
    return { hp: { on: false, f: 30 }, ls: { f: 100, g: 0 }, b1: { f: 300, g: 0, q: 1 }, b2: { f: 1200, g: 0, q: 1 }, b3: { f: 4500, g: 0, q: 1 }, hs: { f: 9000, g: 0 }, lp: { on: false, f: 18000 } };
  }
  function defaultStrip() {
    return { gain: 0, pan: 0, width: 1, monoBass: 0, mute: false, solo: false, eq: defaultEQ(),
      comp: { on: false, th: -20, ratio: 3, att: 10, rel: 150, knee: 6, makeup: 0 },
      drive: { amt: 0, mix: 1 } };
  }
  function defaultMaster() {
    var m = defaultStrip();
    m.glue = m.comp; delete m.comp; m.glue.ratio = 2; m.glue.th = -16; m.glue.att = 30; m.glue.rel = 200;
    m.limiter = { on: true, drive: 0, ceiling: -1, release: 80 };
    m.target = -14; m.preview = false; m.previewGain = 0;
    return m;
  }

  // ---------- builders ----------
  function makeShaperCurve(amt) {
    var n = 2048, c = new Float32Array(n), k = 1 + amt * 9, nk = Math.tanh(k);
    for (var i = 0; i < n; i++) { var x = i / (n - 1) * 2 - 1; c[i] = Math.tanh(k * x) / nk; }
    return c;
  }
  function buildEQ(ctx) {
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
    var ls = ctx.createBiquadFilter(); ls.type = 'lowshelf';
    var b1 = ctx.createBiquadFilter(); b1.type = 'peaking';
    var b2 = ctx.createBiquadFilter(); b2.type = 'peaking';
    var b3 = ctx.createBiquadFilter(); b3.type = 'peaking';
    var hs = ctx.createBiquadFilter(); hs.type = 'highshelf';
    var lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 0.707;
    hp.connect(ls); ls.connect(b1); b1.connect(b2); b2.connect(b3); b3.connect(hs); hs.connect(lp);
    var nyq = ctx.sampleRate / 2;
    return { input: hp, output: lp, nodes: { hp: hp, ls: ls, b1: b1, b2: b2, b3: b3, hs: hs, lp: lp },
      set: function (e) {
        hp.frequency.value = e.hp.on ? e.hp.f : 5; ls.frequency.value = e.ls.f; ls.gain.value = e.ls.g;
        ['b1', 'b2', 'b3'].forEach(function (k) { var n = this[k]; n.frequency.value = e[k].f; n.gain.value = e[k].g; n.Q.value = e[k].q; }, { b1: b1, b2: b2, b3: b3 });
        hs.frequency.value = e.hs.f; hs.gain.value = e.hs.g; lp.frequency.value = e.lp.on ? Math.min(e.lp.f, nyq * 0.98) : nyq * 0.98;
      } };
  }
  function buildWidth(ctx) {
    var sp = ctx.createChannelSplitter(2), mg = ctx.createChannelMerger(2);
    var m = ctx.createGain(); m.gain.value = 0.5; m.channelCount = 1; m.channelCountMode = 'explicit';
    var sPos = ctx.createGain(); sPos.gain.value = 0.5; var sNeg = ctx.createGain(); sNeg.gain.value = -0.5;
    var s = ctx.createGain(); s.channelCount = 1; s.channelCountMode = 'explicit';
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.Q.value = 0.707;
    var w = ctx.createGain(), inv = ctx.createGain(); inv.gain.value = -1;
    var input = ctx.createGain(); input.connect(sp);
    sp.connect(m, 0); sp.connect(m, 1);
    sp.connect(sPos, 0); sp.connect(sNeg, 1); sPos.connect(s); sNeg.connect(s); s.connect(hp); hp.connect(w);
    m.connect(mg, 0, 0); m.connect(mg, 0, 1); w.connect(mg, 0, 0); w.connect(inv); inv.connect(mg, 0, 1);
    return { input: input, output: mg, set: function (width, monoBass) { w.gain.value = width; hp.frequency.value = monoBass > 0 ? monoBass : 5; } };
  }
  function buildDrive(ctx) {
    var input = ctx.createGain(), dry = ctx.createGain(), sh = ctx.createWaveShaper(), wet = ctx.createGain(), out = ctx.createGain();
    sh.oversample = '4x'; input.connect(dry); dry.connect(out); input.connect(sh); sh.connect(wet); wet.connect(out);
    var last = -1;
    return { input: input, output: out, set: function (d) {
      if (d.amt !== last) { sh.curve = makeShaperCurve(d.amt); last = d.amt; }
      var on = d.amt > 0.001; wet.gain.value = on ? d.mix * (1 - 0.3 * d.amt) : 0; dry.gain.value = on ? 1 - d.mix : 1;
    } };
  }
  function buildComp(ctx) {
    var c = ctx.createDynamicsCompressor(), mk = ctx.createGain(); c.connect(mk);
    return { input: c, output: mk, node: c, set: function (s) {
      if (s.on) { c.threshold.value = s.th; c.ratio.value = s.ratio; c.knee.value = s.knee; c.attack.value = s.att / 1000; c.release.value = s.rel / 1000; mk.gain.value = db2g(s.makeup); }
      else { c.threshold.value = 0; c.ratio.value = 1; c.knee.value = 0; mk.gain.value = 1; }
    } };
  }
  // stem strip: in -> eq -> comp -> drive -> width -> pan -> fader -> mute -> out
  function buildStrip(ctx, withMeter) {
    var input = ctx.createGain(), eq = buildEQ(ctx), comp = buildComp(ctx), drive = buildDrive(ctx), width = buildWidth(ctx);
    var pan = ctx.createStereoPanner(), fader = ctx.createGain(), mute = ctx.createGain();
    input.connect(eq.input); eq.output.connect(comp.input); comp.output.connect(drive.input); drive.output.connect(width.input);
    width.output.connect(pan); pan.connect(fader); fader.connect(mute);
    var meter = withMeter ? buildMeter(ctx, mute) : null;
    return { input: input, output: mute, eq: eq, comp: comp, meter: meter,
      set: function (s, audible) {
        eq.set(s.eq); comp.set(s.comp); drive.set(s.drive); width.set(s.width, s.monoBass);
        pan.pan.value = s.pan; fader.gain.value = db2g(s.gain); mute.gain.value = audible ? 1 : 0;
      } };
  }
  function buildMaster(ctx, withMeter) {
    var input = ctx.createGain(), eq = buildEQ(ctx), glue = buildComp(ctx), width = buildWidth(ctx), drive = buildDrive(ctx);
    var limIn = ctx.createGain(), lim = ctx.createDynamicsCompressor(), out = ctx.createGain();
    input.connect(eq.input); eq.output.connect(glue.input); glue.output.connect(width.input); width.output.connect(drive.input);
    drive.output.connect(limIn); limIn.connect(lim); lim.connect(out);
    return { input: input, output: out, eq: eq, glue: glue, lim: lim,
      set: function (m) {
        eq.set(m.eq); glue.set(m.glue); width.set(m.width, m.monoBass); drive.set(m.drive);
        var L = m.limiter;
        limIn.gain.value = db2g((L.on ? L.drive : 0) + m.gain);
        if (L.on) { lim.threshold.value = L.ceiling - 0.3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.001; lim.release.value = L.release / 1000; }
        else { lim.threshold.value = 0; lim.ratio.value = 1; lim.knee.value = 0; }
        out.gain.value = m.preview ? db2g(m.previewGain) : 1;
      } };
  }
  function buildMeter(ctx, src) {
    var sp = ctx.createChannelSplitter(2), a = ctx.createAnalyser(), b = ctx.createAnalyser();
    a.fftSize = b.fftSize = 2048; src.connect(sp); sp.connect(a, 0); sp.connect(b, 1);
    var buf = new Float32Array(2048);
    return { read: function () {
      var r = [];
      [a, b].forEach(function (an) { an.getFloatTimeDomainData(buf); var pk = 0, s = 0; for (var i = 0; i < buf.length; i++) { var v = Math.abs(buf[i]); if (v > pk) pk = v; s += v * v; } r.push(pk, Math.sqrt(s / buf.length)); });
      return { pkL: r[0], rmsL: r[1], pkR: r[2], rmsR: r[3] };
    } };
  }
  // K-weighted loudness tap (approximation of BS.1770 with Web Audio biquads, for live display)
  function buildLoudTap(ctx, src) {
    var sh = ctx.createBiquadFilter(); sh.type = 'highshelf'; sh.frequency.value = 1500; sh.gain.value = 4;
    var hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
    var an = ctx.createAnalyser(); an.fftSize = 4096; src.connect(sh); sh.connect(hp); hp.connect(an);
    var buf = new Float32Array(4096), sp = ctx.createChannelSplitter(2), aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 4096; hp.connect(sp); sp.connect(aL, 0); sp.connect(aR, 1);
    return { power: function () { var p = 0; [aL, aR].forEach(function (x) { x.getFloatTimeDomainData(buf); var s = 0; for (var i = 0; i < buf.length; i++) s += buf[i] * buf[i]; p += s / buf.length; }); return p; } };
  }

  // ---------- the live session ----------
  function Session(sr) {
    var AC = window.AudioContext || window.webkitAudioContext;
    var ctx; try { ctx = new AC({ sampleRate: sr, latencyHint: 'playback' }); } catch (e) { ctx = new AC(); }
    this.ctx = ctx; this.sr = ctx.sampleRate;
    this.master = buildMaster(ctx, true);
    this.ab = ctx.createGain(); this.origGain = ctx.createGain(); this.origOut = ctx.createGain(); this.origMatch = ctx.createGain();
    this.master.output.connect(this.ab); this.ab.connect(ctx.destination);
    this.origGain.connect(this.origMatch); this.origMatch.connect(this.origOut); this.origOut.connect(ctx.destination);
    this.origOut.gain.value = 0;
    this.meter = buildMeter(ctx, this.master.output);
    this.loudM = buildLoudTap(ctx, this.master.output); this.loudO = buildLoudTap(ctx, this.origGain);
    this.specM = ctx.createAnalyser(); this.specM.fftSize = 8192; this.specM.smoothingTimeConstant = 0.85; this.master.output.connect(this.specM);
    this.specO = ctx.createAnalyser(); this.specO.fftSize = 8192; this.specO.smoothingTimeConstant = 0.85; this.origMatch.connect(this.specO);
    this.strips = {}; this.sources = []; this.playing = false; this.pos = 0; this.startAt = 0; this.loop = null;
    this.abOrig = false; this.matchLevels = true; this.pM = 0; this.pO = 0;
  }
  Session.prototype.setStems = function (names) {
    var self = this;
    Object.keys(this.strips).forEach(function (k) { self.strips[k].output.disconnect(); });
    this.strips = {};
    names.forEach(function (n) { var s = buildStrip(self.ctx, true); s.output.connect(self.master.input); self.strips[n] = s; });
  };
  Session.prototype.apply = function (state) {
    var anySolo = state.names.some(function (n) { return state.strips[n].solo; });
    for (var i = 0; i < state.names.length; i++) {
      var n = state.names[i], s = state.strips[n], audible = !s.mute && (!anySolo || s.solo);
      if (this.strips[n]) this.strips[n].set(s, audible);
    }
    this.master.set(state.master);
    this.setAB(this.abOrig);
  };
  Session.prototype.setAB = function (orig) {
    this.abOrig = orig; var t = this.ctx.currentTime;
    this.ab.gain.setTargetAtTime(orig ? 0 : 1, t, 0.01); this.origOut.gain.setTargetAtTime(orig ? 1 : 0, t, 0.01);
  };
  Session.prototype.time = function () {
    if (!this.playing) return this.pos;
    var t = this.ctx.currentTime - this.startAt;
    if (this.loop) { var a = this.loop[0], b = this.loop[1], L = b - a; if (t > b && L > 0.01) t = a + ((t - a) % L); }
    return t;
  };
  Session.prototype.play = function (buffers, original, from) {
    this.stopSources();
    var ctx = this.ctx, self = this; if (ctx.state === 'suspended') ctx.resume();
    var when = ctx.currentTime + 0.05, dur = original.duration;
    from = Math.max(0, Math.min(from, dur - 0.01));
    var mk = function (buf, dest) {
      var s = ctx.createBufferSource(); s.buffer = buf; s.connect(dest);
      if (self.loop) { s.loop = true; s.loopStart = self.loop[0]; s.loopEnd = self.loop[1]; }
      s.start(when, from); self.sources.push(s); return s;
    };
    Object.keys(buffers).forEach(function (n) { if (self.strips[n]) mk(buffers[n], self.strips[n].input); });
    var o = mk(original, this.origGain);
    o.onended = function () { if (self.sources.indexOf(o) >= 0) { self.playing = false; self.pos = 0; if (self.onEnded) self.onEnded(); } };
    this.startAt = when - from; this.playing = true;
  };
  Session.prototype.stopSources = function () {
    this.sources.forEach(function (s) { try { s.onended = null; s.stop(); s.disconnect(); } catch (e) {} });
    this.sources = [];
  };
  Session.prototype.pause = function () { if (this.playing) { this.pos = this.time(); this.stopSources(); this.playing = false; } };
  Session.prototype.stop = function () { this.stopSources(); this.playing = false; this.pos = 0; };
  // loudness matching of the original against the remaster (slow running averages)
  Session.prototype.updateMatch = function () {
    if (!this.playing) return;
    var a = 0.03, pm = this.loudM.power(), po = this.loudO.power();
    // remaster power measured pre-A/B; original power measured before the match gain
    this.pM = this.pM ? this.pM * (1 - a) + pm * a : pm; this.pO = this.pO ? this.pO * (1 - a) + po * a : po;
    var g = this.matchLevels && this.pO > 1e-9 ? Math.sqrt(this.pM / this.pO) : 1;
    g = Math.max(0.05, Math.min(8, g));
    this.origMatch.gain.setTargetAtTime(g, this.ctx.currentTime, 0.2);
    this.matchDb = 20 * Math.log10(g);
  };

  // ---------- offline render ----------
  // opts: {state, buffers, x0, x1, solo: stemName|null, master: bool}
  function render(opts) {
    var st = opts.state, sr = opts.sr, x0 = opts.x0 || 0, x1 = opts.x1, len = x1 - x0;
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var ctx = new OC(2, len, sr), out = ctx.destination, master = null;
    if (opts.master) { master = buildMaster(ctx, false); master.set(Object.assign({}, st.master, { preview: false })); master.output.connect(out); }
    var anySolo = st.names.some(function (n) { return st.strips[n].solo; });
    st.names.forEach(function (n) {
      var s = st.strips[n], audible;
      if (opts.solo) audible = n === opts.solo; else audible = !s.mute && (!anySolo || s.solo);
      if (!audible) return;
      var strip = buildStrip(ctx, false); strip.set(s, true);
      strip.output.connect(master ? master.input : out);
      var src = ctx.createBufferSource(); src.buffer = opts.buffers[n]; src.connect(strip.input); src.start(0, x0 / sr);
    });
    return ctx.startRendering().then(function (b) { return [b.getChannelData(0), b.getChannelData(1)]; });
  }

  return { Session: Session, render: render, defaultStrip: defaultStrip, defaultMaster: defaultMaster, defaultEQ: defaultEQ, buildEQ: buildEQ, db2g: db2g };
})();
