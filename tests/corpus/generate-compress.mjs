#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for lossless compression (src/lib/engine/pack.ts, cleanup.ts).
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only these files:
 *   node tests/corpus/generate-compress.mjs
 * which merges their entries into the existing manifest.json.
 *
 * - compress-predictor.pdf: a photo-like RGB image stored with a PNG predictor (the
 *   way many producers store screenshots and figures). qpdf --recompress-flate drops
 *   the predictor, which made the image (and the file) grow.
 * - compress-dupes.pdf: two copies of one page, each bringing its own copy of the same
 *   embedded font and the same image (what merging files often gives).
 * - compress-form-fonts.pdf: a fillable text field whose /DA uses an embedded font in
 *   /AcroForm /DR that has far more glyphs than the page shows; a subset would lose the
 *   letters someone types later.
 * - compress-subset.pdf: an embedded font (no subset tag) with far more glyphs than the
 *   page uses, plus an outline, a link, page labels and an attachment.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

const here = path.dirname(fileURLToPath(import.meta.url));
const fontBytes = fs.readFileSync(path.join(here, '../../src/lib/engine/fonts/NotoSans-Regular.ttf'));
const LATIN = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,;:!?()[]-+/@&%$#ÀÁÂÄÇÈÉÊËÌÍÎÏÑÒÓÔÖÙÚÛÜßàáâäçèéêëìíîïñòóôöùúûüÿ';

function prng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Smooth RGB with soft noise: compresses well only with a predictor. */
function smoothRgb(w, h, seed) {
	const rnd = prng(seed);
	const px = new Uint8Array(w * h * 3);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const o = (y * w + x) * 3;
			const n = Math.floor(rnd() * 3);
			px[o] = (40 + (180 * x) / w + n) & 255;
			px[o + 1] = (60 + (150 * y) / h + n) & 255;
			px[o + 2] = (200 - (120 * (x + y)) / (w + h) + n) & 255;
		}
	return px;
}

/** PNG "Paeth" filter on every row (PDF Predictor 15 data). */
function paethRows(px, w, h, n) {
	const row = w * n;
	const out = new Uint8Array((row + 1) * h);
	for (let y = 0; y < h; y++) {
		out[y * (row + 1)] = 4;
		for (let i = 0; i < row; i++) {
			const x = px[y * row + i];
			const a = i >= n ? px[y * row + i - n] : 0;
			const b = y > 0 ? px[(y - 1) * row + i] : 0;
			const c = y > 0 && i >= n ? px[(y - 1) * row + i - n] : 0;
			const p = a + b - c;
			const pa = Math.abs(p - a);
			const pb = Math.abs(p - b);
			const pc = Math.abs(p - c);
			out[y * (row + 1) + 1 + i] = (x - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
		}
	}
	return out;
}

function imageStream(doc, w, h, seed, predictor) {
	const px = smoothRgb(w, h, seed);
	const dict = { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' };
	if (predictor) dict.DecodeParms = { Predictor: 15, Colors: 3, BitsPerComponent: 8, Columns: w };
	const data = zlib.deflateSync(predictor ? paethRows(px, w, h, 3) : px, { level: 9 });
	return doc.context.register(doc.context.stream(data, dict));
}

const det = { useObjectStreams: false, updateFieldAppearances: false };

async function predictorFile() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const page = doc.addPage([400, 330]);
	const img = imageStream(doc, 360, 270, 7, true);
	page.node.setXObject(PDFName.of('Im1'), img);
	const font = await doc.embedFont('Helvetica');
	page.drawText('predictor p1', { x: 20, y: 305, size: 12, font });
	page.pushOperators();
	const cs = doc.context.stream('q 360 0 0 270 20 20 cm /Im1 Do Q\n');
	const contents = page.node.get(PDFName.of('Contents'));
	page.node.set(PDFName.of('Contents'), doc.context.obj([contents, doc.context.register(cs)]));
	return doc.save(det);
}

async function fontDoc(text, extraGlyphs) {
	const doc = await PDFDocument.create({ updateMetadata: false });
	doc.registerFontkit(fontkit);
	const font = await doc.embedFont(fontBytes, { subset: true });
	if (extraGlyphs) font.encodeText(LATIN);
	return { doc, font };
}

/** Drops pdf-lib's "ABCDEF+" subset tag, so the font looks embedded whole. */
function untag(doc) {
	for (const [, obj] of doc.context.enumerateIndirectObjects()) {
		const dict = obj.dict ?? obj;
		if (typeof dict.get !== 'function') continue;
		for (const key of ['BaseFont', 'FontName']) {
			const v = dict.get(PDFName.of(key));
			if (v instanceof PDFName && /^[A-Z]{6}\+/.test(v.decodeText())) dict.set(PDFName.of(key), PDFName.of(v.decodeText().slice(7)));
		}
	}
}

async function dupesFile() {
	const { doc: one, font } = await fontDoc('', true);
	const page = one.addPage([400, 330]);
	page.drawText('dupes: the same font and image on both pages', { x: 20, y: 300, size: 12, font });
	const img = imageStream(one, 200, 150, 3, false);
	page.node.setXObject(PDFName.of('Im1'), img);
	page.pushOperators();
	const contents = page.node.get(PDFName.of('Contents'));
	page.node.set(PDFName.of('Contents'), one.context.obj([contents, one.context.register(one.context.stream('q 200 0 0 150 20 40 cm /Im1 Do Q\n'))]));
	const first = await PDFDocument.load(await one.save(det));
	const out = await PDFDocument.create({ updateMetadata: false });
	for (let i = 0; i < 2; i++) {
		const [p] = await out.copyPages(first, [0]); // a separate call: its own copy of every resource
		out.addPage(p);
	}
	return out.save(det);
}

async function formFontsFile() {
	const { doc, font } = await fontDoc('', true);
	untag(doc);
	const page = doc.addPage([400, 200]);
	page.drawText('Name:', { x: 20, y: 150, size: 12, font });
	const form = doc.getForm();
	const tf = form.createTextField('name');
	tf.addToPage(page, { x: 70, y: 140, width: 300, height: 24, font });
	tf.setText('Al');
	tf.updateAppearances(font);
	return doc.save(det);
}

async function subsetFile() {
	const { doc, font } = await fontDoc('', true);
	untag(doc);
	const p1 = doc.addPage([400, 300]);
	p1.drawText('Subset me, page one', { x: 20, y: 250, size: 14, font });
	const p2 = doc.addPage([400, 300]);
	p2.drawText('Page two', { x: 20, y: 250, size: 14, font });
	const ctx = doc.context;
	// Outline with two entries, a link on page 1 to page 2, page labels, an attachment.
	const outlines = ctx.nextRef();
	const e1 = ctx.nextRef();
	const e2 = ctx.nextRef();
	ctx.assign(outlines, ctx.obj({ Type: 'Outlines', First: e1, Last: e2, Count: 2 }));
	ctx.assign(e1, ctx.obj({ Title: PDFString.of('One'), Parent: outlines, Next: e2, Dest: [p1.ref, 'Fit'] }));
	ctx.assign(e2, ctx.obj({ Title: PDFString.of('Two'), Parent: outlines, Prev: e1, Dest: [p2.ref, 'Fit'] }));
	doc.catalog.set(PDFName.of('Outlines'), outlines);
	const link = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 240, 200, 270], Border: [0, 0, 0], Dest: [p2.ref, 'Fit'] }));
	p1.node.set(PDFName.of('Annots'), ctx.obj([link]));
	doc.catalog.set(PDFName.of('PageLabels'), ctx.obj({ Nums: [0, { S: 'r' }, 1, { S: 'D', St: 7 }] }));
	await doc.attach(new TextEncoder().encode('attached text, kept as it is\n'.repeat(20)), 'note.txt', { mimeType: 'text/plain', creationDate: new Date(0), modificationDate: new Date(0) });
	return doc.save(det);
}

/** Writes the compress corpus through `write(name, bytes, meta)`. */
export default async function generateCompressCorpus(write) {
	write('compress-predictor.pdf', await predictorFile(), { pages: 1, label: 'predictor', note: 'RGB image with PNG predictor (Paeth rows); qpdf --recompress-flate drops it and the file grew' });
	write('compress-dupes.pdf', await dupesFile(), { pages: 2, label: 'dupes', note: 'each page has its own copy of the same embedded font and image' });
	write('compress-form-fonts.pdf', await formFontsFile(), { pages: 1, label: 'form-fonts', fields: ['name'], note: 'text field /DA font in /DR is an embedded font with many unused glyphs: must not be subset' });
	write('compress-subset.pdf', await subsetFile(), { pages: 2, label: 'subset', note: 'embedded font with many unused glyphs (no subset tag); outline, link, page labels, attachment' });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateCompressCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
