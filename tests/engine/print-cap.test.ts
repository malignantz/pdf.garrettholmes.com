/**
 * Print-size cap ("Reduce oversized pictures", ExportOptions.printCap; engine/print-cap.ts).
 * Corpus: tests/corpus/generate-print-cap.mjs (print-cap.pdf: p1 photo at 500 ppi, p2 flat
 * chart at 500 ppi, p3 photo at 300 ppi; print-cap-signed.pdf).
 */
import { describe, expect, it } from 'vitest';
import type { PDFObject } from 'mupdf';
import type { ExportOptions, ExportProgress, ExportResult, PageRef, Source } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { CAP_KEEP, CAP_RULES, capPictures, capSize, effectivePpi, estimateJpegQuality } from '../../src/lib/engine/print-cap';
import { imagePageSize } from '../../src/lib/engine/images';
import { renderAndCompare } from '../../src/lib/engine/shrink';
import { corpus, defaultOptions, engine, nodeAssets, openCorpus, pageTexts, ref } from './helpers';
import { nodeOcr } from './ocr-node';

const T = 120_000;
const qpdf = new Qpdf(nodeAssets().qpdf);
const deps = { qpdf, mupdf } as unknown as EngineDeps;

async function run(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}, control = {}): Promise<ExportResult> {
	return engine().exportPlan({ pages, options: { ...defaultOptions, compress: true, ...options } }, sources, [], control);
}

function allOk(res: ExportResult) {
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
}

interface Img {
	width: number;
	height: number;
	filter: string;
	/** Hash of the decoded samples. */
	data: string;
}

function hash(b: Uint8Array): string {
	let h1 = 0x811c9dc5;
	let h2 = 0;
	for (let i = 0; i < b.length; i++) {
		h1 = Math.imul(h1 ^ b[i], 0x01000193);
		h2 = (h2 + b[i] * (i + 1)) >>> 0;
	}
	return `${b.length}:${(h1 >>> 0).toString(16)}:${h2.toString(16)}`;
}

/** The first image XObject of each page. */
async function images(bytes: Uint8Array, password?: string): Promise<Img[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	if (password !== undefined) doc.authenticatePassword(password);
	const out: Img[] = [];
	try {
		for (let p = 0; p < doc.countPages(); p++) {
			let found: PDFObject | null = null;
			doc.findPage(p)
				.getInheritable('Resources')
				.get('XObject')
				.forEach((v) => {
					if (!found && v.get('Subtype').asName() === 'Image') found = v;
				});
			const v = found as PDFObject | null;
			if (!v) continue;
			const b = v.readStream();
			out.push({ width: v.get('Width').asNumber(), height: v.get('Height').asNumber(), filter: v.get('Filter').toString(), data: hash(b.asUint8Array()) });
			b.destroy();
		}
	} finally {
		doc.destroy();
	}
	return out;
}

async function whole(name: string) {
	const src = await openCorpus(name);
	return { src, pages: src.pages.map((_, i) => ref(src, i)) };
}

/** A photo-like JPEG made in memory (gradients and noise, so it compresses like a photo). */
async function photoJpeg(w: number, h: number, quality: number, n: 1 | 3 = 3): Promise<Uint8Array> {
	const m = await mupdf();
	const pix = new m.Pixmap(n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
	const px = pix.getPixels();
	let s = 7;
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			for (let k = 0; k < n; k++) {
				s = (s * 1103515245 + 12345) >>> 0;
				px[(y * w + x) * n + k] = Math.max(0, Math.min(255, 60 + (120 * x) / w + (60 * y) / h + 30 * Math.sin((x + k * 40) / 37) + ((s >>> 16) % 13)));
			}
	const j = pix.asJPEG(quality).slice();
	pix.destroy();
	return j;
}

describe('print-size cap: the rules', () => {
	it('reduces only when 300 ppi as drawn drops at least a fifth of the pixels', () => {
		expect(CAP_KEEP).toBe(0.8);
		// 300 ppi as drawn: nothing to drop.
		expect(capSize(600, 450, 2, 1.5)).toBeNull();
		// 330 ppi: keeps 83% of the pixels: left alone.
		expect(capSize(660, 495, 2, 1.5)).toBeNull();
		// 340 ppi: keeps 78%: reduced to 300 ppi.
		expect(capSize(680, 510, 2, 1.5)).toEqual([600, 450]);
		// The app's own picture page: a 4032×3024 phone photo on a 792×594 pt page is 366 ppi.
		const page = imagePageSize(4032, 3024);
		expect(page).toEqual({ width: 792, height: 594 });
		expect(Math.round(effectivePpi(4032, 3024, 11, 8.25))).toBe(367);
		expect(capSize(4032, 3024, 11, 8.25)).toEqual([3300, 2475]);
		// Drawn stretched: each side is capped on its own.
		expect(capSize(2000, 2000, 2, 10)).toEqual([600, 2000]);
		// No area: never.
		expect(capSize(2000, 2000, 0, 1)).toBeNull();
	});

	it('estimates a JPEG source quality from its luminance table', async () => {
		for (const q of [50, 75, 85, 92]) {
			const est = estimateJpegQuality(await photoJpeg(64, 64, q));
			expect(Math.abs(est! - q), `quality ${q}`).toBeLessThanOrEqual(1);
		}
		expect(estimateJpegQuality(new Uint8Array([1, 2, 3, 4]))).toBeNull();
	});
});

describe('print-size cap: through the export', () => {
	it('brings the oversized photo down to 300 ppi and leaves the chart, the 300 ppi photo and the text alone', async () => {
		const { src, pages } = await whole('print-cap.pdf');
		const off = await run(pages, [src]);
		const progress: ExportProgress[] = [];
		const on = await run(pages, [src], { printCap: true }, { onProgress: (p: ExportProgress) => progress.push(p) });
		allOk(on);
		expect(off.printCap).toBeUndefined();
		expect(on.printCap).toMatchObject({ images: 1, ppi: 300 });
		expect(on.printCap!.savedBytes).toBeGreaterThan(10_000);
		expect(on.bytes.length).toBeLessThan(off.bytes.length);
		expect(on.checks.find((c) => c.name === 'visual')?.detail).toMatch(/^Rendered the 1 page with reduced pictures/);
		expect(progress).toEqual([
			{ stage: 'pictures', done: 0, total: 1 },
			{ stage: 'pictures', done: 1, total: 1 }
		]);
		const [a1, a2, a3] = await images(off.bytes);
		const [b1, b2, b3] = await images(on.bytes);
		expect(a1).toMatchObject({ width: 1000, height: 750 });
		expect(b1).toMatchObject({ width: 600, height: 450, filter: '/DCTDecode' });
		expect(b2).toEqual(a2);
		expect(b3).toEqual(a3);
		expect(await pageTexts(on.bytes)).toEqual(await pageTexts(off.bytes));
		// Every page still looks the same at the size it is drawn.
		const m = await mupdf();
		const x = new m.PDFDocument(off.bytes);
		const y = new m.PDFDocument(on.bytes);
		try {
			for (let p = 0; p < 3; p++) expect(renderAndCompare(m, x, y, p)!.blockMean).toBeLessThan(4);
		} finally {
			x.destroy();
			y.destroy();
		}
	}, T);

	it('is off unless asked for, and does nothing without compress', async () => {
		const { src, pages } = await whole('print-cap.pdf');
		const base = await images((await run(pages, [src])).bytes);
		const plain = await run(pages, [src], { compress: false, printCap: true });
		allOk(plain);
		expect(plain.printCap).toBeUndefined();
		expect(await images(plain.bytes)).toEqual(base);
		const off = await run(pages, [src], { printCap: false });
		expect(off.printCap).toBeUndefined();
		expect(await images(off.bytes)).toEqual(base);
	}, T);

	it('leaves files with nothing oversized exactly as before, without loading MuPDF', async () => {
		let loads = 0;
		const eng = createCoreEngine({ ...nodeAssets(), mupdf: () => (loads++, mupdf()) });
		const src = await eng.openPdf(corpus('multi.pdf'), 'multi.pdf');
		const res = await eng.exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: { ...defaultOptions, compress: true, printCap: true } }, [src], []);
		allOk(res);
		expect(res.printCap).toEqual({ images: 0, savedBytes: 0, ppi: 300 });
		expect(res.checks.some((c) => c.name === 'visual')).toBe(false);
		expect(loads).toBe(0);
	}, T);

	it('leaves every picture of a signed file as it is', async () => {
		const { src, pages } = await whole('print-cap-signed.pdf');
		const notes: string[] = [];
		const eng = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n) });
		const s = await eng.openPdf(corpus('print-cap-signed.pdf'), 'x.pdf');
		const res = await eng.exportPlan({ pages: s.pages.map((_, i) => ref(s, i)), options: { ...defaultOptions, compress: true, printCap: true } }, [s], []);
		allOk(res);
		expect(res.printCap!.images).toBe(0);
		expect(notes).toContain('print-cap: signed file, pictures left as they are');
		expect(await images(res.bytes)).toEqual(await images((await run(pages, [src])).bytes));
		expect(await eng.oversizedPictures(s)).toEqual([]);
	}, T);

	it('uses a reduced picture only when it is at most 80% of the stream, and never makes the file bigger', async () => {
		const bytes = (await openCorpus('print-cap.pdf')).bytes;
		expect(await capPictures(deps, bytes, { rules: { gain: 0.01 } })).toBeNull();
		const r = await capPictures(deps, bytes);
		expect(r).toMatchObject({ images: 1 });
		expect(r!.bytes.length).toBeLessThan(bytes.length);
		// The memory rule: pictures over the limit stay.
		expect(await capPictures(deps, bytes, { rules: { maxPixelsJpeg: 700_000 } })).toBeNull();
		// The size floor.
		expect(await capPictures(deps, bytes, { rules: { minPixels: 800_000 } })).toBeNull();
		expect(CAP_RULES).toMatchObject({ ppi: 300, quality: 85, keep: 0.8, gain: 0.8 });
	}, T);

	it('leaves a JPEG whose data libjpeg finds corrupt (MuPDF would decode it without a word)', async () => {
		const m = await mupdf();
		const doc = new m.PDFDocument((await openCorpus('print-cap.pdf')).bytes);
		let img: PDFObject | null = null;
		doc.findPage(0)
			.getInheritable('Resources')
			.get('XObject')
			.forEach((v) => {
				if (v.get('Subtype').asName() === 'Image') img = v;
			});
		const o = img as unknown as PDFObject;
		const raw = o.readRawStream();
		const src = raw.asUint8Array().slice();
		raw.destroy();
		// A stray restart marker in the middle of the entropy-coded data (the file has no restart
		// interval): libjpeg warns "Corrupt JPEG data"; the frame and markers still parse.
		const mid = Math.floor(src.length / 2);
		const j = new Uint8Array(src.length + 2);
		j.set(src.subarray(0, mid));
		j.set([0xff, 0xd3], mid);
		j.set(src.subarray(mid), mid + 2);
		o.writeRawStream(j);
		const buf = doc.saveToBuffer('');
		const bytes = buf.asUint8Array().slice();
		buf.destroy();
		doc.destroy();
		const notes: string[] = [];
		expect(await capPictures(deps, bytes, { debug: (n) => notes.push(n) })).toBeNull();
		expect(notes.some((n) => /JPEG data libjpeg finds corrupt; left as it is/.test(n))).toBe(true);
	}, T);

	it('restores the pictures when the reduced page does not match', async () => {
		const bytes = (await openCorpus('print-cap.pdf')).bytes;
		const notes: string[] = [];
		const strict = { blockMean: 0.01, blockBias: 0.01, pageMean: 0.01 };
		expect(await capPictures(deps, bytes, { limits: strict, debug: (n) => notes.push(n) })).toBeNull();
		expect(notes.some((n) => /pages 1 differed; pictures left as they are/.test(n))).toBe(true);
	}, T);

	it('stops when cancelled', async () => {
		const { src, pages } = await whole('print-cap.pdf');
		const ac = new AbortController();
		const p = run(pages, [src], { printCap: true }, { signal: ac.signal, onProgress: (x: ExportProgress) => x.stage === 'pictures' && ac.abort() });
		await expect(p).rejects.toMatchObject({ code: 'cancelled' });
	}, T);

	it('works with a password and with redaction', async () => {
		const { src, pages } = await whole('print-cap.pdf');
		const pw = await run(pages, [src], { printCap: true, password: 'pw ✓' });
		allOk(pw);
		expect(pw.checks.find((c) => c.name === 'encryption')?.ok).toBe(true);
		expect(pw.printCap!.images).toBe(1);
		expect((await images(pw.bytes, 'pw ✓'))[0]).toMatchObject({ width: 600, height: 450, filter: '/DCTDecode' });

		// A redaction box over part of the photo (p1) and over text.
		const box = { id: 'r1', kind: 'redact' as const, box: { x: 0.4, y: 0.5, w: 0.15, h: 0.15 } };
		const red = await run([ref(src, 0, 0, [box]), ref(src, 1), ref(src, 2)], [src], { printCap: true });
		allOk(red);
		expect(red.checks.find((c) => c.name === 'redaction')?.ok).toBe(true);
		expect(red.printCap!.images).toBe(1);
		expect((await images(red.bytes))[0]).toMatchObject({ width: 600, height: 450 });
	}, T);
});

describe('print-size cap: with a size target', () => {
	it('applies when the lossless file already fits, and is the mildest step when the capped file fits', async () => {
		const { src, pages } = await whole('print-cap.pdf');
		const lossless = await run(pages, [src]);
		const capped = await run(pages, [src], { printCap: true });

		const roomy = await run(pages, [src], { printCap: true, targetBytes: lossless.bytes.length + 50_000 });
		allOk(roomy);
		expect(roomy.shrink).toMatchObject({ reached: true, imagesChanged: 1, dpi: 300 });
		expect(roomy.printCap).toMatchObject({ images: 1 });
		// Exact against the target path's own lossless file (stream pass only, no JPEG repack).
		expect(roomy.printCap!.savedBytes).toBeGreaterThan(0.8 * (lossless.bytes.length - roomy.bytes.length));
		expect(roomy.printCap!.savedBytes).toBeLessThan(1.2 * (lossless.bytes.length - roomy.bytes.length));
		expect((await images(roomy.bytes))[0]).toMatchObject({ width: 600, height: 450 });

		// Between the capped and the lossless size: the cap alone reaches it.
		const between = await run(pages, [src], { printCap: true, targetBytes: Math.round((capped.bytes.length + lossless.bytes.length) / 2) });
		allOk(between);
		expect(between.shrink).toMatchObject({ reached: true, imagesChanged: 1, dpi: 300 });
		expect(between.printCap!.images).toBe(1);

		// Without the cap the same target takes the ladder.
		const ladder = await run(pages, [src], { targetBytes: Math.round((capped.bytes.length + lossless.bytes.length) / 2) });
		expect(ladder.shrink!.dpi).toBe(200);
		expect(ladder.printCap).toBeUndefined();

		// Below the capped size: the ladder from the original pixels.
		const tight = await run(pages, [src], { printCap: true, targetBytes: 40_000 });
		allOk(tight);
		expect(tight.shrink!.dpi).toBeLessThanOrEqual(200);
		expect(tight.printCap).toEqual({ images: 0, savedBytes: 0, ppi: 300 });
	}, T);
});

describe('print-size cap: the dialog question', () => {
	it('lists oversized pictures with their pages; answers picture pages without MuPDF', async () => {
		let loads = 0;
		const eng = createCoreEngine({ ...nodeAssets(), mupdf: () => (loads++, mupdf()) });
		const multi = await eng.openPdf(corpus('multi.pdf'), 'multi.pdf');
		expect(await eng.oversizedPictures(multi)).toEqual([]);
		expect(loads).toBe(0);
		// A 12 MP phone photo through the app's own intake: one 366 ppi picture.
		const photo = await eng.openImage(await photoJpeg(4032, 3024, 90), 'image/jpeg', 'phone.jpg');
		expect(await eng.oversizedPictures(photo)).toEqual([[0]]);
		// A smaller photo fills its page at under 335 ppi.
		const small = await eng.openImage(await photoJpeg(3000, 2250, 90), 'image/jpeg', 'small.jpg');
		expect(await eng.oversizedPictures(small)).toEqual([]);
		expect(loads).toBe(0);
		const cap = await eng.openPdf(corpus('print-cap.pdf'), 'print-cap.pdf');
		expect(await eng.oversizedPictures(cap)).toEqual([[0]]);
		expect(loads).toBeGreaterThan(0);
		expect(await eng.oversizedPictures({ ...cap, kind: 'blank' })).toEqual([]);
	}, T);

	it('brings a phone photo page down to 300 ppi', async () => {
		const eng = engine();
		const photo = await eng.openImage(await photoJpeg(4032, 3024, 92), 'image/jpeg', 'phone.jpg');
		const pages = [ref(photo, 0)];
		const off = await eng.exportPlan({ pages, options: { ...defaultOptions, compress: true } }, [photo], []);
		const on = await eng.exportPlan({ pages, options: { ...defaultOptions, compress: true, printCap: true } }, [photo], []);
		allOk(on);
		expect(on.printCap!.images).toBe(1);
		expect((await images(on.bytes))[0]).toMatchObject({ width: 3300, height: 2475, filter: '/DCTDecode' });
		expect(on.bytes.length).toBeLessThan(off.bytes.length * 0.8);
	}, T);
});

describe('print-size cap: with OCR', () => {
	it('reads the scan before the cap and keeps the text layer over the capped picture', { timeout: 180_000 }, async () => {
		// ocr-scans.pdf p1 (a 300 ppi scan on a 6 × 4 in page) stored as a grey JPEG and drawn on a
		// 4.8 × 3.2 in page: 375 ppi, eligible for OCR (over 200 ppi) and oversized.
		const m = await mupdf();
		const scan = new m.PDFDocument(corpus('ocr-scans.pdf'));
		let jpeg: Uint8Array;
		let w = 0;
		let h = 0;
		try {
			let img: PDFObject | null = null;
			scan.findPage(0)
				.getInheritable('Resources')
				.get('XObject')
				.forEach((v) => {
					if (v.get('Subtype').asName() === 'Image') img = v;
				});
			const o = img as unknown as PDFObject;
			w = o.get('Width').asNumber();
			h = o.get('Height').asNumber();
			const pix = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, w, h], false);
			const b = o.readStream();
			pix.getPixels().set(b.asUint8Array());
			b.destroy();
			jpeg = pix.asJPEG(92).slice();
			pix.destroy();
		} finally {
			scan.destroy();
		}
		const doc = new m.PDFDocument();
		const pw = 345.6;
		const ph = 230.4;
		const res = doc.addObject(doc.newDictionary());
		const xo = doc.newDictionary();
		xo.put('Scan', doc.addImage(new m.Image(jpeg)));
		res.put('XObject', xo);
		doc.insertPage(-1, doc.addPage([0, 0, pw, ph], 0, res, `q ${pw} 0 0 ${ph} 0 0 cm /Scan Do Q`));
		const buf = doc.saveToBuffer('');
		const bytes = buf.asUint8Array().slice();
		buf.destroy();
		doc.destroy();

		const notes: string[] = [];
		const eng = createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots: 1 }) }, { debug: (n) => notes.push(n) });
		const src = await eng.openPdf(bytes, 'scan.pdf');
		expect(await eng.scannedPages(src)).toEqual([0]);
		expect(await eng.oversizedPictures(src)).toEqual([[0]]);
		const out = await eng.exportPlan({ pages: [ref(src, 0)], options: { ...defaultOptions, compress: true, ocr: true, printCap: true } }, [src], []);
		allOk(out);
		expect(out.ocr).toMatchObject({ eligible: 1, searchable: [1] });
		expect(out.printCap!.images, notes.join('\n')).toBe(1);
		expect(out.checks.find((c) => c.name === 'text-layer')?.ok).toBe(true);
		expect((await images(out.bytes))[0]).toMatchObject({ width: 1440, height: 960 });
		const [text] = await pageTexts(out.bytes);
		for (const word of ['Dear', 'house', 'Smith']) expect(text).toContain(word);
	});
});
