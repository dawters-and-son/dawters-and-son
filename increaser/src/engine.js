// SPDX-License-Identifier: GPL-3.0-or-later
// The Increaser — looper engine. Runs inside the AudioWorklet, and the same class
// renders exports offline on the main thread.
//
// Time model
//   G      global musical position in "base frames" (frames at the tempo the loop was
//          first recorded at). Advances by r per audio frame while playing.
//   r      tempo ratio: current tempo / base tempo.
//   L      loop length in base frames (0 until the first loop exists).
//   Every take is stored at the rate it was recorded (layer.rate); playback reads it at
//   r / layer.rate, either as tape (pitch follows) or through a granular stretcher
//   (pitch kept).

class Engine {
  constructor(sr) {
    this.sr = sr;
    this.NT = 6;
    this.playing = false;
    this.G = 0;
    this.r = 1;
    this.pendingR = 0;
    this.ramp = null;
    this.L = 0;
    this.bpb = 4;
    this.loopBars = 4;
    this.baseTempo = 120;
    this.latency = 0;            // round-trip frames to compensate on takes
    this.stretch = 1;            // 1 = keep pitch, 0 = tape
    this.layers = new Map();
    this.nextId = 1;
    this.tracks = [];
    for (let i = 0; i < this.NT; i++) {
      this.tracks.push({ lenBars: 0, active: [], vol: 0.8, pan: 0, mute: false, solo: false,
        filt: 0, fade: 0, rev: false, gv: 0, ga: 0, fz: [0, 0, 0, 0], fc: null, peak: 0 });
    }
    this.recs = [];
    this.events = [];
    this.inGain = 1; this.monitor = false; this.inPeak = 0; this.inCh = 0; // 0 stereo/auto, 1 left, 2 right
    this.clickOn = false; this.leadClick = true; this.clickVol = 0.5;
    this.ck = { env: 0, ph: 0, f: 1500, last: null };
    this.master = 0.9; this.lim = 1; this.mPeak = 0;
    this.capture = null;
    this.test = 0; this.testPos = 0; this.ts = { step: -1 }; this.rnd = 22222;
    this.trigOn = false; this.trigLevel = 0.06;
    this.pre = new Float32Array(2048); this.preR = new Float32Array(2048); this.preI = 0;
    this.calib = null;
    this.out = [];
    // granular stretcher
    this.GN = Math.max(512, Math.round(sr * 0.046) & ~1); this.GH = this.GN >> 1;
    this.win = new Float32Array(this.GN);
    for (let i = 0; i < this.GN; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.GN);
    this.WS = Math.round(sr * 0.006); this.WM = Math.round(sr * 0.008);
    this.FE = Math.round(sr * 0.002); // 2 ms edge fades
    this.sm = 1 - Math.exp(-1 / (sr * 0.01)); // ~10 ms smoothing
  }

  // ---------- grid ----------
  loopLen() { return this.L > 0 ? this.L : this.loopBars * this.bpb * 60 * this.sr / this.baseTempo; }
  barLen() { return this.loopLen() / this.loopBars; }
  beatLen() { return this.barLen() / this.bpb; }
  trackLen(t) { const tr = this.tracks[t]; if (tr.lenBars) return tr.lenBars * this.barLen(); return this.L; }
  quantum(q) { return q === 'loop' ? this.loopLen() : q === 'bar' ? this.barLen() : q === 'beat' ? this.beatLen() : 0; }
  nextBoundary(from, q) { const Q = this.quantum(q); if (!Q) return from; return Math.ceil((from - 1e-6) / Q) * Q; }
  recording() { for (const r of this.recs) if (r.on) return true; return false; }

  // ---------- commands ----------
  cmd(m) {
    switch (m.c) {
      case 'play': {
        this.playing = true; this.G = m.G != null ? m.G : 0; this.ts.step = -1;
        this.ck.last = Math.floor(this.G / this.beatLen()) - (Math.abs(this.G / this.beatLen() - Math.round(this.G / this.beatLen())) < 1e-9 ? 1 : 0);
        this.testPos = this.G; for (const t of this.tracks) t.ga = 0;
        break;
      }
      case 'stop': {
        for (const r of this.recs.slice()) { if (r.on) this.finishRec(r, true); else this.dropRec(r, 'stopped'); }
        this.playing = false; this.G = 0; this.events = [];
        if (this.pendingR) { this.r = this.pendingR; this.pendingR = 0; }
        this.out.push({ t: 'stopped' });
        break;
      }
      case 'arm': this.arm(m); break;
      case 'punchOut': {
        const r = this.recs.find(x => x.track === m.track && x.on) || this.recs.find(x => x.track === m.track);
        if (!r) break;
        if (!r.on) { this.dropRec(r, 'cancelled'); break; }
        if (r.free && this.L === 0) { this.finishRec(r, false); break; }
        const end = m.quant && m.quant !== 'now' ? this.nextBoundary(this.G + 1, m.quant) : this.G;
        r.endG = Math.max(end, r.segStart + r.r0); r.maxPasses = 0;
        this.out.push({ t: 'punchOutAt', track: r.track, endG: r.endG });
        break;
      }
      case 'cancel': {
        for (const r of this.recs.filter(x => x.track === m.track)) this.dropRec(r, 'cancelled');
        break;
      }
      case 'setTrack': {
        const tr = this.tracks[m.track];
        for (const k of ['active', 'vol', 'pan', 'mute', 'solo', 'filt', 'fade', 'rev', 'lenBars']) if (m[k] !== undefined) tr[k] = m[k];
        if (m.active) tr.active = m.active.filter(id => this.layers.has(id));
        break;
      }
      case 'addLayer': {
        this.layers.set(m.id, this.mkLayer(m.id, m.track, m.Lb, m.Rb, m.n, m.s, m.rate, m.replace, m.gate));
        if (m.id >= this.nextId) this.nextId = m.id + 1;
        break;
      }
      case 'freeLayers': for (const id of m.ids) this.layers.delete(id); break;
      case 'set': for (const k in m) if (k !== 'c') this[k] = m[k]; break;
      case 'tempo': this.setTempo(m.bpm); break;
      case 'ramp': {
        if (this.L <= 0) { this.baseTempo = m.bpm; break; }
        const r1 = m.bpm / this.baseTempo;
        this.ramp = { r0: this.r, r1, dur: Math.max(1, m.bars) * this.barLen(), prog: 0, startG: m.startG != null ? m.startG : this.nextBoundary(this.G + 1, 'bar') };
        this.out.push({ t: 'ramp', startG: this.ramp.startG, bpm: m.bpm, bars: m.bars });
        break;
      }
      case 'stopRamp': this.ramp = null; break;
      case 'at': {
        let G = m.G; if (G < this.G) G = this.G;
        this.events.push({ G, cmd: m.cmd, tag: m.tag }); this.events.sort((a, b) => a.G - b.G);
        break;
      }
      case 'clearEvents': this.events = []; break;
      case 'defineLoop': {
        this.L = m.L; this.baseTempo = m.baseTempo; if (m.loopBars) this.loopBars = m.loopBars; if (m.bpb) this.bpb = m.bpb;
        this.r = m.r || 1; break;
      }
      case 'reset': {
        this.recs = []; this.events = []; this.layers.clear(); this.L = 0; this.r = 1; this.pendingR = 0; this.ramp = null;
        for (const tr of this.tracks) tr.active = [];
        if (m.baseTempo) this.baseTempo = m.baseTempo;
        break;
      }
      case 'capture': {
        if (m.on) this.capture = { L: new Float32Array(8192), R: new Float32Array(8192), i: 0, total: 0 };
        else if (this.capture) { this.flushCapture(true); this.capture = null; }
        break;
      }
      case 'calibrate': this.calib = { t: 0, n: 0, clicks: 6, gap: Math.round(this.sr * 0.5), res: [], wait: -1, armT: 0, noise: 0 }; break;
    }
  }

  setTempo(bpm) {
    bpm = Math.max(20, Math.min(400, bpm));
    if (this.L <= 0) { this.baseTempo = bpm; this.r = 1; return; }
    this.ramp = null;
    const nr = bpm / this.baseTempo;
    if (this.recording()) { this.pendingR = nr; this.out.push({ t: 'tempoHeld', bpm }); }
    else this.r = nr;
  }

  arm(m) {
    // one job per track, unless this one is queued to follow it
    if (!m.queue) for (const r of this.recs.filter(x => x.track === m.track)) this.dropRec(r, 'replaced');
    const lead = m.lead || 0;
    let startG;
    if (m.trigger) startG = Infinity;
    else if (m.startG != null) {
      startG = m.startG;
      if (startG < this.G + 64) startG = this.nextBoundary(this.G + lead, m.quant || 'bar');
    } else if (!this.playing) startG = 0;
    else startG = (m.quant && m.quant !== 'now') ? this.nextBoundary(this.G + lead + 256, m.quant) : this.G + lead;
    const rec = { track: m.track, tag: m.tag, startG, endG: m.len && !m.trigger ? startG + m.len : null, lenReq: m.len || 0, maxPasses: m.passes || 0,
      passes: 0, replace: !!m.replace, free: !!m.free, trigger: !!m.trigger, lead, on: false, r0: this.r,
      silStop: m.silStop || 0, silQ: m.silQ || 'bar', gate: m.gate || 0, quiet: 0, heard: false,
      chunks: null, count: 0, segStart: 0, cur: null, ci: 0 };
    const tl = this.L > 0 ? this.trackLen(m.track) : 0;
    if (rec.endG == null && rec.maxPasses && tl > 0 && isFinite(startG)) rec.endG = startG + rec.maxPasses * tl;
    this.recs.push(rec);
    this.out.push({ t: 'armed', track: m.track, tag: m.tag, startG: isFinite(startG) ? startG : null, endG: rec.endG, lead });
  }

  dropRec(r, why) {
    const i = this.recs.indexOf(r); if (i >= 0) this.recs.splice(i, 1);
    this.out.push({ t: 'recEnd', track: r.track, tag: r.tag, why, layers: 0 });
    if (!this.recording() && this.pendingR) { this.r = this.pendingR; this.pendingR = 0; }
  }

  startRec(r) {
    r.on = true; r.r0 = this.r; r.segStart = r.startG; r.count = 0;
    r.chunks = []; r.cur = [new Float32Array(16384), new Float32Array(16384)]; r.ci = 0;
    this.out.push({ t: 'recStart', track: r.track, tag: r.tag, startG: r.segStart, r0: r.r0 });
  }

  pushRec(r, l, rr) {
    if (r.ci === r.cur[0].length) { r.chunks.push(r.cur); r.cur = [new Float32Array(16384), new Float32Array(16384)]; r.ci = 0; }
    r.cur[0][r.ci] = l; r.cur[1][r.ci] = rr; r.ci++; r.count++;
  }

  collect(r) {
    const n = r.count, Lb = new Float32Array(n), Rb = new Float32Array(n);
    let o = 0;
    for (const c of r.chunks) { Lb.set(c[0], o); Rb.set(c[1], o); o += c[0].length; }
    Lb.set(r.cur[0].subarray(0, r.ci), o); Rb.set(r.cur[1].subarray(0, r.ci), o);
    return [Lb, Rb];
  }

  // close the current segment as a layer; keep recording if more passes follow
  closeSeg(r) {
    if (r.count < 32) return null;
    const [Lb, Rb] = this.collect(r);
    if (r.free && this.L === 0) {
      // the first loop: its length defines the loop and the tempo
      this.L = r.count * r.r0;
      this.baseTempo = this.loopBars * this.bpb * 60 * this.sr / this.L;
      this.r = 1; r.r0 = 1;
      this.tracks[r.track].lenBars = 0;
      this.out.push({ t: 'loopDefined', L: this.L, baseTempo: this.baseTempo, loopBars: this.loopBars, bpb: this.bpb });
    }
    const len = this.trackLen(r.track);
    let s = r.segStart - this.latency * r.r0;
    s = ((s % len) + len) % len;
    const id = this.nextId++;
    const lay = this.mkLayer(id, r.track, Lb, Rb, r.count, s, r.r0, r.replace, r.gate);
    this.layers.set(id, lay);
    this.tracks[r.track].active.push(id);
    // copies go to the main thread (it keeps its own for export and saving)
    this.out.push({ t: 'layer', id, track: r.track, n: r.count, s, rate: r.r0, replace: r.replace, gate: r.gate, Lb: Lb.slice(), Rb: Rb.slice(), tag: r.tag, _transfer: true });
    r.passes++;
    return lay;
  }

  finishRec(r, cut) {
    const lay = this.closeSeg(r);
    const i = this.recs.indexOf(r); if (i >= 0) this.recs.splice(i, 1);
    this.out.push({ t: 'recEnd', track: r.track, tag: r.tag, why: cut ? 'cut' : 'done', layers: r.passes });
    if (!this.recording() && this.pendingR) { this.r = this.pendingR; this.pendingR = 0; this.out.push({ t: 'tempoApplied', r: this.r }); }
    return lay;
  }

  mkLayer(id, track, Lb, Rb, n, s, rate, replace, gate) {
    let e = 0, c = 0;
    for (let i = 0; i < n; i += 16) { e += Lb[i] * Lb[i] + Rb[i] * Rb[i]; c++; }
    const lay = { id, track, Lb, Rb, n, s, rate, replace: !!replace, g: 0, st1: 0, st2: 0, rms: Math.sqrt(e / Math.max(1, c)), gate: gate || 0, gv: null };
    if (gate) lay.gv = Engine.gateCurve(Lb, Rb, n, gate, this.sr);
    return lay;
  }

  // Sound gate for a take: 1 where the player was playing (above the threshold), 0 elsewhere.
  // Per 64-frame block, held 120 ms after the sound so tails ring out, opened 5 ms early, with 8 ms ramps.
  static gateCurve(Lb, Rb, n, thr, sr) {
    const B = 64, nb = Math.ceil(n / B) + 1, on = new Uint8Array(nb), g = new Float32Array(nb);
    for (let b = 0; b < nb - 1; b++) {
      let pk = 0; const e = Math.min(n, (b + 1) * B);
      for (let i = b * B; i < e; i++) { const v = Math.max(Math.abs(Lb[i]), Math.abs(Rb[i])); if (v > pk) pk = v; }
      on[b] = pk > thr ? 1 : 0;
    }
    const hold = Math.ceil(sr * 0.12 / B), pre = Math.ceil(sr * 0.005 / B), ramp = Math.max(1, Math.ceil(sr * 0.008 / B));
    let h = 0;
    for (let b = 0; b < nb; b++) { if (on[b]) h = hold; if (h > 0) { g[b] = 1; h--; } }
    for (let b = nb - 1, k = 0; b >= 0; b--) { if (on[b]) k = pre; else if (k > 0) { g[b] = 1; k--; } }
    // ramps both ways
    const out = new Float32Array(nb);
    let v = 0; for (let b = 0; b < nb; b++) { v = g[b] ? Math.min(1, v + 1 / ramp) : Math.max(0, v - 1 / ramp); out[b] = v; }
    v = 0; for (let b = nb - 1; b >= 0; b--) { v = g[b] ? Math.min(1, v + 1 / ramp) : 0; if (g[b]) out[b] = Math.min(out[b], v); }
    return out;
  }
  gateAt(lay, idx) { const x = idx / 64, i = x | 0, f = x - i, a = lay.gv; const p = a[i] || 0, q = a[i + 1] || 0; return p + (q - p) * f; }

  // ---------- reading ----------
  rd(buf, n, full, x) {
    if (full) { x = x % n; if (x < 0) x += n; }
    else if (x < 0 || x >= n - 1) return 0;
    const i = x | 0, f = x - i;
    const a = buf[i], b = buf[i + 1 < n ? i + 1 : (full ? 0 : i)];
    return a + (b - a) * f;
  }

  // WSOLA: start the new grain where it best continues the grain that is fading out
  align(lay, full, other, age, target, dir) {
    const buf = lay.Lb, n = lay.n, S = this.WS, M = this.WM;
    const base = other + dir * age;
    let best = 0, bestC = -Infinity;
    const score = d => {
      let c = 0, en = 1e-9;
      for (let a = 0; a < M; a += 6) {
        const y = this.rd(buf, n, full, target + d + dir * a);
        c += this.rd(buf, n, full, base + dir * a) * y; en += y * y;
      }
      return c / Math.sqrt(en);
    };
    for (let d = -S; d <= S; d += 3) { const c = score(d); if (c > bestC) { bestC = c; best = d; } }
    const b0 = best;
    for (let d = b0 - 2; d <= b0 + 2; d++) { if (d === b0) continue; const c = score(d); if (c > bestC) { bestC = c; best = d; } }
    return target + best;
  }

  // ---------- test band (synced to the grid) ----------
  rand() { this.rnd = (this.rnd * 1103515245 + 12345) & 0x7fffffff; return this.rnd / 0x3fffffff - 1; }
  testSample() {
    const ts = this.ts, sr = this.sr, beat = this.beatLen();
    const stepF = this.testPos / (beat / 4);
    const step = Math.floor(stepF);
    const bar = Math.floor(step / 16), st = ((step % 16) + 16) % 16;
    const prog = [57, 53, 48, 55]; // A F C G
    const root = prog[((bar % 4) + 4) % 4];
    const kind = this.test;
    if (step !== ts.step) {
      ts.step = step;
      if (kind === 1 || kind === 9) {
        if (st === 0 || st === 8 || st === 10) { ts.kE = 1; ts.kP = 0; }
        if (st === 4 || st === 12) ts.sE = 1;
        if (st % 2 === 0) ts.hE = st % 4 === 2 ? 0.7 : 0.4;
      }
      if (kind === 2 || kind === 9) {
        const pat = [1, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1, 0, 1, 1, 0];
        if (pat[st]) { ts.bE = 1; ts.bF = 440 * Math.pow(2, (root - 24 + (st === 14 ? 12 : 0) - 69) / 12); }
      }
      if (kind === 3 || kind === 9) {
        if (st === 2 || st === 6 || st === 10 || st === 14) {
          ts.cE = 1; const minor = (root === 57);
          ts.cF = [0, minor ? 3 : 4, 7].map(x => 440 * Math.pow(2, (root + x - 69) / 12));
        }
      }
      if (kind === 4 || kind === 9) {
        const mel = [76, 0, 74, 72, 0, 72, 69, 0, 72, 0, 74, 0, 76, 79, 0, 76];
        const off = [0, -3, -5, -2][((bar % 4) + 4) % 4];
        if (mel[st]) { ts.lE = 1; ts.lF = 440 * Math.pow(2, (mel[st] + off - 69 - 12) / 12); }
      }
    }
    let y = 0;
    if (ts.kE > 0.0005) { ts.kP = (ts.kP || 0) + (50 + 110 * ts.kE * ts.kE) / sr; y += Math.sin(2 * Math.PI * ts.kP) * ts.kE * 0.9; ts.kE *= 1 - 9 / sr; }
    if (ts.sE > 0.0005) { y += (this.rand() * 0.6 + Math.sin(2 * Math.PI * (ts.sP = (ts.sP || 0) + 190 / sr))) * ts.sE * 0.35; ts.sE *= 1 - 16 / sr; }
    if (ts.hE > 0.0005) { const w = this.rand(); const h = w - (ts.hz || 0); ts.hz = w; y += h * ts.hE * 0.18; ts.hE *= 1 - 45 / sr; }
    if (ts.bE > 0.0005) {
      ts.bP = ((ts.bP || 0) + ts.bF / sr) % 1; const saw = 2 * ts.bP - 1;
      ts.bz = (ts.bz || 0) + (saw - (ts.bz || 0)) * 0.08; y += ts.bz * ts.bE * 0.55; ts.bE *= 1 - 5 / sr;
    }
    if (ts.cE > 0.0005) {
      ts.cP = ts.cP || [0, 0, 0]; let c = 0;
      for (let k = 0; k < 3; k++) { ts.cP[k] = (ts.cP[k] + ts.cF[k] / sr) % 1; c += 1 - 4 * Math.abs(ts.cP[k] - 0.5); }
      y += c * ts.cE * 0.12; ts.cE *= 1 - 7 / sr;
    }
    if (ts.lE > 0.0005) {
      ts.lV = (ts.lV || 0) + 5.5 / sr;
      ts.lP = ((ts.lP || 0) + ts.lF * (1 + 0.006 * Math.sin(2 * Math.PI * ts.lV)) / sr) % 1;
      y += (ts.lP < 0.5 ? 0.22 : -0.22) * ts.lE; ts.lE *= 1 - 2.5 / sr;
    }
    if (kind === 5) { ts.tP = ((ts.tP || 0) + 440 / sr) % 1; y += Math.sin(2 * Math.PI * ts.tP) * 0.5; }
    return y;
  }

  // ---------- filter (TPT state-variable) ----------
  fCoef(tr) {
    const f = tr.filt;
    if (Math.abs(f) < 0.02) { tr.fc = null; return; }
    const fc = f < 0 ? 20000 * Math.pow(200 / 20000, -f) : 20 * Math.pow(4000 / 20, f);
    const g = Math.tan(Math.PI * Math.min(fc, this.sr * 0.45) / this.sr), k = 1.2;
    tr.fc = { g, k, a1: 1 / (1 + g * (g + k)), hp: f > 0 };
  }
  fRun(tr, x, ch) {
    const c = tr.fc, z = tr.fz, i1 = ch * 2;
    const v3 = x - z[i1 + 1];
    const v1 = c.a1 * z[i1] + c.a1 * c.g * v3;  // simplified TPT form
    const v2 = z[i1 + 1] + c.g * v1;
    z[i1] = 2 * v1 - z[i1]; z[i1 + 1] = 2 * v2 - z[i1 + 1];
    return c.hp ? x - c.k * v1 - v2 : v2;
  }

  // ---------- main loop ----------
  process(inL, inR, outL, outR, n) {
    const NT = this.NT, sm = this.sm, FE = this.FE, GN = this.GN, GH = this.GH, win = this.win;
    let anySolo = false;
    for (const tr of this.tracks) { if (tr.solo) anySolo = true; this.fCoef(tr); }
    const beat = this.beatLen();
    for (let i = 0; i < n; i++) {
      // ----- input -----
      let xl = 0, xr = 0;
      if (inL) {
        const a = inL[i], b = inR ? inR[i] : a;
        if (this.inCh === 1) xl = xr = a; else if (this.inCh === 2) xl = xr = b; else { xl = a; xr = b; }
        xl *= this.inGain; xr *= this.inGain;
      }
      let tsig = 0;
      if (this.test && (this.playing || this.recs.length)) { tsig = this.testSample(); xl += tsig; xr += tsig; this.testPos += this.r; }
      const ia = Math.max(Math.abs(xl), Math.abs(xr)); if (ia > this.inPeak) this.inPeak = ia;
      this.pre[this.preI] = xl; this.preR[this.preI] = xr; this.preI = (this.preI + 1) & 2047;

      // ----- calibration (speaker → mic round trip) -----
      let calOut = 0;
      if (this.calib) calOut = this.calStep(ia);

      // ----- scheduled events -----
      if (this.playing) {
        while (this.events.length && this.events[0].G <= this.G) this.runEvent(this.events.shift());
      }
      // ----- recording -----
      for (let k = 0; k < this.recs.length; k++) {
        const r = this.recs[k];
        if (!r.on) {
          if (r.trigger) {
            if (ia > this.trigLevel) {
              if (!this.playing) { this.playing = true; this.G = 0; this.testPos = 0; }
              r.trigger = false; r.startG = this.G;
              this.startRec(r);
              // 10 ms of pre-roll so the attack isn't lost
              const P = Math.round(this.sr * 0.01);
              for (let j = P; j > 0; j--) { const q = (this.preI - j) & 2047; this.pushRec(r, this.pre[q], this.preR[q]); }
              r.segStart = this.G - P * r.r0;
              if (r.lenReq) r.endG = r.startG + r.lenReq;
            } else continue;
          } else if (this.playing && this.G >= r.startG) this.startRec(r);
          else continue;
        }
        this.pushRec(r, xl, xr);
        if (r.silStop && r.endG == null) {
          // punch out on the next beat or bar once the player has been quiet for silStop frames
          if (ia > this.trigLevel) { r.quiet = 0; r.heard = true; } else r.quiet++;
          if (r.heard && r.quiet >= r.silStop) {
            r.endG = this.L > 0 ? this.nextBoundary(this.G + 1, r.silQ) : this.G;
            r.maxPasses = 0;
            this.out.push({ t: 'punchOutAt', track: r.track, endG: r.endG, why: 'silence' });
          }
        }
        const covered = r.count * r.r0;
        const len = this.L > 0 ? this.trackLen(r.track) : 0;
        if (r.endG != null && r.segStart + covered >= r.endG - 1e-6) {
          if (r.free && this.L === 0 && r.silStop) { this.finishRec(r, false); k--; continue; }
          this.finishRec(r, false); k--; continue;
        }
        if (len > 0 && covered >= len - 1e-6) {
          this.closeSeg(r);
          if (r.maxPasses && r.passes >= r.maxPasses) {
            const j = this.recs.indexOf(r); this.recs.splice(j, 1); k--;
            this.out.push({ t: 'recEnd', track: r.track, tag: r.tag, why: 'done', layers: r.passes });
            if (!this.recording() && this.pendingR) { this.r = this.pendingR; this.pendingR = 0; this.out.push({ t: 'tempoApplied', r: this.r }); }
            continue;
          }
          r.segStart += len; r.count = 0; r.chunks = []; r.ci = 0;
          r.cur = [new Float32Array(16384), new Float32Array(16384)];
          this.out.push({ t: 'recStart', track: r.track, tag: r.tag, startG: r.segStart, r0: r.r0, pass: r.passes });
        }
      }

      // ----- loops -----
      let mL = 0, mR = 0;
      const G = this.G, live = this.playing && G >= 0;
      for (let t = 0; t < NT; t++) {
        const tr = this.tracks[t];
        const audible = !tr.mute && (!anySolo || tr.solo);
        tr.gv += ((audible ? tr.vol : 0) - tr.gv) * sm;
        if (!live || tr.active.length === 0) continue;
        if (tr.gv < 1e-5 && !audible) continue;
        const len = this.trackLen(t); if (len <= 0) continue;
        let p = G % len; if (tr.rev) p = len - p;
        let sL = 0, sR = 0, mult = 1, fm = 1;
        const tga = tr.ga, ta2 = tga + GH >= GN ? tga + GH - GN : tga + GH;
        const gStart = tga === 0 ? 1 : ta2 === 0 ? 2 : 0, dir = tr.rev ? -1 : 1;
        let dRef = 0, refRate = -1;
        if (this.stretch && gStart) {
          // one alignment search per track: on the loudest layer, shared by layers recorded at the same rate
          let best = null, bs = -1, bIdx = 0, bFull = false;
          for (const id of tr.active) {
            const lay = this.layers.get(id); if (!lay || Math.abs(this.r / lay.rate - 1) <= 0.003) continue;
            const span = lay.n * lay.rate;
            let d = p - lay.s; if (d < 0) d += len; if (d >= len) d -= len;
            if (d >= span) continue;
            const sc = lay.rms * (lay.g + 0.01);
            if (sc > bs) { bs = sc; best = lay; bIdx = d / lay.rate; bFull = span >= len - lay.rate * 2; }
          }
          if (best) {
            const al = this.align(best, bFull, gStart === 1 ? best.st2 : best.st1, GH, bIdx, dir);
            dRef = al - bIdx; refRate = best.rate;
          }
        }
        for (let a = tr.active.length - 1; a >= 0; a--) {
          const lay = this.layers.get(tr.active[a]); if (!lay) continue;
          lay.g += (fm - lay.g) * sm;
          fm *= 1 - tr.fade;
          if (mult < 1e-4) continue;
          const span = lay.n * lay.rate;
          let d = p - lay.s; if (d < 0) d += len; if (d >= len) d -= len;
          if (d >= span) continue;
          const idx = d / lay.rate;
          const full = span >= len - lay.rate * 2;
          let ef = 1;
          if (idx < FE) ef = idx / FE; else if (lay.n - idx < FE) ef = (lay.n - idx) / FE;
          const rr = this.r / lay.rate;
          let vl, vr;
          if (this.stretch && Math.abs(rr - 1) > 0.003) {
            const a1 = tga, a2 = ta2;
            if (a1 === 0) lay.st1 = lay.rate === refRate ? idx + dRef : this.align(lay, full, lay.st2, GH, idx, dir);
            if (a2 === 0) lay.st2 = lay.rate === refRate ? idx + dRef : this.align(lay, full, lay.st1, GH, idx, dir);
            const w1 = win[a1], w2 = win[a2];
            const x1 = lay.st1 + dir * a1, x2 = lay.st2 + dir * a2;
            vl = w1 * this.rd(lay.Lb, lay.n, full, x1) + w2 * this.rd(lay.Lb, lay.n, full, x2);
            vr = w1 * this.rd(lay.Rb, lay.n, full, x1) + w2 * this.rd(lay.Rb, lay.n, full, x2);
          } else {
            vl = this.rd(lay.Lb, lay.n, full, idx); vr = this.rd(lay.Rb, lay.n, full, idx);
          }
          const gt = lay.gv ? this.gateAt(lay, idx) : 1;
          const g = lay.g * ef * mult * gt;
          sL += vl * g; sR += vr * g;
          if (lay.replace) mult *= 1 - ef * gt;
        }
        tr.ga = tga + 1 === GN ? 0 : tga + 1;
        sL *= tr.gv; sR *= tr.gv;
        if (tr.fc) { sL = this.fRun(tr, sL, 0); sR = this.fRun(tr, sR, 1); }
        const ang = (tr.pan + 1) * Math.PI / 4;
        sL *= Math.cos(ang) * Math.SQRT2; sR *= Math.sin(ang) * Math.SQRT2;
        const pk = Math.max(Math.abs(sL), Math.abs(sR)); if (pk > tr.peak) tr.peak = pk;
        mL += sL; mR += sR;
      }
      if (this.monitor) { mL += xl; mR += xr; } else if (tsig) { mL += tsig; mR += tsig; } // the test band is always heard
      mL *= this.master; mR *= this.master;
      // peak limiter: instant attack, ~150 ms release, ceiling −0.3 dBFS
      const pk = Math.max(Math.abs(mL), Math.abs(mR));
      const need = pk > 0.966 ? 0.966 / pk : 1;
      if (need < this.lim) this.lim = need; else this.lim += (1 - this.lim) * 0.00015;
      mL *= this.lim; mR *= this.lim;
      if (pk * this.lim > this.mPeak) this.mPeak = pk * this.lim;
      if (this.capture) this.capPush(mL, mR);

      // ----- click (metronome, or lead-in before a punch) -----
      if (this.playing) {
        const bi = Math.floor(G / beat);
        if (this.ck.last !== bi) {
          {
            let leadNow = G < 0;
            if (!leadNow && this.leadClick) for (const r of this.recs) if (!r.on && isFinite(r.startG) && r.startG - G <= r.lead + 1 && r.startG > G - 1) leadNow = true;
            if (this.clickOn || (this.leadClick && leadNow)) {
              const accent = ((bi % this.bpb) + this.bpb) % this.bpb === 0;
              this.ck.env = 1; this.ck.f = accent ? 2000 : 1300; this.ck.ph = 0;
            }
          }
          this.ck.last = bi;
        }
      }
      let c = 0;
      if (this.ck.env > 0.001) { this.ck.ph += this.ck.f / this.sr; c = Math.sin(2 * Math.PI * this.ck.ph) * this.ck.env * this.clickVol * 0.6; this.ck.env *= 1 - 220 / this.sr; }
      outL[i] = mL + c + calOut; outR[i] = mR + c + calOut;

      // ----- advance -----
      if (this.playing) {
        if (this.ramp && !this.recording() && this.G >= this.ramp.startG) {
          const rp = this.ramp; rp.prog += this.r;
          const u = Math.min(1, rp.prog / rp.dur);
          this.r = rp.r0 + (rp.r1 - rp.r0) * u;
          if (u >= 1) { this.ramp = null; this.out.push({ t: 'rampDone', r: this.r }); }
        }
        this.G += this.r;
        if (this.L > 0 && this.G > 1e12) this.G %= this.L; // keep doubles precise in very long sets
      }
    }
  }

  runEvent(ev) {
    const m = ev.cmd;
    if (m.c === 'setTrack') this.cmd(m);
    else if (m.c === 'tempo') this.setTempo(m.bpm);
    else if (m.c === 'ramp') this.cmd(Object.assign({}, m, { startG: this.G }));
    else if (m.c === 'stop') this.cmd(m);
    this.out.push({ t: 'event', tag: ev.tag, cmd: m, G: this.G });
  }

  capPush(l, r) {
    const c = this.capture; c.L[c.i] = l; c.R[c.i] = r; c.i++; c.total++;
    if (c.i === c.L.length) this.flushCapture(false);
  }
  flushCapture(last) {
    const c = this.capture; if (!c) return;
    if (c.i > 0) this.out.push({ t: 'cap', L: c.L.slice(0, c.i), R: c.R.slice(0, c.i), _transfer: true });
    c.i = 0; if (last) this.out.push({ t: 'capEnd', total: c.total });
  }

  calStep(level) {
    const k = this.calib;
    let o = 0;
    if (k.t < this.sr * 0.4) { k.noise = Math.max(k.noise, level); k.t++; return 0; } // listen to the room first
    const t = k.t - Math.round(this.sr * 0.4);
    const ci = Math.floor(t / k.gap), ph = t - ci * k.gap;
    if (ci < k.clicks) {
      if (ph < 48) o = (ph % 2 ? -0.8 : 0.8) * (1 - ph / 48);
      if (ph === 0) k.armT = t;
      const thr = Math.max(0.02, k.noise * 3);
      if (ph > 16 && k.wait !== ci && level > thr) { k.wait = ci; k.res.push(ph); }
    } else {
      const v = k.res.slice().sort((a, b) => a - b);
      const med = v.length ? v[v.length >> 1] : 0;
      this.out.push({ t: 'calib', frames: med, hits: v.length, of: k.clicks });
      this.calib = null; return 0;
    }
    k.t++;
    return o;
  }

  // messages the UI polls
  status() {
    const recs = this.recs.map(r => ({ track: r.track, on: r.on, startG: isFinite(r.startG) ? r.startG : null, endG: r.endG, segStart: r.segStart, count: r.count, r0: r.r0, lead: r.lead, trigger: r.trigger, passes: r.passes, free: r.free }));
    const peaks = this.tracks.map(t => { const p = t.peak; t.peak = 0; return p; });
    const s = { t: 'tick', G: this.G, playing: this.playing, r: this.r, L: this.L, baseTempo: this.baseTempo, recs,
      peaks, inPeak: this.inPeak, mPeak: this.mPeak, ramp: this.ramp ? { r1: this.ramp.r1, u: this.ramp.prog / this.ramp.dur, startG: this.ramp.startG } : null,
      pendingR: this.pendingR, events: this.events.length };
    this.inPeak = 0; this.mPeak = 0;
    return s;
  }
}

if (typeof module !== 'undefined') module.exports = Engine;
