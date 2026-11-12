// Engine.pageText (src/lib/engine/page-text.ts) on the generated corpus file
// hl-text.pdf, and the export of text highlights (highlight stamps with rects).
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from '@cantoo/pdf-lib';
import type { PageRef, PageText, Rotation, Stamp, StampBox, TextWord } from '../../src/lib/core/types';
import { rotateBox } from '../../src/lib/editor/form-view';
import { defaultOptions, engine, manifest, openCorpus, pageTexts, ref } from './helpers';
import { makeSource, render } from './render-helpers';

const T = 90_000;
const FILE = 'hl-text.pdf';

interface DrawnLine {
	text: string;
	font: string;
	size: number;
	x: number;
	y: number;
	angle: number;
}
const LINES = (manifest[FILE] as unknown as { lines: DrawnLine[][] }).lines;

let helv: Awaited<ReturnType<PDFDocument['embedFont']>> | null = null;
async function helvWidth(text: string, size: number) {
	helv ??= await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
	return helv.widthOfTextAtSize(text, size);
}

const cache = new Map<number, Promise<PageText>>();
async function words(page: number): Promise<PageText> {
	if (!cache.has(page)) cache.set(page, openCorpus(FILE).then((s) => engine().pageText(s, page - 1)));
	return cache.get(page)!;
}

const pt = (b: StampBox, W: number, H: number) => ({ x0: b.x * W, y0: b.y * H, x1: (b.x + b.w) * W, y1: (b.y + b.h) * H });
const lineTexts = (t: PageText) => {
	const out: string[] = [];
	for (const w of t.words) out[w.line] = out[w.line] ? `${out[w.line]} ${w.text}` : w.text;
	return out;
};

/** Every dark pixel of the page lies inside some word box grown by `grow` pt. */
async function expectInkCovered(page: number, t: PageText, grow = 0.25) {
	const src = await openCorpus(FILE);
	const { width: W, height: H } = src.pages[page - 1];
	const r = await render(src.bytes, page - 1, 4);
	const boxes = t.words.map((w) => pt(w.box, W, H));
	let dark = 0;
	for (let y = 0; y < r.h; y++)
		for (let x = 0; x < r.w; x++) {
			const o = (y * r.w + x) * 3;
			if (r.px[o] > 100) continue;
			dark++;
			const X = ((x + 0.5) / r.w) * W;
			const Y = ((y + 0.5) / r.h) * H;
			const inside = boxes.some((b) => X >= b.x0 - grow && X <= b.x1 + grow && Y >= b.y0 - grow && Y <= b.y1 + grow);
			expect(inside, `ink at ${X.toFixed(1)},${Y.toFixed(1)} pt on page ${page} outside every word`).toBe(true);
		}
	expect(dark).toBeGreaterThan(200);
}

/** Boxes of words on different lines do not overlap. */
function expectLinesApart(t: PageText) {
	for (const a of t.words)
		for (const b of t.words) {
			if (a.line >= b.line) continue;
			const ox = Math.min(a.box.x + a.box.w, b.box.x + b.box.w) - Math.max(a.box.x, b.box.x);
			const oy = Math.min(a.box.y + a.box.h, b.box.y + b.box.h) - Math.max(a.box.y, b.box.y);
			expect(ox > 1e-6 && oy > 1e-6, `"${a.text}" (line ${a.line}) overlaps "${b.text}" (line ${b.line})`).toBe(false);
		}
}

describe('Engine.pageText', () => {
	it('a paragraph: words and lines in order, boxes where the glyphs are, ink covered, lines apart', async () => {
		const t = await words(1);
		expect(t.skipped).toBe(0);
		const lines = lineTexts(t);
		expect(lines.slice(0, 3)).toEqual([
			'Highlight the quick brown fox jumping',
			'over the lazy dog, gently and quietly',
			'beside the hedge by the old gate.'
		]);
		// Each word starts where Helvetica's widths put it (box minus its margin), within 0.3 pt.
		for (const [li, line] of LINES[0].slice(0, 3).entries()) {
			const ws = t.words.filter((w) => w.line === li);
			let prefix = '';
			for (const w of ws) {
				const start = line.x + (await helvWidth(prefix, line.size));
				const left = w.box.x * 612;
				expect(start - left, `"${w.text}" left edge`).toBeGreaterThanOrEqual(0);
				expect(start - left, `"${w.text}" left margin`).toBeLessThanOrEqual(0.1 * line.size + 0.3);
				const right = (w.box.x + w.box.w) * 612;
				const end = start + (await helvWidth(w.text, line.size));
				expect(right - end, `"${w.text}" right margin`).toBeGreaterThanOrEqual(0);
				expect(right - end).toBeLessThanOrEqual(0.1 * line.size + 0.3);
				prefix += `${w.text} `;
				// One line high: the cap height and the descender with about a 1 pt margin, no more.
				const base = 792 - line.y;
				const top = w.box.y * 792;
				const bottom = (w.box.y + w.box.h) * 792;
				expect(base - top).toBeGreaterThan(0.718 * line.size);
				expect(base - top).toBeLessThan(0.95 * line.size + 0.2);
				expect(bottom - base).toBeGreaterThan(0.2 * line.size);
				expect(bottom - base).toBeLessThan(0.35 * line.size);
			}
		}
		await expectInkCovered(1, t);
		expectLinesApart(t);
	}, T);

	it('reading order is the drawing order, not top to bottom: left column, then right column', async () => {
		const lines = lineTexts(await words(1));
		const i = (s: string) => lines.indexOf(s);
		expect(i('Left column end')).toBeGreaterThan(i('Left column one'));
		expect(i('Right column one')).toBe(i('Left column end') + 1);
	}, T);

	it('/Rotate 90: the same words, boxes turned with the page', async () => {
		const a = await words(1);
		const b = await words(2);
		expect(b.words.length).toBe(20);
		b.words.forEach((w, k) => {
			expect(w.text).toBe(a.words[k].text);
			const want = rotateBox(a.words[k].box, 90);
			for (const key of ['x', 'y', 'w', 'h'] as const) expect(w.box[key]).toBeCloseTo(want[key], 4);
		});
		await expectInkCovered(2, b);
	}, T);

	it('CropBox offset: boxes are fractions of the crop', async () => {
		const a = await words(1);
		const c = await words(3);
		// p3 draws the paragraph 78 pt right and 140 pt lower than p1, in a crop at (100, 150) of 400 × 500.
		c.words.forEach((w, k) => {
			const p = pt(a.words[k].box, 612, 792);
			const q = pt(w.box, 400, 500);
			expect(q.x0).toBeCloseTo(p.x0 + 78 - 100, 2);
			expect(q.y0).toBeCloseTo(p.y0 - 2, 2);
			expect(q.x1 - q.x0).toBeCloseTo(p.x1 - p.x0, 2);
		});
		await expectInkCovered(3, c);
	}, T);

	it('runs at an angle: level and 2° runs and a vertical run are offered, a 30° run is not', async () => {
		const t = await words(4);
		expect(lineTexts(t)).toEqual(['Level line of text', 'Nearly level line', 'Vertical words here']);
		expect(t.skipped).toBe('Tiltedlineoftext'.length);
		// The vertical run: boxes taller than wide, read bottom to top.
		const v = t.words.filter((w) => w.line === 2);
		for (const w of v) expect(w.box.h * 792).toBeGreaterThan(w.box.w * 612);
		expect(v[0].box.y).toBeGreaterThan(v[1].box.y);
		// The 2° run: each word's box holds its tilted letters but stays about one line high.
		for (const w of t.words.filter((x) => x.line === 1)) expect(w.box.h * 792).toBeLessThan(12 * 1.4);
	}, T);

	it('right to left: Hebrew words in reading order, the first word rightmost', async () => {
		const t = await words(5);
		const he = t.words.filter((w) => w.line === 0);
		expect(he.map((w) => w.text)).toEqual(['שלום', 'עולם', 'יפה', 'מאוד']);
		for (let k = 1; k < he.length; k++) expect(he[k].box.x).toBeLessThan(he[k - 1].box.x);
		expect(lineTexts(t)[2]).toBe('Latin after Hebrew');
		await expectInkCovered(5, t);
	}, T);

	it('invisible OCR text is offered; a scan without text has no words', async () => {
		expect(lineTexts(await words(6))).toEqual(['Scanned words under glass']);
		expect(await words(7)).toEqual({ words: [], skipped: 0 });
	}, T);

	it('text clipped away and text in a hidden layer are not offered', async () => {
		expect(lineTexts(await words(8))).toEqual(['Visible words stay']);
	}, T);

	it('a Type 3 font with metrics is offered, its ink covered', async () => {
		const t = await words(9);
		expect(lineTexts(t)).toContain('ABBA BAB');
		await expectInkCovered(9, t);
	}, T);

	it('tight leading under a big heading: every line one band, kept apart, ink covered', async () => {
		const t = await words(10);
		expect(lineTexts(t)).toEqual(['Heading Big', 'gypsy jumping quickly', 'Typography of glyphs', 'jolly yapping puppy']);
		expectLinesApart(t);
		await expectInkCovered(10, t);
		// The words of one line share one band.
		for (const line of [1, 2, 3]) {
			const ws = t.words.filter((w) => w.line === line);
			for (const w of ws) {
				expect(w.box.y).toBeCloseTo(ws[0].box.y, 6);
				expect(w.box.h).toBeCloseTo(ws[0].box.h, 6);
			}
		}
	}, T);

	it('images and blank pages have no words; a page out of range is refused', async () => {
		const blank = await engine().blankPage({ width: 300, height: 300 });
		expect(await engine().pageText(blank, 0)).toEqual({ words: [], skipped: 0 });
		const src = await openCorpus(FILE);
		await expect(engine().pageText(src, 99)).rejects.toMatchObject({ code: 'internal' });
	}, T);
});

// ---------------------------------------------------------------------------
// Export of text highlights.

const COLORS = { yellow: [255, 235, 59], green: [165, 243, 107], pink: [255, 156, 203] } as const;
const near = (a: number[], b: readonly number[], tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const white = (p: number[]) => p.every((v) => v >= 252);

function bounds(rects: StampBox[]): StampBox {
	const x0 = Math.min(...rects.map((r) => r.x));
	const y0 = Math.min(...rects.map((r) => r.y));
	const x1 = Math.max(...rects.map((r) => r.x + r.w));
	const y1 = Math.max(...rects.map((r) => r.y + r.h));
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
const textHl = (rects: StampBox[], color: keyof typeof COLORS = 'yellow'): Stamp => ({ id: `t-${color}`, kind: 'highlight', color, box: bounds(rects), rects });

describe('text highlight stamp', () => {
	// Two lines; the second overlaps the first a little (overlap must not get darker), and a gap.
	const RECTS: StampBox[] = [
		{ x: 0.3, y: 0.2, w: 0.5, h: 0.05 },
		{ x: 0.1, y: 0.245, w: 0.4, h: 0.05 },
		{ x: 0.1, y: 0.4, w: 0.2, h: 0.05 }
	];
	for (const rotation of [0, 90, 180, 270] as Rotation[]) {
		it(`rotation ${rotation}: each rectangle coloured, not darker where two overlap, nothing between`, async () => {
			const src = await makeSource([{ w: 612, h: 792, crop: [100, 150, 500, 650] }]);
			const mk = (st: Stamp[]) => [ref(src, 0, rotation, st)] as PageRef[];
			const plain = await engine().exportPlan({ pages: mk([]), options: defaultOptions }, [src], []);
			const marked = await engine().exportPlan({ pages: mk([textHl(RECTS)]), options: defaultOptions }, [src], []);
			for (const c of marked.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
			const a = await render(plain.bytes, 0, 2);
			const b = await render(marked.bytes, 0, 2);
			const inRect = (fx: number, fy: number, m: number) => RECTS.some((r) => fx > r.x + m && fx < r.x + r.w - m && fy > r.y + m && fy < r.y + r.h - m);
			let checked = 0;
			for (let y = 0; y < a.h; y++)
				for (let x = 0; x < a.w; x++) {
					const fx = (x + 0.5) / a.w;
					const fy = (y + 0.5) / a.h;
					const o = (y * a.w + x) * 3;
					const pa = [a.px[o], a.px[o + 1], a.px[o + 2]];
					const pb = [b.px[o], b.px[o + 1], b.px[o + 2]];
					if (inRect(fx, fy, 0.006)) {
						checked++;
						expect(near(pb, pa.map((v, k) => (v * COLORS.yellow[k]) / 255)), `pixel ${fx.toFixed(3)},${fy.toFixed(3)}`).toBe(true);
					} else if (!inRect(fx, fy, -0.006)) expect(near(pb, pa, 3), `outside ${fx.toFixed(3)},${fy.toFixed(3)}`).toBe(true);
				}
			expect(checked).toBeGreaterThan(2000);
			// The gap between the second and third rectangle stays white.
			expect(white(b.at(0.2, 0.35))).toBe(true);
			expect(await pageTexts(marked.bytes)).toEqual(await pageTexts(plain.bytes));
		}, T);
	}

	it('rects outside their box, an empty list, or rects with a pen stroke are refused', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		const bad: Stamp[] = [
			{ id: 'a', kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, rects: [{ x: 0.1, y: 0.1, w: 0.3, h: 0.05 }] },
			{ id: 'b', kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 }, rects: [] },
			{
				id: 'c',
				kind: 'highlight',
				color: 'yellow',
				box: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
				rects: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.05 }],
				pen: { points: [{ x: 0.15, y: 0.15 }, { x: 0.2, y: 0.15 }], width: 0.01 }
			}
		];
		for (const s of bad)
			await expect(engine().exportPlan({ pages: [ref(src, 0, 0, [s])], options: defaultOptions }, [src], [])).rejects.toMatchObject({ code: 'unsupported' });
	}, T);

	it('words of hl-text.pdf highlighted on the page as shown: their ink tinted, the next words and lines untouched', async () => {
		const src = await openCorpus(FILE);
		const t = await words(1);
		const { selectionRects, shownLayout } = await import('../../src/lib/editor/text-select');
		for (const rotation of [0, 90] as Rotation[]) {
			const aspect = rotation ? 792 / 612 : 612 / 792;
			const lay = shownLayout(t, rotation, aspect);
			const a = t.words.findIndex((w) => w.text === 'quick');
			const b = t.words.findIndex((w) => w.text === 'lazy');
			const rects = selectionRects(lay, a, b);
			expect(rects).toHaveLength(2);
			const res = await engine().exportPlan({ pages: [ref(src, 0, rotation, [textHl(rects, 'green')])], options: defaultOptions }, [src], []);
			for (const c of res.checks) expect(c.ok, c.name).toBe(true);
			const r = await render(res.bytes, 0, 3);
			const at = (w: TextWord, fx: number, fy: number) => {
				const box = rotateBox(w.box, rotation);
				// A point inside the word's box in unrotated terms, turned with the page.
				const p = rotateBox({ x: w.box.x + fx * w.box.w, y: w.box.y + fy * w.box.h, w: 0, h: 0 }, rotation);
				void box;
				return r.at(p.x, p.y);
			};
			const word = (s: string, line: number) => t.words.find((w) => w.text === s && w.line === line)!;
			// Paper beside the letters inside the selected words: green. Outside: white.
			expect(near(at(word('quick', 0), 0.5, 0.05), COLORS.green, 8), 'quick').toBe(true);
			expect(near(at(word('jumping', 0), 0.98, 0.5), COLORS.green, 8), 'jumping end').toBe(true);
			expect(near(at(word('lazy', 1), 0.5, 0.05), COLORS.green, 8), 'lazy').toBe(true);
			expect(white(at(word('the', 0), 0.5, 0.05)), 'the (before quick)').toBe(true);
			expect(white(at(word('dog,', 1), 0.5, 0.05)), 'dog, (after lazy)').toBe(true);
			expect(white(at(word('the', 2), 0.5, 0.05)), 'third line').toBe(true);
		}
	}, T);
});
