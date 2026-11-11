/**
 * Pure maths for the highlighter pen: turning the pointer's raw path into the few
 * points a pen highlight stores, and keeping a stroke's points with its box when
 * the box moves. No DOM.
 *
 * finishStroke works in screen pixels (the page as displayed, same scale on both
 * axes), so tolerances and angles mean what the user sees. The other helpers work
 * in page fractions (core/types.ts StampBox space).
 */

import type { PenStroke, Stamp, StampBox } from '../core/types';
import type { StampPatch } from '../doc/store';

export interface Pt {
	x: number;
	y: number;
}

const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

/** Distance from p to the segment a–b (to a itself when a = b). */
export function segmentDistance(p: Pt, a: Pt, b: Pt): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return dist(p, a);
	const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ramer–Douglas–Peucker: the fewest points whose polyline stays within `tolerance`
 * of the input. Keeps the first and last point. Iterative, so long strokes cannot
 * overflow the stack.
 */
export function simplify(points: readonly Pt[], tolerance: number): Pt[] {
	const n = points.length;
	if (n <= 2) return points.map((p) => ({ x: p.x, y: p.y }));
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	const stack: [number, number][] = [[0, n - 1]];
	while (stack.length) {
		const [lo, hi] = stack.pop()!;
		let worst = -1;
		let at = -1;
		for (let i = lo + 1; i < hi; i++) {
			const d = segmentDistance(points[i], points[lo], points[hi]);
			if (d > worst) {
				worst = d;
				at = i;
			}
		}
		if (at > 0 && worst > tolerance) {
			keep[at] = 1;
			stack.push([lo, at], [at, hi]);
		}
	}
	const out: Pt[] = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push({ x: points[i].x, y: points[i].y });
	return out;
}

/**
 * Largest distance of any point from the segment joining the first and last point.
 * A stroke that doubles back past its ends is far from that segment, so it never
 * counts as straight.
 */
export function maxDeviation(points: readonly Pt[]): number {
	if (points.length < 3) return 0;
	const a = points[0];
	const b = points[points.length - 1];
	let worst = 0;
	for (let i = 1; i < points.length - 1; i++) worst = Math.max(worst, segmentDistance(points[i], a, b));
	return worst;
}

/** Nearly straight: deviation at most `ratio` of the end-to-end length, and at most `maxPx`. */
export function isNearlyStraight(points: readonly Pt[], ratio: number, maxPx: number): boolean {
	if (points.length < 2) return false;
	const len = dist(points[0], points[points.length - 1]);
	if (len === 0) return false;
	return maxDeviation(points) <= Math.min(ratio * len, maxPx);
}

/**
 * A line within `degrees` of horizontal (or vertical) becomes exactly horizontal
 * (vertical), pivoting on its midpoint so it stays where it was drawn.
 */
export function snapToAxis(a: Pt, b: Pt, degrees: number): [Pt, Pt] {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	if (dx === 0 && dy === 0) return [{ ...a }, { ...b }];
	const angle = (Math.atan2(Math.abs(dy), Math.abs(dx)) * 180) / Math.PI;
	if (angle <= degrees) {
		const y = (a.y + b.y) / 2;
		return [
			{ x: a.x, y },
			{ x: b.x, y }
		];
	}
	if (angle >= 90 - degrees) {
		const x = (a.x + b.x) / 2;
		return [
			{ x, y: a.y },
			{ x, y: b.y }
		];
	}
	return [{ ...a }, { ...b }];
}

export interface StrokeOptions {
	/** RDP tolerance, px. */
	tolerance: number;
	/** Straight when the deviation is at most this share of the length… */
	straightRatio: number;
	/** …and at most this many px. */
	straightMaxPx: number;
	/** Lines this close to horizontal or vertical are snapped, degrees. */
	snapDegrees: number;
	/** A stroke that never gets this far (px) from where it started is a tap: nothing is made. */
	minExtentPx: number;
	/** Upper bound on stored points; the tolerance grows until the stroke fits. */
	maxPoints: number;
}

export const STROKE_DEFAULTS: StrokeOptions = {
	tolerance: 1.5,
	straightRatio: 0.06,
	straightMaxPx: 10,
	snapDegrees: 4,
	minExtentPx: 6,
	maxPoints: 120
};

/**
 * The points to store for a drawn stroke (screen px in, screen px out), or null
 * when the pointer barely moved. Nearly straight strokes become a two-point line,
 * snapped to horizontal/vertical when close; others are simplified with RDP.
 */
export function finishStroke(raw: readonly Pt[], opts: Partial<StrokeOptions> = {}): Pt[] | null {
	const o = { ...STROKE_DEFAULTS, ...opts };
	const pts: Pt[] = [];
	for (const p of raw) {
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
		const last = pts[pts.length - 1];
		if (!last || last.x !== p.x || last.y !== p.y) pts.push({ x: p.x, y: p.y });
	}
	if (pts.length < 2) return null;
	const first = pts[0];
	if (Math.max(...pts.map((p) => dist(p, first))) < o.minExtentPx) return null;
	if (isNearlyStraight(pts, o.straightRatio, o.straightMaxPx)) {
		const [a, b] = snapToAxis(first, pts[pts.length - 1], o.snapDegrees);
		return [a, b];
	}
	let tol = o.tolerance;
	let out = simplify(pts, tol);
	while (out.length > o.maxPoints) {
		tol *= 1.5;
		out = simplify(pts, tol);
	}
	return out;
}

// ------------------------------------------------------------------ page fractions

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The box a stroke covers, in page fractions: its points plus half its width each
 * way, kept inside the page. `width` is a fraction of the page height and `aspect`
 * the displayed page's width / height.
 */
export function penBox(points: readonly Pt[], width: number, aspect: number): StampBox {
	const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
	const px = width / 2 / a;
	const py = width / 2;
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const p of points) {
		x0 = Math.min(x0, p.x);
		y0 = Math.min(y0, p.y);
		x1 = Math.max(x1, p.x);
		y1 = Math.max(y1, p.y);
	}
	x0 = clamp01(x0 - px);
	y0 = clamp01(y0 - py);
	x1 = clamp01(x1 + px);
	y1 = clamp01(y1 + py);
	const w = Math.max(x1 - x0, 1e-6);
	const h = Math.max(y1 - y0, 1e-6);
	return { x: Math.min(x0, 1 - w), y: Math.min(y0, 1 - h), w, h };
}

/**
 * The stroke carried along when its box goes from `from` to `to` (moved, or fitted
 * to a page of another shape): points keep their place inside the box, and the
 * width scales with the box height.
 */
export function mapPen(pen: PenStroke, from: StampBox, to: StampBox): PenStroke {
	const sx = from.w > 0 ? to.w / from.w : 1;
	const sy = from.h > 0 ? to.h / from.h : 1;
	const cx = (v: number) => Math.min(to.x + to.w, Math.max(to.x, v));
	const cy = (v: number) => Math.min(to.y + to.h, Math.max(to.y, v));
	return {
		points: pen.points.map((p) => ({ x: cx(to.x + (p.x - from.x) * sx), y: cy(to.y + (p.y - from.y) * sy) })),
		width: pen.width * sy
	};
}

/** Store patch that gives a boxed stamp a new box, moving a pen stroke's points with it. */
export function reboxPatch(s: Exclude<Stamp, { kind: 'text' }>, box: StampBox): StampPatch {
	if (s.kind === 'highlight' && s.pen) return { box, pen: mapPen(s.pen, s.box, box) };
	return { box };
}

/** A two-point horizontal stroke centred on `c`, `len` of the page width long (the keyboard path). */
export function defaultStroke(c: Pt, len: number, width: number, aspect: number): { box: StampBox; pen: PenStroke } {
	const half = Math.min(len, 1) / 2;
	const x = Math.min(1 - half, Math.max(half, c.x));
	const y = clamp01(c.y);
	const points = [
		{ x: x - half, y },
		{ x: x + half, y }
	];
	return { box: penBox(points, width, aspect), pen: { points, width } };
}
