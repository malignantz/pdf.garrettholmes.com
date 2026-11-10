import { describe, expect, it } from 'vitest';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { ExportOptions, PageNumbering, PageRef, Rotation, Source, Stamp } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { numberingLabels, verifyNumbering } from '../../src/lib/engine/numbering';
import { defaultOptions, engine, loadPdfjs, nodeAssets, openCorpus, ref } from './helpers';
import { makeSource, render, type PageSpec } from './render-helpers';

const T = 120_000;
const base: PageNumbering = { style: 'n', position: 'bottom-center', start: 1, skip: 0, size: 12 };

async function exportWith(pages: PageRef[], sources: Source[], numbering: PageNumbering, options: Partial<ExportOptions> = {}) {
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, ...options, numbering } }, sources, []);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res;
}

interface Found {
	text: string;
	W: number;
	H: number;
	left: number;
	right: number;
	/** Baseline distance from the displayed top edge. */
	baseline: number;
	upright: boolean;
}

/** Independent read-back with PDF.js: every text item as displayed, in points. */
async function items(bytes: Uint8Array, pageNo: number, password?: string): Promise<Found[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const page = await doc.getPage(pageNo);
		const vp = page.getViewport({ scale: 1 });
		const tc = await page.getTextContent();
		const out: Found[] = [];
		for (const it of tc.items) {
			if (!('str' in it) || !it.str.trim()) continue;
			const [a, b, , , e, f] = it.transform as number[];
			const h = Math.hypot(a, b);
			const [x0, y0] = vp.convertToViewportPoint(e, f) as [number, number];
			const [x1, y1] = vp.convertToViewportPoint(e + (it.width * a) / h, f + (it.width * b) / h) as [number, number];
			out.push({ text: it.str, W: vp.width, H: vp.height, left: x0, right: x1, baseline: y0, upright: Math.abs(y1 - y0) < 0.5 && x1 > x0 });
		}
		return out;
	} finally {
		await task.destroy();
	}
}

async function find(bytes: Uint8Array, pageNo: number, label: string, password?: string): Promise<Found> {
	const all = await items(bytes, pageNo, password);
	const hit = all.find((i) => i.text.replace(/\s/g, '') === label.replace(/\s/g, ''));
	expect(hit, `label "${label}" on page ${pageNo}; saw ${all.map((i) => i.text).join('|')}`).toBeTruthy();
	expect(hit!.upright, 'label is upright').toBe(true);
	return hit!;
}

function expectPlace(f: Found, position: PageNumbering['position'], size: number, m = 36) {
	if (position.startsWith('bottom')) expect(f.H - f.baseline).toBeCloseTo(m, 0);
	else expect(f.baseline - 0.714 * size).toBeCloseTo(m, 0);
	if (position.endsWith('left')) expect(f.left).toBeCloseTo(m, 0);
	else if (position.endsWith('right')) expect(f.W - f.right).toBeCloseTo(m, 0);
	else expect((f.left + f.right) / 2).toBeCloseTo(f.W / 2, 0);
}

describe('numbers in exports', () => {
	it('every style and position on a letter page', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 612, h: 792 }, { w: 612, h: 792 }]);
		const pages = [0, 1, 2].map((i) => ref(src, i));
		const styles: [PageNumbering['style'], string[]][] = [
			['n', ['1', '2', '3']],
			['n-of-total', ['1 of 3', '2 of 3', '3 of 3']],
			['page-n', ['Page 1', 'Page 2', 'Page 3']],
			['page-n-of-total', ['Page 1 of 3', 'Page 2 of 3', 'Page 3 of 3']]
		];
		for (const [style, want] of styles) {
			const res = await exportWith(pages, [src], { ...base, style });
			const chk = res.checks.find((c) => c.name === 'numbering');
			expect(chk?.ok).toBe(true);
			for (let i = 0; i < 3; i++) expectPlace(await find(res.bytes, i + 1, want[i]), 'bottom-center', 12);
		}
		for (const position of ['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'] as const) {
			const res = await exportWith(pages, [src], { ...base, style: 'page-n-of-total', position, size: 14 });
			for (let i = 0; i < 3; i++) expectPlace(await find(res.bytes, i + 1, `Page ${i + 1} of 3`), position, 14);
		}
	}, T);

	it('bates with prefix and digits; start and skip', async () => {
		const src = await makeSource(Array.from({ length: 5 }, () => ({ w: 612, h: 792 })));
		const pages = [0, 1, 2, 3, 4].map((i) => ref(src, i));
		const res = await exportWith(pages, [src], {
			...base,
			style: 'bates',
			position: 'bottom-right',
			start: 41,
			skip: 2,
			bates: { prefix: 'ABC-', digits: 6 }
		});
		const chk = res.checks.find((c) => c.name === 'numbering')!;
		expect(chk.detail).toBe('Bates ABC-000041 to ABC-000043 are on their pages.');
		for (let i = 0; i < 2; i++) {
			const all = await items(res.bytes, i + 1);
			expect(all.some((x) => /ABC/.test(x.text))).toBe(false);
		}
		for (let i = 2; i < 5; i++) expectPlace(await find(res.bytes, i + 1, `ABC-0000${41 + i - 2}`), 'bottom-right', 12);
	}, T);

	it('detail for plain numbers', async () => {
		const src = await makeSource(Array.from({ length: 12 }, () => ({ w: 200, h: 300 })));
		const res = await exportWith(
			Array.from({ length: 12 }, (_, i) => ref(src, i)),
			[src],
			base
		);
		expect(res.checks.find((c) => c.name === 'numbering')!.detail).toBe('Numbers 1 to 12 are on their pages.');
	}, T);

	const specs: Record<string, PageSpec> = {
		letter: { w: 612, h: 792 },
		src90: { w: 612, h: 792, rotate: 90 },
		src270: { w: 612, h: 792, rotate: 270 },
		crop: { w: 612, h: 792, crop: [100, 150, 500, 650] },
		cropRot: { w: 612, h: 792, crop: [100, 150, 500, 650], rotate: 180 },
		unit: { w: 300, h: 200, userUnit: 2 },
		unitRot: { w: 300, h: 200, userUnit: 2, rotate: 90 }
	};
	for (const [name, spec] of Object.entries(specs)) {
		for (const rotation of [0, 90, 180, 270] as Rotation[]) {
			it(`${name} with user rotation ${rotation}: upright, 36 pt from the displayed edges`, async () => {
				const src = await makeSource([spec]);
				for (const position of ['top-left', 'bottom-right', 'top-center'] as const) {
					const res = await exportWith([ref(src, 0, rotation)], [src], { ...base, position, size: 10 });
					expectPlace(await find(res.bytes, 1, '1'), position, 10);
				}
				// Pixels: ink appears in the bottom-centre margin, as seen by MuPDF.
				const res = await exportWith([ref(src, 0, rotation)], [src], { ...base, size: 18 });
				const plain = await engine().exportPlan({ pages: [ref(src, 0, rotation)], options: defaultOptions }, [src], []);
				const a = await render(plain.bytes, 0);
				const b = await render(res.bytes, 0);
				let ink = 0;
				let elsewhere = 0;
				for (let y = 0; y < a.h; y++) {
					for (let x = 0; x < a.w; x++) {
						const o = (y * a.w + x) * 3;
						if (Math.abs(a.px[o] - b.px[o]) > 40) {
							const fromBottom = a.h - y;
							// The page's own printing is the same in both; only the number differs.
							if (fromBottom > 20 && fromBottom < 52 && Math.abs(x - a.w / 2) < 40) ink++;
							else elsewhere++;
						}
					}
				}
				expect(ink).toBeGreaterThan(20);
				expect(elsewhere).toBe(0);
			}, T);
		}
	}

	it('mixed page sizes, small pages shrink the margin', async () => {
		const src = await openCorpus('sizes.pdf');
		const pages = [0, 1, 2, 3, 4, 5].map((i) => ref(src, i));
		const res = await exportWith(pages, [src], { ...base, position: 'bottom-right', size: 8 });
		const dims: [number, number][] = [
			[612, 792],
			[595.28, 841.89],
			[612, 1008],
			[595.28, 419.53],
			[100, 60],
			[1224, 792]
		];
		for (let i = 0; i < 6; i++) {
			const f = await find(res.bytes, i + 1, String(i + 1));
			const m = Math.min(36, dims[i][0] / 4, dims[i][1] / 4);
			expect(f.W).toBeCloseTo(dims[i][0], 1);
			expectPlace(f, 'bottom-right', 8, m);
		}
	}, T);

	it('works with a password, other stamps, compress and a redaction-free stamp page', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 612, h: 792 }]);
		const stamps: Stamp[] = [
			{ id: 'h', kind: 'highlight', color: 'yellow', box: { x: 0.3, y: 0.9, w: 0.4, h: 0.06 } },
			{ id: 't', kind: 'text', text: 'Approved', x: 0.1, y: 0.1, size: 0.03, color: 'red' }
		];
		const res = await exportWith([ref(src, 0, 0, stamps), ref(src, 1)], [src], { ...base, position: 'bottom-center' }, { password: 'pw', compress: true });
		expect((await items(res.bytes, 1, 'pw')).some((i) => i.text === 'Approved')).toBe(true);
		expectPlace(await find(res.bytes, 1, '1', 'pw'), 'bottom-center', 12);
		expectPlace(await find(res.bytes, 2, '2', 'pw'), 'bottom-center', 12);
		// Render shows both highlight tint and number.
		const r = await render(res.bytes, 0, 1, 'pw');
		expect(r.at(0.5, 0.915)[2]).toBeLessThan(120);
	}, T);

	it('page text that contains the same digits does not satisfy the check', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		const res = await exportWith([ref(src, 0)], [src], { ...base, position: 'top-left' });
		// The number is not in the bottom-centre margin, so asking for that must fail.
		const bad = await verifyNumbering(await depsFor(), res.bytes, ['1'], undefined, { position: 'bottom-center', size: 12 });
		expect(bad[0].ok).toBe(false);
		const good = await verifyNumbering(await depsFor(), res.bytes, ['1'], undefined, { position: 'top-left', size: 12 });
		expect(good[0].ok).toBe(true);
	}, T);

	it('verifyNumbering fails for wrong labels, wrong count, missing page and passes null pages', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 612, h: 792 }, { w: 612, h: 792 }]);
		const pages = [0, 1, 2].map((i) => ref(src, i));
		const res = await exportWith(pages, [src], { ...base, skip: 1 });
		const d = await depsFor();
		const opt = { position: base.position, size: base.size };
		const ok = await verifyNumbering(d, res.bytes, [null, '1', '2'], undefined, opt);
		expect(ok).toEqual([{ name: 'numbering', ok: true, detail: 'Numbers 1 to 2 are on their pages.' }]);
		const wrong = await verifyNumbering(d, res.bytes, [null, '1', '3'], undefined, opt);
		expect(wrong[0].ok).toBe(false);
		expect(wrong[0].detail).toContain('page 3');
		const unnumbered = await verifyNumbering(d, res.bytes, ['9', '1', '2'], undefined, opt);
		expect(unnumbered[0].ok).toBe(false);
		const count = await verifyNumbering(d, res.bytes, [null, '1'], undefined, opt);
		expect(count[0].ok).toBe(false);
		expect(await verifyNumbering(d, res.bytes, [null, null, null])).toEqual([]);
	}, T);

	it('refuses when every page is skipped and when Bates digits are too few', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		await expect(exportWith([ref(src, 0)], [src], { ...base, skip: 1 })).rejects.toBeInstanceOf(EngineError);
		expect(() => numberingLabels({ ...base, style: 'bates', bates: { prefix: 'A', digits: 3 } }, 1000)).toThrow();
	}, T);

	it('300 pages stay fast', async () => {
		const doc = await PDFDocument.create({ updateMetadata: false });
		for (let i = 0; i < 300; i++) doc.addPage([612, 792]).drawText(`body ${i + 1}`, { x: 100, y: 400, size: 12 });
		const src = await engine().openPdf(await doc.save(), 'big.pdf');
		const t0 = performance.now();
		const res = await exportWith(
			Array.from({ length: 300 }, (_, i) => ref(src, i, ((i % 4) * 90) as Rotation)),
			[src],
			{ ...base, style: 'page-n-of-total', position: 'top-right' },
			{ compress: true }
		);
		const ms = performance.now() - t0;
		console.log(`[perf] 300 numbered pages: ${ms.toFixed(0)} ms`);
		expect(ms).toBeLessThan(30_000);
		expect(res.checks.find((c) => c.name === 'numbering')!.detail).toBe('Numbers "Page 1 of 300" to "Page 300 of 300" are on their pages.');
		const f = await find(res.bytes, 299, 'Page 299 of 300');
		expectPlace(f, 'top-right', 12);
	}, 180_000);
});

async function depsFor() {
	const assets = nodeAssets();
	const lib = await loadPdfjs();
	return { pdfjs: async () => lib, assets } as unknown as Parameters<typeof verifyNumbering>[0];
}
