/**
 * Compress-to-target on a 100-page colour scan (each page one 2500×3300 JPEG,
 * 300 ppi on Letter). Slow and memory-hungry, so it only runs when asked:
 *   SHRINK_PERF=1 npx vitest run tests/engine/shrink-perf.test.ts
 * Prints time per phase and the process's resident memory. The generated file
 * is cached in the OS temp folder, so a second run measures memory without the
 * cost of generating it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, StandardFonts } from '@cantoo/pdf-lib';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { shrinkToTarget } from '../../src/lib/engine/shrink';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { defaultOptions, engine, nodeAssets, prng, ref } from './helpers';

const W = 2500;
const H = 3300;

async function scanJpeg(seed: number): Promise<Uint8Array> {
	const m = await mupdf();
	const rnd = prng(seed);
	const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, W, H], false);
	const px = pix.getPixels();
	for (let y = 0; y < H; y++) {
		const line = Math.floor(y / 50);
		for (let x = 0; x < W; x++) {
			const o = (y * W + x) * 3;
			let r = 244,
				g = 241,
				b = 232;
			if (y % 50 < 26 && x > 250 && x < W - 250 && ((x >> 3) * 7 + line * 13) % 23 < 15 && line % 9 !== 8 && y > 300) {
				r = g = b = 40;
			}
			if (x > 1300 && x < 2200 && y > 2200 && y < 3000) {
				r = 120 + 90 * Math.sin(x / 40 + seed);
				g = 110 + 80 * Math.cos(y / 55);
				b = 90 + 60 * Math.sin((x + y) / 70);
			}
			const n = (rnd() - 0.5) * 8;
			px[o] = r + n;
			px[o + 1] = g + n;
			px[o + 2] = b + n;
		}
	}
	const out = pix.asJPEG(85).slice();
	pix.destroy();
	return out;
}

async function scanPdf(pages: number): Promise<Uint8Array> {
	const jpegs = [];
	for (let i = 0; i < 5; i++) jpegs.push(await scanJpeg(100 + i));
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let p = 0; p < pages; p++) {
		const data = jpegs[p % jpegs.length];
		const img = doc.context.register(
			PDFRawStream.of(
				doc.context.obj({ Type: 'XObject', Subtype: 'Image', Width: W, Height: H, BitsPerComponent: 8, ColorSpace: 'DeviceRGB', Filter: 'DCTDecode' }),
				data
			)
		);
		const page = doc.addPage([612, 792]);
		page.node.setXObject(PDFName.of('Scan'), img);
		const ops = Buffer.from(`q ${(W / 300) * 72} 0 0 ${(H / 300) * 72} 6 0 cm /Scan Do Q`, 'latin1');
		page.node.addContentStream(doc.context.register(PDFRawStream.of(doc.context.obj({}), ops)));
		page.drawText(`scan p${p + 1}`, { x: 20, y: 770, size: 10, font });
	}
	return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

describe.skipIf(!process.env.SHRINK_PERF)('shrink performance', () => {
	it('reduces a 100-page 300 ppi colour scan to 10 MB', async () => {
		const t0 = performance.now();
		const cached = path.join(os.tmpdir(), 'pdf-shrink-perf-100.pdf');
		let bytes: Uint8Array;
		if (fs.existsSync(cached)) bytes = new Uint8Array(fs.readFileSync(cached));
		else {
			bytes = await scanPdf(100);
			fs.writeFileSync(cached, bytes);
		}
		const mb = (n: number) => Math.round(n / 1024 / 1024);
		const mem = () => `RSS ${mb(process.memoryUsage().rss)} MB, peak ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`;
		console.log(`[shrink-perf] input ${(bytes.length / 1e6).toFixed(1)} MB ready in ${Math.round(performance.now() - t0)} ms; ${mem()}`);

		const qpdf = new Qpdf(nodeAssets().qpdf);
		const deps = { mupdf, qpdf } as unknown as EngineDeps;
		const finalize = async (b: Uint8Array) => {
			const res = await qpdf.run({
				args: ['/in.pdf', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '/out.pdf'],
				inputs: { '/in.pdf': b },
				outputs: ['/out.pdf']
			});
			return res.files.get('/out.pdf')!;
		};
		const lines: string[] = [];
		const t1 = performance.now();
		const r = await shrinkToTarget(deps, bytes, 10_000_000, finalize, {
			trace: (l) => lines.push(`${Math.round(performance.now() - t1)} ms  ${l}  (${mem()})`)
		});
		const total = performance.now() - t1;
		console.log(lines.map((l) => `[shrink-perf] ${l}`).join('\n'));
		console.log(`[shrink-perf] total ${Math.round(total)} ms → ${(r.bytes.length / 1e6).toFixed(2)} MB ${JSON.stringify(r.shrink)}`);
		for (const c of r.checks) console.log(`[shrink-perf] ${c.name}: ${c.detail}`);
		expect(r.shrink.reached).toBe(true);
		expect(r.checks.every((c) => c.ok)).toBe(true);

		// The same through exportPlan (assemble + verify included).
		const src = await engine().openPdf(bytes, 'scan.pdf');
		const t2 = performance.now();
		const res = await engine().exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: { ...defaultOptions, targetBytes: 10_000_000 } }, [src], []);
		console.log(`[shrink-perf] exportPlan ${Math.round(performance.now() - t2)} ms → ${(res.bytes.length / 1e6).toFixed(2)} MB; ${mem()}`);
		expect(res.shrink?.reached).toBe(true);
	}, 1_200_000);
});
