import { describe, expect, it } from 'vitest';
import {
	addPoint,
	alphaBounds,
	cropRgba,
	drawStrokes,
	fitWithin,
	paperLevel,
	removeBackground,
	strokePath,
	strokesBounds
} from '../../src/lib/editor/ink';
import { markSvg, stampStyle } from '../../src/lib/editor/stamp-view';

function rgba(w: number, h: number, fill: [number, number, number, number]) {
	const d = new Uint8ClampedArray(w * h * 4);
	for (let i = 0; i < d.length; i += 4) d.set(fill, i);
	return d;
}

describe('pen smoothing', () => {
	it('addPoint drops samples closer than minDist', () => {
		const s: { x: number; y: number }[] = [];
		expect(addPoint(s, { x: 0, y: 0 })).toBe(true);
		expect(addPoint(s, { x: 0.5, y: 0.5 }, 1.5)).toBe(false);
		expect(addPoint(s, { x: 2, y: 0 }, 1.5)).toBe(true);
		expect(s).toHaveLength(2);
	});
	it('a single sample is a dot, two are a line', () => {
		expect(strokePath([{ x: 1, y: 2 }])).toEqual([{ op: 'dot', x: 1, y: 2 }]);
		expect(strokePath([{ x: 0, y: 0 }, { x: 4, y: 4 }]).map((c) => c.op)).toEqual(['M', 'L']);
	});
	it('quadratic curves through midpoints, ending at the last sample', () => {
		const pts = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 }
		];
		const cmds = strokePath(pts);
		expect(cmds[0]).toEqual({ op: 'M', x: 0, y: 0 });
		expect(cmds[1]).toEqual({ op: 'Q', cx: 10, cy: 0, x: 10, y: 5 });
		expect(cmds[2]).toEqual({ op: 'Q', cx: 10, cy: 10, x: 5, y: 10 });
		expect(cmds[3]).toEqual({ op: 'L', x: 0, y: 10 });
	});
	it('drawStrokes scales coordinates', () => {
		const calls: string[] = [];
		const ctx = {
			beginPath: () => calls.push('b'),
			moveTo: (x: number, y: number) => calls.push(`M${x},${y}`),
			lineTo: (x: number, y: number) => calls.push(`L${x},${y}`),
			quadraticCurveTo: (a: number, b: number, x: number, y: number) => calls.push(`Q${a},${b},${x},${y}`),
			arc: (x: number, y: number, r: number) => calls.push(`A${x},${y},${r}`),
			stroke: () => calls.push('s'),
			fill: () => calls.push('f')
		};
		drawStrokes(ctx, [[{ x: 1, y: 1 }], [{ x: 0, y: 0 }, { x: 1, y: 2 }]], 2, 3);
		expect(calls).toEqual(['b', 'A3,3,3', 'f', 'b', 'M0,0', 'L3,6', 's']);
	});
	it('strokesBounds pads by the pen width', () => {
		expect(strokesBounds([[{ x: 10, y: 20 }, { x: 30, y: 25 }]], 2)).toEqual({ x: 8, y: 18, width: 24, height: 9 });
		expect(strokesBounds([], 2)).toBeNull();
	});
});

describe('signature cropping', () => {
	it('alphaBounds finds the visible pixels', () => {
		const w = 10;
		const h = 8;
		const d = rgba(w, h, [0, 0, 0, 0]);
		const set = (x: number, y: number) => (d[(y * w + x) * 4 + 3] = 255);
		set(3, 2);
		set(6, 5);
		expect(alphaBounds(d, w, h)).toEqual({ x: 3, y: 2, width: 4, height: 4 });
		expect(alphaBounds(d, w, h, 8, 1)).toEqual({ x: 2, y: 1, width: 6, height: 6 });
		expect(alphaBounds(d, w, h, 8, 50)).toEqual({ x: 0, y: 0, width: 10, height: 8 });
	});
	it('alphaBounds of an empty image is null', () => {
		expect(alphaBounds(rgba(4, 4, [0, 0, 0, 3]), 4, 4)).toBeNull();
	});
	it('cropRgba copies the rectangle', () => {
		const w = 3;
		const d = new Uint8ClampedArray(3 * 3 * 4).map((_, i) => i);
		const c = cropRgba(d, w, { x: 1, y: 1, width: 2, height: 1 });
		expect([...c]).toEqual([16, 17, 18, 19, 20, 21, 22, 23]);
	});
	it('fitWithin keeps aspect', () => {
		expect(fitWithin(4000, 1000, 1600)).toEqual({ width: 1600, height: 400 });
		expect(fitWithin(100, 50, 1600)).toEqual({ width: 100, height: 50 });
	});
});

describe('paper background removal', () => {
	// A grey-ish photographed page (230) with dark ink (40) and a mid shadow (190).
	function photo() {
		const w = 20;
		const h = 10;
		const d = rgba(w, h, [232, 230, 226, 255]);
		const px = (x: number, y: number, v: number) => d.set([v, v, v, 255], (y * w + x) * 4);
		for (let x = 4; x < 12; x++) px(x, 5, 40);
		px(15, 2, 190);
		return { d, w, h };
	}

	it('estimates the paper level', () => {
		const { d } = photo();
		expect(paperLevel(d)).toBeGreaterThan(220);
	});
	it('paper becomes transparent, ink opaque, recoloured', () => {
		const { d, w } = photo();
		const out = removeBackground(d, { strength: 0.5, ink: [13, 58, 158] });
		const a = (x: number, y: number) => out[(y * w + x) * 4 + 3];
		expect(a(0, 0)).toBe(0);
		expect(a(5, 5)).toBe(255);
		expect([...out.slice((5 * w + 5) * 4, (5 * w + 5) * 4 + 3)]).toEqual([13, 58, 158]);
	});
	it('strength decides whether faint marks stay', () => {
		const { d, w } = photo();
		const weak = removeBackground(d, { strength: 0 });
		const strong = removeBackground(d, { strength: 1 });
		const shadow = (x: Uint8ClampedArray) => x[(2 * w + 15) * 4 + 3];
		expect(shadow(weak)).toBe(0);
		expect(shadow(strong)).toBeGreaterThan(0);
	});
	it('is deterministic', () => {
		const { d } = photo();
		expect(removeBackground(d)).toEqual(removeBackground(d));
	});
	it('keeps transparent input transparent', () => {
		const d = rgba(2, 2, [0, 0, 0, 0]);
		expect([...removeBackground(d)].filter((_, i) => i % 4 === 3)).toEqual([0, 0, 0, 0]);
	});
});

describe('stamp drawing rules', () => {
	it('mark SVG uses the engine points scaled to the box', () => {
		const m = markSvg('check', 20, 10);
		expect(m.viewBox).toBe('0 0 20.00000 10.00000');
		expect(m.d).toBe('M2.80000 5.40000L8.00000 8.00000L17.60000 2.00000');
		expect(m.strokeWidth).toBeCloseTo(1.3);
		const dot = markSvg('dot', 10, 10);
		expect(dot.circle).toEqual({ cx: 5, cy: 5, r: 3 });
	});
	it('stampStyle positions boxes in percent and sizes text by page height', () => {
		expect(stampStyle({ id: 'a', kind: 'mark', mark: 'dot', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 } })).toBe(
			'left:10.0000%;top:20.0000%;width:30.0000%;height:40.0000%'
		);
		expect(stampStyle({ id: 'b', kind: 'text', text: 'x', x: 0.5, y: 0.25, size: 0.02, color: 'black' })).toBe(
			'left:50.0000%;top:25.0000%;font-size:calc(0.020000 * 100cqh);color:rgb(0 0 0)'
		);
	});
});
