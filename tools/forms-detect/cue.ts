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
import { cueAt } from '../../src/lib/engine/forms-cue';
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

/** Something drawn in the page content marks this widget's spot (src/lib/engine/forms-cue.ts). */
export function hasCue(ink: PageInk, t: { type: TruthType; rect: Rect }): boolean {
	return cueAt(ink, t.rect, t.type === 'checkbox' || t.type === 'radio');
}
