import { describe, expect, it } from 'vitest';
import type { HighlightColor, PageRef, Rotation, Stamp, StampBox } from '../../src/lib/core/types';
import { defaultOptions, engine, openCorpus, pageTexts, ref } from './helpers';
import { makeSource, render, type PageSpec } from './render-helpers';

const T = 90_000;
const BOX: StampBox = { x: 0.15, y: 0.3, w: 0.6, h: 0.35 };
const COLORS: Record<HighlightColor, [number, number, number]> = {
	yellow: [255, 235, 59],
	green: [165, 243, 107],
	pink: [255, 156, 203]
};
const hl = (color: HighlightColor, box = BOX): Stamp => ({ id: `h-${color}`, kind: 'highlight', color, box });

const near = (a: number[], b: number[], tol = 4) => a.every((v, i) => Math.abs(v - b[i]) <= tol);
const dark = (p: number[]) => p[0] < 70 && p[1] < 70 && p[2] < 70;
const white = (p: number[]) => p.every((v) => v >= 252);

const specs: Record<string, PageSpec> = {
	letter: { w: 612, h: 792 },
	crop: { w: 612, h: 792, crop: [100, 150, 500, 650] },
	unit: { w: 300, h: 200, userUnit: 2 }
};

async function exportOne(spec: PageSpec, rotation: Rotation, stamps: Stamp[], extra = {}) {
	const src = await makeSource([spec]);
	const mk = (st: Stamp[]) => [ref(src, 0, rotation, st)] as PageRef[];
	const plain = await engine().exportPlan({ pages: mk([]), options: { ...defaultOptions, ...extra } }, [src], []);
	const marked = await engine().exportPlan({ pages: mk(stamps), options: { ...defaultOptions, ...extra } }, [src], []);
	for (const c of marked.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return { plain: plain.bytes, marked: marked.bytes };
}

describe('highlight stamp', () => {
	for (const [name, spec] of Object.entries(specs)) {
		for (const rotation of [0, 90, 180, 270] as Rotation[]) {
			it(`${name}, rotation ${rotation}: colour over white, text stays dark, outside unchanged`, async () => {
				const { plain, marked } = await exportOne(spec, rotation, [hl('yellow')]);
				const a = await render(plain, 0);
				const b = await render(marked, 0);
				expect([b.w, b.h]).toEqual([a.w, a.h]);
				let inside = 0;
				let darkKept = 0;
				let tinted = 0;
				for (let y = 0; y < a.h; y++) {
					for (let x = 0; x < a.w; x++) {
						const fx = (x + 0.5) / a.w;
						const fy = (y + 0.5) / a.h;
						const o = (y * a.w + x) * 3;
						const pa = [a.px[o], a.px[o + 1], a.px[o + 2]];
						const pb = [b.px[o], b.px[o + 1], b.px[o + 2]];
						const margin = 0.012;
						const isIn = fx > BOX.x + margin && fx < BOX.x + BOX.w - margin && fy > BOX.y + margin && fy < BOX.y + BOX.h - margin;
						const isOut = fx < BOX.x - margin || fx > BOX.x + BOX.w + margin || fy < BOX.y - margin || fy > BOX.y + BOX.h + margin;
						if (isIn) {
							inside++;
							// Multiply: every pixel is the page pixel times the colour.
							const want = pa.map((v, k) => (v * COLORS.yellow[k]) / 255);
							expect(near(pb, want, 4), `pixel at ${fx},${fy}: ${pa} became ${pb}`).toBe(true);
							if (white(pa)) tinted++;
							else if (dark(pa)) darkKept++;
						} else if (isOut) {
							expect(near(pb, pa, 3), `outside pixel at ${fx},${fy}: ${pb} vs ${pa}`).toBe(true);
						}
					}
				}
				expect(inside).toBeGreaterThan(1000);
				expect(tinted).toBeGreaterThan(500);
				expect(darkKept).toBeGreaterThan(50);
				expect(await pageTexts(marked)).toEqual(await pageTexts(plain));
			}, T);
		}
	}

	it('each colour shows clearly on white and keeps black text readable', async () => {
		for (const color of ['yellow', 'green', 'pink'] as const) {
			const { marked } = await exportOne(specs.letter, 0, [hl(color)]);
			const r = await render(marked, 0);
			expect(near(r.at(0.2, 0.31), COLORS[color])).toBe(true);
			// Not white, and far from black: the black bar sits at y = 0.54..0.60 of the page height.
			const px = r.at(0.2, 0.31);
			expect(Math.min(...px)).toBeLessThan(215);
			expect(dark(r.at(0.5, 0.57))).toBe(true);
		}
	}, T);

	it('draws highlights below the other stamps of the page', async () => {
		const text: Stamp = { id: 't', kind: 'text', text: 'ABCDEFGH', x: 0.2, y: 0.32, size: 0.1, color: 'black' };
		const { marked } = await exportOne(specs.letter, 0, [text, hl('pink')]);
		const r = await render(marked, 0);
		// Black glyph pixels from the text stamp exist inside the highlight, undimmed.
		let darkPx = 0;
		for (let y = Math.floor(0.32 * r.h); y < Math.floor(0.42 * r.h); y++) {
			for (let x = Math.floor(0.2 * r.w); x < Math.floor(0.6 * r.w); x++) {
				const o = (y * r.w + x) * 3;
				if (dark([r.px[o], r.px[o + 1], r.px[o + 2]])) darkPx++;
			}
		}
		expect(darkPx).toBeGreaterThan(100);
	}, T);

	it('a highlight on top of a signature-style image stamp does not hide it (image drawn after)', async () => {
		const mark: Stamp = { id: 'm', kind: 'mark', mark: 'dot', box: { x: 0.3, y: 0.35, w: 0.2, h: 0.2 } };
		const { marked } = await exportOne(specs.letter, 0, [mark, hl('green')]);
		const r = await render(marked, 0);
		expect(dark(r.at(0.4, 0.45))).toBe(true);
	}, T);

	it('works with compression and with several highlights on several pages', async () => {
		const src = await makeSource([specs.letter, specs.crop, specs.unit]);
		const pages = [
			ref(src, 0, 90, [hl('yellow'), hl('green', { x: 0.1, y: 0.7, w: 0.3, h: 0.1 })]),
			ref(src, 1, 0, [hl('pink')]),
			ref(src, 2, 270, [])
		];
		const res = await engine().exportPlan({ pages, options: { ...defaultOptions, compress: true } }, [src], []);
		for (const c of res.checks) expect(c.ok, c.detail).toBe(true);
		const r0 = await render(res.bytes, 0);
		expect(near(r0.at(0.2, 0.75), COLORS.green)).toBe(true);
		expect(white(r0.at(0.9, 0.9))).toBe(true);
		const r2 = await render(res.bytes, 2);
		expect(white(r2.at(0.2, 0.31))).toBe(true);
	}, T);
});

// ---------------------------------------------------------------------------
// Pen highlights: one stroked path, round caps and joins, Multiply.

type Pt = { x: number; y: number };
/** A stroke that crosses itself (segments 1 and 3), with a sharp turn. Width: 3% of the page height. */
const STROKE: Pt[] = [
	{ x: 0.15, y: 0.3 },
	{ x: 0.6, y: 0.48 },
	{ x: 0.62, y: 0.3 },
	{ x: 0.2, y: 0.44 }
];
const PEN_W = 0.03;
const penBounds = (pts: Pt[], w: number, aspect: number): StampBox => {
	const xs = pts.map((p) => p.x);
	const ys = pts.map((p) => p.y);
	const x0 = Math.max(0, Math.min(...xs) - w / 2 / aspect);
	const y0 = Math.max(0, Math.min(...ys) - w / 2);
	const x1 = Math.min(1, Math.max(...xs) + w / 2 / aspect);
	const y1 = Math.min(1, Math.max(...ys) + w / 2);
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
const pen = (color: HighlightColor, aspect: number, pts = STROKE, w = PEN_W): Stamp => ({
	id: `p-${color}`,
	kind: 'highlight',
	color,
	box: penBounds(pts, w, aspect),
	pen: { points: pts, width: w }
});

/** Distance in raster pixels from pixel centre (x, y) to the polyline, all in the displayed page's raster. */
function strokeDistance(x: number, y: number, pts: Pt[], W: number, H: number): number {
	let best = Infinity;
	for (let i = 1; i < pts.length; i++) {
		const ax = pts[i - 1].x * W;
		const ay = pts[i - 1].y * H;
		const bx = pts[i].x * W;
		const by = pts[i].y * H;
		const dx = bx - ax;
		const dy = by - ay;
		const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
		best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
	}
	return best;
}

/**
 * Compares the export with and without the stroke, pixel by pixel: well inside the
 * stroke every pixel is the plain pixel times the colour (also where the stroke
 * crosses itself: no darker), well outside nothing changed.
 */
function expectStroke(a: Awaited<ReturnType<typeof render>>, b: Awaited<ReturnType<typeof render>>, color: HighlightColor, pts = STROKE, w = PEN_W) {
	expect([b.w, b.h]).toEqual([a.w, a.h]);
	const half = (w * a.h) / 2;
	const margin = 1.5;
	let inside = 0;
	let tinted = 0;
	let crossing = 0;
	// Where segments 1 and 3 of STROKE cross, in raster px (found numerically below).
	const cross = pts === STROKE ? crossPoint(pts, a.w, a.h) : null;
	for (let y = 0; y < a.h; y++) {
		for (let x = 0; x < a.w; x++) {
			const d = strokeDistance(x + 0.5, y + 0.5, pts, a.w, a.h);
			const o = (y * a.w + x) * 3;
			const pa = [a.px[o], a.px[o + 1], a.px[o + 2]];
			const pb = [b.px[o], b.px[o + 1], b.px[o + 2]];
			if (d < half - margin) {
				inside++;
				const want = pa.map((v, k) => (v * COLORS[color][k]) / 255);
				expect(near(pb, want, 4), `stroke pixel ${x},${y}: ${pa} became ${pb}`).toBe(true);
				if (white(pa)) tinted++;
				if (cross && Math.hypot(x + 0.5 - cross.x, y + 0.5 - cross.y) < half / 2) crossing++;
			} else if (d > half + margin) {
				expect(near(pb, pa, 3), `outside pixel ${x},${y}: ${pb} vs ${pa}`).toBe(true);
			}
		}
	}
	// The stroke is long: thousands of pixels at 1 px per point.
	expect(inside).toBeGreaterThan(2000);
	expect(tinted).toBeGreaterThan(1000);
	if (cross) expect(crossing, 'pixels checked where the stroke crosses itself').toBeGreaterThan(10);
}

function crossPoint(pts: Pt[], W: number, H: number): Pt | null {
	const [a, b] = [pts[0], pts[1]].map((p) => ({ x: p.x * W, y: p.y * H }));
	const [c, d] = [pts[2], pts[3]].map((p) => ({ x: p.x * W, y: p.y * H }));
	const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
	if (den === 0) return null;
	const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
	const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
	if (t < 0 || t > 1 || u < 0 || u > 1) return null;
	return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

describe('pen highlight stamp', () => {
	for (const [name, spec] of Object.entries(specs)) {
		for (const rotation of [0, 90, 180, 270] as Rotation[]) {
			it(`${name}, rotation ${rotation}: colour along the stroke only, no darker where it crosses itself`, async () => {
				const cw = spec.crop ? spec.crop[2] - spec.crop[0] : spec.w;
				const ch = spec.crop ? spec.crop[3] - spec.crop[1] : spec.h;
				const aspect = rotation % 180 ? ch / cw : cw / ch;
				const { plain, marked } = await exportOne(spec, rotation, [pen('yellow', aspect)]);
				expectStroke(await render(plain, 0), await render(marked, 0), 'yellow');
				expect(await pageTexts(marked)).toEqual(await pageTexts(plain));
			}, T);
		}
	}

	const corpusCases = [
		{ file: 'rotated.pdf', page: 1, rotation: 0 as Rotation, note: 'intrinsic /Rotate 90' },
		{ file: 'rotated.pdf', page: 3, rotation: 90 as Rotation, note: 'intrinsic /Rotate 270 + user 90' },
		{ file: 'cropbox.pdf', page: 1, rotation: 0 as Rotation, note: 'CropBox and MediaBox offset' },
		{ file: 'cropbox.pdf', page: 2, rotation: 180 as Rotation, note: 'CropBox offset, /Rotate 90, user 180' },
		{ file: 'cropbox.pdf', page: 4, rotation: 90 as Rotation, note: 'CropBox offset, /Rotate 270, user 90' }
	];
	for (const c of corpusCases) {
		it(`corpus ${c.file} p${c.page + 1} (${c.note})`, async () => {
			const src = await openCorpus(c.file);
			const size = src.pages[c.page];
			const aspect = c.rotation % 180 ? size.height / size.width : size.width / size.height;
			const mk = (st: Stamp[]) => [ref(src, c.page, c.rotation, st)] as PageRef[];
			const plain = await engine().exportPlan({ pages: mk([]), options: defaultOptions }, [src], []);
			const marked = await engine().exportPlan({ pages: mk([pen('pink', aspect)]), options: defaultOptions }, [src], []);
			for (const ck of marked.checks) expect(ck.ok, `${ck.name}: ${ck.detail}`).toBe(true);
			expectStroke(await render(plain.bytes, 0), await render(marked.bytes, 0), 'pink');
		}, T);
	}

	it('a straight two-point line has round ends half the width past each end', async () => {
		const line = [
			{ x: 0.2, y: 0.25 },
			{ x: 0.7, y: 0.25 }
		];
		const w = 0.04;
		const { plain, marked } = await exportOne(specs.letter, 0, [pen('green', 612 / 792, line, w)]);
		const a = await render(plain, 0);
		const b = await render(marked, 0);
		expectStroke(a, b, 'green', line, w);
		const half = (w * 792) / 2;
		// On the axis just inside the cap: tinted. Off the axis at the corner a square cap would fill: white.
		const x0 = 0.2 * 612;
		const y = 0.25 * 792;
		expect(near(b.at((x0 - half + 2) / 612, y / 792), COLORS.green)).toBe(true);
		expect(white(b.at((x0 - half + 2) / 612, (y - half + 2) / 792))).toBe(true);
	}, T);

	it('pen and box highlights together, with compression, under other stamps', async () => {
		const src = await makeSource([specs.letter]);
		const text: Stamp = { id: 't', kind: 'text', text: 'ABCDEFGH', x: 0.2, y: 0.33, size: 0.08, color: 'black' };
		const pages = [ref(src, 0, 0, [text, pen('yellow', 612 / 792), hl('green', { x: 0.1, y: 0.7, w: 0.3, h: 0.1 })])];
		const res = await engine().exportPlan({ pages, options: { ...defaultOptions, compress: true } }, [src], []);
		for (const c of res.checks) expect(c.ok, c.detail).toBe(true);
		const r = await render(res.bytes, 0);
		expect(near(r.at(0.2, 0.75), COLORS.green)).toBe(true);
		expect(near(r.at(0.15, 0.3), COLORS.yellow)).toBe(true);
		expect(white(r.at(0.9, 0.9))).toBe(true);
		expect((await pageTexts(res.bytes))[0]).toContain('ABCDEFGH');
	}, T);

	it('box highlights have slightly rounded corners', async () => {
		const box: StampBox = { x: 0.2, y: 0.2, w: 0.4, h: 0.1 };
		const { marked } = await exportOne(specs.letter, 0, [hl('yellow', box)]);
		const s = 4;
		const r = await render(marked, 0, s);
		// 0.4 pt in from the top-left corner along the diagonal: outside the ~2.8 pt radius.
		const px = (pt: number, f: number, side: number) => (f * side + pt) / side;
		expect(white(r.at(px(0.4, box.x, 612), px(0.4, box.y, 792)))).toBe(true);
		// Same depth in from the top edge, away from the corner: inside.
		expect(near(r.at(px(20, box.x, 612), px(0.6, box.y, 792)), COLORS.yellow)).toBe(true);
	}, T);
});
