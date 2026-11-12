/**
 * Tap to snap on flat forms (forms-snap.ts), a measured prototype not wired into the
 * app. Corpus: tests/corpus/generate-forms-snap.mjs (positions are top-down points).
 * Real-world numbers: tools/forms-snap/ and the plan's "Stretch" section.
 */
import { describe, expect, it } from 'vitest';
import type * as MU from 'mupdf';
import { collectInk, type Rect } from '../../src/lib/engine/forms-detect';
import { prepareSnap, similarTo, snapAt, type SnapPage, type SnapResult } from '../../src/lib/engine/forms-snap';
import { corpus } from './helpers';

const T = 60_000;

let cached: SnapPage | null = null;
async function page(): Promise<SnapPage> {
	if (cached) return cached;
	const m = (await import('mupdf')) as unknown as typeof MU;
	const doc = m.Document.openDocument(corpus('forms-snap.pdf'), 'application/pdf');
	cached = prepareSnap(collectInk(m as never, doc.loadPage(0)));
	return cached;
}

const near = (a: Rect, b: Rect, tol = 2) => a.every((v, i) => Math.abs(v - b[i]) <= tol);

function expectSnap(s: SnapResult | null, rule: string, rect: Rect, kind: 'text' | 'check' = 'text') {
	expect(s, `${rule} at ${rect}`).not.toBeNull();
	expect(s!.rule).toBe(rule);
	expect(s!.kind).toBe(kind);
	expect(near(s!.rect, rect), `${s!.rect} ≈ ${rect}`).toBe(true);
}

describe('snapAt on a generated flat form', () => {
	it('picks the line the tap is over, of two on one row and of two stacked', async () => {
		const p = await page();
		expectSnap(snapAt(p, [150, 95]), 'rule', [130, 82, 290, 102]);
		expect(snapAt(p, [150, 95])!.label).toBe('First name');
		expectSnap(snapAt(p, [400, 97]), 'rule', [352, 82, 540, 102]);
		expect(snapAt(p, [400, 97])!.label).toBe('Last name');
		expectSnap(snapAt(p, [200, 128]), 'rule', [115, 112, 540, 132]);
		expectSnap(snapAt(p, [200, 147]), 'rule', [115, 133, 540, 152]);
	}, T);

	it('fills the empty table cell that was tapped', async () => {
		const p = await page();
		expectSnap(snapAt(p, [150, 205]), 'cell', [73, 197, 219, 213.5]);
		expectSnap(snapAt(p, [150, 222]), 'cell', [73, 215, 219, 231.5]);
		expectSnap(snapAt(p, [300, 223]), 'cell', [221, 215, 359, 231.5]);
	}, T);

	it('snaps to a square on it or just beside it, less sure between two close squares', async () => {
		const p = await page();
		expectSnap(snapAt(p, [134, 263]), 'square', [130, 259, 139, 268], 'check');
		expectSnap(snapAt(p, [141, 263]), 'square', [130, 259, 139, 268], 'check');
		expectSnap(snapAt(p, [184, 270]), 'square', [180, 259, 189, 268], 'check');
		const sure = snapAt(p, [304, 268])!;
		expectSnap(sure, 'square', [300, 263, 309, 272], 'check');
		const between = snapAt(p, [304, 261])!;
		expect(between.confidence).toBeLessThan(sure.confidence - 0.2);
	}, T);

	it('treats comb boxes as one field and finds underscores and a box under a corner label', async () => {
		const p = await page();
		expectSnap(snapAt(p, [125, 315]), 'comb', [110, 309, 192, 321]);
		expectSnap(snapAt(p, [380, 315]), 'underscore', [334.5, 305.2, 445.7, 321.2]);
		expectSnap(snapAt(p, [120, 360]), 'cell-band', [73, 350.4, 299, 371.5]);
	}, T);

	it('does not snap on a paragraph, in the margin, or on the words of a filled table', async () => {
		const p = await page();
		for (const t of [
			[150, 418],
			[200, 432],
			[400, 432],
			[30, 600],
			[560, 700],
			[85, 482],
			[232, 497]
		] as [number, number][])
			expect(snapAt(p, t), `tap ${t}`).toBeNull();
		// Beside a number in a data cell there is free space that looks like a blank: snapped, but unsure.
		expect(snapAt(p, [300, 497])!.confidence).toBeLessThan(0.5);
	}, T);

	it('honours a narrower scope and a confidence floor', async () => {
		const p = await page();
		expect(snapAt(p, [150, 95], { rules: ['square', 'circle', 'glyph', 'cell-check'] })).toBeNull();
		expectSnap(snapAt(p, [134, 263], { rules: ['square'] }), 'square', [130, 259, 139, 268], 'check');
		expect(snapAt(p, [304, 261], { minConfidence: 0.7 })).toBeNull();
	}, T);

	it('proposes more fields like the confirmed ones', async () => {
		const p = await page();
		const cell = snapAt(p, [150, 205])!;
		const cells = similarTo(p, [cell]);
		expect(cells.filter((s) => s.rule === 'cell')).toHaveLength(5);
		expect(cells.every((s) => s.rule === 'cell')).toBe(true);
		const squares = similarTo(p, [snapAt(p, [134, 263])!]);
		expect(squares.map((s) => s.label).sort()).toEqual(['Blue', 'Green', 'No', 'Red']);
	}, T);

	it('is deterministic and fast', async () => {
		const p = await page();
		const taps: [number, number][] = [];
		for (let x = 40; x < 580; x += 9) for (let y = 40; y < 520; y += 9) taps.push([x, y]);
		const t0 = performance.now();
		const a = taps.map((t) => snapAt(p, t));
		const ms = performance.now() - t0;
		expect(taps.map((t) => snapAt(p, t))).toEqual(a);
		expect(ms / taps.length).toBeLessThan(1);
	}, T);
});
