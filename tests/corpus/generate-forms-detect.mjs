#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for the flat-form blank detector (src/lib/engine/forms-detect.ts): one flat
 * form page with each kind of blank the detector knows, next to things that look
 * like blanks but are not, and one page of ordinary document content.
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only this file:
 *   node tests/corpus/generate-forms-detect.mjs
 * which merges its entry into the existing manifest.json.
 *
 * Positions below are top-down (y from the top of the 612 × 792 pt page), the space
 * the detector reports in; tests/engine/forms-detect.test.ts lists the expected blanks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDocument, PDFName, StandardFonts, rgb } from '@cantoo/pdf-lib';

const H = 792;

function appendContent(doc, page, text) {
	const extra = doc.context.register(doc.context.stream(text));
	const arr = page.node.get(PDFName.of('Contents'));
	if (arr instanceof PDFArray) arr.push(extra);
	else page.node.set(PDFName.of('Contents'), doc.context.obj([arr, extra]));
}

async function flatForm() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const dings = await doc.embedFont(StandardFonts.ZapfDingbats);
	const black = rgb(0, 0, 0);
	const text = (page, s, x, y, size = 10, f = font) => page.drawText(s, { x, y: H - y, size, font: f, color: black });
	const line = (page, x0, y, x1, w = 0.75) => page.drawLine({ start: { x: x0, y: H - y }, end: { x: x1, y: H - y }, thickness: w, color: black });
	const box = (page, x0, y0, x1, y1, w = 0.75) =>
		page.drawRectangle({ x: x0, y: H - y1, width: x1 - x0, height: y1 - y0, borderWidth: w, borderColor: black });

	// Page 1: a flat form.
	const p1 = doc.addPage([612, H]);
	text(p1, 'Application form', 72, 60, 16, bold);
	// 1. Underscores after a label.
	text(p1, 'Name: ______________________________', 72, 100);
	// 2. A drawn rule after a label.
	text(p1, 'Address', 72, 140);
	line(p1, 130, 142, 400);
	// 3. A box with a small label in its top-left corner.
	box(p1, 72, 170, 300, 202);
	text(p1, '1. Employer name', 75, 178, 7);
	// 4. A table: a header row and two empty rows.
	const cols = [72, 200, 300, 400];
	const rows = [220, 236, 254, 272];
	for (const y of rows) line(p1, cols[0], y, cols[3]);
	for (const x of cols) p1.drawLine({ start: { x, y: H - rows[0] }, end: { x, y: H - rows[3] }, thickness: 0.75, color: black });
	text(p1, 'Item', 76, 232, 9);
	text(p1, 'Quantity', 204, 232, 9);
	text(p1, 'Price', 304, 232, 9);
	// 5. Two drawn squares with labels.
	text(p1, 'Citizen?', 72, 308);
	box(p1, 130, 299, 139, 308);
	text(p1, 'Yes', 143, 308);
	box(p1, 180, 299, 189, 308);
	text(p1, 'No', 193, 308);
	// 6. A box glyph (ZapfDingbats ❏) with a label.
	p1.drawText('❏', { x: 72, y: H - 338, size: 10, font: dings, color: black });
	text(p1, 'Married', 86, 338);
	// 7. A box drawn as a filled frame (two rectangles, even-odd fill).
	appendContent(doc, p1, `q 0 g 160 ${H - 339} 9 9 re 161 ${H - 338} 7 7 re f* Q`);
	text(p1, 'Single', 174, 338);
	// 8. Comb boxes: five 12 pt squares 2 pt apart.
	text(p1, 'ZIP code', 72, 380);
	for (let i = 0; i < 5; i++) box(p1, 130 + i * 14, 369, 142 + i * 14, 381);
	// 9. A signature line with its caption underneath.
	line(p1, 72, 450, 300);
	text(p1, 'Signature of applicant', 72, 460, 8);
	// Not blanks: a section heading over a thick page-wide rule, a footer rule.
	text(p1, 'Part 2. Details', 72, 500, 12, bold);
	line(p1, 72, 504, 540, 2);
	text(p1, 'Read the notes before you sign. Each answer must be true and complete.', 72, 520);
	line(p1, 72, 750, 540);
	text(p1, 'Form T-1 (2026)', 72, 762, 8);

	// Page 2: an ordinary document page.
	const p2 = doc.addPage([612, H]);
	text(p2, 'Annual report', 72, 72, 18, bold);
	line(p2, 72, 80, 540, 1);
	const para = [
		'This page has paragraphs, an underlined link and a table filled with',
		'numbers. None of it is a blank to fill in, so the detector must stay',
		'quiet here. See the website for details.'
	];
	para.forEach((s, i) => text(p2, s, 72, 110 + i * 14));
	line(p2, 72 + font.widthOfTextAtSize('quiet here. See the ', 10), 141, 72 + font.widthOfTextAtSize('quiet here. See the website', 10), 0.5);
	const tc = [72, 220, 360, 500];
	const tr = [170, 186, 202, 218];
	for (const y of tr) line(p2, tc[0], y, tc[3]);
	for (const x of tc) p2.drawLine({ start: { x, y: H - tr[0] }, end: { x, y: H - tr[3] }, thickness: 0.75, color: black });
	[
		['Region', 'Sales', 'Growth'],
		['North', '1,200', '4%'],
		['South', '980', '2%']
	].forEach((row, r) => row.forEach((s, c) => text(p2, s, tc[c] + 4, tr[r] + 12, 9)));
	line(p2, 72, 750, 540);
	text(p2, 'Page 2', 72, 762, 8);
	return doc.save({ useObjectStreams: false });
}

export default async function generateFormsDetectCorpus(write) {
	write('forms-detect-flat.pdf', await flatForm(), {
		pages: 2,
		note: 'p1 flat form (no AcroForm): underscores, a drawn rule, a labelled box, a table with two empty rows, two squares, a ZapfDingbats box glyph, a filled-frame box, five comb boxes, a signature line with caption; plus a heading rule and a footer rule that are not blanks. p2 ordinary page: heading rule, paragraphs, underlined link, filled table, footer rule'
	});
}

// Standalone: write only this file and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateFormsDetectCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
