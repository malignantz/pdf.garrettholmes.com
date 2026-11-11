import { describe, expect, it } from 'vitest';
import type { Stamp } from '../../src/lib/core/types';
import {
	defaultStroke,
	finishStroke,
	isNearlyStraight,
	mapPen,
	maxDeviation,
	penBox,
	reboxPatch,
	segmentDistance,
	simplify,
	snapToAxis,
	type Pt
} from '../../src/lib/editor/pen';
import { stampForPage } from '../../src/lib/editor/copy';
import { moveBox } from '../../src/lib/editor/geometry';

/** A pointer path sampled every `step` px along f(t), t in 0..1. */
function sample(n: number, f: (t: number) => Pt): Pt[] {
	return Array.from({ length: n + 1 }, (_, i) => f(i / n));
}

describe('segmentDistance', () => {
	it('measures to the segment, not the infinite line', () => {
		expect(segmentDistance({ x: 5, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(3);
		expect(segmentDistance({ x: 14, y: 3 }, { x: 0, y: 0 }, { x: 10, y: 0 })).toBeCloseTo(5);
		expect(segmentDistance({ x: 3, y: 4 }, { x: 0, y: 0 }, { x: 0, y: 0 })).toBeCloseTo(5);
	});
});

describe('simplify (Ramer–Douglas–Peucker)', () => {
	it('keeps the ends and drops points on a line', () => {
		const line = sample(500, (t) => ({ x: t * 300, y: 40 + t * 100 }));
		expect(simplify(line, 1)).toEqual([line[0], line[500]]);
	});

	it('keeps corners', () => {
		const pts = [...sample(100, (t) => ({ x: t * 100, y: 0 })), ...sample(100, (t) => ({ x: 100, y: t * 100 })).slice(1)];
		const out = simplify(pts, 1);
		expect(out).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 },
			{ x: 100, y: 100 }
		]);
	});

	it('stays within the tolerance of every input point, with far fewer points', () => {
		const wave = sample(2000, (t) => ({ x: t * 600, y: 50 + Math.sin(t * Math.PI * 6) * 20 + Math.sin(t * 97) * 0.4 }));
		const out = simplify(wave, 1.5);
		expect(out.length).toBeLessThan(80);
		expect(out.length).toBeGreaterThan(10);
		for (const p of wave) {
			let best = Infinity;
			for (let i = 1; i < out.length; i++) best = Math.min(best, segmentDistance(p, out[i - 1], out[i]));
			expect(best).toBeLessThanOrEqual(1.5 + 1e-9);
		}
	});

	it('handles tiny inputs', () => {
		expect(simplify([], 1)).toEqual([]);
		expect(simplify([{ x: 1, y: 2 }], 1)).toEqual([{ x: 1, y: 2 }]);
	});
});

describe('straightness', () => {
	it('a gentle wobble along a line is straight; a bend or a doubling back is not', () => {
		const wobble = sample(100, (t) => ({ x: t * 400, y: 100 + Math.sin(t * Math.PI * 10) * 3 }));
		expect(maxDeviation(wobble)).toBeCloseTo(3, 1);
		expect(isNearlyStraight(wobble, 0.06, 10)).toBe(true);

		const arc = sample(100, (t) => ({ x: t * 400, y: 100 + Math.sin(t * Math.PI) * 40 }));
		expect(isNearlyStraight(arc, 0.06, 10)).toBe(false);

		// Right, then back left over the same line: the far end is off the start–end segment.
		const back = [...sample(50, (t) => ({ x: t * 300, y: 0 })), ...sample(50, (t) => ({ x: 300 - t * 250, y: 0 })).slice(1)];
		expect(isNearlyStraight(back, 0.06, 10)).toBe(false);
	});

	it('the allowance is relative to the length, with a cap', () => {
		const short = sample(20, (t) => ({ x: t * 40, y: Math.sin(t * Math.PI) * 4 }));
		expect(isNearlyStraight(short, 0.06, 10)).toBe(false); // 4 px over 40 px: a curve
		const long = sample(200, (t) => ({ x: t * 1000, y: Math.sin(t * Math.PI) * 12 }));
		expect(isNearlyStraight(long, 0.06, 10)).toBe(false); // 12 px is over the 10 px cap
		expect(isNearlyStraight(long, 0.06, 15)).toBe(true);
	});
});

describe('snapToAxis', () => {
	it('snaps within the angle to exactly horizontal or vertical, about the midpoint', () => {
		const deg = (d: number, len = 200): [Pt, Pt] => [
			{ x: 100, y: 100 },
			{ x: 100 + len * Math.cos((d * Math.PI) / 180), y: 100 + len * Math.sin((d * Math.PI) / 180) }
		];
		const [a, b] = snapToAxis(...deg(3), 4);
		expect(a.y).toBe(b.y);
		expect(a.y).toBeCloseTo(100 + (200 * Math.sin((3 * Math.PI) / 180)) / 2, 9);
		expect(a.x).toBe(100);

		const [c, d] = snapToAxis(...deg(-88), 4);
		expect(c.x).toBe(d.x);
		expect(d.y).toBeLessThan(c.y);

		const [e, f] = snapToAxis(...deg(180 - 2), 4);
		expect(e.y).toBe(f.y);
		expect(f.x).toBeLessThan(e.x);

		const diag = deg(20);
		expect(snapToAxis(...diag, 4)).toEqual(diag);
	});
});

describe('finishStroke', () => {
	it('a tap or a slip makes nothing', () => {
		expect(finishStroke([{ x: 10, y: 10 }])).toBeNull();
		expect(finishStroke([{ x: 10, y: 10 }, { x: 10, y: 10 }])).toBeNull();
		expect(finishStroke(sample(5, (t) => ({ x: 10 + t * 3, y: 10 + t * 2 })))).toBeNull();
	});

	it('a nearly straight, nearly level drag becomes an exactly level two-point line', () => {
		const pts = sample(300, (t) => ({ x: 50 + t * 400, y: 200 + t * 14 + Math.sin(t * 40) * 2 }));
		const out = finishStroke(pts)!;
		expect(out).toHaveLength(2);
		expect(out[0].y).toBe(out[1].y);
		expect(out[0].x).toBe(50);
		expect(out[1].x).toBeCloseTo(450, 9);
		expect(out[0].y).toBeCloseTo((pts[0].y + pts[300].y) / 2, 9);
	});

	it('a straight slanted drag stays a slanted two-point line', () => {
		const pts = sample(100, (t) => ({ x: t * 300, y: t * 120 }));
		expect(finishStroke(pts)).toEqual([pts[0], pts[100]]);
	});

	it('a curvy stroke keeps its shape in tens of points, not thousands', () => {
		const pts = sample(3000, (t) => ({ x: 20 + t * 500, y: 200 + Math.sin(t * Math.PI * 8) * 60 }));
		const out = finishStroke(pts)!;
		expect(out.length).toBeGreaterThan(8);
		expect(out.length).toBeLessThan(120);
		expect(out[0]).toEqual(pts[0]);
		expect(out[out.length - 1]).toEqual(pts[3000]);
	});

	it('caps the point count for very busy strokes', () => {
		const pts = sample(5000, (t) => ({ x: t * 800, y: 300 + Math.sin(t * 600) * 40 }));
		expect(finishStroke(pts, { maxPoints: 50 })!.length).toBeLessThanOrEqual(50);
	});

	it('ignores repeated and non-finite samples', () => {
		const out = finishStroke([
			{ x: 0, y: 0 },
			{ x: 0, y: 0 },
			{ x: NaN, y: 3 },
			{ x: 100, y: 0 }
		]);
		expect(out).toEqual([
			{ x: 0, y: 0 },
			{ x: 100, y: 0 }
		]);
	});
});

describe('pen box and moving a stroke', () => {
	it('penBox covers the points plus half the width each way (x in page-width fractions)', () => {
		const b = penBox(
			[
				{ x: 0.2, y: 0.5 },
				{ x: 0.6, y: 0.52 }
			],
			0.02,
			0.5
		);
		expect(b.x).toBeCloseTo(0.2 - 0.02, 9); // 0.01 of the height = 0.02 of the (half as wide) width
		expect(b.w).toBeCloseTo(0.4 + 0.04, 9);
		expect(b.y).toBeCloseTo(0.49, 9);
		expect(b.h).toBeCloseTo(0.04, 9);
	});

	it('penBox stays inside the page', () => {
		const b = penBox(
			[
				{ x: 0, y: 0 },
				{ x: 1, y: 0 }
			],
			0.04,
			1
		);
		expect(b).toEqual({ x: 0, y: 0, w: 1, h: 0.02 });
	});

	it('moving the box moves the points with it, even when the move is clamped at the edge', () => {
		const points = [
			{ x: 0.3, y: 0.4 },
			{ x: 0.5, y: 0.45 },
			{ x: 0.6, y: 0.4 }
		];
		const s: Stamp = { id: 'h', kind: 'highlight', color: 'yellow', box: penBox(points, 0.02, 0.77), pen: { points, width: 0.02 } };
		const moved = moveBox(s.box, 0.9, 0.1);
		const patch = reboxPatch(s, moved);
		expect(patch.box).toEqual(moved);
		const dx = moved.x - s.box.x;
		expect(dx).toBeLessThan(0.9);
		patch.pen!.points.forEach((p, i) => {
			expect(p.x).toBeCloseTo(points[i].x + dx, 9);
			expect(p.y).toBeCloseTo(points[i].y + 0.1, 9);
			expect(p.x).toBeLessThanOrEqual(1);
		});
		expect(patch.pen!.width).toBeCloseTo(0.02, 12);
		// A box highlight gets only a box.
		expect(reboxPatch({ id: 'b', kind: 'highlight', color: 'pink', box: s.box }, moved)).toEqual({ box: moved });
	});

	it('copying to a page of another shape keeps the stroke inside its box', () => {
		const points = [
			{ x: 0.2, y: 0.3 },
			{ x: 0.7, y: 0.34 }
		];
		const s: Stamp = { id: 'h', kind: 'highlight', color: 'green', box: penBox(points, 0.018, 0.77), pen: { points, width: 0.018 } };
		const out = stampForPage(s, 0.77, 1.29) as Extract<Stamp, { kind: 'highlight' }>;
		expect(out.pen).toBeDefined();
		for (const p of out.pen!.points) {
			expect(p.x).toBeGreaterThanOrEqual(out.box.x - 1e-9);
			expect(p.x).toBeLessThanOrEqual(out.box.x + out.box.w + 1e-9);
			expect(p.y).toBeGreaterThanOrEqual(out.box.y - 1e-9);
			expect(p.y).toBeLessThanOrEqual(out.box.y + out.box.h + 1e-9);
		}
		// Same on-screen thickness relative to the page width.
		expect(out.pen!.width / 1.29).toBeCloseTo(0.018 / 0.77, 6);
	});

	it('mapPen is the identity for the same box', () => {
		const pen = { points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.25 }], width: 0.01 };
		const box = penBox(pen.points, pen.width, 1);
		expect(mapPen(pen, box, box)).toEqual(pen);
	});

	it('defaultStroke is a level line centred on the point, kept on the page', () => {
		const st = defaultStroke({ x: 0.5, y: 0.5 }, 0.3, 0.018, 0.77);
		expect(st.pen.points).toEqual([
			{ x: 0.35, y: 0.5 },
			{ x: 0.65, y: 0.5 }
		]);
		expect(st.box.x + st.box.w / 2).toBeCloseTo(0.5, 9);
		expect(st.box.y + st.box.h / 2).toBeCloseTo(0.5, 9);
		const edge = defaultStroke({ x: 0.95, y: 0.5 }, 0.3, 0.018, 0.77);
		expect(edge.pen.points[1].x).toBeCloseTo(1, 9);
	});
});
