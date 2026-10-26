// SPDX-License-Identifier: GPL-3.0-or-later
// The Increaser — live looper. Copyright (C) 2026 Josh Wilk.
'use strict';
(() => {
const NT = 6;
const $ = id => document.getElementById(id);
const h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
};
const ENGINE_SRC = $('engine-src').textContent;
const Engine = new Function(ENGINE_SRC + '\nreturn Engine;')();
const ICON = {
  play: '<svg viewBox="0 0 24 24"><path d="M7 4l13 8-13 8z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 24 24"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>',
  undo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  clear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};
const TCOL = ['--t1', '--t2', '--t3', '--t4', '--t5', '--t6'];
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  mode: 'sync', loopBars: 4, bpb: 4, tempo: 120,
  lead: 4, quantIn: 'bar', punchOut: 'pass', outBars: 4, passes: 4, outQuant: 'bar', replace: false,
  advance: true, leadClick: true, click: false, clickVol: 0.5, autoStart: false, trigDb: -30, bigCount: true,
  stretch: 1, holdUndo: true, source: 'mic', test: 9, monitor: false, inGain: 1, inCh: 0, deviceId: '',
  latAuto: true, latOffsetMs: 0, latCalMs: null, theme: '', master: 0.9, tab: 'punch',
  bindings: null, recipe: null, buildBars: 4,
  startOn: 'count', silHold: 1, gate: false,
};
const S = Object.assign({}, DEFAULTS);
try { Object.assign(S, JSON.parse(localStorage.getItem('increaser.prefs') || '{}')); } catch (e) {}
if (S.autoStart && S.startOn === 'count') { S.startOn = 'sound'; S.autoStart = false; } // 0.1.0 setting
const saveSoon = (() => { let t; return () => { clearTimeout(t); t = setTimeout(() => { try { const o = {}; for (const k in DEFAULTS) o[k] = S[k]; localStorage.setItem('increaser.prefs', JSON.stringify(o)); } catch (e) {} }, 300); }; })();

const NAMES = ['Ristretto', 'Lungo', 'Doppio', 'Macchiato', 'Cortado', 'Affogato'];
const tracks = [];
for (let i = 0; i < NT; i++) tracks.push({ name: NAMES[i], keep: 0, vol: 0.8, pan: 0, filt: 0, fade: 0, mute: false, solo: false, rev: false, lenBars: 0, active: [], undo: [], redo: [], bins: null });
const layers = new Map();
const loop = { L: 0, baseTempo: S.tempo, loopBars: S.loopBars, bpb: S.bpb };
let sel = 0, hist = [], rhist = [];
let T = { G: 0, playing: false, r: 1, L: 0, baseTempo: S.tempo, recs: [], peaks: [0, 0, 0, 0, 0, 0], inPeak: 0, mPeak: 0, at: 0 };

// ---------------------------------------------------------------- audio
let ctx = null, node = null, micStream = null, micSrc = null, starting = null;
const sr = () => ctx ? ctx.sampleRate : 48000;
function send(m, tr) { if (node) node.port.postMessage(m, tr || []); }

function ensureAudio() {
  if (starting) { if (ctx && node && ctx.state !== 'running') ctx.resume(); return starting; } // still loading: wait for the worklet
  starting = (async () => {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    const wrap = `
class P extends AudioWorkletProcessor {
  constructor() { super(); this.e = new Engine(sampleRate); this.k = 0; this.port.onmessage = ev => this.e.cmd(ev.data); }
  process(ins, outs) {
    const i = ins[0] || [], o = outs[0];
    this.e.process(i[0] || null, i[1] || i[0] || null, o[0], o[1] || o[0], o[0].length);
    const out = this.e.out;
    if (out.length) {
      for (const m of out) {
        if (m._transfer) { const tr = []; for (const k of ['Lb', 'Rb', 'L', 'R']) if (m[k] && m[k].buffer) tr.push(m[k].buffer); delete m._transfer; this.port.postMessage(m, tr); }
        else this.port.postMessage(m);
      }
      this.e.out = [];
    }
    if (++this.k >= 3) { this.k = 0; this.port.postMessage(this.e.status()); }
    return true;
  }
}
registerProcessor('increaser', P);`;
    const url = URL.createObjectURL(new Blob([ENGINE_SRC + wrap], { type: 'application/javascript' }));
    try { await ctx.audioWorklet.addModule(url); }
    catch (e) {
      toast('Audio could not start here. Open the page from a web address (the launcher or the website) in Chrome, Edge or Firefox.', 7000);
      throw e;
    }
    node = new AudioWorkletNode(ctx, 'increaser', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
    node.port.onmessage = ev => onMsg(ev.data);
    node.connect(ctx.destination);
    pushAll();
    if (ctx.state !== 'running') await ctx.resume();
  })();
  starting.catch(() => { starting = null; ctx = null; node = null; });
  return starting;
}

function pushAll() {
  send({ c: 'set', bpb: S.bpb, loopBars: S.loopBars, baseTempo: loop.L ? loop.baseTempo : S.tempo, stretch: S.stretch, clickOn: S.click, leadClick: S.leadClick,
    clickVol: S.clickVol, monitor: S.monitor, inGain: S.inGain, inCh: S.inCh, master: S.master, trigLevel: Math.pow(10, S.trigDb / 20),
    test: S.source === 'test' ? S.test : 0, latency: latencyFrames() });
}

function latencyFrames() {
  let ms;
  if (!S.latAuto && S.latCalMs != null) ms = S.latCalMs;
  else {
    const out = ctx ? ((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000 : 0;
    let inp = 10;
    try { const tk = micStream && micStream.getAudioTracks()[0]; const st = tk && tk.getSettings(); if (st && st.latency) inp = st.latency * 1000; } catch (e) {}
    ms = S.source === 'mic' ? out + inp : 0;
  }
  ms += S.latOffsetMs;
  return Math.max(0, Math.round(ms * sr() / 1000));
}

async function openMic(force) {
  if (S.source !== 'mic') { if (micSrc) { micSrc.disconnect(); micSrc = null; } return true; }
  if (micSrc && !force) return true;
  await ensureAudio();
  try {
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
    if (S.deviceId) audio.deviceId = { exact: S.deviceId };
    micStream = await navigator.mediaDevices.getUserMedia({ audio });
    if (micSrc) micSrc.disconnect();
    micSrc = ctx.createMediaStreamSource(micStream);
    micSrc.connect(node);
    pushAll(); fillDevices();
    return true;
  } catch (e) {
    toast('No microphone: ' + (e.name === 'NotAllowedError' ? 'access was refused.' : e.message) + ' Pick the test band in Input to try it out.', 6000);
    return false;
  }
}

// ---------------------------------------------------------------- grid helpers
function grid() {
  const L = loop.L || S.loopBars * S.bpb * 60 * sr() / S.tempo;
  const bar = L / (loop.L ? loop.loopBars : S.loopBars);
  return { L, bar, beat: bar / (loop.L ? loop.bpb : S.bpb) };
}
const trackLen = t => tracks[t].lenBars ? tracks[t].lenBars * grid().bar : loop.L;
const tempoNow = () => loop.L ? T.r * loop.baseTempo : S.tempo;
function Gnow() {
  if (!T.playing) return T.G;
  return T.G + (performance.now() - T.at) / 1000 * sr() * T.r;
}
const recOf = t => T.recs.find(r => r.track === t && r.on) || T.recs.find(r => r.track === t);

// ---------------------------------------------------------------- engine messages
const tagWaiters = new Map();
function onMsg(m) {
  switch (m.t) {
    case 'tick': T = m; T.at = performance.now(); break;
    case 'layer': {
      const tr = tracks[m.track];
      const lay = { id: m.id, track: m.track, Lb: m.Lb, Rb: m.Rb, n: m.n, s: m.s, rate: m.rate, replace: m.replace, gate: m.gate || 0 };
      layers.set(m.id, lay);
      if (!tr.active.includes(m.id)) tr.active.push(m.id);
      const op = { k: 'add', id: m.id };
      if (tr.keep && tr.active.length > tr.keep) { op.dropped = tr.active.splice(0, tr.active.length - tr.keep); sync(m.track); }
      tr.undo.push(op); dropRedo(m.track); hist.push(m.track); rhist = [];
      layerBins(lay); trackBins(m.track); renderCups();
      break;
    }
    case 'loopDefined': {
      Object.assign(loop, { L: m.L, baseTempo: m.baseTempo, loopBars: m.loopBars, bpb: m.bpb });
      S.tempo = Math.round(m.baseTempo * 10) / 10; saveSoon();
      toast(`Loop set: ${m.loopBars} bars at ${m.baseTempo.toFixed(1)} BPM`);
      renderDeck(); renderPanes();
      break;
    }
    case 'recEnd': {
      if (m.layers > 0 && m.why === 'done' && S.advance && !build.running && m.track === sel && !(m.tag && (m.tag.startsWith('b') || m.tag === 'rt'))) {
        let n = (sel + 1) % NT;
        for (let k = 0; k < NT; k++) { const c = (sel + 1 + k) % NT; if (!tracks[c].active.length) { n = c; break; } }
        select(n);
      }
      if (build.running) build.onRecEnd(m);
      renderCups();
      break;
    }
    case 'armed': { const w = tagWaiters.get(m.tag); if (w) { tagWaiters.delete(m.tag); w(m); } break; }
    case 'event': {
      const c = m.cmd;
      if (c.c === 'setTrack') { const tr = tracks[c.track]; for (const k of ['mute', 'solo', 'vol']) if (c[k] !== undefined) tr[k] = c[k]; renderCups(); }
      break;
    }
    case 'tempoHeld': toast(`Tempo ${m.bpm.toFixed(1)} will apply when the take ends`); break;
    case 'cap': cap.chunks.push([m.L, m.R]); cap.frames += m.L.length; break;
    case 'capEnd': finishCapture(); break;
    case 'calib': calibDone(m); break;
    case 'rampDone': toast('Tempo ramp finished at ' + (m.r * loop.baseTempo).toFixed(1) + ' BPM'); break;
  }
}

// ---------------------------------------------------------------- recording logic
const thrLin = () => Math.pow(10, S.trigDb / 20);
function silFrames() { const g = grid(); return S.silHold === 'bar' ? Math.round(g.bar) : Math.round(S.silHold * sr()); }
function lenOpts(t) {
  const g = grid();
  switch (S.punchOut) {
    case 'pass': return { passes: 1 };
    case 'bars': return { len: S.outBars * g.bar };
    case 'layer': return { passes: S.passes };
    default: return {};
  }
}

function defineSyncLoop() {
  const L = S.loopBars * S.bpb * 60 * sr() / S.tempo;
  Object.assign(loop, { L, baseTempo: S.tempo, loopBars: S.loopBars, bpb: S.bpb });
  send({ c: 'defineLoop', L, baseTempo: S.tempo, loopBars: S.loopBars, bpb: S.bpb });
  renderDeck(); renderPanes();
}

async function record(t, extra = {}) {
  await ensureAudio();
  if (!(await openMic())) return null;
  pushAll();
  const g = grid();
  const lead = Math.round(S.lead * g.beat);
  const tag = extra.tag || ('u' + Math.random().toString(36).slice(2, 7));
  const base = Object.assign({ c: 'arm', track: t, lead, tag, replace: S.replace, quant: S.quantIn, gate: S.gate ? thrLin() : 0 }, extra);
  const sound = S.startOn === 'sound' && !extra.noTrigger;
  if (S.punchOut === 'silence' && (loop.L || S.mode === 'sync') && base.silStop == null) { base.silStop = silFrames(); base.silQ = S.outQuant === 'now' ? 'beat' : S.outQuant; }
  if (!loop.L) {
    if (S.mode === 'free') {
      if (sound) { send(Object.assign(base, { trigger: true, free: true, lead: 0, silStop: 0 })); toast('Listening — start playing and the first loop begins'); return tag; }
      send({ c: 'play', G: -lead });
      send(Object.assign(base, { startG: 0, free: true }));
      return tag;
    }
    defineSyncLoop();
    if (sound) { send(Object.assign(lenOpts(t), base, { trigger: true, lead: 0 })); toast('Listening — bar 1 starts on your first note'); return tag; }
    send({ c: 'play', G: -lead });
    send(Object.assign(lenOpts(t), base, { startG: 0 }));
    return tag;
  }
  if (sound) { send(Object.assign(lenOpts(t), base, { trigger: true, lead: 0 })); toast(tracks[t].name + ' is listening — it records from your first note'); return tag; }
  if (!T.playing && extra.startG == null) {
    send({ c: 'play', G: -lead });
    send(Object.assign(lenOpts(t), base, { startG: 0 }));
    T.playing = true;
    return tag;
  }
  send(Object.assign(lenOpts(t), base));
  return tag;
}

function punchOut(t) { send({ c: 'punchOut', track: t, quant: S.outQuant }); }

async function main(t = sel) {
  const r = recOf(t);
  if (r) { if (r.on) punchOut(t); else send({ c: 'cancel', track: t }); return; }
  await record(t);
}

async function playStop() {
  await ensureAudio();
  if (T.playing) { send({ c: 'stop' }); build.stop(true); T.playing = false; }
  else if (loop.L) { send({ c: 'play', G: 0 }); T.playing = true; }
  else toast('Nothing to play yet — press Increase to record the first loop');
}

function sync(t) {
  const tr = tracks[t];
  send({ c: 'setTrack', track: t, active: tr.active.slice(), vol: tr.vol, pan: tr.pan, mute: tr.mute, solo: tr.solo, filt: tr.filt, fade: tr.fade, rev: tr.rev, lenBars: tr.lenBars });
}

function dropRedo(t) {
  const tr = tracks[t];
  const ids = [];
  for (const op of tr.redo) if (op.k === 'add') ids.push(op.id);
  tr.redo = [];
  const used = new Set();
  for (const x of tracks) { x.active.forEach(i => used.add(i)); for (const op of x.undo) (op.k === 'add' ? [op.id].concat(op.dropped || []) : op.ids).forEach(i => used.add(i)); }
  const free = ids.filter(i => !used.has(i));
  if (free.length) { send({ c: 'freeLayers', ids: free }); free.forEach(i => layers.delete(i)); }
}

function undo(t) {
  if (t == null) {
    const r = T.recs.find(x => x.track === sel);
    if (r) { send({ c: 'cancel', track: sel }); return; }
    t = hist.length ? hist.pop() : sel;
  } else { const i = hist.lastIndexOf(t); if (i >= 0) hist.splice(i, 1); }
  const tr = tracks[t];
  if (T.recs.some(x => x.track === t)) { send({ c: 'cancel', track: t }); toast('Take cancelled'); return; }
  const op = tr.undo.pop(); if (!op) { toast('Nothing to undo'); return; }
  if (op.k === 'add') { tr.active = tr.active.filter(x => x !== op.id); if (op.dropped) tr.active = op.dropped.concat(tr.active); }
  else tr.active = op.ids.slice();
  tr.redo.push(op); rhist.push(t);
  sync(t); trackBins(t); renderCups();
  toast(op.k === 'add' ? `Undo: ${tr.name} has ${tr.active.length} layer${tr.active.length === 1 ? '' : 's'}` : `Undo: ${tr.name} restored`);
}
function redo(t) {
  if (t == null) t = rhist.length ? rhist.pop() : sel;
  else { const i = rhist.lastIndexOf(t); if (i >= 0) rhist.splice(i, 1); }
  const tr = tracks[t];
  const op = tr.redo.pop(); if (!op) { toast('Nothing to redo'); return; }
  if (op.k === 'add') { if (op.dropped) tr.active = tr.active.filter(x => !op.dropped.includes(x)); tr.active.push(op.id); } else tr.active = [];
  tr.undo.push(op); hist.push(t);
  sync(t); trackBins(t); renderCups();
}
// Retake: drop the last take on this cup and record the same stretch of the loop again, counted in
async function retake(t = sel) {
  const tr = tracks[t];
  if (T.recs.some(x => x.track === t)) { send({ c: 'cancel', track: t }); }
  const op = tr.undo[tr.undo.length - 1];
  if (!loop.L || !op || op.k !== 'add') { toast('Nothing to retake on ' + tr.name + ' — press Increase'); return; }
  const lay = layers.get(op.id); if (!lay) return;
  undo(t);
  await ensureAudio();
  const g = grid(), len = trackLen(t), lead = Math.round(S.lead * g.beat);
  const span = Math.min(lay.n * lay.rate, len);
  const phase = (((lay.s + latencyFrames() * lay.rate) % len) + len) % len;
  let at;
  if (!T.playing) { send({ c: 'play', G: phase - lead }); at = phase; T.playing = true; }
  else { const G = Gnow() + lead + 512; at = Math.ceil((G - phase) / len) * len + phase; }
  send({ c: 'arm', track: t, startG: at, len: span, lead, replace: lay.replace, gate: lay.gate || 0, tag: 'rt' });
  toast('Retake: ' + tr.name + ' records that spot again' + (S.lead ? ' after the count-in' : ''));
}
function clearTrack(t) {
  const tr = tracks[t];
  send({ c: 'cancel', track: t });
  if (!tr.active.length) return;
  const op = { k: 'clear', ids: tr.active.slice() };
  tr.active = []; tr.undo.push(op); dropRedo(t); hist.push(t);
  sync(t); trackBins(t); renderCups();
  toast(`${tr.name} cleared — Undo brings it back`);
}
function newSession() {
  send({ c: 'stop' }); send({ c: 'reset', baseTempo: S.tempo }); build.stop(true);
  layers.clear(); hist = []; rhist = [];
  for (const tr of tracks) Object.assign(tr, { active: [], undo: [], redo: [], bins: null, lenBars: 0, mute: false, solo: false });
  Object.assign(loop, { L: 0, baseTempo: S.tempo, loopBars: S.loopBars, bpb: S.bpb });
  for (let t = 0; t < NT; t++) sync(t);
  T.playing = false; select(0);
  renderAll();
}

// ---------------------------------------------------------------- tempo
function setTempo(bpm) {
  bpm = Math.max(30, Math.min(300, Math.round(bpm * 10) / 10));
  if (!loop.L) { S.tempo = bpm; send({ c: 'tempo', bpm }); saveSoon(); }
  else { send({ c: 'tempo', bpm }); T.r = bpm / loop.baseTempo; }
  renderDeck();
}
const taps = [];
function tap() {
  const now = performance.now();
  if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
  taps.push(now); if (taps.length > 5) taps.shift();
  if (taps.length >= 3) { let s = 0; for (let i = 1; i < taps.length; i++) s += taps[i] - taps[i - 1]; setTempo(60000 / (s / (taps.length - 1))); }
}

// ---------------------------------------------------------------- build runner
const ACTIONS = { rec: 'Record', layer: 'Layer ×', replace: 'Replace', mute: 'Mute', unmute: 'Unmute', tempo: 'Tempo', ramp: 'Ramp to', wait: 'Wait' };
const PRESETS = {
  'Four cups': [
    { a: 'rec', t: 0, bars: 0 }, { a: 'rec', t: 1, bars: 0 }, { a: 'rec', t: 2, bars: 0 }, { a: 'rec', t: 3, bars: 0 }],
  'Beatbox to band': [
    { a: 'layer', t: 0, passes: 3 }, { a: 'rec', t: 1, bars: 0 }, { a: 'rec', t: 2, bars: 0 }, { a: 'wait', bars: 4 }, { a: 'rec', t: 3, bars: 8 }],
  'Build, drop, lift': [
    { a: 'rec', t: 0, bars: 0 }, { a: 'rec', t: 1, bars: 0 }, { a: 'rec', t: 2, bars: 0 },
    { a: 'mute', t: 1 }, { a: 'mute', t: 2 }, { a: 'wait', bars: 4 }, { a: 'unmute', t: 1 }, { a: 'unmute', t: 2 }, { a: 'ramp', bpm: 8, bars: 8 }],
  'Slow burn': [
    { a: 'rec', t: 0, bars: 0 }, { a: 'layer', t: 1, passes: 2 }, { a: 'ramp', bpm: 6, bars: 8 }, { a: 'wait', bars: 8 }, { a: 'rec', t: 2, bars: 0 }, { a: 'ramp', bpm: 6, bars: 8 }],
};
if (!S.recipe) S.recipe = JSON.parse(JSON.stringify(PRESETS['Four cups']));

const build = {
  running: false, i: 0, cursor: null, win: [], pending: 0, waitFree: false,
  async start() {
    if (this.running) return;
    if (!S.recipe.length) { toast('Add a step first'); return; }
    await ensureAudio();
    if (!(await openMic())) return;
    this.running = true; this.i = 0; this.win = []; this.pending = 0; this.cursor = null; this.waitFree = false;
    renderBuild();
    const g = grid(), lead = Math.round(S.lead * g.beat);
    if (!loop.L && S.mode === 'sync') { defineSyncLoop(); send({ c: 'play', G: -lead }); this.cursor = 0; T.playing = true; }
    else if (loop.L && !T.playing) { send({ c: 'play', G: -lead }); this.cursor = 0; T.playing = true; }
    this.next();
  },
  stop(silent) {
    if (!this.running) return;
    this.running = false;
    send({ c: 'clearEvents' });
    for (const r of T.recs) if (!r.on) send({ c: 'cancel', track: r.track });
    if (!silent) toast('Build stopped');
    renderBuild();
  },
  stepLen(st) { const g = grid(); return st.bars ? st.bars * g.bar : trackLen(st.t) || g.L; },
  async next() {
    while (this.running && this.i < S.recipe.length) {
      const st = S.recipe[this.i], idx = this.i, g = grid();
      if (['rec', 'layer', 'replace'].includes(st.a)) {
        const tag = 'b' + idx + '_' + Date.now().toString(36);
        if (!loop.L) {
          // free mode: the first take is played in by hand (or auto-start); continue once the loop exists
          this.waitFree = true; this.i++;
          tagWaiters.set(tag, m => { this.win[idx] = [m.startG, null]; });
          await record(st.t, { tag });
          renderBuild(); return;
        }
        const extra = { tag, queue: true, replace: st.a === 'replace' };
        extra.len = 0; extra.passes = 0;
        if (st.a === 'layer') extra.passes = st.passes || 2; else if (st.bars) extra.len = st.bars * g.bar; else extra.passes = 1;
        if (this.cursor != null) extra.startG = this.cursor; else { extra.startG = null; }
        const armed = new Promise(res => tagWaiters.set(tag, res));
        if (st.t !== sel) select(st.t);
        await record(st.t, Object.assign({ noTrigger: true }, extra));
        const m = await armed;
        const end = m.endG != null ? m.endG : m.startG + this.stepLen(st) * (st.passes || 1);
        this.win[idx] = [m.startG, end]; this.cursor = end; this.pending++;
      } else if (st.a === 'wait') {
        if (this.cursor == null) this.cursor = Math.ceil((Gnow() + 1) / g.bar) * g.bar;
        const s0 = this.cursor; this.cursor += (st.bars || 4) * g.bar; this.win[idx] = [s0, this.cursor];
      } else {
        if (this.cursor == null) this.cursor = Math.ceil((Gnow() + 1) / g.bar) * g.bar;
        let cmd;
        if (st.a === 'mute' || st.a === 'unmute') cmd = { c: 'setTrack', track: st.t, mute: st.a === 'mute' };
        else if (st.a === 'tempo') cmd = { c: 'tempo', bpm: Math.max(30, tempoNow() + (st.bpm || 0)) };
        else if (st.a === 'ramp') cmd = { c: 'ramp', bpm: Math.max(30, tempoNow() + (st.bpm || 0)), bars: st.bars || 8 };
        send({ c: 'at', G: this.cursor, cmd, tag: 'b' + idx });
        this.win[idx] = [this.cursor, this.cursor + 1];
      }
      this.i++;
    }
    renderBuild();
  },
  onRecEnd(m) {
    if (this.waitFree && loop.L) {
      this.waitFree = false;
      const g = grid();
      this.cursor = Math.ceil((Gnow() + S.lead * g.beat + 2000) / g.bar) * g.bar;
      if (this.win.length) this.win[this.win.length - 1][1] = Gnow();
      this.next();
    }
  },
  current() {
    if (!this.running) return -1;
    const G = Gnow();
    let cur = -1;
    for (let k = 0; k < this.win.length; k++) { const w = this.win[k]; if (w && G >= w[0] - 1 && (w[1] == null || G < w[1])) cur = k; }
    const last = this.win[S.recipe.length - 1];
    if (this.i >= S.recipe.length && last && last[1] != null && G >= last[1] && !T.recs.length) { this.running = false; toast('Build complete'); renderBuild(); }
    return cur;
  },
};

function quickBuild(kind) {
  if (!loop.L || !T.playing) { toast('Start the loop playing first'); return; }
  const g = grid();
  let at = Math.ceil((Gnow() + g.beat) / g.bar) * g.bar;
  const used = tracks.map((x, i) => i).filter(i => tracks[i].active.length);
  if (!used.length) return;
  const N = S.buildBars * g.bar;
  if (kind === 'up') {
    for (const t of used) send({ c: 'at', G: at, cmd: { c: 'setTrack', track: t, mute: true } });
    used.forEach((t, k) => send({ c: 'at', G: at + k * N, cmd: { c: 'setTrack', track: t, mute: false } }));
    toast(`Build-up: ${used.length} cups come in one at a time, every ${S.buildBars} bars`);
  } else if (kind === 'down') {
    used.slice(1).reverse().forEach((t, k) => send({ c: 'at', G: at + k * N, cmd: { c: 'setTrack', track: t, mute: true } }));
    toast(`Breakdown: cups drop out every ${S.buildBars} bars until only ${tracks[used[0]].name} is left`);
  } else if (kind === 'drop') {
    for (const t of used.slice(1)) { send({ c: 'at', G: at, cmd: { c: 'setTrack', track: t, mute: true } }); send({ c: 'at', G: at + N, cmd: { c: 'setTrack', track: t, mute: false } }); }
    toast(`Drop: everything but ${tracks[used[0]].name} for ${S.buildBars} bars, then all back in`);
  } else if (kind === 'all') {
    send({ c: 'clearEvents' });
    for (const t of used) send({ c: 'at', G: at, cmd: { c: 'setTrack', track: t, mute: false } });
  }
}

// ---------------------------------------------------------------- waveforms on the cups
const BINS = 240;
function layerBins(lay) {
  const len = trackLen(lay.track) || loop.L; if (!len) return;
  const b = new Float32Array(BINS), step = Math.max(1, Math.floor(lay.n / (BINS * 24)));
  for (let i = 0; i < lay.n; i += step) {
    const v = Math.max(Math.abs(lay.Lb[i]), Math.abs(lay.Rb[i]));
    let p = (lay.s + i * lay.rate) % len; const k = Math.floor(p / len * BINS) % BINS;
    if (v > b[k]) b[k] = v;
  }
  lay.bins = b;
}
function trackBins(t) {
  const tr = tracks[t]; if (!tr.active.length) { tr.bins = null; return; }
  const b = new Float32Array(BINS); let g = 1;
  for (let a = tr.active.length - 1; a >= 0; a--) {
    const lay = layers.get(tr.active[a]); if (!lay) continue; if (!lay.bins) layerBins(lay);
    if (lay.bins) for (let k = 0; k < BINS; k++) b[k] += lay.bins[k] * g;
    g *= 1 - tr.fade;
  }
  let mx = 0.05; for (let k = 0; k < BINS; k++) mx = Math.max(mx, b[k]);
  for (let k = 0; k < BINS; k++) b[k] = Math.sqrt(b[k] / mx);
  tr.bins = b;
}

// ---------------------------------------------------------------- knob
function knob({ label, min, max, value, def, bipolar, fmt, onChange }) {
  const el = h('div', { class: 'knob' });
  const dial = h('div', { class: 'dial', tabindex: 0, role: 'slider', 'aria-label': label });
  const ring = h('div', { class: 'ring' }), cap = h('div', { class: 'cap' }), ptr = h('div', { class: 'ptr' });
  dial.append(ring, cap, ptr);
  const kv = h('div', { class: 'kv' }), kl = h('div', { class: 'kl' }, label);
  el.append(dial, kl, kv);
  let v = value;
  const draw = () => {
    const u = (v - min) / (max - min), ang = -135 + u * 270;
    ptr.style.transform = `rotate(${ang}deg)`;
    const lo = bipolar ? Math.min(0, ang) : -135, span = bipolar ? Math.abs(ang) : u * 270;
    ring.style.background = `conic-gradient(from ${lo}deg, var(--red) 0 ${span}deg, transparent ${span}deg), conic-gradient(from -135deg, var(--track) 0 270deg, transparent 270deg)`;
    dial.setAttribute('aria-valuenow', v.toFixed(2)); kv.textContent = fmt ? fmt(v) : v.toFixed(2);
  };
  const setV = (nv, emit) => { nv = Math.max(min, Math.min(max, nv)); if (bipolar && Math.abs(nv) < (max - min) * 0.015) nv = 0; v = nv; draw(); if (emit) onChange(v); };
  let y0 = 0, v0 = 0;
  dial.addEventListener('pointerdown', e => { dial.setPointerCapture(e.pointerId); y0 = e.clientY; v0 = v; e.preventDefault(); });
  dial.addEventListener('pointermove', e => { if (!dial.hasPointerCapture(e.pointerId)) return; const k = e.shiftKey ? 600 : 150; setV(v0 + (y0 - e.clientY) / k * (max - min), true); });
  dial.addEventListener('wheel', e => { e.preventDefault(); setV(v - Math.sign(e.deltaY) * (max - min) / 50, true); }, { passive: false });
  dial.addEventListener('dblclick', () => setV(def, true));
  dial.addEventListener('keydown', e => {
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { setV(v + (max - min) / 50, true); e.preventDefault(); e.stopPropagation(); }
    if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { setV(v - (max - min) / 50, true); e.preventDefault(); e.stopPropagation(); }
  });
  draw();
  el.set = nv => setV(nv, false);
  return el;
}
function seg(opts, value, onChange, attrs) {
  const el = h('div', Object.assign({ class: 'seg' }, attrs || {}));
  for (const [val, lab, dis] of opts) {
    const b = h('button', { 'data-v': String(val), class: val === value ? 'on' : '', disabled: !!dis, onclick: () => { for (const x of el.children) x.classList.toggle('on', x === b); onChange(val); } }, lab);
    el.append(b);
  }
  return el;
}
function sw(label, key, after) {
  const inp = h('input', { type: 'checkbox' }); inp.checked = !!S[key];
  inp.onchange = () => { S[key] = inp.checked; saveSoon(); pushAll(); after && after(); };
  return h('label', { class: 'switch' }, inp, h('span', null, label));
}
function sel_(opts, value, onChange) {
  const s = h('select'); for (const [v, l] of opts) { const o = h('option', { value: String(v) }, l); if (String(v) === String(value)) o.selected = true; s.append(o); }
  s.onchange = () => onChange(s.value); return s;
}

// ---------------------------------------------------------------- cups
const cupEls = [];
function buildCups() {
  const wrap = $('cups'); wrap.innerHTML = '';
  for (let t = 0; t < NT; t++) {
    const tr = tracks[t];
    const card = h('article', { class: 'cup', style: `--tc: var(${TCOL[t]})` });
    const name = h('input', { class: 'name', value: tr.name, 'aria-label': 'Cup name', onchange: () => { tr.name = name.value || NAMES[t]; if (S.tab === 'build') renderPanes(); } });
    const state = h('span', { class: 'state' }, 'Empty');
    const cv = h('canvas', { class: 'cv', 'aria-label': 'Cup ' + (t + 1) });
    cv.addEventListener('click', () => select(t));
    cv.addEventListener('dblclick', () => { select(t); main(t); });
    const bRec = h('button', { class: 'rec', title: 'Record / overdub / punch out', onclick: () => { select(t); main(t); } }, '● Rec');
    const bMute = h('button', { title: 'Mute', onclick: () => { tr.mute = !tr.mute; sync(t); renderCups(); } }, 'M');
    const bSolo = h('button', { class: 'hide-xs', title: 'Solo', onclick: () => { tr.solo = !tr.solo; sync(t); renderCups(); } }, 'S');
    const bUndo = h('button', { title: 'Undo the last layer on this cup', onclick: () => undo(t) }); bUndo.innerHTML = ICON.undo;
    const bRedo = h('button', { class: 'hide-xs', title: 'Redo', onclick: () => redo(t) }); bRedo.innerHTML = ICON.redo;
    const bClr = h('button', { title: 'Clear this cup (undoable)', onclick: () => clearTrack(t) }); bClr.innerHTML = ICON.clear;
    const kv = knob({ label: 'Vol', min: 0, max: 1.2, value: tr.vol, def: 0.8, fmt: v => v < 0.002 ? '−∞' : (20 * Math.log10(v)).toFixed(1), onChange: v => { tr.vol = v; sync(t); } });
    const kp = knob({ label: 'Pan', min: -1, max: 1, value: tr.pan, def: 0, bipolar: true, fmt: v => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100), onChange: v => { tr.pan = v; sync(t); } });
    const kf = knob({ label: 'Tone', min: -1, max: 1, value: tr.filt, def: 0, bipolar: true, fmt: v => v === 0 ? 'open' : v < 0 ? 'LP' + Math.round(-v * 100) : 'HP' + Math.round(v * 100), onChange: v => { tr.filt = v; sync(t); } });
    const kd = knob({ label: 'Fade', min: 0, max: 0.9, value: tr.fade, def: 0, fmt: v => Math.round(v * 100) + '%', onChange: v => { tr.fade = v; sync(t); trackBins(t); } });
    kd.title = 'Each older layer plays this much quieter than the one above it';
    const len = sel_([[0, 'Loop'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']], tr.lenBars, v => { tr.lenBars = +v; sync(t); });
    len.title = 'Cup length (set while the cup is empty)';
    const bRev = h('button', { class: 'chip', title: 'Play this cup backwards', onclick: () => { tr.rev = !tr.rev; sync(t); renderCups(); } }, 'Rev');
    const info = h('span', null, '');
    card.append(
      h('header', null, h('span', { class: 'no' }, 'No.' + (t + 1)), name, state),
      cv,
      h('div', { class: 'cbtns' }, bRec, bMute, bSolo, bUndo, bRedo, bClr),
      h('div', { class: 'knobs' }, kv, kp, kf, kd),
      h('div', { class: 'cfoot' }, len, bRev, h('span', { class: 'sp' }), info));
    card.addEventListener('pointerdown', () => { if (sel !== t) select(t); }, true);
    wrap.append(card);
    cupEls[t] = { card, cv, state, bRec, bMute, bSolo, bUndo, bRedo, bClr, len, bRev, info, name, knobs: { kv, kp, kf, kd } };
  }
  renderCups();
}
function select(t) { const ch = sel !== t; sel = t; renderCups(); renderDeck(); if (ch && S.tab === 'punch') renderPanes(); }

function trackState(t) {
  const tr = tracks[t], r = recOf(t);
  if (r && r.on) return tr.active.length ? ['rec', 'Dub'] : ['rec', 'Rec'];
  if (r) return ['armed', r.trigger ? 'Listening' : 'Armed'];
  if (!tr.active.length) return ['', 'Empty'];
  if (tr.mute || (tracks.some(x => x.solo) && !tr.solo)) return ['mute', 'Muted'];
  return [T.playing ? 'play' : '', T.playing ? 'Playing' : 'Ready'];
}
function renderCups() {
  for (let t = 0; t < NT; t++) {
    const e = cupEls[t]; if (!e) continue; const tr = tracks[t];
    e.card.classList.toggle('sel', t === sel);
    const [cls, txt] = trackState(t);
    e.state.className = 'state ' + cls; e.state.textContent = txt;
    const r = recOf(t);
    e.bRec.classList.toggle('on', !!(r && r.on));
    e.bRec.textContent = r ? (r.on ? '■ Out' : '✕ Cancel') : (tr.active.length ? '● Dub' : '● Rec');
    e.bMute.classList.toggle('on', tr.mute); e.bSolo.classList.toggle('on', tr.solo); e.bRev.classList.toggle('on', tr.rev);
    e.bUndo.disabled = !tr.undo.length && !r; e.bRedo.disabled = !tr.redo.length; e.bClr.disabled = !tr.active.length && !r;
    e.len.disabled = tr.active.length > 0;
    e.info.textContent = tr.active.length ? tr.active.length + (tr.active.length === 1 ? ' layer' : ' layers') : '';
  }
}

// cup drawing
const COL = { t: [] };
function readCols() {
  Object.assign(COL, { ink: css('--ink'), porcelain: css('--porcelain'), red: css('--red'), paper: css('--paper'), paper2: css('--paper-2'), muted: css('--muted'),
    espresso: css('--espresso'), crema: css('--crema'), cremaLt: css('--crema-lt'), t: TCOL.map(css) });
}
const PATTERNS = ['stripes', 'dots', 'waves', 'checks', 'rays', 'scallops'];
function drawCup(t, G) {
  const e = cupEls[t]; const cv = e.cv;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(cv.clientWidth * dpr); if (!W) return;
  if (cv.width !== W) { cv.width = W; cv.height = W; }
  const c = cv.getContext('2d'); c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, W, W);
  const tr = tracks[t], cx = W / 2, cy = W / 2, R = W / 2 - 4 * dpr;
  const ink = COL.ink, por = COL.porcelain, tc = COL.t[t], red = COL.red, paper2 = COL.paper2;
  const len = trackLen(t) || grid().L;
  const r = recOf(t);
  const muted = tr.active.length && (tr.mute || (tracks.some(x => x.solo) && !tr.solo));
  // saucer
  c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fillStyle = por; c.fill(); c.lineWidth = 2 * dpr; c.strokeStyle = ink; c.stroke();
  // art band
  const b0 = R * 0.87, b1 = R * 0.97;
  c.save(); c.beginPath(); c.arc(cx, cy, b1, 0, 7); c.arc(cx, cy, b0, 0, 7, true); c.clip();
  c.fillStyle = tc; c.globalAlpha = muted ? 0.35 : 1;
  const pat = PATTERNS[t];
  if (pat === 'stripes') { for (let k = 0; k < 48; k += 2) { c.beginPath(); c.moveTo(cx, cy); c.arc(cx, cy, b1, k / 48 * 6.283, (k + 1) / 48 * 6.283); c.fill(); } }
  else if (pat === 'dots') { for (let k = 0; k < 36; k++) { const a = k / 36 * 6.283; c.beginPath(); c.arc(cx + Math.cos(a) * (b0 + b1) / 2, cy + Math.sin(a) * (b0 + b1) / 2, (b1 - b0) * 0.34, 0, 7); c.fill(); } }
  else if (pat === 'waves') { c.beginPath(); for (let k = 0; k <= 360; k++) { const a = k / 360 * 6.283, rr = (b0 + b1) / 2 + Math.sin(a * 18) * (b1 - b0) * 0.32; c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); } c.lineWidth = (b1 - b0) * 0.38; c.strokeStyle = tc; c.stroke(); }
  else if (pat === 'checks') { for (let k = 0; k < 40; k++) { const a0 = k / 40 * 6.283, a1 = (k + 1) / 40 * 6.283, mid = (b0 + b1) / 2; c.beginPath(); if (k % 2) { c.arc(cx, cy, mid, a0, a1); c.arc(cx, cy, b0, a1, a0, true); } else { c.arc(cx, cy, b1, a0, a1); c.arc(cx, cy, mid, a1, a0, true); } c.fill(); } }
  else if (pat === 'rays') { c.fillRect(0, 0, W, W); c.fillStyle = por; for (let k = 0; k < 30; k++) { const a = k / 30 * 6.283; c.beginPath(); c.moveTo(cx + Math.cos(a) * b1, cy + Math.sin(a) * b1); c.lineTo(cx + Math.cos(a + 0.07) * b0, cy + Math.sin(a + 0.07) * b0); c.lineTo(cx + Math.cos(a - 0.07) * b0, cy + Math.sin(a - 0.07) * b0); c.fill(); } }
  else { for (let k = 0; k < 28; k++) { const a = k / 28 * 6.283; c.beginPath(); c.arc(cx + Math.cos(a) * b1, cy + Math.sin(a) * b1, (b1 - b0) * 0.85, 0, 7); c.fill(); } }
  c.restore(); c.globalAlpha = 1;
  c.beginPath(); c.arc(cx, cy, b0, 0, 7); c.lineWidth = 1 * dpr; c.strokeStyle = ink; c.stroke();
  // handle (east)
  const cupR = R * 0.56;
  c.save(); c.translate(cx, cy); c.beginPath();
  const hw = R * 0.11, hl = R * 0.2;
  c.roundRect ? c.roundRect(cupR - 4 * dpr, -hw / 2, hl, hw, hw / 2) : c.rect(cupR - 4 * dpr, -hw / 2, hl, hw);
  c.fillStyle = por; c.fill(); c.lineWidth = 2 * dpr; c.strokeStyle = ink; c.stroke(); c.restore();
  // waveform ring
  const w0 = R * 0.6, w1 = R * 0.84;
  if (tr.bins) {
    c.strokeStyle = muted ? COL.muted : ink; c.lineWidth = Math.max(1, 1.4 * dpr); c.beginPath();
    for (let k = 0; k < BINS; k++) {
      const a = (tr.rev ? -1 : 1) * 0 + k / BINS * 6.283 - Math.PI / 2;
      const amp = tr.bins[k]; if (amp < 0.02) continue;
      const rr = w0 + 2 * dpr + amp * (w1 - w0 - 2 * dpr);
      c.moveTo(cx + Math.cos(a) * (w0 + 2 * dpr), cy + Math.sin(a) * (w0 + 2 * dpr)); c.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
    }
    c.stroke();
  } else {
    c.setLineDash([2 * dpr, 5 * dpr]); c.beginPath(); c.arc(cx, cy, (w0 + w1) / 2, 0, 7); c.strokeStyle = COL.muted; c.lineWidth = 1 * dpr; c.stroke(); c.setLineDash([]);
  }
  // recording arc
  if (r && r.on && len > 0) {
    const covered = r.count * r.r0;
    const a0 = (((r.segStart % len) + len) % len) / len * 6.283 - Math.PI / 2;
    const a1 = a0 + Math.min(1, covered / len) * 6.283;
    c.beginPath(); c.arc(cx, cy, (w0 + w1) / 2, a0, a1); c.strokeStyle = red; c.lineWidth = (w1 - w0) * 0.7; c.globalAlpha = 0.35; c.stroke(); c.globalAlpha = 1;
    c.beginPath(); c.arc(cx, cy, w1 + 1 * dpr, a0, a1); c.lineWidth = 3 * dpr; c.stroke();
  }
  if (r && r.on && !loop.L) { // first free loop: growing spiral
    const k = (performance.now() / 1000) % 1;
    c.beginPath(); c.arc(cx, cy, (w0 + w1) / 2, -Math.PI / 2, -Math.PI / 2 + k * 6.283); c.strokeStyle = red; c.lineWidth = 4 * dpr; c.stroke();
  }
  // cup
  c.beginPath(); c.arc(cx, cy, cupR, 0, 7); c.fillStyle = por; c.fill(); c.lineWidth = 2.5 * dpr;
  c.strokeStyle = r && r.on ? red : ink; if (r && r.on) { c.shadowColor = red; c.shadowBlur = 14 * dpr; } c.stroke(); c.shadowBlur = 0;
  if (r && !r.on) { c.save(); c.setLineDash([6 * dpr, 6 * dpr]); c.lineDashOffset = -performance.now() / 30; c.beginPath(); c.arc(cx, cy, cupR + 4 * dpr, 0, 7); c.strokeStyle = red; c.lineWidth = 2 * dpr; c.stroke(); c.restore(); }
  const coffR = cupR * 0.86;
  const nl = tr.active.length;
  if (nl) {
    c.beginPath(); c.arc(cx, cy, coffR, 0, 7); c.fillStyle = COL.espresso; c.fill();
    const level = Math.min(1, 0.3 + nl * 0.12);
    const g = c.createRadialGradient(cx - coffR * 0.2, cy - coffR * 0.25, coffR * 0.05, cx, cy, coffR * level);
    g.addColorStop(0, COL.cremaLt); g.addColorStop(0.7, COL.crema); g.addColorStop(1, 'rgba(120,70,30,0)');
    c.beginPath(); c.arc(cx, cy, coffR * level, 0, 7); c.fillStyle = g; c.fill();
    // a ring per layer, like a cup filled in pours
    c.strokeStyle = 'rgba(43,26,18,.35)'; c.lineWidth = 1 * dpr;
    for (let k = 1; k <= Math.min(nl, 8); k++) { c.beginPath(); c.arc(cx, cy, coffR * (0.18 + 0.1 * k), 0, 7); c.stroke(); }
    c.fillStyle = '#2B1A12'; c.font = `700 ${Math.round(cupR * 0.42)}px "Courier Prime", monospace`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(String(nl), cx, cy + 1 * dpr);
  } else {
    c.beginPath(); c.arc(cx, cy, coffR, 0, 7); c.fillStyle = paper2; c.fill();
    c.fillStyle = COL.muted; c.font = `400 ${Math.round(cupR * 0.36)}px "Yesteryear", cursive`; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText(r ? (r.on ? 'pouring' : 'ready') : 'empty', cx, cy);
  }
  // playhead needle
  if (T.playing && G >= 0 && len > 0 && (nl || (r && r.on))) {
    let p = (G % len) / len; if (tr.rev) p = 1 - p;
    const a = p * 6.283 - Math.PI / 2;
    c.beginPath(); c.moveTo(cx + Math.cos(a) * cupR, cy + Math.sin(a) * cupR); c.lineTo(cx + Math.cos(a) * b0, cy + Math.sin(a) * b0);
    c.strokeStyle = red; c.lineWidth = 2.5 * dpr; c.stroke();
    c.beginPath(); c.arc(cx + Math.cos(a) * b0, cy + Math.sin(a) * b0, 4 * dpr, 0, 7); c.fillStyle = red; c.fill();
  }
  // bar ticks
  if (len > 0 && loop.L) {
    const bars = Math.max(1, Math.round(len / grid().bar));
    c.strokeStyle = ink; c.lineWidth = 1.5 * dpr;
    for (let k = 0; k < bars && bars <= 32; k++) { const a = k / bars * 6.283 - Math.PI / 2; c.beginPath(); c.moveTo(cx + Math.cos(a) * (w1 + 1 * dpr), cy + Math.sin(a) * (w1 + 1 * dpr)); c.lineTo(cx + Math.cos(a) * (b0 - 1 * dpr), cy + Math.sin(a) * (b0 - 1 * dpr)); c.stroke(); }
  }
  if (muted) { c.globalAlpha = 0.5; c.fillStyle = COL.paper; c.beginPath(); c.arc(cx, cy, R, 0, 7); c.fill(); c.globalAlpha = 1; }
}

// ---------------------------------------------------------------- deck
function renderDeck() {
  const r = recOf(sel), tr = tracks[sel];
  const mb = $('bMain');
  mb.classList.toggle('rec', !!(r && r.on)); mb.classList.toggle('armed', !!(r && !r.on));
  $('mainK').textContent = r ? (r.on ? 'Punch out' : 'Cancel') : (S.startOn === 'sound' ? 'Listen' : tr.active.length ? 'Overdub' : 'Record');
  const leadTxt = S.lead ? (S.lead % S.bpb === 0 ? (S.lead / S.bpb) + ' bar' + (S.lead / S.bpb > 1 ? 's' : '') : S.lead + ' beat' + (S.lead > 1 ? 's' : '')) : 'no';
  $('mainH').textContent = 'No.' + (sel + 1) + ' · ' + (S.startOn === 'sound' ? 'on sound' : S.lead ? leadTxt + ' in' : 'no lead');
  $('bPlay').innerHTML = T.playing ? ICON.stop : ICON.play; $('bPlay').classList.toggle('on', T.playing);
  $('bPlay').setAttribute('aria-label', T.playing ? 'Stop' : 'Play');
  const bpm = tempoNow();
  $('bpm').firstChild.textContent = bpm.toFixed(1);
  const segm = $('segMode');
  for (const b of segm.children) { b.disabled = !!loop.L; }
  $('bClick').classList.toggle('on', S.click);
  $('held').textContent = T.pendingR ? 'tempo ' + (T.pendingR * loop.baseTempo).toFixed(1) + ' after this take' : (T.ramp ? 'ramping → ' + (T.ramp.r1 * loop.baseTempo).toFixed(1) : (loop.L && Math.abs(T.r - 1) > 0.0005 ? 'recorded at ' + loop.baseTempo.toFixed(1) : ''));
}
function renderPos(G) {
  if (!loop.L) {
    if (T.playing && G < 0) { $('pos').textContent = 'COUNT ' + Math.ceil(-G / grid().beat); $('pos2').textContent = S.mode === 'free' ? 'first loop: play, then press again' : 'first loop starts at bar 1'; }
    else if (T.recs.some(r => r.on)) { $('pos').textContent = ((G / sr())).toFixed(1) + ' s'; $('pos2').textContent = 'first loop · press again to close it'; }
    else { $('pos').textContent = '— —'; $('pos2').textContent = S.mode === 'free' ? `free: your first take sets ${S.loopBars} bars` : `sync: ${S.loopBars} bars of ${S.bpb} at ${S.tempo.toFixed(1)}`; }
    $('posLbl').textContent = 'No loop yet';
    return;
  }
  const g = grid();
  if (G < 0) { $('pos').textContent = 'COUNT ' + Math.ceil(-G / g.beat); $('pos2').textContent = 'lead-in'; $('posLbl').textContent = 'Position'; return; }
  const pass = Math.floor(G / g.L) + 1, inL = G % g.L, bar = Math.floor(inL / g.bar) + 1, beat = Math.floor((inL % g.bar) / g.beat) + 1;
  $('pos').textContent = `${String(bar)}.${beat}`;
  $('posLbl').textContent = `Bar.beat of ${loop.loopBars}`;
  $('pos2').textContent = `pass ${pass} · ${(g.L / sr() / T.r).toFixed(2)} s loop`;
}

function meter(el, v) { const db = v > 0 ? 20 * Math.log10(v) : -90; const u = Math.max(0, Math.min(1, (db + 54) / 54)); el.style.width = (u * 100).toFixed(1) + '%'; el.classList.toggle('hot', v > 0.95); }

// countdown overlay
function renderCount(G) {
  const el = $('count');
  let show = null;
  for (const r of T.recs) {
    if (r.trigger) { show = { t: r.track, num: '♪', sub: 'Listening — recording begins on your first note' }; continue; }
    if (r.on) { const dt = (r.count / sr()); if (dt < 0.7) show = { t: r.track, num: 'REC', go: true, sub: 'recording' }; continue; }
    if (r.startG == null || !T.playing) continue;
    const g = grid(), left = r.startG - G;
    if (left > 0 && left <= Math.max(r.lead, 1) + 2) show = { t: r.track, num: String(Math.ceil(left / g.beat - 1e-6)), sub: 'punch in on the downbeat' };
  }
  if (!show || !S.bigCount) { el.classList.remove('on'); return; }
  el.classList.add('on');
  el.style.setProperty('--tc', `var(${TCOL[show.t]})`);
  $('cWho').textContent = tracks[show.t].name;
  const n = $('cNum'); n.textContent = show.num; n.classList.toggle('go', !!show.go);
  $('cSub').textContent = show.sub;
}

// ---------------------------------------------------------------- panes
const TABS = [['punch', 'Punch'], ['build', 'Build'], ['tempo', 'Tempo'], ['pedal', 'Pedal'], ['input', 'Input'], ['export', 'Export']];
function renderTabs() {
  const tabs = $('tabs'); tabs.innerHTML = '';
  for (const [k, l] of TABS) tabs.append(h('button', { class: S.tab === k ? 'on' : '', onclick: () => { S.tab = k; saveSoon(); renderTabs(); renderPanes(); } }, l));
}
function renderPanes() {
  const p = $('panes'); p.innerHTML = '';
  const pane = h('div', { class: 'pane on' });
  ({ punch: panePunch, build: paneBuild, tempo: paneTempo, pedal: panePedal, input: paneInput, export: paneExport })[S.tab](pane);
  p.append(pane);
}
const put = (p, ...kids) => p.append(...kids.filter(k => k != null && k !== false));
const row = (label, ...kids) => h('div', { class: 'row' }, h('label', null, label), ...kids);
function upd(key, v) { S[key] = v; saveSoon(); pushAll(); renderDeck(); }

function panePunch(p) {
  put(p, h('h2', null, 'Punch in, hands free'),
    h('p', null, 'Press Increase once. The cup counts you in, starts recording on the downbeat and stops by itself — no pedal needed.'),
    h('h3', null, 'Start'),
    row('Start on', seg([['count', 'Count-in'], ['sound', 'My first note']], S.startOn, v => { upd('startOn', v); renderPanes(); })),
    S.startOn === 'count' ? row('Count-in', seg([[0, 'None'], [1, '1'], [2, '2'], [4, '4'], [8, '8']], S.lead, v => upd('lead', v)), h('span', { class: 'note' }, 'beats')) : null,
    S.startOn === 'count' ? row('Punch in on', seg([['beat', 'Beat'], ['bar', 'Bar'], ['loop', 'Loop top']], S.quantIn, v => upd('quantIn', v))) : null,
    S.startOn === 'count' ? sw('Click the lead-in beats', 'leadClick') : null,
    S.startOn === 'sound' ? h('p', null, 'Press Increase and the cup listens. Recording starts the moment you play louder than the threshold below (with 10 ms kept from before, so the attack is there). The very first loop starts the transport on that note.') : null,
    sw('Big countdown on screen', 'bigCount'),
    h('h3', null, 'Punch out'),
    row('Stop after', seg([['pass', 'One pass'], ['bars', 'Bars'], ['layer', 'Passes'], ['silence', 'I stop'], ['manual', 'My press']], S.punchOut, v => { upd('punchOut', v); renderPanes(); })),
    S.punchOut === 'silence' ? row('Quiet for', sel_([[0.5, '½ second'], [1, '1 second'], [2, '2 seconds'], ['bar', '1 bar']], S.silHold, v => upd('silHold', v === 'bar' ? 'bar' : +v)), h('span', { class: 'note' }, 'then out on the next ' + (S.outQuant === 'loop' ? 'loop end' : S.outQuant === 'now' ? 'beat' : 'bar'))) : null,
    S.punchOut === 'silence' ? h('p', null, 'Play as long as you like; when you go quiet, the take ends on the grid. Every full loop pass becomes its own layer. (The very first Free loop still closes on your press.)') : null,
    S.punchOut === 'bars' ? row('Length', sel_([[1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']], S.outBars, v => upd('outBars', +v))) : null,
    S.punchOut === 'layer' ? row('Passes', sel_([[2, '2'], [3, '3'], [4, '4'], [6, '6'], [8, '8']], S.passes, v => upd('passes', +v)), h('span', { class: 'note' }, 'each pass becomes its own layer')) : null,
    S.punchOut === 'manual' ? h('p', null, 'Recording keeps going until you press again; every loop pass becomes a new layer you can undo on its own.') : null,
    row('Pressed out on', seg([['now', 'Now'], ['bar', 'Bar'], ['loop', 'Loop end']], S.outQuant, v => upd('outQuant', v))),
    h('h3', null, 'Sound threshold'),
    h('div', { class: 'thr' }, h('i', null, h('b', { id: 'thrLvl' }), h('u', { id: 'thrMark', style: `left:${((S.trigDb + 60) / 60 * 100).toFixed(1)}%` }))),
    row('Threshold', h('input', { type: 'range', min: -60, max: -6, value: S.trigDb, oninput: e => { upd('trigDb', +e.target.value); const m = $('thrMark'); if (m) m.style.left = ((S.trigDb + 60) / 60 * 100) + '%'; const v = $('thrV'); if (v) v.textContent = S.trigDb + ' dB'; } }), h('span', { class: 'note', id: 'thrV' }, S.trigDb + ' dB')),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill', onclick: measureRoom }, 'Set from the room')),
    h('p', null, 'The bar is your input right now; the mark is the threshold. Used by Start on my first note, Stop when I stop, and Gate below. Set from the room listens to 1½ seconds of quiet and puts the mark 12 dB above it.'),
    h('h3', null, 'Takes'),
    sw('Replace what is under the take (punch replace) instead of layering over it', 'replace', () => { renderDeck(); renderPanes(); }),
    sw(S.replace ? 'Gate: replace only where I play — the old part stays wherever the new take is quiet' : 'Gate: keep only where I play — silence between phrases (and the bleed in it) is left out', 'gate'),
    sw('After a take, move to the next empty cup', 'advance'),
    h('h3', null, 'This cup: No.' + (sel + 1) + ' ' + tracks[sel].name),
    row('Keep', sel_([[0, 'every layer'], [1, 'the last layer'], [2, 'the last 2'], [3, 'the last 3'], [4, 'the last 4'], [8, 'the last 8']], tracks[sel].keep, v => { tracks[sel].keep = +v; })),
    h('p', null, 'With a limit, each new layer pushes out the oldest (Undo brings it back). “The last layer” makes every pass replace the one before — record with My press or I stop and it keeps only your latest take. Add Fade for a decaying, ever-changing loop.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill red', onclick: () => retake() }, 'Retake last take (R)'), h('button', { class: 'pill', onclick: () => undo(sel) }, 'Undo on this cup')),
    h('p', null, 'Retake removes the last take on this cup and records the same stretch of the loop again on the next pass, counted in — one press to redo a flubbed part.'),
    h('h3', null, 'First loop'),
    row('Mode', seg([['sync', 'Sync'], ['free', 'Free']], S.mode, v => { upd('mode', v); renderPanes(); }, { })),
    h('p', null, S.mode === 'sync' ? 'Sync: the first loop is a set number of bars at the tempo above, with a count-in.' : 'Free: play, press to close the loop; its length sets the tempo for the bars below.'),
    row('Loop bars', sel_([[1, '1'], [2, '2'], [4, '4'], [8, '8'], [16, '16']], S.loopBars, v => upd('loopBars', +v)), h('span', { class: 'note' }, 'of'),
      sel_([[3, '3/4'], [4, '4/4'], [5, '5/4'], [6, '6/8'], [7, '7/8']], S.bpb, v => upd('bpb', +v))),
    loop.L ? h('p', null, `Loop locked: ${loop.loopBars} bars of ${loop.bpb}, recorded at ${loop.baseTempo.toFixed(1)} BPM. New session clears it.`) : null,
    h('div', { class: 'btnrow' }, h('button', { class: 'pill', onclick: () => confirmDlg('New session?', 'Every cup and the loop are cleared. Save first in Export if you want to keep them.', 'Clear everything', newSession) }, 'New session')));
  if (loop.L) for (const b of p.querySelectorAll('.seg')) if (b.querySelector('[data-v="sync"]')) for (const x of b.children) x.disabled = true;
}

function paneTempo(p) {
  const bpm = tempoNow();
  const tin = h('input', { type: 'number', step: 0.1, min: 30, max: 300, value: bpm.toFixed(1), onchange: e => setTempo(+e.target.value) });
  const rTo = h('input', { type: 'number', step: 0.5, min: 30, max: 300, value: (Math.round((bpm + 8) * 10) / 10).toFixed(1) });
  const rBars = sel_([[1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars'], [32, '32 bars']], 8, () => {});
  put(p, h('h2', null, 'Tempo moves'),
    h('div', { class: 'big-tempo' }, h('b', { id: 'bigBpm' }, bpm.toFixed(1)), h('span', null, 'BPM')),
    h('div', { class: 'btnrow' },
      ...[[-5, '−5'], [-1, '−1'], [-0.1, '−.1'], [0.1, '+.1'], [1, '+1'], [5, '+5']].map(([d, l]) => h('button', { class: 'pill', onclick: () => { setTempo(tempoNow() + d); renderPanes(); } }, l)),
      h('button', { class: 'pill', onclick: () => { setTempo(tempoNow() / 2); renderPanes(); } }, '½×'),
      h('button', { class: 'pill', onclick: () => { setTempo(tempoNow() * 2); renderPanes(); } }, '2×'),
      h('button', { class: 'pill', onclick: tap }, 'Tap')),
    row('Set', tin, loop.L ? h('button', { class: 'pill', onclick: () => { setTempo(loop.baseTempo); renderPanes(); } }, 'Back to ' + loop.baseTempo.toFixed(1)) : null),
    h('h3', null, 'When the tempo moves'),
    row('Loops', seg([[1, 'Keep pitch'], [0, 'Tape (pitch follows)']], S.stretch, v => upd('stretch', v))),
    h('p', null, 'Keep pitch time-stretches every layer (WSOLA grains), so a loop recorded at 92 still sits in key at 110. Tape speeds the loops up and down like a varispeed deck.'),
    h('h3', null, 'Ramp'),
    row('To', rTo, h('span', { class: 'note' }, 'BPM over'), rBars),
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill red', onclick: () => { if (!loop.L) return toast('Record a loop first'); send({ c: 'ramp', bpm: +rTo.value, bars: +rBars.value }); toast(`Ramping to ${(+rTo.value).toFixed(1)} from the next bar`); } }, 'Start ramp'),
      h('button', { class: 'pill', onclick: () => { send({ c: 'stopRamp' }); } }, 'Hold here'),
      loop.L ? h('button', { class: 'pill', onclick: () => send({ c: 'ramp', bpm: loop.baseTempo, bars: +rBars.value }) }, 'Ramp back') : null),
    h('p', null, 'Ramps begin on the next bar. Tempo changes wait while a take is recording, then apply as it ends, so every layer stays on the grid.'),
    h('h3', null, 'Click'),
    sw('Metronome on', 'click', renderDeck),
    row('Level', h('input', { type: 'range', min: 0, max: 1, step: 0.01, value: S.clickVol, oninput: e => upd('clickVol', +e.target.value) })));
}

function paneBuild(p) {
  const steps = h('div', { class: 'steps', id: 'steps' });
  const trackOpts = tracks.map((t, i) => [i, 'No.' + (i + 1) + ' ' + t.name]);
  S.recipe.forEach((st, i) => {
    const f = h('div', { class: 'f' });
    f.append(sel_(Object.entries(ACTIONS), st.a, v => { st.a = v; saveSoon(); renderPanes(); }));
    if (['rec', 'layer', 'replace', 'mute', 'unmute'].includes(st.a)) f.append(sel_(trackOpts, st.t || 0, v => { st.t = +v; saveSoon(); }));
    if (st.a === 'rec' || st.a === 'replace') f.append(sel_([[0, 'one pass'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']], st.bars || 0, v => { st.bars = +v; saveSoon(); }));
    if (st.a === 'layer') f.append(h('input', { type: 'number', min: 1, max: 16, value: st.passes || 2, onchange: e => { st.passes = +e.target.value; saveSoon(); } }), h('span', { class: 'note' }, 'passes'));
    if (st.a === 'wait') f.append(sel_([[1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']], st.bars || 4, v => { st.bars = +v; saveSoon(); }));
    if (st.a === 'tempo' || st.a === 'ramp') f.append(h('input', { type: 'number', step: 0.5, value: st.bpm || 0, onchange: e => { st.bpm = +e.target.value; saveSoon(); } }), h('span', { class: 'note' }, 'BPM ±'));
    if (st.a === 'ramp') f.append(h('span', { class: 'note' }, 'over'), sel_([[2, '2'], [4, '4'], [8, '8'], [16, '16']], st.bars || 8, v => { st.bars = +v; saveSoon(); }), h('span', { class: 'note' }, 'bars'));
    const x = h('div', { class: 'x' },
      h('button', { title: 'Up', onclick: () => { if (i) { [S.recipe[i - 1], S.recipe[i]] = [S.recipe[i], S.recipe[i - 1]]; saveSoon(); renderPanes(); } } }, '↑'),
      h('button', { title: 'Down', onclick: () => { if (i < S.recipe.length - 1) { [S.recipe[i + 1], S.recipe[i]] = [S.recipe[i], S.recipe[i + 1]]; saveSoon(); renderPanes(); } } }, '↓'),
      h('button', { title: 'Remove', onclick: () => { S.recipe.splice(i, 1); saveSoon(); renderPanes(); } }, '✕'));
    steps.append(h('div', { class: 'step', 'data-i': i }, h('span', { class: 'n' }, String(i + 1)), f, x));
  });
  const preset = sel_([['', 'Load a recipe…'], ...Object.keys(PRESETS).map(k => [k, k])], '', v => { if (v) { S.recipe = JSON.parse(JSON.stringify(PRESETS[v])); saveSoon(); renderPanes(); } });
  put(p, h('h2', null, 'Progressive build-up'),
    h('p', null, 'A recipe of takes and moves. Run it and each cup is armed in turn, counted in and punched in and out on the grid while you play.'),
    h('div', { class: 'runbox' },
      h('button', { class: 'pill red', id: 'bRun', onclick: () => build.running ? build.stop() : build.start() }, build.running ? '■ Stop build' : '▶ Run build'),
      h('span', { class: 'stat', id: 'buildStat' }, '')),
    steps,
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill', onclick: () => { S.recipe.push({ a: 'rec', t: Math.min(NT - 1, S.recipe.filter(s => s.a === 'rec').length), bars: 0 }); saveSoon(); renderPanes(); } }, '+ Step'),
      preset),
    h('h3', null, 'Arrange what you have'),
    h('p', null, 'Bring finished cups in or out on bar lines, for intros, drops and endings.'),
    row('Every', sel_([[1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars']], S.buildBars, v => { S.buildBars = +v; saveSoon(); })),
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill', onclick: () => quickBuild('up') }, 'Build up'),
      h('button', { class: 'pill', onclick: () => quickBuild('down') }, 'Break down'),
      h('button', { class: 'pill', onclick: () => quickBuild('drop') }, 'Drop'),
      h('button', { class: 'pill', onclick: () => quickBuild('all') }, 'All in')));
  renderBuild();
}
function renderBuild() {
  const b = $('bRun'); if (b) b.textContent = build.running ? '■ Stop build' : '▶ Run build';
}

// ---------------------------------------------------------------- pedals
const PACTIONS = [
  ['main', 'Increase (record / dub / out)'], ['play', 'Play / stop'], ['undo', 'Undo'], ['redo', 'Redo'],
  ['next', 'Next cup'], ['prev', 'Previous cup'], ['mute', 'Mute cup'], ['clear', 'Clear cup'],
  ['retake', 'Retake last take'], ['tap', 'Tap tempo'], ['tup', 'Tempo +1'], ['tdn', 'Tempo −1'], ['build', 'Run / stop build'],
];
const DEFAULT_BINDS = {
  main: [{ k: 'key', code: 'Space' }], play: [{ k: 'key', code: 'KeyP' }], undo: [{ k: 'key', code: 'Backspace' }], redo: [{ k: 'key', code: 'KeyY' }],
  next: [{ k: 'key', code: 'ArrowRight' }, { k: 'key', code: 'PageDown' }], prev: [{ k: 'key', code: 'ArrowLeft' }, { k: 'key', code: 'PageUp' }],
  mute: [{ k: 'key', code: 'KeyM' }], retake: [{ k: 'key', code: 'KeyR' }], clear: [{ k: 'key', code: 'Delete' }], tap: [{ k: 'key', code: 'KeyT' }],
  tup: [{ k: 'key', code: 'ArrowUp' }], tdn: [{ k: 'key', code: 'ArrowDown' }], build: [{ k: 'key', code: 'KeyB' }],
};
if (!S.bindings) S.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDS));
for (const a in DEFAULT_BINDS) if (!S.bindings[a]) S.bindings[a] = JSON.parse(JSON.stringify(DEFAULT_BINDS[a])); // actions added later
let learning = null, midiAccess = null;
const pressT = {};
function doAction(a) {
  switch (a) {
    case 'main': main(); break; case 'play': playStop(); break; case 'undo': undo(); break; case 'redo': redo(); break;
    case 'next': select((sel + 1) % NT); break; case 'prev': select((sel + NT - 1) % NT); break;
    case 'mute': tracks[sel].mute = !tracks[sel].mute; sync(sel); renderCups(); break;
    case 'clear': clearTrack(sel); break; case 'retake': retake(); break; case 'tap': tap(); break;
    case 'tup': setTempo(tempoNow() + 1); break; case 'tdn': setTempo(tempoNow() - 1); break;
    case 'build': build.running ? build.stop() : build.start(); break;
  }
}
const sameB = (a, b) => a.k === b.k && (a.k === 'key' ? a.code === b.code : a.k === 'pad' ? a.b === b.b : (a.type === b.type && a.num === b.num && a.ch === b.ch));
function findAction(b) { for (const a in S.bindings) if (S.bindings[a].some(x => sameB(x, b))) return a; return null; }
function pedalDown(b, id) {
  if (learning) {
    for (const a in S.bindings) S.bindings[a] = S.bindings[a].filter(x => !sameB(x, b));
    S.bindings[learning] = (S.bindings[learning] || []).concat([b]);
    learning = null; saveSoon(); if (S.tab === 'pedal') renderPanes(); toast('Pedal learned');
    return true;
  }
  const a = findAction(b); if (!a) return false;
  doAction(a);
  if (a === 'main' && S.holdUndo) { clearTimeout(pressT[id]); pressT[id] = setTimeout(() => { pressT[id] = null; undo(); toast('Held: undo'); }, 800); }
  flashBind(a);
  return true;
}
function pedalUp(id) { clearTimeout(pressT[id]); pressT[id] = null; }
function flashBind(a) { const el = document.querySelector(`.bind[data-a="${a}"]`); if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); } }
function bindName(b) {
  if (b.k === 'key') return b.code.replace(/^Key/, '').replace(/^Digit/, '').replace('Arrow', '↦ ').replace('↦ Right', '→').replace('↦ Left', '←').replace('↦ Up', '↑').replace('↦ Down', '↓');
  if (b.k === 'midi') return `MIDI ${b.type === 'cc' ? 'CC' : 'note'} ${b.num} ch${b.ch + 1}`;
  return 'Pad button ' + b.b;
}
document.addEventListener('keydown', e => {
  const tg = e.target;
  if (tg && (tg.tagName === 'INPUT' && tg.type !== 'checkbox' && tg.type !== 'range' || tg.tagName === 'TEXTAREA' || tg.tagName === 'SELECT')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === 'Escape' && $('scrim').classList.contains('on')) { closeDlg(); return; }
  if (/^Digit[1-6]$/.test(e.code) && !learning) { select(+e.code[5] - 1); e.preventDefault(); return; }
  if (e.repeat) { if (findAction({ k: 'key', code: e.code })) e.preventDefault(); return; }
  if (pedalDown({ k: 'key', code: e.code }, 'k' + e.code)) e.preventDefault();
});
document.addEventListener('keyup', e => { pedalUp('k' + e.code); if (e.code === 'Space' && findAction({ k: 'key', code: 'Space' })) e.preventDefault(); });
async function enableMidi() {
  if (!navigator.requestMIDIAccess) { toast('This browser has no Web MIDI — use Chrome or Edge, or a pedal that acts as a keyboard'); return; }
  try {
    midiAccess = await navigator.requestMIDIAccess();
    const hook = () => { for (const inp of midiAccess.inputs.values()) inp.onmidimessage = onMidi; if (S.tab === 'pedal') renderPanes(); };
    midiAccess.onstatechange = hook; hook();
    toast('MIDI on: ' + ([...midiAccess.inputs.values()].map(i => i.name).join(', ') || 'no devices yet'));
  } catch (e) { toast('MIDI was not allowed'); }
}
function onMidi(ev) {
  const [st, d1, d2] = ev.data; const type = st & 0xf0, ch = st & 15;
  if (type === 0x90 && d2 > 0) pedalDown({ k: 'midi', type: 'note', num: d1, ch }, 'n' + ch + '_' + d1);
  else if (type === 0x80 || (type === 0x90 && d2 === 0)) pedalUp('n' + ch + '_' + d1);
  else if (type === 0xb0) {
    const id = 'c' + ch + '_' + d1;
    if (d2 >= 64 && !pressT['on' + id]) { pressT['on' + id] = 1; pedalDown({ k: 'midi', type: 'cc', num: d1, ch }, id); }
    else if (d2 < 64 && pressT['on' + id]) { pressT['on' + id] = 0; pedalUp(id); }
  }
}
const padPrev = {};
function pollPads() {
  if (!navigator.getGamepads) return;
  for (const gp of navigator.getGamepads()) {
    if (!gp) continue;
    gp.buttons.forEach((b, i) => {
      const id = 'g' + gp.index + '_' + i, was = padPrev[id];
      if (b.pressed && !was) pedalDown({ k: 'pad', b: i }, id); else if (!b.pressed && was) pedalUp(id);
      padPrev[id] = b.pressed;
    });
  }
}
function panePedal(p) {
  const list = h('div', { class: 'binds' });
  for (const [a, label] of PACTIONS) {
    const bs = S.bindings[a] || [];
    const k = h('span', { class: 'k' }); bs.forEach(b => k.append(h('kbd', null, bindName(b))));
    if (!bs.length) k.append('—');
    list.append(h('div', { class: 'bind', 'data-a': a }, h('span', { class: 'a' }, label), k,
      h('span', null, h('button', { class: learning === a ? 'learning' : '', onclick: () => { learning = learning === a ? null : a; renderPanes(); } }, learning === a ? 'Press it…' : 'Learn'),
        ' ', h('button', { title: 'Remove bindings', onclick: () => { S.bindings[a] = []; saveSoon(); renderPanes(); } }, '✕'))));
  }
  const pads = navigator.getGamepads ? [...navigator.getGamepads()].filter(Boolean) : [];
  put(p, h('h2', null, 'Pedals'),
    h('p', null, 'Every function works from the screen and the keyboard. A USB foot switch adds hands: most act as a keyboard (Page Up/Down, arrows or a letter); MIDI foot controllers send notes or CCs; some show up as game pads. Press Learn, then tap the pedal.'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill' + (midiAccess ? ' on' : ''), onclick: enableMidi }, midiAccess ? 'MIDI on' : 'Enable MIDI'),
      h('span', { class: 'note' }, midiAccess ? ([...midiAccess.inputs.values()].map(i => i.name).join(', ') || 'no MIDI devices found') : ''),
      pads.length ? h('span', { class: 'note' }, 'Pads: ' + pads.map(g => g.id.slice(0, 24)).join(', ')) : null),
    list,
    sw('Hold Increase (pedal or key) for about a second to undo', 'holdUndo'),
    h('p', null, 'One pedal is enough: tap to record, tap to punch out, tap to overdub, hold to undo. Number keys 1–6 pick a cup.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill', onclick: () => { S.bindings = JSON.parse(JSON.stringify(DEFAULT_BINDS)); saveSoon(); renderPanes(); } }, 'Reset to defaults')));
}

// ---------------------------------------------------------------- input
async function fillDevices() {
  const s = $('devSel'); if (!s || !navigator.mediaDevices) return;
  try {
    const devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput');
    s.innerHTML = ''; s.append(h('option', { value: '' }, 'Default input'));
    devs.forEach((d, i) => { const o = h('option', { value: d.deviceId }, d.label || 'Input ' + (i + 1)); if (d.deviceId === S.deviceId) o.selected = true; s.append(o); });
  } catch (e) {}
}
let calibCb = null;
function calibDone(m) {
  if (m.hits < 3) { toast(`Calibration heard ${m.hits} of ${m.of} clicks — turn the speakers up, or set it by hand`); return; }
  S.latCalMs = Math.round(m.frames / sr() * 1000 * 10) / 10; S.latAuto = false; saveSoon(); pushAll();
  toast(`Round trip: ${S.latCalMs} ms — takes are moved back by that much`);
  if (S.tab === 'input') renderPanes();
}
function paneInput(p) {
  const devSel = h('select', { id: 'devSel', onchange: async e => { S.deviceId = e.target.value; saveSoon(); await openMic(true); } }, h('option', { value: '' }, 'Default input'));
  const ms = Math.round(latencyFrames() / sr() * 1000 * 10) / 10;
  put(p, h('h2', null, 'Input'),
    row('Source', seg([['mic', 'Microphone / interface'], ['test', 'Test band']], S.source, async v => { S.source = v; saveSoon(); pushAll(); if (v === 'mic') await openMic(true); else openMic(); renderPanes(); })),
    S.source === 'mic' ? row('Device', devSel, h('button', { class: 'pill', onclick: () => openMic(true) }, micSrc ? 'Reconnect' : 'Connect')) : null,
    S.source === 'mic' ? row('Channel', seg([[0, 'Stereo'], [1, 'Left (In 1)'], [2, 'Right (In 2)']], S.inCh, v => upd('inCh', v))) : null,
    S.source === 'test' ? row('Plays', sel_([[9, 'Full band'], [1, 'Beatbox'], [2, 'Bass'], [3, 'Keys'], [4, 'Lead'], [5, 'A 440 tone']], S.test, v => { upd('test', +v); })) : null,
    S.source === 'test' ? h('p', null, 'A built-in band that plays along with the grid, so you can try every feature without an instrument. Switch parts between takes to stack a song.') : null,
    row('Gain', h('input', { type: 'range', min: 0, max: 4, step: 0.01, value: S.inGain, oninput: e => upd('inGain', +e.target.value) })),
    sw('Hear the input through the speakers (use headphones)', 'monitor'),
    h('h3', null, 'Latency'),
    h('p', null, `Takes are moved back by ${ms} ms so they land where you played them, not where the sound arrived.`),
    sw('Estimate it from the audio device', 'latAuto', () => renderPanes()),
    row('Fine offset', h('input', { type: 'range', min: -50, max: 50, step: 0.5, value: S.latOffsetMs, oninput: e => { upd('latOffsetMs', +e.target.value); } }), h('span', { class: 'note' }, S.latOffsetMs + ' ms')),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill', onclick: async () => {
      S.source = 'mic'; await openMic(); send({ c: 'calibrate' }); toast('Calibrating: six clicks from the speakers, mic listening — keep quiet');
    } }, 'Calibrate with speakers + mic')),
    S.latCalMs != null ? h('p', null, `Measured round trip: ${S.latCalMs} ms${S.latAuto ? ' (not in use while estimating)' : ''}.`) : null,
    h('h3', null, 'Output'),
    row('Master', h('input', { type: 'range', min: 0, max: 1.2, step: 0.01, value: S.master, oninput: e => upd('master', +e.target.value) })));
  fillDevices();
}

// ---------------------------------------------------------------- export
const cap = { on: false, chunks: [], frames: 0, t0: 0 };
async function toggleCapture() {
  await ensureAudio();
  if (!cap.on) { cap.on = true; cap.chunks = []; cap.frames = 0; cap.t0 = Date.now(); send({ c: 'capture', on: true }); toast('Recording your set — press ● Set again to stop and save'); }
  else { cap.on = false; send({ c: 'capture', on: false }); }
  $('bSet').classList.toggle('on', cap.on);
}
function finishCapture() {
  const n = cap.frames; if (!n) return;
  const L = new Float32Array(n), R = new Float32Array(n); let o = 0;
  for (const [a, b] of cap.chunks) { L.set(a, o); R.set(b, o); o += a.length; }
  cap.chunks = [];
  download(wav([L, R], sr(), 24), `Increaser set ${stamp()}.wav`);
}
const stamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())} ${z(d.getHours())}-${z(d.getMinutes())}`; };
function wav(chs, rate, bits) {
  const n = chs[0].length, nc = chs.length, bps = bits / 8, size = 44 + n * nc * bps;
  const buf = new ArrayBuffer(size), v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, size - 8, true); ws(8, 'WAVE'); ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, rate, true); v.setUint32(28, rate * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  ws(36, 'data'); v.setUint32(40, n * nc * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) {
    let x = Math.max(-1, Math.min(1, chs[c][i]));
    if (bits === 16) { v.setInt16(o, Math.round(x * 32767), true); o += 2; }
    else { const q = Math.round(x * 8388607); v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255); o += 3; }
  }
  return new Blob([buf], { type: 'audio/wav' });
}
function download(blob, name) {
  const a = h('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}
// zip (stored, no compression)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = u => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
async function zip(files) {
  const parts = [], cd = []; let off = 0;
  for (const f of files) {
    const data = f.data instanceof Blob ? new Uint8Array(await f.data.arrayBuffer()) : f.data instanceof Uint8Array ? f.data : new TextEncoder().encode(f.data);
    const name = new TextEncoder().encode(f.name), crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(8, 0, true); lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, off, true);
    cd.push(ch.buffer, name);
    off += 30 + name.length + data.length;
  }
  const cdSize = cd.reduce((s, x) => s + (x.byteLength || x.length), 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cd, end.buffer], { type: 'application/zip' });
}
function unzip(buf) {
  const v = new DataView(buf), out = {}; let o = 0;
  while (o + 30 <= buf.byteLength && v.getUint32(o, true) === 0x04034b50) {
    const size = v.getUint32(o + 18, true), nl = v.getUint16(o + 26, true), xl = v.getUint16(o + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, o + 30, nl));
    out[name] = buf.slice(o + 30 + nl + xl, o + 30 + nl + xl + size); o += 30 + nl + xl + size;
  }
  return out;
}

function renderOffline(passes, only) {
  const rate = sr(), E = new Engine(rate);
  E.cmd({ c: 'defineLoop', L: loop.L, baseTempo: loop.baseTempo, loopBars: loop.loopBars, bpb: loop.bpb, r: T.r || 1 });
  E.cmd({ c: 'set', stretch: S.stretch, master: S.master, latency: 0 });
  for (const lay of layers.values()) E.cmd({ c: 'addLayer', id: lay.id, track: lay.track, Lb: lay.Lb, Rb: lay.Rb, n: lay.n, s: lay.s, rate: lay.rate, replace: lay.replace, gate: lay.gate || 0 });
  let longest = loop.L;
  tracks.forEach((tr, t) => {
    const on = only == null || only === t;
    E.cmd({ c: 'setTrack', track: t, active: on ? tr.active.slice() : [], vol: tr.vol, pan: tr.pan, mute: only == null ? tr.mute : false, solo: only == null ? tr.solo : false, filt: tr.filt, fade: tr.fade, rev: tr.rev, lenBars: tr.lenBars });
    if (tr.active.length) longest = Math.max(longest, trackLen(t));
  });
  for (const tr of E.tracks) tr.gv = tr.vol;
  for (const lay of E.layers.values()) lay.g = 1;
  E.cmd({ c: 'play', G: 0 });
  const n = Math.ceil(passes * longest / (T.r || 1)), Lo = new Float32Array(n), Ro = new Float32Array(n), B = 512;
  const bl = new Float32Array(B), br = new Float32Array(B);
  for (let o = 0; o < n; o += B) { const k = Math.min(B, n - o); E.process(null, null, bl, br, k); Lo.set(bl.subarray(0, k), o); Ro.set(br.subarray(0, k), o); E.out = []; }
  return [Lo, Ro];
}
async function exportMix(passes, bits) {
  if (!loop.L) return toast('Nothing recorded yet');
  toast('Rendering…'); await new Promise(r => setTimeout(r, 30));
  download(wav(renderOffline(passes), sr(), bits), `Increaser loop mix ${stamp()}.wav`);
}
async function exportStems(passes, bits) {
  if (!loop.L) return toast('Nothing recorded yet');
  toast('Rendering stems…'); await new Promise(r => setTimeout(r, 30));
  const files = [];
  tracks.forEach((tr, t) => { if (tr.active.length) files.push({ name: `${t + 1} ${tr.name}.wav`, data: wav(renderOffline(passes, t), sr(), bits) }); });
  download(await zip(files), `Increaser stems ${stamp()}.zip`);
}
async function saveSession() {
  if (!loop.L) return toast('Nothing to save yet');
  const used = new Set(); tracks.forEach(tr => tr.active.forEach(i => used.add(i)));
  const meta = { app: 'The Increaser', v: 1, sr: sr(), loop: Object.assign({}, loop), tempo: tempoNow(), stretch: S.stretch,
    tracks: tracks.map(t => ({ name: t.name, keep: t.keep, vol: t.vol, pan: t.pan, filt: t.filt, fade: t.fade, mute: t.mute, solo: t.solo, rev: t.rev, lenBars: t.lenBars, active: t.active.slice() })),
    layers: [...used].map(id => { const l = layers.get(id); return { id, track: l.track, n: l.n, s: l.s, rate: l.rate, replace: l.replace, gate: l.gate || 0 }; }) };
  const files = [{ name: 'session.json', data: JSON.stringify(meta, null, 1) }];
  for (const id of used) { const l = layers.get(id); const u = new Float32Array(l.n * 2); u.set(l.Lb, 0); u.set(l.Rb, l.n); files.push({ name: `layers/${id}.f32`, data: new Uint8Array(u.buffer) }); }
  download(await zip(files), `Increaser session ${stamp()}.increaser`);
}
async function openSession(file) {
  await ensureAudio();
  const ent = unzip(await file.arrayBuffer());
  if (!ent['session.json']) return toast('That is not an Increaser session');
  const meta = JSON.parse(new TextDecoder().decode(ent['session.json']));
  newSession();
  const k = sr() / meta.sr; // resample positions if the device rate differs
  if (Math.abs(k - 1) > 1e-6) toast('Session was saved at ' + meta.sr + ' Hz; it plays back with a small pitch change at ' + sr() + ' Hz');
  Object.assign(loop, meta.loop); loop.L = meta.loop.L * k;
  send({ c: 'defineLoop', L: loop.L, baseTempo: loop.baseTempo, loopBars: loop.loopBars, bpb: loop.bpb });
  S.stretch = meta.stretch; pushAll();
  for (const m of meta.layers) {
    const u = new Float32Array(ent[`layers/${m.id}.f32`]);
    const lay = { id: m.id, track: m.track, n: m.n, s: m.s * k, rate: m.rate, replace: m.replace, gate: m.gate || 0, Lb: u.slice(0, m.n), Rb: u.slice(m.n) };
    layers.set(m.id, lay);
    send({ c: 'addLayer', id: m.id, track: m.track, Lb: lay.Lb.slice(), Rb: lay.Rb.slice(), n: m.n, s: lay.s, rate: m.rate, replace: m.replace, gate: lay.gate });
  }
  meta.tracks.forEach((mt, t) => { Object.assign(tracks[t], mt, { undo: mt.active.map(id => ({ k: 'add', id })), redo: [] }); sync(t); });
  layers.forEach(l => layerBins(l)); for (let t = 0; t < NT; t++) trackBins(t);
  send({ c: 'tempo', bpm: meta.tempo });
  buildCups(); renderAll(); toast('Session opened — press Play');
}
// ---------------------------------------------------------------- send to DAWters and Son
// On the web this opens DAWters at #receive and posts the stems once it says it is ready (DAWters only
// listens to the suite's own sites and localhost). Opened from a file, or if DAWters doesn't answer, it
// saves a .dawsuite.json for DAWters' File → Import from the suite instead.
const DAWTERS_URL = 'https://dawters-and-son.github.io/dawters-and-son/app/';
function b64(f) { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); }
function suitePayload(passes) {
  const list = [];
  tracks.forEach((tr, t) => { if (tr.active.length) { const [L, R] = renderOffline(passes, t); list.push({ name: tr.name, audio: { sr: sr(), ch: [b64(L), b64(R)] } }); } });
  return { type: 'dawters-send', kind: 'stems', app: 'The Increaser', name: 'Increaser loops', bpm: Math.round(tempoNow() * 100) / 100, bpb: loop.bpb, tracks: list };
}
async function sendToDawters(passes) {
  if (!loop.L || !tracks.some(t => t.active.length)) return toast('Record a loop first');
  const web = /^https?:$/.test(location.protocol);
  let win = null, url = null;
  if (web) {
    url = /\/increaser\/?(index\.html)?$/.test(location.pathname) ? new URL('../app/', location.href).href : DAWTERS_URL;
    win = window.open(url + '#receive', 'dawters'); // opened now, while the click still counts as a gesture
  }
  toast('Rendering the cups for DAWters…'); await new Promise(r => setTimeout(r, 30));
  const payload = suitePayload(passes);
  const saveFile = why => { download(new Blob([JSON.stringify(payload)], { type: 'application/json' }), `Increaser loops ${stamp()}.dawsuite.json`); toast((why ? why + ' — ' : '') + 'saved a .dawsuite.json: open DAWters and use File → Import from the suite', 6000); };
  if (!win) return saveFile(web ? 'Pop-up blocked' : '');
  const origin = new URL(url).origin;
  let done = false;
  const onMsg = e => {
    if (e.source !== win) return;
    if (e.data === 'dawters-ready') { try { win.postMessage(payload, origin); } catch (er) { finish(false); } }
    else if (e.data && e.data.type === 'dawters-got') finish(!!e.data.ok);
  };
  const finish = ok => { if (done) return; done = true; window.removeEventListener('message', onMsg); clearTimeout(tm);
    if (ok) toast(`${payload.tracks.length} cup${payload.tracks.length === 1 ? '' : 's'} sent to DAWters as tracks`); else saveFile('DAWters did not take them'); };
  const tm = setTimeout(() => finish(false), 45000);
  window.addEventListener('message', onMsg);
}

function paneExport(p) {
  let passes = 2, bits = 24;
  const file = h('input', { type: 'file', accept: '.increaser,.zip', style: 'display:none', onchange: e => e.target.files[0] && openSession(e.target.files[0]) });
  put(p, h('h2', null, 'Take it home'),
    h('h3', null, 'Record your set'),
    h('p', null, 'Captures everything you hear (loops plus live input when monitoring), as it happens, to a 24-bit WAV.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill red', onclick: toggleCapture }, cap.on ? '■ Stop and save' : '● Record set')),
    h('h3', null, 'Bounce the loops'),
    row('Length', sel_([[1, '1 pass'], [2, '2 passes'], [4, '4 passes'], [8, '8 passes']], 2, v => passes = +v)),
    row('Format', sel_([[24, 'WAV 24-bit'], [16, 'WAV 16-bit']], 24, v => bits = +v)),
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill', onclick: () => exportMix(passes, bits) }, 'Loop mix'),
      h('button', { class: 'pill', onclick: () => exportStems(passes, bits) }, 'Stems (zip)')),
    h('p', null, 'Stems are the same length and start on bar 1, ready to drop into DAWters and Son.'),
    h('h3', null, 'The suite'),
    h('p', null, 'Send every cup to DAWters and Son as its own track, lined up from bar 1 at this tempo, to record, mix and master over.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill red', onclick: () => sendToDawters(passes) }, 'Send to DAWters')),
    h('h3', null, 'Session'),
    h('div', { class: 'btnrow' },
      h('button', { class: 'pill', onclick: saveSession }, 'Save session'),
      h('button', { class: 'pill', onclick: () => file.click() }, 'Open session'), file));
}

// ---------------------------------------------------------------- dialogs
let toastT;
function toast(msg, ms = 2600) { const t = $('toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), ms); }
function openDlg(...kids) { const d = $('dlg'); d.innerHTML = ''; d.append(...kids); $('scrim').classList.add('on'); }
function closeDlg() { $('scrim').classList.remove('on'); }
$('scrim').addEventListener('click', e => { if (e.target === $('scrim')) closeDlg(); });
function confirmDlg(title, text, yes, fn) {
  openDlg(h('h2', null, title), h('p', null, text), h('div', { class: 'btnrow' }, h('button', { class: 'pill', onclick: closeDlg }, 'Keep'), h('button', { class: 'pill red', onclick: () => { closeDlg(); fn(); } }, yes)));
}
function help() {
  openDlg(h('h2', null, 'How the Increaser pours'),
    h('p', null, 'Six cups, each a loop track. The ring around a cup is its sound, the red needle is the playhead, and the cup fills a little more with every layer.'),
    h('ul', null,
      h('li', null, h('b', null, 'Increase'), ' (Space, or one pedal) does the next sensible thing on the selected cup: record, punch out, overdub. Hold it to undo.'),
      h('li', null, h('b', null, 'Hands free: '), 'set a lead-in and a punch-out in Punch. Press once; the count-in clicks, the take starts on the downbeat and stops by itself.'),
      h('li', null, h('b', null, 'By sound: '), 'Start on my first note records the moment you play over the threshold; Stop after › I stop ends the take on the grid when you go quiet; Gate keeps (or replaces) only the parts where you played.'),
      h('li', null, h('b', null, 'Fixing a take: '), 'R (or a pedal) is Retake — it removes the last take on the cup and records the same spot again. Keep › the last layer makes each pass replace the one before.'),
      h('li', null, h('b', null, 'First loop: '), 'Sync records a set number of bars at a set tempo. Free lets you play, then press again — its length sets the tempo. Free can also start on your first note.'),
      h('li', null, h('b', null, 'Build: '), 'a recipe of takes, mutes, waits and tempo ramps that runs on the grid, so a whole song can stack up without touching anything.'),
      h('li', null, h('b', null, 'Tempo: '), 'nudge, tap, halve, double or ramp the tempo while the loops play; they keep their pitch (or follow it, tape style).'),
      h('li', null, h('b', null, 'Pedals: '), 'USB foot switches (keyboard, MIDI or game pad) are learned in Pedal.'),
      h('li', null, h('b', null, 'No instrument handy? '), 'Input › Test band plays along with the grid.')),
    h('p', null, 'Keys: Space Increase · P play/stop · Backspace undo · Y redo · R retake · ←/→ cup · 1–6 pick a cup · M mute · Delete clear · T tap · ↑/↓ tempo · B build.'),
    h('p', null, 'The Increaser is free software (GPL-3.0-or-later) in the DAWters and Son suite, with DAWters (record, mix, master), Esperanza’s Drum Kit (beats) and Eleosynth (synth and pedals). Export › Send to DAWters puts every cup on its own track there. It makes no network requests.'),
    h('div', { class: 'btnrow' }, h('button', { class: 'pill red', onclick: closeDlg }, 'Pour')));
}

// ---------------------------------------------------------------- deck wiring
function wireDeck() {
  $('bPlay').onclick = playStop;
  $('bMain').onclick = () => main();
  $('bUndo').innerHTML = ICON.undo; $('bUndo').onclick = () => undo();
  $('bRedo').innerHTML = ICON.redo; $('bRedo').onclick = () => redo();
  $('tUp').onclick = () => setTempo(tempoNow() + 1);
  $('tDn').onclick = () => setTempo(tempoNow() - 1);
  $('tTap').onclick = tap;
  $('bClick').onclick = () => { S.click = !S.click; saveSoon(); pushAll(); renderDeck(); };
  $('bSet').onclick = toggleCapture;
  $('bHelp').onclick = help;
  const bt = $('bTheme');
  const applyTheme = () => { if (S.theme) document.documentElement.setAttribute('data-theme', S.theme); else document.documentElement.removeAttribute('data-theme');
    const dark = S.theme === 'dark' || (!S.theme && matchMedia('(prefers-color-scheme: dark)').matches); bt.textContent = dark ? 'Daytime' : 'Late show'; readCols(); };
  bt.onclick = () => { const dark = S.theme === 'dark' || (!S.theme && matchMedia('(prefers-color-scheme: dark)').matches); S.theme = dark ? 'light' : 'dark'; saveSoon(); applyTheme(); };
  applyTheme();
  const sm = $('segMode');
  sm.replaceWith(Object.assign(seg([['sync', 'Sync'], ['free', 'Free']], S.mode, v => { upd('mode', v); if (S.tab === 'punch') renderPanes(); }), { id: 'segMode' }));
  // tempo drag
  const bpm = $('bpm'); let y0 = 0, b0 = 0, drag = false;
  bpm.addEventListener('pointerdown', e => { bpm.setPointerCapture(e.pointerId); y0 = e.clientY; b0 = tempoNow(); drag = false; });
  bpm.addEventListener('pointermove', e => { if (!bpm.hasPointerCapture(e.pointerId)) return; const d = (y0 - e.clientY) / (e.shiftKey ? 40 : 4); if (Math.abs(d) > 0.5) drag = true; if (drag) setTempo(b0 + d); });
  bpm.addEventListener('wheel', e => { e.preventDefault(); setTempo(tempoNow() - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1)); }, { passive: false });
  bpm.addEventListener('dblclick', () => { const v = prompt('Tempo (BPM)', tempoNow().toFixed(1)); if (v && +v > 0) setTempo(+v); });
}
function renderAll() { renderDeck(); renderCups(); renderTabs(); renderPanes(); }

const room = { until: 0, max: 0 };
async function measureRoom() {
  await ensureAudio(); if (!(await openMic())) return;
  room.max = 0; room.until = performance.now() + 1500; toast('Listening to the room — stay quiet for a moment');
}
// ---------------------------------------------------------------- frame loop
let lastRecSig = '';
function frame() {
  const G = Gnow();
  for (let t = 0; t < NT; t++) drawCup(t, G);
  renderPos(G); renderCount(G);
  meter($('mIn'), T.inPeak || 0); meter($('mOut'), T.mPeak || 0);
  const tl = $('thrLvl');
  if (tl) { const db = T.inPeak > 0 ? 20 * Math.log10(T.inPeak) : -90; tl.style.width = Math.max(0, Math.min(100, (db + 60) / 60 * 100)).toFixed(1) + '%'; tl.classList.toggle('hot', db > S.trigDb); }
  if (room.until) {
    room.max = Math.max(room.max, T.inPeak || 0);
    if (performance.now() > room.until) {
      room.until = 0; const db = room.max > 0 ? 20 * Math.log10(room.max) : -80;
      S.trigDb = Math.round(Math.max(-60, Math.min(-6, db + 12))); saveSoon(); pushAll();
      toast(`Room is at ${db.toFixed(0)} dB — threshold set to ${S.trigDb} dB`); if (S.tab === 'punch') renderPanes();
    }
  }
  const sig = T.recs.map(r => r.track + ':' + r.on + ':' + (r.trigger ? 1 : 0)).join(',') + '|' + T.playing + '|' + (T.pendingR || 0) + '|' + (T.ramp ? 1 : 0) + '|' + T.r.toFixed(4);
  if (sig !== lastRecSig) { lastRecSig = sig; renderCups(); renderDeck(); }
  if (build.running) {
    const cur = build.current();
    document.querySelectorAll('.step').forEach(el => { const i = +el.dataset.i; el.classList.toggle('now', i === cur); el.classList.toggle('done', cur > i || (!build.running)); });
    const st = $('buildStat'); if (st) st.textContent = cur >= 0 ? `step ${cur + 1} of ${S.recipe.length}` : (build.waitFree ? 'play the first loop, press to close it' : 'counting in…');
  } else { const st = $('buildStat'); if (st && st.textContent) { st.textContent = ''; document.querySelectorAll('.step').forEach(el => el.classList.remove('now', 'done')); } }
  if (S.tab === 'tempo') { const b = $('bigBpm'); if (b) b.textContent = tempoNow().toFixed(1); }
  pollPads();
  requestAnimationFrame(frame);
}

// first gesture starts audio (browsers require it)
const kick = () => { ensureAudio().catch(() => {}); window.removeEventListener('pointerdown', kick); window.removeEventListener('keydown', kick); };
window.addEventListener('pointerdown', kick); window.addEventListener('keydown', kick);
window.addEventListener('beforeunload', e => { if (layers.size) { e.preventDefault(); e.returnValue = ''; } });

wireDeck(); buildCups(); renderAll();
requestAnimationFrame(frame);
if (!localStorage.getItem('increaser.seen')) { try { localStorage.setItem('increaser.seen', '1'); } catch (e) {} setTimeout(help, 400); }
window.__inc = { retake, suitePayload, sendToDawters, S, tracks, layers, loop, get T() { return T; }, build, main, record, undo, redo, setTempo, playStop, send, renderOffline, quickBuild, Gnow, select, newSession };
})();
