/* France's French Press — small UI kit: knobs, faders, the EQ graph, menus, dialogs, toasts.
 * SPDX-License-Identifier: GPL-3.0-or-later  Copyright (C) 2026 Josh Wilk */
var UI = (function () {
  'use strict';
  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') e.className = attrs[k]; else if (k === 'html') e.innerHTML = attrs[k]; else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]); else if (k === 'style') e.style.cssText = attrs[k]; else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function fmtHz(f) { return f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f) + ''; }
  function fmtDb(d) { return (d > 0 ? '+' : '') + d.toFixed(1); }
  function fmtTime(t, tenths) { if (!isFinite(t)) t = 0; var m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + (tenths === false ? Math.floor(s) : s.toFixed(1)); }

  // ---------- knob ----------
  // opts: {label, min, max, value, def, log, step, fmt(v), onchange(v), bipolar}
  function Knob(opts) {
    var o = Object.assign({ min: 0, max: 1, step: 0, fmt: function (v) { return v.toFixed(2); } }, opts);
    if (o.def === undefined) o.def = o.value;
    var root = el('div', { class: 'knob', tabindex: '0', role: 'slider', 'aria-label': o.label });
    var NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 46 46');
    svg.innerHTML = '<defs><radialGradient id="kg" cx="35%" cy="30%"><stop offset="0" stop-color="#4b3f35"/><stop offset=".7" stop-color="#14100C"/></radialGradient></defs>' +
      '<path class="trk" fill="none" stroke="var(--paper3)" stroke-width="4" stroke-linecap="round"/>' +
      '<path class="arc" fill="none" stroke="var(--red)" stroke-width="4" stroke-linecap="round"/>' +
      '<circle cx="23" cy="23" r="14" fill="url(#kg)" stroke="var(--ink)" stroke-width="1.5"/>' +
      '<line class="ptr" x1="23" y1="23" x2="23" y2="11" stroke="#F3E7CF" stroke-width="3" stroke-linecap="round"/>';
    var lab = el('div', { class: 'kl', text: o.label }), val = el('div', { class: 'kv' });
    root.appendChild(svg); root.appendChild(val); root.appendChild(lab);
    var A0 = -135, A1 = 135;
    function toN(v) { return o.log ? Math.log(v / o.min) / Math.log(o.max / o.min) : (v - o.min) / (o.max - o.min); }
    function fromN(n) { n = Math.max(0, Math.min(1, n)); var v = o.log ? o.min * Math.pow(o.max / o.min, n) : o.min + n * (o.max - o.min); if (o.step) v = Math.round(v / o.step) * o.step; return v; }
    function arcPath(a, b) {
      var r = 20, p = function (deg) { var t = (deg - 90) * Math.PI / 180; return [23 + r * Math.cos(t), 23 + r * Math.sin(t)]; };
      var s = p(a), e = p(b), large = Math.abs(b - a) > 180 ? 1 : 0, sweep = b > a ? 1 : 0;
      return 'M' + s[0] + ' ' + s[1] + ' A' + r + ' ' + r + ' 0 ' + large + ' ' + sweep + ' ' + e[0] + ' ' + e[1];
    }
    svg.querySelector('.trk').setAttribute('d', arcPath(A0, A1));
    function draw() {
      var n = toN(o.value), ang = A0 + n * (A1 - A0), zero = o.bipolar ? A0 + toN(o.bipolar === true ? 0 : o.bipolar) * (A1 - A0) : A0;
      var arc = svg.querySelector('.arc');
      if (Math.abs(ang - zero) < 0.5) arc.setAttribute('d', ''); else arc.setAttribute('d', arcPath(Math.min(zero, ang), Math.max(zero, ang)));
      svg.querySelector('.ptr').setAttribute('transform', 'rotate(' + ang + ' 23 23)');
      val.textContent = o.fmt(o.value); root.setAttribute('aria-valuetext', o.fmt(o.value));
    }
    function set(v, fire) { o.value = v; draw(); if (fire && o.onchange) o.onchange(v); }
    var dragY = null, startN = 0;
    svg.addEventListener('pointerdown', function (e) { dragY = e.clientY; startN = toN(o.value); svg.setPointerCapture(e.pointerId); e.preventDefault(); });
    svg.addEventListener('pointermove', function (e) { if (dragY === null) return; var sens = e.shiftKey ? 600 : 160; set(fromN(startN + (dragY - e.clientY) / sens), true); });
    svg.addEventListener('pointerup', function () { dragY = null; });
    svg.addEventListener('dblclick', function () { set(o.def, true); });
    root.addEventListener('wheel', function (e) { e.preventDefault(); set(fromN(toN(o.value) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.02)), true); }, { passive: false });
    root.addEventListener('keydown', function (e) {
      var d = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
      if (d) { e.preventDefault(); e.stopPropagation(); set(fromN(toN(o.value) + d * (e.shiftKey ? 0.005 : 0.02)), true); }
      if (e.key === 'Home' || e.key === 'Delete') { e.preventDefault(); e.stopPropagation(); set(o.def, true); }
    });
    draw();
    return { el: root, set: function (v) { set(v, false); }, get: function () { return o.value; } };
  }

  // ---------- vertical fader (dB) ----------
  function Fader(opts) {
    var o = Object.assign({ min: -60, max: 12, value: 0, def: 0 }, opts);
    var root = el('div', { class: 'fader', tabindex: '0', role: 'slider', 'aria-label': o.label || 'Level' }), track = el('div', { class: 'track' }), cap = el('div', { class: 'cap' });
    root.appendChild(track); root.appendChild(cap);
    // fader law: top 12 dB linear-ish, steeper below -24
    function toN(v) { return v >= -24 ? 0.35 + 0.65 * (v + 24) / (o.max + 24) : Math.max(0, 0.35 * (v - o.min) / (-24 - o.min)); }
    function fromN(n) { n = Math.max(0, Math.min(1, n)); var v = n >= 0.35 ? -24 + (n - 0.35) / 0.65 * (o.max + 24) : o.min + n / 0.35 * (-24 - o.min); return Math.round(v * 10) / 10; }
    function draw() { var h = root.clientHeight || 190, n = toN(o.value); cap.style.top = ((1 - n) * (h - 30)) + 'px'; root.setAttribute('aria-valuetext', o.value.toFixed(1) + ' dB'); }
    function set(v, fire) { o.value = v; draw(); if (fire && o.onchange) o.onchange(v); }
    var dy = null, sn = 0;
    root.addEventListener('pointerdown', function (e) { dy = e.clientY; sn = toN(o.value); root.setPointerCapture(e.pointerId); e.preventDefault(); });
    root.addEventListener('pointermove', function (e) { if (dy === null) return; set(fromN(sn + (dy - e.clientY) / ((root.clientHeight || 190) - 30) * (e.shiftKey ? 0.25 : 1)), true); });
    root.addEventListener('pointerup', function () { dy = null; });
    root.addEventListener('dblclick', function () { set(o.def, true); });
    root.addEventListener('wheel', function (e) { e.preventDefault(); set(Math.max(o.min, Math.min(o.max, o.value - Math.sign(e.deltaY) * 0.5)), true); }, { passive: false });
    root.addEventListener('keydown', function (e) { var d = { ArrowUp: 0.5, ArrowDown: -0.5 }[e.key]; if (d) { e.preventDefault(); e.stopPropagation(); set(Math.max(o.min, Math.min(o.max, o.value + d)), true); } });
    requestAnimationFrame(draw);
    return { el: root, set: function (v) { set(v, false); }, draw: draw };
  }

  // ---------- EQ graph ----------
  // eq: state object; getNodes(): live BiquadFilterNodes (or null); onchange()
  function EQGraph(canvas, opts) {
    var o = opts, F0 = 20, F1 = 20000, G = 18, drag = null, freqs = new Float32Array(256), mag = new Float32Array(256), ph = new Float32Array(256), acc = new Float32Array(256);
    for (var i = 0; i < 256; i++) freqs[i] = F0 * Math.pow(F1 / F0, i / 255);
    function geo() { var r = canvas.getBoundingClientRect(), d = window.devicePixelRatio || 1; if (canvas.width !== Math.round(r.width * d) || canvas.height !== Math.round(r.height * d)) { canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d); } return { w: canvas.width, h: canvas.height, d: d }; }
    function x2f(x, w) { return F0 * Math.pow(F1 / F0, x / w); }
    function f2x(f, w) { return Math.log(f / F0) / Math.log(F1 / F0) * w; }
    function g2y(g, h) { return h / 2 - g / G * (h / 2 - 8); }
    function y2g(y, h) { return (h / 2 - y) / (h / 2 - 8) * G; }
    var handles = function () { var e = o.eq(); return [
      { k: 'hp', f: e.hp.f, g: -G + 2, on: e.hp.on, pass: true }, { k: 'ls', f: e.ls.f, g: e.ls.g }, { k: 'b1', f: e.b1.f, g: e.b1.g }, { k: 'b2', f: e.b2.f, g: e.b2.g },
      { k: 'b3', f: e.b3.f, g: e.b3.g }, { k: 'hs', f: e.hs.f, g: e.hs.g }, { k: 'lp', f: e.lp.f, g: -G + 2, on: e.lp.on, pass: true }]; };
    function draw(spectrum) {
      var g = geo(), w = g.w, h = g.h, c = canvas.getContext('2d'), d = g.d, small = h < 120 * d;
      c.clearRect(0, 0, w, h);
      c.strokeStyle = css('--paper3'); c.lineWidth = 1; c.fillStyle = css('--ink3'); c.font = (10 * d) + 'px ' + css('--type');
      [50, 100, 200, 500, 1000, 2000, 5000, 10000].forEach(function (f) { var x = f2x(f, w); c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); if (!small) c.fillText(fmtHz(f), x + 2, h - 4); });
      [-12, -6, 0, 6, 12].forEach(function (gg) { var y = g2y(gg, h); c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); });
      if (spectrum) {
        c.fillStyle = o.color ? o.color() : css('--ink3'); c.globalAlpha = 0.18; c.beginPath(); c.moveTo(0, h);
        for (var x = 0; x < w; x += 2 * d) { var f = x2f(x, w), bin = Math.round(f / (spectrum.sr / 2) * (spectrum.data.length - 1)); var v = spectrum.data[Math.min(spectrum.data.length - 1, bin)]; var y = h - (v + 100) / 90 * h; c.lineTo(x, Math.max(0, Math.min(h, y))); }
        c.lineTo(w, h); c.fill(); c.globalAlpha = 1;
      }
      var nodes = o.nodes && o.nodes();
      acc.fill(0);
      if (nodes) {
        ['hp', 'ls', 'b1', 'b2', 'b3', 'hs', 'lp'].forEach(function (k) { nodes[k].getFrequencyResponse(freqs, mag, ph); for (var i = 0; i < 256; i++) acc[i] += 20 * Math.log10(mag[i] + 1e-9); });
      }
      c.strokeStyle = o.color ? o.color() : css('--ink'); c.lineWidth = 2.5 * d; c.beginPath();
      for (i = 0; i < 256; i++) { var xx = i / 255 * w, yy = g2y(Math.max(-G - 4, Math.min(G + 4, acc[i])), h); if (i) c.lineTo(xx, yy); else c.moveTo(xx, yy); }
      c.stroke();
      if (!small) handles().forEach(function (hd) {
        var x = f2x(hd.f, w), y = g2y(hd.g, h);
        c.fillStyle = hd.pass ? (hd.on ? css('--red') : css('--paper2')) : css('--paper2'); c.strokeStyle = css('--ink'); c.lineWidth = 2 * d;
        c.beginPath(); if (hd.pass) c.rect(x - 6 * d, y - 6 * d, 12 * d, 12 * d); else c.arc(x, y, 7 * d, 0, 7); c.fill(); c.stroke();
        c.fillStyle = css('--ink'); c.fillText({ hp: 'HP', ls: 'LO', b1: '1', b2: '2', b3: '3', hs: 'HI', lp: 'LP' }[hd.k], x + 9 * d, y - 8 * d);
      });
    }
    if (o.interactive) {
      canvas.addEventListener('pointerdown', function (e) {
        var g = geo(), r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * g.d, y = (e.clientY - r.top) * g.d, best = null, bd = 1e9;
        handles().forEach(function (hd) { var dx = f2x(hd.f, g.w) - x, dy = g2y(hd.g, g.h) - y, dd = dx * dx + dy * dy; if (dd < bd) { bd = dd; best = hd; } });
        if (best && bd < Math.pow(28 * g.d, 2)) { drag = best.k; canvas.setPointerCapture(e.pointerId); e.preventDefault(); }
      });
      canvas.addEventListener('pointermove', function (e) {
        if (!drag) return; var g = geo(), r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * g.d, y = (e.clientY - r.top) * g.d, eq = o.eq(), b = eq[drag];
        b.f = Math.max(20, Math.min(20000, x2f(x, g.w)));
        if (drag === 'hp' || drag === 'lp') b.on = true; else b.g = Math.round(Math.max(-G, Math.min(G, y2g(y, g.h))) * 10) / 10;
        o.onchange();
      });
      canvas.addEventListener('pointerup', function () { drag = null; });
      canvas.addEventListener('dblclick', function (e) {
        var g = geo(), r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * g.d, y = (e.clientY - r.top) * g.d, eq = o.eq();
        handles().forEach(function (hd) { var dx = f2x(hd.f, g.w) - x, dy = g2y(hd.g, g.h) - y; if (dx * dx + dy * dy < Math.pow(16 * g.d, 2)) { if (hd.pass) eq[hd.k].on = !eq[hd.k].on; else eq[hd.k].g = 0; } });
        o.onchange();
      });
      canvas.addEventListener('wheel', function (e) {
        var g = geo(), r = canvas.getBoundingClientRect(), x = (e.clientX - r.left) * g.d, eq = o.eq(), best = null, bd = 1e9;
        ['b1', 'b2', 'b3'].forEach(function (k) { var dx = Math.abs(f2x(eq[k].f, g.w) - x); if (dx < bd) { bd = dx; best = k; } });
        if (best && bd < 40 * g.d) { e.preventDefault(); eq[best].q = Math.max(0.2, Math.min(12, eq[best].q * (e.deltaY > 0 ? 0.9 : 1.11))); o.onchange(); }
      }, { passive: false });
    }
    return { draw: draw };
  }

  // ---------- menus, dialogs, toasts ----------
  var openMenu = null;
  function menu(x, y, items) {
    closeMenu();
    var m = el('div', { class: 'menu' });
    items.forEach(function (it) {
      if (it === '-') m.appendChild(el('hr'));
      else if (it.sub) m.appendChild(el('div', { class: 'sub', text: it.sub }));
      else m.appendChild(el('button', { html: (it.chip ? '<span class="chip" style="background:' + it.chip + '"></span>' : '') + it.label, onclick: function () { closeMenu(); it.fn(); } }));
    });
    document.body.appendChild(m);
    var r = m.getBoundingClientRect();
    m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + 'px'; m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 4)) + 'px';
    openMenu = m;
    setTimeout(function () { document.addEventListener('pointerdown', outside, true); }, 0);
    function outside(e) { if (!m.contains(e.target)) { closeMenu(); } }
    m._outside = outside;
  }
  function closeMenu() { if (openMenu) { document.removeEventListener('pointerdown', openMenu._outside, true); openMenu.remove(); openMenu = null; } }
  function dialog(html, onOpen) {
    var s = $('#scrim'), d = $('#dialog'); d.innerHTML = html; s.classList.remove('hidden');
    var close = function () { s.classList.add('hidden'); d.innerHTML = ''; };
    s.onclick = function (e) { if (e.target === s) close(); };
    $$('[data-close]', d).forEach(function (b) { b.onclick = close; });
    if (onOpen) onOpen(d, close);
    return close;
  }
  function ask(title, html, okLabel) {
    return new Promise(function (res) {
      dialog('<h2 class="title">' + title + '</h2>' + html + '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn" data-close>Cancel</button><button class="btn primary" id="dlgOk">' + (okLabel || 'OK') + '</button></div>',
        function (d, close) { $('#dlgOk', d).onclick = function () { var r = {}; $$('input,select', d).forEach(function (i) { r[i.id || i.name] = i.type === 'checkbox' ? i.checked : i.value; }); close(); res(r); }; $$('[data-close]', d).forEach(function (b) { b.addEventListener('click', function () { res(null); }); }); $('#scrim').onclick = function (e) { if (e.target.id === 'scrim') { close(); res(null); } }; var f = $('input,select', d); if (f) f.focus(); });
    });
  }
  var toastT = 0;
  function toast(msg, ms) { var t = $('#toast'); t.textContent = msg; t.classList.remove('hidden'); clearTimeout(toastT); toastT = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600); }

  return { $: $, $$: $$, el: el, css: css, fmtHz: fmtHz, fmtDb: fmtDb, fmtTime: fmtTime, Knob: Knob, Fader: Fader, EQGraph: EQGraph, menu: menu, closeMenu: closeMenu, dialog: dialog, ask: ask, toast: toast };
})();
