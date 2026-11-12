/**
 * "Make scanned pages searchable": which pages qualify (ocr/eligible.ts) and the text
 * layer writer (ocr/layer.ts), with OCR results made by hand from where the corpus
 * generator drew the words (tests/corpus/generate-ocr.mjs), so no OCR engine runs here.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import * as PL from '@cantoo/pdf-lib';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { pageTextOf } from '../../src/lib/engine/page-text';
import { renderAndCompare } from '../../src/lib/engine/shrink';
import { checkScanPage, scannedPagesOf } from '../../src/lib/engine/ocr/eligible';
import { GLYPHLESS_TTF_SHA256, glyphlessTtf } from '../../src/lib/engine/ocr/glyphless';
import { MIN_GAP, cleanText, layoutLines, writeLayers, type LayerPage } from '../../src/lib/engine/ocr/layer';
import { norm, type OcrWord } from '../../src/lib/engine/ocr/gate';
import type { OcrLine, OcrRead } from '../../src/lib/engine/ocr/tess';
import { corpus, loadPdfjs, manifest, nodeAssets, root } from './helpers';

const meta = manifest['ocr-scans.pdf'] as { words: { t: string; box: [number, number, number, number] }[]; eligible: number[] };
const DPI = 300;
const K = DPI / 72;
const W = 432;
const H = 288;

/** The letter's words as an OCR result would give them (pixels at 300 dpi), lines by baseline. */
function handRead(turn = 0): OcrRead {
	const lines = new Map<number, OcrWord[]>();
	for (const w of meta.words) {
		const li = Math.round(((w.box[1] + w.box[3]) / 2 - 35) / 28);
		const list = lines.get(li) ?? [];
		list.push([w.t, w.box[0] * K, w.box[1] * K, w.box[2] * K, w.box[3] * K, 95]);
		lines.set(li, list);
	}
	const width = Math.round(W * K);
	const height = Math.round(H * K);
	// As if Tesseract had turned the image by `turn` about its centre before reading.
	const cx = width / 2;
	const cy = height / 2;
	const fwd = (x: number, y: number): [number, number] => [Math.cos(turn) * (x - cx) - Math.sin(turn) * (y - cy) + cx, Math.sin(turn) * (x - cx) + Math.cos(turn) * (y - cy) + cy];
	const out: OcrLine[] = [];
	for (const words of [...lines.entries()].sort((a, b) => a[0] - b[0]).map(([, ws]) => ws)) {
		const first = words[0];
		const last = words[words.length - 1];
		// Baseline through the boxes' bottoms (the typed lines lean 0.7°).
		let [bx0, by0] = [first[1], first[4]];
		let [bx1, by1] = [last[3], last[4]];
		const turned = words.map((w) => {
			if (!turn) return w;
			// Box of the word in the turned image (its centre turned; size kept).
			const [x, y] = fwd((w[1] + w[3]) / 2, (w[2] + w[4]) / 2);
			const hw = (w[3] - w[1]) / 2;
			const hh = (w[4] - w[2]) / 2;
			return [w[0], x - hw, y - hh, x + hw, y + hh, w[5]] as OcrWord;
		});
		if (turn) {
			[bx0, by0] = fwd(bx0, by0);
			[bx1, by1] = fwd(bx1, by1);
		}
		out.push({ baseline: [bx0, by0, bx1, by1], words: turned });
	}
	return { width, height, rotate: turn, lines: out };
}

/** Words the highlighter reads on page `p` of `bytes`, boxes in points (page as displayed). */
async function hlWords(bytes: Uint8Array, p: number) {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes, 'application/pdf');
	try {
		const page = doc.loadPage(p);
		const [x0, y0, x1, y1] = page.getBounds();
		page.destroy();
		const pw = x1 - x0;
		const ph = y1 - y0;
		return pageTextOf(doc, p).words.map((w) => ({ t: w.text, x0: w.box.x * pw, y0: w.box.y * ph, x1: (w.box.x + w.box.w) * pw, y1: (w.box.y + w.box.h) * ph }));
	} finally {
		doc.destroy();
	}
}

/** Share of the letter's words the highlighter offers at the place they were drawn. */
async function placedShare(bytes: Uint8Array, p: number, map: (x: number, y: number) => [number, number] = (x, y) => [x, y]) {
	const hl = await hlWords(bytes, p);
	let ok = 0;
	for (const w of meta.words) {
		const [cx, cy] = map((w.box[0] + w.box[2]) / 2, (w.box[1] + w.box[3]) / 2);
		if (hl.some((h) => h.t === w.t && cx >= h.x0 && cx <= h.x1 && cy >= h.y0 && cy <= h.y1)) ok++;
	}
	return ok / meta.words.length;
}

async function pdfjsTokens(bytes: Uint8Array, p: number): Promise<string[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const tc = await (await doc.getPage(p + 1)).getTextContent();
		return tc.items
			.map((it) => ('str' in it ? it.str : ''))
			.join(' ')
			.split(/\s+/)
			.map(norm)
			.filter(Boolean);
	} finally {
		await task.destroy();
	}
}

async function samePixels(a: Uint8Array, b: Uint8Array, p: number) {
	const m = await mupdf();
	const da = new m.PDFDocument(a);
	const db = new m.PDFDocument(b);
	try {
		return renderAndCompare(m, da, db, p);
	} finally {
		da.destroy();
		db.destroy();
	}
}

const job = (read: OcrRead, pageIndex = 0, userRotation: LayerPage['userRotation'] = 0): LayerPage => ({ pageIndex, userRotation, read, dpi: DPI });

describe('OCR: which pages qualify', () => {
	it('tries only picture pages of 200 ppi and more without any text', async () => {
		const qpdf = new Qpdf(nodeAssets().qpdf);
		const bytes = corpus('ocr-scans.pdf');
		const sizes = Array.from({ length: 8 }, (_, i) => (i === 1 ? { width: H, height: W } : { width: W, height: H }));
		expect(await scannedPagesOf(qpdf, mupdf, bytes, sizes)).toEqual(meta.eligible);
		const m = await mupdf();
		const doc = m.Document.openDocument(bytes, 'application/pdf');
		try {
			const why = Array.from({ length: 8 }, (_, i) => checkScanPage(m, doc, i));
			expect(why.map((w) => w.reason ?? 'ok')).toEqual(['ok', 'ok', 'ok', 'low resolution', 'text', 'text', 'text', 'ok']);
			expect(why[0].ppi).toBeCloseTo(300, 0);
			expect(why[3].ppi).toBeCloseTo(150, 0);
			expect(why[0].cover).toBeCloseTo(1, 3);
		} finally {
			doc.destroy();
		}
	});

	it('skips the highlighter corpus scan page without text only when it is too coarse', async () => {
		const m = await mupdf();
		const doc = m.Document.openDocument(corpus('hl-text.pdf'), 'application/pdf');
		try {
			// p6 has an invisible OCR layer over a scan; p7 is a small grey picture, far under 200 ppi.
			expect(checkScanPage(m, doc, 5)).toMatchObject({ eligible: false, reason: 'text' });
			expect(checkScanPage(m, doc, 6).eligible).toBe(false);
		} finally {
			doc.destroy();
		}
	});
});

describe('OCR: writing the text layer', () => {
	it('uses the 572-byte glyphless font of Tesseract', () => {
		const ttf = glyphlessTtf();
		expect(ttf.length).toBe(572);
		expect(createHash('sha256').update(ttf).digest('hex')).toBe(GLYPHLESS_TTF_SHA256);
	});

	it('ships the measured tessdata_fast English and orientation data', () => {
		const sha = (name: string) => createHash('sha256').update(zlib.gunzipSync(fs.readFileSync(path.join(root, 'src/lib/engine/vendor/tesseract', name)))).digest('hex');
		// The SHA-256s tools/ocr/fetch-models.sh pinned for the measurement.
		expect(sha('eng.traineddata.gz')).toBe('7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2');
		expect(sha('osd.traineddata.gz')).toBe('9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff');
	});

	it('cleans text the font cannot carry', () => {
		expect(cleanText('ab\u0000c')).toBe('abc');
		expect(cleanText('�')).toBe('');
		expect(cleanText('x😀y')).toBe('xy');
		expect(cleanText(' “Dear” ')).toBe('“Dear”');
	});

	it('puts every word where it is on the picture, invisibly', async () => {
		const src = corpus('ocr-scans.pdf');
		const r = await writeLayers(PL, src, [job(handRead())]);
		expect(r.skipped.size).toBe(0);
		expect(r.written.get(0)?.length).toBe(meta.words.length);
		const px = await samePixels(src, r.bytes, 0);
		expect(px).toMatchObject({ pageMean: 0, blockMean: 0 });
		expect(await placedShare(r.bytes, 0)).toBeGreaterThanOrEqual(0.98);
		const tokens = await pdfjsTokens(r.bytes, 0);
		for (const w of meta.words) expect(tokens).toContain(norm(w.t));
		// Other pages untouched: no text, same pixels.
		expect(await hlWords(r.bytes, 3)).toEqual([]);
		expect(await samePixels(src, r.bytes, 3)).toMatchObject({ pageMean: 0 });
	});

	it('turns lines back by the deskew angle Tesseract applied', async () => {
		const src = corpus('ocr-scans.pdf');
		const r = await writeLayers(PL, src, [job(handRead(0.03))]);
		expect(await placedShare(r.bytes, 0)).toBeGreaterThanOrEqual(0.98);
	});

	it('follows /Rotate: the picture stored turned on a /Rotate 270 page', async () => {
		const src = corpus('ocr-scans.pdf');
		// p8 shows the letter upright, so OCR coordinates of the page as shown are the same as p1's.
		const r = await writeLayers(PL, src, [job(handRead(), 7)]);
		expect(await placedShare(r.bytes, 7)).toBeGreaterThanOrEqual(0.98);
		expect(await samePixels(src, r.bytes, 7)).toMatchObject({ pageMean: 0, blockMean: 0 });
	});

	it('ignores the rotation the user added (it is only /Rotate)', async () => {
		const doc = await PL.PDFDocument.load(corpus('ocr-scans.pdf'));
		doc.getPage(0).setRotation(PL.degrees(90));
		const turned = await doc.save();
		const r = await writeLayers(PL, turned, [job(handRead(), 0, 90)]);
		// Shown turned 90° clockwise: a point (x, y) of the upright page is at (H - y, x).
		expect(await placedShare(r.bytes, 0, (x, y) => [H - y, x])).toBeGreaterThanOrEqual(0.98);
	});

	it('keeps the layer in place when the original content leaves its graphics state unbalanced', async () => {
		const doc = await PL.PDFDocument.load(corpus('ocr-scans.pdf'));
		const page = doc.getPage(0);
		const node = page.node;
		const contents = node.Contents() as PL.PDFArray;
		// A stray Q first, then a scale left behind inside an unclosed q (drawn after the picture).
		contents.insert(0, doc.context.register(doc.context.flateStream('Q\n')));
		contents.push(doc.context.register(doc.context.flateStream('q 0.5 0 0 0.5 100 100 cm q\n')));
		const odd = await doc.save();
		const r = await writeLayers(PL, odd, [job(handRead())]);
		expect(r.written.has(0)).toBe(true);
		expect(await placedShare(r.bytes, 0)).toBeGreaterThanOrEqual(0.98);
		expect(await samePixels(odd, r.bytes, 0)).toMatchObject({ pageMean: 0, blockMean: 0 });
	});

	it('leaves the file alone when there is nothing to write', async () => {
		const src = corpus('ocr-scans.pdf');
		const r = await writeLayers(PL, src, [job({ width: 1800, height: 1200, rotate: 0, lines: [{ baseline: null, words: [['�', 1, 1, 50, 50, 99]] }] })]);
		expect(r.bytes).toBe(src);
		expect(r.written.size).toBe(0);
		expect(r.skipped.get(0)).toBe('no words to write');
	});
});

describe('highlighter over an OCR layer (invisible glyphless text)', () => {
	it('keeps each line band off the next one where their font boxes overlap', async () => {
		// Two tight lines: the first has a deep descender ("gypsy"), the second a tall capital,
		// so the em boxes the writer gives them overlap by about 3 pt.
		const line = (y0: number, y1: number, base: number, words: [string, number, number][]) => ({
			baseline: [words[0][1], base, words[words.length - 1][2], base] as [number, number, number, number],
			words: words.map(([t, x0, x1]) => [t, x0, t === 'gypsy' ? y0 : y0 + 8, x1, t === 'gypsy' ? y1 : base, 95] as OcrWord)
		});
		const read: OcrRead = {
			width: 1800,
			height: 1200,
			rotate: 0,
			lines: [line(100, 160, 145, [['gypsy', 125, 300], ['jump', 320, 460]]), line(130, 200, 190, [['Tall', 125, 280], ['hat', 300, 400]])]
		};
		read.lines[1].words[0][2] = 125; // the capital reaches up into the line above
		const doc = await PL.PDFDocument.create();
		doc.addPage([432, 288]);
		const blank = await doc.save();
		const r = await writeLayers(PL, blank, [job(read)]);
		const m = await mupdf();
		const d = m.Document.openDocument(r.bytes, 'application/pdf');
		try {
			const words = (opts: { inklessCut?: boolean }) => {
				const ws = pageTextOf(d, 0, { ...opts, m }).words;
				const box = (t: string) => ws.find((w) => w.text === t)!.box;
				return { gypsy: box('gypsy'), Tall: box('Tall') };
			};
			const old = words({ inklessCut: false });
			expect(old.gypsy.y + old.gypsy.h).toBeGreaterThan(old.Tall.y + 0.005);
			const now = words({});
			expect(now.gypsy.y + now.gypsy.h).toBeLessThanOrEqual(now.Tall.y + 1e-9);
		} finally {
			d.destroy();
		}
	});

	it('leaves visible text and fonts drawn without outlines as they were', async () => {
		const m = await mupdf();
		const d = m.Document.openDocument(corpus('hl-text.pdf'), 'application/pdf');
		try {
			for (let p = 0; p < 10; p++) expect(pageTextOf(d, p, { m })).toEqual(pageTextOf(d, p, { m, inklessCut: false }));
		} finally {
			d.destroy();
		}
	});
});

describe('word spacing in the OCR layer', () => {
	it('keeps touching or slightly overlapping OCR words apart for PDF.js, and leaves deep overlaps alone', async () => {
		// Each line: "was" then "a" at a gap of g em (line height 55 px), then "follows:";
		// and two OCR lines on one baseline ("prepared" | "as").
		const gaps = [-0.1, -0.03, 0, 0.03];
		const lines: OcrLine[] = gaps.map((g, i) => {
			const y0 = 100 + i * 80;
			const x2 = 187 + g * 55;
			return {
				baseline: [100, y0 + 42, x2 + 170, y0 + 42],
				words: [
					['was', 100, y0 + 14, 187, y0 + 42, 95],
					['a', x2, y0, x2 + 25, y0 + 58, 95],
					['follows:', x2 + 50, y0, x2 + 170, y0 + 42, 95]
				]
			};
		});
		lines.push({ baseline: [100, 600, 300, 600], words: [['prepared', 100, 560, 300, 600, 95]] }, { baseline: [301, 600, 400, 600], words: [['as', 301, 570, 340, 600, 95]] });
		// A deep overlap: "it" inside the end of "contains".
		lines.push({ baseline: [100, 700, 400, 700], words: [['contains', 100, 660, 300, 700, 95], ['it', 270, 665, 298, 700, 95], ['all', 320, 665, 380, 700, 95]] });
		const doc = await PL.PDFDocument.create();
		doc.addPage([612, 792]);
		const r = await writeLayers(PL, await doc.save(), [job({ width: 2550, height: 3300, rotate: 0, lines })]);
		const tokens = await pdfjsTokens(r.bytes, 0);
		expect(tokens.filter((t) => t === 'was')).toHaveLength(4);
		expect(tokens.filter((t) => t === 'a')).toHaveLength(4);
		expect(tokens).toContain('prepared');
		expect(tokens).toContain('as');
		expect(tokens).toContain('contains');
		expect(tokens).toContain('it');
		const laid = layoutLines({ width: 2550, height: 3300, rotate: 0, lines }, 300);
		for (const l of laid.slice(0, 4)) expect(l.words[0].gap!).toBeGreaterThanOrEqual(MIN_GAP * l.size - 1e-9);
		// The deep overlap keeps OCR's geometry.
		expect(laid[6].words[0].gap!).toBeLessThan(0);
	});
});
