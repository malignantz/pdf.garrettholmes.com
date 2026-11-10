import { describe, expect, it } from 'vitest';
import type { HighlightColor, PageRef, Rotation, Stamp, StampBox } from '../../src/lib/core/types';
import { defaultOptions, engine, pageTexts, ref } from './helpers';
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
