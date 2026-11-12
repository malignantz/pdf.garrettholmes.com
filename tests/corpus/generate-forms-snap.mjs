#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for tap-to-snap on flat forms (src/lib/engine/forms-snap.ts): one flat form
 * page with blanks next to each other (where a tap must pick the right one), and a
 * paragraph and a filled table where a tap must not snap.
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only this file:
 *   node tests/corpus/generate-forms-snap.mjs
 * which merges its entry into the existing manifest.json.
 *
 * Positions are top-down (y from the top of the 612 × 792 pt page), the space snapAt
 * takes and returns; tests/engine/forms-snap.test.ts lists the expected snaps.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { jpeg, scanGray } from './generate-shrink.mjs';

const H = 792;

async function snapForm() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const black = rgb(0, 0, 0);
	const p = doc.addPage([612, H]);
	const text = (s, x, y, size = 10, f = font) => p.drawText(s, { x, y: H - y, size, font: f, color: black });
	const hline = (x0, y, x1, w = 0.75) => p.drawLine({ start: { x: x0, y: H - y }, end: { x: x1, y: H - y }, thickness: w, color: black });
	const vline = (x, y0, y1, w = 0.75) => p.drawLine({ start: { x, y: H - y0 }, end: { x, y: H - y1 }, thickness: w, color: black });
	const box = (x0, y0, x1, y1) => p.drawRectangle({ x: x0, y: H - y1, width: x1 - x0, height: y1 - y0, borderWidth: 0.75, borderColor: black });

	text('Request form', 72, 60, 16, bold);
	// Two labelled lines on one row: "First name ____  Last name ____".
	text('First name', 72, 100);
	hline(130, 102, 290);
	text('Last name', 300, 100);
	hline(352, 102, 540);
	// A line directly under another (two address lines).
	text('Address', 72, 130);
	hline(115, 132, 540);
	hline(115, 152, 540);
	// A grid: header row and two empty rows of three cells.
	const cols = [72, 220, 360, 500];
	const rows = [180, 196, 214, 232];
	for (const y of rows) hline(cols[0], y, cols[3]);
	for (const x of cols) vline(x, rows[0], rows[3]);
	text('Item', 76, 192, 9);
	text('Quantity', 224, 192, 9);
	text('Price', 364, 192, 9);
	// Yes / No squares, and a column of three squares 4 pt apart.
	text('Citizen?', 72, 268);
	box(130, 259, 139, 268);
	text('Yes', 143, 268);
	box(180, 259, 189, 268);
	text('No', 193, 268);
	for (let i = 0; i < 3; i++) {
		box(300, 250 + i * 13, 309, 259 + i * 13);
		text(['Red', 'Green', 'Blue'][i], 313, 259 + i * 13);
	}
	// Comb boxes: six 12 pt squares 2 pt apart.
	text('Code', 72, 320);
	for (let i = 0; i < 6; i++) box(110 + i * 14, 309, 122 + i * 14, 321);
	// Underscores after a label.
	text('Phone: ____________________', 300, 320);
	// A box with a small label in its corner.
	box(72, 340, 300, 372);
	text('Employer name', 75, 348, 7);
	// Snap on tap (editor/snap.ts): a tall box (text keeps the tapped line) and a short box (text steps down).
	text('Comments', 72, 548);
	box(72, 552, 300, 612);
	text('Initials', 320, 560);
	box(360, 552, 420, 561);
	// Not blanks: a paragraph and a filled table.
	const para = [
		'This paragraph explains the form. Tapping on its words must not place',
		'a field anywhere, and neither must tapping in the margin of the page.'
	];
	para.forEach((s, i) => text(s, 72, 420 + i * 14));
	const tc = [72, 220, 360];
	const tr = [470, 486, 502];
	for (const y of tr) hline(tc[0], y, tc[2]);
	for (const x of tc) vline(x, tr[0], tr[2]);
	[
		['North', '1,200'],
		['South', '980']
	].forEach((row, r) => row.forEach((s, c) => text(s, tc[c] + 4, tr[r] + 12, 9)));
	// Page 2: a scanned form (a full-page image) with a drawn line and a label over it, as
	// an OCR tool leaves it: a scan is never snapped to, whatever is drawn on top.
	const p2 = doc.addPage([612, H]);
	const scan = await doc.embedJpg(jpeg(scanGray(153, 198, 5), 153, 198, 1, 60));
	p2.drawImage(scan, { x: 0, y: 0, width: 612, height: H });
	p2.drawText('Name', { x: 72, y: H - 100, size: 10, font, color: black });
	p2.drawLine({ start: { x: 110, y: H - 102 }, end: { x: 300, y: H - 102 }, thickness: 0.75, color: black });
	return doc.save({ useObjectStreams: false });
}

export default async function generateFormsSnapCorpus(write) {
	write('forms-snap.pdf', await snapForm(), {
		pages: 2,
		note: 'p1 flat form (no AcroForm) for tap-to-snap: two labelled lines on one row, two stacked address lines, a 3×3 grid (header + 2 empty rows), Yes/No squares, a column of three squares 4 pt apart, six comb boxes, an underscore run, a box with a corner label, a 60 pt tall box and a 9 pt short box; a paragraph and a filled 2×2 table that are not blanks; p2 a full-page scan (JPEG) with a label and a drawn line over it'
	});
}

// Standalone: write only this file and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateFormsSnapCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
