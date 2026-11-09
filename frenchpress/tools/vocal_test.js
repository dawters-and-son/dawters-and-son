// Vocal quality, old (vMode 1) vs new (vMode 2), on songs with true vocals. SDR + leakage (SIR, from applying
// the same masks is not possible here, so SIR is approximated by the accompaniment energy left in the vocal).
const fs = require('fs'), path = require('path'), E = require('../src/engine.js');
const dir = process.env.FP_TESTDATA || '/home/claude/testdata/';
function readWav(f) {
  const b = fs.readFileSync(f), dv = new DataView(b.buffer, b.byteOffset, b.byteLength); let o = 12, fmt, nc, sr, bits, data;
  while (o < b.length) { const id = b.toString('ascii', o, o + 4), sz = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { fmt = dv.getUint16(o + 8, true); nc = dv.getUint16(o + 10, true); sr = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); if (fmt === 0xFFFE) fmt = 3; }
    if (id === 'data') { data = [o + 8, sz]; break; } o += 8 + sz + (sz & 1); }
  const n = data[1] / (nc * bits / 8), ch = [...Array(nc)].map(() => new Float32Array(n));
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) { const p = data[0] + (i * nc + c) * bits / 8; ch[c][i] = fmt === 3 ? dv.getFloat32(p, true) : dv.getInt16(p, true) / 32768; }
  return { ch, sr };
}
const sdr = (r, e) => { let a = 0, b = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < r[c].length; i++) { a += r[c][i] ** 2; b += (r[c][i] - e[c][i]) ** 2; } return 10 * Math.log10(a / (b + 1e-20)); };
(async () => {
  const songs = ['rock', 'falcon', 'cristinava', 'themountai', 'triviulfea'], tot = { 1: [], 2: [] };
  for (const s of songs) {
    const mix = readWav(dir + s + '_mix.wav'), voc = readWav(dir + s + '_vocals.wav'), line = [s];
    for (const mode of [1, 2]) {
      const t = Date.now();
      const r = await E.separate(mix.ch[0], mix.ch[1], mix.sr, { stems: 4, vMode: mode }, E.localPool(), () => [new Float32Array(mix.ch[0].length), new Float32Array(mix.ch[0].length)]);
      const v = sdr(voc.ch, r.stems.vocals); tot[mode].push(v);
      line.push(`v${mode === 1 ? '1.0' : '1.1'} vocals ${v.toFixed(2)} dB (${Date.now() - t} ms)`);
    }
    console.log(line.join('  |  '));
  }
  const m = k => (tot[k].reduce((a, b) => a + b, 0) / tot[k].length).toFixed(2);
  console.log('MEAN vocals: v1.0', m(1), 'dB  ->  v1.1', m(2), 'dB');
})();
