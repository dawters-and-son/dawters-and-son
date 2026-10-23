// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — export formats. WAV is written here; everything smaller goes through ffmpeg:
// the bundled native ffmpeg in the Mac app, ffmpeg.wasm (in ff/) everywhere else.
'use strict';
const ENC = {
  // id: [label, ext, kbps (for size estimates; 0 = lossless/variable), native args, wasm args]
  FORMATS: {
    wav16: ['WAV · 16-bit (dithered)', 'wav'], wav24: ['WAV · 24-bit', 'wav'], wav32: ['WAV · 32-bit float', 'wav'],
    flac: ['FLAC · lossless, about half the size', 'flac', 0, ['-c:a', 'flac', '-compression_level', '8']],
    mp3_320: ['MP3 · 320 kbps', 'mp3', 320, ['-c:a', 'libmp3lame', '-b:a', '320k']],
    mp3_256: ['MP3 · 256 kbps', 'mp3', 256, ['-c:a', 'libmp3lame', '-b:a', '256k']],
    mp3_192: ['MP3 · 192 kbps', 'mp3', 192, ['-c:a', 'libmp3lame', '-b:a', '192k']],
    mp3_128: ['MP3 · 128 kbps (smallest MP3)', 'mp3', 128, ['-c:a', 'libmp3lame', '-b:a', '128k']],
    aac_256: ['AAC (.m4a) · 256 kbps', 'm4a', 256, ['-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart']],
    aac_160: ['AAC (.m4a) · 160 kbps', 'm4a', 160, ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']],
    ogg_q6: ['Ogg Vorbis · ~192 kbps', 'ogg', 192, ['-c:a', 'libvorbis', '-q:a', '6']],
    opus_128: ['Opus · 128 kbps', 'opus', 128, ['-c:a', 'libopus', '-b:a', '128k', '-ar', '48000'], ['-c:a', 'opus', '-strict', '-2', '-b:a', '128k', '-ar', '48000', '-ac', '2']],
    opus_64: ['Opus · 64 kbps (voice memo size)', 'opus', 64, ['-c:a', 'libopus', '-b:a', '64k', '-ar', '48000'], ['-c:a', 'opus', '-strict', '-2', '-b:a', '64k', '-ar', '48000', '-ac', '2']],
  },
  isWav: (f) => f.startsWith('wav'),
  ext: (f) => ENC.FORMATS[f][1],
  bits: (f) => ({ wav16: 16, wav24: 24, wav32: 32 })[f] || 24,
  estimate(f, secs, sr) {
    const F = ENC.FORMATS[f];
    if (ENC.isWav(f)) return secs * sr * 2 * ENC.bits(f) / 8;
    if (f === 'flac') return secs * sr * 2 * 2 * 0.55;
    return secs * F[2] * 1000 / 8;
  },
  fmtSize: (b) => b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB',
  // what this build can encode with: 'native' | 'wasm' | null
  async backend() {
    if (window.dawNative && window.dawNative.encode) { try { if (await window.dawNative.hasFfmpeg()) return 'native'; } catch (e) { /* fall through */ } }
    if (/^(https?):$/.test(location.protocol)) return 'wasm';
    return null;
  },
  // ---- ffmpeg.wasm: loaded once, on first use (about 32 MB from the app's own files) ----
  _w: null, _ready: null, _seq: 0,
  loadWasm(onNote) {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      onNote && onNote('Loading the encoder (first time only)…');
      const base = new URL('ff/', location.href).href;
      const [js, wasm] = await Promise.all([
        fetch(base + 'ffmpeg-core.js').then((r) => { if (!r.ok) throw new Error('encoder files missing (ff/ffmpeg-core.js)'); return r.text(); }),
        fetch(base + 'ffmpeg-core.wasm').then((r) => { if (!r.ok) throw new Error('encoder files missing (ff/ffmpeg-core.wasm)'); return r.arrayBuffer(); }),
      ]);
      const coreUrl = URL.createObjectURL(new Blob([js], { type: 'application/javascript' }));
      const w = new Worker(URL.createObjectURL(new Blob([FFW_SRC], { type: 'application/javascript' })));
      await new Promise((res, rej) => {
        const f = (e) => { if (e.data.id !== 'init') return; w.removeEventListener('message', f); e.data.ok ? res() : rej(new Error(e.data.error)); };
        w.addEventListener('message', f); w.onerror = (e) => rej(new Error(e.message || 'encoder failed to start'));
        w.postMessage({ type: 'init', core: coreUrl, wasm }, [wasm]);
      });
      this._w = w;
    })();
    this._ready.catch(() => { this._ready = null; });
    return this._ready;
  },
  // wav: a WAV file (ArrayBuffer or Uint8Array — handed over, not copied); returns Uint8Array of the encoded file
  async encode(wav, f, meta, onProg, onNote) {
    const F = ENC.FORMATS[f], ext = F[1];
    if (!(wav instanceof ArrayBuffer)) wav = wav.byteOffset === 0 && wav.byteLength === wav.buffer.byteLength ? wav.buffer : wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
    const md = []; if (meta) for (const k of ['title', 'artist', 'album', 'comment']) if (meta[k]) md.push('-metadata', k + '=' + meta[k]);
    const be = await this.backend();
    if (be === 'native') {
      onNote && onNote('Encoding with ffmpeg…');
      const r = await window.dawNative.encode(wav, [...F[3], ...md], ext);
      if (r.error) throw new Error(r.error);
      return new Uint8Array(r.data);
    }
    if (be !== 'wasm') throw new Error('Compressed formats need the studio served from localhost (use the Start script) or the Mac/Android app');
    await this.loadWasm(onNote);
    onNote && onNote('Encoding ' + ext.toUpperCase() + '…');
    const id = ++this._seq, w = this._w;
    return new Promise((res, rej) => {
      const fn = (e) => {
        const m = e.data; if (m.id !== id) return;
        if ('progress' in m) { onProg && onProg(m.progress); return; }
        w.removeEventListener('message', fn);
        m.error ? rej(new Error(m.error)) : res(new Uint8Array(m.data));
      };
      w.addEventListener('message', fn);
      w.postMessage({ id, input: wav, args: [...(F[4] || F[3]), ...md], out: 'out.' + ext }, [wav]);
    });
  },
  MIME: { wav: 'audio/wav', flac: 'audio/flac', mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', zip: 'application/zip' },
};
