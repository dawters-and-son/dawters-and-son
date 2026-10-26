// node tools/test_engine.js — checks the looper engine offline
const Engine = require('../src/engine.js');
const SR = 48000, B = 128;
let fails = 0;
function ok(c, msg) { console.log((c ? 'PASS ' : 'FAIL ') + msg); if (!c) fails++; }
function run(e, frames, inp) {
  const oL = new Float32Array(frames), oR = new Float32Array(frames);
  const bl = new Float32Array(B), br = new Float32Array(B), il = new Float32Array(B);
  let msgs = [];
  for (let o = 0; o < frames; o += B) {
    const n = Math.min(B, frames - o);
    if (inp) for (let i = 0; i < n; i++) il[i] = inp(o + i);
    e.process(inp ? il : null, inp ? il : null, bl, br, n);
    oL.set(bl.subarray(0, n), o); oR.set(br.subarray(0, n), o);
    msgs = msgs.concat(e.out); e.out = [];
  }
  return { L: oL, R: oR, msgs };
}
function freq(x, a, b) { // zero-crossing frequency estimate
  let c = 0, first = -1, last = -1;
  for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) { const f = i - 1 + (-x[i - 1]) / (x[i] - x[i - 1]); if (first < 0) first = f; last = f; c++; }
  return (c - 1) * SR / (last - first);
}
function rms(x, a, b) { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(s / (b - a)); }
const mk = () => { const e = new Engine(SR); e.cmd({ c: 'set', master: 0.25 }); return e; };
const sine = f => i => 0.5 * Math.sin(2 * Math.PI * f * i / SR);

// 1. sync record with a 1-bar lead-in, auto length = one loop
let e = mk();
e.cmd({ c: 'set', baseTempo: 120, loopBars: 4, bpb: 4 });
const L = e.loopLen();
ok(L === 384000, 'loop length 4 bars @120 = 384000 frames (' + L + ')');
const lead = e.barLen();
e.cmd({ c: 'play', G: -lead });
e.cmd({ c: 'arm', track: 0, startG: 0, len: L, lead, quant: 'bar' });
e.L = L; // the UI defines the loop in sync mode before arming
let r = run(e, lead + L + 4000, sine(440));
const lay = r.msgs.find(m => m.t === 'layer');
ok(lay && lay.n === L && lay.s === 0, 'take lands on bar 1 and is exactly one loop long (n=' + (lay && lay.n) + ', s=' + (lay && lay.s) + ')');
const clicks = (() => { let c = 0, last = -1e9; for (let i = 1; i < lead; i++) if (Math.abs(r.L[i]) > 0.05 && i - last > 4000) { c++; last = i; } return c; })();
ok(clicks === 4, 'lead-in clicks four beats before the punch (' + clicks + ')');

// 2. playback, then tempo moves with and without keeping pitch
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
r = run(e, SR, null);
ok(Math.abs(freq(r.L, 4800, 40000) - 440) < 0.5, 'loop plays back at 440 Hz (' + freq(r.L, 4800, 40000).toFixed(2) + ')');
e.cmd({ c: 'tempo', bpm: 150 });
r = run(e, SR, null);
let f = freq(r.L, 4800, 40000);
ok(Math.abs(f - 440) < 2, 'tempo 120→150 keeping pitch stays at 440 Hz (' + f.toFixed(2) + ')');
ok(Math.abs(e.r - 1.25) < 1e-9, 'rate is 1.25');
e.cmd({ c: 'set', stretch: 0 });
r = run(e, SR, null); f = freq(r.L, 4800, 40000);
ok(Math.abs(f - 550) < 1, 'tape mode at 150 BPM plays at 550 Hz (' + f.toFixed(2) + ')');
e.cmd({ c: 'set', stretch: 1 }); e.cmd({ c: 'tempo', bpm: 120 });

// 3. increase: three passes on track 1 become three layers
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
e.cmd({ c: 'arm', track: 1, startG: 0, passes: 3, lead: 0 });
r = run(e, L * 3 + 2000, sine(330));
const lays = r.msgs.filter(m => m.t === 'layer' && m.track === 1);
ok(lays.length === 3 && lays.every(x => x.n === L), 'increase mode: 3 passes → 3 full layers');
ok(e.tracks[1].active.length === 3, 'all three layers active');

// 4. fade: older layers get quieter
e.cmd({ c: 'setTrack', track: 0, mute: true });
e.cmd({ c: 'setTrack', track: 1, fade: 0 });
r = run(e, 24000, null); const full = rms(r.L, 12000, 24000);
e.cmd({ c: 'setTrack', track: 1, fade: 0.5 });
r = run(e, 48000, null); const faded = rms(r.L, 30000, 48000);
ok(Math.abs(faded / full - (1 + 0.5 + 0.25) / 3) < 0.02, 'fade 50% weights layers 1, ½, ¼ (' + (faded / full).toFixed(3) + ')');

// 5. undo (drop the top layer)
e.cmd({ c: 'setTrack', track: 1, fade: 0, active: e.tracks[1].active.slice(0, 1) });
r = run(e, 48000, null);
ok(Math.abs(rms(r.L, 30000, 48000) / full - 1 / 3) < 0.02, 'undo two layers leaves one third of the level');

// 6. replace punch over bar 2 silences what's under it
e.cmd({ c: 'setTrack', track: 0, mute: false }); e.cmd({ c: 'setTrack', track: 1, mute: true });
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
const bar = e.barLen();
e.cmd({ c: 'arm', track: 0, startG: bar, len: bar, replace: true });
r = run(e, L + 100, () => 0);
r = run(e, L, null);
console.log('  replace rms', rms(r.L, 2000, bar - 2000), rms(r.L, bar + 2000, 2 * bar - 2000), rms(r.L, 2 * bar + 2000, 3 * bar));
ok(rms(r.L, 2000, bar - 2000) > 0.05 && rms(r.L, bar + 2000, 2 * bar - 2000) < 1e-4 && rms(r.L, 2 * bar + 2000, 3 * bar) > 0.05,
  'replace punch in bar 2: bar 1 plays, bar 2 silent, bar 3 plays');

// 7. latency compensation moves the take earlier
e = mk(); e.cmd({ c: 'set', baseTempo: 120, latency: 1000 }); e.L = e.loopLen();
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'arm', track: 0, startG: 0, len: e.L });
r = run(e, e.L + 500, sine(440));
ok(r.msgs.find(m => m.t === 'layer').s === e.L - 1000, 'latency 1000 frames: take starts 1000 frames early');

// 8. free first loop: its length sets the tempo
e = mk(); e.cmd({ c: 'set', loopBars: 4, bpb: 4 });
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'arm', track: 0, startG: 0, free: true });
r = run(e, Math.round(SR * 7.5), sine(220));
e.cmd({ c: 'punchOut', track: 0, quant: 'now' });
r = run(e, 256, sine(220));
const def = r.msgs.find(m => m.t === 'loopDefined');
ok(def && Math.abs(def.baseTempo - 128) < 0.05, 'free loop of 7.5 s over 4 bars → 128 BPM (' + (def && def.baseTempo.toFixed(2)) + ')');

// 9. tempo ramp
e.cmd({ c: 'ramp', bpm: 160, bars: 2, startG: e.G });
r = run(e, Math.round(2 * e.barLen() / 1.1) + 20000, null);
ok(Math.abs(e.r * e.baseTempo - 160) < 0.01 && r.msgs.some(m => m.t === 'rampDone'), 'ramp 128→160 over 2 bars lands on 160 (' + (e.r * e.baseTempo).toFixed(2) + ')');

// 10. tempo held during a take, applied after
e.cmd({ c: 'tempo', bpm: 128 });
e.cmd({ c: 'arm', track: 2, startG: null, quant: 'now', lead: 0, passes: 1 });
run(e, 1000, sine(300));
e.cmd({ c: 'tempo', bpm: 100 });
ok(Math.abs(e.r - 1) < 1e-9 && e.pendingR > 0, 'tempo change waits while recording');
run(e, e.L + 2000, sine(300));
ok(Math.abs(e.r * e.baseTempo - 100) < 0.01, 'and applies when the take ends');

// 11. auto-start on signal
e = mk(); e.cmd({ c: 'set', trigLevel: 0.1 });
e.cmd({ c: 'arm', track: 0, trigger: true, free: true });
run(e, 24000, () => 0.001);
ok(!e.playing && e.recs.length === 1 && !e.recs[0].on, 'auto-start waits through silence');
run(e, 2400, sine(440));
ok(e.playing && e.recs[0].on, 'auto-start begins on the first note');

// 12. scheduled mute lands on the bar
e = mk(); e.cmd({ c: 'set', baseTempo: 120 }); e.L = e.loopLen();
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'arm', track: 0, startG: 0, len: e.L });
run(e, e.L + 10, sine(440));
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
e.cmd({ c: 'at', G: e.barLen(), cmd: { c: 'setTrack', track: 0, mute: true } });
r = run(e, e.barLen() * 2, null);
const bl = e.barLen();
console.log('  mute rms', rms(r.L, bl - 4000, bl - 100), rms(r.L, bl + 3000, bl + 8000));
ok(rms(r.L, bl - 4000, bl - 100) > 0.05 && rms(r.L, bl + 3000, bl + 8000) < 0.01, 'scheduled mute takes effect at bar 2');

// 13. reverse + polymetric track length
e.cmd({ c: 'setTrack', track: 0, mute: false, rev: true });
r = run(e, 24000, null);
ok(Math.abs(freq(r.L, 4000, 24000) - 440) < 1, 'reverse playback keeps the pitch of a sine');

// 15. start on sound on a running loop: the take lands where the sound began
e = mk(); e.cmd({ c: 'set', baseTempo: 120, trigLevel: 0.1 }); e.L = e.loopLen();
e.cmd({ c: 'play', G: 0 });
run(e, 48000, () => 0.001);
e.cmd({ c: 'arm', track: 0, trigger: true, passes: 1 });
const t0s = 48000 * 3;
r = run(e, t0s + e.L + 4000, i => (i >= t0s - 48000 ? 0.5 * Math.sin(2 * Math.PI * 440 * i / SR) : 0.001));
const ls = r.msgs.find(m => m.t === 'layer');
ok(ls && Math.abs(ls.s - (48000 + t0s - 48000 - 480)) <= 128 && ls.n >= e.L - 1 && ls.n <= e.L + 480, 'start on sound: one-pass take placed where the note began (s=' + (ls && ls.s) + ')');

// 16. stop when I stop playing: punch out on the bar after half a second of quiet
e = mk(); e.cmd({ c: 'set', baseTempo: 120, trigLevel: 0.05 }); e.L = e.loopLen();
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'arm', track: 0, startG: 0, silStop: 24000, silQ: 'bar' });
const playFor = Math.round(2.3 * 48000);
r = run(e, e.L, i => (i < playFor ? 0.4 * Math.sin(2 * Math.PI * 220 * i / SR) : 0));
const lq = r.msgs.find(m => m.t === 'layer');
ok(lq && lq.n === 2 * e.barLen(), 'stop on silence: playing 2.3 s then stopping ends the take at the end of bar 2 (' + (lq && lq.n / e.barLen()) + ' bars)');

// 17. gated replace: the new take only replaces where it has sound
e = mk(); e.cmd({ c: 'set', baseTempo: 120 }); e.L = e.loopLen();
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'arm', track: 0, startG: 0, passes: 1 });
run(e, e.L + 10, sine(440));
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
e.cmd({ c: 'arm', track: 0, startG: 0, passes: 1, replace: true, gate: 0.05 });
const half = e.barLen() * 2;
run(e, e.L + 10, i => (i >= half ? 0.3 * Math.sin(2 * Math.PI * 660 * i / SR) : 0.002));
e.cmd({ c: 'stop' }); e.cmd({ c: 'play', G: 0 });
r = run(e, e.L, null);
const f1 = freq(r.L, 4000, half - 8000), f2 = freq(r.L, half + 8000, e.L - 4000);
ok(Math.abs(f1 - 440) < 1 && Math.abs(f2 - 660) < 1, 'gated replace: first half keeps the old 440 Hz, second half is the new 660 Hz (' + f1.toFixed(1) + ', ' + f2.toFixed(1) + ')');
ok(rms(r.L, 4000, half - 8000) > 0.05, 'and the quiet half of the new take adds no noise or gap');

// 14. CPU: 6 tracks × 5 layers, stretched
e = mk(); e.cmd({ c: 'set', baseTempo: 120 }); e.L = e.loopLen();
for (let t = 0; t < 6; t++) { const ids = []; for (let k = 0; k < 5; k++) { const id = t * 10 + k + 1; const a = new Float32Array(e.L).map((_, i) => Math.sin(i * 0.05 * (k + 1))); e.cmd({ c: 'addLayer', id, track: t, Lb: a, Rb: a, n: e.L, s: 0, rate: 1 }); ids.push(id); } e.cmd({ c: 'setTrack', track: t, active: ids, filt: -0.4 }); }
e.cmd({ c: 'play', G: 0 }); e.cmd({ c: 'tempo', bpm: 131 });
const t0 = process.hrtime.bigint(); run(e, SR * 4, null); const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok(ms < 4000 * 0.5, '30 stretched layers + filters render ' + (4000 / ms).toFixed(1) + '× faster than real time');

console.log(fails ? fails + ' FAILED' : 'all passed');
process.exit(fails ? 1 : 0);
