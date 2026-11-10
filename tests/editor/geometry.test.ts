import { describe, expect, it } from 'vitest';
import {
	adaptBox,
	boxAround,
	centeredView,
	clampBox,
	clampPan,
	fitSize,
	fractionToScreen,
	imageBoxSize,
	moveBox,
	pinchView,
	resizeBox,
	screenToFraction,
	squareBoxSize,
	zoomAt,
	MAX_ZOOM,
	type View
} from '../../src/lib/editor/geometry';
import { copyTargets, stampForPage } from '../../src/lib/editor/copy';

const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('fitSize', () => {
	it('fits a portrait page by height in a wide viewport', () => {
		const s = fitSize({ width: 1000, height: 600 }, 0.5, 0);
		expect(s).toEqual({ width: 300, height: 600 });
	});
	it('fits a landscape page by width in a tall viewport', () => {
		const s = fitSize({ width: 400, height: 800 }, 2, 20);
		expect(s).toEqual({ width: 360, height: 180 });
	});
});

describe('screen <-> page fractions', () => {
	const base = { width: 400, height: 500 };
	const views: View[] = [
		{ zoom: 1, panX: 10, panY: 20 },
		{ zoom: 2.5, panX: -300, panY: -140 },
		{ zoom: 6, panX: -1234.5, panY: 77 }
	];
	it('round-trips at any zoom and pan', () => {
		for (const v of views)
			for (const f of [
				{ x: 0, y: 0 },
				{ x: 1, y: 1 },
				{ x: 0.3, y: 0.71 }
			]) {
				const s = fractionToScreen(f, v, base);
				const back = screenToFraction(s, v, base);
				close(back.x, f.x);
				close(back.y, f.y);
			}
	});
	it('maps the page corners', () => {
		const v = { zoom: 2, panX: 50, panY: -100 };
		expect(screenToFraction({ x: 50, y: -100 }, v, base)).toEqual({ x: 0, y: 0 });
		expect(screenToFraction({ x: 850, y: 900 }, v, base)).toEqual({ x: 1, y: 1 });
	});
	it('zoomAt keeps the point under the cursor fixed', () => {
		const v = { zoom: 1.3, panX: 12, panY: 34 };
		const anchor = { x: 222, y: 111 };
		const before = screenToFraction(anchor, v, base);
		const z = zoomAt(v, base, 3.7, anchor);
		expect(z.zoom).toBe(3.7);
		const after = screenToFraction(anchor, z, base);
		close(after.x, before.x);
		close(after.y, before.y);
	});
	it('zoomAt clamps zoom', () => {
		expect(zoomAt({ zoom: 1, panX: 0, panY: 0 }, base, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
		expect(zoomAt({ zoom: 2, panX: 0, panY: 0 }, base, 0.1, { x: 0, y: 0 }).zoom).toBe(1);
	});
	it('pinch: the page point under the first midpoint follows the fingers', () => {
		const start = { zoom: 1, panX: 0, panY: 0 };
		const m0 = { x: 200, y: 250 };
		const m1 = { x: 260, y: 230 };
		const v = pinchView(start, base, m0, 100, m1, 250);
		close(v.zoom, 2.5);
		const f0 = screenToFraction(m0, start, base);
		const f1 = screenToFraction(m1, v, base);
		close(f1.x, f0.x);
		close(f1.y, f0.y);
	});
});

describe('clampPan', () => {
	const port = { width: 800, height: 600 };
	const base = { width: 400, height: 560 };
	it('centres a page smaller than the viewport', () => {
		const v = clampPan({ zoom: 1, panX: -999, panY: 999 }, port, base, 16);
		expect(v).toEqual(centeredView(port, base, 1));
	});
	it('limits the gap at the edges when zoomed in', () => {
		const v = clampPan({ zoom: 3, panX: 500, panY: -5000 }, port, base, 16);
		expect(v.panX).toBe(16);
		expect(v.panY).toBe(600 - 560 * 3 - 16);
	});
});

describe('stamp boxes', () => {
	it('clampBox keeps a box inside the page', () => {
		expect(clampBox({ x: -0.1, y: 0.95, w: 0.2, h: 0.1 })).toEqual({ x: 0, y: 0.9, w: 0.2, h: 0.1 });
		const big = clampBox({ x: 0.5, y: 0.5, w: 2, h: 1 });
		expect(big).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
	});
	it('boxAround centres on the point and clamps at edges', () => {
		const b = boxAround({ x: 0.5, y: 0.5 }, 0.2, 0.1);
		close(b.x, 0.4);
		close(b.y, 0.45);
		expect(boxAround({ x: 0.99, y: 0.01 }, 0.2, 0.1)).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.1 });
	});
	it('moveBox clamps', () => {
		expect(moveBox({ x: 0.5, y: 0.5, w: 0.2, h: 0.2 }, 1, -1)).toEqual({ x: 0.8, y: 0, w: 0.2, h: 0.2 });
	});

	it('aspect-locked resize from the SE corner keeps the NW corner and the shape', () => {
		const start = { x: 0.2, y: 0.3, w: 0.2, h: 0.1 };
		const r = resizeBox(start, 'se', { x: 0.6, y: 0.35 });
		close(r.x, 0.2);
		close(r.y, 0.3);
		close(r.w / r.h, 2);
		close(r.w, 0.4); // larger scale (x: 2x) wins
	});
	it('aspect-locked resize from the NW corner keeps the SE corner', () => {
		const start = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 };
		const r = resizeBox(start, 'nw', { x: 0.5, y: 0.5 });
		close(r.x + r.w, 0.6);
		close(r.y + r.h, 0.6);
		close(r.w, 0.1);
		close(r.h, 0.1);
	});
	it('resize never leaves the page and keeps the aspect at the edge', () => {
		const start = { x: 0.7, y: 0.1, w: 0.2, h: 0.1 };
		const r = resizeBox(start, 'se', { x: 5, y: 5 });
		close(r.x + r.w, 1);
		close(r.w / r.h, 2);
		expect(r.y + r.h).toBeLessThanOrEqual(1);
	});
	it('resize has a minimum size', () => {
		const r = resizeBox({ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, 'se', { x: 0.4, y: 0.4 }, true, 0.01);
		close(r.w, 0.01);
		close(r.h, 0.01);
	});
	it('free resize (no lock) follows both axes', () => {
		const r = resizeBox({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, 'ne', { x: 0.5, y: 0 }, false);
		expect(r).toEqual({ x: 0.1, y: 0, w: 0.4, h: 0.2 });
	});

	it('imageBoxSize keeps the image aspect on screen', () => {
		const pageAspect = 612 / 792;
		const s = imageBoxSize(300, 100, pageAspect, 0.25);
		close(s.width, 0.25);
		// on-screen ratio: (w * W) / (h * H) = 3
		close((s.width * pageAspect) / s.height, 3);
	});
	it('squareBoxSize is square on screen', () => {
		for (const a of [0.5, 1, 1.6]) {
			const s = squareBoxSize(a, 0.03);
			close((s.width * a) / s.height, 1);
		}
	});
	it('adaptBox keeps the on-screen shape on a page of another aspect', () => {
		const b = { x: 0.1, y: 0.1, w: 0.3, h: 0.05 };
		const from = 612 / 792;
		const to = 792 / 612;
		const n = adaptBox(b, from, to);
		close((n.w * to) / n.h, (b.w * from) / b.h);
		close(n.x, 0.1);
	});
});

describe('copy to pages', () => {
	it('all pages except the current one', () => {
		expect(copyTargets(5, 2, 'all', 0, 0)).toEqual([0, 1, 3, 4]);
	});
	it('a range, in either order, clamped, without the current page', () => {
		expect(copyTargets(10, 3, 'range', 2, 5)).toEqual([1, 2, 4]);
		expect(copyTargets(10, 3, 'range', 5, 2)).toEqual([1, 2, 4]);
		expect(copyTargets(4, 0, 'range', -3, 99)).toEqual([1, 2, 3]);
		expect(copyTargets(4, 0, 'range', NaN, 2)).toEqual([]);
	});
	it('stampForPage drops the id and adapts boxes', () => {
		const s = stampForPage({ id: 'x', kind: 'mark', mark: 'check', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } }, 1, 2);
		expect('id' in s).toBe(false);
		expect(s.kind === 'mark' && s.box.h).toBeCloseTo(0.2);
		const t = stampForPage({ id: 'y', kind: 'text', text: 'Hi', x: 0.2, y: 0.3, size: 0.02, color: 'red' }, 1, 2);
		expect(t).toEqual({ kind: 'text', text: 'Hi', x: 0.2, y: 0.3, size: 0.02, color: 'red' });
	});
});
