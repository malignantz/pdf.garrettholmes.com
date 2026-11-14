/**
 * Crop in the document (PageRef.crop, 2026-11-14). Pure; no store.
 *
 * A crop is the visible part of a page, as fractions of the page as displayed (after
 * PageRef.rotation) before any crop. Stamps are fractions of the visible part, so a
 * new crop moves every mark to the new frame: x' = (crop0.x + x·crop0.w − crop1.x) / crop1.w
 * (and the same for y); lengths scale by crop0.w / crop1.w; sizes given as a share of
 * the page height (text size, pen width) by crop0.h / crop1.h. A crop that would leave a
 * mark (or part of it) outside the visible part is not applied to that page: crop never
 * hides a mark the person placed. Rotation turns the crop like a box (doc/turn.ts).
 */
import type { PageSize, Rotation, Stamp, StampBox } from '../core/types';
import { STAMP_FONT } from '../engine/geometry';

/** Smallest side the store accepts, as a fraction of the page side (as engine/crop.ts CROP_MIN). */
export const CROP_MIN = 0.05;
/** The whole page. */
export const FULL: StampBox = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** A crop the store accepts: finite, inside the page, each side at least CROP_MIN. */
export function isValidCrop(c: unknown): c is StampBox {
	const b = c as Partial<StampBox> | null;
	const eps = 1e-6;
	return (
		!!b &&
		typeof b === 'object' &&
		fin(b.x) &&
		fin(b.y) &&
		fin(b.w) &&
		fin(b.h) &&
		b.x >= -eps &&
		b.y >= -eps &&
		b.x + b.w <= 1 + eps &&
		b.y + b.h <= 1 + eps &&
		b.w >= CROP_MIN - eps &&
		b.h >= CROP_MIN - eps
	);
}

/** True when the crop shows the whole page (no crop is needed). */
export function isFull(c: StampBox | undefined): boolean {
	return !c || (Math.abs(c.x) < 1e-6 && Math.abs(c.y) < 1e-6 && Math.abs(c.w - 1) < 1e-6 && Math.abs(c.h - 1) < 1e-6);
}

/** Size of the page as shown: the source page size, turned by `rotation`, then cropped. */
export function shownSize(size: PageSize, rotation: Rotation, crop?: StampBox): PageSize {
	const odd = rotation === 90 || rotation === 270;
	const w = odd ? size.height : size.width;
	const h = odd ? size.width : size.height;
	return crop ? { width: w * crop.w, height: h * crop.h } : { width: w, height: h };
}

/** The uncropped page as shown (after rotation). */
export function fullSize(size: PageSize, rotation: Rotation): PageSize {
	return shownSize(size, rotation);
}

/** A box from the frame `from` into the frame `to` (both fractions of the uncropped page; absent = whole page). */
export function reframeBox(b: StampBox, from: StampBox | undefined, to: StampBox | undefined): StampBox {
	const f = from ?? FULL;
	const t = to ?? FULL;
	return { x: (f.x + b.x * f.w - t.x) / t.w, y: (f.y + b.y * f.h - t.y) / t.h, w: (b.w * f.w) / t.w, h: (b.h * f.h) / t.h };
}

/** A point from frame `from` into frame `to`. */
export function reframePoint(p: { x: number; y: number }, from: StampBox | undefined, to: StampBox | undefined): { x: number; y: number } {
	const f = from ?? FULL;
	const t = to ?? FULL;
	return { x: (f.x + p.x * f.w - t.x) / t.w, y: (f.y + p.y * f.h - t.y) / t.h };
}

const inside = (b: StampBox, tol = 1e-6) => b.x >= -tol && b.y >= -tol && b.x + b.w <= 1 + tol && b.y + b.h <= 1 + tol;

/** Average advance of the stamp font, in em: for estimating how far a text stamp reaches. */
const EM_PER_CHAR = 0.5;

/**
 * About where a text stamp's block lies, in its page's fractions (`aspect` = shown width /
 * height). An estimate (no font metrics here): used only to refuse a crop that would cut it.
 */
export function textExtent(s: Extract<Stamp, { kind: 'text' }>, aspect: number): StampBox {
	const lines = s.text.replace(/\r\n?/g, '\n').split('\n');
	const longest = Math.max(1, ...lines.map((l) => [...l].length));
	// Width as a share of the page width; height as a share of the page height.
	const wAlong = longest * EM_PER_CHAR * s.size / aspect;
	const hAcross = lines.length * STAMP_FONT.lineHeight * s.size;
	// Turned blocks swap their sides on the page (a share of height becomes one of width).
	switch (s.turn) {
		case 90:
			return { x: s.x - hAcross / aspect, y: s.y, w: hAcross / aspect, h: wAlong * aspect };
		case 180:
			return { x: s.x - wAlong, y: s.y - hAcross, w: wAlong, h: hAcross };
		case 270:
			return { x: s.x, y: s.y - wAlong * aspect, w: hAcross / aspect, h: wAlong * aspect };
		default:
			return { x: s.x, y: s.y, w: wAlong, h: hAcross };
	}
}

/**
 * One stamp moved from the frame `from` to the frame `to` (see the module comment), or
 * null when it would not lie wholly inside the new visible part. `fullAspect` is the
 * uncropped page's shown width / height (for the text estimate). A link to a blank that
 * would leave the page is dropped (the stamp stays).
 */
export function reframeStamp(s: Stamp, from: StampBox | undefined, to: StampBox | undefined, fullAspect: number): Stamp | null {
	const f = from ?? FULL;
	const t = to ?? FULL;
	const sy = f.h / t.h;
	const box = (b: StampBox) => reframeBox(b, f, t);
	const blank = <T extends Stamp>(st: T, b: { kind: 'text' | 'check'; box: StampBox } | undefined): T => {
		if (!b) return st;
		const nb = box(b.box);
		if (inside(nb)) return { ...st, blank: { kind: b.kind, box: nb } };
		const { blank: _drop, ...rest } = st as T & { blank?: unknown };
		return rest as T;
	};
	switch (s.kind) {
		case 'text': {
			const p = reframePoint({ x: s.x, y: s.y }, f, t);
			const next = blank({ ...s, x: p.x, y: p.y, size: s.size * sy }, s.blank);
			const aspect = (fullAspect * t.w) / t.h;
			if (!inside({ x: p.x, y: p.y, w: 0, h: 0 }) || !inside(textExtent(next, aspect), 0.01)) return null;
			return next;
		}
		case 'highlight': {
			const h: Stamp = { ...s, box: box(s.box) };
			if (s.pen) h.pen = { width: s.pen.width * sy, points: s.pen.points.map((q) => reframePoint(q, f, t)) };
			if (s.rects) h.rects = s.rects.map(box);
			return inside(h.box) ? h : null;
		}
		case 'mark': {
			const m = blank({ ...s, box: box(s.box) }, s.blank);
			return inside(m.box) ? m : null;
		}
		case 'image':
		case 'redact': {
			const b = box(s.box);
			return inside(b) ? { ...s, box: b } : null;
		}
	}
}

/** Clamp a box to the page, keeping it at least `min` (fractions) each way. */
export function clampCrop(c: StampBox, minW = CROP_MIN, minH = CROP_MIN): StampBox {
	const w = Math.min(1, Math.max(minW, c.w));
	const h = Math.min(1, Math.max(minH, c.h));
	const x = Math.min(1 - w, Math.max(0, c.x));
	const y = Math.min(1 - h, Math.max(0, c.y));
	return { x, y, w, h };
}
