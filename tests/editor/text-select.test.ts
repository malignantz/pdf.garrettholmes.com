// Selection geometry of the text highlighter (src/lib/editor/text-select.ts) on the
// words the engine reads from tests/corpus/files/hl-text.pdf.
import { describe, expect, it } from 'vitest';
import type { PageText, Rotation, StampBox } from '../../src/lib/core/types';
import { engine, openCorpus } from '../engine/helpers';
import { rotateBox } from '../../src/lib/editor/form-view';
import { reboxPatch } from '../../src/lib/editor/pen';
import { boundsOf, mapRects, selectionRects, selectionText, shownLayout, wordAtEnd, wordNear } from '../../src/lib/editor/text-select';

const T = 60_000;
const cache = new Map<number, Promise<PageText>>();
const words = (page: number) => {
	if (!cache.has(page)) cache.set(page, openCorpus('hl-text.pdf').then((s) => engine().pageText(s, page - 1)));
	return cache.get(page)!;
};
const idx = (t: PageText, text: string, line?: number) => t.words.findIndex((w) => w.text === text && (line === undefined || w.line === line));
const centre = (b: StampBox) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });
const close = (a: number, b: number, d = 1e-6) => Math.abs(a - b) <= d;

describe('text selection', () => {
	it('a drag from inside one word to inside another snaps to whole words: one rectangle per line', async () => {
		const t = await words(1);
		const lay = shownLayout(t, 0, 612 / 792);
		const quick = t.words[idx(t, 'quick')].box;
		const lazy = t.words[idx(t, 'lazy')].box;
		// Pointer a little inside each word, off its centre.
		const a = wordNear(lay, { x: quick.x + quick.w * 0.7, y: quick.y + quick.h * 0.4 }, 0.01);
		const b = wordAtEnd(lay, { x: lazy.x + lazy.w * 0.2, y: lazy.y + lazy.h * 0.6 });
		expect(t.words[a].text).toBe('quick');
		expect(t.words[b].text).toBe('lazy');
		expect(selectionText(lay, a, b)).toBe('quick brown fox jumping over the lazy');
		const rects = selectionRects(lay, a, b);
		expect(rects).toHaveLength(2);
		const jumping = t.words[idx(t, 'jumping')].box;
		const over = t.words[idx(t, 'over')].box;
		expect(close(rects[0].x, quick.x)).toBe(true);
		expect(close(rects[0].x + rects[0].w, jumping.x + jumping.w)).toBe(true);
		expect(close(rects[1].x, over.x)).toBe(true);
		expect(close(rects[1].x + rects[1].w, lazy.x + lazy.w)).toBe(true);
		// The order of the ends does not matter.
		expect(selectionRects(lay, b, a)).toEqual(rects);
		// The rectangles of two lines do not overlap.
		expect(rects[0].y + rects[0].h).toBeLessThanOrEqual(rects[1].y + 1e-9);
	}, T);

	it('three lines: three rectangles; a word alone: its own box', async () => {
		const t = await words(1);
		const lay = shownLayout(t, 0, 612 / 792);
		expect(selectionRects(lay, idx(t, 'the', 0), idx(t, 'old'))).toHaveLength(3);
		const fox = idx(t, 'fox');
		const [one] = selectionRects(lay, fox, fox);
		for (const k of ['x', 'y', 'w', 'h'] as const) expect(one[k]).toBeCloseTo(t.words[fox].box[k], 9);
	}, T);

	it('reading order comes from the file: the end of the left column runs on to the top of the right one', async () => {
		const t = await words(1);
		const lay = shownLayout(t, 0, 612 / 792);
		const a = idx(t, 'end');
		const b = t.words.findIndex((w, i) => i > a && w.text === 'one');
		expect(selectionText(lay, a, b)).toBe('end Right column one');
		const rects = selectionRects(lay, a, b);
		expect(rects).toHaveLength(2);
		// The second rectangle is above the first on the page: not sorted by position.
		expect(rects[1].y).toBeLessThan(rects[0].y);
		// Nothing of "Left column two" (between them by position) is covered.
		const two = t.words.find((w) => w.text === 'two' && w.box.x < 0.3)!;
		for (const r of rects) expect(r.y + r.h <= two.box.y + 1e-9 || r.y >= two.box.y + two.box.h - 1e-9 || r.x >= two.box.x + two.box.w).toBe(true);
	}, T);

	it('a pointer between lines or past the end of a line picks the nearest line, then the nearest word', async () => {
		const t = await words(1);
		const lay = shownLayout(t, 0, 612 / 792);
		const jumping = t.words[idx(t, 'jumping')].box;
		// Far right of the first line, on its height.
		expect(t.words[wordAtEnd(lay, { x: 0.9, y: jumping.y + jumping.h / 2 })].text).toBe('jumping');
		// In the margin to the left of the second line.
		const over = t.words[idx(t, 'over')].box;
		expect(t.words[wordAtEnd(lay, { x: 0.02, y: over.y + over.h / 2 })].text).toBe('over');
		// Far from any text: no start word within a small tolerance.
		expect(wordNear(lay, { x: 0.5, y: 0.9 }, 0.02)).toBe(-1);
	}, T);

	it('right to left: a range of Hebrew words is one rectangle from the last word to the first', async () => {
		const t = await words(5);
		const lay = shownLayout(t, 0, 612 / 792);
		const a = idx(t, 'עולם');
		const b = idx(t, 'מאוד');
		const rects = selectionRects(lay, a, b);
		expect(rects).toHaveLength(1);
		expect(close(rects[0].x, t.words[b].box.x)).toBe(true);
		expect(close(rects[0].x + rects[0].w, t.words[a].box.x + t.words[a].box.w)).toBe(true);
		// The first word (rightmost) is not covered.
		const first = t.words[idx(t, 'שלום')].box;
		expect(rects[0].x + rects[0].w).toBeLessThanOrEqual(first.x + 1e-9);
	}, T);

	for (const rotation of [90, 180, 270] as Rotation[]) {
		it(`page turned ${rotation}°: rectangles turn with the words`, async () => {
			const t = await words(1);
			const aspect = rotation % 180 ? 792 / 612 : 612 / 792;
			const lay = shownLayout(t, rotation, aspect);
			const flat = shownLayout(t, 0, 612 / 792);
			const a = idx(t, 'quick');
			const b = idx(t, 'lazy');
			const turned = selectionRects(lay, a, b);
			const want = selectionRects(flat, a, b).map((r) => rotateBox(r, rotation));
			expect(turned).toHaveLength(2);
			turned.forEach((r, i) => {
				for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k]).toBeCloseTo(want[i][k], 9);
			});
			// Lines run up or down a page turned a quarter.
			if (rotation % 180) expect(lay.lines[0].across).toBe(false);
			// Hit-testing works in the turned frame.
			expect(wordNear(lay, centre(lay.words[a].box), 0.001)).toBe(a);
		}, T);
	}

	it('intrinsic /Rotate 90 and a CropBox: the words are where they are shown', async () => {
		const p1 = await words(1);
		const p2 = await words(2);
		const p3 = await words(3);
		const a = idx(p1, 'quick');
		const b = idx(p1, 'lazy');
		const r1 = selectionRects(shownLayout(p1, 0, 612 / 792), a, b);
		const r2 = selectionRects(shownLayout(p2, 0, 792 / 612), a, b);
		r2.forEach((r, i) => {
			const want = rotateBox(r1[i], 90);
			for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k]).toBeCloseTo(want[k], 4);
		});
		const r3 = selectionRects(shownLayout(p3, 0, 400 / 500), a, b);
		// p3 draws the paragraph 22 pt left and 2 pt up of p1's, in a 400 × 500 crop.
		r3.forEach((r, i) => {
			expect(r.x * 400).toBeCloseTo(r1[i].x * 612 - 22, 2);
			expect(r.y * 500).toBeCloseTo(r1[i].y * 792 - 2, 2);
		});
	}, T);

	it('a nearly level line is cut into pieces that each stay about one line high', async () => {
		const t = await words(4);
		const lay = shownLayout(t, 0, 612 / 792);
		const ws = t.words.map((w, i) => ({ w, i })).filter((x) => x.w.line === 1);
		const rects = selectionRects(lay, ws[0].i, ws[ws.length - 1].i);
		const tallest = Math.max(...ws.map((x) => x.w.box.h));
		for (const r of rects) expect(r.h).toBeLessThanOrEqual(1.15 * tallest + 1e-9);
		const level = t.words.filter((w) => w.line === 0);
		expect(selectionRects(lay, 0, level.length - 1)).toHaveLength(1);
	}, T);

	it('moving the stamp moves its rectangles; they stay inside the box', async () => {
		const t = await words(1);
		const lay = shownLayout(t, 0, 612 / 792);
		const rects = selectionRects(lay, idx(t, 'quick'), idx(t, 'lazy'));
		const box = boundsOf(rects);
		const to = { ...box, x: box.x + 0.1, y: box.y + 0.05 };
		const moved = mapRects(rects, box, to);
		moved.forEach((r, i) => {
			expect(r.x).toBeCloseTo(rects[i].x + 0.1, 9);
			expect(r.y).toBeCloseTo(rects[i].y + 0.05, 9);
			expect(r.w).toBeCloseTo(rects[i].w, 9);
		});
		const patch = reboxPatch({ id: 's', kind: 'highlight', color: 'yellow', box, rects }, to);
		expect(patch).toEqual({ box: to, rects: moved });
		// Fitted into a smaller box (another page's shape), each keeps its share.
		const small = { x: 0.2, y: 0.2, w: box.w / 2, h: box.h / 2 };
		for (const r of mapRects(rects, box, small)) {
			expect(r.x).toBeGreaterThanOrEqual(small.x - 1e-12);
			expect(r.x + r.w).toBeLessThanOrEqual(small.x + small.w + 1e-12);
		}
	}, T);
});
