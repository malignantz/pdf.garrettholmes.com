/**
 * "Make scanned pages black and white" core (engine/bilevel.ts): the qualify test, the
 * threshold, the "nothing vanished" check and the encoders. Corpus:
 * tests/corpus/generate-bilevel.mjs (bilevel-scans.pdf).
 *
 * The encoders are checked against the decoders that matter: MuPDF (the engine) and PDF.js
 * (the app's renderer), with its wasm decoder and with its JS fallback, bit for bit.
 */
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
	BILEVEL_RULES,
	analyse,
	binarize,
	encodeG4,
	flateRows,
	makeBilevel,
	otsu,
	rowBytesOf,
	sameBits,
	vanished
} from '../../src/lib/engine/bilevel';
import { mupdf, type Mupdf } from '../../src/lib/engine/mupdf';
import { findCandidates } from '../../src/lib/engine/shrink';
import { corpus, loadPdfjs, manifest, root } from './helpers';

const T = 60_000;

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

/** Packed 1-bit rows (1 = white) from a predicate saying which pixels are black. */
function bitsOf(w: number, h: number, black: (x: number, y: number) => boolean): Uint8Array {
	const grey = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) grey[y * w + x] = black(x, y) ? 0 : 255;
	return binarize(grey, w, h, 127);
}

/** A one-page PDF drawing one 1-bit image stream with the given filter and parameters. */
function imagePdf(m: Mupdf, data: Uint8Array, w: number, h: number, filter: string, parms: Record<string, number>): Uint8Array {
	const doc = new m.PDFDocument();
	try {
		const dict = doc.newDictionary();
		dict.put('Type', doc.newName('XObject'));
		dict.put('Subtype', doc.newName('Image'));
		dict.put('ColorSpace', doc.newName('DeviceGray'));
		dict.put('Filter', doc.newName(filter));
		dict.put('Width', w);
		dict.put('Height', h);
		dict.put('BitsPerComponent', 1);
		const dp = doc.newDictionary();
		for (const [k, v] of Object.entries(parms)) dp.put(k, v);
		dict.put('DecodeParms', dp);
		const img = doc.addRawStream(data, dict);
		const res = doc.newDictionary();
		const xo = doc.newDictionary();
		xo.put('Im', img);
		res.put('XObject', xo);
		doc.insertPage(-1, doc.addPage([0, 0, w, h], 0, res, `q ${w} 0 0 ${h} 0 0 cm /Im Do Q`));
		return doc.saveToBuffer('').asUint8Array().slice();
	} finally {
		doc.destroy();
	}
}

/** The image's decoded bits as MuPDF reads the stream. */
async function mupdfBits(pdf: Uint8Array): Promise<Uint8Array> {
	const m = await mupdf();
	const doc = new m.PDFDocument(pdf);
	try {
		const img = doc.findPage(0).getInheritable('Resources').get('XObject').get('Im');
		return img.readStream().asUint8Array().slice();
	} finally {
		doc.destroy();
	}
}

/** The image's data as PDF.js hands it to the renderer (kind 1: 1 bit per pixel, 1 = white). */
async function pdfjsBits(pdf: Uint8Array, useWasm: boolean): Promise<{ kind: number; width: number; height: number; data: Uint8Array }> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({
		data: pdf.slice(),
		isOffscreenCanvasSupported: false,
		wasmUrl: path.join(root, 'node_modules/pdfjs-dist/wasm/'),
		useWasm,
		verbosity: 0
	} as never);
	try {
		const doc = await task.promise;
		const page = await doc.getPage(1);
		const ops = await page.getOperatorList();
		const i = ops.fnArray.indexOf(lib.OPS.paintImageXObject);
		expect(i).toBeGreaterThanOrEqual(0);
		return (await new Promise((res) => page.objs.get(ops.argsArray[i][0], res))) as never;
	} finally {
		await task.destroy();
	}
}

async function roundTrip(bits: Uint8Array, w: number, h: number) {
	const m = await mupdf();
	const g4 = encodeG4(bits, w, h);
	const pdf = imagePdf(m, g4, w, h, 'CCITTFaxDecode', { K: -1, Columns: w, Rows: h });
	const mu = await mupdfBits(pdf);
	expect(mu.length).toBe(rowBytesOf(w) * h);
	expect(sameBits(mu, bits, w, h)).toBe(true);
	for (const wasm of [true, false]) {
		const js = await pdfjsBits(pdf, wasm);
		expect([js.kind, js.width, js.height]).toEqual([1, w, h]);
		expect(sameBits(js.data, bits, w, h)).toBe(true);
	}
	return g4;
}

describe('CCITT G4 encoder', () => {
	it('round-trips small, odd-width and random pictures through MuPDF and PDF.js', { timeout: T }, async () => {
		await roundTrip(bitsOf(1, 1, () => true), 1, 1);
		await roundTrip(bitsOf(1, 1, () => false), 1, 1);
		await roundTrip(bitsOf(9, 3, (x, y) => (x + y) % 2 === 0), 9, 3);
		const r = prng(7);
		const noise = bitsOf(203, 61, () => r() < 0.5);
		await roundTrip(noise, 203, 61);
		// Text-like: vertical-mode heavy.
		await roundTrip(bitsOf(517, 120, (x, y) => (x % 23 < 3 && y % 30 < 20) || (y % 30 === 10 && x % 200 < 150)), 517, 120);
	});

	it('codes every run length up to 2,700 of both colours (terminating, make-up and extended codes)', { timeout: T }, async () => {
		// Row y: a white run of y·9 pixels then black for the rest; the next row the colours swap,
		// so most rows go through horizontal mode with distinct run lengths.
		const w = 2730;
		const h = 304;
		const bits = bitsOf(w, h, (x, y) => {
			const run = Math.floor(y / 2) * 18 + (y % 2) * 9;
			return y % 4 < 2 ? x >= run : x < run;
		});
		await roundTrip(bits, w, h);
		// And runs of every length 0–130 (the terminating/make-up boundary) in one row each.
		const w2 = 400;
		const bits2 = bitsOf(w2, 131, (x, y) => x >= y && x < 2 * y + 3);
		await roundTrip(bits2, w2, 131);
	});

	it('is smaller than the packed bits for text-like pictures', () => {
		const w = 1000;
		const h = 400;
		const bits = bitsOf(w, h, (x, y) => (x % 23 < 3 && y % 30 < 20) || (y % 30 === 10 && x % 200 < 150));
		expect(encodeG4(bits, w, h).length).toBeLessThan((rowBytesOf(w) * h) / 10);
	});
});

describe('Flate rows', () => {
	it('decode through MuPDF with PNG predictors (1 bit per pixel)', { timeout: T }, async () => {
		const m = await mupdf();
		const r = prng(3);
		const w = 131;
		const h = 40;
		const bits = bitsOf(w, h, (x, y) => (y < 20 ? (x * y) % 7 === 0 : r() < 0.3));
		const pdf = imagePdf(m, zlib.deflateSync(flateRows(bits, w, h)), w, h, 'FlateDecode', { Predictor: 15, Colors: 1, BitsPerComponent: 1, Columns: w });
		expect(sameBits(await mupdfBits(pdf), bits, w, h)).toBe(true);
		const js = await pdfjsBits(pdf, false);
		expect(sameBits(js.data, bits, w, h)).toBe(true);
	});
});

describe('threshold and helpers', () => {
	it('otsu splits two peaks between them', () => {
		const hist = new Array(256).fill(0);
		for (let i = 0; i < 20; i++) hist[30 + i] = 50;
		for (let i = 0; i < 20; i++) hist[220 + i] = 900;
		const t = otsu(hist);
		expect(t).toBeGreaterThanOrEqual(49);
		expect(t).toBeLessThan(220);
	});

	it('sameBits ignores the padding bits of each row', () => {
		const a = new Uint8Array([0b10100000, 0b11000000]);
		const b = new Uint8Array([0b10100111, 0b11011111]);
		expect(sameBits(a, b, 3, 2)).toBe(true);
		expect(sameBits(a, new Uint8Array([0b10000000, 0b11000000]), 3, 2)).toBe(false);
	});
});

/** The pictures of bilevel-scans.pdf: samples, size and resolution. */
async function scans() {
	const m = await mupdf();
	const doc = new m.PDFDocument(corpus('bilevel-scans.pdf'));
	try {
		const cands = findCandidates(doc).sort((a, b) => Math.min(...a.pages) - Math.min(...b.pages));
		return cands.map((c) => {
			const buf = doc.newIndirect(c.num).readStream();
			const samples = buf.asUint8Array().slice();
			buf.destroy();
			return { samples, w: c.width, h: c.height, n: c.n, ppi: Math.min(c.width / c.inW, c.height / c.inH) };
		});
	} finally {
		doc.destroy();
	}
}

describe('qualify test and "nothing vanished" (bilevel-scans.pdf)', () => {
	it('converts the black-on-white pages and refuses the others', { timeout: T }, async () => {
		const pics = await scans();
		const meta = manifest['bilevel-scans.pdf'] as { converted: number[]; refused: number[] };
		expect(pics.length).toBe(6);
		const verdicts = pics.map((p) => makeBilevel(p.samples, p.w, p.h, p.n, p.ppi));
		for (const i of meta.converted) {
			expect(verdicts[i].ok, `p${i + 1}: ${verdicts[i].reason}`).toBe(true);
			const bits = verdicts[i].bits!;
			expect(bits.length).toBe(rowBytesOf(pics[i].w) * pics[i].h);
		}
		for (const i of meta.refused) expect(verdicts[i].ok, `p${i + 1}`).toBe(false);
		expect(verdicts[2].reason).toBe('colour');
		expect(verdicts[4].reason).toBe('colour');
		expect(['grey', 'vanished']).toContain(verdicts[1].reason);
		expect(['grey', 'vanished']).toContain(verdicts[3].reason);
	});

	it('the check alone catches a faint line the qualify test would let through', { timeout: T }, async () => {
		const [p] = await scans();
		// A light-grey line 0.5 in long, 3 px thick (darkness about 0.35), below the text.
		const a = analyse(p.samples, p.w, p.h, p.n, p.ppi);
		const grey = a.grey.slice();
		for (let y = 400; y < 403; y++) for (let x = 100; x < 250; x++) grey[y * p.w + x] = Math.round(a.paper - 0.35 * (a.paper - a.ink));
		const bits = binarize(grey, p.w, p.h, a.threshold);
		const v = vanished(grey, bits, p.w, p.h, p.ppi, a.paper, a.ink);
		expect(v.ok).toBe(false);
		expect(v.lost!.extent).toBeGreaterThanOrEqual(BILEVEL_RULES.minExtent);
		// A speck of the same grey (0.03 in) is let go.
		const speck = a.grey.slice();
		for (let y = 400; y < 409; y++) for (let x = 100; x < 109; x++) speck[y * p.w + x] = Math.round(a.paper - 0.35 * (a.paper - a.ink));
		const vs = vanished(speck, binarize(speck, p.w, p.h, a.threshold), p.w, p.h, p.ppi, a.paper, a.ink);
		expect(vs.ok).toBe(true);
	});

	it('refuses pictures under the resolution floor and with too little contrast', () => {
		const w = 300;
		const h = 200;
		const flat = new Uint8Array(w * h).fill(200);
		expect(analyse(flat, w, h, 1, 300).reason).toBe('contrast');
		const text = new Uint8Array(w * h);
		for (let i = 0; i < w * h; i++) text[i] = i % 17 < 2 ? 20 : 240;
		expect(analyse(text, w, h, 1, 150).reason).toBe('resolution');
	});

	it('G4 of a converted corpus page decodes to the same bits in MuPDF and PDF.js', { timeout: T }, async () => {
		const [p] = await scans();
		const v = makeBilevel(p.samples, p.w, p.h, p.n, p.ppi);
		expect(v.ok).toBe(true);
		const g4 = await roundTrip(v.bits!, p.w, p.h);
		// Text on paper: far below the JPEG it came from.
		expect(g4.length).toBeLessThan(p.samples.length / 50);
	});
});
