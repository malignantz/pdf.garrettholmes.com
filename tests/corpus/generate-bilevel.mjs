#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for "Make scanned pages black and white" (src/lib/engine/bilevel.ts): small
 * scanned-style pages made here, never copied from anywhere. Typed text is drawn with a
 * standard font by pdf-lib, rendered by MuPDF to RGB pixels, given scanner traits (paper
 * tone, ink level, a little noise) and stored alone on a page as an RGB JPEG.
 *
 * bilevel-scans.pdf (3 × 1.5 in pages, pictures at 300 ppi, 900 × 450):
 *   p1  typed lines, black on near-white paper                          → converted
 *   p2  the same plus a line printed in light grey (0.7)                → refused (grey content)
 *   p3  the same plus a red stamp                                       → refused (colour)
 *   p4  the same plus a pencil-grey scribble (0.58, thin)               → refused (grey or vanished)
 *   p5  the same with a colour photo patch                              → refused (colour)
 *   p6  the typed lines on yellowed paper (236, 222, 190)               → converted
 *
 * bilevel-mixed.pdf (6 × 4 in pages; the export tests and e2e):
 *   p1  a typed English letter, black on white, grey JPEG at 300 ppi         → converted (and OCR reads it)
 *   p2  the letter with a red PAID stamp, RGB JPEG at 200 ppi                 → left (colour)
 *   p3  the letter with a pencil-grey scribble, grey JPEG at 200 ppi          → left (faint mark)
 *   p4  born-digital text, no picture                                        → not a scanned page
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-bilevel.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, StandardFonts, rgb } from '@cantoo/pdf-lib';
import * as mupdf from 'mupdf';

const here = path.dirname(fileURLToPath(import.meta.url));
const PW = 216;
const PH = 108;
const PPI = 300;

export const LINES = ['Invoice 4471-0082, due 03/01/2026', 'Amount $1,240.00, account 88-2041-B', 'Please keep this notice with your records.'];

function prng(seed) {
	let s = seed;
	return () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648);
}

/** The page drawn by `extra` (after the typed lines), rendered to RGB at PPI. */
async function render(extra) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const p = doc.addPage([PW, PH]);
	LINES.forEach((t, i) => p.drawText(t, { x: 12, y: PH - 22 - i * 15, size: 9, font }));
	extra?.(p, font);
	const md = mupdf.Document.openDocument(await doc.save(), 'application/pdf');
	const page = md.loadPage(0);
	const pix = page.toPixmap(mupdf.Matrix.scale(PPI / 72, PPI / 72), mupdf.ColorSpace.DeviceRGB, false, true);
	const w = pix.getWidth();
	const h = pix.getHeight();
	const stride = pix.getStride();
	const src = pix.getPixels();
	const px = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 3), y * w * 3);
	pix.destroy();
	page.destroy();
	md.destroy();
	return { w, h, px };
}

/** Scanner traits: white → paper, black → ink, a little noise. */
function scan({ w, h, px }, paper = [242, 241, 238], ink = 25, seed = 1) {
	const rnd = prng(seed);
	const out = new Uint8Array(px.length);
	for (let i = 0; i < px.length; i++) {
		const v = ink + (px[i] / 255) * (paper[i % 3] - ink) + (rnd() - 0.5) * 6;
		out[i] = Math.max(0, Math.min(255, Math.round(v)));
	}
	return { w, h, px: out };
}

function jpeg({ w, h, px }, quality = 80) {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
	pix.getPixels().set(px);
	const out = pix.asJPEG(quality).slice();
	pix.destroy();
	return out;
}

function picturePage(doc, img) {
	const page = doc.addPage([PW, PH]);
	const ref = doc.context.register(
		doc.context.stream(jpeg(img), { Type: 'XObject', Subtype: 'Image', Width: img.w, Height: img.h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })
	);
	const name = page.node.newXObject('Scan', ref);
	page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`q ${PW} 0 0 ${PH} 0 0 cm ${name.asString()} Do Q`)));
}

export async function bilevelScans() {
	const plain = await render();
	const lightGrey = await render((p, font) => p.drawText('COPY received 02/16/2026', { x: 12, y: 20, size: 9, font, color: rgb(0.7, 0.7, 0.7) }));
	const stamp = await render((p, font) => {
		p.drawEllipse({ x: 170, y: 30, xScale: 30, yScale: 18, borderColor: rgb(0.8, 0.15, 0.15), borderWidth: 2 });
		p.drawText('PAID', { x: 154, y: 25, size: 12, font, color: rgb(0.8, 0.15, 0.15) });
	});
	const pencil = await render((p) =>
		p.drawSvgPath('M 0 10 C 8 -6 14 22 22 6 S 34 -2 42 10 C 46 16 54 0 62 8 S 76 16 84 2', { x: 20, y: 40, borderColor: rgb(0.58, 0.58, 0.6), borderWidth: 0.6 })
	);
	const photo = scan(plain);
	{
		// A colour photo patch (0.6 × 0.4 in) at the lower right.
		const rnd = prng(9);
		const pw = 180;
		const ph = 120;
		for (let y = 0; y < ph; y++)
			for (let x = 0; x < pw; x++) {
				const o = ((photo.h - ph - 15 + y) * photo.w + (photo.w - pw - 15 + x)) * 3;
				photo.px[o] = 40 + (180 * x) / pw + rnd() * 10;
				photo.px[o + 1] = 60 + (150 * y) / ph + rnd() * 10;
				photo.px[o + 2] = 160 - (100 * (x + y)) / (pw + ph) + rnd() * 10;
			}
	}
	const doc = await PDFDocument.create();
	picturePage(doc, scan(plain));
	picturePage(doc, scan(lightGrey));
	picturePage(doc, scan(stamp));
	picturePage(doc, scan(pencil));
	picturePage(doc, photo);
	picturePage(doc, scan(plain, [236, 222, 190], 30, 2));
	return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

const LETTER = [
	'Dear Sir, thank you for your letter of the first of May.',
	'We have looked at the house on the hill and we would like',
	'to make an offer. The price is fair and the land is good,',
	'but the old water pump in the yard will need some work.',
	'Please tell us if the owner will take the offer, and when',
	'we could come to see the house again with our builder.',
	'Yours truly, John Smith'
];
const MW = 432;
const MH = 288;

/** The letter on a 6 × 4 in page with `extra` drawn after it, rendered to RGB at `ppi`. */
async function letter(ppi, extra) {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const p = doc.addPage([MW, MH]);
	LETTER.forEach((t, i) => p.drawText(t, { x: 30, y: MH - 40 - i * 26, size: 12, font }));
	extra?.(p, font);
	const md = mupdf.Document.openDocument(await doc.save(), 'application/pdf');
	const page = md.loadPage(0);
	const pix = page.toPixmap(mupdf.Matrix.scale(ppi / 72, ppi / 72), mupdf.ColorSpace.DeviceRGB, false, true);
	const w = pix.getWidth();
	const h = pix.getHeight();
	const stride = pix.getStride();
	const src = pix.getPixels();
	const px = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++) px.set(src.subarray(y * stride, y * stride + w * 3), y * w * 3);
	pix.destroy();
	page.destroy();
	md.destroy();
	return { w, h, px };
}

function toGrey({ w, h, px }) {
	const g = new Uint8Array(w * h);
	for (let i = 0; i < w * h; i++) g[i] = Math.round(0.299 * px[i * 3] + 0.587 * px[i * 3 + 1] + 0.114 * px[i * 3 + 2]);
	return { w, h, px: g, grey: true };
}

function jpegPage(doc, img, pw, ph, quality) {
	const cs = img.grey ? mupdf.ColorSpace.DeviceGray : mupdf.ColorSpace.DeviceRGB;
	const pix = new mupdf.Pixmap(cs, [0, 0, img.w, img.h], false);
	pix.getPixels().set(img.px);
	const data = pix.asJPEG(quality).slice();
	pix.destroy();
	const page = doc.addPage([pw, ph]);
	const ref = doc.context.register(
		doc.context.stream(data, { Type: 'XObject', Subtype: 'Image', Width: img.w, Height: img.h, ColorSpace: img.grey ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })
	);
	const name = page.node.newXObject('Scan', ref);
	page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.flateStream(`q ${pw} 0 0 ${ph} 0 0 cm ${name.asString()} Do Q`)));
}

export async function bilevelMixed() {
	const doc = await PDFDocument.create();
	const font = await doc.embedFont(StandardFonts.Helvetica);
	jpegPage(doc, toGrey(scan(await letter(300), [244, 244, 242], 20, 3)), MW, MH, 70);
	jpegPage(
		doc,
		scan(
			await letter(200, (p, f) => {
				p.drawEllipse({ x: 350, y: 60, xScale: 50, yScale: 28, borderColor: rgb(0.8, 0.15, 0.15), borderWidth: 3 });
				p.drawText('PAID', { x: 323, y: 52, size: 20, font: f, color: rgb(0.8, 0.15, 0.15) });
			}),
			[244, 244, 242],
			20,
			4
		),
		MW,
		MH,
		70
	);
	jpegPage(
		doc,
		toGrey(
			scan(
				await letter(200, (p) =>
					p.drawSvgPath('M 0 12 C 10 -8 18 28 28 8 S 44 -2 54 12 C 60 20 70 0 80 10 S 98 22 108 4', { x: 260, y: 70, borderColor: rgb(0.6, 0.6, 0.62), borderWidth: 0.7 })
				),
				[244, 244, 242],
				20,
				5
			)
		),
		MW,
		MH,
		70
	);
	const p4 = doc.addPage([MW, MH]);
	LETTER.slice(0, 3).forEach((t, i) => p4.drawText(t, { x: 30, y: MH - 40 - i * 26, size: 12, font }));
	return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export default async function generateBilevelCorpus(write) {
	write('bilevel-mixed.pdf', await bilevelMixed(), {
		pages: 4,
		note: 'Black and white scans, mixed: p1 typed English letter, grey JPEG 300 ppi (converted; OCR reads it); p2 the letter with a red stamp, RGB 200 ppi (left: colour); p3 the letter with a pencil scribble, grey 200 ppi (left: faint mark); p4 born-digital text (not a scanned page)',
		eligible: [0, 1, 2],
		converted: [0],
		left: [1, 2],
		letter: LETTER
	});
	write('bilevel-scans.pdf', await bilevelScans(), {
		pages: 6,
		note: 'Black and white scans: 300 ppi RGB JPEG pages: p1 typed lines (converted); p2 + light grey line (refused); p3 + red stamp (refused: colour); p4 + pencil scribble (refused); p5 + colour photo (refused: colour); p6 typed lines on yellowed paper (converted)',
		ppi: PPI,
		converted: [0, 5],
		refused: [1, 2, 3, 4]
	});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateBilevelCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
