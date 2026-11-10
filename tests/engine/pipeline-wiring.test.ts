/**
 * How core.ts drives the stage modules: order, the context each receives, and the
 * cross-stage rules (redaction forces flatten + metadata removal). The stage
 * modules are replaced by spies that pass the bytes through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Source, Stamp } from '../../src/lib/core/types';

const calls: string[] = [];
const seen: Record<string, unknown[]> = {};
const spy =
	(name: string, result: (args: unknown[]) => unknown) =>
	async (...args: unknown[]) => {
		calls.push(name);
		seen[name] = args;
		return result(args);
	};

vi.mock('../../src/lib/engine/forms', async (orig) => {
	const real = await orig<typeof import('../../src/lib/engine/forms')>();
	return {
		...real,
		applyForms: spy('applyForms', (a) => a[1]),
		verifyForms: spy('verifyForms', () => [{ name: 'forms', ok: true, detail: 'spy' }])
	};
});
vi.mock('../../src/lib/engine/redact', () => ({
	applyRedactions: spy('applyRedactions', (a) => a[1]),
	verifyRedactions: spy('verifyRedactions', () => [{ name: 'redaction', ok: true, detail: 'spy' }])
}));

const { metadataLeft } = await import('../../src/lib/engine/core');
const { defaultOptions, engine, openCorpus, ref } = await import('./helpers');
const { Qpdf } = await import('../../src/lib/engine/qpdf');
const { nodeAssets } = await import('./helpers');

const T = 60_000;
const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.1 };

async function qpdfJson(bytes: Uint8Array) {
	const qpdf = new Qpdf(nodeAssets().qpdf);
	const res = await qpdf.run({ args: ['--json-output', '--json-stream-data=none', '/a.pdf', '/a.json'], inputs: { '/a.pdf': bytes }, outputs: ['/a.json'] });
	const j = JSON.parse(new TextDecoder().decode(res.files.get('/a.json')!));
	return { header: j.qpdf[0], objects: j.qpdf[1] };
}

beforeEach(() => {
	calls.length = 0;
	for (const k of Object.keys(seen)) delete seen[k];
});

describe('stage wiring', () => {
	it('a plan without phase 2 features runs no new stage', async () => {
		const src = await openCorpus('multi.pdf');
		await engine().exportPlan({ pages: [ref(src, 0)], options: defaultOptions }, [src], []);
		expect(calls).toEqual([]);
	}, T);

	it('redaction: forms (flatten forced) → redact → stamps; metadata stripped; jobs and allowed text', async () => {
		const src = await openCorpus('metadata.pdf');
		const stamps: Stamp[] = [
			{ id: 'r1', kind: 'redact', box },
			{ id: 't', kind: 'text', text: 'Hi\nthere', x: 0.1, y: 0.5, size: 0.02, color: 'black' },
			{ id: 'r2', kind: 'redact', box: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 } }
		];
		const pages = [ref(src, 0), ref(src, 0, 90, stamps)];
		const res = await engine().exportPlan({ pages, options: { ...defaultOptions, stripMetadata: false } }, [src], []);
		expect(calls).toEqual(['applyForms', 'applyRedactions', 'verifyForms', 'verifyRedactions']);

		const ctx = seen.applyForms[2] as { pages: { source: Source; pageIndex: number; rotation: number }[]; flatten: boolean; formValues: unknown };
		expect(ctx.flatten).toBe(true);
		expect(ctx.formValues).toEqual({});
		expect(ctx.pages.map((p) => [p.source.id, p.pageIndex, p.rotation])).toEqual([
			[src.id, 0, 0],
			[src.id, 0, 90]
		]);

		const jobs = seen.applyRedactions[2] as { pageIndex: number; boxes: unknown[]; expected: { width: number; height: number } }[];
		expect(jobs).toHaveLength(1);
		expect(jobs[0].pageIndex).toBe(1);
		expect(jobs[0].boxes).toEqual([box, { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }]);
		expect(jobs[0].expected).toEqual({ width: src.pages[0].height, height: src.pages[0].width });
		expect(seen.verifyRedactions[3]).toEqual([['Hi', 'there']]);

		// Forced metadata removal, verified like a user-chosen one.
		expect(metadataLeft(await qpdfJson(res.bytes))).toEqual([]);
		expect(res.checks.filter((c) => c.name === 'structure' && /Metadata removed/.test(c.detail))).toHaveLength(1);
		expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['forms', 'redaction']));
	}, T);

	it('form answers reach the forms stage, limited to used sources', async () => {
		const [a, b] = await Promise.all([openCorpus('form.pdf'), openCorpus('multi.pdf')]);
		await engine().exportPlan(
			{ pages: [ref(b, 0), ref(a, 1)], options: defaultOptions, formValues: { [a.id]: { name: 'Grace', agree: true } } },
			[a, b],
			[]
		);
		expect(calls).toEqual(['applyForms', 'verifyForms']);
		const ctx = seen.applyForms[2] as { flatten: boolean; formValues: unknown };
		expect(ctx.flatten).toBe(false);
		expect(ctx.formValues).toEqual({ [a.id]: { name: 'Grace', agree: true } });
	}, T);
});
