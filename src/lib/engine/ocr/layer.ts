/**
 * Writes the invisible OCR text layer of "Make scanned pages searchable" with
 * @cantoo/pdf-lib (the measurement's prototype, tools/ocr/layer/layer.ts, variant
 * gap-tz-0.2, which kept page pixels identical in MuPDF, PDF.js and poppler):
 *
 *  - one glyphless font per file: Type0 / CIDFontType2, Identity-H, every CID drawn
 *    with the blank glyph of Tesseract's pdf.ttf (CIDToGIDMap), width DW 500 (half an
 *    em), and a ToUnicode CMap for the codes used (code = the character's UTF-16 unit);
 *  - per page, the original content wrapped so it runs in its own graphics state
 *    (leading q's for every Q it has too many, then as many Q's as it leaves open:
 *    content.ts `graphicsNesting`, as the stamps stage does), then one new content
 *    stream: per OCR line `BT 3 Tr` (invisible), font size = the line's height about
 *    Tesseract's baseline (tallest ascender to deepest descender), one `Tm` at the
 *    first word on that baseline, turned to its slope (lines within 0.2° of level are
 *    written level), per word a horizontal stretch (Tz) so its advance equals its OCR
 *    box width, and a stretched space glyph across each gap (MuPDF glues words without);
 *  - coordinates: Tesseract reads the page turned by its own deskew angle, so each line
 *    is laid out in that turned image, turned back about the image centre, then pixels
 *    of the page as displayed (rendered at `dpi`) → points → PDF user space, honouring
 *    the source's /Rotate and the CropBox ∩ MediaBox origin. The user's extra rotation
 *    is added by assembly as /Rotate only, so it does not move user space.
 *
 * Every word written is returned with where it was put, for the stage's checks.
 */

import type * as PdfLib from '@cantoo/pdf-lib';
import type { Rotation } from '../../core/types';
import { graphicsNesting } from '../content';
import { displayToPdf, type Box } from '../geometry';
import { readGeometry } from '../stamps';
import { glyphlessTtf } from './glyphless';
import type { OcrRead } from './tess';

/** Lines whose baseline is this close to level (degrees) are written level. */
export const SNAP_DEG = 0.2;

export interface LayerPage {
	/** 0-based page of the assembled file. */
	pageIndex: number;
	/** The rotation the user added to this page (assembly put it into /Rotate). */
	userRotation: Rotation;
	read: OcrRead;
	/** Resolution the page was rendered at for OCR. */
	dpi: number;
}

/** One written word: its text and its em box as four corners in PDF user space. */
export interface WrittenWord {
	text: string;
	line: number;
	quad: [number, number][];
}

export interface LayerResult {
	bytes: Uint8Array;
	/** Words written, by page index. */
	written: Map<number, WrittenWord[]>;
	/** Pages left without a layer, by page index, with the reason (for debugging). */
	skipped: Map<number, string>;
}

const n = (v: number) => {
	const s = (Math.round(v * 1000) / 1000).toString();
	return s === '-0' ? '0' : s;
};

/** Text that the font can carry: BMP characters only, no control codes or U+FFFD. */
export function cleanText(text: string): string {
	let out = '';
	for (const ch of text) {
		const k = ch.codePointAt(0) ?? 0;
		if (k > 0xffff || k < 0x20 || (k >= 0x7f && k < 0xa0) || k === 0xfffd || (k >= 0xd800 && k <= 0xdfff)) continue;
		out += ch;
	}
	return out.trim();
}

interface LaidWord {
	text: string;
	/** Start along the line from the line origin, and advance, points. */
	at: number;
	adv: number;
	/** Gap to the next word, points (may be negative), or null for the last word. */
	gap: number | null;
}

interface LaidLine {
	/** Origin (bottom of the em box, at the first word's left edge), display points of the source page. */
	ox: number;
	oy: number;
	/** Direction along the baseline in display space (y down). */
	cos: number;
	sin: number;
	size: number;
	words: LaidWord[];
}

/** Lays out the lines of one page in display points of the source page (as it was rendered). */
export function layoutLines(read: OcrRead, dpi: number): LaidLine[] {
	const k = 72 / dpi;
	const a = read.rotate;
	const cx = read.width / 2;
	const cy = read.height / 2;
	const ca = Math.cos(-a);
	const sa = Math.sin(-a);
	// From Tesseract's turned image back to the image as rendered.
	const back = (x: number, y: number): [number, number] => [ca * (x - cx) - sa * (y - cy) + cx, sa * (x - cx) + ca * (y - cy) + cy];
	const out: LaidLine[] = [];
	for (const line of read.lines) {
		const words = line.words.map((w) => [cleanText(w[0]), w[1], w[2], w[3], w[4]] as const).filter((w) => w[0] !== '' && [w[1], w[2], w[3], w[4]].every(Number.isFinite) && w[3] > w[1] && w[4] > w[2]);
		if (!words.length) continue;
		const bl = line.baseline;
		const baseAt = (x: number) => {
			if (!bl) return Math.max(...words.map((w) => w[4]));
			const t = bl[2] === bl[0] ? 0 : (x - bl[0]) / (bl[2] - bl[0]);
			return bl[1] + t * (bl[3] - bl[1]);
		};
		// Slope in the turned image, where lines are close to level.
		const slope = bl && bl[2] !== bl[0] ? (bl[3] - bl[1]) / (bl[2] - bl[0]) : 0;
		if (!Number.isFinite(slope) || Math.abs(slope) > 0.2) continue;
		const th = Math.atan(slope);
		const c = Math.cos(th);
		const s = Math.sin(th);
		// The em box (ascent 1 em, descent 0) spans the line's deepest descender to its
		// tallest ascender, measured across the baseline.
		let asc = 1;
		let desc = 0;
		for (const w of words) {
			const b = baseAt((w[1] + w[3]) / 2);
			const rise = (Math.abs(slope) * (w[3] - w[1])) / 2;
			asc = Math.max(asc, b - w[2] - rise);
			desc = Math.max(desc, w[4] - b - rise);
		}
		const size = Math.max(1, (asc + desc) * k);
		// Origin in the turned image: the first word's left edge on the baseline, moved down by desc.
		const w0 = words[0];
		const [tx, ty] = [w0[1] - s * desc, baseAt(w0[1]) + c * desc];
		const [ix, iy] = back(tx, ty);
		// Direction in the image as rendered: the line's slope less Tesseract's turn.
		let ang = th - a;
		if (Math.abs(ang) <= (SNAP_DEG * Math.PI) / 180) ang = 0;
		const laid: LaidWord[] = [];
		for (let i = 0; i < words.length; i++) {
			const w = words[i];
			const next = words[i + 1];
			laid.push({
				text: w[0],
				at: ((w[1] - w0[1]) * k) / c,
				adv: Math.max(0.1, ((w[3] - w[1]) * k) / c),
				gap: next ? ((next[1] - w[3]) * k) / c : null
			});
		}
		out.push({ ox: ix * k, oy: iy * k, cos: Math.cos(ang), sin: Math.sin(ang), size, words: laid });
	}
	return out;
}

/** Adds the layer to each page in `pages`; pages whose content cannot be wrapped safely are skipped. */
export async function writeLayers(lib: typeof PdfLib, bytes: Uint8Array, pages: LayerPage[]): Promise<LayerResult> {
	const { PDFDocument, PDFName, PDFArray, PDFRef, PDFRawStream, PDFContentStream, PDFString, ParseSpeeds } = lib;
	const doc = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: true, parseSpeed: ParseSpeeds.Fastest });
	const ctx = doc.context;
	const all = doc.getPages();
	const written = new Map<number, WrittenWord[]>();
	const skipped = new Map<number, string>();
	const used = new Set<number>();
	const fontRef = ctx.nextRef();
	const seen = new Set<string>();

	for (const job of pages) {
		const page = all[job.pageIndex];
		if (!page) {
			skipped.set(job.pageIndex, 'page missing');
			continue;
		}
		const leaf = page.node;
		if (seen.has(page.ref.toString())) {
			skipped.set(job.pageIndex, 'page object shared with another output page');
			continue;
		}
		seen.add(page.ref.toString());
		const geom = readGeometry(lib, leaf);
		if (geom.userUnit !== 1) {
			skipped.set(job.pageIndex, 'UserUnit');
			continue;
		}
		const rotation = (((geom.rotation - job.userRotation) % 360) + 360) % 360 as Rotation;

		// Original content and its q/Q nesting (as stamps.ts reads it).
		let raw = leaf.get(PDFName.of('Contents'));
		if (raw instanceof PDFRef) {
			const target = ctx.lookup(raw);
			if (target instanceof PDFArray) raw = target;
		}
		const refs: PdfLib.PDFObject[] = [];
		if (raw instanceof PDFArray) for (let i = 0; i < raw.size(); i++) refs.push(raw.get(i));
		else if (raw) refs.push(raw);
		const decoded: Uint8Array[] = [];
		const kept: PdfLib.PDFObject[] = [];
		let bad: string | null = null;
		for (let i = 0; i < refs.length && !bad; i++) {
			let ref = refs[i];
			if (!(ref instanceof PDFRef)) ref = ctx.register(ref);
			const obj = ctx.lookup(ref);
			if (obj instanceof PDFRawStream) {
				if (obj.getContentsSize() === 0) continue;
				try {
					decoded.push(lib.decodePDFRawStream(obj).decode());
				} catch {
					bad = 'content cannot be decoded';
				}
				kept.push(ref);
			} else if (obj instanceof PDFContentStream) {
				decoded.push(obj.getUnencodedContents());
				kept.push(ref);
			} else if (obj !== undefined && obj !== lib.PDFNull) bad = 'content is not a stream';
		}
		const nest = bad ? null : graphicsNesting(decoded);
		if (bad || !nest || nest.unterminated) {
			skipped.set(job.pageIndex, bad ?? `content ends inside ${nest?.unterminated}`);
			continue;
		}

		const lines = layoutLines(job.read, job.dpi);
		const ops: string[] = [];
		const words: WrittenWord[] = [];
		const box: Box = geom.box;
		// Display-space vector (y down) → user-space vector.
		const [ux0, uy0] = displayToPdf(box, rotation, 0, 0);
		const vec = (dx: number, dy: number): [number, number] => {
			const [x, y] = displayToPdf(box, rotation, dx, dy);
			return [x - ux0, y - uy0];
		};
		const hex = (text: string) => {
			let h = '';
			for (let i = 0; i < text.length; i++) {
				const u = text.charCodeAt(i);
				used.add(u);
				h += u.toString(16).padStart(4, '0');
			}
			return h;
		};
		const fontName = 'OCRGlyphless';
		lines.forEach((l, li) => {
			const fs = l.size;
			const [a, b] = vec(l.cos, l.sin);
			const [c, d] = vec(l.sin, -l.cos);
			const [ox, oy] = displayToPdf(box, rotation, l.ox, l.oy);
			if (![fs, a, b, c, d, ox, oy].every(Number.isFinite)) return;
			ops.push(`BT 3 Tr /${fontName} ${n(fs)} Tf ${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(ox)} ${n(oy)} Tm`);
			const sp = hex(' ');
			for (const w of l.words) {
				const units = w.text.length;
				ops.push(`${n((100 * w.adv) / (units * 0.5 * fs))} Tz <${hex(w.text)}> Tj`);
				const corner = (t: number, h: number): [number, number] => displayToPdf(box, rotation, l.ox + t * l.cos + h * l.sin, l.oy + t * l.sin - h * l.cos);
				words.push({ text: w.text, line: li, quad: [corner(w.at, fs), corner(w.at + w.adv, fs), corner(w.at, 0), corner(w.at + w.adv, 0)] });
				if (w.gap !== null) {
					// The space spans the gap, at least 0.05 em; a TJ offset takes back any excess.
					const sw = Math.max(0.05 * fs, w.gap);
					const back = sw - w.gap;
					const tz = (100 * sw) / (0.5 * fs);
					ops.push(back > 1e-3 ? `${n(tz)} Tz [<${sp}> ${n((back * 1000) / (fs * (tz / 100)))}] TJ` : `${n(tz)} Tz <${sp}> Tj`);
				}
			}
			ops.push('ET');
		});
		if (!words.length) {
			skipped.set(job.pageIndex, 'no words to write');
			continue;
		}

		// Page-local copies of the resource dictionaries, so shared ones are not changed.
		const inherited = leaf.Resources();
		const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
		const fonts = resources.lookupMaybe(PDFName.of('Font'), lib.PDFDict);
		const fontsCopy = fonts ? fonts.clone(ctx) : ctx.obj({});
		if (fontsCopy.has(PDFName.of(fontName))) {
			skipped.set(job.pageIndex, 'font name taken');
			continue;
		}
		fontsCopy.set(PDFName.of(fontName), fontRef);
		resources.set(PDFName.of('Font'), fontsCopy);
		leaf.set(PDFName.of('Resources'), resources);

		const pushes = 1 - nest.minDepth;
		const pops = pushes + nest.finalDepth;
		const pre = ctx.register(ctx.flateStream('q\n'.repeat(pushes)));
		const tail = ctx.register(ctx.flateStream(`${nest.inText ? 'ET\n' : ''}${'Q\n'.repeat(pops)}q\n${ops.join('\n')}\nQ\n`));
		leaf.set(PDFName.of('Contents'), ctx.obj([pre, ...kept, tail]));
		written.set(job.pageIndex, words);
	}

	if (written.size) {
		const ttf = glyphlessTtf();
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
		for (let i = 0; i < 65536; i++) map[i * 2 + 1] = 1; // every CID → glyph 1 (blank)
		const cidToGid = ctx.register(ctx.flateStream(map));
		const cid = ctx.register(
			ctx.obj({
				Type: 'Font',
				Subtype: 'CIDFontType2',
				BaseFont: 'GlyphLessFont',
				CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
				FontDescriptor: desc,
				DW: 500,
				CIDToGIDMap: cidToGid
			})
		);
		const codes = [...used].sort((x, y) => x - y);
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
		ctx.assign(fontRef, ctx.obj({ Type: 'Font', Subtype: 'Type0', BaseFont: 'GlyphLessFont', Encoding: 'Identity-H', DescendantFonts: [cid], ToUnicode: toUni }));
	}

	const out = written.size ? await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false, objectsPerTick: Infinity }) : bytes;
	return { bytes: out, written, skipped };
}
