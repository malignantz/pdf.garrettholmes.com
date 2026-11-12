/**
 * Pure maths for the text highlighter: the page's words (Engine.pageText) as they are
 * shown, hit-testing a pointer against them, and the rectangles of a selection.
 * No DOM. Everything is in stamp space (core/types.ts StampBox: fractions of the page
 * as shown, after PageRef.rotation, origin top-left). Distances are in page heights,
 * with x scaled by the shown page's aspect (width / height) so both axes agree.
 */

import type { PageText, Rotation, StampBox } from '../core/types';
import { rotateBox } from './form-view';

export interface ShownWord {
	text: string;
	box: StampBox;
	line: number;
}

export interface ShownLine {
	box: StampBox;
	/** Index of the line's first and last word in `words`. */
	first: number;
	last: number;
	/** The line runs across the shown page (else up or down it). */
	across: boolean;
}

export interface TextLayout {
	words: ShownWord[];
	lines: ShownLine[];
	aspect: number;
}

export interface Pt {
	x: number;
	y: number;
}

function union(a: StampBox, b: StampBox): StampBox {
	const x0 = Math.min(a.x, b.x);
	const y0 = Math.min(a.y, b.y);
	const x1 = Math.max(a.x + a.w, b.x + b.w);
	const y1 = Math.max(a.y + a.h, b.y + b.h);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** The page's words turned with the page (`rotation` is PageRef.rotation), grouped in lines. */
export function shownLayout(text: PageText, rotation: Rotation, aspect: number): TextLayout {
	const words = text.words.map((w) => ({ text: w.text, line: w.line, box: rotateBox(w.box, rotation) }));
	const lines: ShownLine[] = [];
	words.forEach((w, i) => {
		const cur = lines[lines.length - 1];
		if (cur && words[cur.first].line === w.line) {
			cur.box = union(cur.box, w.box);
			cur.last = i;
		} else lines.push({ box: { ...w.box }, first: i, last: i, across: true });
	});
	for (const l of lines) {
		if (l.last === l.first) {
			// One word: its long side.
			const b = words[l.first].box;
			l.across = b.w * aspect >= b.h;
			continue;
		}
		const a = words[l.first].box;
		const z = words[l.last].box;
		const dx = Math.abs(z.x + z.w / 2 - (a.x + a.w / 2)) * aspect;
		const dy = Math.abs(z.y + z.h / 2 - (a.y + a.h / 2));
		l.across = dx >= dy;
	}
	return { words, lines, aspect };
}

/** Distance from p to a box (0 inside), in page heights. */
export function boxDistance(b: StampBox, p: Pt, aspect: number): number {
	const dx = Math.max(b.x - p.x, 0, p.x - (b.x + b.w)) * aspect;
	const dy = Math.max(b.y - p.y, 0, p.y - (b.y + b.h));
	return Math.hypot(dx, dy);
}

/** Size of a line across its writing direction (its height when it runs across the page), in page heights. */
export function crossSize(l: ShownLine, aspect: number): number {
	return l.across ? l.box.h : l.box.w * aspect;
}

/** The word under or nearest to p within `maxDist` (page heights), or -1. */
export function wordNear(layout: TextLayout, p: Pt, maxDist: number): number {
	let best = -1;
	let bestD = Infinity;
	layout.words.forEach((w, i) => {
		const d = boxDistance(w.box, p, layout.aspect);
		if (d < bestD) {
			bestD = d;
			best = i;
		}
	});
	return bestD <= maxDist ? best : -1;
}

/**
 * Where a drag that is now at p ends: the nearest line level with p (whose height
 * spans p, as when the pointer runs past the end of a line), else the nearest line;
 * then the nearest word of that line. Always a word when the page has any.
 */
export function wordAtEnd(layout: TextLayout, p: Pt): number {
	const { lines, words, aspect } = layout;
	if (!lines.length) return -1;
	let li = 0;
	let ld = Infinity;
	let level = false;
	lines.forEach((l, i) => {
		const b = l.box;
		const isLevel = l.across ? p.y >= b.y && p.y <= b.y + b.h : p.x >= b.x && p.x <= b.x + b.w;
		const d = boxDistance(b, p, aspect);
		if ((isLevel && !level) || (isLevel === level && d < ld)) {
			ld = d;
			li = i;
			level = isLevel;
		}
	});
	const l = lines[li];
	let best = l.first;
	let bd = Infinity;
	for (let i = l.first; i <= l.last; i++) {
		const d = boxDistance(words[i].box, p, aspect);
		if (d < bd) {
			bd = d;
			best = i;
		}
	}
	return best;
}

/** Merged boxes may be this much taller (across the line) than the tallest part. */
const MERGE_SLACK = 1.15;

/**
 * Rectangles covering words a..b (either order) in reading order: one per line, the
 * line's words merged, plus extra pieces where a slightly tilted line would otherwise
 * grow too tall. Lines that sit side by side on one band (a line the file splits in
 * two) are merged too.
 */
export function selectionRects(layout: TextLayout, a: number, b: number): StampBox[] {
	const { words, lines, aspect } = layout;
	if (a < 0 || b < 0 || !words.length) return [];
	const i0 = Math.min(a, b);
	const i1 = Math.min(Math.max(a, b), words.length - 1);
	const lineOf = new Map<number, ShownLine>();
	for (const l of lines) lineOf.set(words[l.first].line, l);
	const cross = (box: StampBox, across: boolean) => (across ? box.h : box.w * aspect);
	/**
	 * A merged box must not cover a word that is not selected (right-to-left text whose
	 * last full stop sits at the far end, a letter the file draws separately): the
	 * rectangle then ends before it.
	 */
	const coversOther = (u: StampBox, lines: number[]) => {
		for (const ln of lines) {
			const l = lineOf.get(ln);
			if (!l) continue;
			for (let k = l.first; k <= l.last; k++) {
				if (k >= i0 && k <= i1) continue;
				const b = words[k].box;
				const cx = b.x + b.w / 2;
				const cy = b.y + b.h / 2;
				if (cx > u.x && cx < u.x + u.w && cy > u.y && cy < u.y + u.h) return true;
			}
		}
		return false;
	};
	const out: { box: StampBox; line: number; across: boolean }[] = [];
	for (let i = i0; i <= i1; i++) {
		const w = words[i];
		const across = lineOf.get(w.line)?.across ?? true;
		const last = out[out.length - 1];
		if (last && last.line === w.line) {
			const u = union(last.box, w.box);
			if (cross(u, across) <= MERGE_SLACK * Math.max(cross(last.box, across), cross(w.box, across)) && !coversOther(u, [w.line])) {
				last.box = u;
				continue;
			}
		}
		out.push({ box: { ...w.box }, line: w.line, across });
	}
	// Pieces of different lines on one band, next to each other.
	const merged: StampBox[] = [];
	let prev: (typeof out)[number] | null = null;
	for (const r of out) {
		if (prev && prev.line !== r.line && prev.across === r.across && sameBand(prev.box, r.box, r.across, aspect) && !coversOther(union(prev.box, r.box), [prev.line, r.line])) {
			prev.box = union(prev.box, r.box);
			merged[merged.length - 1] = prev.box;
			continue;
		}
		merged.push(r.box);
		prev = r;
	}
	return merged.map(clampBox01);
}

function sameBand(a: StampBox, b: StampBox, across: boolean, aspect: number): boolean {
	const [a0, a1, b0, b1, along0, along1, balong0, balong1] = across
		? [a.y, a.y + a.h, b.y, b.y + b.h, a.x * aspect, (a.x + a.w) * aspect, b.x * aspect, (b.x + b.w) * aspect]
		: [a.x * aspect, (a.x + a.w) * aspect, b.x * aspect, (b.x + b.w) * aspect, a.y, a.y + a.h, b.y, b.y + b.h];
	const size = Math.max(a1 - a0, b1 - b0);
	if (Math.abs(a0 - b0) > 0.15 * size || Math.abs(a1 - b1) > 0.15 * size) return false;
	const gap = Math.max(balong0 - along1, along0 - balong1);
	return gap <= 1.5 * size;
}

function clampBox01(b: StampBox): StampBox {
	const x0 = Math.min(1, Math.max(0, b.x));
	const y0 = Math.min(1, Math.max(0, b.y));
	const x1 = Math.min(1, Math.max(0, b.x + b.w));
	const y1 = Math.min(1, Math.max(0, b.y + b.h));
	return { x: x0, y: y0, w: Math.max(x1 - x0, 1e-6), h: Math.max(y1 - y0, 1e-6) };
}

/** Bounds of a list of rectangles. */
export function boundsOf(rects: readonly StampBox[]): StampBox {
	let b = { ...rects[0] };
	for (const r of rects.slice(1)) b = union(b, r);
	return clampBox01(b);
}

/** The text of words a..b, for announcements. */
export function selectionText(layout: TextLayout, a: number, b: number): string {
	const i0 = Math.min(a, b);
	const i1 = Math.max(a, b);
	return layout.words
		.slice(i0, i1 + 1)
		.map((w) => w.text)
		.join(' ');
}

/**
 * The rectangles carried along when their box goes from `from` to `to` (moved, or
 * fitted to a page of another shape): each keeps its place inside the box.
 */
export function mapRects(rects: readonly StampBox[], from: StampBox, to: StampBox): StampBox[] {
	const sx = from.w > 0 ? to.w / from.w : 1;
	const sy = from.h > 0 ? to.h / from.h : 1;
	return rects.map((r) => {
		const x = to.x + (r.x - from.x) * sx;
		const y = to.y + (r.y - from.y) * sy;
		const w = r.w * sx;
		const h = r.h * sy;
		// Kept inside the new box (rounding).
		const x0 = Math.max(to.x, Math.min(x, to.x + to.w));
		const y0 = Math.max(to.y, Math.min(y, to.y + to.h));
		return { x: x0, y: y0, w: Math.max(1e-6, Math.min(x + w, to.x + to.w) - x0), h: Math.max(1e-6, Math.min(y + h, to.y + to.h) - y0) };
	});
}
