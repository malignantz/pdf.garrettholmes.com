#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for the stamps stage and page numbers (src/lib/engine/stamps.ts, numbering.ts):
 * page content shapes found in real files that the stage must handle or refuse.
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only this file:
 *   node tests/corpus/generate-stamps.mjs
 * which merges its entry into the existing manifest.json.
 *
 * Every page carries a Helvetica label "quirks p<N>" so tests can check text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDocument, PDFName, StandardFonts, rgb } from '@cantoo/pdf-lib';

/** Adds a raw (unencoded unless `dict` says otherwise) content stream after the page's own. */
function appendContent(doc, page, bytes, dict = {}) {
	const extra = doc.context.register(doc.context.stream(bytes, dict));
	const arr = page.node.get(PDFName.of('Contents'));
	if (arr instanceof PDFArray) arr.push(extra);
	else page.node.set(PDFName.of('Contents'), doc.context.obj([arr, extra]));
}

async function stampsQuirks() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = (w, h, n) => {
		const p = doc.addPage([w, h]);
		const size = Math.max(4, Math.min(12, w / 12, h / 6));
		p.drawText(`quirks p${n}`, { x: 6, y: h - size - 4, size, font, color: rgb(0, 0, 0) });
		return p;
	};

	// p1: an empty content stream that still says /Filter /FlateDecode (0 bytes, not
	// valid zlib). Viewers treat it as empty.
	appendContent(doc, page(400, 400, 1), new Uint8Array(0), { Filter: 'FlateDecode' });

	// p2: /Contents is a reference to an array of streams, not the array itself.
	{
		const p = page(400, 400, 2);
		appendContent(doc, p, 'q 0 0 1 rg 300 300 20 20 re f Q');
		const arr = p.node.get(PDFName.of('Contents'));
		p.node.set(PDFName.of('Contents'), doc.context.register(arr));
	}

	// p3: the content leaves a text object open (BT without ET).
	{
		const p = page(400, 400, 3);
		const fontName = p.node.normalizedEntries().Font.keys()[0].asString();
		appendContent(doc, p, `BT ${fontName} 9 Tf 1 0 0 1 50 50 Tm (open text) Tj`);
	}

	// p4: a footer line on the baseline where a bottom-centre page number goes (36 pt
	// from the bottom), running under it, as on many forms and reports.
	{
		const p = page(612, 792, 4);
		p.drawText('Footer text that runs right across the bottom of the page, under the page number.', { x: 36, y: 36, size: 9, font });
	}

	// p5: a Square annotation with an opaque appearance over the top-left quarter.
	{
		const p = page(400, 400, 5);
		const ap = doc.context.register(
			doc.context.stream('1 1 0.6 rg 0 0 200 200 re f', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 200, 200] })
		);
		const annot = doc.context.register(
			doc.context.obj({ Type: 'Annot', Subtype: 'Square', Rect: [0, 200, 200, 400], F: 4, AP: { N: ap } })
		);
		p.node.set(PDFName.of('Annots'), doc.context.obj([annot]));
	}

	// p6: a page too small for a page number (20 × 20 pt). (Damaged content that ends
	// inside a string is built in the test itself: every corpus file must export plain.)
	page(20, 20, 6);

	// p7: a push button over the top half (as IRS forms put a full-page notice in front
	// of the form), and a plain text field over the bottom half.
	{
		const p = page(400, 400, 7);
		const ap = (w, h) =>
			doc.context.register(doc.context.stream(`0.9 0.9 0.9 rg 0 0 ${w} ${h} re f`, { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }));
		const button = doc.context.register(
			doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Btn', Ff: 65536, T: doc.context.obj('notice'), Rect: [0, 200, 400, 400], F: 4, AP: { N: ap(400, 200) } })
		);
		const text = doc.context.register(
			doc.context.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: doc.context.obj('name'), Rect: [0, 0, 400, 200], F: 4, MK: {}, AP: { N: ap(400, 200) } })
		);
		p.node.set(PDFName.of('Annots'), doc.context.obj([button, text]));
	}

	return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

export default async function generateStampsCorpus(write) {
	write('stamps-quirks.pdf', await stampsQuirks(), {
		pages: 7,
		label: 'quirks',
		note: 'p1 empty FlateDecode content stream; p2 /Contents is a reference to an array; p3 unclosed BT; p4 footer text on the page-number baseline; p5 Square annotation over the top-left quarter; p6 20x20 pt page; p7 push button over the top half, text field (no background) over the bottom half'
	});
}

// Standalone: write only this file and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateStampsCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
