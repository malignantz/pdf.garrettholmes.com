/**
 * Pure helpers for showing form fields on a page: where each widget sits on the
 * page as the user sees it, tab order, font size, keeping a focused field in
 * view, and spotting a redaction that hides a field which also shows elsewhere.
 * No DOM.
 *
 * Widget boxes (FormWidget.box) are fractions of the source page as displayed:
 * the file's own /Rotate applied, PageRef.rotation not. Stamps and the editor
 * work in fractions of the page after PageRef.rotation; `rotateBox` converts.
 */

import type { FormField, FormValue, PageRef, Rotation, StampBox } from '../core/types';
import type { Size, View } from './geometry';
import { scaledSize } from './geometry';

/** A widget box turned clockwise with its page by `rotation` degrees. */
export function rotateBox(b: StampBox, rotation: Rotation): StampBox {
	switch (rotation) {
		case 0:
			return { ...b };
		case 90:
			return { x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w };
		case 180:
			return { x: 1 - (b.x + b.w), y: 1 - (b.y + b.h), w: b.w, h: b.h };
		case 270:
			return { x: b.y, y: 1 - (b.x + b.w), w: b.h, h: b.w };
	}
}

/** True when two boxes share some area (touching edges do not count). */
export function overlaps(a: StampBox, b: StampBox): boolean {
	return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** One widget to draw on a page, with the field it belongs to. */
export interface PlacedWidget {
	field: FormField;
	/** Index into field.widgets. */
	index: number;
	/** Box in source-displayed fractions (before PageRef.rotation). */
	box: StampBox;
	option?: string;
	/** The user cannot change it here: read-only in the form, or a multi-select list. */
	locked: boolean;
}

/** Fields the editor offers a control for. Everything else is shown locked. */
export function isEditable(f: FormField): boolean {
	return !f.readOnly && !(f.kind === 'choice' && f.multiSelect);
}

/**
 * The widgets of one source page in reading order: top to bottom, and left to
 * right within a row (boxes whose vertical middles are within half the shorter
 * box's height of each other share a row).
 */
export function pageWidgets(fields: readonly FormField[], pageIndex: number): PlacedWidget[] {
	const out: PlacedWidget[] = [];
	for (const field of fields) {
		field.widgets.forEach((w, index) => {
			if (w.pageIndex !== pageIndex) return;
			out.push({ field, index, box: w.box, ...(w.option !== undefined ? { option: w.option } : {}), locked: !isEditable(field) });
		});
	}
	return out
		.map((w, i) => ({ w, i }))
		.sort((a, b) => {
			const ay = a.w.box.y + a.w.box.h / 2;
			const by = b.w.box.y + b.w.box.h / 2;
			const tol = Math.min(a.w.box.h, b.w.box.h) / 2;
			if (Math.abs(ay - by) > tol) return ay - by;
			if (a.w.box.x !== b.w.box.x) return a.w.box.x - b.w.box.x;
			return a.i - b.i;
		})
		.map((x) => x.w);
}

/**
 * Font size for a control, in CSS px. `boxHeightPx` is the widget's height on
 * screen (before PageRef rotation), `pxPerPt` the page's screen scale.
 * Single-line text is sized to the box (about 0.72 of its height) but never
 * larger than 14 pt; multi-line text uses 10 pt, smaller if the box is short.
 */
export function controlFontPx(boxHeightPx: number, pxPerPt: number, multiline: boolean): number {
	const h = Math.max(0, boxHeightPx);
	const px = multiline ? Math.min(10 * pxPerPt, h * 0.72) : Math.min(14 * pxPerPt, h * 0.72);
	return Math.max(1, px);
}

/**
 * Phones zoom into any input whose font is under 16 px. A smaller control is laid
 * out at 16 px and scaled down with a transform: returns the font size to set and
 * the scale to apply (1 when the font is already 16 px or more).
 */
export function noZoomFont(px: number, min = 16): { font: number; scale: number } {
	if (!(px > 0)) return { font: min, scale: 1 };
	return px >= min ? { font: px, scale: 1 } : { font: min, scale: px / min };
}

/**
 * Pan the view the least amount so `box` (fractions of the displayed page) is
 * inside the visible area `area` (viewport px: left, top, right, bottom), with
 * `margin` px around it. A box larger than the area is aligned to its top-left.
 */
export function panToReveal(
	view: View,
	base: Size,
	box: StampBox,
	area: { left: number; top: number; right: number; bottom: number },
	margin = 16
): View {
	const s = scaledSize(base, view.zoom);
	const x0 = view.panX + box.x * s.width;
	const y0 = view.panY + box.y * s.height;
	const x1 = x0 + box.w * s.width;
	const y1 = y0 + box.h * s.height;
	const axis = (a0: number, a1: number, lo: number, hi: number) => {
		if (a1 - a0 + 2 * margin > hi - lo) return lo + margin - a0;
		if (a0 < lo + margin) return lo + margin - a0;
		if (a1 > hi - margin) return hi - margin - a1;
		return 0;
	};
	const dx = axis(x0, x1, area.left, area.right);
	const dy = axis(y0, y1, area.top, area.bottom);
	return dx || dy ? { zoom: view.zoom, panX: view.panX + dx, panY: view.panY + dy } : view;
}

/** What a field shows: the typed answer when there is one, else the file's own value. */
export function shownValue(field: FormField, values: Readonly<Record<string, FormValue>> | undefined): FormValue {
	return values && Object.hasOwn(values, field.name) ? values[field.name] : field.value;
}

/**
 * A redaction on `pages[current]` covers a widget of a field that also shows on
 * another page of the plan (another page of the same file, or a copy of this
 * page) where no redaction covers it. Returns the 1-based grid number of the
 * first such page, with the field, or null.
 */
export function redactionEcho(
	pages: readonly PageRef[],
	current: number,
	fields: readonly FormField[]
): { field: FormField; pageNumber: number } | null {
	const here = pages[current];
	if (!here) return null;
	const redactions = (p: PageRef) => p.stamps.flatMap((s) => (s.kind === 'redact' ? [s.box] : []));
	const mine = redactions(here);
	if (!mine.length) return null;
	for (const field of fields) {
		const hidden = field.widgets.some(
			(w) => w.pageIndex === here.pageIndex && mine.some((r) => overlaps(r, rotateBox(w.box, here.rotation)))
		);
		if (!hidden) continue;
		for (let j = 0; j < pages.length; j++) {
			const p = pages[j];
			if (j === current || p.sourceId !== here.sourceId) continue;
			const boxes = redactions(p);
			const shows = field.widgets.some(
				(w) => w.pageIndex === p.pageIndex && !boxes.some((r) => overlaps(r, rotateBox(w.box, p.rotation)))
			);
			if (shows) return { field, pageNumber: j + 1 };
		}
	}
	return null;
}
