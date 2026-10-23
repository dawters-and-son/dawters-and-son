// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Josh Wilk. Part of DAWters and Son; see LICENSE for terms (no warranty).
// DAWters and Son — built-in instruments: parameter specs, presets, kits
'use strict';
const INST = {};
INST.TYPES = { synth: 'Synth', drums: 'Drums', sampler: 'Sampler' };
INST.PADS = [36, 38, 39, 42, 46, 45, 50, 56];
INST.PAD_NAMES = ['Kick', 'Snare', 'Clap', 'Closed hat', 'Open hat', 'Low tom', 'High tom', 'Perc'];
INST.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
INST.noteName = (n) => INST.NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);

INST.synthDefault = () => ({
  o1w: 'saw', o1oct: 0, o1semi: 0, o2w: 'square', o2oct: 0, o2semi: 0, o2det: 7, mix: 0.4, pw: 0.5, sub: 0, noise: 0,
  ftype: 'lp24', cut: 2400, res: 0.2, fenv: 0.35, fkey: 0.5, vfilt: 0.3, fa: 0.002, fd: 0.35, fs: 0.2, fr: 0.3,
  a: 0.004, d: 0.3, s: 0.7, r: 0.25, lrate: 5, lshape: 0, lpitch: 0, lcut: 0, glide: 0, mono: false, vsens: 0.6, vol: -4, width: 0,
});
const SP = (o) => Object.assign(INST.synthDefault(), o);
INST.SYNTH_PRESETS = [
  ['BASS 01 SUB', SP({ o1w: 'sine', o2w: 'tri', o1oct: -1, o2oct: -1, mix: 0.3, cut: 900, res: 0.1, fenv: 0.1, a: 0.002, d: 0.4, s: 0.9, r: 0.08, mono: true, glide: 0.03, vol: 0 })],
  ['BASS 02 ACID', SP({ o1w: 'saw', o2w: 'saw', o1oct: -1, o2oct: -1, o2det: 0, mix: 0, cut: 300, res: 0.82, fenv: 0.65, fd: 0.18, fs: 0, a: 0.001, d: 0.2, s: 0.8, r: 0.06, mono: true, glide: 0.06, vfilt: 0.8, vol: -3 })],
  ['BASS 03 PICK', SP({ o1w: 'square', o2w: 'saw', o1oct: -1, o2oct: -1, mix: 0.5, cut: 600, res: 0.3, fenv: 0.45, fd: 0.12, fs: 0.05, a: 0.001, d: 0.35, s: 0.3, r: 0.12, vol: -2 })],
  ['LEAD 01 SAW', SP({ o1w: 'saw', o2w: 'saw', o2det: 12, mix: 0.5, cut: 3800, res: 0.25, fenv: 0.2, a: 0.004, s: 0.85, r: 0.18, lpitch: 12, lrate: 5.5, mono: true, glide: 0.04, vol: -6 })],
  ['LEAD 02 SQUARE', SP({ o1w: 'square', o2w: 'square', o2oct: 1, mix: 0.3, pw: 0.35, cut: 2600, res: 0.15, fenv: 0.25, a: 0.002, s: 0.8, r: 0.15, vol: -7 })],
  ['PAD 01 WARM', SP({ o1w: 'saw', o2w: 'saw', o2det: 14, mix: 0.5, cut: 1400, res: 0.12, fenv: 0.15, fa: 0.8, fd: 1.5, fs: 0.5, fr: 1.2, a: 0.9, d: 1.2, s: 0.8, r: 1.6, lcut: 0.25, lrate: 0.3, vol: -9 })],
  ['PAD 02 GLASS', SP({ o1w: 'tri', o2w: 'sine', o2oct: 1, o2det: 5, mix: 0.45, cut: 6000, res: 0.35, fenv: 0, a: 0.6, d: 1, s: 0.75, r: 2, lpitch: 6, lrate: 4, vol: -8 })],
  ['KEYS 01 SOFT', SP({ o1w: 'tri', o2w: 'sine', o2oct: 1, mix: 0.25, cut: 3000, res: 0.05, fenv: 0.25, fd: 0.6, fs: 0.2, a: 0.003, d: 1.2, s: 0.3, r: 0.4, vsens: 0.8, vol: -5 })],
  ['PLUCK 01', SP({ o1w: 'saw', o2w: 'square', mix: 0.4, cut: 700, res: 0.3, fenv: 0.6, fd: 0.16, fs: 0, a: 0.001, d: 0.3, s: 0, r: 0.25, vol: -5 })],
  ['BRASS 01', SP({ o1w: 'saw', o2w: 'saw', o2det: 9, mix: 0.5, cut: 900, res: 0.1, fenv: 0.45, fa: 0.06, fd: 0.4, fs: 0.4, a: 0.03, d: 0.3, s: 0.8, r: 0.2, vol: -6 })],
  ['STRINGS 01', SP({ o1w: 'saw', o2w: 'saw', o2det: 18, mix: 0.5, cut: 2200, res: 0.05, fenv: 0.05, a: 0.35, d: 0.5, s: 0.9, r: 0.9, lpitch: 8, lrate: 5, vol: -9 })],
  ['ORGAN 01', SP({ o1w: 'sine', o2w: 'sine', o2oct: 1, mix: 0.45, sub: 0.35, cut: 8000, res: 0, fenv: 0, a: 0.004, d: 0.1, s: 1, r: 0.05, lpitch: 9, lrate: 6.5, vol: -8 })],
  ['BELL 01', SP({ o1w: 'sine', o2w: 'sine', o2semi: 7, o2oct: 1, o2det: 3, mix: 0.4, cut: 9000, fenv: 0, a: 0.001, d: 2.2, s: 0, r: 1.5, vol: -6 })],
  ['NOISE 01 RISER', SP({ o1w: 'saw', noise: 0.8, mix: 0, cut: 400, res: 0.6, fenv: 0.9, fa: 3, fd: 0.1, fs: 1, a: 2, s: 1, r: 0.5, vol: -10 })],
];

INST.KITS = [
  ['KIT 01 BOOM', [[0, 0.9, 0, 0.35], [0, 0.35, -3, 0.5], [0, 0.4, -4, 0.5], [0, 0.4, -9, 0.3], [0, 0.6, -10, 0.3], [0, 0.5, -5, 0.3], [0, 0.4, -5, 0.3], [0, 0.4, -9, 0.5]]],
  ['KIT 02 TIGHT', [[2, 0.35, 0, 0.6], [2, 0.18, -2, 0.8], [1, 0.25, -4, 0.6], [2, 0.25, -8, 0.6], [2, 0.35, -10, 0.6], [3, 0.3, -5, 0.4], [3, 0.25, -5, 0.4], [3, 0.25, -9, 0.6]]],
  ['KIT 03 DUST', [[-2, 0.55, -1, 0.2], [-3, 0.3, -3, 0.25], [-2, 0.45, -5, 0.3], [-4, 0.3, -11, 0.2], [-4, 0.5, -12, 0.2], [-3, 0.5, -6, 0.2], [-3, 0.4, -6, 0.2], [-5, 0.5, -10, 0.2]]],
  ['KIT 04 ELECTRO', [[5, 0.45, 0, 0.9], [5, 0.25, -2, 1], [4, 0.3, -3, 0.9], [5, 0.18, -8, 0.9], [5, 0.3, -9, 0.9], [7, 0.3, -5, 0.8], [7, 0.25, -5, 0.8], [6, 0.3, -8, 0.9]]],
];
INST.kitPads = (k) => INST.KITS[k][1].map(([tune, decay, level, tone], i) => ({ tune, decay, level, tone, pan: [0, 0, 0, 0.25, 0.25, -0.35, 0.35, -0.2][i] }));
INST.drumsDefault = () => ({ kit: 0, vol: -2, pads: INST.kitPads(0) });
INST.samplerDefault = () => ({ root: 60, tune: 0, track: true, oneshot: false, loop: false, start: 0, lstart: 0, a: 0.002, d: 0.3, s: 1, r: 0.3, cut: 20000, res: 0, vsens: 0.6, vol: -3 });
INST.make = (type) => ({ type, p: type === 'drums' ? INST.drumsDefault() : type === 'sampler' ? INST.samplerDefault() : Object.assign(INST.synthDefault(), INST.SYNTH_PRESETS[0][1]), preset: type === 'synth' ? 0 : -1, sample: null, padSamples: {} });

// ---- UI specs: [key, label, spec] ----
const NOTE_FMT = (v) => INST.noteName(Math.round(v));
INST.SYNTH_UI = [
  ['OSC 1', [['o1w', 'Wave', { opts: ['saw', 'square', 'tri', 'sine'], lab: ['SAW', 'SQR', 'TRI', 'SIN'] }], ['o1oct', 'Octave', { min: -2, max: 2, step: 1, def: 0 }], ['o1semi', 'Semi', { min: -12, max: 12, step: 1, def: 0, bipolar: true }]]],
  ['OSC 2', [['o2w', 'Wave', { opts: ['saw', 'square', 'tri', 'sine'], lab: ['SAW', 'SQR', 'TRI', 'SIN'] }], ['o2oct', 'Octave', { min: -2, max: 2, step: 1, def: 0 }], ['o2semi', 'Semi', { min: -12, max: 12, step: 1, def: 0, bipolar: true }], ['o2det', 'Detune', { min: -50, max: 50, def: 7, u: 'ct', bipolar: true }], ['mix', 'Mix', { min: 0, max: 1, def: 0.4 }]]],
  ['SOURCE', [['pw', 'Pulse W', { min: 0.05, max: 0.95, def: 0.5 }], ['sub', 'Sub', { min: 0, max: 1, def: 0 }], ['noise', 'Noise', { min: 0, max: 1, def: 0 }]]],
  ['FILTER', [['ftype', 'Type', { opts: ['lp24', 'lp12', 'hp', 'bp'], lab: ['LP24', 'LP12', 'HP', 'BP'] }], ['cut', 'Cutoff', { min: 40, max: 18000, def: 2400, u: 'Hz', log: true }], ['res', 'Reso', { min: 0, max: 1, def: 0.2 }], ['fenv', 'Env amt', { min: -1, max: 1, def: 0.35, bipolar: true }], ['fkey', 'Key trk', { min: 0, max: 1, def: 0.5 }], ['vfilt', 'Vel>Cut', { min: 0, max: 1, def: 0.3 }]]],
  ['FILTER ENV', [['fa', 'Attack', { min: 0.001, max: 5, def: 0.002, u: 's', log: true }], ['fd', 'Decay', { min: 0.01, max: 5, def: 0.35, u: 's', log: true }], ['fs', 'Sustain', { min: 0, max: 1, def: 0.2 }], ['fr', 'Release', { min: 0.01, max: 5, def: 0.3, u: 's', log: true }]]],
  ['AMP', [['a', 'Attack', { min: 0.001, max: 5, def: 0.004, u: 's', log: true }], ['d', 'Decay', { min: 0.01, max: 5, def: 0.3, u: 's', log: true }], ['s', 'Sustain', { min: 0, max: 1, def: 0.7 }], ['r', 'Release', { min: 0.01, max: 6, def: 0.25, u: 's', log: true }], ['vsens', 'Velocity', { min: 0, max: 1, def: 0.6 }], ['vol', 'Volume', { min: -30, max: 6, def: -4, u: 'dB' }]]],
  ['LFO', [['lshape', 'Shape', { opts: [0, 1, 2], lab: ['SIN', 'SQR', 'SAW'] }], ['lrate', 'Rate', { min: 0.05, max: 20, def: 5, u: 'Hz', log: true }], ['lpitch', 'Vibrato', { min: 0, max: 100, def: 0, u: 'ct' }], ['lcut', 'Wah', { min: 0, max: 3, def: 0 }]]],
  ['VOICE', [['mono', 'Mode', { opts: [false, true], lab: ['POLY', 'MONO'] }], ['glide', 'Glide', { min: 0, max: 0.5, def: 0, u: 's' }], ['width', 'Width', { min: -1, max: 1, def: 0, bipolar: true }]]],
];
INST.SAMPLER_UI = [
  ['PLAY', [['root', 'Root', { min: 24, max: 96, step: 1, def: 60, fmt: NOTE_FMT }], ['tune', 'Fine', { min: -100, max: 100, def: 0, u: 'ct', bipolar: true }], ['track', 'Pitch', { opts: [true, false], lab: ['KEYS', 'FIXED'] }], ['oneshot', 'Trigger', { opts: [false, true], lab: ['GATE', 'ONESHOT'] }]]],
  ['REGION', [['start', 'Start', { min: 0, max: 0.99, def: 0 }], ['loop', 'Loop', { opts: [false, true], lab: ['OFF', 'ON'] }], ['lstart', 'Loop at', { min: 0, max: 0.99, def: 0 }]]],
  ['AMP', [['a', 'Attack', { min: 0.001, max: 5, def: 0.002, u: 's', log: true }], ['d', 'Decay', { min: 0.01, max: 5, def: 0.3, u: 's', log: true }], ['s', 'Sustain', { min: 0, max: 1, def: 1 }], ['r', 'Release', { min: 0.01, max: 6, def: 0.3, u: 's', log: true }], ['vsens', 'Velocity', { min: 0, max: 1, def: 0.6 }], ['vol', 'Volume', { min: -30, max: 6, def: -3, u: 'dB' }]]],
  ['FILTER', [['cut', 'Cutoff', { min: 80, max: 20000, def: 20000, u: 'Hz', log: true }], ['res', 'Reso', { min: 0, max: 1, def: 0 }]]],
];
INST.PAD_UI = [['tune', 'Tune', { min: -12, max: 12, def: 0, u: 'st', bipolar: true }], ['decay', 'Decay', { min: 0.03, max: 2, def: 0.4, u: 's', log: true }], ['tone', 'Tone', { min: 0, max: 1, def: 0.4 }], ['level', 'Level', { min: -30, max: 6, def: -3, u: 'dB' }], ['pan', 'Pan', { min: -1, max: 1, def: 0, bipolar: true }]];

// sample payloads for the worklet ({ch:[Float32Array], sr})
INST.samplePayload = (eng, inst) => {
  const pack = (id) => { const b = id && eng.buffers.get(id); if (!b) return null; const ch = []; for (let c = 0; c < Math.min(2, b.ab.numberOfChannels); c++) ch.push(b.ab.getChannelData(c)); return { ch, sr: b.ab.sampleRate }; };
  if (inst.type === 'sampler') return { main: pack(inst.sample) };
  if (inst.type === 'drums') { const o = {}; for (const n in inst.padSamples || {}) { const s = pack(inst.padSamples[n]); if (s) o[n] = s; } return o; }
  return {};
};
INST.bufIds = (inst) => { const out = []; if (!inst) return out; if (inst.sample) out.push(inst.sample); for (const n in inst.padSamples || {}) out.push(inst.padSamples[n]); return out; };
