/**
 * Watermark (ExportOptions.watermark, 2026-11-14): one line of text across every page.
 *
 * Drawn by the stamps stage (stamps.ts calls `watermarkOps`) as ordinary page content,
 * after every stamp and page number, so it lies on top of the page:
 *
 *   q /PgsWm gs                                        ca = CA = opacity (light / medium)
 *     [clip: the page box minus every redaction box]   W* n, so a black box stays black
 *     /Artifact <</Type /Pagination /Subtype /Watermark>> BDC
 *       frame cm   BT /F size Tf … (text) Tj ET
 *     EMC
 *   Q
 *
 * The frame is `uprightFrame` at the middle of the page as displayed (after /Rotate, the
 * app's rotation and any crop), turned by the layout's angle, so the text reads the right
 * way up on screen on every page shape. The size is fitted to the page: the turned text
 * box stays inside 80% of the page each way, and is never more than a fifth of the
 * shorter side tall. Marked as a pagination artifact so screen readers that follow tags
 * skip it and the accessibility tags stay as they are (no MCID is used or changed).
 *
 * The check (`verifyWatermark`, PDF.js): on every page the text reads back as one run
 * (or runs that continue each other) at the planned angle, centred on the page's middle.
 *
 * Not protection: anyone with a PDF editor can delete the drawing. The dialog says so.
 */

import type * as PdfLib from '@cantoo/pdf-lib';
import type { PageSize, Rotation, StampBox, VerifyCheck, Watermark } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { displayedUserSize, multiply, normalizeStampText, stampPdfRect, uprightFrame, type Box, type Matrix } from './geometry';

/** Most characters a watermark may have. */
export const WATERMARK_MAX_CHARS = 40;
/** Fill colours (DeviceRGB). */
export const WATERMARK_RGB = { grey: [0.45, 0.45, 0.45], red: [0.784, 0.063, 0.18] } as const satisfies Record<Watermark['color'], readonly [number, number, number]>;
/** Opacity (ExtGState ca and CA). */
export const WATERMARK_OPACITY = { light: 0.2, medium: 0.38 } as const satisfies Record<Watermark['strength'], number>;
/** Cap height of the stamp font (Noto Sans), in em: the text is centred on its capitals. */
const CAP_EM = 0.714;
/** Height counted when fitting (capitals plus room for descenders), in em. */
const FIT_HEIGHT_EM = 1.0;
/** Share of the page each way the turned text may cover. */
const FIT_SHARE = 0.8;
/** Tallest text: this share of the page's shorter side. */
const MAX_SIZE_SHARE = 0.2;
/** Smallest size drawn (points, UserUnit applied); smaller is refused as unreadable. */
export const WATERMARK_MIN_PT = 8;

const LOOKS: readonly Watermark['look'][] = ['diagonal', 'straight'];
const STRENGTHS: readonly Watermark['strength'][] = ['light', 'medium'];
const COLORS: readonly Watermark['color'][] = ['grey', 'red'];

/** The text as drawn: NFC, spaces collapsed, trimmed. */
export function watermarkText(text: string): string {
	return normalizeStampText(text).replace(/\s+/g, ' ').trim();
}

/** Throws EngineError('unsupported') with a sentence the person can act on. Font coverage is checked by the caller. */
export function validateWatermark(w: Watermark): void {
	const bad = (msg: string) => new EngineError('unsupported', msg);
	if (typeof w !== 'object' || w === null || typeof w.text !== 'string') throw bad('The watermark settings are missing.');
	const text = watermarkText(w.text);
	if (text === '') throw bad('Type the watermark text.');
	if (/[\p{C}\n]/u.test(w.text.replace(/\s/g, ' '))) throw bad('The watermark contains invisible characters. Use letters, digits and symbols.');
	if ([...text].length > WATERMARK_MAX_CHARS) throw bad(`The watermark can have at most ${WATERMARK_MAX_CHARS} characters.`);
	if (!LOOKS.includes(w.look)) throw bad('Choose how the watermark runs across the page.');
	if (!STRENGTHS.includes(w.strength)) throw bad('Choose how strong the watermark is.');
	if (!COLORS.includes(w.color)) throw bad('Choose a colour for the watermark.');
}

export interface WatermarkLayout {
	/** Font size, in the units of W and H. */
	size: number;
	/** Counter-clockwise turn on screen, in radians (0: level). */
	angle: number;
	/** Middle of the page as displayed, from the top-left. */
	cx: number;
	cy: number;
	/** Advance width of the text at `size`. */
	width: number;
}

/**
 * Where the watermark goes on a page displayed W × H (any unit). `advanceEm` is the
 * text's advance width at size 1. Diagonal: along the page's diagonal from the
 * bottom-left to the top-right corner; straight: level. Both centred.
 */
export function watermarkLayout(W: number, H: number, advanceEm: number, look: Watermark['look']): WatermarkLayout {
	const angle = look === 'diagonal' ? Math.atan2(H, W) : 0;
	const c = Math.cos(angle);
	const s = Math.sin(angle);
	const a = Math.max(advanceEm, 1e-6);
	const e = FIT_HEIGHT_EM;
	const size = Math.min((FIT_SHARE * W) / (a * c + e * s), (FIT_SHARE * H) / (a * s + e * c), MAX_SIZE_SHARE * Math.min(W, H));
	return { size, angle, cx: W / 2, cy: H / 2, width: a * size };
}

/** What the stamps stage needs to draw the watermark on every page. */
export interface WatermarkJob {
	watermark: Watermark;
	/** Redaction boxes per output page (stamp space), kept free of the watermark so they stay solid black. */
	redactions: StampBox[][];
	/** Displayed size the plan expects for every output page (as NumberingJob.expected). */
	expected: PageSize[];
}

interface Geometry {
	box: Box;
	rotation: Rotation;
	userUnit: number;
}

const r4 = (n: number) => Math.round(n * 10000) / 10000;

/**
 * Operators that draw the watermark on one page, in the page's initial graphics state.
 * `fontName` and `gsName` are resource names on the page (the stamp font and an
 * ExtGState with the watermark's opacity).
 */
export function watermarkOps(
	lib: typeof PdfLib,
	geom: Geometry,
	wm: Watermark,
	font: PdfLib.PDFFont,
	fontName: string,
	gsName: string,
	redactions: StampBox[],
	pageIndex: number
): PdfLib.PDFOperator[] {
	const ops = lib;
	const text = watermarkText(wm.text);
	const shown = displayedUserSize(geom.box, geom.rotation);
	const lay = watermarkLayout(shown.width, shown.height, font.widthOfTextAtSize(text, 1), wm.look);
	if (lay.size * geom.userUnit < WATERMARK_MIN_PT) {
		throw new EngineError('unsupported', `Page ${pageIndex + 1} is too small for this watermark. Use shorter text.`);
	}
	const c = Math.cos(lay.angle);
	const s = Math.sin(lay.angle);
	// Upright frame at the middle (y up on screen), turned counter-clockwise by the angle.
	const frame = multiply([c, s, -s, c, 0, 0], uprightFrame(geom.box, geom.rotation, lay.cx, lay.cy));
	const [cr, cg, cb] = WATERMARK_RGB[wm.color];
	const out: PdfLib.PDFOperator[] = [ops.pushGraphicsState(), ops.setGraphicsState(gsName)];
	if (redactions.length) {
		// Even-odd clip: the page box with a hole for every redaction box.
		const b = geom.box;
		out.push(ops.rectangle(r4(b.x0), r4(b.y0), r4(b.x1 - b.x0), r4(b.y1 - b.y0)));
		for (const r of redactions) {
			const p = stampPdfRect(geom.box, geom.rotation, r);
			out.push(ops.rectangle(r4(p.x0), r4(p.y0), r4(p.x1 - p.x0), r4(p.y1 - p.y0)));
		}
		out.push(ops.clipEvenOdd(), ops.endPath());
	}
	out.push(
		lib.PDFOperator.of(lib.PDFOperatorNames.BeginMarkedContentSequence, [lib.PDFName.of('Artifact'), '<< /Type /Pagination /Subtype /Watermark >>']),
		ops.concatTransformationMatrix(...(frame.map(r4) as Matrix)),
		ops.setFillingRgbColor(cr, cg, cb),
		ops.beginText(),
		ops.setFontAndSize(fontName, r4(lay.size)),
		ops.setCharacterSpacing(0),
		ops.setWordSpacing(0),
		ops.setCharacterSqueeze(100),
		ops.setTextRise(0),
		ops.setTextRenderingMode(ops.TextRenderingMode.Fill),
		ops.setTextMatrix(1, 0, 0, 1, r4(-lay.width / 2), r4((-CAP_EM * lay.size) / 2)),
		ops.showText(font.encodeText(text)),
		ops.endText(),
		ops.endMarkedContent(),
		ops.popGraphicsState()
	);
	return out;
}

const squash = (s: string) => s.replace(/\s+/g, '');

/**
 * 'watermark' check on the final file, with PDF.js (an independent reader): on every
 * page the watermark text reads back at the planned angle (within 1°), centred on the
 * page's middle (within 2% of the page's shorter side).
 */
export async function verifyWatermark(deps: EngineDeps, finalBytes: Uint8Array, wm: Watermark, pageCount: number, password?: string): Promise<VerifyCheck> {
	const text = watermarkText(wm.text);
	const want = squash(text);
	const fail = (detail: string): VerifyCheck => ({ name: 'watermark', ok: false, detail });
	const lib = await deps.pdfjs();
	const task = lib.getDocument({
		data: finalBytes.slice(),
		password,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		verbosity: 0
	});
	const missing: number[] = [];
	try {
		const doc = await task.promise;
		if (doc.numPages !== pageCount) return fail(`The file has ${doc.numPages} pages but ${pageCount} were expected, so the watermark cannot be checked.`);
		for (let i = 0; i < pageCount; i++) {
			const page = await doc.getPage(i + 1);
			try {
				if (!(await watermarkIsThere(page, want, wm.look))) missing.push(i + 1);
			} finally {
				page.cleanup();
			}
		}
	} catch {
		return fail('The watermark could not be read back from the file.');
	} finally {
		await task.destroy().catch(() => undefined);
	}
	if (missing.length) {
		const shown = missing.slice(0, 5).join(', ') + (missing.length > 5 ? ` and ${missing.length - 5} more` : '');
		return fail(`The watermark was not found where it was drawn on page ${shown}.`);
	}
	return { name: 'watermark', ok: true, detail: `"${text}" is across the middle of all ${pageCount} ${pageCount === 1 ? 'page' : 'pages'}.` };
}

async function watermarkIsThere(page: import('pdfjs-dist/legacy/build/pdf.mjs').PDFPageProxy, want: string, look: Watermark['look']): Promise<boolean> {
	const vp = page.getViewport({ scale: 1 });
	const W = vp.width;
	const H = vp.height;
	const angle = look === 'diagonal' ? Math.atan2(H, W) : 0;
	const dir: [number, number] = [Math.cos(angle), -Math.sin(angle)];
	const tc = await page.getTextContent();
	// Runs along the planned direction, as positions along it (display space, y down).
	const runs: { str: string; t0: number; t1: number; start: [number, number]; size: number }[] = [];
	for (const it of tc.items) {
		if (!('str' in it) || !it.str || squash(it.str) === '') continue;
		const [a, b, c, d, e, f] = it.transform as number[];
		const h = Math.hypot(a, b);
		if (h === 0) continue;
		const p0 = vp.convertToViewportPoint(e, f) as [number, number];
		const p1 = vp.convertToViewportPoint(e + (it.width * a) / h, f + (it.width * b) / h) as [number, number];
		const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
		if (len === 0) continue;
		const ux = (p1[0] - p0[0]) / len;
		const uy = (p1[1] - p0[1]) / len;
		if (ux * dir[0] + uy * dir[1] < Math.cos((1 * Math.PI) / 180)) continue;
		const t0 = p0[0] * dir[0] + p0[1] * dir[1];
		const pu = vp.convertToViewportPoint(e + c, f + d) as [number, number];
		runs.push({ str: it.str, t0, t1: t0 + len, start: p0, size: Math.hypot(pu[0] - p0[0], pu[1] - p0[1]) });
	}
	runs.sort((p, q) => p.t0 - q.t0);
	const tol = 0.02 * Math.min(W, H);
	for (let i = 0; i < runs.length; i++) {
		const first = runs[i];
		let text = squash(first.str);
		if (!want.startsWith(text)) continue;
		let t1 = first.t1;
		for (let j = i + 1; j < runs.length && text.length < want.length; j++) {
			const r = runs[j];
			// Same line: its start lies on the first run's line, and it follows on.
			const off = (r.start[0] - first.start[0]) * -dir[1] + (r.start[1] - first.start[1]) * dir[0];
			if (Math.abs(off) > 1 || r.t0 < t1 - 2 || r.t0 - t1 > first.size) continue;
			const next = text + squash(r.str);
			if (!want.startsWith(next)) continue;
			text = next;
			t1 = Math.max(t1, r.t1);
		}
		if (text !== want) continue;
		// The run's middle, a half cap height above its baseline, is the page's middle.
		const mid = (first.t0 + t1) / 2 - first.t0;
		const up: [number, number] = [dir[1], -dir[0]];
		const mx = first.start[0] + dir[0] * mid + up[0] * ((CAP_EM * first.size) / 2);
		const my = first.start[1] + dir[1] * mid + up[1] * ((CAP_EM * first.size) / 2);
		if (Math.hypot(mx - W / 2, my - H / 2) <= tol) return true;
	}
	return false;
}

/**
 * The job for an export's watermark, or null without one. Checks the settings and that
 * the stamp font can draw every character (EngineError 'unsupported' otherwise: the
 * export is refused rather than drawn with missing letters).
 */
export async function watermarkJob(
	font: { unsupportedChars(text: string): Promise<string> },
	wm: Watermark | undefined,
	pages: readonly { stamps: readonly { kind: string; box?: StampBox }[] }[],
	expected: PageSize[]
): Promise<WatermarkJob | null> {
	if (wm === undefined) return null;
	validateWatermark(wm);
	const text = watermarkText(wm.text);
	const bad = await font.unsupportedChars(text);
	if (bad) throw new EngineError('unsupported', `The watermark uses characters that cannot be printed: ${[...bad].join(' ')}. Remove them.`);
	return {
		watermark: { text, look: wm.look, strength: wm.strength, color: wm.color },
		redactions: pages.map((p) => p.stamps.flatMap((s) => (s.kind === 'redact' && s.box ? [s.box] : []))),
		expected
	};
}
