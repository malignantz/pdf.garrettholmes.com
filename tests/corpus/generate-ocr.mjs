#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for "Make scanned pages searchable" (src/lib/engine/ocr/): small scanned-style
 * pages made here, never copied from anywhere. Typed text is drawn with a standard font
 * by pdf-lib, rendered to a grey picture by MuPDF, and the picture alone is put on a new
 * page, so the page carries no text: what a scanner gives.
 *
 * ocr-scans.pdf (6 × 4 in pages):
 *   p1  typed English letter, lines turned 0.7° (a skewed scan), 300 ppi   → made searchable
 *   p2  the same picture turned 90°, page upright: text runs sideways       → declined (orientation)
 *   p3  rows of made-up words, 300 ppi                                     → declined (gate: no common English)
 *   p4  the letter at 150 ppi                                              → not tried (resolution)
 *   p5  the letter plus one line of real text                              → not tried (has text)
 *   p6  the letter with an old invisible OCR layer                         → not tried (has text)
 *   p7  born-digital text, no picture                                      → not tried
 *   p8  the letter's picture stored turned 90° on a /Rotate 270 page, so it shows upright → made searchable
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-ocr.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDocument, PDFName, StandardFonts, degrees } from '@cantoo/pdf-lib';
import * as mupdf from 'mupdf';

const here = path.dirname(fileURLToPath(import.meta.url));

export const LETTER = [
	'Dear Sir, thank you for your letter of the first of May.',
	'We have looked at the house on the hill and we would like',
	'to make an offer. The price is fair and the land is good,',
	'but the old water pump in the yard will need some work.',
	'Please tell us if the owner will take the offer, and when',
	'we could come to see the house again with our builder.',
	'We hope to move in before the end of the year.',
	'Yours truly, John Smith'
];

const W = 432;
const H = 288;

/** Deterministic made-up words (no common English). */
function gibberish() {
	let s = 7;
	const r = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
	const cons = 'bcdfghjklmnpqrstvwxz';
	const vow = 'aeiouy';
	const word = () => {
		let w = '';
		const n = 3 + Math.floor(r() * 5);
		for (let i = 0; i < n; i++) w += i % 2 ? vow[Math.floor(r() * vow.length)] : cons[Math.floor(r() * cons.length)];
		return w;
	};
	return Array.from({ length: 8 }, () => Array.from({ length: 7 }, word).join(' '));
}

/** Words of a page as MuPDF reads them: text and box (points, top-left origin). */
function wordsOf(page) {
	const out = [];
	let cur = null;
	const st = page.toStructuredText('preserve-whitespace');
	const flush = () => {
		if (cur) out.push({ t: cur.t, box: cur.box.map((v) => Math.round(v * 10) / 10) });
		cur = null;
	};
	st.walk({
		beginLine: flush,
		onChar(c, _o, _f, _s, q) {
			if (c.trim() === '') return flush();
			const xs = [q[0], q[2], q[4], q[6]];
			const ys = [q[1], q[3], q[5], q[7]];
			const b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
			if (!cur) cur = { t: '', box: b };
			cur.t += c;
			cur.box = [Math.min(cur.box[0], b[0]), Math.min(cur.box[1], b[1]), Math.max(cur.box[2], b[2]), Math.max(cur.box[3], b[3])];
		}
	});
	flush();
	st.destroy();
	return out;
}

/** A one-page PDF with typed lines, rendered by MuPDF to grey pixels at `dpi`; also its words. */
async function typed(lines, dpi, skew = 0) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const p = doc.addPage([W, H]);
	lines.forEach((t, i) => p.drawText(t, { x: 30, y: H - 40 - i * 28, size: 12, font, rotate: degrees(skew) }));
	const pdf = await doc.save();
	const mdoc = mupdf.Document.openDocument(pdf, 'application/pdf');
	const page = mdoc.loadPage(0);
	const words = wordsOf(page);
	const pix = page.toPixmap(mupdf.Matrix.scale(dpi / 72, dpi / 72), mupdf.ColorSpace.DeviceGray, false, true);
	const w = pix.getWidth();
	const h = pix.getHeight();
	const stride = pix.getStride();
	const src = pix.getPixels();
	const px = Buffer.alloc(w * h);
	for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w), y * w);
	pix.destroy();
	page.destroy();
	mdoc.destroy();
	return { w, h, px, words };
}

/** The picture turned 90° clockwise. */
function turnCw(img) {
	const { w, h, px } = img;
	const out = Buffer.alloc(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x * h + (h - 1 - y)] = px[y * w + x];
	return { w: h, h: w, px: out };
}

function appendContent(doc, page, text) {
	const extra = doc.context.register(doc.context.flateStream(text));
	const arr = page.node.get(PDFName.of('Contents'));
	if (arr instanceof PDFArray) arr.push(extra);
	else if (arr) page.node.set(PDFName.of('Contents'), doc.context.obj([arr, extra]));
	else page.node.set(PDFName.of('Contents'), doc.context.obj([extra]));
}

/** A page of size pw × ph that is only `img`, stretched over it. */
function picturePage(doc, img, pw, ph, indirectSize = false) {
	const page = doc.addPage([pw, ph]);
	const num = (n) => (indirectSize ? doc.context.register(doc.context.obj(n)) : n);
	const ref = doc.context.register(
		doc.context.stream(zlib.deflateSync(img.px, { level: 9 }), {
			Type: 'XObject',
			Subtype: 'Image',
			Width: num(img.w),
			Height: num(img.h),
			ColorSpace: 'DeviceGray',
			BitsPerComponent: 8,
			Filter: 'FlateDecode'
		})
	);
	const name = page.node.newXObject('Scan', ref);
	appendContent(doc, page, `q ${pw} 0 0 ${ph} 0 0 cm ${name.asString()} Do Q`);
	return page;
}

export async function ocrScans() {
	const letter = await typed(LETTER, 300, 0.7);
	const lowres = await typed(LETTER, 150, 0.7);
	const junk = await typed(gibberish(), 300, 0);
	const doc = await PDFDocument.create();
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	picturePage(doc, letter, W, H); // p1
	picturePage(doc, turnCw(letter), H, W); // p2: portrait page, text sideways
	picturePage(doc, junk, W, H); // p3
	picturePage(doc, lowres, W, H); // p4
	picturePage(doc, letter, W, H).drawText('Scanned on 12 May', { x: 300, y: 8, size: 7, font: helv }); // p5
	{
		const p = picturePage(doc, letter, W, H); // p6: an old OCR layer
		const f = p.node.newFontDictionary('OldOcr', helv.ref);
		appendContent(doc, p, `BT 3 Tr ${f.asString()} 12 Tf 30 248 Td (Dear Sir, thank you for your letter) Tj ET`);
	}
	{
		const p = doc.addPage([W, H]); // p7: born-digital
		LETTER.slice(0, 3).forEach((t, i) => p.drawText(t, { x: 30, y: H - 40 - i * 28, size: 12, font: helv }));
	}
	picturePage(doc, turnCw(letter), H, W).setRotation(degrees(270)); // p8: stored turned, shown upright
	return { bytes: await doc.save({ useObjectStreams: false, addDefaultPage: false }), words: letter.words };
}

export default async function generateOcrCorpus(write) {
	const { bytes, words } = await ocrScans();
	write('ocr-scans.pdf', bytes, {
		pages: 8,
		note: 'Make scanned pages searchable: p1 skewed typed letter 300 ppi (searchable); p2 same, sideways (declined: orientation); p3 made-up words (declined: gate); p4 150 ppi (not tried); p5 scan + real text (not tried); p6 scan + old invisible OCR layer (not tried); p7 born-digital (not tried); p8 picture stored turned on a /Rotate 270 page (searchable)',
		letter: LETTER,
		/** The letter's words where the typed page drew them (points, top-left origin; p1 and p8 as shown). */
		words,
		eligible: [0, 1, 2, 7],
		searchable: [0, 7],
		declined: [1, 2]
	});
	// Some scanner software stores the picture's /Width and /Height as separate objects.
	const letter = await typed(LETTER, 300, 0.7);
	const doc = await PDFDocument.create();
	picturePage(doc, letter, W, H, true);
	write('ocr-indirect-size.pdf', await doc.save({ useObjectStreams: false, addDefaultPage: false }), {
		pages: 1,
		note: 'Make scanned pages searchable: a 300 ppi scan whose image /Width and /Height are indirect references (qpdf lists them as "n 0 R"); the page must still be offered',
		eligible: [0]
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateOcrCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
