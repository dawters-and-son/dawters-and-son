// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — UI kit: knobs, faders, meters, menus, dialogs, toasts
'use strict';
const K = {};
K.h = (tag, attrs, ...kids) => {
  const e = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    const v = attrs[k];
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'html') e.innerHTML = v; else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) e.append(c.nodeType ? c : document.createTextNode(c));
  return e;
};

// ---------- value mapping ----------
K.norm = (s, v) => {
  if (s.opts) return v / Math.max(1, s.opts.length - 1);
  if (s.log) return Math.log(v / s.min) / Math.log(s.max / s.min);
  return (v - s.min) / (s.max - s.min);
};
K.denorm = (s, n) => {
  n = U.clamp(n, 0, 1);
  if (s.opts) return Math.round(n * (s.opts.length - 1));
  if (s.log) return s.min * Math.pow(s.max / s.min, n);
  const v = s.min + n * (s.max - s.min);
  return s.step ? Math.round(v / s.step) * s.step : v;
};
K.fmt = (s, v) => {
  if (s.opts) return s.opts[v];
  if (s.fmt) return s.fmt(v);
  const u = s.u || '';
  if (u === 'Hz') return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + 'k' : Math.round(v) + '';
  if (u === 'dB') return (v > 0 ? '+' : '') + v.toFixed(1);
  if (u === 'ms') return v < 10 ? v.toFixed(1) + 'ms' : Math.round(v) + 'ms';
  if (u === 's') return v.toFixed(2) + 's';
  if (u === '%') return Math.round(v) + '%';
  if (s.max <= 1 && s.min >= 0) return Math.round(v * 100) + '%';
  return (Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v)) + (u ? ' ' + u : '');
};

// spec: {n, min, max, def, u, log, opts, bipolar, size, color, get(), set(v, final)}
K.knob = (s) => {
  const el = K.h('div', { class: 'knob' + (s.size ? ' ' + s.size : '') + (s.bipolar ? ' bi' : ''), tabindex: 0, role: 'slider', 'aria-label': s.n });
  const dial = K.h('div', { class: 'dial' }), ptr = K.h('div', { class: 'ptr' }), val = K.h('div', { class: 'val' });
  dial.append(ptr);
  el.append(val, dial, K.h('label', null, s.n));
  if (s.color) el.style.setProperty('--c', s.color);
  const show = () => { const v = s.get(); el.style.setProperty('--v', K.norm(s, v)); val.textContent = K.fmt(s, v); el.setAttribute('aria-valuetext', val.textContent); };
  let start = null, sv = 0, moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId); start = e.clientY; sv = K.norm(s, s.get()); moved = false; el.classList.add('active'); s.begin && s.begin();
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (start === null) return;
    const span = e.shiftKey ? 600 : 160;
    const n = U.clamp(sv + (start - e.clientY) / span, 0, 1);
    moved = true; s.set(K.denorm(s, n), false); show();
  });
  const end = () => { if (start === null) return; start = null; el.classList.remove('active'); if (moved) s.set(s.get(), true); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { if (s.def !== undefined) { s.begin && s.begin(); s.set(s.def, true); show(); } });
  el.addEventListener('wheel', (e) => { e.preventDefault(); s.begin && s.begin(); const n = U.clamp(K.norm(s, s.get()) - Math.sign(e.deltaY) * (s.opts ? 1 / Math.max(1, s.opts.length - 1) : e.shiftKey ? 0.005 : 0.025), 0, 1); s.set(K.denorm(s, n), true); show(); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const st = s.opts ? 1 / Math.max(1, s.opts.length - 1) : e.shiftKey ? 0.005 : 0.03;
    let d = 0; if (e.key === 'ArrowUp' || e.key === 'ArrowRight') d = st; else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') d = -st; else return;
    e.preventDefault(); e.stopPropagation(); s.begin && s.begin(); s.set(K.denorm(s, K.norm(s, s.get()) + d), true); show();
  });
  el.refresh = show; show();
  return el;
};

// ---------- fader dB curve ----------
K.FDB = [[0, -Infinity], [0.04, -70], [0.12, -50], [0.24, -36], [0.38, -24], [0.52, -14], [0.64, -8], [0.76, 0], [0.88, 3], [1, 6]];
K.posToDb = (p) => { const T = K.FDB; if (p <= 0) return -Infinity; for (let i = 1; i < T.length; i++) if (p <= T[i][0]) { const a = T[i - 1], b = T[i]; if (a[1] === -Infinity) return -90 + (b[1] + 90) * (p - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * (p - a[0]) / (b[0] - a[0]); } return 6; };
K.dbToPos = (d) => { const T = K.FDB; if (d === -Infinity || d < -90) return 0; for (let i = 1; i < T.length; i++) { const a = T[i - 1], b = T[i]; const lo = a[1] === -Infinity ? -90 : a[1]; if (d <= b[1]) return a[0] + (b[0] - a[0]) * (d - lo) / (b[1] - lo); } return 1; };
// spec: {get():gain, set(gain, final), begin()}
K.fader = (s) => {
  const el = K.h('div', { class: 'fader', tabindex: 0, role: 'slider', 'aria-label': s.n || 'Fader' });
  const ticks = K.h('div', { class: 'ticks' });
  [6, 0, -6, -12, -24, -48].forEach((d) => { const i = K.h('i', { class: d === 0 ? 'z' : '' }); i.style.top = (1 - K.dbToPos(d)) * 100 + '%'; ticks.append(i); });
  const cap = K.h('div', { class: 'cap' });
  el.append(K.h('div', { class: 'slot-line' }), ticks, cap);
  const show = () => { const p = K.dbToPos(U.db(s.get())); cap.style.top = 'calc(10px + ' + (1 - p) + ' * (100% - 20px))'; s.onShow && s.onShow(); };
  let sy = null, sp = 0, moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    el.setPointerCapture(e.pointerId); sy = e.clientY; sp = K.dbToPos(U.db(s.get())); moved = false; s.begin && s.begin();
    const r = el.getBoundingClientRect(), cr = cap.getBoundingClientRect();
    if (e.clientY < cr.top - 4 || e.clientY > cr.bottom + 4) { const p = U.clamp(1 - (e.clientY - r.top - 10) / (r.height - 20), 0, 1); sp = p; s.set(U.undb(K.posToDb(p)), false); show(); moved = true; }
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (sy === null) return;
    const h = el.getBoundingClientRect().height - 20, k = e.shiftKey ? 0.2 : 1;
    const p = U.clamp(sp + (sy - e.clientY) / h * k, 0, 1);
    moved = true; s.set(U.undb(K.posToDb(p)), false); show();
  });
  const end = () => { if (sy === null) return; sy = null; if (moved) s.set(s.get(), true); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { s.begin && s.begin(); s.set(1, true); show(); });
  el.addEventListener('wheel', (e) => { e.preventDefault(); s.begin && s.begin(); const d = U.db(s.get()); const nd = (d === -Infinity ? -60 : d) - Math.sign(e.deltaY) * (e.shiftKey ? 0.1 : 1); s.set(nd < -89 ? 0 : U.undb(Math.min(6, nd)), true); show(); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    let d = 0; if (e.key === 'ArrowUp') d = 1; else if (e.key === 'ArrowDown') d = -1; else return;
    e.preventDefault(); e.stopPropagation(); s.begin && s.begin(); const cd = U.db(s.get()); const nd = (cd === -Infinity ? -60 : cd) + d * (e.shiftKey ? 0.1 : 1); s.set(nd < -89 ? 0 : U.undb(Math.min(6, nd)), true); show();
  });
  el.refresh = show; show();
  return el;
};

// horizontal fader: {get, set, begin, onShow}
K.hfader = (s) => {
  const el = K.h('div', { class: 'hfader', tabindex: 0, role: 'slider', 'aria-label': s.n || 'Volume' });
  const fill = K.h('div', { class: 'hf-fill' }), cap = K.h('div', { class: 'hf-cap' }), zero = K.h('i', { class: 'hf-zero' });
  zero.style.left = K.dbToPos(0) * 100 + '%';
  el.append(K.h('div', { class: 'hf-track' }, fill, zero), cap);
  const show = () => { const p = K.dbToPos(U.db(s.get())); cap.style.left = 'calc(' + p + ' * (100% - 30px))'; fill.style.width = p * 100 + '%'; el.setAttribute('aria-valuetext', U.fmtDb(U.db(s.get())) + ' dB'); s.onShow && s.onShow(); };
  let sx = null, sp = 0, moved = false;
  const setFromX = (x) => { const r = el.getBoundingClientRect(); const p = U.clamp((x - r.left - 15) / (r.width - 30), 0, 1); s.set(U.undb(K.posToDb(p)), false); show(); };
  el.addEventListener('pointerdown', (e) => {
    el.setPointerCapture(e.pointerId); sx = e.clientX; moved = false; s.begin && s.begin();
    sp = K.dbToPos(U.db(s.get()));
    const cr = cap.getBoundingClientRect();
    if (e.clientX < cr.left - 6 || e.clientX > cr.right + 6) { setFromX(e.clientX); moved = true; sp = K.dbToPos(U.db(s.get())); sx = e.clientX; }
    e.preventDefault(); e.stopPropagation();
  });
  el.addEventListener('pointermove', (e) => {
    if (sx === null) return;
    const w = el.getBoundingClientRect().width - 30, k = e.shiftKey ? 0.2 : 1;
    moved = true; s.set(U.undb(K.posToDb(U.clamp(sp + (e.clientX - sx) / w * k, 0, 1))), false); show();
  });
  const end = () => { if (sx === null) return; sx = null; if (moved) s.set(s.get(), true); };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => { s.begin && s.begin(); s.set(1, true); show(); });
  el.addEventListener('keydown', (e) => {
    let d = 0; if (e.key === 'ArrowRight' || e.key === 'ArrowUp') d = 1; else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') d = -1; else return;
    e.preventDefault(); e.stopPropagation(); s.begin && s.begin(); const cd = U.db(s.get()); const nd = (cd === -Infinity ? -60 : cd) + d; s.set(nd < -89 ? 0 : U.undb(Math.min(6, nd)), true); show();
  });
  el.refresh = show; show();
  return el;
};

// ---------- meters (vertical canvas) ----------
K.meterState = () => ({ v: [0, 0], hold: [0, 0], ht: [0, 0], clip: [false, false] });
K.dbToMeter = (d) => U.clamp((d + 60) / 66, 0, 1); // -60..+6
K.drawMeter = (cv, st, vals, opt) => {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const n = vals.length, now = performance.now(), horiz = opt && opt.horiz;
  for (let c = 0; c < n; c++) {
    const lin = vals[c] || 0, d = U.db(lin);
    let m = K.dbToMeter(d);
    st.v[c] = m > st.v[c] ? m : Math.max(m, st.v[c] - 0.022);
    if (m >= st.hold[c] || now - st.ht[c] > 1400) { st.hold[c] = m; st.ht[c] = now; }
    if (lin >= 0.999) st.clip[c] = true;
    const L = horiz ? w : h, cw = (horiz ? h : w) / n;
    const len = st.v[c] * L;
    const T = K.T || { text: '#000', acc: '#FF2B00', surface: '#fff' };
    const zero = K.dbToMeter(-3) * L;
    g.fillStyle = T.text;
    if (horiz) g.fillRect(0, c * cw, Math.min(len, zero), cw); else g.fillRect(c * cw, h - Math.min(len, zero), cw, Math.min(len, zero));
    if (len > zero) { g.fillStyle = T.acc; if (horiz) g.fillRect(zero, c * cw, len - zero, cw); else g.fillRect(c * cw, h - len, cw, len - zero); }
    // raw segment cuts
    g.fillStyle = T.surface;
    for (let k = 3; k < L; k += 3) { if (horiz) g.fillRect(k, c * cw, 1, cw); else g.fillRect(c * cw, h - k, cw, 1); }
    if (n > 1) { if (horiz) g.fillRect(0, c * cw, w, c ? 1 : 0); else g.fillRect(c * cw, 0, c ? 1 : 0, h); }
    const hp = st.hold[c] * L;
    g.fillStyle = st.clip[c] || hp > zero ? T.acc : T.text;
    if (horiz) g.fillRect(Math.max(0, hp - 2), c * cw, 2, cw); else g.fillRect(c * cw, Math.max(0, h - hp), cw, 2);
  }
  if (!horiz && h > 80 && !(opt && opt.noScale)) {
    g.fillStyle = (K.T && K.T.acc) || '#FF2B00';
    [0, -6, -12, -24, -48].forEach((d) => { const y = h - K.dbToMeter(d) * h; g.fillRect(0, y, w, 1); });
  }
};

// ---------- VU meter: a needle on a lit cream face; 0 VU = −18 dBFS RMS (or opt.ref) ----------
K.vu = (cv, st, rms, opt) => {
  const dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const T = K.T || {}, ink = T.vuInk || '#1A1611', face = T.vu || '#F1E6C4', red = T.acc || '#C8231B';
  const now = performance.now(), dt = Math.min(100, now - (st.t || now)); st.t = now;
  const FULL = Math.pow(10, 3 / 20), pos = (v) => Math.pow(10, v / 20) / FULL;
  const tgt = rms.map((r) => U.clamp(r > 1e-6 ? pos(U.db(r * Math.SQRT2) - ((opt && opt.ref) || -18)) : 0, 0, 1.06));
  const k = 1 - Math.exp(-dt / 55);
  st.l = (st.l || 0) + (tgt[0] - (st.l || 0)) * k; st.r = (st.r || 0) + ((tgt[1] !== undefined ? tgt[1] : tgt[0]) - (st.r || 0)) * k;
  g.clearRect(0, 0, w, h);
  // face
  const R = 6; g.fillStyle = face; g.beginPath(); g.roundRect ? g.roundRect(1, 1, w - 2, h - 2, R) : g.rect(1, 1, w - 2, h - 2); g.fill();
  const vg = g.createRadialGradient(w / 2, h * 0.45, h * 0.2, w / 2, h * 0.45, w * 0.75); vg.addColorStop(0, 'rgba(255,250,230,0)'); vg.addColorStop(1, 'rgba(60,40,10,.22)');
  g.fillStyle = vg; g.fill();
  const cx = w / 2, cy = h * 1.08, rad = Math.min(h * 0.86, w * 0.62), A0 = -0.8, A1 = 0.8;
  const ang = (p) => A0 + (A1 - A0) * p - Math.PI / 2;
  g.save(); g.beginPath(); g.rect(4, 4, w - 8, h - 8); g.clip();
  // scale arcs
  g.lineWidth = 1.5; g.strokeStyle = ink; g.beginPath(); g.arc(cx, cy, rad, ang(pos(-20)), ang(pos(0))); g.stroke();
  g.lineWidth = 5; g.strokeStyle = red; g.beginPath(); g.arc(cx, cy, rad + 2.5, ang(pos(0)), ang(1)); g.stroke();
  g.font = '700 ' + Math.max(8, Math.round(h * 0.11)) + 'px "Courier Prime", monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
  [-20, -10, -7, -5, -3, -2, -1, 0, 1, 2, 3].forEach((v) => {
    const a = ang(pos(v)), big = [-20, -10, -5, 0, 3].includes(v) || h > 90;
    g.strokeStyle = v > 0 ? red : ink; g.lineWidth = v === 0 ? 2 : 1.2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad); g.lineTo(cx + Math.cos(a) * (rad + (big ? 8 : 5)), cy + Math.sin(a) * (rad + (big ? 8 : 5))); g.stroke();
    if (big && w > 120) { g.fillStyle = v > 0 ? red : ink; g.fillText(String(Math.abs(v)), cx + Math.cos(a) * (rad + 16), cy + Math.sin(a) * (rad + 15)); }
  });
  g.fillStyle = ink; g.font = '600 ' + Math.max(10, Math.round(h * 0.17)) + 'px Oswald, "Arial Narrow", sans-serif'; g.fillText('VU', cx, cy - rad * 0.42);
  if (w > 150) { g.font = Math.max(10, Math.round(h * 0.14)) + 'px Yesteryear, cursive'; g.fillStyle = ink; g.globalAlpha = 0.55; g.fillText('DAWters & Son', cx, cy - rad * 0.2); g.globalAlpha = 1; }
  // needles
  const needle = (p, col, lw) => { const a = ang(p); g.strokeStyle = col; g.lineWidth = lw; g.lineCap = 'round'; g.beginPath(); g.moveTo(cx + Math.cos(a) * rad * 0.18, cy + Math.sin(a) * rad * 0.18); g.lineTo(cx + Math.cos(a) * (rad + 6), cy + Math.sin(a) * (rad + 6)); g.stroke(); };
  if (!(opt && opt.mono)) needle(st.r, red, 1.4);
  needle(st.l, ink, 2);
  g.restore();
  // pivot plate
  g.fillStyle = ink; g.beginPath(); g.roundRect ? g.roundRect(w * 0.3, h - h * 0.16, w * 0.4, h * 0.16 + 2, [6, 6, 0, 0]) : g.rect(w * 0.3, h - h * 0.16, w * 0.4, h * 0.16); g.fill();
  // overload lamp
  const hot = Math.max(st.l, st.r) > 0.99; g.fillStyle = hot ? red : 'rgba(0,0,0,.12)';
  g.beginPath(); g.arc(w - 11, 11, 4, 0, Math.PI * 2); g.fill();
  g.strokeStyle = ink; g.lineWidth = 2; g.beginPath(); g.roundRect ? g.roundRect(1, 1, w - 2, h - 2, R) : g.rect(1, 1, w - 2, h - 2); g.stroke();
};

// ---------- menus ----------
K.closeMenus = () => { document.querySelectorAll('.dd').forEach((d) => d.remove()); document.querySelectorAll('.menu-btn.open').forEach((b) => b.classList.remove('open')); };
// ---------- touch detection ----------
K.lastPointer = (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) ? 'touch' : 'mouse';
document.addEventListener('pointerdown', (e) => { K.lastPointer = e.pointerType === 'pen' ? 'touch' : e.pointerType; }, true);
K.isTouch = () => K.lastPointer === 'touch';

// ---------- bottom sheets ----------
K.closeSheets = () => document.querySelectorAll('.sheet-scrim').forEach((s) => s.close ? s.close() : s.remove());
// body: node(s); actions: [{label, act, primary}] shown as a big button row
K.sheet = (title, body, actions, opt = {}) => {
  K.closeSheets(); K.closeMenus();
  const scrim = K.h('div', { class: 'sheet-scrim' + (opt.light ? ' light' : '') });
  const close = () => { if (!scrim.isConnected) return; sh.classList.add('out'); scrim.classList.add('out'); setTimeout(() => scrim.remove(), 180); document.removeEventListener('keydown', esc, true); opt.onClose && opt.onClose(); };
  scrim.close = close;
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const grab = K.h('div', { class: 'grab', 'aria-hidden': 'true' });
  const head = K.h('div', { class: 'sh-head' }, K.h('div', { class: 'sh-title' }, title), K.h('button', { class: 'btn icon sm', 'aria-label': 'Close', onclick: close }, '✕'));
  const acts = actions && actions.length ? K.h('div', { class: 'sh-foot' }, actions.map((b) => K.h('button', { class: 'btn big' + (b.primary ? ' on' : ''), onclick: async () => { const r = b.act ? await b.act() : undefined; if (r !== false) close(); } }, b.label))) : null;
  const sh = K.h('div', { class: 'sheet', role: 'dialog', 'aria-label': title }, grab, head, K.h('div', { class: 'sh-body' + (opt.grid ? ' grid' : '') }, body), acts);
  scrim.append(sh); document.body.append(scrim);
  scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(); });
  // drag the grab handle down to dismiss
  let gy = null;
  grab.addEventListener('pointerdown', (e) => { gy = e.clientY; grab.setPointerCapture(e.pointerId); });
  grab.addEventListener('pointermove', (e) => { if (gy !== null) sh.style.transform = 'translateY(' + Math.max(0, e.clientY - gy) + 'px)'; });
  grab.addEventListener('pointerup', (e) => { if (gy !== null && e.clientY - gy > 80) close(); else sh.style.transform = ''; gy = null; });
  document.addEventListener('keydown', esc, true);
  return { el: sh, close };
};
// a menu rendered as a sheet of big buttons (used on touch screens)
K.sheetMenu = (items) => {
  let title = '';
  const body = [];
  let grid = null;
  const flush = () => { if (grid && grid.childNodes.length) body.push(grid); grid = null; };
  let s;
  for (const it of items) {
    if (!it) continue;
    if (it.head) { if (!title && !body.length && !grid) { title = it.head; continue; } flush(); body.push(K.h('div', { class: 'sh-sub' }, it.head)); continue; }
    if (it.sep) { flush(); continue; }
    if (!grid) grid = K.h('div', { class: 'sh-acts' });
    const b = K.h('button', { class: 'act' + (it.check ? ' on' : ''), disabled: it.disabled || undefined }, (it.check !== undefined ? (it.check ? '● ' : '○ ') : '') + it.label);
    b.addEventListener('click', () => { s.close(); it.act && it.act(); });
    grid.append(b);
  }
  flush();
  s = K.sheet(title || 'Actions', body, null);
  return s;
};

// items: [{label, key, act, disabled, sep, head, check}]
K.menu = (items, x, y, opener) => {
  if (K.isTouch()) return K.sheetMenu(items);
  K.closeMenus();
  const dd = K.h('div', { class: 'dd', role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { dd.append(K.h('hr')); continue; }
    if (it.head) { dd.append(K.h('div', { class: 'hd' }, it.head)); continue; }
    const b = K.h('button', { class: 'it', role: 'menuitem', disabled: it.disabled || undefined }, (it.check !== undefined ? (it.check ? '● ' : '○ ') : '') + it.label, it.key ? K.h('span', { class: 'k' }, it.key) : null);
    b.addEventListener('click', () => { K.closeMenus(); it.act && it.act(); });
    dd.append(b);
  }
  document.body.append(dd);
  const r = dd.getBoundingClientRect();
  dd.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  dd.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 6)) + 'px';
  if (opener) opener.classList.add('open');
  const first = dd.querySelector('.it:not([disabled])'); if (first) first.focus({ preventScroll: true });
  dd.addEventListener('keydown', (e) => {
    const its = Array.from(dd.querySelectorAll('.it:not([disabled])')), i = its.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); its[(i + 1) % its.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); its[(i - 1 + its.length) % its.length].focus(); }
    else if (e.key === 'Escape') { K.closeMenus(); }
    e.stopPropagation();
  });
  return dd;
};
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.dd') && !e.target.closest('.menu-btn')) K.closeMenus(); }, true);

// ---------- dialogs ----------
K.dialog = (title, body, buttons, opt = {}) => {
  const scrim = opt.float ? null : K.h('div', { class: 'scrim' });
  const close = () => { (scrim || dlg).remove(); opt.onClose && opt.onClose(); document.removeEventListener('keydown', esc, true); };
  const esc = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const dh = K.h('div', { class: 'dh' }, title, K.h('button', { class: 'btn icon sm x', 'aria-label': 'Close', onclick: close }, '✕'));
  const df = buttons && buttons.length ? K.h('div', { class: 'df' }) : null;
  if (df) for (const b of buttons) df.append(K.h('button', { class: 'btn' + (b.primary ? ' on' : ''), onclick: async () => { const r = b.act ? await b.act() : undefined; if (r !== false) close(); } }, b.label));
  const dlg = K.h('div', { class: 'dlg' + (opt.float ? ' float' : ''), role: 'dialog', 'aria-label': title }, dh, K.h('div', { class: 'db' }, body), df);
  if (opt.width) dlg.style.width = opt.width;
  if (scrim) { scrim.append(dlg); document.body.append(scrim); scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim && !opt.modal) close(); }); }
  else { document.body.append(dlg); dlg.style.left = (opt.x || 80) + 'px'; dlg.style.top = (opt.y || 90) + 'px'; }
  document.addEventListener('keydown', esc, true);
  if (opt.float) {
    let sx = null, sy, ox, oy;
    dh.addEventListener('pointerdown', (e) => { if (e.target.closest('button')) return; dh.setPointerCapture(e.pointerId); sx = e.clientX; sy = e.clientY; ox = dlg.offsetLeft; oy = dlg.offsetTop; });
    dh.addEventListener('pointermove', (e) => { if (sx === null) return; dlg.style.left = U.clamp(ox + e.clientX - sx, 0, innerWidth - 80) + 'px'; dlg.style.top = U.clamp(oy + e.clientY - sy, 0, innerHeight - 40) + 'px'; });
    dh.addEventListener('pointerup', () => { sx = null; });
  }
  return { el: dlg, close };
};
K.row = (label, ctl) => K.h('div', { class: 'fr' }, K.h('label', null, label), ctl);
K.select = (opts, val, onch) => { const s = K.h('select', { onchange: () => onch(s.value) }); for (const o of opts) { const op = K.h('option', { value: o[0] }, o[1]); if (String(o[0]) === String(val)) op.selected = true; s.append(op); } return s; };
K.confirm = (title, text, okLabel) => new Promise((res) => { K.dialog(title, K.h('div', null, text), [{ label: 'Cancel', act: () => res(false) }, { label: okLabel || 'OK', primary: true, act: () => res(true) }], { onClose: () => res(false) }); });
K.prompt = (title, label, val) => new Promise((res) => {
  const i = K.h('input', { type: 'text', value: val || '' });
  const d = K.dialog(title, K.row(label, i), [{ label: 'Cancel', act: () => res(null) }, { label: 'OK', primary: true, act: () => res(i.value) }], { onClose: () => res(null) });
  setTimeout(() => { i.focus(); i.select(); }, 30);
  i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { res(i.value); d.close(); } });
});
K.toast = (msg, ms) => {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = K.h('div', { class: 'toast', role: 'status' }, msg); document.body.append(t);
  setTimeout(() => t.remove(), ms || 2600);
};

// logo mark: a 1950s ribbon microphone on a round sponsor badge
K.LOGO = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="31" fill="var(--logo-bg,#14120F)"/><circle cx="32" cy="32" r="27.5" fill="none" stroke="var(--acc,#C8231B)" stroke-width="2.5"/><rect x="21" y="11" width="22" height="31" rx="11" fill="var(--logo-fg,#F4EEE1)"/><g fill="var(--logo-bg,#14120F)"><rect x="24" y="17" width="16" height="2.2"/><rect x="23" y="21.5" width="18" height="2.2"/><rect x="23" y="26" width="18" height="2.2"/><rect x="23" y="30.5" width="18" height="2.2"/><rect x="24" y="35" width="16" height="2.2"/></g><rect x="30" y="42" width="4" height="7" fill="var(--logo-fg,#F4EEE1)"/><rect x="22" y="49" width="20" height="3.5" rx="1.7" fill="var(--logo-fg,#F4EEE1)"/></svg>`;
K.SUN = K.LOGO;
K.ICON = {
  play: '<svg viewBox="0 0 20 20"><path d="M5 3l12 7-12 7z" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 20 20"><rect x="4" y="4" width="12" height="12" rx="2" fill="currentColor"/></svg>',
  rec: '<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" fill="currentColor"/></svg>',
  home: '<svg viewBox="0 0 20 20"><path d="M4 3h2.5v14H4zM17 3v14L7.5 10z" fill="currentColor"/></svg>',
  end: '<svg viewBox="0 0 20 20"><path d="M13.5 3H16v14h-2.5zM3 3v14l9.5-7z" fill="currentColor"/></svg>',
  rew: '<svg viewBox="0 0 20 20"><path d="M10 4v12L2 10zM18 4v12l-8-6z" fill="currentColor"/></svg>',
  ffw: '<svg viewBox="0 0 20 20"><path d="M10 4v12l8-6zM2 4v12l8-6z" fill="currentColor"/></svg>',
};
