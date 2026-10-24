// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — project model, defaults, undo history, clip maths
'use strict';
const M = {};
M.COLORS = ['#C8231B', '#2F4F7F', '#3D7A72', '#C99A1E', '#6E4A36', '#8E2F45', '#5D6B3A', '#B4644F', '#4E5A63', '#7C6BA0', '#1F2A44', '#8A847A'];
M.BUS_COLORS = ['#2F4F7F', '#3D7A72', '#C99A1E', '#8E2F45'];
M.NBUS = 4; M.NSEND = 4; M.NFX = 8;

M.defCh = (kind) => ({
  trim: 0, phase: false, hpf: 20, lpf: 20000, eqOn: true,
  lsF: 80, lsG: 0, lmF: 400, lmG: 0, hmF: 2500, hmG: 0, hsF: 10000, hsG: 0,
  gate: -80, compOn: true, mode: kind === 'bus' ? 'compressor' : kind === 'master' ? 'compressor' : 'compressor',
  thresh: 0, ratio: kind === 'track' ? 4 : 2, attack: kind === 'track' ? 10 : 20, release: kind === 'track' ? 120 : 250, makeup: 0,
  tape: 0, limOn: true, ceiling: -1, bypass: false,
});

M.newTrack = (i, opts = {}) => ({
  id: U.uid('t'), kind: opts.kind || 'audio', inst: opts.inst || null, beat: opts.kind === 'beat' ? (opts.beat || {}) : undefined,
  name: opts.name || (opts.kind === 'inst' ? INST.TYPES[opts.inst.type] + ' ' + (i + 1) : opts.kind === 'beat' ? 'Beat ' + (i + 1) : 'Track ' + (i + 1)), color: M.COLORS[i % M.COLORS.length],
  stereo: opts.stereo !== undefined ? opts.stereo : false, input: opts.input || '1',
  arm: false, mon: false, mute: false, solo: false, height: 92,
  ch: M.defCh('track'), fader: 1, pan: 0,
  sends: Array.from({ length: M.NSEND }, () => ({ lvl: 0, pre: false })), out: 'master',
  fx: [], clips: [],
  env: { vol: { on: false, pts: [] }, pan: { on: false, pts: [] } }, show: 'none',
});
M.newBus = (i) => ({ id: 'bus' + i, name: 'Mixbus ' + (i + 1), color: M.BUS_COLORS[i], ch: M.defCh('bus'), fader: 1, pan: 0, mute: false, fx: [] });
M.newProject = (sr) => {
  const p = {
    v: 1, name: 'Untitled Song', bpm: 120, sig: [4, 4], sr: sr || 48000,
    tracks: [], buses: Array.from({ length: M.NBUS }, (_, i) => M.newBus(i)),
    master: { ch: M.defCh('master'), fader: 1, fx: [], drive: 0, target: 'stream' }, patterns: {}, scenes: 8, cells: {}, matrixRec: false,
    loop: { on: false, s: 0, e: 8 }, punch: { on: false, s: 2, e: 6 }, markers: [],
    created: Date.now(),
  };
  for (let i = 0; i < 4; i++) p.tracks.push(M.newTrack(i));
  p.loop.e = 4 * 60 / p.bpm * p.sig[0];
  return p;
};

M.clipEnd = (c) => c.start + c.len;
// bring older song files up to date
M.migrate = (p) => {
  p.patterns = p.patterns || {}; p.scenes = p.scenes || 8; p.cells = p.cells || {}; p.matrixRec = !!p.matrixRec;
  // effects gain parameters over time: fill any the saved song does not have yet
  const fill = (list) => (list || []).forEach((f) => { if (FX.types[f.type]) f.p = Object.assign(FX.defaults(f.type), f.p); });
  p.tracks.forEach((t) => fill(t.fx)); p.buses.forEach((b) => fill(b.fx)); fill(p.master.fx);
  p.master.fx = p.master.fx || []; p.master.drive = p.master.drive || 0; p.master.target = p.master.target || 'stream'; p.buses.forEach((b) => (b.fx = b.fx || []));
  // songs from 2.0/2.1 used bright brutalist colours: move them onto the print-ink palette
  const OLD = ['#FF2B00', '#0038FF', '#00A651', '#FFB800', '#7A00FF', '#FF00A0', '#00B5B5', '#8C5A00', '#B3D400', '#FF7A00', '#00205B', '#8A8A8A'], OB = ['#7A00FF', '#00B5B5', '#FF7A00', '#0038FF'];
  p.buses.forEach((b, i) => { if (OB.includes(b.color)) b.color = M.BUS_COLORS[i]; });
  p.tracks.forEach((t) => { const k = OLD.indexOf(t.color); if (k >= 0) t.color = M.COLORS[k]; t.clips.forEach((c) => { const j = OLD.indexOf(c.color); if (j >= 0) c.color = M.COLORS[j]; }); });
  p.tracks.forEach((t) => { t.kind = t.kind || 'audio'; if (t.kind === 'inst' && !t.inst) t.inst = INST.make('synth'); if (t.inst && t.inst.type === 'drums') INST.fillPads(t.inst.p); });
  return p;
};
M.newPattern = (trackId, name, beats, kind) => ({ id: U.uid('p'), track: trackId, name: name || 'Pattern', len: beats || 16, notes: [], drums: kind === 'drums' });
M.bufRefs = (p) => { const s = new Set(); p.tracks.forEach((t) => { t.clips.forEach((c) => c.buf && s.add(c.buf)); if (t.inst) INST.bufIds(t.inst).forEach((x) => s.add(x)); }); return s; };

// Flatten a track's clips into non-overlapping playable segments; later clips sit on top.
M.flatten = (clips) => {
  let segs = [];
  for (const c of clips) {
    if (c.mute) continue;
    const s = c.start, e = c.start + c.len;
    const next = [];
    for (const g of segs) {
      if (g.e <= s || g.s >= e) { next.push(g); continue; }
      if (g.s < s) next.push({ c: g.c, s: g.s, e: s });
      if (g.e > e) next.push({ c: g.c, s: e, e: g.e });
    }
    next.push({ c, s, e });
    segs = next;
  }
  segs.sort((a, b) => a.s - b.s);
  return segs.filter((g) => g.e - g.s > 1e-6);
};

// Clip fade/gain value at time t (song seconds)
M.clipGainAt = (c, t) => {
  let g = c.gain;
  const x = t - c.start;
  if (c.fi > 0 && x < c.fi) g *= Math.max(0, x / c.fi);
  const y = c.start + c.len - t;
  if (c.fo > 0 && y < c.fo) g *= Math.max(0, y / c.fo);
  return g;
};

// Envelope value at t (points sorted by t)
M.envAt = (env, t, def) => {
  const p = env.pts;
  if (!p.length) return def;
  if (t <= p[0].t) return p[0].v;
  if (t >= p[p.length - 1].t) return p[p.length - 1].v;
  for (let i = 1; i < p.length; i++) if (p[i].t >= t) {
    const a = p[i - 1], b = p[i], f = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return a.v + (b.v - a.v) * f;
  }
  return def;
};

M.songEnd = (p) => {
  let e = 0;
  for (const t of p.tracks) for (const c of t.clips) e = Math.max(e, c.start + c.len);
  return e;
};

// ---------- Undo history (snapshots of the JSON model; audio buffers are immutable and referenced by id) ----------
class History {
  constructor() { this.u = []; this.r = []; this.max = 150; }
  push(proj, label) { this.u.push({ s: JSON.stringify(proj), label }); if (this.u.length > this.max) this.u.shift(); this.r = []; }
  undo(proj) { const h = this.u.pop(); if (!h) return null; this.r.push({ s: JSON.stringify(proj), label: h.label }); return { p: JSON.parse(h.s), label: h.label }; }
  redo(proj) { const h = this.r.pop(); if (!h) return null; this.u.push({ s: JSON.stringify(proj), label: h.label }); return { p: JSON.parse(h.s), label: h.label }; }
  clear() { this.u = []; this.r = []; }
  refs() { const s = new Set(); for (const h of this.u.concat(this.r)) { const m = h.s.match(/"buf":"[^"]+"/g); if (m) m.forEach((x) => s.add(x.slice(7, -1))); } return s; }
}
M.History = History;
