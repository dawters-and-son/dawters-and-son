// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
//
// The plug-in relay. Runs in an Electron utility process, between the studio and the native
// plug-in host (dawters-plughost, which runs the VST3 plug-ins in a process of its own):
//   • control ports (the page's main thread): create / destroy / state / editor windows / scanning
//   • audio ports (one per AudioContext, held by the audio worklet itself): blocks of samples
//     in and out, so the audio never waits on the page's main thread
// If the host crashes, every port hears about it ({ev:'crashed'}) and the next request starts a new one.
'use strict';
const { spawn, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const HOST = process.env.PLUGHOST;
const CACHE = process.env.PLUG_CACHE;
const controls = new Set();
let host = null;      // { proc, buf, queue: [{port, seq, id, nch}], pend: Map(q -> {port, q}), nextQ }

function log(...a) { try { process.stderr.write('[plugrelay] ' + a.join(' ') + '\n'); } catch (e) { /* */ } }

// ------------------------------------------------------------------------------------- the host
function startHost() {
  if (host) return host;
  if (!HOST || !fs.existsSync(HOST)) return null;
  const proc = spawn(HOST, ['--serve'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const h = { proc, buf: Buffer.alloc(0), queue: [], pend: new Map(), nextQ: 1 };
  host = h;
  proc.stdout.on('data', (d) => { h.buf = h.buf.length ? Buffer.concat([h.buf, d]) : d; parse(h); });
  proc.stderr.on('data', (d) => log(String(d).trimEnd()));
  proc.stdin.on('error', () => { /* the host went away; 'exit' handles it */ });
  proc.on('exit', (code, sig) => {
    if (host !== h) return;
    host = null;
    log('host exited', code, sig || '');
    // answer everything still waiting so no worklet stalls
    for (const r of h.queue) r.port.postMessage({ t: 'a', id: r.id, seq: r.seq, ch: null, lost: true });
    for (const p of h.pend.values()) p.port.postMessage({ q: p.q, ok: false, error: 'The plug-in host stopped' });
    const crashed = code !== 0 || sig;
    for (const c of controls) c.postMessage({ ev: crashed ? 'crashed' : 'stopped' });
  });
  return h;
}

function parse(h) {
  while (h.buf.length >= 8) {
    const type = h.buf.readUInt32LE(0), len = h.buf.readUInt32LE(4);
    if (h.buf.length < 8 + len) return;
    const body = h.buf.subarray(8, 8 + len);
    h.buf = h.buf.subarray(8 + len);
    if (type === 1) {
      let m; try { m = JSON.parse(body.toString('utf8')); } catch (e) { continue; }
      if (m.ev) { for (const c of controls) c.postMessage(m); continue; }
      const p = h.pend.get(m.q); if (!p) continue;
      h.pend.delete(m.q); m.q = p.q; p.port.postMessage(m);
    } else if (type === 3) {
      const r = h.queue.shift(); if (!r) continue;
      const id = body.readUInt32LE(0), frames = body.readUInt32LE(4), nch = body.readUInt32LE(8), status = body.readUInt32LE(12);
      const ch = [];
      for (let c = 0; c < nch; c++) {
        const f = new Float32Array(frames);
        Buffer.from(f.buffer).set(body.subarray(16 + c * frames * 4, 16 + (c + 1) * frames * 4));
        ch.push(f);
      }
      r.port.postMessage({ t: 'a', id, seq: r.seq, ch, status });
    }
  }
}

function writeFrame(h, type, parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const hdr = Buffer.alloc(8); hdr.writeUInt32LE(type, 0); hdr.writeUInt32LE(len, 4);
  h.proc.stdin.write(parts.length ? Buffer.concat([hdr, ...parts]) : hdr);
}

function sendJson(h, obj) { writeFrame(h, 1, [Buffer.from(JSON.stringify(obj), 'utf8')]); }

// one block of audio from a worklet: {t:'a', id, seq, ch:[Float32Array], ev:[[offset,kind,chan,d1,value]], tempo, ppq, flags, ts}
function audio(port, m) {
  const h = startHost();
  if (!h) { port.postMessage({ t: 'a', id: m.id, seq: m.seq, ch: null, lost: true }); return; }
  const ch = m.ch || [], frames = m.fr || (ch[0] ? ch[0].length : 0), ev = m.ev || [];
  const head = Buffer.alloc(40);
  head.writeUInt32LE(m.id >>> 0, 0); head.writeUInt32LE(frames, 4); head.writeUInt32LE(ch.length, 8); head.writeUInt32LE(ev.length, 12);
  head.writeDoubleLE(m.tempo || 120, 16); head.writeDoubleLE(m.ppq || 0, 24); head.writeUInt32LE(m.flags || 0, 32); head.writeUInt32LE(m.ts || 0x0404, 36);
  const evb = Buffer.alloc(ev.length * 12);
  ev.forEach((e, i) => { const o = i * 12; evb.writeInt32LE(e[0] | 0, o); evb.writeUInt8(e[1] & 255, o + 4); evb.writeUInt8(e[2] & 15, o + 5); evb.writeUInt8(e[3] & 127, o + 6); evb.writeUInt8(0, o + 7); evb.writeFloatLE(e[4] || 0, o + 8); });
  const parts = [head, evb];
  for (const c of ch) parts.push(Buffer.from(c.buffer, c.byteOffset, frames * 4));
  h.queue.push({ port, seq: m.seq, id: m.id });
  writeFrame(h, 2, parts);
}

// ------------------------------------------------------------------------------------- scanning
function run(args, timeoutMs) {
  return new Promise((res) => {
    execFile(HOST, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 }, (err, out) => {
      let j = null; try { j = JSON.parse(String(out).trim().split('\n').pop()); } catch (e) { /* */ }
      res({ err, j });
    });
  });
}

function findBundles(dir, depth, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (/\.vst3$/i.test(e.name)) out.add(p);
    else if (e.isDirectory() && depth > 0) findBundles(p, depth - 1, out);
  }
}

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { return {}; } }
function saveCache(c) { try { fs.writeFileSync(CACHE, JSON.stringify(c)); } catch (e) { /* */ } }

let scanning = null;
async function scan(opts, progress) {
  if (!HOST || !fs.existsSync(HOST)) return { ok: false, error: 'The plug-in host is not installed with this build' };
  const found = new Set();
  const std = await run(['--paths'], 20000);
  for (const p of (std.j || [])) found.add(p);
  for (const d of opts.dirs || []) findBundles(d, 4, found);
  const cache = opts.rescan ? {} : loadCache();
  const next = {}, todo = [];
  for (const p of found) {
    let mt = 0; try { mt = fs.statSync(p).mtimeMs; } catch (e) { continue; }
    if (cache[p] && cache[p].mt === mt && !(opts.retry && cache[p].error)) next[p] = cache[p]; else todo.push([p, mt]);
  }
  let done = 0;
  const worker = async () => {
    while (todo.length) {
      const [p, mt] = todo.shift();
      const r = await run(['--scan', p], 30000);
      next[p] = r.j && r.j.ok ? { mt, classes: r.j.classes } : { mt, classes: [], error: (r.j && r.j.error) || (r.err && r.err.killed ? 'took too long to load' : 'crashed while loading') };
      done++; progress({ ev: 'scan', done, total: done + todo.length, path: p });
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  saveCache(next);
  const list = [], failed = [];
  for (const p of Object.keys(next).sort()) {
    const e = next[p];
    if (e.error) failed.push({ path: p, error: e.error });
    for (const c of e.classes) list.push(Object.assign({ path: p }, c));
  }
  return { ok: true, plugins: list, failed };
}

// ------------------------------------------------------------------------------------- ports
function control(port, m) {
  if (m.cmd === 'scan') {
    if (!scanning) scanning = scan(m, (p) => { for (const c of controls) c.postMessage(p); }).finally(() => { scanning = null; });
    scanning.then((r) => port.postMessage(Object.assign({ q: m.q }, r)));
    return;
  }
  if (m.cmd === 'cached') {
    const c = loadCache(), list = [];
    for (const p of Object.keys(c)) for (const k of c[p].classes || []) list.push(Object.assign({ path: p }, k));
    port.postMessage({ q: m.q, ok: true, plugins: list, available: !!(HOST && fs.existsSync(HOST)) });
    return;
  }
  const h = startHost();
  if (!h) { port.postMessage({ q: m.q, ok: false, error: 'The plug-in host is not installed with this build' }); return; }
  const q = h.nextQ++;
  h.pend.set(q, { port, q: m.q });
  sendJson(h, Object.assign({}, m, { q }));
}

process.parentPort.on('message', (e) => {
  const port = e.ports && e.ports[0]; if (!port) return;
  const kind = e.data && e.data.kind;
  if (kind === 'control') controls.add(port);
  port.on('message', (ev) => {
    const m = ev.data; if (!m) return;
    if (m.t === 'a') audio(port, m); else control(port, m);
  });
  port.on('close', () => controls.delete(port));
  port.start();
});
