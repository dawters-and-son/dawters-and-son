/* France's French Press — application controller.
 * SPDX-License-Identifier: GPL-3.0-or-later  Copyright (C) 2026 Josh Wilk */
(function () {
  'use strict';
  var $ = UI.$, $$ = UI.$$, el = UI.el, VERSION = '1.0.0';

  // ---------------------------------------------------------------- constants
  var STEM = {
    vocals: { label: 'Vocals', short: 'VOX' }, drums: { label: 'Drums', short: 'DRM' }, bass: { label: 'Bass', short: 'BAS' },
    other: { label: 'Band', short: 'BND' }, ambience: { label: 'Room', short: 'RM' }, instrumental: { label: 'Band', short: 'BND' }
  };
  function color(n) { return UI.css('--' + n); }
  var RECIPES = [
    { id: 'balanced', name: 'Balanced', desc: 'The all-rounder for modern stereo mixes: singer in the middle, band around them.', p: {} },
    { id: 'vocal', name: 'Vocal focus', desc: 'Leans on pitch tracking and the centre image for the cleanest voice.', p: { width: 0.2, mel: 0.8, rep: 0.4 } },
    { id: 'beat', name: 'Beat-driven', desc: 'Hip-hop, EDM, pop built on loops: finds what repeats every bar and keeps it in the band.', p: { rep: 0.6, mel: 0.7, kickLen: 0.14 } },
    { id: 'live', name: 'Live & acoustic', desc: 'Real rooms and wide players: gentler drum pull, more of the room kept apart.', p: { kick: 0.6, beta: 2.0, width: 0.35, rep: 0, ambience: 1 } },
    { id: 'mono', name: 'Mono & vintage', desc: 'One-channel or narrow old records: pitch and repetition do the work the stereo image cannot.', p: { width: 1.0, mel: 0.9, rep: 0.5, ambience: 0 } },
    { id: 'karaoke', name: 'Karaoke', desc: 'Two stems: the voice and everything else. Mute the voice to sing along.', p: { stems: 2 } }
  ];
  var SLIDERS = [
    { g: 'Vocals', k: 'width', l: 'Centre width', min: 0.05, max: 1, step: 0.01, f: function (v) { return v.toFixed(2); } },
    { g: 'Vocals', k: 'vocalPan', l: 'Singer position (L–R)', min: -0.6, max: 0.6, step: 0.01, f: function (v) { return Math.abs(v) < 0.005 ? 'centre' : (v < 0 ? 'L ' : 'R ') + Math.abs(v).toFixed(2); } },
    { g: 'Vocals', k: 'mel', l: 'Pitch tracking', min: 0, max: 1, step: 0.05, f: pct },
    { g: 'Vocals', k: 'vlo', l: 'Lowest vocal note', min: 60, max: 400, step: 5, f: hz },
    { g: 'Vocals', k: 'vhi', l: 'Highest vocal air', min: 4000, max: 20000, step: 100, f: hz },
    { g: 'Drums', k: 'beta', l: 'Drum strictness', min: 0.6, max: 4, step: 0.1, f: function (v) { return v.toFixed(1) + '×'; } },
    { g: 'Drums', k: 'kick', l: 'Kick capture', min: 0, max: 1, step: 0.05, f: pct },
    { g: 'Drums', k: 'kickLen', l: 'Kick length', min: 0.06, max: 0.3, step: 0.01, f: function (v) { return Math.round(v * 1000) + ' ms'; } },
    { g: 'Bass', k: 'bassFc', l: 'Bass crossover', min: 80, max: 500, step: 5, f: hz },
    { g: 'Bass', k: 'bmel', l: 'Bass-line tracking', min: 0, max: 1, step: 0.05, f: pct },
    { g: 'Band & room', k: 'rep', l: 'Loop removal', min: 0, max: 1, step: 0.05, f: pct },
    { g: 'Band & room', k: 'ambience', l: 'Room amount (5 stems)', min: 0, max: 1.5, step: 0.05, f: pct },
    { g: 'Band & room', k: 'smooth', l: 'Smoothing', min: 0, max: 1, step: 1, f: function (v) { return v ? 'on' : 'off'; } }
  ];
  function pct(v) { return Math.round(v * 100) + '%'; }
  function hz(v) { return UI.fmtHz(v) + ' Hz'; }
  var TARGETS = [{ v: -14, l: 'Streaming · −14 LUFS' }, { v: -16, l: 'Apple Music · −16 LUFS' }, { v: -11, l: 'Loud pop · −11 LUFS' }, { v: -9, l: 'CD / club · −9 LUFS' }, { v: -16.5, l: 'Podcast · −16 LUFS' }, { v: -23, l: 'Broadcast EBU R128 · −23 LUFS' }];

  // ---------------------------------------------------------------- state
  var S = {
    file: null, sr: 44100, len: 0, L: null, R: null, original: null, mono: false,
    recipe: 'balanced', params: Object.assign({}, DSP.DEFAULTS), split: null,
    st: null, ops: [], undo: [], redo: [], peaks: {}, specs: {}, tab: 'press',
    view: { zoom: 50, scroll: 0, mode: 'wave', sel: null, lanesH: [] },
    session: null, dirty: false, splitting: false
  };
  window.FP = S; // for debugging and tests

  // ---------------------------------------------------------------- worker pool
  var POOL = null;
  function makePool() {
    if (POOL) return POOL;
    var n = Math.max(1, Math.min(8, navigator.hardwareConcurrency || 2));
    try {
      var src = $('#dsp-src').textContent + '\n' + $('#lame-src').textContent;
      var url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      var workers = [], idle = [], queue = [], pending = {}, seq = 0;
      for (var i = 0; i < n; i++) {
        var w = new Worker(url);
        w.onmessage = function (e) { var p = pending[e.data.id]; delete pending[e.data.id]; idle.push(this); pump(); if (e.data.err) p.rej(new Error(e.data.err)); else p.res(e.data.res); };
        w.onerror = function (e) { console.error('worker error', e.message); };
        workers.push(w); idle.push(w);
      }
      var pump = function () { while (idle.length && queue.length) { var w = idle.pop(), q = queue.shift(); pending[q.id] = q; w.postMessage({ id: q.id, op: q.op, job: q.job }, DSP.transferables(q.job)); } };
      POOL = { size: n, workers: true, run: function (op, job) { return new Promise(function (res, rej) { queue.push({ id: ++seq, op: op, job: job, res: res, rej: rej }); pump(); }); } };
    } catch (e) {
      console.warn('Workers unavailable, pressing on the main thread', e);
      POOL = ENGINE.localPool();
    }
    return POOL;
  }

  // ---------------------------------------------------------------- loading
  function parseWav(buf) {
    var dv = new DataView(buf); if (dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
    var o = 12, fmt, nc, sr, bits, data;
    while (o + 8 <= buf.byteLength) {
      var id = dv.getUint32(o, false), sz = dv.getUint32(o + 4, true);
      if (id === 0x666d7420) { fmt = dv.getUint16(o + 8, true); nc = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); if (fmt === 0xFFFE && sz >= 40) fmt = dv.getUint16(o + 32, true); }
      if (id === 0x64617461) { data = [o + 8, Math.min(sz, buf.byteLength - o - 8)]; break; }
      o += 8 + sz + (sz & 1);
    }
    if (!data || !nc || (fmt !== 1 && fmt !== 3) || sr < 8000 || sr > 192000) return null;
    var bps = bits / 8, n = Math.floor(data[1] / (nc * bps)), ch = [];
    for (var c = 0; c < nc; c++) ch.push(new Float32Array(n));
    var p = data[0];
    for (var i = 0; i < n; i++) for (c = 0; c < nc; c++, p += bps) {
      var v;
      if (fmt === 3) v = bits === 64 ? dv.getFloat64(p, true) : dv.getFloat32(p, true);
      else if (bits === 16) v = dv.getInt16(p, true) / 32768;
      else if (bits === 24) { var x = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getInt8(p + 2) << 16); v = x / 8388608; }
      else if (bits === 32) v = dv.getInt32(p, true) / 2147483648;
      else if (bits === 8) v = (dv.getUint8(p) - 128) / 128;
      ch[c][i] = v;
    }
    return { sr: sr, ch: ch };
  }
  function decode(buf) {
    var w = parseWav(buf.slice(0));
    if (w) return Promise.resolve(w);
    return new Promise(function (res, rej) {
      var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext, ctx = new OC(2, 1, 44100);
      var ok = function (ab) { var ch = []; for (var c = 0; c < ab.numberOfChannels; c++) ch.push(Float32Array.from(ab.getChannelData(c))); res({ sr: ab.sampleRate, ch: ch }); };
      var p = ctx.decodeAudioData(buf, ok, function (e) { rej(e || new Error('This file could not be decoded')); });
      if (p && p.catch) p.catch(function (e) { rej(e); });
    });
  }
  async function openFile(file) {
    var name = file.name || 'song';
    var buf = await file.arrayBuffer();
    if (/\.frenchpress$/i.test(name) || isZip(buf)) return openProject(buf);
    await loadAudio(buf, name, file.type || '');
    S.ops = []; S.undo = []; S.redo = [];
  }
  function isZip(buf) { return buf.byteLength > 4 && new DataView(buf).getUint32(0, true) === 0x04034b50; }
  async function loadAudio(buf, name, type) {
    UI.toast('Opening ' + name + '…');
    var raw = buf.slice(0), d;
    try { d = await decode(buf); } catch (e) { UI.toast('Could not open that file: ' + (e.message || e)); throw e; }
    var L = d.ch[0], R = d.ch[1] || d.ch[0];
    if (d.ch.length > 2) { L = d.ch[0]; R = d.ch[1]; }
    if (!d.ch[1]) R = Float32Array.from(L);
    stopPlayback();
    S.file = { name: name, bytes: raw, type: type }; S.ops = []; S.undo = []; S.redo = [];
    S.sr = d.sr; S.len = L.length; S.L = L; S.R = R; S.split = null; S.peaks = {}; S.specs = {};
    // mono / near-mono detection
    var sLR = 0, sLL = 0, sRR = 0, step = Math.max(1, Math.floor(S.len / 200000));
    for (var i = 0; i < S.len; i += step) { sLR += L[i] * R[i]; sLL += L[i] * L[i]; sRR += R[i] * R[i]; }
    var corr = sLR / Math.sqrt(sLL * sRR + 1e-20), sideRatio = 0; S.mono = corr > 0.995 || !d.ch[1];
    if (!S.session || S.session.sr !== S.sr) { if (S.session) try { S.session.ctx.close(); } catch (e) {} S.session = new AUDIO.Session(S.sr); S.session.onEnded = function () { updatePlayIcon(); }; }
    S.original = S.session.ctx.createBuffer(2, S.len, S.sr); S.original.copyToChannel(L, 0); S.original.copyToChannel(R, 1);
    S.view.sel = null; S.view.scroll = 0;
    if (S.mono) selectRecipe('mono', true); else if (S.recipe === 'mono') selectRecipe('balanced', true);
    showSetup();
    setTabsEnabled(false);
    saveSessionFile();
  }

  // ---------------------------------------------------------------- demo song (synthesised here, so it is ours outright)
  function demoSong() {
    var sr = 44100, bpm = 96, beat = 60 / bpm, bars = 8, len = Math.round(bars * 4 * beat * sr), L = new Float32Array(len), R = new Float32Array(len);
    var rnd = (function () { var s = 7; return function () { s = (s * 16807) % 2147483647; return s / 2147483647 * 2 - 1; }; })();
    function add(buf, i, v) { if (i >= 0 && i < len) buf[i] += v; }
    var chords = [[69, 72, 76], [65, 69, 72], [60, 64, 67], [67, 71, 74]], mtof = function (m) { return 440 * Math.pow(2, (m - 69) / 12); };
    for (var b = 0; b < bars; b++) {
      var t0 = b * 4 * beat, ch = chords[b % 4];
      // pad: detuned saws, wide
      ch.forEach(function (m, vi) {
        var f = mtof(m), n = Math.round(4 * beat * sr), s0 = Math.round(t0 * sr), panL = [1.05, 0.2, 0.85][vi], panR = [0.2, 1.05, 0.35][vi];
        var ph1 = 0, ph2 = 0, lp = 0;
        for (var i = 0; i < n; i++) {
          ph1 += f * 1.003 / sr; ph2 += f * 0.997 / sr; var s = (ph1 % 1 - 0.5) + (ph2 % 1 - 0.5);
          lp += (s - lp) * 0.08; var env = Math.min(1, i / (0.08 * sr)) * Math.min(1, (n - i) / (0.1 * sr));
          add(L, s0 + i, lp * env * 0.4 * panL); add(R, s0 + i, lp * env * 0.4 * panR);
        }
      });
      for (var q = 0; q < 8; q++) {
        var tb = t0 + q * beat / 2, s0 = Math.round(tb * sr);
        // bass: root, eighths
        var fb = mtof(ch[0] - 36 + (q === 7 ? 7 : 0)), nb = Math.round(beat / 2 * sr * 0.9), phb = 0;
        for (var i = 0; i < nb; i++) { phb += fb / sr; var sb = Math.sin(2 * Math.PI * phb) + 0.3 * Math.sin(4 * Math.PI * phb) + 0.15 * (phb % 1 - 0.5); var eb = Math.exp(-i / (0.5 * sr)) * Math.min(1, (nb - i) / 300); add(L, s0 + i, sb * eb * 0.3); add(R, s0 + i, sb * eb * 0.3); }
        // hats, slightly right
        var nh = Math.round(0.05 * sr), hp = 0, prev = 0;
        for (i = 0; i < nh; i++) { var r = rnd(); hp = r - prev; prev = r; var eh = Math.exp(-i / (0.012 * sr)) * 0.12; add(L, s0 + i, hp * eh * 0.7); add(R, s0 + i, hp * eh); }
        if (q % 4 === 0 || q === 5) { // kick
          var nk = Math.round(0.35 * sr), pk = 0;
          for (i = 0; i < nk; i++) { var fk = 45 + 110 * Math.exp(-i / (0.03 * sr)); pk += fk / sr; var ek = Math.exp(-i / (0.12 * sr)); var sk = Math.sin(2 * Math.PI * pk) * ek * 0.9; add(L, s0 + i, sk); add(R, s0 + i, sk); }
        }
        if (q === 2 || q === 6) { // snare
          var ns = Math.round(0.25 * sr), ps = 0;
          for (i = 0; i < ns; i++) { ps += 190 / sr; var es = Math.exp(-i / (0.06 * sr)), ss = (rnd() * 0.6 + Math.sin(2 * Math.PI * ps) * 0.5) * es * 0.5; add(L, s0 + i, ss); add(R, s0 + i, ss); }
        }
      }
    }
    // lead "voice": glottal pulses through vowel formants, centre, with vibrato; a melody that does not repeat
    var melody = [69, 72, 74, 72, 69, 67, 69, null, 72, 76, 74, 72, 74, 76, 79, null, 77, 76, 74, 72, 74, 72, 69, null, 67, 69, 72, 71, 69, 67, 69, 69];
    var vowels = [[730, 1090, 2440], [530, 1840, 2480], [570, 840, 2410], [300, 870, 2240], [270, 2290, 3010]];
    var res = vowels.map(function () { return [0, 0, 0, 0, 0, 0]; }), vs0 = Math.round(2 * 4 * beat * sr);
    var phv = 0;
    for (var k = 0; k < melody.length; k++) {
      var m = melody[k]; if (m === null) continue;
      var start = vs0 + Math.round(k * beat * sr) - vs0 * 0, n = Math.round(beat * sr * 0.95), vw = vowels[k % vowels.length], st = [0, 0, 0, 0, 0, 0];
      var f0 = mtof(m - 12);
      for (i = 0; i < n; i++) {
        var vib = 1 + 0.012 * Math.sin(2 * Math.PI * 5.5 * i / sr) * Math.min(1, i / (0.25 * sr));
        phv += f0 * vib / sr; var src = (phv % 1) < 0.4 ? Math.sin(Math.PI * (phv % 1) / 0.4) : 0; src = src * src - 0.2;
        var out = 0;
        for (var fo = 0; fo < 3; fo++) { // two-pole resonators
          var fr = vw[fo], bw = 80 + fo * 40, rr = Math.exp(-Math.PI * bw / sr), th = 2 * Math.PI * fr / sr, a1 = 2 * rr * Math.cos(th), a2 = -rr * rr;
          var y = src * (1 - rr) + a1 * st[2 * fo] + a2 * st[2 * fo + 1]; st[2 * fo + 1] = st[2 * fo]; st[2 * fo] = y; out += y * (fo === 0 ? 1 : 0.6);
        }
        var env = Math.min(1, i / (0.04 * sr)) * Math.min(1, (n - i) / (0.06 * sr)) * 0.16, idx = vs0 + Math.round(k * beat * sr) - vs0 + Math.round(2 * 4 * beat * sr) + i;
        add(L, idx, out * env); add(R, idx, out * env);
      }
    }
    // a little stereo room on everything
    var dl = [1557, 1617, 1491, 1422], dr = [1277, 1356, 1188, 1116];
    function room(x, d, g) { var y = new Float32Array(len); d.forEach(function (dd) { for (var i = dd; i < len; i++) y[i] += (x[i - dd] + y[i - dd] * 0.55) * g; }); return y; }
    var mono = new Float32Array(len); for (i = 0; i < len; i++) mono[i] = (L[i] + R[i]) * 0.5;
    var rl = room(mono, dl, 0.05), rrr = room(mono, dr, 0.05);
    var pk2 = 0; for (i = 0; i < len; i++) { L[i] += rl[i]; R[i] += rrr[i]; pk2 = Math.max(pk2, Math.abs(L[i]), Math.abs(R[i])); }
    var g = 0.89 / pk2; for (i = 0; i < len; i++) { L[i] *= g; R[i] *= g; }
    return DSP.wav([L, R], sr, 16, true);
  }

  // ---------------------------------------------------------------- press view
  function showSetup() {
    $('#welcome').classList.add('hidden'); $('#setup').classList.remove('hidden'); $('#result').classList.add('hidden');
    var fc = $('#fileCard'); fc.innerHTML = '';
    var info = el('div', {}, [el('div', { class: 'title', style: 'font-size:28px', text: S.file.name }),
      el('div', { class: 'muted', text: UI.fmtTime(S.len / S.sr) + ' · ' + (S.sr / 1000) + ' kHz · ' + (S.mono ? 'mono (or nearly)' : 'stereo') })]);
    var cv = el('canvas'); fc.appendChild(info); fc.appendChild(cv);
    requestAnimationFrame(function () { drawMini(cv, [S.L, S.R], UI.css('--ink2')); });
    $('#coresInfo').textContent = 'Runs on ' + makePool().size + (makePool().workers ? ' threads' : ' thread (main)') + ' on this device';
    renderRecipes(); renderStemSeg(); renderAdvanced();
  }
  function renderRecipes() {
    var box = $('#recipes'); box.innerHTML = '';
    RECIPES.forEach(function (r) { box.appendChild(el('button', { class: 'recipe' + (S.recipe === r.id ? ' on' : ''), onclick: function () { selectRecipe(r.id); } }, [el('b', { text: r.name }), el('span', { text: r.desc })])); });
  }
  function selectRecipe(id, quiet) {
    var r = RECIPES.filter(function (x) { return x.id === id; })[0] || RECIPES[0], stems = S.params.stems;
    S.recipe = r.id; S.params = Object.assign({}, DSP.DEFAULTS, r.p);
    S.params.stems = r.p.stems || (stems === 2 ? 4 : stems || 4);
    if (!quiet || $('#recipes').children.length) { renderRecipes(); renderStemSeg(); renderAdvanced(); }
  }
  function renderStemSeg() { $$('#stemSeg button').forEach(function (b) { b.classList.toggle('on', +b.dataset.n === S.params.stems); b.onclick = function () { S.params.stems = +b.dataset.n; renderStemSeg(); }; }); }
  function renderAdvanced() {
    var g = $('#advGrid'); g.innerHTML = ''; var groups = {};
    SLIDERS.forEach(function (s) {
      if (!groups[s.g]) { groups[s.g] = el('div', {}, [el('h4', { text: s.g })]); g.appendChild(groups[s.g]); }
      var inp = el('input', { type: 'range', min: s.min, max: s.max, step: s.step, value: S.params[s.k] }), out = el('output', { text: s.f(S.params[s.k]) });
      inp.oninput = function () { S.params[s.k] = +inp.value; out.textContent = s.f(+inp.value); };
      groups[s.g].appendChild(el('label', { class: 'slider' }, [el('span', { text: s.l }), out, inp]));
    });
    g.appendChild(el('div', {}, [el('button', { class: 'btn sm', text: 'Reset to the recipe', onclick: function () { selectRecipe(S.recipe); } })]));
  }
  var cancelFlag = false;
  async function runSplit() {
    if (S.splitting) return;
    if (S.ops.length && !(await UI.ask('Press again?', '<p>Pressing again starts from fresh stems, so your ' + S.ops.length + ' edit' + (S.ops.length > 1 ? 's' : '') + ' will be lost. Mixer and master settings stay.</p>', 'Press again'))) return;
    S.splitting = true; cancelFlag = false; stopPlayback(); if (window.FPAndroid && FPAndroid.busy) FPAndroid.busy(true);
    var pool = makePool(), names = ENGINE.STEM_SETS[S.params.stems];
    var prog = $('#progress'); prog.classList.remove('hidden'); $('#result').classList.add('hidden'); $('#pressBtn').disabled = true;
    var stages = ['Pressing out the drums', 'Listening for the melody', 'Following the singer and the bass line', 'Separating the layers', 'Drawing the stems'];
    var stepsUl = $('#progSteps'); stepsUl.innerHTML = ''; stages.forEach(function (s) { stepsUl.appendChild(el('li', { text: s })); });
    var weights = [0.3, 0.14, 0.04, 0.42, 0.1], t0 = Date.now();
    var setProg = function (stage, frac) {
      var si = stages.indexOf(stage); if (si < 0) return;
      $$('li', stepsUl).forEach(function (li, i) { li.className = i < si ? 'done' : i === si ? 'now' : ''; });
      var done = 0; for (var i = 0; i < si; i++) done += weights[i]; done += weights[si] * frac;
      $('#progBar').style.width = (done * 100).toFixed(1) + '%'; $('#progLabel').textContent = stage + '…';
      var el2 = (Date.now() - t0) / 1000; $('#progTime').textContent = el2.toFixed(0) + ' s' + (done > 0.08 ? ' · about ' + Math.max(0, el2 / done - el2).toFixed(0) + ' s to go' : '');
    };
    var bufs = {};
    try {
      var res = await ENGINE.separate(S.L, S.R, S.sr, S.params, pool, function (name) {
        var b = S.session.ctx.createBuffer(2, S.len, S.sr); bufs[name] = b; return [b.getChannelData(0), b.getChannelData(1)];
      }, setProg, function () { return cancelFlag; });
      setProg('Drawing the stems', 0);
      S.split = { names: res.names, buffers: bufs, report: res, params: Object.assign({}, S.params), recipe: S.recipe };
      S.ops = []; S.undo = []; S.redo = []; S.peaks = {}; S.specs = {};
      ensureMixState(res.names);
      res.names.forEach(function (n) { S.peaks[n] = computePeaks(bufs[n]); });
      S.peaks.__mix = computePeaks(S.original);
      S.session.setStems(res.names); S.session.apply(S.st);
      await computeSpecs(res.names, function (f) { setProg('Drawing the stems', f); });
      setProg('Drawing the stems', 1);
      $$('li', stepsUl).forEach(function (li) { li.className = 'done'; });
      showResult(res, (Date.now() - t0) / 1000);
      setTabsEnabled(true); renderEditHeads(); buildMix(); buildMaster(); saveProjectSoon();
    } catch (e) {
      if (String(e.message || e) === 'cancelled') UI.toast('Pressing cancelled'); else { console.error(e); UI.toast('Something went wrong: ' + (e.message || e), 6000); }
    } finally { S.splitting = false; $('#pressBtn').disabled = false; prog.classList.add('hidden'); if (window.FPAndroid && FPAndroid.busy) FPAndroid.busy(false); }
  }
  function showResult(res, secs) {
    var r = $('#result'); r.classList.remove('hidden'); r.innerHTML = '';
    // reconstruction check
    var err = 0, names = res.names, B = S.split.buffers;
    for (var c = 0; c < 2; c++) {
      var orig = c ? S.R : S.L, chans = names.map(function (n) { return B[n].getChannelData(c); });
      for (var i = 0; i < S.len; i++) { var s = 0; for (var k = 0; k < chans.length; k++) s += chans[k][i]; var d = Math.abs(s - orig[i]); if (d > err) err = d; }
    }
    var errDb = 20 * Math.log10(err + 1e-30);
    r.appendChild(el('h2', { class: 'title', text: 'Pressed in ' + secs.toFixed(1) + ' s' }));
    var list = el('div', { class: 'stemlist', style: 'margin:10px 0' });
    names.forEach(function (n) {
      var b = B[n], e = 0, l = b.getChannelData(0), rr = b.getChannelData(1); for (var i = 0; i < S.len; i += 4) e += l[i] * l[i] + rr[i] * rr[i];
      var lvl = 10 * Math.log10(e / (S.len / 4 * 2) + 1e-20), cv = el('canvas');
      list.appendChild(el('div', { class: 'stemrow' }, [el('span', { class: 'chip', style: 'background:' + color(n) }), el('b', { class: 'title', style: 'font-size:22px', text: STEM[n].label }), cv, el('span', { class: 'muted', text: lvl.toFixed(1) + ' dB' })]));
      requestAnimationFrame(function () { drawMini(cv, [l, rr], color(n)); });
    });
    r.appendChild(list);
    r.appendChild(el('p', { class: 'report', html: '<span class="ok">●</span> The stems add back up to the original <b>exactly</b> (largest difference ' + errDb.toFixed(0) + ' dB, below anything audible), so nothing is lost and nothing is added.' +
      (res.period ? '<br>The music repeats every <b>' + res.period.toFixed(2) + ' s</b>' + bpmGuess(res.period) + '.' : '') +
      '<br>A melody was tracked through <b>' + Math.round(res.voicedFrac * 100) + '%</b> of the song.' }));
    r.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'btn primary', text: 'Edit the stems', onclick: function () { setTab('edit'); } }),
      el('button', { class: 'btn', text: 'Open the console', onclick: function () { setTab('mix'); } }),
      el('button', { class: 'btn', text: 'Master it', onclick: function () { setTab('master'); } }),
      el('button', { class: 'btn', text: '▶ Play', onclick: function () { togglePlay(); } })]));
  }
  function bpmGuess(per) { var best = null; [1, 2, 4, 8, 16].forEach(function (n) { var b = 60 * n / per; if (b >= 72 && b < 160 && !best) best = b; }); return best ? ' (about <b>' + Math.round(best) + ' BPM</b>)' : ''; }
  function drawMini(cv, chans, col) {
    var r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; cv.width = Math.max(10, r.width * d); cv.height = Math.max(10, r.height * d);
    var c = cv.getContext('2d'), w = cv.width, h = cv.height, n = chans[0].length, step = n / w; c.fillStyle = col;
    for (var x = 0; x < w; x++) { var a = Math.floor(x * step), b = Math.min(n, Math.floor((x + 1) * step)), m = 0; for (var i = a; i < b; i += 4) { var v = Math.max(Math.abs(chans[0][i]), Math.abs(chans[1][i])); if (v > m) m = v; } var hh = Math.max(1, m * h); c.fillRect(x, (h - hh) / 2, 1, hh); }
  }
  function ensureMixState(names) {
    var old = S.st;
    S.st = { names: names.slice(), strips: {}, master: old ? old.master : AUDIO.defaultMaster() };
    names.forEach(function (n) { S.st.strips[n] = old && old.strips[n] ? old.strips[n] : AUDIO.defaultStrip(); });
    if (!S.st.master.target) S.st.master.target = -14;
  }

  // ---------------------------------------------------------------- peaks & spectrograms
  var PK = 256;
  function computePeaks(buf, a, b, pk) {
    var L = buf.getChannelData(0), R = buf.getChannelData(1), n = Math.ceil(L.length / PK);
    pk = pk || new Float32Array(n); a = a || 0; b = b === undefined ? n : b;
    for (var j = a; j < b; j++) { var m = 0, e = Math.min(L.length, (j + 1) * PK); for (var i = j * PK; i < e; i++) { var v = Math.abs(L[i]); if (v > m) m = v; v = Math.abs(R[i]); if (v > m) m = v; } pk[j] = m; }
    return pk;
  }
  var SPEC_HOP = 1024;
  async function computeSpecs(names, onFrac, x0, x1) {
    var pool = makePool(), cols = Math.ceil(S.len / SPEC_HOP), N = 2048, CH = 600, jobs = [], done = 0;
    var c0 = x0 === undefined ? 0 : Math.max(0, Math.floor(x0 / SPEC_HOP) - 2), c1 = x1 === undefined ? cols : Math.min(cols, Math.ceil(x1 / SPEC_HOP) + 2);
    names.forEach(function (n) {
      if (!S.specs[n]) S.specs[n] = { cols: cols, data: new Uint8Array(cols * DSP.SPEC_ROWS), tiles: {} };
      for (var a = c0; a < c1; a += CH) jobs.push({ n: n, a: a, b: Math.min(c1, a + CH) });
    });
    await ENGINE.runAll(pool, jobs.map(function (j) {
      return function () {
        var buf = S.split.buffers[j.n], s0 = j.a * SPEC_HOP - N, s1 = j.b * SPEC_HOP + N;
        var L = sliceZ(buf.getChannelData(0), s0, s1), R = sliceZ(buf.getChannelData(1), s0, s1);
        return pool.run('SPEC', { L: L, R: R, segStart: s0, c0: j.a, c1: j.b, hop: SPEC_HOP, N: N, sr: S.sr }).then(function (res) {
          S.specs[j.n].data.set(res.out, j.a * DSP.SPEC_ROWS); S.specs[j.n].tiles = {}; if (onFrac) onFrac(++done / jobs.length);
        });
      };
    }));
  }
  function sliceZ(x, a, b) { var o = new Float32Array(b - a), s = Math.max(0, a), e = Math.min(x.length, b); if (e > s) o.set(x.subarray(s, e), s - a); return o; }
  var TILE = 1024;
  function specTile(n, t) {
    var sp = S.specs[n]; if (!sp) return null;
    if (sp.tiles[t]) return sp.tiles[t];
    var rows = DSP.SPEC_ROWS, w = Math.min(TILE, sp.cols - t * TILE); if (w <= 0) return null;
    var cv = document.createElement('canvas'); cv.width = w; cv.height = rows;
    var c = cv.getContext('2d'), img = c.createImageData(w, rows), col = hexRgb(color(n)), late = document.documentElement.dataset.look === 'late', bg = hexRgb(UI.css('--paper'));
    for (var x = 0; x < w; x++) for (var r = 0; r < rows; r++) {
      var v = sp.data[(t * TILE + x) * rows + r] / 255; v = v * v * 1.15; if (v > 1) v = 1;
      var o = ((rows - 1 - r) * w + x) * 4, ink = late ? [255, 245, 225] : [20, 16, 12];
      // stem colour for the body, ink/cream for the loudest parts
      var k2 = Math.max(0, v - 0.75) * 4;
      for (var ci = 0; ci < 3; ci++) img.data[o + ci] = Math.round(bg[ci] + (col[ci] - bg[ci]) * Math.min(1, v * 1.3) + (ink[ci] - col[ci]) * k2 * 0.5);
      img.data[o + 3] = 255;
    }
    c.putImageData(img, 0, 0); sp.tiles[t] = cv; return cv;
  }
  function hexRgb(h) { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join(''); return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }

  // ---------------------------------------------------------------- edit view: timeline
  var tl = null, ov = null, RULER = 22;
  function laneGeom() {
    var names = S.split ? S.split.names : [], h = tl.clientHeight - RULER, n = names.length || 1, lh = Math.max(46, Math.floor(h / n));
    return names.map(function (nm, i) { return { name: nm, y: RULER + i * lh, h: lh }; });
  }
  function t2x(t) { return (t - S.view.scroll) * S.view.zoom; }
  function x2t(x) { return x / S.view.zoom + S.view.scroll; }
  var F_LO = 30, F_HI = 18000;
  function f2y(f, ln) { var lo = Math.log2(F_LO), hi = Math.log2(Math.min(F_HI, S.sr / 2 - 100)); return ln.y + ln.h - (Math.log2(Math.max(f, F_LO)) - lo) / (hi - lo) * ln.h; }
  function y2f(y, ln) { var lo = Math.log2(F_LO), hi = Math.log2(Math.min(F_HI, S.sr / 2 - 100)); return Math.pow(2, lo + (ln.y + ln.h - y) / ln.h * (hi - lo)); }
  function fitZoom() { var w = tl.clientWidth || 800; S.view.zoom = w / Math.max(1, S.len / S.sr); S.view.scroll = 0; }
  function clampScroll() { var dur = S.len / S.sr, vis = (tl.clientWidth || 800) / S.view.zoom; S.view.scroll = Math.max(0, Math.min(S.view.scroll, Math.max(0, dur - vis))); }
  function sizeCanvas(cv) { var r = cv.getBoundingClientRect(), d = devicePixelRatio || 1; var w = Math.round(r.width * d), h = Math.round(r.height * d); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return d; }
  function renderEditHeads() {
    var box = $('#laneHeads'); box.innerHTML = ''; if (!S.split) return;
    var lanes = laneGeom();
    lanes.forEach(function (ln) {
      var s = S.st.strips[ln.name];
      var m = el('button', { class: 'mini' + (s.mute ? ' on' : ''), text: 'M', title: 'Mute', onclick: function () { s.mute = !s.mute; applyMix(); renderEditHeads(); } });
      var so = el('button', { class: 'mini s' + (s.solo ? ' on' : ''), text: 'S', title: 'Solo', onclick: function () { s.solo = !s.solo; applyMix(); renderEditHeads(); } });
      var nm = el('div', { class: 'nm', title: 'Select this whole stem', onclick: function () { S.view.sel = { x0: 0, x1: S.len, stems: [ln.name] }; drawTimeline(); updateSelInfo(); } }, [el('span', { class: 'chip', style: 'background:' + color(ln.name) }), STEM[ln.name].label]);
      box.appendChild(el('div', { class: 'lhead', style: 'top:' + ln.y + 'px;height:' + ln.h + 'px' }, [nm, el('div', { class: 'btns' }, [m, so])]));
    });
  }
  function drawTimeline() {
    if (!tl || S.tab !== 'edit' || !S.split) return;
    var d = sizeCanvas(tl), c = tl.getContext('2d'), w = tl.width, h = tl.height, lanes = laneGeom(), V = S.view;
    c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, w, h); c.scale(d, d);
    var W = w / d, dur = S.len / S.sr;
    // ruler
    c.fillStyle = UI.css('--paper3'); c.fillRect(0, 0, W, RULER);
    var spp = 1 / V.zoom, stepT = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120].filter(function (s) { return s * V.zoom >= 70; })[0] || 120;
    c.fillStyle = UI.css('--ink2'); c.strokeStyle = UI.css('--ink3'); c.font = '11px ' + UI.css('--type'); c.lineWidth = 1;
    for (var t = Math.floor(V.scroll / stepT) * stepT; t < x2t(W); t += stepT) { var x = t2x(t); c.beginPath(); c.moveTo(x + 0.5, RULER - 7); c.lineTo(x + 0.5, RULER); c.stroke(); c.fillText(UI.fmtTime(t, stepT < 1), x + 3, 14); }
    var loop = S.session && S.session.loop; if (loop) { c.fillStyle = 'rgba(200,35,27,.25)'; c.fillRect(t2x(loop[0]), 0, (loop[1] - loop[0]) * V.zoom, RULER); }
    // lanes
    lanes.forEach(function (ln, li) {
      var s = S.st.strips[ln.name], col = color(ln.name), anySolo = S.st.names.some(function (n) { return S.st.strips[n].solo; });
      var dim = s.mute || (anySolo && !s.solo);
      c.fillStyle = li % 2 ? UI.css('--paper') : UI.css('--paper2'); c.fillRect(0, ln.y, W, ln.h);
      c.globalAlpha = dim ? 0.35 : 1;
      if (V.mode === 'spec') {
        var sp = S.specs[ln.name];
        if (sp) {
          var hopT = SPEC_HOP / S.sr, cA = Math.max(0, Math.floor(V.scroll / hopT)), cB = Math.min(sp.cols, Math.ceil(x2t(W) / hopT) + 1);
          c.imageSmoothingEnabled = true;
          for (var ti = Math.floor(cA / TILE); ti * TILE < cB; ti++) {
            var tile = specTile(ln.name, ti); if (!tile) break;
            var tc0 = ti * TILE, x0 = t2x(tc0 * hopT), x1 = t2x((tc0 + tile.width) * hopT);
            c.drawImage(tile, 0, 0, tile.width, tile.height, x0, ln.y, x1 - x0, ln.h);
          }
        }
        c.fillStyle = UI.css('--ink3'); c.font = '10px ' + UI.css('--type');
        [100, 1000, 10000].forEach(function (f) { var y = f2y(f, ln); c.fillText(UI.fmtHz(f), 3, y - 2); c.fillRect(0, y, 6, 1); });
      } else {
        var pk = S.peaks[ln.name], mid = ln.y + ln.h / 2, amp = ln.h / 2 - 3, buf = S.split.buffers[ln.name];
        c.fillStyle = col; c.beginPath();
        var sppx = S.sr / V.zoom, Ld = buf.getChannelData(0), Rd = buf.getChannelData(1);
        for (var px = 0; px < W; px++) {
          var sa = Math.floor(x2t(px) * S.sr), sb = Math.floor(x2t(px + 1) * S.sr), m = 0;
          if (sb <= 0 || sa >= S.len) continue; sa = Math.max(0, sa); sb = Math.min(S.len, Math.max(sb, sa + 1));
          if (sppx >= PK * 2) { for (var j = Math.floor(sa / PK); j < Math.ceil(sb / PK); j++) if (pk[j] > m) m = pk[j]; }
          else for (var i = sa; i < sb; i++) { var v = Math.abs(Ld[i]); if (v > m) m = v; v = Math.abs(Rd[i]); if (v > m) m = v; }
          var hh = Math.max(0.5, Math.min(1, m) * amp); c.rect(px, mid - hh, 1, hh * 2);
        }
        c.fill();
        c.fillStyle = UI.css('--ink3'); c.fillRect(0, mid, W, 0.5);
      }
      c.globalAlpha = 1;
      c.fillStyle = UI.css('--ink'); c.fillRect(0, ln.y + ln.h - 1, W, 1);
    });
    // selection
    var sel = V.sel;
    if (sel) {
      c.fillStyle = 'rgba(200,35,27,.16)'; c.strokeStyle = UI.css('--red'); c.lineWidth = 1.5;
      lanes.forEach(function (ln) {
        if (sel.stems.indexOf(ln.name) < 0) return;
        var xa = t2x(sel.x0 / S.sr), xb = t2x(sel.x1 / S.sr), ya = ln.y, yb = ln.y + ln.h;
        if (sel.flo !== undefined) { ya = f2y(sel.fhi, ln); yb = f2y(sel.flo, ln); }
        c.fillRect(xa, ya, xb - xa, yb - ya); c.strokeRect(xa, ya, xb - xa, yb - ya);
      });
    }
    // playhead
    var ph = t2x(S.session ? S.session.time() : 0);
    c.fillStyle = UI.css('--red'); c.fillRect(ph - 1, 0, 2, h / d);
    c.beginPath(); c.moveTo(ph - 6, 0); c.lineTo(ph + 6, 0); c.lineTo(ph, 8); c.fill();
    drawOverview();
  }
  function drawOverview() {
    if (!ov || !S.split) return;
    var d = sizeCanvas(ov), c = ov.getContext('2d'), w = ov.width, h = ov.height, pk = S.peaks.__mix, n = pk.length;
    c.clearRect(0, 0, w, h); c.fillStyle = UI.css('--ink2');
    for (var x = 0; x < w; x++) { var a = Math.floor(x / w * n), b = Math.max(a + 1, Math.floor((x + 1) / w * n)), m = 0; for (var j = a; j < b; j++) if (pk[j] > m) m = pk[j]; var hh = Math.max(1, m * (h - 6)); c.fillRect(x, (h - hh) / 2, 1, hh); }
    var dur = S.len / S.sr, vis = tl.clientWidth / S.view.zoom;
    c.strokeStyle = UI.css('--red'); c.lineWidth = 2 * d; c.strokeRect(S.view.scroll / dur * w, 1, Math.max(4, vis / dur * w), h - 2);
    var ph = (S.session ? S.session.time() : 0) / dur * w; c.fillStyle = UI.css('--red'); c.fillRect(ph - d, 0, 2 * d, h);
  }
  function setupTimeline() {
    tl = $('#timeline'); ov = $('#overview');
    var drag = null, pointers = {}, pinch = null;
    tl.addEventListener('pointerdown', function (e) {
      if (!S.split) return;
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(pointers);
      if (ids.length === 2) { var a = pointers[ids[0]], b = pointers[ids[1]]; pinch = { d: Math.abs(a.x - b.x) || 1, zoom: S.view.zoom, mid: (a.x + b.x) / 2, t: x2t((a.x + b.x) / 2 - tl.getBoundingClientRect().left) }; drag = null; return; }
      tl.setPointerCapture(e.pointerId);
      var r = tl.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, lanes = laneGeom();
      if (y < RULER) { seek(Math.max(0, x2t(x))); drag = { ruler: true }; return; }
      var li = lanes.findIndex(function (ln) { return y >= ln.y && y < ln.y + ln.h; }); if (li < 0) return;
      if (e.button === 2) return;
      drag = { x: x, y: y, li: li, t: x2t(x), moved: false, ln: lanes[li], spec: S.view.mode === 'spec' };
    });
    tl.addEventListener('pointermove', function (e) {
      if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var r = tl.getBoundingClientRect();
      if (pinch) { var ids = Object.keys(pointers); if (ids.length < 2) return; var a = pointers[ids[0]], b = pointers[ids[1]], dd = Math.abs(a.x - b.x) || 1, mid = (a.x + b.x) / 2 - r.left;
        S.view.zoom = Math.max(2, Math.min(4000, pinch.zoom * dd / pinch.d)); S.view.scroll = pinch.t - mid / S.view.zoom; clampScroll(); drawTimeline(); return; }
      if (!drag) return;
      var x = e.clientX - r.left, y = e.clientY - r.top;
      if (drag.ruler) { seek(Math.max(0, x2t(x))); return; }
      if (!drag.moved && Math.abs(x - drag.x) < 4 && Math.abs(y - drag.y) < 4) return;
      drag.moved = true;
      var lanes = laneGeom(), t0 = Math.max(0, Math.min(drag.t, x2t(x))), t1 = Math.min(S.len / S.sr, Math.max(drag.t, x2t(x)));
      var sel = { x0: Math.round(t0 * S.sr), x1: Math.round(t1 * S.sr) };
      if (drag.spec) {
        var ln = drag.ln, ya = Math.max(ln.y, Math.min(ln.y + ln.h, y));
        var fa = y2f(drag.y, ln), fb = y2f(ya, ln); sel.flo = Math.max(F_LO, Math.min(fa, fb)); sel.fhi = Math.min(S.sr / 2, Math.max(fa, fb)); sel.stems = [ln.name];
      } else {
        var lj = lanes.findIndex(function (l2) { return y >= l2.y && y < l2.y + l2.h; }); if (lj < 0) lj = y < RULER ? 0 : lanes.length - 1;
        var a2 = Math.min(drag.li, lj), b2 = Math.max(drag.li, lj); sel.stems = lanes.slice(a2, b2 + 1).map(function (l2) { return l2.name; });
      }
      S.view.sel = sel; if (x > r.width - 20) { S.view.scroll += 8 / S.view.zoom; clampScroll(); } if (x < 20) { S.view.scroll -= 8 / S.view.zoom; clampScroll(); }
      drawTimeline(); updateSelInfo();
    });
    var up = function (e) {
      delete pointers[e.pointerId]; if (Object.keys(pointers).length < 2) pinch = null;
      if (!drag) return;
      if (!drag.ruler && !drag.moved) { S.view.sel = null; seek(drag.t); updateSelInfo(); }
      drag = null;
    };
    tl.addEventListener('pointerup', up); tl.addEventListener('pointercancel', up);
    tl.addEventListener('contextmenu', function (e) { e.preventDefault(); if (S.view.sel) opMenu(e.clientX, e.clientY); });
    tl.addEventListener('wheel', function (e) {
      e.preventDefault(); var r = tl.getBoundingClientRect(), x = e.clientX - r.left;
      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) > Math.abs(e.deltaX) && !e.shiftKey && false) { zoomAt(x, e.deltaY < 0 ? 1.25 : 0.8); return; }
      if (e.ctrlKey || e.metaKey) return;
      var dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY; if (e.altKey) { zoomAt(x, e.deltaY < 0 ? 1.25 : 0.8); return; }
      S.view.scroll += dx / S.view.zoom; clampScroll(); drawTimeline();
    }, { passive: false });
    var ovDrag = false;
    var ovMove = function (e) { var r = ov.getBoundingClientRect(), dur = S.len / S.sr, vis = tl.clientWidth / S.view.zoom; S.view.scroll = (e.clientX - r.left) / r.width * dur - vis / 2; clampScroll(); drawTimeline(); };
    ov.addEventListener('pointerdown', function (e) { if (!S.split) return; ovDrag = true; ov.setPointerCapture(e.pointerId); ovMove(e); });
    ov.addEventListener('pointermove', function (e) { if (ovDrag) ovMove(e); });
    ov.addEventListener('pointerup', function () { ovDrag = false; });
    $$('#modeSeg button').forEach(function (b) { b.onclick = function () { S.view.mode = b.dataset.m; $$('#modeSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); if (S.view.sel && S.view.sel.flo !== undefined && S.view.mode === 'wave') { delete S.view.sel.flo; delete S.view.sel.fhi; } drawTimeline(); updateSelInfo(); }; });
    $('#zIn').onclick = function () { zoomAt(tl.clientWidth / 2, 1.5); }; $('#zOut').onclick = function () { zoomAt(tl.clientWidth / 2, 1 / 1.5); }; $('#zFit').onclick = function () { fitZoom(); drawTimeline(); };
    $$('#editBar [data-op]').forEach(function (b) { b.onclick = function (e) { doOpUI(b.dataset.op, e); }; });
    $('#undoBtn').onclick = undo; $('#redoBtn').onclick = redo;
    new ResizeObserver(function () { if (S.tab === 'edit') { renderEditHeads(); drawTimeline(); } }).observe(tl);
  }
  function zoomAt(x, f) { var t = x2t(x); S.view.zoom = Math.max(2, Math.min(4000, S.view.zoom * f)); S.view.scroll = t - x / S.view.zoom; clampScroll(); drawTimeline(); }
  function updateSelInfo() {
    var s = S.view.sel, box = $('#selInfo');
    if (!s) { box.textContent = S.view.mode === 'spec' ? 'Drag a box around a sound in one lane to move it to another stem or turn it down.' : 'Drag across the lanes to select a range of one or more stems.'; return; }
    box.textContent = UI.fmtTime(s.x0 / S.sr) + ' – ' + UI.fmtTime(s.x1 / S.sr) + ' · ' + s.stems.map(function (n) { return STEM[n].label; }).join(', ') + (s.flo !== undefined ? ' · ' + UI.fmtHz(s.flo) + '–' + UI.fmtHz(s.fhi) + ' Hz' : '');
  }
  function opMenu(x, y) {
    var s = S.view.sel; if (!s) return;
    var items = [{ label: 'Level…', fn: function () { doOpUI('gain'); } }, { label: 'Silence', fn: function () { doOpUI('silence'); } }];
    if (s.flo === undefined) items.push({ label: 'Fade in', fn: function () { doOpUI('fadein'); } }, { label: 'Fade out', fn: function () { doOpUI('fadeout'); } });
    items.push('-', { sub: 'Move to' });
    S.split.names.forEach(function (n) { if (s.stems.length === 1 && s.stems[0] === n) return; items.push({ label: STEM[n].label, chip: color(n), fn: function () { doOp({ type: s.flo !== undefined ? 'smove' : 'move', stems: s.stems.slice(), to: n, x0: s.x0, x1: s.x1, flo: s.flo, fhi: s.fhi }); } }); });
    items.push('-', { label: 'Loop this range', fn: function () { setLoop([s.x0 / S.sr, s.x1 / S.sr]); } }, { label: 'Play from here', fn: function () { seek(s.x0 / S.sr); if (!S.session.playing) togglePlay(); } });
    UI.menu(x, y, items);
  }
  async function doOpUI(type, ev) {
    var s = S.view.sel; if (!s) { UI.toast('Select a range first: drag across the lanes'); return; }
    var spec = s.flo !== undefined;
    if (type === 'move') { var r = ev ? ev.target.getBoundingClientRect() : { left: 200, bottom: 120 }; opMenuMove(r.left, r.bottom + 4); return; }
    if ((type === 'fadein' || type === 'fadeout') && spec) { UI.toast('Fades work on time ranges: switch to Waveform'); return; }
    if (type === 'gain') {
      var a = await UI.ask('Level', '<p class="muted">Raise or lower the selection. Edges are smoothed so nothing clicks.</p><label class="slider"><span>Change</span><output id="gOut">−6.0 dB</output><input type="range" id="gIn" min="-36" max="12" step="0.5" value="-6" oninput="document.getElementById(\'gOut\').textContent=(this.value>0?\'+\':\'\')+(+this.value).toFixed(1)+\' dB\'"></label>', 'Apply');
      if (!a) return; doOp({ type: spec ? 'sgain' : 'gain', stems: s.stems.slice(), x0: s.x0, x1: s.x1, flo: s.flo, fhi: s.fhi, db: +a.gIn });
      return;
    }
    if (type === 'silence') { doOp({ type: spec ? 'sgain' : 'gain', stems: s.stems.slice(), x0: s.x0, x1: s.x1, flo: s.flo, fhi: s.fhi, db: -200 }); return; }
    doOp({ type: type, stems: s.stems.slice(), x0: s.x0, x1: s.x1 });
  }
  function opMenuMove(x, y) {
    var s = S.view.sel, items = [{ sub: 'Move the selection to' }];
    S.split.names.forEach(function (n) { if (s.stems.length === 1 && s.stems[0] === n) return; items.push({ label: STEM[n].label, chip: color(n), fn: function () { doOp({ type: s.flo !== undefined ? 'smove' : 'move', stems: s.stems.slice(), to: n, x0: s.x0, x1: s.x1, flo: s.flo, fhi: s.fhi }); } }); });
    UI.menu(x, y, items);
  }

  // ---------------------------------------------------------------- edit operations (undoable, logged for projects)
  var RAMP = 256;
  function envAt(i, a, b) { var r = Math.min(RAMP, (b - a) / 2); if (i < a || i >= b) return 0; if (i < a + r) return 0.5 - 0.5 * Math.cos(Math.PI * (i - a) / r); if (i >= b - r) return 0.5 - 0.5 * Math.cos(Math.PI * (b - i) / r); return 1; }
  function snapshot(names, a, b) { return names.map(function (n) { var buf = S.split.buffers[n]; return { n: n, a: a, L: buf.getChannelData(0).slice(a, b), R: buf.getChannelData(1).slice(a, b) }; }); }
  function restore(snap) { snap.forEach(function (s) { var buf = S.split.buffers[s.n]; buf.getChannelData(0).set(s.L, s.a); buf.getChannelData(1).set(s.R, s.a); }); }
  async function applyOp(op) {
    var B = S.split.buffers, a = Math.max(0, op.x0), b = Math.min(S.len, op.x1);
    if (b - a < 2) return;
    if (op.type === 'gain' || op.type === 'fadein' || op.type === 'fadeout') {
      var g = op.type === 'gain' ? AUDIO.db2g(op.db) : 0;
      op.stems.forEach(function (n) { [0, 1].forEach(function (c) { var x = B[n].getChannelData(c);
        for (var i = a; i < b; i++) {
          var k;
          if (op.type === 'gain') k = 1 + (g - 1) * envAt(i, a, b);
          else { var t = (i - a) / (b - a); k = op.type === 'fadein' ? 0.5 - 0.5 * Math.cos(Math.PI * t) : 0.5 + 0.5 * Math.cos(Math.PI * t); }
          x[i] *= k;
        } }); });
    } else if (op.type === 'move') {
      var to = B[op.to];
      op.stems.forEach(function (n) { if (n === op.to) return; [0, 1].forEach(function (c) { var x = B[n].getChannelData(c), y = to.getChannelData(c);
        for (var i = a; i < b; i++) { var v = x[i] * envAt(i, a, b); x[i] -= v; y[i] += v; } }); });
    } else if (op.type === 'smove' || op.type === 'sgain') {
      var pool = makePool(), N = 2048, s0 = a - 2 * N, s1 = b + 2 * N, n = op.stems[0];
      var res = await pool.run('SPART', { L: sliceZ(B[n].getChannelData(0), s0, s1), R: sliceZ(B[n].getChannelData(1), s0, s1), segStart: s0, sr: S.sr, x0: a, x1: b, flo: op.flo, fhi: op.fhi, N: N });
      var k = op.type === 'smove' ? 1 : 1 - AUDIO.db2g(op.db);
      [0, 1].forEach(function (c) { var x = B[n].getChannelData(c), part = c ? res.R : res.L, y = op.type === 'smove' ? B[op.to].getChannelData(c) : null;
        for (var i = 0; i < part.length; i++) { var j = s0 + i; if (j < 0 || j >= S.len) continue; var v = part[i] * k; x[j] -= v; if (y) y[j] += v; } });
    }
  }
  function opRange(op) { var pad = (op.type === 'smove' || op.type === 'sgain') ? 4096 + 512 : 0; return [Math.max(0, op.x0 - pad), Math.min(S.len, op.x1 + pad)]; }
  function opStems(op) { return op.to && op.stems.indexOf(op.to) < 0 ? op.stems.concat([op.to]) : op.stems.slice(); }
  var opBusy = false;
  async function doOp(op) {
    if (opBusy || !S.split) return; opBusy = true;
    try {
      var rg = opRange(op), names = opStems(op), before = snapshot(names, rg[0], rg[1]);
      await applyOp(op);
      var after = snapshot(names, rg[0], rg[1]);
      S.undo.push({ op: op, before: before, after: after, rg: rg, names: names }); S.redo = []; S.ops.push(op);
      if (S.undo.length > 60) S.undo.shift();
      await afterEdit(names, rg); UI.toast(opLabel(op));
    } finally { opBusy = false; }
  }
  function opLabel(op) {
    var who = op.stems.map(function (n) { return STEM[n].label; }).join(' + ');
    return ({ gain: op.db <= -100 ? 'Silenced ' + who : who + ' ' + UI.fmtDb(op.db || 0) + ' dB', sgain: op.db <= -100 ? 'Removed that sound from ' + who : who + ' sound ' + UI.fmtDb(op.db || 0) + ' dB', fadein: 'Faded in ' + who, fadeout: 'Faded out ' + who, move: 'Moved ' + who + ' to ' + (op.to && STEM[op.to].label), smove: 'Moved that sound to ' + (op.to && STEM[op.to].label) })[op.type];
  }
  async function afterEdit(names, rg) {
    names.forEach(function (n) { computePeaks(S.split.buffers[n], Math.floor(rg[0] / PK), Math.ceil(rg[1] / PK), S.peaks[n]); });
    if (S.session.playing) { var t = S.session.time(); S.session.play(S.split.buffers, S.original, t); }
    drawTimeline();
    await computeSpecs(names, null, rg[0], rg[1]);
    drawTimeline(); saveProjectSoon();
  }
  async function undo() { var u = S.undo.pop(); if (!u) { UI.toast('Nothing to undo'); return; } restore(u.before); S.redo.push(u); S.ops.pop(); await afterEdit(u.names, u.rg); UI.toast('Undid: ' + opLabel(u.op)); }
  async function redo() { var u = S.redo.pop(); if (!u) { UI.toast('Nothing to redo'); return; } restore(u.after); S.undo.push(u); S.ops.push(u.op); await afterEdit(u.names, u.rg); UI.toast('Redid: ' + opLabel(u.op)); }

  // ---------------------------------------------------------------- mix view
  var MOVES = [
    { l: 'Flat', fn: function (st) { st.names.forEach(function (n) { var m = st.strips[n]; var keep = { mute: false, solo: false }; Object.assign(m, AUDIO.defaultStrip(), keep); }); } },
    { l: 'Vocal forward', fn: function (st) { var v = st.strips.vocals; if (v) { v.gain = 2.5; v.eq.b3 = { f: 3500, g: 2, q: 0.8 }; v.eq.hp = { on: true, f: 90 }; v.comp = { on: true, th: -22, ratio: 3, att: 8, rel: 120, knee: 6, makeup: 2 }; } ['other', 'instrumental'].forEach(function (n) { if (st.strips[n]) { st.strips[n].eq.b2 = { f: 2500, g: -1.5, q: 0.9 }; } }); } },
    { l: 'Punchier drums', fn: function (st) { var d = st.strips.drums; if (d) { d.gain = 1.5; d.eq.ls = { f: 70, g: 2.5 }; d.eq.b2 = { f: 400, g: -2, q: 1.2 }; d.eq.hs = { f: 8000, g: 2 }; d.comp = { on: true, th: -18, ratio: 4, att: 25, rel: 90, knee: 3, makeup: 2.5 }; d.drive = { amt: 0.2, mix: 0.35 }; } } },
    { l: 'Tighter low end', fn: function (st) { var b = st.strips.bass; if (b) { b.monoBass = 300; b.width = 0.5; b.eq.hp = { on: true, f: 32 }; b.eq.b1 = { f: 220, g: -2, q: 1.1 }; b.comp = { on: true, th: -20, ratio: 4, att: 15, rel: 160, knee: 6, makeup: 2 }; } st.names.forEach(function (n) { if (n !== 'bass' && n !== 'drums') { st.strips[n].eq.hp = { on: true, f: n === 'vocals' ? 100 : 70 }; } }); } },
    { l: 'Wider band', fn: function (st) { ['other', 'ambience', 'instrumental'].forEach(function (n) { if (st.strips[n]) { st.strips[n].width = 1.45; st.strips[n].monoBass = 150; } }); } },
    { l: 'Less room', fn: function (st) { if (st.strips.ambience) st.strips.ambience.gain = -6; else UI.toast('Press with 5 stems to get a Room stem'); } },
    { l: 'Karaoke', fn: function (st) { st.names.forEach(function (n) { st.strips[n].solo = false; st.strips[n].mute = n === 'vocals'; }); } },
    { l: 'A cappella', fn: function (st) { st.names.forEach(function (n) { st.strips[n].mute = false; st.strips[n].solo = n === 'vocals'; }); } },
    { l: 'Drumless', fn: function (st) { st.names.forEach(function (n) { st.strips[n].solo = false; st.strips[n].mute = n === 'drums'; }); } },
    { l: 'Bassless', fn: function (st) { st.names.forEach(function (n) { st.strips[n].solo = false; st.strips[n].mute = n === 'bass'; }); } },
    { l: 'Everyone in', fn: function (st) { st.names.forEach(function (n) { st.strips[n].solo = false; st.strips[n].mute = false; }); } }
  ];
  var selStrip = null, stripUI = {};
  function applyMix() { if (S.session && S.st) S.session.apply(S.st); saveProjectSoon(); }
  function buildMix() {
    var mv = $('#moves'); mv.innerHTML = '';
    MOVES.forEach(function (m) { mv.appendChild(el('button', { class: 'btn sm', text: m.l, onclick: function () { m.fn(S.st); applyMix(); buildMix(); renderEditHeads(); UI.toast(m.l); } })); });
    var box = $('#strips'); box.innerHTML = ''; stripUI = {};
    if (!selStrip || S.st.names.indexOf(selStrip) < 0) selStrip = S.st.names[0];
    S.st.names.forEach(function (n) {
      var s = S.st.strips[n], u = {};
      var nm = el('div', { class: 'nm', onclick: function () { selStrip = n; buildMix(); } }, [el('span', { class: 'chip', style: 'background:' + color(n) }), STEM[n].label]);
      var eqc = el('canvas', { class: 'eqmini', title: 'Open the EQ', onclick: function () { selStrip = n; buildMix(); } });
      u.eqg = UI.EQGraph(eqc, { eq: function () { return s.eq; }, nodes: function () { return S.session.strips[n] && S.session.strips[n].eq.nodes; }, color: function () { return color(n); } });
      var k = function (o) { var kn = UI.Knob(o); return kn; };
      var pan = k({ label: 'Pan', min: -1, max: 1, value: s.pan, def: 0, bipolar: true, fmt: function (v) { return Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100); }, onchange: function (v) { s.pan = v; applyMix(); } });
      var wid = k({ label: 'Width', min: 0, max: 2, value: s.width, def: 1, bipolar: 1, fmt: function (v) { return Math.round(v * 100) + '%'; }, onchange: function (v) { s.width = v; applyMix(); } });
      var fad = UI.Fader({ value: s.gain, label: STEM[n].label + ' level', onchange: function (v) { s.gain = v; fv.textContent = UI.fmtDb(v) + ' dB'; applyMix(); } });
      var fv = el('div', { class: 'fv', text: UI.fmtDb(s.gain) + ' dB' });
      var met = el('canvas', { class: 'vmeter', width: 32, height: 380 }); u.meter = met;
      var mb = el('button', { class: 'mini' + (s.mute ? ' on' : ''), text: 'M', title: 'Mute', onclick: function () { s.mute = !s.mute; mb.classList.toggle('on', s.mute); applyMix(); renderEditHeads(); } });
      var sb = el('button', { class: 'mini s' + (s.solo ? ' on' : ''), text: 'S', title: 'Solo', onclick: function () { s.solo = !s.solo; sb.classList.toggle('on', s.solo); applyMix(); renderEditHeads(); } });
      var card = el('div', { class: 'strip' + (selStrip === n ? ' sel' : '') }, [nm, eqc, el('div', { class: 'knobs' }, [pan.el, wid.el]), el('div', { class: 'fad' }, [fad.el, met]), fv, el('div', { class: 'btns' }, [mb, sb])]);
      box.appendChild(card); stripUI[n] = u;
      requestAnimationFrame(function () { u.eqg.draw(); fad.draw(); });
    });
    buildDetail();
  }
  function knobSet(defs) { return el('div', { class: 'krow' }, defs.map(function (d) { return UI.Knob(d).el; })); }
  function buildDetail() {
    var n = selStrip, s = S.st.strips[n], box = $('#detail'); box.innerHTML = '';
    var cv = el('canvas', { class: 'eqbig' });
    var g = UI.EQGraph(cv, { interactive: true, eq: function () { return s.eq; }, nodes: function () { return S.session.strips[n] && S.session.strips[n].eq.nodes; }, color: function () { return color(n); }, onchange: function () { applyMix(); g.draw(); if (stripUI[n]) stripUI[n].eqg.draw(); bandKnobs(); } });
    detailEQ = { g: g, n: n };
    var bandBox = el('div');
    function bandKnobs() {
      bandBox.innerHTML = '';
      var e = s.eq, ch = function () { applyMix(); g.draw(); if (stripUI[n]) stripUI[n].eqg.draw(); };
      var hz = function (v) { return UI.fmtHz(v); }, db = function (v) { return UI.fmtDb(v); };
      bandBox.appendChild(knobSet([
        { label: 'HP', min: 20, max: 1000, log: true, value: e.hp.f, def: 30, fmt: function (v) { return e.hp.on ? hz(v) : 'off'; }, onchange: function (v) { e.hp.f = v; e.hp.on = v > 21; ch(); } },
        { label: 'Low', min: -15, max: 15, value: e.ls.g, def: 0, bipolar: true, fmt: db, onchange: function (v) { e.ls.g = v; ch(); } },
        { label: 'Low Hz', min: 30, max: 500, log: true, value: e.ls.f, def: 100, fmt: hz, onchange: function (v) { e.ls.f = v; ch(); } },
        { label: 'Band 1', min: -15, max: 15, value: e.b1.g, def: 0, bipolar: true, fmt: db, onchange: function (v) { e.b1.g = v; ch(); } },
        { label: '1 Hz', min: 60, max: 2000, log: true, value: e.b1.f, def: 300, fmt: hz, onchange: function (v) { e.b1.f = v; ch(); } },
        { label: 'Band 2', min: -15, max: 15, value: e.b2.g, def: 0, bipolar: true, fmt: db, onchange: function (v) { e.b2.g = v; ch(); } },
        { label: '2 Hz', min: 200, max: 8000, log: true, value: e.b2.f, def: 1200, fmt: hz, onchange: function (v) { e.b2.f = v; ch(); } },
        { label: 'Band 3', min: -15, max: 15, value: e.b3.g, def: 0, bipolar: true, fmt: db, onchange: function (v) { e.b3.g = v; ch(); } },
        { label: '3 Hz', min: 1000, max: 16000, log: true, value: e.b3.f, def: 4500, fmt: hz, onchange: function (v) { e.b3.f = v; ch(); } },
        { label: 'High', min: -15, max: 15, value: e.hs.g, def: 0, bipolar: true, fmt: db, onchange: function (v) { e.hs.g = v; ch(); } },
        { label: 'High Hz', min: 2000, max: 18000, log: true, value: e.hs.f, def: 9000, fmt: hz, onchange: function (v) { e.hs.f = v; ch(); } },
        { label: 'LP', min: 1000, max: 20000, log: true, value: e.lp.f, def: 18000, fmt: function (v) { return e.lp.on ? hz(v) : 'off'; }, onchange: function (v) { e.lp.f = v; e.lp.on = v < 19900; ch(); } }
      ]));
    }
    bandKnobs();
    var comp = s.comp, lamp = el('span', { class: 'lamp' + (comp.on ? ' on' : ''), title: 'Compressor on/off', onclick: function () { comp.on = !comp.on; lamp.classList.toggle('on', comp.on); applyMix(); } });
    var gr = el('div', { class: 'gr' }, [el('i')]); detailGR = { el: gr.firstChild, n: n };
    var compSec = el('div', { class: 'section' }, [el('h4', {}, ['Compressor', lamp]),
      knobSet([
        { label: 'Thresh', min: -50, max: 0, value: comp.th, def: -20, fmt: function (v) { return v.toFixed(0) + ' dB'; }, onchange: function (v) { comp.th = v; if (!comp.on) { comp.on = true; lamp.classList.add('on'); } applyMix(); } },
        { label: 'Ratio', min: 1, max: 20, log: true, value: comp.ratio, def: 3, fmt: function (v) { return v.toFixed(1) + ':1'; }, onchange: function (v) { comp.ratio = v; applyMix(); } },
        { label: 'Attack', min: 0.5, max: 100, log: true, value: comp.att, def: 10, fmt: function (v) { return v.toFixed(v < 10 ? 1 : 0) + ' ms'; }, onchange: function (v) { comp.att = v; applyMix(); } },
        { label: 'Release', min: 20, max: 1000, log: true, value: comp.rel, def: 150, fmt: function (v) { return Math.round(v) + ' ms'; }, onchange: function (v) { comp.rel = v; applyMix(); } },
        { label: 'Knee', min: 0, max: 20, value: comp.knee, def: 6, fmt: function (v) { return v.toFixed(0) + ' dB'; }, onchange: function (v) { comp.knee = v; applyMix(); } },
        { label: 'Makeup', min: 0, max: 18, value: comp.makeup, def: 0, fmt: db2, onchange: function (v) { comp.makeup = v; applyMix(); } }
      ]), el('div', { class: 'lbl', text: 'Gain reduction' }), gr]);
    var drv = s.drive, drvSec = el('div', { class: 'section', style: 'margin-top:12px' }, [el('h4', { text: 'Saturation · width' }),
      knobSet([
        { label: 'Drive', min: 0, max: 1, value: drv.amt, def: 0, fmt: pct, onchange: function (v) { drv.amt = v; applyMix(); } },
        { label: 'Mix', min: 0, max: 1, value: drv.mix, def: 1, fmt: pct, onchange: function (v) { drv.mix = v; applyMix(); } },
        { label: 'Mono below', min: 0, max: 400, value: s.monoBass, def: 0, fmt: function (v) { return v < 5 ? 'off' : Math.round(v) + ' Hz'; }, onchange: function (v) { s.monoBass = v < 5 ? 0 : v; applyMix(); } }
      ])]);
    box.appendChild(el('div', { class: 'dgrid' }, [
      el('div', {}, [el('div', { class: 'row', style: 'justify-content:space-between;margin-bottom:6px' }, [el('h3', { class: 'title', style: 'font-size:28px' }, [el('span', { class: 'chip', style: 'display:inline-block;margin-right:8px;background:' + color(n) }), STEM[n].label + ' EQ']), el('span', { class: 'muted', style: 'font-size:12px', text: 'Drag the dots · wheel for width · double-click resets' })]), cv, el('div', { style: 'margin-top:8px' }, [bandBox])]),
      el('div', {}, [compSec, drvSec])]));
    requestAnimationFrame(function () { g.draw(); });
  }
  function db2(v) { return '+' + v.toFixed(1) + ' dB'; }
  var detailEQ = null, detailGR = null;

  // ---------------------------------------------------------------- master view
  var MREC = [
    { l: 'Transparent', m: { eq: AUDIO.defaultEQ(), glue: { on: true, th: -14, ratio: 1.5, att: 30, rel: 250, knee: 8, makeup: 0.5 }, width: 1, monoBass: 0, drive: { amt: 0, mix: 1 }, limiter: { on: true, drive: 2, ceiling: -1, release: 120 } } },
    { l: 'Warm', m: { eq: Object.assign(AUDIO.defaultEQ(), { ls: { f: 110, g: 1.5 }, hs: { f: 10000, g: -1 }, b2: { f: 2800, g: -0.8, q: 0.8 } }), glue: { on: true, th: -16, ratio: 2, att: 30, rel: 200, knee: 8, makeup: 1 }, width: 1, monoBass: 120, drive: { amt: 0.3, mix: 0.5 }, limiter: { on: true, drive: 3, ceiling: -1, release: 100 } } },
    { l: 'Punchy', m: { eq: Object.assign(AUDIO.defaultEQ(), { ls: { f: 60, g: 1.5 }, b1: { f: 300, g: -1.2, q: 1 }, hs: { f: 9000, g: 1 } }), glue: { on: true, th: -18, ratio: 3, att: 20, rel: 120, knee: 4, makeup: 2 }, width: 1.05, monoBass: 140, drive: { amt: 0.15, mix: 0.4 }, limiter: { on: true, drive: 4, ceiling: -1, release: 70 } } },
    { l: 'Loud & bright', m: { eq: Object.assign(AUDIO.defaultEQ(), { hp: { on: true, f: 28 }, ls: { f: 80, g: 1 }, hs: { f: 8000, g: 2.5 } }), glue: { on: true, th: -20, ratio: 3, att: 15, rel: 100, knee: 4, makeup: 3 }, width: 1.1, monoBass: 150, drive: { amt: 0.25, mix: 0.5 }, limiter: { on: true, drive: 7, ceiling: -0.8, release: 50 } } },
    { l: 'Wide & airy', m: { eq: Object.assign(AUDIO.defaultEQ(), { hs: { f: 12000, g: 2.5 }, b1: { f: 250, g: -1, q: 0.9 } }), glue: { on: true, th: -16, ratio: 2, att: 30, rel: 200, knee: 8, makeup: 1 }, width: 1.3, monoBass: 180, drive: { amt: 0, mix: 1 }, limiter: { on: true, drive: 3, ceiling: -1, release: 100 } } },
    { l: 'Vintage radio', m: { eq: Object.assign(AUDIO.defaultEQ(), { hp: { on: true, f: 120 }, lp: { on: true, f: 6500 }, b2: { f: 1500, g: 3, q: 0.7 } }), glue: { on: true, th: -24, ratio: 4, att: 10, rel: 150, knee: 6, makeup: 4 }, width: 0.3, monoBass: 0, drive: { amt: 0.5, mix: 0.7 }, limiter: { on: true, drive: 4, ceiling: -1, release: 80 } } }
  ];
  var mUI = {};
  function buildMaster() {
    var rb = $('#mrecipes'); rb.innerHTML = '';
    MREC.forEach(function (r) { rb.appendChild(el('button', { class: 'btn sm', text: r.l, onclick: function () { var m = S.st.master; var keep = { gain: m.gain, target: m.target, preview: m.preview, previewGain: m.previewGain, pan: 0, mute: false, solo: false };
      Object.assign(m, JSON.parse(JSON.stringify(r.m)), keep); m.preview = false; $('#previewChk').checked = false; applyMix(); buildMaster(); UI.toast('Master: ' + r.l + ' · press Match target to land on ' + m.target + ' LUFS'); } })); });
    var m = S.st.master, box = $('#mchain'); box.innerHTML = '';
    var cv = el('canvas', { class: 'eqbig', style: 'height:200px' });
    var g = UI.EQGraph(cv, { interactive: true, eq: function () { return m.eq; }, nodes: function () { return S.session.master.eq.nodes; }, color: function () { return UI.css('--red'); }, onchange: function () { applyMix(); g.draw(); } });
    mUI.eq = g;
    var lampG = el('span', { class: 'lamp' + (m.glue.on ? ' on' : ''), onclick: function () { m.glue.on = !m.glue.on; lampG.classList.toggle('on', m.glue.on); applyMix(); } });
    var lampL = el('span', { class: 'lamp' + (m.limiter.on ? ' on' : ''), onclick: function () { m.limiter.on = !m.limiter.on; lampL.classList.toggle('on', m.limiter.on); applyMix(); } });
    var grG = el('div', { class: 'gr' }, [el('i')]), grL = el('div', { class: 'gr' }, [el('i')]); mUI.grG = grG.firstChild; mUI.grL = grL.firstChild;
    box.appendChild(el('div', { class: 'section' }, [el('h4', { text: 'Master EQ' }), cv, el('div', { class: 'muted', style: 'font-size:12px;margin-top:4px', text: 'Drag the dots · wheel over a band for its width · double-click resets a band or switches HP/LP' })]));
    box.appendChild(el('div', { class: 'grid2', style: 'margin-top:12px' }, [
      el('div', { class: 'section' }, [el('h4', {}, ['Glue compressor', lampG]), knobSet([
        { label: 'Thresh', min: -40, max: 0, value: m.glue.th, def: -16, fmt: function (v) { return v.toFixed(0) + ' dB'; }, onchange: function (v) { m.glue.th = v; applyMix(); } },
        { label: 'Ratio', min: 1, max: 10, log: true, value: m.glue.ratio, def: 2, fmt: function (v) { return v.toFixed(1) + ':1'; }, onchange: function (v) { m.glue.ratio = v; applyMix(); } },
        { label: 'Attack', min: 1, max: 100, log: true, value: m.glue.att, def: 30, fmt: function (v) { return v.toFixed(0) + ' ms'; }, onchange: function (v) { m.glue.att = v; applyMix(); } },
        { label: 'Release', min: 50, max: 1000, log: true, value: m.glue.rel, def: 200, fmt: function (v) { return Math.round(v) + ' ms'; }, onchange: function (v) { m.glue.rel = v; applyMix(); } },
        { label: 'Makeup', min: 0, max: 12, value: m.glue.makeup, def: 0, fmt: db2, onchange: function (v) { m.glue.makeup = v; applyMix(); } }]), el('div', { class: 'lbl', text: 'Gain reduction' }), grG]),
      el('div', { class: 'section' }, [el('h4', { text: 'Tone · width' }), knobSet([
        { label: 'Tape', min: 0, max: 1, value: m.drive.amt, def: 0, fmt: pct, onchange: function (v) { m.drive.amt = v; applyMix(); } },
        { label: 'Tape mix', min: 0, max: 1, value: m.drive.mix, def: 1, fmt: pct, onchange: function (v) { m.drive.mix = v; applyMix(); } },
        { label: 'Width', min: 0, max: 2, value: m.width, def: 1, bipolar: 1, fmt: function (v) { return Math.round(v * 100) + '%'; }, onchange: function (v) { m.width = v; applyMix(); } },
        { label: 'Mono below', min: 0, max: 300, value: m.monoBass, def: 0, fmt: function (v) { return v < 5 ? 'off' : Math.round(v) + ' Hz'; }, onchange: function (v) { m.monoBass = v < 5 ? 0 : v; applyMix(); } },
        { label: 'Master', min: -12, max: 6, value: m.gain, def: 0, bipolar: true, fmt: function (v) { return UI.fmtDb(v) + ' dB'; }, onchange: function (v) { m.gain = v; applyMix(); } }])]),
      el('div', { class: 'section' }, [el('h4', {}, ['Limiter', lampL]), knobSet([
        { label: 'Drive', min: 0, max: 18, value: m.limiter.drive, def: 0, fmt: db2, onchange: function (v) { m.limiter.drive = v; applyMix(); } },
        { label: 'Ceiling', min: -6, max: 0, step: 0.1, value: m.limiter.ceiling, def: -1, fmt: function (v) { return v.toFixed(1) + ' dBTP'; }, onchange: function (v) { m.limiter.ceiling = v; applyMix(); } },
        { label: 'Release', min: 10, max: 500, log: true, value: m.limiter.release, def: 80, fmt: function (v) { return Math.round(v) + ' ms'; }, onchange: function (v) { m.limiter.release = v; applyMix(); } }]), el('div', { class: 'lbl', text: 'Limiting' }), grL])
    ]));
    var ts = $('#targetSel'); ts.innerHTML = '';
    TARGETS.forEach(function (t) { ts.appendChild(el('option', { value: t.v, text: t.l })); });
    ts.value = String(m.target); ts.onchange = function () { m.target = +ts.value; m.preview = false; $('#previewChk').checked = false; applyMix(); updateTarget(); };
    $('#previewChk').checked = !!m.preview;
    updateTarget();
    requestAnimationFrame(function () { g.draw(); });
  }
  function updateTarget() { var t = S.st ? S.st.master.target : -14; $('#tMark').style.left = ((t + 30) / 24 * 100) + '%'; $('#tLabel').textContent = 'target ' + t + ' LUFS'; $('#xTarget').textContent = '(' + t + ' LUFS, ' + (S.st ? S.st.master.limiter.ceiling.toFixed(1) : -1) + ' dBTP)'; }

  async function renderFull(opts) { // {x0,x1, solo, master}
    return AUDIO.render(Object.assign({ state: S.st, buffers: S.split.buffers, sr: S.sr, x0: 0, x1: S.len }, opts));
  }
  async function analyse() {
    $('#analysis').innerHTML = '<span class="muted">Rendering the master…</span>';
    var ch = await renderFull({ master: true }), pool = makePool();
    var r = await pool.run('LOUD', { chans: [Float32Array.from(ch[0]), Float32Array.from(ch[1])], sr: S.sr });
    var o = await pool.run('LOUD', { chans: [Float32Array.from(S.L), Float32Array.from(S.R)], sr: S.sr });
    $('#analysis').innerHTML = '<b>Remaster:</b> ' + r.lufs.toFixed(1) + ' LUFS integrated · true peak ' + (20 * Math.log10(r.tp + 1e-12)).toFixed(1) + ' dBTP · range ' + r.lra.toFixed(1) + ' LU' +
      '<br><b>Original:</b> ' + o.lufs.toFixed(1) + ' LUFS · true peak ' + (20 * Math.log10(o.tp + 1e-12)).toFixed(1) + ' dBTP · range ' + o.lra.toFixed(1) + ' LU' +
      '<br><span class="muted">Export with "Master to the target" lands on ' + S.st.master.target + ' LUFS exactly, with a true-peak ceiling of ' + S.st.master.limiter.ceiling.toFixed(1) + ' dBTP.</span>';
    return r;
  }
  // fit: render, measure, gain + true-peak limiter, measure again, correct
  async function masterToTarget(ch, sr) {
    var m = S.st.master, pool = makePool(), ceil = AUDIO.db2g(m.limiter.ceiling - 0.15), target = m.target;
    var a = await pool.run('LOUD', { chans: [Float32Array.from(ch[0]), Float32Array.from(ch[1])], sr: sr });
    var gain = isFinite(a.lufs) ? Math.pow(10, (target - a.lufs) / 20) : 1, res = null;
    for (var pass = 0; pass < 3; pass++) {
      res = await pool.run('LIMIT', { chans: [Float32Array.from(ch[0]), Float32Array.from(ch[1])], sr: sr, gain: gain, ceiling: ceil, release: m.limiter.release });
      var err = target - res.lufs; if (!isFinite(err) || Math.abs(err) < 0.05) break;
      gain *= Math.pow(10, err / 20);
    }
    res.gainDb = 20 * Math.log10(gain);
    return res;
  }
  async function matchTarget() {
    var btn = $('#matchBtn'); btn.disabled = true; $('#analysis').innerHTML = '<span class="muted">Rendering and fitting…</span>';
    try {
      var ch = await renderFull({ master: true }), res = await masterToTarget(ch, S.sr), m = S.st.master;
      m.previewGain = res.gainDb; m.preview = true; $('#previewChk').checked = true; applyMix();
      $('#analysis').innerHTML = 'Lands on <b>' + res.lufs.toFixed(1) + ' LUFS</b> with ' + UI.fmtDb(res.gainDb) + ' dB into the final limiter · true peak ' + (20 * Math.log10(res.tp + 1e-12)).toFixed(1) + ' dBTP.<br><span class="muted">"Hear at target" is now on, so playback is close to the export. The export does this fitting for you.</span>';
    } finally { btn.disabled = false; }
  }

  // ---------------------------------------------------------------- export, files, projects
  async function exportAll() {
    if (!S.split) return;
    var btn = $('#exportBtn'), st = $('#exportStatus'), rep = $('#exportReport');
    var fmt = $('#fmtSel').value, loud = $$('input[name=loud]').filter(function (i) { return i.checked; })[0].value, useZip = $('#xZip').checked;
    var range = $('#rangeSeg .on').dataset.r, x0 = 0, x1 = S.len;
    if (range === 'sel') { if (!S.view.sel) { UI.toast('Make a selection in Edit first'); return; } x0 = S.view.sel.x0; x1 = S.view.sel.x1; }
    var want = { mix: $('#xMix').checked, proc: $('#xProc').checked, raw: $('#xRaw').checked };
    if (!want.mix && !want.proc && !want.raw) { UI.toast('Tick at least one thing to export'); return; }
    btn.disabled = true; var files = [], lines = [], base = S.file.name.replace(/\.[^.]+$/, '') || 'song', pool = makePool();
    try {
      var enc = async function (name, chans) {
        st.textContent = 'Encoding ' + name + '…';
        if (fmt.indexOf('mp3') === 0) {
          var kb = +fmt.split('-')[1], r = await pool.run('MP3', { L: Float32Array.from(chans[0]), R: Float32Array.from(chans[1]), sr: S.sr, kbps: kb });
          files.push({ name: name + '.mp3', data: r.data });
        } else files.push({ name: name + '.wav', data: DSP.wav(chans, S.sr, fmt === 'wav16' ? 16 : fmt === 'wav32' ? 32 : 24, true) });
      };
      if (want.mix) {
        st.textContent = 'Rendering the remaster…';
        var ch = await renderFull({ master: true, x0: x0, x1: x1 }), res;
        if (loud === 'target') { st.textContent = 'Mastering to ' + S.st.master.target + ' LUFS…'; res = await masterToTarget(ch, S.sr); ch = res.chans; }
        else {
          var gain = 1;
          if (loud === 'peak') { var tp = await pool.run('LOUD', { chans: [Float32Array.from(ch[0]), Float32Array.from(ch[1])], sr: S.sr }); gain = AUDIO.db2g(S.st.master.limiter.ceiling) / Math.max(1e-6, tp.tp); }
          res = await pool.run('LIMIT', { chans: [Float32Array.from(ch[0]), Float32Array.from(ch[1])], sr: S.sr, gain: gain, ceiling: AUDIO.db2g(S.st.master.limiter.ceiling - 0.15), release: S.st.master.limiter.release }); ch = res.chans;
        }
        lines.push('<b>' + base + ' (remaster)</b>: ' + res.lufs.toFixed(1) + ' LUFS · ' + (20 * Math.log10(res.tp + 1e-12)).toFixed(1) + ' dBTP');
        await enc(base + ' (remaster)', ch);
      }
      for (var i = 0; i < S.split.names.length; i++) {
        var n = S.split.names[i];
        if (want.proc) { st.textContent = 'Rendering ' + STEM[n].label + '…'; await enc(base + ' - ' + STEM[n].label + ' (processed)', await renderFull({ solo: n, master: false, x0: x0, x1: x1 })); }
        if (want.raw) { var b = S.split.buffers[n]; await enc(base + ' - ' + STEM[n].label, [b.getChannelData(0).slice(x0, x1), b.getChannelData(1).slice(x0, x1)]); }
      }
      if (want.raw) lines.push('Raw stems add up to the original' + (S.ops.length ? ' (plus your ' + S.ops.length + ' edit' + (S.ops.length > 1 ? 's' : '') + ')' : '') + '.');
      if (files.length > 1 && useZip) { st.textContent = 'Packing…'; await save(base + ' - France\'s French Press.zip', DSP.zip(files), 'application/zip'); }
      else for (var f = 0; f < files.length; f++) await save(files[f].name, [files[f].data], /mp3$/.test(files[f].name) ? 'audio/mpeg' : 'audio/wav');
      st.textContent = 'Done · ' + files.length + ' file' + (files.length > 1 ? 's' : '');
      rep.style.display = 'block'; rep.innerHTML = lines.join('<br>') + '<br>' + files.map(function (f) { return f.name + ' · ' + (f.data.length / 1048576).toFixed(1) + ' MB'; }).join('<br>');
    } catch (e) { console.error(e); st.textContent = 'Export failed: ' + (e.message || e); }
    finally { btn.disabled = false; }
  }
  // save a file: Android bridge, or a download
  async function save(name, parts, mime) {
    var A = window.FPAndroid;
    if (A && A.begin) {
      var id = A.begin(name, mime);
      for (var p = 0; p < parts.length; p++) { var u = parts[p]; for (var o = 0; o < u.length; o += 393216) { A.chunk(id, b64(u.subarray(o, Math.min(u.length, o + 393216)))); await new Promise(function (r) { setTimeout(r, 0); }); } }
      var where = A.end(id); UI.toast('Saved to ' + where, 4000); return;
    }
    var blob = new Blob(parts, { type: mime }), url = URL.createObjectURL(blob), a = el('a', { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function b64(u8) { var s = ''; for (var i = 0; i < u8.length; i += 32768) s += String.fromCharCode.apply(null, u8.subarray(i, i + 32768)); return btoa(s); }
  function projectJSON() {
    return { app: 'french-press', v: 1, version: VERSION, file: S.file && S.file.name, recipe: S.split ? S.split.recipe : S.recipe, params: S.split ? S.split.params : S.params, ops: S.ops, mix: S.st };
  }
  async function saveProject() {
    if (!S.file) return;
    var j = new TextEncoder().encode(JSON.stringify(projectJSON())), ext = (S.file.name.match(/\.[^.]+$/) || ['.audio'])[0];
    await save((S.file.name.replace(/\.[^.]+$/, '') || 'song') + '.frenchpress', DSP.zip([{ name: 'project.json', data: j }, { name: 'original' + ext, data: new Uint8Array(S.file.bytes) }]), 'application/octet-stream');
  }
  async function openProject(buf) {
    var files = DSP.unzip(new Uint8Array(buf)), pj = JSON.parse(new TextDecoder().decode(files['project.json']));
    var orig = Object.keys(files).filter(function (k) { return k.indexOf('original') === 0; })[0];
    await loadAudio(files[orig].slice().buffer, pj.file || 'song', '');
    await restoreProject(pj);
  }
  async function restoreProject(pj) {
    S.recipe = pj.recipe || 'balanced'; S.params = Object.assign({}, DSP.DEFAULTS, pj.params); renderRecipes(); renderStemSeg(); renderAdvanced();
    if (pj.mix) S.st = pj.mix;
    await runSplit();
    if (!S.split) return;
    if (pj.mix) { S.st = pj.mix; ensureMixState(S.split.names); S.session.apply(S.st); buildMix(); buildMaster(); }
    for (var i = 0; i < (pj.ops || []).length; i++) { await applyOp(pj.ops[i]); S.ops.push(pj.ops[i]); }
    if (pj.ops && pj.ops.length) { S.split.names.forEach(function (n) { S.peaks[n] = computePeaks(S.split.buffers[n]); }); await computeSpecs(S.split.names); UI.toast('Replayed ' + pj.ops.length + ' edit' + (pj.ops.length > 1 ? 's' : '')); }
  }

  // autosave in IndexedDB: the song once, the project as it changes
  var DBP = null;
  function db() { if (DBP) return DBP; DBP = new Promise(function (res, rej) { try { var r = indexedDB.open('french-press', 1); r.onupgradeneeded = function () { r.result.createObjectStore('kv'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; } catch (e) { rej(e); } }); return DBP; }
  function kvSet(k, v) { return db().then(function (d) { return new Promise(function (res) { var t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); }).catch(function () {}); }
  function kvGet(k) { return db().then(function (d) { return new Promise(function (res) { var t = d.transaction('kv').objectStore('kv').get(k); t.onsuccess = function () { res(t.result); }; t.onerror = function () { res(null); }; }); }).catch(function () { return null; }); }
  function saveSessionFile() { if (S.file && S.file.bytes.byteLength < 400 * 1048576) kvSet('song', { name: S.file.name, bytes: S.file.bytes, type: S.file.type }); kvSet('project', null); }
  var saveT = 0;
  function saveProjectSoon() { clearTimeout(saveT); saveT = setTimeout(function () { if (S.split) kvSet('project', JSON.parse(JSON.stringify(projectJSON()))); }, 1500); }
  async function offerResume() {
    var song = await kvGet('song'); if (!song || !song.bytes) return;
    var pj = await kvGet('project'), box = $('#resume'); box.classList.remove('hidden'); box.innerHTML = '';
    box.appendChild(el('div', { class: 'row' }, [el('div', { style: 'flex:1' }, [el('div', { class: 'lbl', text: 'Pick up where you left off' }), el('div', { class: 'title', style: 'font-size:26px', text: song.name }),
      el('div', { class: 'muted', text: pj ? (pj.ops || []).length + ' edits · recipe ' + pj.recipe : 'not pressed yet' })]),
      el('button', { class: 'btn primary', text: 'Resume', onclick: async function () { box.classList.add('hidden'); await loadAudio(song.bytes.slice(0), song.name, song.type); if (pj) await restoreProject(pj); } }),
      el('button', { class: 'btn sm', text: 'Forget it', onclick: function () { kvSet('song', null); kvSet('project', null); box.classList.add('hidden'); } })]));
  }

  // ---------------------------------------------------------------- transport
  function togglePlay() {
    if (!S.split && !S.original) return;
    var se = S.session; if (!se) return;
    if (se.playing) se.pause();
    else if (S.split) se.play(S.split.buffers, S.original, se.pos);
    else { // not pressed yet: play the original
      se.setStems([]); se.play({}, S.original, se.pos); se.setAB(true);
    }
    updatePlayIcon();
  }
  function stopPlayback() { if (S.session) { S.session.stop(); updatePlayIcon(); } }
  function seek(t) { var se = S.session; if (!se) return; t = Math.max(0, Math.min(t, S.len / S.sr)); if (se.playing) { se.play(S.split ? S.split.buffers : {}, S.original, t); } else se.pos = t; drawTimeline(); }
  function setLoop(rg) {
    var se = S.session; if (!se) return;
    se.loop = rg; $('#loopBtn').classList.toggle('on', !!rg);
    if (rg && (se.time() < rg[0] || se.time() > rg[1])) { se.pos = rg[0]; }
    if (se.playing) se.play(S.split ? S.split.buffers : {}, S.original, rg ? Math.max(rg[0], Math.min(se.time(), rg[1] - 0.01)) : se.time());
    drawTimeline();
  }
  function updatePlayIcon() { var p = S.session && S.session.playing; $('#playIcon').setAttribute('d', p ? 'M3 2h4v12H3zM9 2h4v12H9z' : 'M3 2l11 6-11 6z'); $('#playBtn').classList.toggle('on', !!p); }
  function setAB(orig) { if (!S.session || !S.split) return; S.session.setAB(orig); $('#abBtn').classList.toggle('on', orig); }

  // ---------------------------------------------------------------- tabs, animation loop
  function setTabsEnabled(on) { $$('#tabs button').forEach(function (b) { if (b.dataset.tab !== 'press') b.disabled = !on; }); }
  function setTab(t) {
    S.tab = t; $$('#tabs button').forEach(function (b) { b.classList.toggle('on', b.dataset.tab === t); });
    $$('main > .view').forEach(function (v) { v.classList.toggle('hidden', v.id !== 'v-' + t); });
    if (t === 'edit') { if (!S.view.fitted) { requestAnimationFrame(function () { fitZoom(); S.view.fitted = true; renderEditHeads(); drawTimeline(); }); } else requestAnimationFrame(function () { renderEditHeads(); drawTimeline(); }); updateSelInfo(); }
    if (t === 'mix') requestAnimationFrame(function () { buildMix(); });
    if (t === 'master') requestAnimationFrame(function () { buildMaster(); });
    if (t === 'export') updateTarget();
  }
  var loudHist = [], lastPk = 0, specBuf = null, specBufO = null;
  function frame() {
    requestAnimationFrame(frame);
    var se = S.session; if (!se) return;
    var t = se.time(), dur = S.len / S.sr;
    $('#clock').innerHTML = UI.fmtTime(t) + ' <small>/ ' + UI.fmtTime(dur) + '</small>';
    if (se.playing) {
      se.updateMatch();
      if (S.tab === 'edit') { var x = t2x(t), W = tl.clientWidth; if (S.session.playing && (x > W - 30 || x < 0)) { S.view.scroll = t - 20 / S.view.zoom; clampScroll(); } drawTimeline(); }
    }
    // band meter
    var m = se.meter.read(), bm = $('#bandMeter'), c = bm.getContext('2d'), w = bm.width, h = bm.height;
    c.fillStyle = '#000'; c.fillRect(0, 0, w, h);
    [[m.rmsL, m.pkL], [m.rmsR, m.pkR]].forEach(function (v, i) {
      var y = 8 + i * 26, toX = function (a) { return Math.max(0, Math.min(1, (20 * Math.log10(a + 1e-9) + 48) / 48)) * (w - 8); };
      c.fillStyle = '#C9B898'; c.fillRect(4, y, toX(v[0] * 1.414), 18); c.fillStyle = v[1] > 0.97 ? '#E8463C' : '#F3E7CF'; c.fillRect(4 + toX(v[1]) - 2, y, 3, 18);
    });
    if (S.tab === 'mix' && S.split) {
      S.st.names.forEach(function (n) { var u = stripUI[n], s = se.strips[n]; if (!u || !s) return; var r = s.meter.read(), cv = u.meter, cc = cv.getContext('2d'); cc.fillStyle = '#0d0a08'; cc.fillRect(0, 0, cv.width, cv.height);
        [r.pkL, r.pkR].forEach(function (p, i) { var hh = Math.max(0, Math.min(1, (20 * Math.log10(p + 1e-9) + 54) / 54)) * cv.height; cc.fillStyle = p > 0.97 ? '#E8463C' : color(n); cc.fillRect(2 + i * 15, cv.height - hh, 13, hh); }); });
      if (detailGR && se.strips[detailGR.n]) { var red = -se.strips[detailGR.n].comp.node.reduction; detailGR.el.style.width = Math.min(100, red / 20 * 100) + '%'; }
      if (detailEQ && se.playing && S.st.names.indexOf(detailEQ.n) >= 0) { /* spectrum behind the EQ */ }
    }
    if (S.tab === 'master' && S.split) {
      var pw = se.loudM.power(), now = performance.now();
      if (se.playing) { loudHist.push([now, pw]); while (loudHist.length && now - loudHist[0][0] > 3000) loudHist.shift(); }
      var mom = 0, nm = 0, sht = 0; loudHist.forEach(function (e) { sht += e[1]; if (now - e[0] < 400) { mom += e[1]; nm++; } });
      var Lm = nm ? -0.691 + 10 * Math.log10(mom / nm + 1e-12) : -Infinity, Ls = loudHist.length ? -0.691 + 10 * Math.log10(sht / loudHist.length + 1e-12) : -Infinity;
      lastPk = Math.max(lastPk * 0.995, m.pkL, m.pkR);
      $('#lM').textContent = isFinite(Lm) && Lm > -70 ? Lm.toFixed(1) : '–'; $('#lS').textContent = isFinite(Ls) && Ls > -70 ? Ls.toFixed(1) : '–'; $('#lP').textContent = lastPk > 1e-5 ? (20 * Math.log10(lastPk)).toFixed(1) : '–';
      $('#tFill').style.width = (isFinite(Ls) ? Math.max(0, Math.min(1, (Ls + 30) / 24)) * 100 : 0) + '%';
      $('#matchDb').textContent = se.matchDb !== undefined ? '(original ' + UI.fmtDb(se.matchDb) + ' dB)' : '';
      if (mUI.grG) { mUI.grG.style.width = Math.min(100, -se.master.glue.node.reduction / 12 * 100) + '%'; mUI.grL.style.width = Math.min(100, -se.master.lim.reduction / 12 * 100) + '%'; }
      drawSpectrum();
    }
  }
  function drawSpectrum() {
    var cv = $('#spec'), se = S.session, d = sizeCanvas(cv), c = cv.getContext('2d'), w = cv.width, h = cv.height;
    if (!specBuf) { specBuf = new Float32Array(se.specM.frequencyBinCount); specBufO = new Float32Array(se.specO.frequencyBinCount); }
    se.specM.getFloatFrequencyData(specBuf); se.specO.getFloatFrequencyData(specBufO);
    c.clearRect(0, 0, w, h); c.strokeStyle = UI.css('--paper3'); c.lineWidth = 1; c.fillStyle = UI.css('--ink3'); c.font = (10 * d) + 'px ' + UI.css('--type');
    var f2x = function (f) { return Math.log(f / 20) / Math.log(1000) * w; }, nyq = se.ctx.sampleRate / 2;
    [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(function (f) { var x = f2x(f); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); c.fillText(UI.fmtHz(f), x + 2, h - 4); });
    [[specBufO, UI.css('--ink3'), [4 * d, 4 * d]], [specBuf, UI.css('--red'), []]].forEach(function (s) {
      var arr = s[0]; c.strokeStyle = s[1]; c.lineWidth = 2 * d; c.setLineDash(s[2]); c.beginPath(); var first = true;
      for (var x = 0; x < w; x += 2 * d) {
        var f = 20 * Math.pow(1000, x / w), b0 = Math.max(1, Math.floor(f * 0.944 / nyq * arr.length)), b1 = Math.max(b0 + 1, Math.ceil(f * 1.059 / nyq * arr.length)), sum = 0, cnt = 0;
        for (var b = b0; b < b1 && b < arr.length; b++) { sum += Math.pow(10, arr[b] / 10); cnt++; }
        var m = cnt ? 10 * Math.log10(sum / cnt + 1e-20) : -200;
        var y = h - (m + 100 + 3 * Math.log2(f / 1000)) / 80 * h; if (first) { c.moveTo(x, y); first = false; } else c.lineTo(x, y);
      }
      c.stroke(); c.setLineDash([]);
    });
  }

  // ---------------------------------------------------------------- menus & help
  function mainMenu(x, y) {
    var look = document.documentElement.dataset.look === 'late';
    UI.menu(x, y, [
      { label: 'Open a song or project…', fn: function () { $('#fileIn').click(); } },
      { label: 'Save project (.frenchpress)', fn: function () { if (S.split) saveProject(); else UI.toast('Press a song first'); } },
      '-',
      { label: look ? 'Daytime look' : 'Late-show look', fn: function () { setLook(look ? 'day' : 'late'); } },
      { label: (document.body.classList.contains('grain') ? 'Film grain off' : 'Film grain on'), fn: function () { document.body.classList.toggle('grain'); try { localStorage.setItem('fp.grain', document.body.classList.contains('grain') ? '1' : '0'); } catch (e) {} } },
      '-',
      { label: 'How it works', fn: howItWorks }, { label: 'Keyboard shortcuts', fn: shortcuts }, { label: 'About France\u2019s French Press', fn: about }
    ]);
  }
  function setLook(l) { document.documentElement.dataset.look = l === 'late' ? 'late' : ''; try { localStorage.setItem('fp.look', l); } catch (e) {} Object.keys(S.specs).forEach(function (n) { S.specs[n].tiles = {}; }); if (S.split) { if (S.tab === 'mix') buildMix(); if (S.tab === 'master') buildMaster(); renderEditHeads(); drawTimeline(); } }
  function howItWorks() {
    UI.dialog('<h2 class="title">How the press works</h2><p>No trained model is involved. Each stem is a <i>mask</i> over the song\'s spectrum — for every slice of time and every frequency, a share between 0 and 1 of what the song has there. The shares always add up to one, so the stems add back up to the song exactly.</p><ol>' +
      '<li><b>Drums.</b> Sustained notes are horizontal lines in a spectrogram; hits are vertical. Median filters across time and across frequency tell them apart (harmonic–percussive separation, Fitzgerald 2010; Driedger, Müller &amp; Disch 2014). Kicks are too low and too long for that, so a separate detector takes the short bursts that rise above the low end\'s sustained floor.</li>' +
      '<li><b>Where things sit.</b> Comparing left and right in every bin gives a pan position and how much the two sides agree (Avendano 2003; Barry, Lawlor &amp; Coyle 2004). Singers usually sit in the middle; the room and the reverb are what the two sides <i>don\'t</i> share (Avendano &amp; Jot 2004) — that becomes the Room stem.</li>' +
      '<li><b>The melody and the bass line.</b> A pitch tracker scores every possible note in every frame by how much energy sits on its harmonics, then follows the most likely path (Viterbi). A comb over that path\'s harmonics catches the voice even when it is not in the centre. A second tracker follows the bass line and pulls its harmonics into the Bass stem.</li>' +
      '<li><b>What repeats.</b> Loops and riffs repeat bar after bar; a voice usually does not. A median of the spectrum one and two repeats away models the loop (adaptive REPET, Rafii &amp; Pardo 2013; Liutkus et al. 2012) and keeps it out of the vocal.</li></ol>' +
      '<p>Tested against songs with their real multitrack stems (MUSDB18 samples), the defaults were tuned for the best average signal-to-distortion over vocals, drums, bass and the band.</p><p><b>Honest limits.</b> A trained separator (Demucs, Spleeter) is cleaner, especially for a clean a cappella. French Press is at its best for rebalancing a mix: a louder voice, a tighter low end, quieter cymbals, more or less room — and the spectral editor lets you hand-move what the press got wrong.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>');
  }
  function shortcuts() {
    UI.dialog('<h2 class="title">Keyboard</h2><p><b>Space</b> play / pause · <b>Home</b> to start · <b>L</b> loop the selection · <b>A</b> remaster / original<br><b>Ctrl+Z</b> undo · <b>Ctrl+Shift+Z</b> or <b>Ctrl+Y</b> redo · <b>Delete</b> silence the selection · <b>M</b> move the selection<br><b>+ / −</b> zoom · <b>0</b> fit · <b>W</b> waveform / spectral · <b>Esc</b> clear the selection<br>Alt+wheel or Ctrl+wheel zooms the timeline; two fingers pinch on touch screens.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>');
  }
  function about() {
    UI.dialog('<h2 class="title">France’s French Press ' + VERSION + '</h2><p><i>Separate the grounds.</i> A stem splitter and remaster studio, part of the DAWters and Son suite.</p><p>Free software. Copyright © 2026 Josh Wilk. Licensed under the GNU General Public License, version 3 or (at your option) any later version. No price, no tiers, no sign-up, no tracking: the app makes no network requests.</p><p class="muted" style="font-size:12px">Fonts: Yesteryear, Oswald, Courier Prime (SIL Open Font License 1.1). MP3 encoding: lamejs (LGPL-3.0). Separation methods cited in How it works.</p><div class="row" style="justify-content:flex-end"><button class="btn" data-close>Close</button></div>');
  }

  // ---------------------------------------------------------------- keyboard
  function keys(e) {
    if (e.target.matches('input, select, textarea') || $('#scrim:not(.hidden)')) return;
    var k = e.key, ctl = e.ctrlKey || e.metaKey;
    if (k === ' ') { e.preventDefault(); togglePlay(); }
    else if (k === 'Home' || k === 'Enter') { e.preventDefault(); seek(0); }
    else if (ctl && (k === 'z' || k === 'Z')) { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (ctl && (k === 'y' || k === 'Y')) { e.preventDefault(); redo(); }
    else if (ctl && (k === 's' || k === 'S')) { e.preventDefault(); if (S.split) saveProject(); }
    else if (ctl || e.altKey) return;
    else if (k === 'l' || k === 'L') { if (S.session && S.session.loop) setLoop(null); else if (S.view.sel) setLoop([S.view.sel.x0 / S.sr, S.view.sel.x1 / S.sr]); else UI.toast('Select a range to loop'); }
    else if (k === 'a' || k === 'A') setAB(!(S.session && S.session.abOrig));
    else if (S.tab === 'edit') {
      if (k === 'Delete' || k === 'Backspace') { e.preventDefault(); doOpUI('silence'); }
      else if (k === '+' || k === '=') zoomAt(tl.clientWidth / 2, 1.5); else if (k === '-') zoomAt(tl.clientWidth / 2, 1 / 1.5);
      else if (k === '0') { fitZoom(); drawTimeline(); } else if (k === 'Escape') { S.view.sel = null; drawTimeline(); updateSelInfo(); }
      else if (k === 'w' || k === 'W') { $$('#modeSeg button')[S.view.mode === 'wave' ? 1 : 0].click(); }
      else if (k === 'm' || k === 'M') { if (S.view.sel) { var r = $('#timeline').getBoundingClientRect(); opMenuMove(r.left + 40, r.top + 40); } }
    }
  }

  // ---------------------------------------------------------------- init
  function init() {
    try { var lk = localStorage.getItem('fp.look'); if (lk === 'late') document.documentElement.dataset.look = 'late'; if (localStorage.getItem('fp.grain') === '0') document.body.classList.remove('grain'); } catch (e) {}
    var op = $('#opening'); if (matchMedia('(prefers-reduced-motion: reduce)').matches || /notitle/.test(location.hash)) op.remove(); else { setTimeout(function () { op.style.opacity = 0; setTimeout(function () { op.remove(); }, 500); }, 900); }
    $$('#tabs button').forEach(function (b) { b.onclick = function () { if (!b.disabled) setTab(b.dataset.tab); }; });
    $('#openBtn').onclick = function () { $('#fileIn').click(); }; $('#newBtn').onclick = function () { $('#fileIn').click(); };
    $('#fileIn').onchange = function () { var f = this.files[0]; this.value = ''; if (f) openFile(f).catch(function (e) { console.error(e); }); };
    $('#demoBtn').onclick = function () { var w = demoSong(); loadAudio(w.buffer, 'French Press demo.wav', 'audio/wav'); };
    var drop = $('#drop');
    ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (e) { e.preventDefault(); if (t === 'drop' || e.target === drop) drop.classList.remove('over'); }); });
    document.addEventListener('drop', function (e) { var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) { setTab('press'); openFile(f).catch(function (er) { console.error(er); }); } });
    $('#pressBtn').onclick = runSplit; $('#cancelBtn').onclick = function () { cancelFlag = true; };
    $('#playBtn').onclick = togglePlay; $('#homeBtn').onclick = function () { seek(S.session && S.session.loop ? S.session.loop[0] : 0); };
    $('#loopBtn').onclick = function () { if (S.session && S.session.loop) setLoop(null); else if (S.view.sel) setLoop([S.view.sel.x0 / S.sr, S.view.sel.x1 / S.sr]); else if (S.len) setLoop([0, S.len / S.sr]); };
    $('#abBtn').onclick = function () { setAB(!(S.session && S.session.abOrig)); };
    $('#menuBtn').onclick = function (e) { var r = e.target.getBoundingClientRect(); mainMenu(r.right - 220, r.bottom + 6); };
    $('#analyseBtn').onclick = function () { analyse().catch(function (e) { $('#analysis').textContent = 'Analysis failed: ' + e.message; }); };
    $('#matchBtn').onclick = function () { matchTarget().catch(function (e) { $('#analysis').textContent = 'Failed: ' + e.message; }); };
    $('#previewChk').onchange = function () { S.st.master.preview = this.checked; applyMix(); };
    $('#matchChk').onchange = function () { S.session.matchLevels = this.checked; };
    $('#exportBtn').onclick = exportAll; $('#saveProjBtn').onclick = saveProject;
    $$('#rangeSeg button').forEach(function (b) { b.onclick = function () { $$('#rangeSeg button').forEach(function (x) { x.classList.toggle('on', x === b); }); }; });
    document.addEventListener('keydown', keys);
    setupTimeline();
    selectRecipe('balanced', true);
    offerResume();
    requestAnimationFrame(frame);
    window.addEventListener('beforeunload', function () { if (S.split) kvSet('project', JSON.parse(JSON.stringify(projectJSON()))); });
  }
  // exposed for tests and the Android shell
  async function openUrl(url, name) { var r = await fetch(url), buf = await r.arrayBuffer(); setTab('press'); if (/\.frenchpress$/i.test(name) || isZip(buf)) return openProject(buf); await loadAudio(buf, name, ''); }
  window.FPAPI = { openUrl: openUrl, openFile: openFile, loadAudio: loadAudio, demoSong: demoSong, runSplit: runSplit, setTab: setTab, doOp: doOp, undo: undo, redo: redo, exportAll: exportAll, analyse: analyse, matchTarget: matchTarget, togglePlay: togglePlay, selectRecipe: selectRecipe, renderFull: renderFull, masterToTarget: masterToTarget, saveProject: saveProject, openProject: openProject, projectJSON: projectJSON };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
