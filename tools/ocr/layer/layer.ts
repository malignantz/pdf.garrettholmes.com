/**
 * Prototype writer for an invisible OCR text layer ("Make this scan searchable"),
 * with @cantoo/pdf-lib. Not app code: a measurement of whether the approach holds.
 *
 * What it writes (Tesseract's own PDF renderer does the same in spirit):
 *  - one glyphless font per document: Type0 / CIDFontType2, Identity-H, every CID mapped
 *    to one blank glyph (CIDToGIDMap stream), constant width DW 500 (half an em), and a
 *    ToUnicode CMap listing the codes used (code = the UTF-16 unit of the character), so
 *    the codes extract as the right text. The font program is a 2-glyph TrueType
 *    (Tesseract's pdf.ttf, Apache-2.0, 572 bytes): ascent 1 em, descent 0, no outline.
 *  - per page, the original content wrapped in q … Q (so a leftover CTM, clip or colour
 *    state cannot move the layer) and one new content stream: per OCR line `BT 3 Tr`,
 *    font size = the line's height about Tesseract's baseline (tallest ascender + deepest
 *    descender), so the font's em box covers the line; one `Tm` per line at the first
 *    word's left edge on that baseline, turned to the baseline's slope (skewed scans);
 *    per word a horizontal stretch so its advance equals its OCR box width (stretch "tz":
 *    per-word Tz; "tc": one Tz per line plus per-word Tc, which keeps the text matrix
 *    constant along the line), and the gap to the next word crossed by a stretched space
 *    (spaces "gap") or a TJ offset (spaces "none").
 *  - coordinates: OCR pixels of the page as displayed (rendered at `dpi`) → points of the
 *    displayed page → PDF user space, honouring /Rotate and the CropBox∩MediaBox origin.
 */
import fs from 'node:fs';
import * as PL from '@cantoo/pdf-lib';
import type { OcrPage } from './ocr';

export type Spaces = 'none' | 'gap';
/**
 * How a word's advance is made to match its OCR width: per-word Tz; one Tz per line (the
 * median a word needs, or the largest, so Tc is never positive) plus per-word Tc; or
 * "mix": Tz on level lines, "tcmax" on tilted ones.
 */
export type Stretch = 'tz' | 'tc' | 'tcmax' | 'mix';

export const GLYPHLESS_TTF = '/usr/share/tesseract-ocr/5/tessdata/pdf.ttf';

const n = (v: number) => {
	const s = (Math.round(v * 1000) / 1000).toString();
	return s === '-0' ? '0' : s;
};

/** UTF-16 code units of a word as 4-hex-digit codes; unpaired or non-BMP text goes through as its code units. */
function hexOf(text: string, used: Set<number>): { hex: string; units: number } {
	let hex = '';
	for (let i = 0; i < text.length; i++) {
		const u = text.charCodeAt(i);
		used.add(u);
		hex += u.toString(16).padStart(4, '0');
	}
	return { hex, units: text.length };
}

/** Matrix columns for the displayed page: user-space vectors of displayed +X and displayed "up" (−Y), and the user-space point of displayed (0,0). */
export function displayFrame(page: PL.PDFPage): { u: [number, number]; v: [number, number]; at: (X: number, Y: number) => [number, number]; W: number; H: number } {
	const mb = page.getMediaBox();
	const cb = page.getCropBox();
	const x0 = Math.max(mb.x, cb.x);
	const y0 = Math.max(mb.y, cb.y);
	const x1 = Math.min(mb.x + mb.width, cb.x + cb.width);
	const y1 = Math.min(mb.y + mb.height, cb.y + cb.height);
	const r = (((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
	const w = x1 - x0;
	const h = y1 - y0;
	switch (r) {
		case 90:
			return { u: [0, 1], v: [-1, 0], at: (X, Y) => [x0 + Y, y0 + X], W: h, H: w };
		case 180:
			return { u: [-1, 0], v: [0, -1], at: (X, Y) => [x1 - X, y0 + Y], W: w, H: h };
		case 270:
			return { u: [0, -1], v: [1, 0], at: (X, Y) => [x1 - Y, y1 - X], W: h, H: w };
		default:
			return { u: [1, 0], v: [0, 1], at: (X, Y) => [x0 + X, y1 - Y], W: w, H: h };
	}
}

export interface LayerStats {
	words: number;
	lines: number;
	contentBytes: number;
}

export class GlyphlessFont {
	readonly ref: PL.PDFRef;
	readonly used = new Set<number>();
	constructor(private doc: PL.PDFDocument) {
		this.ref = doc.context.nextRef();
	}

	/** Writes the font objects; call once after every page's layer is written. */
	finish(ttf: Uint8Array = new Uint8Array(fs.readFileSync(GLYPHLESS_TTF))) {
		const ctx = this.doc.context;
		const file = ctx.register(ctx.flateStream(ttf, { Length1: ttf.length }));
		const desc = ctx.register(
			ctx.obj({
				Type: 'FontDescriptor',
				FontName: 'GlyphLessFont',
				Flags: 5,
				FontBBox: [0, 0, 500, 1000],
				ItalicAngle: 0,
				Ascent: 1000,
				Descent: -1,
				CapHeight: 1000,
				StemV: 80,
				FontFile2: file
			})
		);
		const map = new Uint8Array(65536 * 2);
		for (let i = 0; i < 65536; i++) map[i * 2 + 1] = 1; // every CID → glyph 1
		const cidToGid = ctx.register(ctx.flateStream(map));
		const cid = ctx.register(
			ctx.obj({
				Type: 'Font',
				Subtype: 'CIDFontType2',
				BaseFont: 'GlyphLessFont',
				CIDSystemInfo: { Registry: PL.PDFString.of('Adobe'), Ordering: PL.PDFString.of('Identity'), Supplement: 0 },
				FontDescriptor: desc,
				DW: 500,
				CIDToGIDMap: cidToGid
			})
		);
		const codes = [...this.used].sort((a, b) => a - b);
		const h4 = (c: number) => c.toString(16).padStart(4, '0').toUpperCase();
		let body = '';
		for (let i = 0; i < codes.length; i += 100) {
			const chunk = codes.slice(i, i + 100);
			body += `${chunk.length} beginbfchar\n${chunk.map((c) => `<${h4(c)}> <${h4(c)}>`).join('\n')}\nendbfchar\n`;
		}
		const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${body}endcmap
CMapName currentdict /CMap defineresource pop
end
end
`;
		const toUni = ctx.register(ctx.flateStream(cmap));
		ctx.assign(
			this.ref,
			ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'GlyphLessFont', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUni })
		);
	}
}

/** Adds the invisible layer for `ocr` (made from the page rendered as displayed at ocr.dpi) to page `index`. */
/**
 * Lines whose baseline is within `snapDeg` of level are written level (PDF.js's text
 * extraction treats every text item on a non-axis-aligned matrix whose x-scale differs
 * from the previous one as a new line; see notes). Steeper lines follow their slope.
 */
export function addTextLayer(doc: PL.PDFDocument, index: number, ocr: OcrPage, font: GlyphlessFont, spaces: Spaces, stretch: Stretch = 'tz', snapDeg = 0.2): LayerStats {
	const page = doc.getPage(index);
	const f = displayFrame(page);
	const k = 72 / ocr.dpi;
	const name = page.node.newFontDictionary('OCR', font.ref);
	const ops: string[] = [];
	let words = 0;
	for (const line of ocr.lines) {
		// Tesseract's baseline (it may slope: skewed scans, or a "line" that steps across table
		// columns). The font's em box (ascent 1 em, descent 0) spans from the line's deepest
		// descender to its tallest ascender, measured across the baseline.
		const bl = line.baseline;
		const baseAt = (x: number) => {
			if (!bl) return Math.max(...line.words.map((w) => w[4]));
			const t = bl[2] === bl[0] ? 0 : (x - bl[0]) / (bl[2] - bl[0]);
			return bl[1] + t * (bl[3] - bl[1]);
		};
		// Slope of the baseline: the words are written along it (Tesseract's renderer does
		// the same), so a skewed scan gets tilted words and each word's box stays tight.
		const raw = bl && bl[2] !== bl[0] ? (bl[3] - bl[1]) / (bl[2] - bl[0]) : 0;
		const slope = Math.abs(Math.atan(raw)) <= (snapDeg * Math.PI) / 180 ? 0 : raw;
		const th = Math.atan(slope);
		const [c, s] = [Math.cos(th), Math.sin(th)];
		let asc = 1;
		let desc = 0;
		for (const w of line.words) {
			const b = baseAt((w[1] + w[3]) / 2);
			const rise = (Math.abs(slope) * (w[3] - w[1])) / 2;
			asc = Math.max(asc, b - w[2] - rise);
			desc = Math.max(desc, w[4] - b - rise);
		}
		const fs = Math.max(1, (asc + desc) * k);
		// Displayed-page vectors (Y down) → user space.
		const L = (dx: number, dy: number): [number, number] => [dx * f.u[0] - dy * f.v[0], dx * f.u[1] - dy * f.v[1]];
		const [a, b] = L(c, s);
		const [cc, d] = L(s, -c);
		// One Tm per line (at the first word); later words are reached by advancing along
		// the baseline: a stretched space glyph over the gap ("gap"), or a TJ offset
		// ("none"). One matrix per line matters to PDF.js, which ends a line at every new
		// non-axis-aligned matrix.
		const w0 = line.words[0];
		const [ox, oy] = f.at(w0[1] * k - s * desc * k, (baseAt(w0[1]) + c * desc) * k);
		ops.push(`BT 3 Tr ${name.asString()} ${n(fs)} Tf ${n(a)} ${n(b)} ${n(cc)} ${n(d)} ${n(ox)} ${n(oy)} Tm`);
		// Advance of each word (and gap) along the baseline, in points.
		const adv = line.words.map((w) => Math.max(0.1, ((w[3] - w[1]) * k) / c));
		const units = line.words.map((w) => w[0].length);
		// "tc": one horizontal scale for the line (the median a word needs), the rest per
		// word by character spacing, so the text matrix stays the same along the line.
		const need = adv.map((v, i) => (100 * v) / (units[i] * 0.5 * fs)).sort((x, y) => x - y);
		const mode: Stretch = stretch === 'mix' ? (slope === 0 ? 'tz' : 'tcmax') : stretch;
		const lineTz = mode === 'tcmax' ? need[need.length - 1] : need[Math.floor(need.length / 2)];
		if (mode !== 'tz') ops.push(`${n(lineTz)} Tz`);
		const hs = lineTz / 100;
		/** Operators that make `count` codes of `hex` advance `width` points. */
		const run = (hex: string, count: number, width: number, tail: string) => {
			if (mode === 'tz') return `${n((100 * width) / (count * 0.5 * fs))} Tz ${tail}`;
			return `${n(width / (count * hs) - 0.5 * fs)} Tc ${tail}`;
		};
		for (let i = 0; i < line.words.length; i++) {
			const [text, , , x1] = line.words[i];
			const { hex } = hexOf(text, font.used);
			words++;
			const next = line.words[i + 1];
			// Gap to the next word along the baseline; OCR boxes can overlap (negative gap).
			const gap = next ? ((next[1] - x1) * k) / c : 0;
			if (spaces === 'gap' || !next) {
				ops.push(run(hex, units[i], adv[i], `<${hex}> Tj`));
				if (next) {
					// The space spans the gap, at least 0.05 em; a TJ offset takes back any excess.
					const sw = Math.max(0.05 * fs, gap);
					const back = sw - gap;
					const sp = hexOf(' ', font.used).hex;
					const scale = mode === 'tz' ? sw / (0.5 * fs) : hs;
					ops.push(run(sp, 1, sw, back > 1e-3 ? `[<${sp}> ${n((back * 1000) / (fs * scale))}] TJ` : `<${sp}> Tj`));
				}
			} else {
				const scale = mode === 'tz' ? adv[i] / (units[i] * 0.5 * fs) : hs;
				ops.push(run(hex, units[i], adv[i], `[<${hex}> ${n((-gap * 1000) / (fs * scale))}] TJ`));
			}
		}
		ops.push('ET');
	}
	const ctx = doc.context;
	const start = ctx.register(ctx.flateStream('q\n'));
	const end = ctx.register(ctx.flateStream('Q\n'));
	const body = `q\n${ops.join('\n')}\nQ\n`;
	page.node.normalize();
	if (!page.node.wrapContentStreams(start, end)) throw new Error('page contents not wrappable');
	page.node.addContentStream(ctx.register(ctx.flateStream(body)));
	return { words, lines: ocr.lines.length, contentBytes: body.length };
}
