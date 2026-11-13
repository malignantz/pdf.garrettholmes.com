#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for the print-size cap ("Reduce oversized pictures", src/lib/engine/print-cap.ts).
 * Pictures are made here (generate-shrink.mjs pixels, JPEGs by MuPDF), never copied.
 *
 * print-cap.pdf (5 × 4 in pages, a Helvetica label on each):
 *   p1  photo JPEG 1000×750 drawn 2 × 1.5 in (500 ppi)            → brought down to 600×450
 *   p2  flat-colour chart (Flate) 1000×750 drawn 2 × 1.5 in      → left (not photo-like)
 *   p3  photo JPEG 600×450 drawn 2 × 1.5 in (300 ppi)             → left (not oversized)
 * print-cap-signed.pdf: p1 alone in a file with a signed signature field → left (signed file).
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-print-cap.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { jpeg, lineArtRgb, photoRgb } from './generate-shrink.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const det = { useObjectStreams: false, updateFieldAppearances: false };
const PW = 360;
const PH = 288;

function image(doc, bytes, w, h, filter) {
	return doc.context.register(
		doc.context.stream(bytes, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: filter })
	);
}

function page(doc, font, label, ref) {
	const p = doc.addPage([PW, PH]);
	p.drawText(label, { x: 20, y: PH - 30, size: 12, font });
	const name = p.node.newXObject('Im', ref);
	const content = doc.context.register(doc.context.flateStream(`q 144 0 0 108 108 60 cm ${name.asString()} Do Q`));
	const arr = p.node.get(PDFName.of('Contents'));
	p.node.set(PDFName.of('Contents'), arr ? doc.context.obj([arr, content]) : content);
	return p;
}

async function capFile() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	page(doc, font, 'print-cap p1', image(doc, jpeg(photoRgb(1000, 750, 11), 1000, 750, 3, 80), 1000, 750, 'DCTDecode'));
	page(doc, font, 'print-cap p2', image(doc, zlib.deflateSync(lineArtRgb(1000, 750), { level: 9 }), 1000, 750, 'FlateDecode'));
	page(doc, font, 'print-cap p3', image(doc, jpeg(photoRgb(600, 450, 12), 600, 450, 3, 80), 600, 450, 'DCTDecode'));
	return doc.save(det);
}

async function signedFile() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const p = page(doc, font, 'print-cap-signed p1', image(doc, jpeg(photoRgb(1000, 750, 11), 1000, 750, 3, 80), 1000, 750, 'DCTDecode'));
	const ctx = doc.context;
	const sig = ctx.register(
		ctx.obj({
			Type: 'Sig',
			Filter: 'Adobe.PPKLite',
			SubFilter: 'adbe.pkcs7.detached',
			ByteRange: [0, 100, 200, 300],
			Contents: PDFHexString.of('00'.repeat(64)),
			M: PDFString.of('D:20261113000000Z')
		})
	);
	const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: sig, Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: p.ref }));
	p.node.set(PDFName.of('Annots'), ctx.obj([field]));
	doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field], SigFlags: 3 }));
	return doc.save(det);
}

/** Writes the print-cap corpus through `write(name, bytes, meta)`. */
export default async function generatePrintCapCorpus(write) {
	write('print-cap.pdf', await capFile(), {
		pages: 3,
		label: 'print-cap',
		size: [PW, PH],
		note: 'p1 photo JPEG at 500 ppi (capped to 600×450), p2 flat chart at 500 ppi (left), p3 photo at 300 ppi (left)'
	});
	write('print-cap-signed.pdf', await signedFile(), { pages: 1, label: 'print-cap-signed', size: [PW, PH], note: 'oversized photo in a signed file: left as it is' });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generatePrintCapCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
