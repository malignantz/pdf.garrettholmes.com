/**
 * The truth on a page and its visible cues, shared by the blank detector's and the
 * snap harness's workers:
 * - `pageWidgets`: the widgets that count (visible, not push buttons, on the page),
 *   and the rest as "neutral" rectangles;
 * - `hasCue`: whether the page content (not the widget) shows something at a widget's
 *   spot: a line along its top or bottom, a box about its size, a ring, underscores
 *   or a box glyph.
 */
import type * as MU from 'mupdf';
import type { PageInk } from '../../src/lib/engine/forms-detect';
import type { Rect, TruthType } from './match';

const HIDDEN = 2 | 32; // Hidden, NoView

function widgetType(w: MU.PDFWidget): TruthType | 'button' | null {
	const t = w.getFieldType();
	if (t === 'text') return 'text';
	if (t === 'checkbox') return 'checkbox';
	if (t === 'radiobutton') return 'radio';
	if (t === 'combobox' || t === 'listbox') return 'choice';
	if (t === 'signature') return 'signature';
	if (t === 'button') return 'button';
	return null;
}

/** Widgets of a page in MuPDF page space: the counted ones, and the others (buttons, hidden) as neutral rectangles. */
export function pageWidgets(page: MU.PDFPage): { kept: { type: TruthType; rect: Rect }[]; neutral: Rect[] } {
	const pb = page.getBounds();
	const [bx, by] = pb;
	const neutral: Rect[] = [];
	const kept: { type: TruthType; rect: Rect }[] = [];
	for (const w of page.getWidgets()) {
		const b = w.getBounds();
		const rect: Rect = [b[0] - bx, b[1] - by, b[2] - bx, b[3] - by];
		const type = widgetType(w);
		const hidden = (w.getFlags() & HIDDEN) !== 0;
		const tiny = rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1;
		const off = rect[2] < 0 || rect[3] < 0 || rect[0] > pb[2] - bx || rect[1] > pb[3] - by;
		if (!type || type === 'button' || hidden || tiny || off) {
			if (!tiny && !off) neutral.push(rect);
			continue;
		}
		kept.push({ type, rect });
	}
	return { kept, neutral };
}

/** Something drawn in the page content marks this widget's spot. */
export function hasCue(ink: PageInk, t: { type: TruthType; rect: Rect }): boolean {
	const r = t.rect;
	const w = r[2] - r[0];
	const h = r[3] - r[1];
	const g = Math.max(3, 0.3 * h);
	// Horizontal ink along the widget's top or bottom covering half its width (pieces add up).
	let cover = 0;
	for (const l of ink.lines) {
		if (l.light > 0.92) continue;
		if (l.dir === 'h') {
			const o = Math.min(l.x1, r[2]) - Math.max(l.x0, r[0]);
			if (o > 0 && l.y0 >= r[1] - g && l.y0 <= r[3] + g) cover += o;
		} else if (t.type === 'checkbox' || t.type === 'radio') {
			const o = Math.min(l.y1, r[3]) - Math.max(l.y0, r[1]);
			if (o >= 0.5 * h && l.x0 >= r[0] - g && l.x0 <= r[2] + g) return true;
		}
	}
	if (cover >= 0.5 * w) return true;
	for (const b of ink.boxes) {
		const ox = Math.min(b.r[2], r[2]) - Math.max(b.r[0], r[0]);
		const oy = Math.min(b.r[3], r[3]) - Math.max(b.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		const bArea = (b.r[2] - b.r[0]) * (b.r[3] - b.r[1]);
		// A box about the widget's size (not a page-wide background).
		if ((ox * oy) / (w * h) >= 0.5 && bArea <= 6 * w * h && (b.stroked || b.light < 0.97)) return true;
	}
	for (const c of ink.circles) {
		const ox = Math.min(c[2], r[2]) - Math.max(c[0], r[0]);
		const oy = Math.min(c[3], r[3]) - Math.max(c[1], r[1]);
		if (ox > 0 && oy > 0) return true;
	}
	for (const gl of ink.glyphs) {
		const ox = Math.min(gl.r[2], r[2]) - Math.max(gl.r[0], r[0]);
		const oy = Math.min(gl.r[3], r[3]) - Math.max(gl.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		if (gl.ch === '_' || gl.shape) return true;
	}
	return false;
}
