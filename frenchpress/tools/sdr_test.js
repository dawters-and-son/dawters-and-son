// Runs the JS engine on songs with known stems and reports SDR per stem + reconstruction error.
const fs = require('fs'), D = require('../src/dsp.js'), E = require('../src/engine.js');
function readWav(f) {
  const b = fs.readFileSync(f), dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12, fmt, nc, sr, bits, data;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { fmt = dv.getUint16(o + 8, true); nc = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); if (fmt === 0xFFFE) fmt = dv.getUint16(o + 32, true); }
    if (id === 'data') { data = [o + 8, sz]; break; } o += 8 + sz + (sz & 1); }
  const n = data[1] / (nc * bits / 8), ch = [...Array(nc)].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const p = data[0] + (i * nc + c) * bits / 8; ch[c][i] = fmt === 3 ? dv.getFloat32(p, true) : dv.getInt16(p, true) / 32768; }
  return { ch, sr };
}
const sdr = (ref, est) => { let a = 0, b = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < ref[c].length; i++) { a += ref[c][i] ** 2; b += (ref[c][i] - est[c][i]) ** 2; } return 10 * Math.log10(a / (b + 1e-20) + 1e-20); };
(async () => {
  const songs = process.argv.slice(2).length ? process.argv.slice(2) : ['rock', 'falcon', 'loop'];
  const means = [];
  for (const name of songs) {
    const dir = '/home/claude/testdata/', mix = readWav(dir + name + '_mix.wav');
    const t = Date.now();
    const res = await E.separate(mix.ch[0], mix.ch[1], mix.sr, { stems: 5 }, E.localPool(), () => [new Float32Array(mix.ch[0].length), new Float32Array(mix.ch[0].length)]);
    const ms = Date.now() - t, st = res.stems, r = {};
    const oth = [0, 1].map(c => st.other[c].map((v, i) => v + st.ambience[c][i]));
    for (const k of ['vocals', 'drums', 'bass']) r[k] = sdr(readWav(dir + name + '_' + k + '.wav').ch, st[k]);
    r.other = sdr(readWav(dir + name + '_other.wav').ch, oth);
    let err = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < mix.ch[c].length; i++) { let s = 0; for (const k of res.names) s += st[k][c][i]; err = Math.max(err, Math.abs(s - mix.ch[c][i])); }
    const mean = (r.vocals + r.drums + r.bass + r.other) / 4; means.push(mean);
    console.log(name, Object.fromEntries(Object.entries(r).map(([k, v]) => [k, +v.toFixed(2)])), 'mean', mean.toFixed(2), 'recon max err dB', (20 * Math.log10(err + 1e-30)).toFixed(1),
      'period s', res.period.toFixed(2), 'voiced', res.voicedFrac.toFixed(2), 'time', ms + 'ms for', (mix.ch[0].length / mix.sr).toFixed(1) + 's', JSON.stringify(res.timing));
  }
})();
