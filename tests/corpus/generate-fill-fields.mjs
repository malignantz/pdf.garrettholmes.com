#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for "Keep filled blanks editable" (src/lib/engine/blank-fields.ts): flat form
 * pages to snap on, in files that already have a form, that ask viewers to redraw their
 * fields, or whose page is turned by /Rotate.
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only these files:
 *   node tests/corpus/generate-fill-fields.mjs
 * which merges their entries into the existing manifest.json.
 *
 * Positions are top-down (y from the top of the page as displayed), points.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName, PDFString, StandardFonts, rgb } from '@cantoo/pdf-lib';

/** A flat form on `p` (displayed size w × h; drawn upright for /Rotate `rot`): a labelled line, a box, a square. */
function flatForm(p, font, w, h, rot = 0) {
	const black = rgb(0, 0, 0);
	// Display (top-down) point to PDF user space for /Rotate 0 or 90.
	const P = (x, y) => (rot === 90 ? { x: y, y: x } : { x, y: h - y });
	const text = (s, x, y, size = 10) => {
		const o = P(x, y);
		p.drawText(s, { x: o.x, y: o.y, size, font, color: black, ...(rot === 90 ? { rotate: { type: 'degrees', angle: 90 } } : {}) });
	};
	const line = (x0, y0, x1, y1) => p.drawLine({ start: P(x0, y0), end: P(x1, y1), thickness: 0.75, color: black });
	const box = (x0, y0, x1, y1) => {
		line(x0, y0, x1, y0);
		line(x1, y0, x1, y1);
		line(x1, y1, x0, y1);
		line(x0, y1, x0, y0);
	};
	text('Application', 72, 60, 16);
	text('Full name', 72, 100);
	line(130, 102, 400, 102);
	text('City', 72, 140);
	line(100, 142, 300, 142);
	text('Employer', 72, 175, 7);
	box(72, 170, 400, 200);
	text('Member?', 72, 240);
	box(130, 231, 139, 240);
	text('Yes', 143, 240);
	box(180, 231, 189, 240);
	text('No', 193, 240);
}

async function withForm({ redraw = false, clash = false } = {}) {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const p1 = doc.addPage([612, 792]);
	p1.drawText('Page one has form fields.', { x: 72, y: 720, size: 12, font });
	const form = doc.getForm();
	const name = form.createTextField('Name');
	name.addToPage(p1, { x: 72, y: 640, width: 200, height: 20, borderWidth: 0 });
	const agree = form.createCheckBox('Agree');
	agree.addToPage(p1, { x: 72, y: 600, width: 12, height: 12 });
	if (clash) {
		// A field already called what this app would call its first new field on page 2.
		const taken = form.createTextField('blank_p2_1');
		taken.addToPage(p1, { x: 72, y: 560, width: 200, height: 20, borderWidth: 0 });
	}
	const p2 = doc.addPage([612, 792]);
	flatForm(p2, font, 612, 792);
	form.updateFieldAppearances();
	const af = doc.catalog.lookup(PDFName.of('AcroForm'));
	if (redraw) af.set(PDFName.of('NeedAppearances'), doc.context.obj(true));
	if (clash) {
		// /DR /Helv is some other font here: the new fields must not name it.
		const dr = af.lookup(PDFName.of('DR')) ?? doc.context.obj({});
		af.set(PDFName.of('DR'), dr);
		let fonts = dr.lookup(PDFName.of('Font'));
		if (!fonts) {
			fonts = doc.context.obj({});
			dr.set(PDFName.of('Font'), fonts);
		}
		fonts.set(PDFName.of('Helv'), doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', Encoding: 'WinAnsiEncoding' })));
		af.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
	}
	return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}

async function rotated() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	// Stored 612 × 792 with /Rotate 90: shown 792 wide, 612 tall.
	const p = doc.addPage([612, 792]);
	flatForm(p, font, 792, 612, 90);
	p.node.set(PDFName.of('Rotate'), doc.context.obj(90));
	return doc.save({ useObjectStreams: false });
}

export default async function generateFillFieldsCorpus(write) {
	write('fill-fields-form.pdf', await withForm(), {
		pages: 2,
		note: 'p1 an AcroForm text field "Name" and checkbox "Agree" (pdf-lib); p2 a flat form for snap on tap: a line after "Full name" (y 102, x 130-400), a line after "City" (y 142, x 100-300), a box with a corner label (72,170)-(400,200), squares (130,231)-(139,240) and (180,231)-(189,240)'
	});
	write('fill-fields-clash.pdf', await withForm({ clash: true }), {
		pages: 2,
		note: 'as fill-fields-form.pdf, plus a field named "blank_p2_1" on p1 and /AcroForm /DR /Helv pointing at Courier'
	});
	write('fill-fields-redraw.pdf', await withForm({ redraw: true }), {
		pages: 2,
		note: 'as fill-fields-form.pdf with /NeedAppearances true: viewers are asked to redraw every field'
	});
	write('fill-fields-rotated.pdf', await rotated(), {
		pages: 1,
		note: 'one page stored 612x792 with /Rotate 90 (shown 792x612), the flat form of fill-fields-form.pdf p2 drawn upright as displayed'
	});
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateFillFieldsCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
