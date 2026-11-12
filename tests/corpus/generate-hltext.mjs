#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for the text highlighter (src/lib/engine/page-text.ts, src/lib/editor/text-select.ts):
 * pages whose words, lines and geometry are known, so tests can check word boxes,
 * reading order, rotation, CropBox, right-to-left text, OCR text and what is not offered.
 *
 * Called from generate.mjs (one line), or on its own to (re)write only this file:
 *   node tests/corpus/generate-hltext.mjs
 * which merges its entry into the existing manifest.json.
 *
 * The manifest entry lists every drawn line: its text, font, size, start point
 * (PDF user space) and angle, so tests can work out where each word must be.
 * The Hebrew page embeds a subset of DejaVu Sans (Bitstream Vera licence, embedding
 * allowed) from the system fonts; it is drawn in visual order, as producers do.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFArray, PDFDocument, PDFName, PDFString, StandardFonts, degrees, rgb } from '@cantoo/pdf-lib';
import fontkit from '@cantoo/fontkit';

const here = path.dirname(fileURLToPath(import.meta.url));
const NOTO = path.join(here, '../../src/lib/engine/fonts/NotoSans-Regular.ttf');
const DEJAVU = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

/** Adds a raw content stream after the page's own. */
function appendContent(doc, page, bytes, dict = {}) {
	const extra = doc.context.register(doc.context.stream(bytes, dict));
	const arr = page.node.get(PDFName.of('Contents'));
	if (arr instanceof PDFArray) arr.push(extra);
	else if (arr) page.node.set(PDFName.of('Contents'), doc.context.obj([arr, extra]));
	else page.node.set(PDFName.of('Contents'), extra);
}

/** The resource name pdf-lib gave the page's only (or first) font. */
function fontKey(page) {
	return page.node.normalizedEntries().Font.keys()[0].asString();
}

export const PARAGRAPH = [
	'Highlight the quick brown fox jumping',
	'over the lazy dog, gently and quietly',
	'beside the hedge by the old gate.'
];

/** A small grey "scan" image (8-bit grey, Flate), w × h pixels. */
function scanImage(doc, w, h) {
	const px = Buffer.alloc(w * h);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px[y * w + x] = (x * 7 + y * 13) % 40 < 3 ? 120 : 235;
	return doc.context.register(
		doc.context.stream(zlib.deflateSync(px), {
			Type: 'XObject',
			Subtype: 'Image',
			Width: w,
			Height: h,
			ColorSpace: 'DeviceGray',
			BitsPerComponent: 8,
			Filter: 'FlateDecode'
		})
	);
}

async function hlText() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	doc.registerFontkit(fontkit);
	const helv = await doc.embedFont(StandardFonts.Helvetica);
	const noto = await doc.embedFont(fs.readFileSync(NOTO), { subset: true });
	const pages = [];
	const lines = (n) => (pages[n - 1] ??= []);
	const draw = (n, p, text, x, y, size, font = helv, fontName = 'Helvetica', angle = 0) => {
		p.drawText(text, { x, y, size, font, color: rgb(0, 0, 0), rotate: degrees(angle) });
		lines(n).push({ text, font: fontName, size, x, y, angle });
	};
	const paragraph = (n, p, x, y) => PARAGRAPH.forEach((t, i) => draw(n, p, t, x, y - i * 13.2, 11));

	// p1: a paragraph (Helvetica 11 on 13.2), a line in an embedded font, and two columns
	// drawn column by column (reading order is the drawing order, not top to bottom).
	{
		const p = doc.addPage([612, 792]);
		paragraph(1, p, 72, 700);
		draw(1, p, 'Embedded glyphs typography', 72, 620, 14, noto, 'NotoSans');
		['Left column one', 'Left column two', 'Left column end'].forEach((t, i) => draw(1, p, t, 72, 500 - i * 13.2, 11));
		['Right column one', 'Right column two'].forEach((t, i) => draw(1, p, t, 330, 500 - i * 13.2, 11));
	}
	// p2: the same paragraph on a page with /Rotate 90.
	{
		const p = doc.addPage([612, 792]);
		paragraph(2, p, 72, 700);
		p.node.set(PDFName.of('Rotate'), doc.context.obj(90));
	}
	// p3: a CropBox offset from the MediaBox; the paragraph inside it.
	{
		const p = doc.addPage([612, 792]);
		paragraph(3, p, 150, 560);
		p.setCropBox(100, 150, 400, 500);
	}
	// p4: runs at angles: level, 2° (allowed), 30° (not offered), vertical (90°).
	{
		const p = doc.addPage([612, 792]);
		draw(4, p, 'Level line of text', 72, 720, 12);
		draw(4, p, 'Nearly level line', 72, 660, 12, helv, 'Helvetica', 2);
		draw(4, p, 'Tilted line of text', 72, 520, 12, helv, 'Helvetica', 30);
		draw(4, p, 'Vertical words here', 450, 300, 12, helv, 'Helvetica', 90);
	}
	// p5: Hebrew, right to left, drawn in visual order; then a Latin line.
	if (fs.existsSync(DEJAVU)) {
		const dv = await doc.embedFont(fs.readFileSync(DEJAVU), { subset: true });
		const p = doc.addPage([612, 792]);
		const he = ['שלום עולם יפה מאוד', 'שורה שנייה כאן'];
		he.forEach((t, i) => {
			// pdf-lib lays Hebrew out right to left (fontkit), so the glyphs go into the
			// content stream in visual order, leftmost first.
			const w = dv.widthOfTextAtSize(t, 14);
			p.drawText(t, { x: 540 - w, y: 700 - i * 18, size: 14, font: dv, color: rgb(0, 0, 0) });
			lines(5).push({ text: t, font: 'DejaVuSans', size: 14, x: 540 - w, y: 700 - i * 18, angle: 0, rtl: true });
		});
		draw(5, p, 'Latin after Hebrew', 72, 600, 12);
	} else throw new Error(`missing ${DEJAVU}`);
	// p6: a "scan" with invisible OCR text over it (render mode 3).
	{
		const p = doc.addPage([612, 792]);
		p.drawText('x', { x: -100, y: -100, size: 1, font: helv }); // registers the font
		const f = fontKey(p);
		const img = scanImage(doc, 200, 260);
		p.node.normalizedEntries().Resources.set(PDFName.of('XObject'), doc.context.obj({ Scan: img }));
		appendContent(doc, p, `q 612 0 0 792 0 0 cm /Scan Do Q BT 3 Tr /${f} 12 Tf 72 700 Td (Scanned words under glass) Tj ET`);
		lines(6).push({ text: 'Scanned words under glass', font: 'Helvetica', size: 12, x: 72, y: 700, angle: 0, invisible: true });
	}
	// p7: a scan with no text at all.
	{
		const p = doc.addPage([612, 792]);
		const img = scanImage(doc, 200, 260);
		p.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Scan: img } }));
		appendContent(doc, p, 'q 612 0 0 792 0 0 cm /Scan Do Q');
	}
	// p8: a visible line; a line wholly clipped away; a line in a layer that is off.
	{
		const p = doc.addPage([612, 792]);
		draw(8, p, 'Visible words stay', 72, 700, 12);
		const f = fontKey(p);
		appendContent(doc, p, `q 0 0 10 10 re W n BT /${f} 12 Tf 72 600 Td (Clipped away words) Tj ET Q`);
		lines(8).push({ text: 'Clipped away words', font: 'Helvetica', size: 12, x: 72, y: 600, angle: 0, clipped: true });
		const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Hidden') }));
		doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: { OFF: [ocg], Order: [ocg] } }));
		p.node.normalizedEntries().Resources.set(PDFName.of('Properties'), doc.context.obj({ oc1: ocg }));
		appendContent(doc, p, `/OC /oc1 BDC BT /${f} 12 Tf 72 500 Td (Hidden layer words) Tj ET EMC`);
		lines(8).push({ text: 'Hidden layer words', font: 'Helvetica', size: 12, x: 72, y: 500, angle: 0, hiddenLayer: true });
	}
	// p9: a Type 3 font (glyphs are drawn boxes), and a Helvetica line.
	{
		const p = doc.addPage([612, 792]);
		draw(9, p, 'Normal line here', 72, 600, 12);
		const proc = (w) => doc.context.register(doc.context.stream(`${w} 0 0 0 ${w - 100} 700 d1 50 0 ${w - 200} 700 re f`));
		const t3 = doc.context.register(
			doc.context.obj({
				Type: 'Font',
				Subtype: 'Type3',
				FontBBox: [0, 0, 600, 700],
				FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
				CharProcs: { A: proc(600), B: proc(500), space: doc.context.register(doc.context.stream('300 0 d0')) },
				Encoding: { Type: 'Encoding', Differences: [32, 'space', 65, 'A', 'B'] },
				FirstChar: 32,
				LastChar: 66,
				Widths: [300, ...Array(32).fill(0), 600, 500],
				Resources: {}
			})
		);
		p.node.normalizedEntries().Font.set(PDFName.of('T3'), t3);
		appendContent(doc, p, 'BT /T3 14 Tf 72 700 Td (ABBA BAB) Tj ET');
		lines(9).push({ text: 'ABBA BAB', font: 'Type3', size: 14, x: 72, y: 700, angle: 0, type3: true });
	}
	// p10: tight leading (10 on 10.5) with descenders, under a 24 pt heading.
	{
		const p = doc.addPage([612, 792]);
		draw(10, p, 'Heading Big', 72, 720, 24);
		['gypsy jumping quickly', 'Typography of glyphs', 'jolly yapping puppy'].forEach((t, i) => draw(10, p, t, 72, 690 - i * 10.5, 10));
	}
	return { bytes: await doc.save({ useObjectStreams: false, addDefaultPage: false }), lines: pages };
}

export default async function generateHlTextCorpus(write) {
	const { bytes, lines } = await hlText();
	write('hl-text.pdf', bytes, {
		pages: 10,
		note: 'text highlighter: p1 paragraph + embedded font + two columns drawn left then right; p2 /Rotate 90; p3 CropBox [100 150 500 650]; p4 runs at 0, 2, 30 and 90 degrees; p5 Hebrew (visual order) + Latin; p6 invisible OCR text over a scan; p7 scan, no text; p8 visible, clipped-away and hidden-layer lines; p9 Type 3 font + Helvetica; p10 24 pt heading over tight 10 on 10.5 lines',
		lines: lines.map((l) => l ?? [])
	});
}

// Standalone: write only this file and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateHlTextCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
