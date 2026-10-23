// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — ffmpeg encoder worker (runs ffmpeg.wasm, single-threaded core).
// The page fetches the core script and wasm itself and hands them over, so the worker never touches the network.
//   in:  { type:'init', core: <blob url of ffmpeg-core.js>, wasm: ArrayBuffer }
//        { id, input: ArrayBuffer (wav), args: [...], out: 'name.ext' }
//   out: { id:'init', ok } | { id, progress } | { id, data: ArrayBuffer } | { id, error }
let mod = null;
self.onmessage = async (e) => {
  const d = e.data;
  if (d.type === 'init') {
    try { importScripts(d.core); mod = await WebAssembly.compile(d.wasm); self.postMessage({ id: 'init', ok: true }); }
    catch (x) { self.postMessage({ id: 'init', error: String((x && x.message) || x) }); }
    return;
  }
  const log = [];
  try {
    if (!mod) throw new Error('encoder not loaded');
    // a fresh instance per job: the core is not safe to run twice
    const c = await self.createFFmpegCore({
      instantiateWasm: (imports, done) => { WebAssembly.instantiate(mod, imports).then((inst) => done(inst, mod)); return {}; },
      locateFile: (p) => p,
    });
    c.setLogger((m) => { log.push(m.message); if (log.length > 40) log.shift(); });
    c.setProgress((p) => self.postMessage({ id: d.id, progress: Math.max(0, Math.min(1, p.progress)) }));
    c.FS.writeFile('in.wav', new Uint8Array(d.input));
    const r = c.exec('-hide_banner', '-i', 'in.wav', ...d.args, d.out);
    if (r !== 0) throw new Error('ffmpeg exited with ' + r + ': ' + log.slice(-3).join(' | '));
    const out = c.FS.readFile(d.out);
    self.postMessage({ id: d.id, data: out.buffer }, [out.buffer]);
  } catch (x) { self.postMessage({ id: d.id, error: String((x && x.message) || x) }); }
};
