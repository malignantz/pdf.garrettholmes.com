import { describe, expect, it } from 'vitest';
import { defaultOptions, engine, loadPdfjs, openCorpus, pageTexts, ref } from './helpers';
import { corpus } from './helpers';
import { EngineError } from '../../src/lib/engine/errors';

const T = 30_000;

/** Layer name → visible by default, as PDF.js reads the file's optional content config. */
async function layerStates(bytes: Uint8Array): Promise<Record<string, boolean>> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	try {
		const doc = await task.promise;
		const config = await doc.getOptionalContentConfig();
		const out: Record<string, boolean> = {};
		for (const [, group] of config) out[(group as { name: string }).name] = (group as { visible: boolean }).visible;
		return out;
	} finally {
		await task.destroy();
	}
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe('assemble keeps optional content (layers)', () => {
	it('keeps a hidden layer hidden in a plain export', async () => {
		const src = await openCorpus('layers.pdf');
		expect(await layerStates(src.bytes)).toEqual({ Hidden: false, Shown: true });
		for (const compress of [false, true]) {
			const res = await engine().exportPlan({ pages: [ref(src, 0)], options: { ...defaultOptions, compress } }, [src], []);
			expect(await layerStates(res.bytes)).toEqual({ Hidden: false, Shown: true });
			expect(latin1(res.bytes)).not.toContain('PdfgOptionalContent');
		}
	}, T);

	it('merges layers of several files; /BaseState /OFF stays hidden', async () => {
		const a = await openCorpus('layers.pdf');
		const b = await openCorpus('layers-base-off.pdf');
		const plain = await openCorpus('multi.pdf');
		expect(await layerStates(b.bytes)).toEqual({ Off: false, On: true });
		const res = await engine().exportPlan(
			{ pages: [ref(b, 1), ref(plain, 0), ref(a, 0, 90), ref(b, 0), ref(a, 0)], options: defaultOptions },
			[a, b, plain],
			[]
		);
		expect(await layerStates(res.bytes)).toEqual({ Hidden: false, Shown: true, Off: false, On: true });
		expect(latin1(res.bytes)).not.toContain('PdfgOptionalContent');
		expect(await pageTexts(res.bytes)).toHaveLength(5);
	}, T);
});

describe('intake: files readers disagree about', () => {
	it('refuses a file whose update redefines an object with another generation', async () => {
		let err: unknown;
		try {
			await engine().openPdf(corpus('gen-conflict.pdf'), 'gen-conflict.pdf');
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(EngineError);
		expect((err as EngineError).code).toBe('unreadable');
		expect((err as EngineError).message).toMatch(/readers disagree/);
	}, T);

	it('opens a file that legitimately reuses an object number', async () => {
		const s = await openCorpus('gen-reuse.pdf');
		expect(await pageTexts(s.bytes)).toEqual(['gen-reuse p1']);
	}, T);
});

/** Every PDF.js field object per full name: [value, ...]. */
async function fieldValues(bytes: Uint8Array): Promise<Record<string, unknown[]>> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	try {
		const doc = await task.promise;
		const raw = (await doc.getFieldObjects()) as unknown;
		const objs = (raw instanceof Map ? Object.fromEntries(raw) : (raw ?? {})) as Record<string, { value?: unknown }[]>;
		return Object.fromEntries(Object.entries(objs).map(([k, v]) => [k, v.map((x) => x.value)]));
	} finally {
		await task.destroy();
	}
}

describe('forms: fields with widgets on several pages', () => {
	it('gives the off-page copies the same answer', async () => {
		const src = await openCorpus('form-split.pdf');
		const fields = await engine().formFields(src);
		expect(fields.map((f) => f.name).sort()).toEqual(['Fine.Note', 'Fine.SA']);
		const res = await engine().exportPlan(
			{ pages: [ref(src, 0), ref(src, 1)], options: defaultOptions, formValues: { [src.id]: { 'Fine.SA': true, 'Fine.Note': 'new answer' } } },
			[src],
			[]
		);
		const values = await fieldValues(res.bytes);
		// The assemble step renames the per-page copies; whatever the name, no copy keeps the old answer.
		const all = (base: string) => Object.entries(values).filter(([k]) => k.replace(/\+\d+/g, '') === base).flatMap(([, v]) => v);
		expect(all('Fine.SA').length).toBeGreaterThan(1);
		expect(new Set(all('Fine.SA'))).toEqual(new Set(['Yes']));
		expect(all('Fine.Note').length).toBeGreaterThan(1);
		expect(new Set(all('Fine.Note'))).toEqual(new Set(['new answer']));
	}, T);
});
