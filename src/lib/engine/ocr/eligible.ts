/**
 * Which pages "Make scanned pages searchable" may try (the measurement's avoid list,
 * /home/garrett/pdf-survey/out-ocr/notes.md §6): a page of a PDF source that
 *  - has no text at all: no real text and no old OCR layer (invisible or clipped
 *    text counts), so mixed pages (a scan plus real text) are never touched;
 *  - is essentially one picture: an image (or image mask) covering at least 85% of
 *    the page, of at least 200 pixels per inch along both sides as drawn (the best
 *    such picture counts: a scan stored as a background plus a sharp mask qualifies);
 *  - fits the render budget: at most 25 MP rendered at 300 dpi, the picture at most
 *    36 MP (a 600 dpi Letter scan), UserUnit 1.
 *
 * Two steps, so opening the export dialog does not download MuPDF for ordinary files:
 * qpdf (already loaded) lists each page's images, and only a page with an image big
 * enough to qualify is looked at with MuPDF (what it draws, and where).
 */

import type * as MU from 'mupdf';
import type { PageSize } from '../../core/types';
import { disown, rethrowFault, type Mupdf } from '../mupdf';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from '../qpdf';

export const OCR_DPI = 300;
export const MIN_PPI = 200;
export const MIN_COVER = 0.85;
export const MAX_RENDER_PIXELS = 25_000_000;
export const MAX_IMAGE_PIXELS = 36_000_000;

/** Pages whose images could make them eligible (qpdf only; no MuPDF). */
export async function imageCandidates(qpdf: Qpdf, bytes: Uint8Array, pages: PageSize[]): Promise<number[]> {
	const res = await qpdf.run({ args: ['--json=2', '--json-key=pages', '/c.pdf'], inputs: { '/c.pdf': bytes } });
	if (res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) return [];
	let parsed: { pages?: { images?: { width?: unknown; height?: unknown }[] }[] };
	try {
		parsed = JSON.parse(res.stdout);
	} catch {
		return [];
	}
	const out: number[] = [];
	(parsed.pages ?? []).forEach((p, i) => {
		const size = pages[i];
		if (!size) return;
		const need = MIN_COVER * ((size.width / 72) * MIN_PPI) * ((size.height / 72) * MIN_PPI);
		const ok = (p.images ?? []).some((im) => {
			const w = Number(im.width);
			const h = Number(im.height);
			return Number.isFinite(w) && Number.isFinite(h) && w * h >= need * 0.999;
		});
		if (ok) out.push(i);
	});
	return out;
}

export interface ScanCheck {
	eligible: boolean;
	/** Why not, for debugging and tests. */
	reason?: 'text' | 'no picture' | 'low resolution' | 'too large' | 'user unit' | 'unreadable';
	/** Best covering picture: share of the page and pixels per inch. */
	cover: number;
	ppi: number;
}

type Mat = [number, number, number, number, number, number];
const ap = (m: Mat, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/** What page `index` of an opened MuPDF document is made of, and whether it qualifies. */
export function checkScanPage(m: Mupdf, doc: MU.Document, index: number): ScanCheck {
	const page = doc.loadPage(index) as MU.PDFPage;
	try {
		try {
			const uu = page.getObject().get('UserUnit');
			if (uu && uu.isNumber() && uu.asNumber() !== 1) return { eligible: false, reason: 'user unit', cover: 0, ppi: 0 };
		} catch {
			// No UserUnit.
		}
		const [x0, y0, x1, y1] = page.getBounds();
		const W = x1 - x0;
		const H = y1 - y0;
		if (!(W > 0 && H > 0)) return { eligible: false, reason: 'unreadable', cover: 0, ppi: 0 };
		let text = false;
		const pics: { cover: number; ppi: number; px: number }[] = [];
		const onImage = (img: MU.Image, ctm: Mat) => {
			const pts = [ap(ctm, 0, 0), ap(ctm, 1, 0), ap(ctm, 0, 1), ap(ctm, 1, 1)];
			const xs = pts.map((p) => p[0] - x0);
			const ys = pts.map((p) => p[1] - y0);
			const bw = Math.max(0, Math.min(W, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
			const bh = Math.max(0, Math.min(H, Math.max(...ys)) - Math.max(0, Math.min(...ys)));
			const pw = img.getWidth();
			const ph = img.getHeight();
			const a = Math.hypot(ctm[0], ctm[1]) / 72;
			const b = Math.hypot(ctm[2], ctm[3]) / 72;
			pics.push({ cover: (bw * bh) / (W * H), ppi: Math.min(pw / Math.max(1e-6, a), ph / Math.max(1e-6, b)), px: pw * ph });
		};
		const dl = page.toDisplayList(false);
		const dev = new m.Device({
			fillText: () => void (text = true),
			strokeText: () => void (text = true),
			clipText: () => void (text = true),
			clipStrokeText: () => void (text = true),
			ignoreText: () => void (text = true),
			fillImage: (img, ctm) => onImage(img, ctm as Mat),
			fillImageMask: (img, ctm) => onImage(img, ctm as Mat),
			clipImageMask: (img, ctm) => onImage(img, ctm as Mat),
			fillShade(shade) {
				// See mupdf.ts: the borrowed shade must not be freed by its wrapper.
				disown(shade);
			}
		});
		try {
			dl.run(dev, m.Matrix.identity);
		} finally {
			try {
				dev.close();
			} catch {
				// Closed.
			}
			dev.destroy();
			dl.destroy();
		}
		const covering = pics.filter((p) => p.cover >= MIN_COVER);
		const best = covering.reduce<(typeof pics)[number] | null>((b, p) => (!b || p.ppi > b.ppi ? p : b), null);
		const cover = best?.cover ?? Math.max(0, ...pics.map((p) => p.cover));
		const ppi = best?.ppi ?? 0;
		if (text) return { eligible: false, reason: 'text', cover, ppi };
		if (!best) return { eligible: false, reason: 'no picture', cover, ppi };
		if (best.ppi < MIN_PPI) return { eligible: false, reason: 'low resolution', cover, ppi };
		if (best.px > MAX_IMAGE_PIXELS || W * H * (OCR_DPI / 72) ** 2 > MAX_RENDER_PIXELS) return { eligible: false, reason: 'too large', cover, ppi };
		return { eligible: true, cover, ppi };
	} finally {
		page.destroy();
	}
}

/** Eligible pages of one PDF source's bytes (0-based). */
export async function scannedPagesOf(qpdf: Qpdf, mupdf: () => Promise<Mupdf>, bytes: Uint8Array, pages: PageSize[]): Promise<number[]> {
	const cands = await imageCandidates(qpdf, bytes, pages);
	if (!cands.length) return [];
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes, 'application/pdf');
	try {
		const out: number[] = [];
		for (const i of cands) {
			if (i >= doc.countPages()) continue;
			try {
				if (checkScanPage(m, doc, i).eligible) out.push(i);
			} catch (e) {
				// A page MuPDF cannot read is not tried (wasm traps still go up).
				rethrowFault(e);
			}
		}
		return out;
	} finally {
		doc.destroy();
	}
}
