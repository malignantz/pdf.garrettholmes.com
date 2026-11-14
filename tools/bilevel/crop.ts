/**
 * Debug crop for the review: one picture of a PDF page (or of a synthetic scan of one) at
 * 100% or zoomed, original beside black/white with the current rules. Output stays outside
 * the repo.
 *   node … tools/bilevel/crop.ts IN.pdf PAGE X Y W H ZOOM OUT.png [SYNTH_SEED]
 */
import fs from 'node:fs';
import { analyse, binarize, rowBytesOf, vanished } from '../../src/lib/engine/bilevel';
import { mupdf } from '../../src/lib/engine/mupdf';
import { findCandidates } from '../../src/lib/engine/shrink';
import { engine } from '../survey/lib/engine';
import { synthScan } from './synth';

const [inp, pageS, xs, ys, ws, hs, zs, out, seedS] = process.argv.slice(2);
const m = await mupdf();
let bytes: Uint8Array = new Uint8Array(fs.readFileSync(inp));
let page = Number(pageS);
if (seedS) {
	bytes = (await synthScan(m, bytes, page, Number(seedS)))!.pdf;
	page = 0;
}
const src = (await engine().openPdf(bytes, 'in.pdf')).bytes;
const doc = new m.PDFDocument(src);
const c = findCandidates(doc).find((k) => k.pages.has(page))!;
const buf = doc.newIndirect(c.num).readStream();
const samples = buf.asUint8Array().slice();
const ppi = Math.min(c.width / c.inW, c.height / c.inH);
const a = analyse(samples, c.width, c.height, c.n, ppi);
const bits = binarize(a.grey, c.width, c.height, a.threshold);
const [x0, y0, cw, ch, z] = [xs, ys, ws, hs, zs].map(Number);
const W = (cw * 2 + 4) * z;
const H = ch * z;
const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, W, H], false);
const px = pix.getPixels();
const st = pix.getStride();
px.fill(200);
const rb = rowBytesOf(c.width);
for (let y = 0; y < ch * z; y++)
	for (let x = 0; x < cw * z; x++) {
		const sx = x0 + Math.floor(x / z);
		const sy = y0 + Math.floor(y / z);
		if (sx >= c.width || sy >= c.height) continue;
		const i = sy * c.width + sx;
		const d = y * st + x * 3;
		for (let k = 0; k < 3; k++) px[d + k] = c.n === 3 ? samples[i * 3 + k] : samples[i];
		const v = bits[sy * rb + (sx >> 3)] & (0x80 >> (sx & 7)) ? 255 : 0;
		const e = y * st + (x + (cw + 4) * z) * 3;
		px[e] = px[e + 1] = px[e + 2] = v;
	}
fs.writeFileSync(out, pix.asPNG());
const v = vanished(a.grey, bits, c.width, c.height, ppi, a.paper, a.ink);
console.log({ at: v.at, lost: v.lost, gained: v.gained, lossFine: v.lossFine, w: c.width, h: c.height, threshold: a.threshold, paper: a.paper, ink: a.ink, ppi: Math.round(ppi), reason: a.reason });
