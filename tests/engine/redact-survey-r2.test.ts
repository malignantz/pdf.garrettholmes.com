/**
 * Redaction fixes from the second survey round (2026-11-11), each with a generated file
 * that has the trait of the real one:
 * - a very large map page ran out of memory: refused up front by a size guard;
 * - redact-survey-2.pdf: text next to a box removed (a lone space's em box, the glyph core
 *   band), scaled text moved by a second MuPDF rewrite after the check, and annotations and
 *   gradients removed whole without a warning, and a drawing removed whole although its
 *   clip kept it far from the box (see generate-redact.mjs, survey2).
 */

import { describe, expect, it } from 'vitest';
import type { Source, Stamp, StampBox } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { MAX_REDACT_CONTENT_BYTES } from '../../src/lib/engine/redact';
import { densePage } from '../corpus/generate-redact.mjs';
import { mupdf } from '../../src/lib/engine/mupdf';
import { corpus, defaultOptions, engine, manifest, pageTexts, ref } from './helpers';

const T = 180_000;
interface Case {
	box: number[];
	noImage?: number[];
	keep?: string[];
	scaled?: string;
	clip?: number[];
}
const cases = (manifest['redact-survey-2.pdf'] as unknown as { cases: Case[] }).cases;

/** A user-space rect [x0 y0 x1 y1] grown by `pad` pt, as a fraction of a 612×792 page. */
function frac([x0, y0, x1, y1]: number[], w = 612, h = 792, pad = 1): StampBox {
	return { x: (x0 - pad) / w, y: (h - y1 - pad) / h, w: (x1 - x0 + 2 * pad) / w, h: (y1 - y0 + 2 * pad) / h };
}
let sid = 0;
const redact = (box: StampBox): Stamp => ({ id: `r${sid++}`, kind: 'redact', box });

async function exportRedacted(src: Source, boxes: StampBox[], pageIndex = 0) {
	const pages = src.pages.map((_, i) => ref(src, i, 0, i === pageIndex ? boxes.map(redact) : []));
	return engine().exportPlan({ pages, options: defaultOptions }, [src], []);
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineError;
	}
	throw new Error('expected a refusal');
}

describe('redaction: page size guard (survey: a 79 MB USGS map page ran out of memory)', () => {
	it('refuses a page with more drawing instructions than the limit, quickly and plainly', async () => {
		const mb = MAX_REDACT_CONTENT_BYTES / 1024 / 1024;
		for (const inForm of [false, true]) {
			const { bytes, line } = densePage(mb + 1, { inForm });
			const src = await engine().openPdf(bytes, 'dense.pdf');
			const t0 = Date.now();
			const err = await refusal(exportRedacted(src, [frac(line)]));
			expect(err.code).toBe('too-large');
			expect(err.message).toMatch(/^Page 1 is too detailed to redact on this device/);
			// Refused before the heavy work (which takes about a minute at this size).
			expect(Date.now() - t0).toBeLessThan(20_000);
		}
	}, T);

	it('still redacts a dense page under the limit', async () => {
		const { bytes, line } = densePage(2);
		const src = await engine().openPdf(bytes, 'dense.pdf');
		const res = await exportRedacted(src, [frac(line)]);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect((await pageTexts(res.bytes))[0]).not.toContain('SECRET-DENSE-LINE');
	}, T);
});

async function survey2(): Promise<Source> {
	return engine().openPdf(corpus('redact-survey-2.pdf'), 'redact-survey-2.pdf');
}

/** Characters of a page with their left edges (MuPDF, page space). */
async function charsOf(bytes: Uint8Array, pageIndex: number): Promise<{ c: string; x: number; y: number }[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	try {
		const out: { c: string; x: number; y: number }[] = [];
		doc.loadPage(pageIndex)
			.toStructuredText('preserve-whitespace')
			.walk({ onChar: (c, _o, _f, _s, q) => out.push({ c, x: q[0], y: q[1] }) });
		return out;
	} finally {
		doc.destroy();
	}
}

describe('redaction: text next to a box stays (redact-survey-2.pdf pages 1-2)', () => {
	it('a lone space under the box does not take glyphs of the big line below', async () => {
		const src = await survey2();
		const res = await exportRedacted(src, [frac(cases[0].box, 612, 792, 0)], 0);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const text = (await pageTexts(res.bytes))[0];
		expect(text).not.toMatch(/SECRET|A B/);
		for (const k of cases[0].keep!) expect(text).toContain(k);
		expect(res.warnings.join(' ')).not.toMatch(/removed whole/);
	}, T);

	it('a lowercase line whose ink ends 2 pt below the box stays whole', async () => {
		const src = await survey2();
		const res = await exportRedacted(src, [frac(cases[1].box, 612, 792, 0)], 1);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const text = (await pageTexts(res.bytes))[1];
		expect(text).not.toContain('SECRET');
		for (const k of cases[1].keep!) expect(text).toContain(k);
		expect(res.warnings.join(' ')).not.toMatch(/removed whole/);
	}, T);

	it('counts every letter removed beyond a box in the warning, also those only next to it', async () => {
		const src = await survey2();
		// 3 pt lower: the box now reaches the core band of the lowercase line (0.5 em above
		// its baseline), so its letters go though their ink stays outside the box.
		const [x0, y0, x1, y1] = cases[1].box;
		const res = await exportRedacted(src, [frac([x0, y0 - 3, x1, y1], 612, 792, 0)], 1);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const left = (await charsOf(res.bytes, 1)).filter((c) => c.y > 175 && c.y < 190 && c.c.trim()).length;
		const gone = cases[1].keep![0].replace(/ /g, '').length - left;
		expect(gone).toBeGreaterThan(0);
		expect(res.warnings.join(' ')).toMatch(new RegExp(`${gone} letters only partly under a redaction box, or just next to one, were removed whole`));
	}, T);
});

describe('redaction: MuPDF rewrites move scaled text (redact-survey-2.pdf page 3)', () => {
	it('rewrites the page once when no image is under the box, so scaled text moves less than half a point', async () => {
		const src = await survey2();
		const before = (await charsOf(src.bytes, 2)).filter((c) => c.y > 370 && c.y < 390);
		const res = await exportRedacted(src, [frac(cases[2].noImage!, 612, 792, 0)], 2);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const after = (await charsOf(res.bytes, 2)).filter((c) => c.y > 370 && c.y < 390);
		expect(after.map((c) => c.c).join('')).toBe(cases[2].scaled);
		const moved = Math.max(...after.map((c, i) => Math.abs(c.x - before[i].x)));
		expect(moved).toBeLessThan(0.5);
	}, T);

	it('refuses when the image pass moves the scaled text half a point or more', async () => {
		const src = await survey2();
		const err = await refusal(exportRedacted(src, [frac(cases[2].box, 612, 792, 0)], 2));
		expect(err.code).toBe('unsupported');
		expect(err.message).toMatch(/would also remove or move text outside it/);
	}, T);
});

describe('redaction: what goes whole is announced (redact-survey-2.pdf pages 4-5)', () => {
	it('warns when an annotation touching a box is removed', async () => {
		const src = await survey2();
		const res = await exportRedacted(src, [frac(cases[3].box, 612, 792, 0)], 3);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.warnings.join(' ')).toMatch(/2 comments or other annotations touching a redaction box were removed whole/);
	}, T);

	it('warns when a gradient touching a box is removed whole beyond it', async () => {
		const src = await survey2();
		const res = await exportRedacted(src, [frac(cases[4].box, 612, 792, 0)], 4);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.warnings.join(' ')).toMatch(/A drawing \(lines, shapes, gradients or outlined text\) touching a redaction box was removed whole/);
	}, T);
});

/** Mean RGB of a user-space rect of a page, rendered by MuPDF at 1 px/pt (inset 2 px). */
async function meanColour(bytes: Uint8Array, pageIndex: number, [x0, y0, x1, y1]: number[]): Promise<number[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const pix = doc.loadPage(pageIndex).toPixmap(m.Matrix.identity, m.ColorSpace.DeviceRGB, false, true);
	try {
		const stride = pix.getStride();
		const px = pix.getPixels();
		const sum = [0, 0, 0];
		let n = 0;
		for (let y = Math.ceil(792 - y1) + 2; y < Math.floor(792 - y0) - 2; y++) {
			for (let x = Math.ceil(x0) + 2; x < Math.floor(x1) - 2; x++) {
				for (let k = 0; k < 3; k++) sum[k] += px[y * stride + x * 3 + k];
				n++;
			}
		}
		return sum.map((v) => v / n);
	} finally {
		pix.destroy();
		doc.destroy();
	}
}

describe('redaction: a clipped drawing (redact-survey-2.pdf page 6)', () => {
	it('keeps a drawing whose outline runs under the box but whose clip keeps it away', async () => {
		const src = await survey2();
		const before = await meanColour(src.bytes, 5, cases[5].clip!);
		const res = await exportRedacted(src, [frac(cases[5].box, 612, 792, 0)], 5);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect((await pageTexts(res.bytes))[5]).not.toContain('SECRET');
		expect(res.warnings.join(' ')).not.toMatch(/removed whole/);
		const after = await meanColour(res.bytes, 5, cases[5].clip!);
		after.forEach((v, i) => expect(Math.abs(v - before[i])).toBeLessThan(1));
	}, T);

	it('still removes it when the box reaches into what it paints', async () => {
		const src = await survey2();
		// A box over the label and up into the clipped area.
		const [x0, y0, x1] = cases[5].box;
		const res = await exportRedacted(src, [frac([x0, y0, Math.max(x1, 160), 420], 612, 792, 0)], 5);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.warnings.join(' ')).toMatch(/A drawing .* was removed whole/);
		const after = await meanColour(res.bytes, 5, [200, 500, 290, 590]);
		expect(Math.min(...after)).toBeGreaterThan(250);
	}, T);
});
