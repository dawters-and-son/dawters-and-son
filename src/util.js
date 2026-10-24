// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — utilities: math, ids, WAV, ZIP, IndexedDB, peaks
'use strict';
const U = {};
U.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
U.db = (g) => (g <= 0.000001 ? -Infinity : 20 * Math.log10(g));
U.undb = (d) => (d === -Infinity ? 0 : Math.pow(10, d / 20));
U.uid = (p) => (p || 'x') + Date.now().toString(36).slice(-5) + Math.random().toString(36).slice(2, 7);
U.fmtDb = (d, dp = 1) => (d === -Infinity || d < -96 ? '-∞' : (d > 0 ? '+' : '') + d.toFixed(dp));
U.fmtTime = (s) => {
  const neg = s < 0; s = Math.abs(s);
  const m = Math.floor(s / 60), sec = s - m * 60;
  return (neg ? '-' : '') + String(m).padStart(2, '0') + ':' + sec.toFixed(3).padStart(6, '0');
};
U.fmtBars = (s, bpm, sig) => {
  const beat = 60 / bpm, b = s / beat;
  const neg = b < 0, ab = Math.abs(b);
  const bar = Math.floor(ab / sig[0]), bt = Math.floor(ab - bar * sig[0]), tick = Math.floor((ab - Math.floor(ab)) * 960);
  return (neg ? '-' : '') + String(bar + 1).padStart(3, '0') + '.' + (bt + 1) + '.' + String(tick).padStart(3, '0');
};
U.debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
U.esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- WAV ----------
// bits: 16 (TPDF dither), 24, 32 (float)
U.encodeWav = (channels, sr, bits, dither) => {
  const nch = channels.length, n = channels[0].length;
  const bps = bits === 32 ? 4 : bits / 8;
  const dataLen = n * nch * bps;
  const buf = new ArrayBuffer(44 + dataLen), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, bits === 32 ? 3 : 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bps, true); v.setUint16(32, nch * bps, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, dataLen, true);
  let o = 44;
  if (bits === 32) {
    const f = new Float32Array(buf, 44, n * nch);
    for (let i = 0, k = 0; i < n; i++) for (let c = 0; c < nch; c++) f[k++] = channels[c][i];
  } else if (bits === 16) {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      let s = channels[c][i] * 32767;
      if (dither) s += (Math.random() - Math.random());
      s = Math.round(s); if (s > 32767) s = 32767; else if (s < -32768) s = -32768;
      v.setInt16(o, s, true); o += 2;
    }
  } else {
    for (let i = 0; i < n; i++) for (let c = 0; c < nch; c++) {
      let s = Math.round(channels[c][i] * 8388607); if (s > 8388607) s = 8388607; else if (s < -8388608) s = -8388608;
      v.setUint8(o, s & 255); v.setUint8(o + 1, (s >> 8) & 255); v.setUint8(o + 2, (s >> 16) & 255); o += 3;
    }
  }
  return new Uint8Array(buf);
};
// Decode WAV we wrote ourselves (PCM 16/24/32, float 32) at original rate — avoids resampling on load
U.decodeWav = (u8) => {
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
  let o = 12, fmt = null, data = null;
  while (o + 8 <= u8.length) {
    const id = str(o, 4), len = v.getUint32(o + 4, true);
    if (id === 'fmt ') fmt = { tag: v.getUint16(o + 8, true), nch: v.getUint16(o + 10, true), sr: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    else if (id === 'data') { data = { o: o + 8, len: Math.min(len, u8.length - o - 8) }; }
    o += 8 + len + (len & 1);
  }
  if (!fmt || !data) return null;
  let tag = fmt.tag;
  if (tag === 0xfffe) tag = fmt.bits === 32 ? 3 : 1;
  const bps = fmt.bits / 8, n = Math.floor(data.len / (bps * fmt.nch));
  const ch = []; for (let c = 0; c < fmt.nch; c++) ch.push(new Float32Array(n));
  let p = data.o;
  for (let i = 0; i < n; i++) for (let c = 0; c < fmt.nch; c++) {
    let s;
    if (tag === 3 && fmt.bits === 32) s = v.getFloat32(p, true);
    else if (tag === 3 && fmt.bits === 64) s = v.getFloat64(p, true);
    else if (fmt.bits === 16) s = v.getInt16(p, true) / 32768;
    else if (fmt.bits === 24) { let x = u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16); if (x & 0x800000) x |= ~0xffffff; s = x / 8388608; }
    else if (fmt.bits === 32) s = v.getInt32(p, true) / 2147483648;
    else if (fmt.bits === 8) s = (u8[p] - 128) / 128;
    else s = 0;
    ch[c][i] = s; p += bps;
  }
  return { sr: fmt.sr, ch };
};

// ---------- CRC32 + ZIP (store) ----------
U.crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
U.crc32 = (u8) => { let c = 0xffffffff; const t = U.crcTable; for (let i = 0; i < u8.length; i++) c = t[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
U.zip = (files) => { // files: [{name, data:Uint8Array}] -> Blob
  const enc = new TextEncoder(), parts = [], cen = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = U.crc32(f.data), size = f.data.length;
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
    h.setUint16(10, 0, true); h.setUint16(12, 0x21, true); h.setUint32(14, crc, true); h.setUint32(18, size, true); h.setUint32(22, size, true);
    h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
    parts.push(new Uint8Array(h.buffer), name, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
    c.setUint16(12, 0, true); c.setUint16(14, 0x21, true); c.setUint32(16, crc, true); c.setUint32(20, size, true); c.setUint32(24, size, true);
    c.setUint16(28, name.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), name);
    off += 30 + name.length + size;
  }
  const cenLen = cen.reduce((a, b) => a + b.length, 0);
  const e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cenLen, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/zip' });
};
U.unzip = async (blobOrBuf) => { // stored or deflated (DecompressionStream) entries
  const u8 = blobOrBuf instanceof Uint8Array ? blobOrBuf : new Uint8Array(await blobOrBuf.arrayBuffer());
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let e = u8.length - 22; while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error('Not a zip file');
  const count = v.getUint16(e + 10, true); let p = v.getUint32(e + 16, true);
  const dec = new TextDecoder(), out = {};
  for (let i = 0; i < count; i++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true), lho = v.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const ln = v.getUint16(lho + 26, true), lx = v.getUint16(lho + 28, true);
    const data = u8.subarray(lho + 30 + ln + lx, lho + 30 + ln + lx + csize);
    if (method === 0) out[name] = data;
    else if (method === 8 && typeof DecompressionStream !== 'undefined') {
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      out[name] = new Uint8Array(await new Response(ds).arrayBuffer());
    }
    p += 46 + nlen + xlen + clen;
  }
  return out;
};

// ---------- IndexedDB ----------
U.idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('dawters-and-suns', 1);
    r.onupgradeneeded = () => { const db = r.result; db.createObjectStore('kv'); db.createObjectStore('buffers'); };
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  }));
  const tx = async (store, mode, fn) => { const db = await open(); return new Promise((res, rej) => { const t = db.transaction(store, mode); const s = t.objectStore(store); const r = fn(s); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); };
  return {
    get: (store, k) => tx(store, 'readonly', (s) => s.get(k)),
    put: (store, k, v) => tx(store, 'readwrite', (s) => s.put(v, k)),
    del: (store, k) => tx(store, 'readwrite', (s) => s.delete(k)),
    keys: (store) => tx(store, 'readonly', (s) => s.getAllKeys()),
    clear: (store) => tx(store, 'readwrite', (s) => s.clear()),
  };
})();

// ---------- Waveform peaks ----------
U.LEVELS = [32, 128, 512, 2048, 8192];
U.computePeaks = (ab) => {
  const n = ab.length, nch = ab.numberOfChannels, chs = [];
  for (let c = 0; c < nch; c++) chs.push(ab.getChannelData(c));
  const levels = [];
  const base = U.LEVELS[0], m0 = Math.ceil(n / base), pk = new Float32Array(m0 * 2);
  for (let b = 0; b < m0; b++) {
    let mn = 0, mx = 0; const s = b * base, e = Math.min(n, s + base);
    for (let c = 0; c < nch; c++) { const d = chs[c]; for (let i = s; i < e; i++) { const x = d[i]; if (x < mn) mn = x; else if (x > mx) mx = x; } }
    pk[b * 2] = mn; pk[b * 2 + 1] = mx;
  }
  levels.push(pk);
  for (let l = 1; l < U.LEVELS.length; l++) {
    const prev = levels[l - 1], f = U.LEVELS[l] / U.LEVELS[l - 1], m = Math.ceil(prev.length / 2 / f), cur = new Float32Array(m * 2);
    for (let b = 0; b < m; b++) {
      let mn = 0, mx = 0;
      for (let k = b * f; k < Math.min(prev.length / 2, (b + 1) * f); k++) { if (prev[k * 2] < mn) mn = prev[k * 2]; if (prev[k * 2 + 1] > mx) mx = prev[k * 2 + 1]; }
      cur[b * 2] = mn; cur[b * 2 + 1] = mx;
    }
    levels.push(cur);
  }
  return levels;
};

U.download = (blob, name) => {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
};
U.pickFile = (accept, multiple) => new Promise((res) => {
  const i = document.createElement('input'); i.type = 'file'; i.accept = accept || ''; i.multiple = !!multiple;
  i.style.display = 'none'; document.body.appendChild(i);
  i.onchange = () => { res(Array.from(i.files || [])); i.remove(); };
  i.click();
});
// Float32 audio <-> base64 (how the suite apps hand samples to each other inside JSON)
U.f32b64 = (f) => { const u = new Uint8Array(f.buffer, f.byteOffset, f.byteLength); let s = ''; for (let i = 0; i < u.length; i += 32768) s += String.fromCharCode.apply(null, u.subarray(i, i + 32768)); return btoa(s); };
U.b64f32 = (s) => { const b = atob(s), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return new Float32Array(u.buffer); };
