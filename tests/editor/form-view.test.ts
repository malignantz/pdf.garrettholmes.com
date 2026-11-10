import { describe, expect, it } from 'vitest';
import type { FormField, PageRef, Rotation, StampBox } from '../../src/lib/core/types';
import {
	controlFontPx,
	isEditable,
	noZoomFont,
	overlaps,
	pageWidgets,
	panToReveal,
	redactionEcho,
	rotateBox,
	shownValue
} from '../../src/lib/editor/form-view';

const close = (a: StampBox, b: StampBox) => {
	for (const k of ['x', 'y', 'w', 'h'] as const) expect(a[k]).toBeCloseTo(b[k], 9);
};

/** Turn a point of the unrotated page clockwise, as the page view does. */
function turnPoint(x: number, y: number, r: Rotation): [number, number] {
	switch (r) {
		case 0:
			return [x, y];
		case 90:
			return [1 - y, x];
		case 180:
			return [1 - x, 1 - y];
		case 270:
			return [y, 1 - x];
	}
}

const text = (name: string, widgets: FormField['widgets'], extra: Partial<FormField> = {}): FormField => ({
	name,
	kind: 'text',
	value: '',
	readOnly: false,
	widgets,
	...extra
});

describe('rotateBox', () => {
	const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
	it('is the identity at 0', () => close(rotateBox(b, 0), b));
	for (const r of [90, 180, 270] as const) {
		it(`matches turning every corner by ${r}`, () => {
			const corners = [
				turnPoint(b.x, b.y, r),
				turnPoint(b.x + b.w, b.y, r),
				turnPoint(b.x, b.y + b.h, r),
				turnPoint(b.x + b.w, b.y + b.h, r)
			];
			const xs = corners.map((c) => c[0]);
			const ys = corners.map((c) => c[1]);
			const want = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
			close(rotateBox(b, r), want);
		});
	}
	it('four quarter turns come back', () => {
		let x = b;
		for (let i = 0; i < 4; i++) x = rotateBox(x, 90);
		close(x, b);
	});
});

describe('overlaps', () => {
	it('needs shared area; touching edges do not count', () => {
		const a = { x: 0, y: 0, w: 0.5, h: 0.5 };
		expect(overlaps(a, { x: 0.4, y: 0.4, w: 0.2, h: 0.2 })).toBe(true);
		expect(overlaps(a, { x: 0.5, y: 0, w: 0.2, h: 0.2 })).toBe(false);
		expect(overlaps(a, { x: 0.6, y: 0.6, w: 0.1, h: 0.1 })).toBe(false);
	});
});

describe('pageWidgets', () => {
	it('keeps one page, in reading order, rows by vertical middle', () => {
		const fields: FormField[] = [
			text('below', [{ pageIndex: 0, box: { x: 0.1, y: 0.5, w: 0.2, h: 0.03 } }]),
			text('right', [{ pageIndex: 0, box: { x: 0.5, y: 0.205, w: 0.2, h: 0.03 } }]),
			text('left', [{ pageIndex: 0, box: { x: 0.1, y: 0.2, w: 0.2, h: 0.03 } }]),
			text('other page', [{ pageIndex: 1, box: { x: 0.1, y: 0.1, w: 0.2, h: 0.03 } }]),
			{
				name: 'r',
				kind: 'radio',
				value: '',
				readOnly: false,
				widgets: [
					{ pageIndex: 0, box: { x: 0.3, y: 0.8, w: 0.02, h: 0.02 }, option: 'b' },
					{ pageIndex: 0, box: { x: 0.1, y: 0.8, w: 0.02, h: 0.02 }, option: 'a' }
				]
			}
		];
		const got = pageWidgets(fields, 0);
		expect(got.map((w) => w.field.name + (w.option ?? ''))).toEqual(['left', 'right', 'below', 'ra', 'rb']);
		expect(got.find((w) => w.option === 'a')!.index).toBe(1);
	});

	it('locks read-only fields and multi-select lists', () => {
		const box = { x: 0, y: 0, w: 0.1, h: 0.1 };
		const ro = text('ro', [{ pageIndex: 0, box }], { readOnly: true });
		const list: FormField = { name: 'l', kind: 'choice', value: [], readOnly: false, multiSelect: true, options: [], widgets: [{ pageIndex: 0, box }] };
		const combo: FormField = { ...list, name: 'c', multiSelect: false };
		expect(isEditable(ro)).toBe(false);
		expect(isEditable(list)).toBe(false);
		expect(isEditable(combo)).toBe(true);
		expect(pageWidgets([ro, list, combo], 0).map((w) => w.locked)).toEqual([true, true, false]);
	});
});

describe('font sizing', () => {
	it('single line follows the box, capped at 14 pt', () => {
		expect(controlFontPx(15, 1, false)).toBeCloseTo(10.8, 5);
		expect(controlFontPx(100, 1, false)).toBe(14);
		expect(controlFontPx(100, 2, false)).toBe(28);
	});
	it('multi-line uses 10 pt unless the box is short', () => {
		expect(controlFontPx(200, 1.5, true)).toBe(15);
		expect(controlFontPx(10, 1.5, true)).toBeCloseTo(7.2, 5);
	});
	it('never returns zero', () => expect(controlFontPx(0, 1, false)).toBe(1));
	it('small fonts are laid out at 16 px and scaled down', () => {
		expect(noZoomFont(8)).toEqual({ font: 16, scale: 0.5 });
		expect(noZoomFont(20)).toEqual({ font: 20, scale: 1 });
		expect(noZoomFont(Number.NaN)).toEqual({ font: 16, scale: 1 });
	});
});

describe('panToReveal', () => {
	const base = { width: 500, height: 700 };
	const area = { left: 0, top: 0, right: 400, bottom: 300 };
	it('leaves a visible box alone (same object)', () => {
		const v = { zoom: 1, panX: 0, panY: 0 };
		expect(panToReveal(v, base, { x: 0.1, y: 0.1, w: 0.2, h: 0.05 }, area, 10)).toBe(v);
	});
	it('pans the least to bring a box above the bottom edge (keyboard)', () => {
		const v = { zoom: 1, panX: 0, panY: 0 };
		// Box from y=490 to 525 px; must end at 290.
		const got = panToReveal(v, base, { x: 0.1, y: 0.7, w: 0.2, h: 0.05 }, area, 10);
		expect(got.panX).toBe(0);
		expect(got.panY).toBeCloseTo(-235, 9);
	});
	it('pans right for a box off the left edge, at zoom', () => {
		const v = { zoom: 2, panX: -400, panY: 0 };
		const got = panToReveal(v, base, { x: 0.1, y: 0.05, w: 0.1, h: 0.02 }, area, 10);
		// Box starts at -400 + 100 = -300 px; must start at 10.
		expect(got.panX).toBeCloseTo(-90, 9);
		expect(got.panY).toBe(0);
	});
	it('aligns a box larger than the area to its top-left', () => {
		const v = { zoom: 1, panX: 0, panY: 0 };
		const got = panToReveal(v, base, { x: 0, y: 0.1, w: 1, h: 0.9 }, area, 10);
		expect(got.panX).toBe(10);
		expect(got.panY).toBeCloseTo(10 - 70, 9);
	});
});

describe('shownValue', () => {
	it('prefers the typed answer, even an empty one', () => {
		const f = text('a', [], { value: 'file' });
		expect(shownValue(f, undefined)).toBe('file');
		expect(shownValue(f, { b: 'x' })).toBe('file');
		expect(shownValue(f, { a: '' })).toBe('');
	});
});

describe('redactionEcho', () => {
	const fieldBox = { x: 0.1, y: 0.1, w: 0.3, h: 0.04 };
	const shared = text('shared', [
		{ pageIndex: 0, box: fieldBox },
		{ pageIndex: 1, box: fieldBox }
	]);
	const solo = text('solo', [{ pageIndex: 0, box: { x: 0.1, y: 0.5, w: 0.3, h: 0.04 } }]);
	const page = (id: string, pageIndex: number, stamps: PageRef['stamps'] = [], rotation: Rotation = 0, sourceId = 's'): PageRef => ({
		id,
		sourceId,
		pageIndex,
		rotation,
		stamps
	});
	const redact = (box: StampBox) => ({ id: `r${Math.random()}`, kind: 'redact' as const, box });

	it('names the other page that shows the field', () => {
		const pages = [page('a', 0, [redact({ x: 0.05, y: 0.09, w: 0.5, h: 0.06 })]), page('x', 3, [], 0, 'other'), page('b', 1)];
		expect(redactionEcho(pages, 0, [solo, shared])).toEqual({ field: shared, pageNumber: 3 });
	});

	it('is quiet when the redaction misses, the field is only here, or the other copy is redacted too', () => {
		const away = redact({ x: 0.6, y: 0.8, w: 0.1, h: 0.1 });
		expect(redactionEcho([page('a', 0, [away]), page('b', 1)], 0, [shared])).toBeNull();
		const onSolo = redact({ x: 0.1, y: 0.5, w: 0.3, h: 0.04 });
		expect(redactionEcho([page('a', 0, [onSolo]), page('b', 1)], 0, [shared, solo])).toBeNull();
		const r = redact({ x: 0.05, y: 0.09, w: 0.5, h: 0.06 });
		expect(redactionEcho([page('a', 0, [r]), page('b', 1, [redact({ x: 0, y: 0, w: 1, h: 0.3 })])], 0, [shared])).toBeNull();
		expect(redactionEcho([page('a', 0)], 0, [shared])).toBeNull();
	});

	it('counts a copy of the same page', () => {
		const r = redact({ x: 0.1, y: 0.5, w: 0.3, h: 0.04 });
		expect(redactionEcho([page('b', 1), page('a', 0, [r]), page('a2', 0)], 1, [solo])).toEqual({ field: solo, pageNumber: 3 });
	});

	it('compares in the turned page when the page is rotated', () => {
		// Turned 90: the field box (x .1-.4, y .5-.54) shows at x .46-.5, y .1-.4.
		const turned = redact({ x: 0.45, y: 0.15, w: 0.06, h: 0.1 });
		expect(redactionEcho([page('a', 0, [turned], 90), page('a2', 0)], 0, [solo])).toEqual({ field: solo, pageNumber: 2 });
		const unturnedSpot = redact({ x: 0.1, y: 0.5, w: 0.3, h: 0.04 });
		expect(redactionEcho([page('a', 0, [unturnedSpot], 90), page('a2', 0)], 0, [solo])).toBeNull();
	});
});
