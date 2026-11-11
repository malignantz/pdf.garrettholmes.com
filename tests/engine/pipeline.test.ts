/**
 * Phase 2 pipeline skeleton: the stage modules are wired in, the cross-stage rules
 * hold, and the stubs refuse clearly. Stage behaviour itself is tested in each
 * module's own test file as the streams land.
 */
import { describe, expect, it } from 'vitest';
import type { EngineErrorShape, ExportOptions, ExportPlan, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { corpus, defaultOptions, engine, openCorpus, ref } from './helpers';

const T = 60_000;

async function rejects(p: Promise<unknown>): Promise<EngineErrorShape> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineErrorShape;
	}
	throw new Error('expected a rejection');
}

function run(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}, extra: Partial<ExportPlan> = {}) {
	return engine().exportPlan({ pages, options: { ...defaultOptions, ...options }, ...extra }, sources, []);
}

const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };

describe('MuPDF loader', () => {
	it('loads in Node once and opens a PDF', async () => {
		const a = mupdf();
		expect(mupdf()).toBe(a);
		const m = await a;
		const doc = m.Document.openDocument(corpus('multi.pdf'), 'application/pdf');
		expect(doc.countPages()).toBe(6);
	}, T);
});

describe('formFields', () => {
	it('is [] for a source without a form; form.pdf reports its fields (details in forms.test.ts)', async () => {
		const plain = await openCorpus('multi.pdf');
		expect(plain.hasForm).toBeUndefined();
		expect(await engine().formFields(plain)).toEqual([]);
		const src = await openCorpus('form.pdf');
		expect(src.hasForm).toBe(true);
		expect((await engine().formFields(src)).map((f) => f.name)).toEqual(['name', 'agree', 'notes']);
	}, T);
});

describe('export pipeline rules', () => {
	it('validates new stamp kinds', async () => {
		const src = await openCorpus('multi.pdf');
		const out: Stamp = { id: 's', kind: 'redact', box: { x: 0.9, y: 0.1, w: 0.2, h: 0.1 } };
		expect((await rejects(run([ref(src, 0, 0, [out])], [src]))).code).toBe('unsupported');
		const empty: Stamp = { id: 's', kind: 'highlight', color: 'yellow', box: { ...box, w: 0 } };
		expect((await rejects(run([ref(src, 0, 0, [empty])], [src]))).code).toBe('unsupported');
		const colour = { id: 's', kind: 'highlight', color: 'orange', box } as unknown as Stamp;
		expect((await rejects(run([ref(src, 0, 0, [colour])], [src]))).code).toBe('internal');
		const kind = { id: 's', kind: 'sticker', box } as unknown as Stamp;
		expect((await rejects(run([ref(src, 0, 0, [kind])], [src]))).code).toBe('internal');
	}, T);

	it('validates pen highlight strokes', async () => {
		const src = await openCorpus('multi.pdf');
		const pb = { x: 0.1, y: 0.1, w: 0.5, h: 0.1 };
		const pts = [
			{ x: 0.12, y: 0.15 },
			{ x: 0.55, y: 0.15 }
		];
		const pen = (p: unknown): Stamp => ({ id: 's', kind: 'highlight', color: 'yellow', box: pb, pen: p }) as unknown as Stamp;
		const good = await run([ref(src, 0, 0, [pen({ points: pts, width: 0.02 })])], [src]);
		expect(good.checks.every((c) => c.ok)).toBe(true);
		for (const bad of [
			{ points: pts.slice(0, 1), width: 0.02 },
			{ points: pts, width: 0 },
			{ points: pts, width: Number.NaN },
			{ points: [pts[0], { x: 0.9, y: 0.15 }], width: 0.02 },
			{ points: [pts[0], { x: 0.3, y: Number.POSITIVE_INFINITY }], width: 0.02 },
			{ points: 'M0 0', width: 0.02 },
			null
		]) {
			expect((await rejects(run([ref(src, 0, 0, [pen(bad)])], [src]))).code, JSON.stringify(bad)).toBe('unsupported');
		}
	}, T);

	it('validates targetBytes', async () => {
		const src = await openCorpus('multi.pdf');
		for (const targetBytes of [19_999, 25_000.5, -1, Number.NaN]) {
			const e = await rejects(run([ref(src, 0)], [src], { targetBytes }));
			expect(e.code).toBe('unsupported');
			expect(e.message).toMatch(/20 KB/);
		}
	}, T);

	it('validates formValues against the open sources', async () => {
		const src = await openCorpus('multi.pdf');
		const e = await rejects(run([ref(src, 0)], [src], {}, { formValues: { ghost: { a: 'x' } } }));
		expect(e.code).toBe('internal');
		const bad = await rejects(run([ref(src, 0)], [src], {}, { formValues: { [src.id]: { a: 3 as never } } }));
		expect(bad.code).toBe('internal');
	}, T);

	it('ignores answers for open sources the plan does not use; empty answers change nothing', async () => {
		const [a, b] = await Promise.all([openCorpus('multi.pdf'), openCorpus('sizes.pdf')]);
		const res = await run([ref(a, 0)], [a, b], {}, { formValues: { [b.id]: { name: 'x' }, [a.id]: {} } });
		expect(res.checks.every((c) => c.ok)).toBe(true);
	}, T);

	it('refuses answers for a field the source does not have', async () => {
		const src = await openCorpus('form.pdf');
		const e = await rejects(run([ref(src, 0)], [src], {}, { formValues: { [src.id]: { nosuch: 'Grace' } } }));
		expect(e.code).toBe('unsupported');
	}, T);

	it('flattenForms on a file without a form exports normally', async () => {
		const src = await openCorpus('multi.pdf');
		const res = await run([ref(src, 0)], [src], { flattenForms: true });
		expect(res.pageCount).toBe(1);
	}, T);

	it('refuses numbering settings before building anything', async () => {
		const src = await openCorpus('multi.pdf');
		const allSkipped = await rejects(
			run([ref(src, 0), ref(src, 1)], [src], { numbering: { style: 'n', position: 'top-left', start: 1, skip: 2, size: 10 } })
		);
		expect(allSkipped.message).toMatch(/without a number/);
		const tooSmall = await rejects(
			run([ref(src, 0)], [src], { numbering: { style: 'n', position: 'top-left', start: 1, skip: 0, size: 2 } })
		);
		expect(tooSmall.message).toMatch(/6 and 24/);
		const glyph = await rejects(
			run([ref(src, 0)], [src], {
				numbering: { style: 'bates', position: 'top-left', start: 1, skip: 0, size: 10, bates: { prefix: '✓', digits: 3 } }
			})
		);
		expect(glyph.message).toMatch(/cannot draw: ✓/);
	}, T);

	it('targetBytes forces compression and reports shrink', async () => {
		const src = await openCorpus('multi.pdf');
		const plain = await run([ref(src, 0), ref(src, 1)], [src]);
		expect(plain.shrink).toBeUndefined();
		const res = await run([ref(src, 0), ref(src, 1)], [src], { targetBytes: 1_000_000 });
		expect(res.shrink).toEqual({ targetBytes: 1_000_000, reached: true, imagesChanged: 0, dpi: 0 });
		expect(res.checks.find((c) => c.name === 'target-size')?.ok).toBe(true);
		const compressed = await run([ref(src, 0), ref(src, 1)], [src], { compress: true });
		expect(res.bytes.length).toBe(compressed.bytes.length);
	}, T);

	it('an unreachable target still returns the file, with reached false', async () => {
		// alpha.png is a 64 KB PNG: its page cannot get under 20 KB without shrinking the image.
		const img = await engine().openImage(corpus('alpha.png'), 'image/png', 'alpha.png');
		const res = await run([ref(img, 0)], [img], { targetBytes: 20_000 });
		expect(res.bytes.length).toBeGreaterThan(20_000);
		expect(res.shrink).toEqual({ targetBytes: 20_000, reached: false, imagesChanged: 0, dpi: 0 });
		expect(res.checks.every((c) => c.ok)).toBe(true);
	}, T);
});
