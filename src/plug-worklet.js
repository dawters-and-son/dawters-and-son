// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// ds-plug: one VST3 plug-in instance, running in the native plug-in host (desktop builds only).
// Each 128-frame block is sent to the host through a message port that goes straight from this
// audio thread to the plug-in relay, and the processed block comes back a few blocks later: the
// node always delays by exactly `blocks` × 128 frames (plus the plug-in's own latency), which the
// engine compensates on every track. If an answer is late, the dry signal fills in for that block.
let PLUG_RELAY = null;
const PLUG_NODES = new Map();
function plugRelayMsg(e) {
  const m = e.data; if (!m || m.t !== 'a') return;
  const p = PLUG_NODES.get(m.id); if (p) p.reply(m);
}

class DSPlug extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const po = (o && o.processorOptions) || {};
    this.id = 0;
    this.instrument = !!po.instrument;
    this.D = Math.max(1, po.blocks | 0 || 4);
    // offline renders send whole chunks of D blocks at a time (one message instead of D); live sends every block
    this.C = po.offline ? this.D : 1;
    this.bk = 0; this.warm = Math.round(sampleRate / 128);
    this.seq = 0;
    this.replies = new Map();
    this.ev = [];                     // [frame (context), kind, chan, data1, value], sorted
    this.tp = { f0: 0, ppq: 0, tempo: 120, playing: false, ts: 0x0404 };
    this.offline = !!po.offline;
    this.late = 0; this.lateSent = 0;
    // sleeping: after two seconds of silence in and out, silent blocks aren't sent at all (they would come
    // back silent); the next sound or note wakes it, still on time because the delay is unchanged
    this.quiet = 0; this.sleepAfter = Math.round(sampleRate * 2 / 128); this.skipped = new Set();
    this.answered = -1;               // highest seq with an answer
    this.lastSent = -1;
    this.drainAt = -2;
    // a delay line for the dry signal: what plays while the plug-in is loading, or if an answer is late
    this.dry = [new Float32Array(this.D * 128), new Float32Array(this.D * 128)];
    this.dw = 0;
    if (po.events && po.events.length) this.addEvents(po.events);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.t === 'relay') { PLUG_RELAY = m.port; PLUG_RELAY.onmessage = plugRelayMsg; }
      else if (m.t === 'id') { if (this.id) PLUG_NODES.delete(this.id); this.id = m.id; this.bk = 0; this.seq = 0; this.replies.clear(); this.skipped.clear(); this.answered = -1; this.lastSent = -1; if (m.id) PLUG_NODES.set(m.id, this); }
      else if (m.t === 'ev') this.addEvents(m.ev.map((x) => [x[0], x[1] ? 1 : 0, 0, x[2], x[3]]));
      else if (m.t === 'now') this.ev.unshift([0, m.k ? 1 : 0, 0, m.n, m.v || 0]); // played live: as soon as possible
      else if (m.t === 'clear' || m.t === 'panic') { this.ev = []; this.ev.push([0, 2, 0, 0, 0]); }
      else if (m.t === 'tp') this.tp = Object.assign(this.tp, m.tp);
      else if (m.t === 'drain') { this.drainAt = this.lastSent; this.checkDrain(); }
      else if (m.t === 'stat') this.port.postMessage({ t: 'stat', id: this.id, seq: this.seq, answered: this.answered, late: this.late, relay: !!PLUG_RELAY, frame: currentFrame });
      else if (m.t === 'bye') { if (this.id) PLUG_NODES.delete(this.id); this.id = 0; this.dead = true; }
    };
  }
  addEvents(list) {
    for (const x of list) this.ev.push(x);
    this.ev.sort((a, b) => a[0] - b[0]);
  }
  reply(m) {
    if (m.seq > this.answered) this.answered = m.seq;
    if (m.ch) this.replies.set(m.seq, m.ch);
    this.checkDrain();
  }
  checkDrain() {
    if (this.drainAt !== null && this.drainAt !== undefined && this.drainAt > -2 && this.answered >= this.drainAt) { this.drainAt = -2; this.port.postMessage({ t: 'drained' }); }
  }
  process(inputs, outputs) {
    if (this.dead) return false;
    const out = outputs[0], inp = inputs[0] || [], fr = out[0].length, f0 = currentFrame;
    const L = inp[0], R = inp[1] || inp[0];
    // the dry delay line (effects only)
    const n = this.D * 128;
    let dl = null, dr = null;
    if (!this.instrument) {
      dl = new Float32Array(fr); dr = new Float32Array(fr);
      for (let i = 0; i < fr; i++) {
        const k = (this.dw + i) % n;
        dl[i] = this.dry[0][k]; dr[i] = this.dry[1][k];
        this.dry[0][k] = L ? L[i] : 0; this.dry[1][k] = R ? R[i] : 0;
      }
      this.dw = (this.dw + fr) % n;
    }
    let silentIn = true;
    if (!this.instrument && L) for (let i = 0; i < fr; i++) if (L[i] !== 0 || (R && R[i] !== 0)) { silentIn = false; break; }
    const C = this.C, live = C === 1;
    const due = this.ev.length && this.ev[0][0] < f0 + fr;
    if (!silentIn || due) this.quiet = 0;
    if (this.id && PLUG_RELAY) {
      const pos = this.bk % C;
      if (pos === 0) { this.cf0 = f0; this.cin = this.instrument ? [] : [new Float32Array(C * 128), new Float32Array(C * 128)]; this.cev = []; }
      if (!this.instrument) { if (L) this.cin[0].set(L, pos * 128); if (R) this.cin[1].set(R, pos * 128); }
      while (this.ev.length && this.ev[0][0] < f0 + fr) { const x = this.ev.shift(); this.cev.push([Math.max(0, x[0] - this.cf0), x[1], x[2], x[3], x[4]]); }
      if (pos === C - 1) {
        if (live && this.quiet >= this.sleepAfter && !this.cev.length) this.skipped.add(this.seq);
        else {
          const tp = this.tp, ppq = tp.ppq + (this.cf0 - tp.f0) / sampleRate * tp.tempo / 60, ch = this.cin;
          PLUG_RELAY.postMessage({ t: 'a', id: this.id, seq: this.seq, fr: C * 128, ch, ev: this.cev, tempo: tp.tempo, ppq, flags: (tp.playing ? 1 : 0) | (this.offline ? 2 : 0), ts: tp.ts }, ch.map((c) => c.buffer));
          this.lastSent = this.seq;
        }
        this.seq++;
      }
      this.bk++;
    }
    // the block D blocks back: which chunk it was in, and where
    const wb = this.bk - 1 - this.D, want = wb >= 0 ? Math.floor(wb / C) : -1, at = wb >= 0 ? (wb % C) * 128 : 0;
    const r = want >= 0 ? this.replies.get(want) : null;
    if (want >= 0 && this.skipped.has(want)) { if (at + 128 >= C * 128) this.skipped.delete(want); for (let c = 0; c < out.length; c++) out[c].fill(0); }
    else if (r) {
      if (at + 128 >= C * 128) this.replies.delete(want);
      let loud = false;
      for (let c = 0; c < out.length; c++) { const src = r[Math.min(c, r.length - 1)]; out[c].set(src.subarray(at, at + fr)); if (!loud) for (let i = at; i < at + fr; i++) if (Math.abs(src[i]) > 1e-6) { loud = true; break; } }
      if (loud) this.quiet = 0; else if (silentIn) this.quiet++;
    } else {
      if (want >= 0 && this.id && this.bk > this.warm) { this.late++; this.quiet = 0; } // the first second is a warm-up
      if (dl) { out[0].set(dl); if (out[1]) out[1].set(dr); }
    }
    if (this.replies.size > 64) for (const k of this.replies.keys()) if (k < want) this.replies.delete(k);
    if (this.late !== this.lateSent && (f0 & 0x3fff) < fr) { this.lateSent = this.late; this.port.postMessage({ t: 'late', n: this.late }); }
    return true;
  }
}
registerProcessor('ds-plug', DSPlug);
