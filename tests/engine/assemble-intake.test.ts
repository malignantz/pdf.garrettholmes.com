import { describe, expect, it } from 'vitest';
import { defaultOptions, engine, loadPdfjs, openCorpus, pageTexts, ref } from './helpers';
import { corpus } from './helpers';
import { EngineError } from '../../src/lib/engine/errors';
import { checkProblems } from '../../src/lib/engine/core';

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

async function exportAll(name: string, compress: boolean) {
	const src = await openCorpus(name);
	return engine().exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: { ...defaultOptions, compress } }, [src], []);
}

describe('damaged sources: export or refuse clearly, never crash', () => {
	it('accepts content damage the original already has, and says so', async () => {
		for (const compress of [false, true]) {
			const res = await exportAll('damage-content.pdf', compress);
			const structure = res.checks.find((c) => c.name === 'structure')!;
			expect(structure.ok).toBe(true);
			expect(structure.detail).toMatch(/already has/);
			expect(res.warnings.join(' ')).toMatch(/damaged; it was copied unchanged/);
			expect(await pageTexts(res.bytes)).toEqual(await pageTexts((await openCorpus('damage-content.pdf')).bytes));
		}
	}, T);

	it('compresses a file with an undecodable Flate stream by keeping that stream as is', async () => {
		const res = await exportAll('damage-flate.pdf', true);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(await pageTexts(res.bytes)).toEqual(['damage-flate p1']);
	}, T);

	it('refuses, in plain words, a file whose damage stops the check', async () => {
		for (const compress of [false, true]) {
			let err: unknown;
			try {
				await exportAll('damage-jpeg.pdf', compress);
			} catch (e) {
				err = e;
			}
			expect(err).toBeInstanceOf(EngineError);
			expect((err as EngineError).code).toBe('unreadable');
			expect((err as EngineError).message).toMatch(/damaged and cannot be read/);
		}
	}, T);

	it('opens a page whose content list holds non-streams, without them', async () => {
		const src = await openCorpus('null-contents.pdf');
		expect(src.notes.join(' ')).toMatch(/Removed broken entries/);
		expect(await pageTexts(src.bytes)).toEqual(['null-contents p1', 'null-contents p2']);
		const res = await exportAll('null-contents.pdf', true);
		expect(await pageTexts(res.bytes)).toEqual(['null-contents p1', 'null-contents p2']);
	}, T);

	it('reads qpdf --check problems without numbers or file names', () => {
		const out = [
			'WARNING: page object 3 0 stream 4 0 (content, offset 49): unexpected )',
			'WARNING: /v.pdf (offset 418): input stream is complete but output may still be valid',
			'WARNING: /s.pdf object stream 84 (object 151 0, offset 11645): name with stray # will not work with PDF >= 1.2',
			'this.program: operation succeeded with warnings',
			'this.program: invalid jpeg data reading from buffer'
		].join('\n');
		expect(checkProblems(out)).toEqual({
			warnings: ['unexpected )', 'input stream is complete but output may still be valid', 'name with stray # will not work with PDF >= #.#'],
			fatal: ['invalid jpeg data reading from buffer']
		});
	});
});
