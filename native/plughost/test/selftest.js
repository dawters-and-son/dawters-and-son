// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// Checks a dawters-plughost build against the VST3 SDK's sample plug-ins:
//   node selftest.js <dawters-plughost> <folder with .vst3 bundles> [--editors]
// scans every bundle, plays a test signal through several effects and instruments, round-trips their
// state, then drives the --serve protocol the way DAWters does (create, audio blocks, state, destroy).
// With --editors (Mac and Windows) it also opens and closes plug-in windows.
'use strict';
const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const [host, dir] = process.argv.slice(2);
const editors = process.argv.includes('--editors');
let failures = 0;
const fail = (msg) => { failures++; console.log('FAIL ' + msg); };
const ok = (msg) => console.log('ok   ' + msg);
const run = (args) => {
  try { return JSON.parse(execFileSync(host, args, { timeout: 60000, encoding: 'utf8' }).trim().split('\n').pop()); }
  catch (e) { const out = String(e.stdout || '').trim().split('\n').pop(); try { return JSON.parse(out); } catch (x) { return { ok: false, error: e.message.split('\n')[0] }; } }
};

// ---- scan
const bundles = fs.readdirSync(dir).filter((n) => n.endsWith('.vst3')).map((n) => path.join(dir, n));
const classes = [];
for (const b of bundles) {
  const r = run(['--scan', b]);
  if (!r.ok) { console.log('skip ' + path.basename(b) + ': ' + r.error); continue; }
  for (const c of r.classes) classes.push(Object.assign({ path: b }, c));
}
console.log(classes.length + ' plug-in classes in ' + bundles.length + ' bundles');
if (classes.length < 10) fail('expected the SDK samples to offer at least 10 classes');

// ---- play through some of them
const pick = ['ADelay', 'AGain VST3', 'mda Delay', 'mda Degrade', 'mda Ambience', 'mda Limiter', 'mda JX10', 'mda DX10', 'mda Piano', 'Note Expression Synth'];
for (const name of pick) {
  const c = classes.find((x) => x.name === name); if (!c) { console.log('skip ' + name + ' (not built)'); continue; }
  const r = run(['--selftest', c.path, c.cid]);
  if (r.ok && r.finite && r.stateRoundTrip) ok(name + ': out ' + r.rmsOutDb.toFixed(1) + ' dB, latency ' + r.latency + ', state ' + r.stateBytes + ' bytes' + (r.instrument ? ' (instrument)' : ''));
  else fail(name + ': ' + JSON.stringify(r));
}

// ---- the --serve protocol
function serveTest() {
  return new Promise((resolve) => {
    const p = spawn(host, ['--serve'], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
    let buf = Buffer.alloc(0); const waits = [];
    const next = () => new Promise((r) => { waits.push(r); pump(); });
    function pump() {
      while (waits.length && buf.length >= 8) {
        const type = buf.readUInt32LE(0), len = buf.readUInt32LE(4); if (buf.length < 8 + len) return;
        const body = buf.subarray(8, 8 + len); buf = buf.subarray(8 + len);
        if (type === 1) { const m = JSON.parse(body.toString()); if (m.ev) continue; waits.shift()({ type, m }); }
        else waits.shift()({ type, body });
      }
    }
    p.stdout.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
    const send = (type, payload) => { const h = Buffer.alloc(8); h.writeUInt32LE(type, 0); h.writeUInt32LE(payload.length, 4); p.stdin.write(Buffer.concat([h, payload])); };
    const json = (o) => send(1, Buffer.from(JSON.stringify(o)));
    const audio = (id, frames, chans) => {
      const head = Buffer.alloc(40); head.writeUInt32LE(id, 0); head.writeUInt32LE(frames, 4); head.writeUInt32LE(chans.length, 8); head.writeUInt32LE(0, 12);
      head.writeDoubleLE(120, 16); head.writeDoubleLE(0, 24); head.writeUInt32LE(1, 32); head.writeUInt32LE(0x0404, 36);
      send(2, Buffer.concat([head, ...chans.map((c) => Buffer.from(c.buffer))]));
    };
    (async () => {
      const t = setTimeout(() => { fail('serve: timed out'); p.kill(); resolve(); }, 30000);
      json({ q: 1, cmd: 'hello' }); const h = (await next()).m;
      if (h.ok) ok('serve: hello ' + h.platform + ' ' + h.version + (h.editors ? ' (editors)' : '')); else fail('serve: hello');
      const ag = classes.find((x) => x.name === 'AGain VST3') || classes.find((x) => !x.instrument);
      json({ q: 2, cmd: 'create', path: ag.path, cid: ag.cid, sr: 48000, block: 1024 }); const cr = (await next()).m;
      if (!cr.ok) { fail('serve: create ' + JSON.stringify(cr)); p.kill(); clearTimeout(t); return resolve(); }
      ok('serve: created ' + cr.name + ' as #' + cr.id + ', ' + cr.ins + ' in / ' + cr.outs + ' out, editor ' + cr.editor);
      // 200 blocks of a sine; AGain at its default should pass it through
      let maxErr = 0;
      for (let k = 0; k < 200; k++) {
        const L = new Float32Array(128); for (let i = 0; i < 128; i++) L[i] = 0.5 * Math.sin((k * 128 + i) / 9);
        audio(cr.id, 128, [L, L]);
        const r = await next();
        const nch = r.body.readUInt32LE(8), st = r.body.readUInt32LE(12);
        if (r.type !== 3 || nch < 1 || st !== 0) { fail('serve: bad audio reply'); break; }
        for (let i = 0; i < 128; i++) maxErr = Math.max(maxErr, Math.abs(r.body.readFloatLE(16 + i * 4) - L[i]));
      }
      if (maxErr < 1e-3 || ag.name !== 'AGain VST3') ok('serve: 200 audio blocks, max difference ' + maxErr.toExponential(2)); else fail('serve: audio changed by ' + maxErr);
      json({ q: 3, cmd: 'getState', id: cr.id }); const gs = (await next()).m;
      if (gs.ok && gs.state && gs.state.c) ok('serve: state ' + gs.state.c.length + ' chars'); else fail('serve: getState ' + JSON.stringify(gs));
      json({ q: 4, cmd: 'setState', id: cr.id, state: gs.state }); const ss = (await next()).m;
      if (ss.ok) ok('serve: setState'); else fail('serve: setState');
      if (editors) {
        json({ q: 5, cmd: 'editor', id: cr.id, open: true }); const ed = (await next()).m;
        if (ed.ok) ok('serve: editor window opened'); else fail('serve: editor ' + JSON.stringify(ed));
        await new Promise((r) => setTimeout(r, 1000));
        json({ q: 6, cmd: 'editor', id: cr.id, open: false }); const ec = (await next()).m;
        if (ec.ok) ok('serve: editor window closed'); else fail('serve: editor close');
      }
      json({ q: 7, cmd: 'destroy', id: cr.id }); const de = (await next()).m;
      if (de.ok) ok('serve: destroyed'); else fail('serve: destroy');
      // an unknown instance passes audio through untouched
      const L = new Float32Array(128).fill(0.25); audio(999, 128, [L]); const pt = await next();
      if (pt.body.readUInt32LE(12) === 1 && Math.abs(pt.body.readFloatLE(16) - 0.25) < 1e-6) ok('serve: unknown instance passes through'); else fail('serve: pass-through');
      json({ cmd: 'quit' });
      p.on('exit', (code) => { clearTimeout(t); if (code === 0) ok('serve: quit cleanly'); else fail('serve: exit code ' + code); resolve(); });
    })().catch((e) => { fail('serve: ' + e.message); p.kill(); resolve(); });
  });
}

(async () => {
  await serveTest();
  if (editors) {
    for (const name of ['AGain VST3', 'Note Expression Synth With UI']) {
      const c = classes.find((x) => x.name === name); if (!c) { console.log('skip editor ' + name); continue; }
      const r = run(['--edtest', c.path, c.cid]);
      if (r.ok) ok('editor: ' + name + ' ' + r.w + '×' + r.h + ' opened and closed'); else fail('editor: ' + name + ' ' + JSON.stringify(r));
    }
  }
  console.log(failures ? failures + ' failure(s)' : 'all good');
  process.exit(failures ? 1 : 0);
})();
