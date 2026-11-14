#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * Corpus for Crop (engine/crop.ts): page boxes as odd as real files have them. Written by
 * hand (a tiny object writer below) so every box is exactly as described. Nothing is
 * copied from elsewhere.
 *
 *   crop-odd.pdf  3 pages, each drawing a 10 × 10 grid of numbered cells over its
 *                 visible box (so any part of the page can be recognised in a render).
 *     page 1  inherits /MediaBox [-100 -50 512 742] and /Rotate 90 from the page tree
 *             (non-zero origin); its own /TrimBox [-90 -40 500 700], /BleedBox
 *             [-100 -50 512 742] and /ArtBox [-95 650 -60 700] (in a corner).
 *     page 2  /MediaBox [0 0 612 792], /CropBox [-20 -20 300 400] (reaching outside
 *             the MediaBox: the visible box is [0 0 300 400]), /UserUnit 2, /Rotate 270.
 *     page 3  /MediaBox as an indirect array [0 0 500 300], /CropBox as an indirect
 *             object, its own /Rotate 180, three levels down the page tree. (An intermediate
 *             node overriding /Rotate is not used: qpdf's page copy takes the top node's
 *             value there while PDF.js takes the nearest; that is the assemble step's
 *             business, not crop's.)
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-crop.mjs
 * (writes only this file and merges its manifest entry).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Objects (1-based) to a PDF file with a correct xref. */
function pdf(objects) {
	const parts = ['%PDF-1.7\n%\xe2\xe3\xcf\xd3\n'];
	const offsets = [];
	let length = Buffer.byteLength(parts[0], 'latin1');
	objects.forEach((body, i) => {
		const text = `${i + 1} 0 obj\n${body}\nendobj\n`;
		offsets.push(length);
		parts.push(text);
		length += Buffer.byteLength(text, 'latin1');
	});
	const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
	parts.push(xref, `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`);
	return Buffer.from(parts.join(''), 'latin1');
}

function stream(content) {
	return `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`;
}

/** A 10 × 10 grid of cells over [x0 y0 x1 y1], each with its number, alternating greys. */
function grid([x0, y0, x1, y1]) {
	const w = (x1 - x0) / 10;
	const h = (y1 - y0) / 10;
	const out = [];
	for (let r = 0; r < 10; r++) {
		for (let c = 0; c < 10; c++) {
			const g = (r + c) % 2 ? 0.85 : 0.6;
			out.push(`${g} g ${(x0 + c * w).toFixed(2)} ${(y0 + r * h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
			out.push(`BT /F1 ${(Math.min(w, h) * 0.4).toFixed(2)} Tf 0 g ${(x0 + c * w + w * 0.15).toFixed(2)} ${(y0 + r * h + h * 0.3).toFixed(2)} Td (${r * 10 + c}) Tj ET`);
		}
	}
	return out.join('\n');
}

export function cropOdd() {
	const font = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
	return pdf([
		/* 1 */ '<< /Type /Catalog /Pages 2 0 R >>',
		/* 2 */ '<< /Type /Pages /Kids [3 0 R 9 0 R] /Count 3 /MediaBox [-100 -50 512 742] /Rotate 90 /Resources << /Font << /F1 4 0 R >> >> >>',
		/* 3 */ '<< /Type /Page /Parent 2 0 R /Contents 5 0 R /TrimBox [-90 -40 500 700] /BleedBox [-100 -50 512 742] /ArtBox [-95 650 -60 700] >>',
		/* 4 */ font,
		/* 5 */ stream(grid([-100, -50, 512, 742])),
		/* 6 */ '<< /Type /Page /Parent 9 0 R /MediaBox [0 0 612 792] /CropBox [-20 -20 300 400] /UserUnit 2 /Rotate 270 /Contents 7 0 R >>',
		/* 7 */ stream(grid([0, 0, 300, 400])),
		/* 8 */ '[0 0 500 300]',
		/* 9 */ '<< /Type /Pages /Parent 2 0 R /Kids [6 0 R 10 0 R] /Count 2 >>',
		/* 10 */ '<< /Type /Page /Parent 12 0 R /MediaBox 8 0 R /CropBox 13 0 R /Rotate 180 /Contents 11 0 R >>',
		/* 11 */ stream(grid([0, 0, 500, 300])),
		/* 12 */ '<< /Type /Pages /Parent 9 0 R /Kids [10 0 R] /Count 1 >>',
		/* 13 */ '[0 0 500 300]'
	]);
}

export default function generateCropCorpus(write) {
	write('crop-odd.pdf', cropOdd(), {
		pages: 3,
		label: 'crop',
		note: 'inherited non-zero-origin MediaBox and /Rotate, Trim/Bleed/ArtBox, a CropBox past the MediaBox with UserUnit 2, indirect boxes, three-level page tree',
		visible: [
			[-100, -50, 512, 742],
			[0, 0, 300, 400],
			[0, 0, 500, 300]
		],
		rotate: [90, 270, 180],
		userUnit: [1, 2, 1]
	});
}

// Standalone: write only this file and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	generateCropCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
