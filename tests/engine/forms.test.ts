/**
 * Forms: detection at intake and the field list (forms.ts). Exports are in
 * forms-export.test.ts. Corpus: tests/corpus/generate-forms.mjs.
 */
import { describe, expect, it } from 'vitest';
import type { FormField } from '../../src/lib/core/types';
import { detectForm, undrawableChars, widgetBox, XFA_NOTE } from '../../src/lib/engine/forms';
import { Qpdf } from '../../src/lib/engine/qpdf';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { corpus, engine, loadPdfjs, manifest, nodeAssets, openCorpus } from './helpers';

const T = 60_000;

const byName = (fields: FormField[]) => new Map(fields.map((f) => [f.name, f]));

describe('detectForm', () => {
	const deps = (mupdf: EngineDeps['mupdf']) => ({ qpdf: new Qpdf(nodeAssets().qpdf), mupdf }) as unknown as EngineDeps;
	const noMupdf = deps(() => Promise.reject(new Error('MuPDF must not load for this file')));

	it('does not load MuPDF for files without an AcroForm', async () => {
		for (const name of ['multi.pdf', 'sizes.pdf', 'objstm.pdf', 'cropbox.pdf']) {
			expect(await detectForm(noMupdf, corpus(name))).toEqual({ hasForm: false, notes: [] });
		}
	}, T);

	it('reports fillable forms and refuses XFA with a note', async () => {
		const real = deps(() => import('mupdf'));
		expect(await detectForm(real, corpus('forms-kinds.pdf'))).toEqual({ hasForm: true, notes: [] });
		expect(await detectForm(real, corpus('forms-xfa.pdf'))).toEqual({ hasForm: false, notes: [XFA_NOTE] });
	}, T);

	it('openPdf sets hasForm and the XFA note', async () => {
		expect((await openCorpus('forms-kinds.pdf')).hasForm).toBe(true);
		expect((await openCorpus('forms-calc.pdf')).hasForm).toBe(true);
		expect((await openCorpus('forms-enc.pdf', 'form')).hasForm).toBe(true);
		expect((await openCorpus('multi.pdf')).hasForm).toBeUndefined();
		const xfa = await openCorpus('forms-xfa.pdf');
		expect(xfa.hasForm).toBeUndefined();
		expect(xfa.notes).toContain(XFA_NOTE);
		expect(await engine().formFields(xfa)).toEqual([]);
	}, T);
});

describe('formFields: what is listed', () => {
	it('lists the fillable kinds and leaves out the rest', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const fields = await engine().formFields(src);
		expect(fields.map((f) => f.name)).toEqual(manifest['forms-kinds.pdf'].listed);
		for (const name of manifest['forms-kinds.pdf'].notListed as string[]) {
			expect(fields.some((f) => f.name === name)).toBe(false);
		}
	}, T);

	it('reads values, flags and labels', async () => {
		const f = byName(await engine().formFields(await openCorpus('forms-kinds.pdf')));
		expect(f.get('name')).toMatchObject({ kind: 'text', label: 'Full name', value: 'Ada Lovelace', readOnly: false, multiline: false });
		expect(f.get('name')!.maxLength).toBeUndefined();
		expect(f.get('notes')).toMatchObject({ kind: 'text', multiline: true, value: '' });
		expect(f.get('zip')).toMatchObject({ maxLength: 5, readOnly: false });
		expect(f.get('code')).toMatchObject({ maxLength: 6, readOnly: false });
		expect(f.get('ro')).toMatchObject({ value: 'Fixed', readOnly: true });
		// /TU absent: no label (MuPDF would fall back to the name).
		for (const n of ['notes', 'person.first', 'person.last', 'country']) expect(f.get(n)!.label).toBeUndefined();
		expect(f.get('agree')).toMatchObject({ kind: 'checkbox', value: true });
		expect(f.get('opt_in')).toMatchObject({ kind: 'checkbox', value: false });
		expect(f.get('person.first')).toMatchObject({ kind: 'text', value: '' });
	}, T);

	it('radio: option names follow /Opt (PDF.js vocabulary) or the state names; groups across pages', async () => {
		const f = byName(await engine().formFields(await openCorpus('forms-kinds.pdf')));
		const color = f.get('color')!;
		expect(color.value).toBe('green');
		expect(color.widgets.map((w) => [w.pageIndex, w.option])).toEqual([
			[0, 'red'],
			[0, 'green'],
			[0, 'blue']
		]);
		const size = f.get('size')!;
		expect(size.value).toBe('');
		expect(size.widgets.map((w) => [w.pageIndex, w.option])).toEqual([
			[0, 'S'],
			[0, 'M'],
			[1, 'L']
		]);
		expect(f.get('shared')!.widgets.map((w) => w.pageIndex)).toEqual([0, 1]);
	}, T);

	it('radio options and values agree with PDF.js', async () => {
		const src = await openCorpus('forms-kinds.pdf');
		const f = byName(await engine().formFields(src));
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: src.bytes.slice(), verbosity: 0 });
		const doc = await task.promise;
		const seen: [string, unknown, unknown][] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			for (const a of (await (await doc.getPage(i)).getAnnotations()) as { radioButton?: boolean; fieldName: string; buttonValue: unknown; fieldValue: unknown }[]) {
				if (a.radioButton) seen.push([a.fieldName, a.buttonValue, a.fieldValue]);
			}
		}
		await task.destroy();
		const ours = ['color', 'size'].flatMap((n) => f.get(n)!.widgets.map((w) => [n, w.option, f.get(n)!.value || null]));
		expect(seen).toEqual(ours);
	}, T);

	it('choice: export values differ from labels; list boxes are read-only', async () => {
		const f = byName(await engine().formFields(await openCorpus('forms-kinds.pdf')));
		expect(f.get('country')).toMatchObject({
			kind: 'choice',
			value: ['ca'],
			readOnly: false,
			options: [
				{ value: 'us', label: 'United States' },
				{ value: 'ca', label: 'Canada' }
			]
		});
		expect(f.get('country')!.multiSelect).toBeUndefined();
		expect(f.get('langs')).toMatchObject({ kind: 'choice', value: ['English', 'German'], readOnly: true, multiSelect: true });
	}, T);

	it('calculated fields are read-only; formatted ones are not', async () => {
		const f = byName(await engine().formFields(await openCorpus('forms-calc.pdf')));
		expect(f.get('total')!.readOnly).toBe(true);
		for (const n of ['qty', 'price', 'date']) expect(f.get(n)!.readOnly).toBe(false);
	}, T);

	it('an encrypted source lists the same fields as its plain copy', async () => {
		const plain = await engine().formFields(await openCorpus('forms-kinds.pdf'));
		const enc = await engine().formFields(await openCorpus('forms-enc.pdf', 'form'));
		expect(enc).toEqual(plain);
	}, T);

	it('existing corpus form (form.pdf)', async () => {
		const f = await engine().formFields(await openCorpus('form.pdf'));
		expect(f.map((x) => [x.name, x.kind, x.value])).toEqual([
			['name', 'text', 'Ada Lovelace'],
			['agree', 'checkbox', true],
			['notes', 'text', '']
		]);
	}, T);
});

describe('widget boxes', () => {
	it('hand-calculated: rotation and an offset CropBox', () => {
		const page = { x0: 50, y0: 60, x1: 562, y1: 732 }; // 512 x 672
		const r = { x0: 100, y0: 200, x1: 300, y1: 224 };
		const close = (got: ReturnType<typeof widgetBox>, want: number[]) =>
			expect([got!.x, got!.y, got!.w, got!.h].map((n, i) => Math.abs(n - want[i]) < 1e-5)).toEqual([true, true, true, true]);
		close(widgetBox(r, page, 0), [50 / 512, 508 / 672, 200 / 512, 24 / 672]);
		// 90: displayed 672 wide, 512 high; display x = y - y0, display y = x - x0.
		const b90 = widgetBox(r, page, 90)!;
		expect(b90.x).toBeCloseTo(140 / 672, 6);
		expect(b90.y).toBeCloseTo(50 / 512, 6);
		expect(b90.w).toBeCloseTo(24 / 672, 6);
		expect(b90.h).toBeCloseTo(200 / 512, 6);
		// Off the page: nothing shows.
		expect(widgetBox({ x0: 0, y0: 0, x1: 40, y1: 40 }, page, 0)).toBeNull();
		// Partly off: clipped.
		close(widgetBox({ x0: 0, y0: 700, x1: 100, y1: 800 }, page, 0), [0, 0, 50 / 512, 32 / 672]);
	});

	it('match PDF.js viewport rectangles on rotated pages and offset CropBoxes', async () => {
		const src = await openCorpus('forms-geometry.pdf');
		const fields = byName(await engine().formFields(src));
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: src.bytes.slice(), verbosity: 0 });
		const doc = await task.promise;
		let checked = 0;
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const vp = page.getViewport({ scale: 1 });
			for (const a of (await page.getAnnotations()) as { fieldName: string; rect: number[] }[]) {
				const box = fields.get(a.fieldName)!.widgets[0].box;
				const t = vp.transform;
				const pt = (x: number, y: number) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
				const [x0, y0] = pt(a.rect[0], a.rect[1]);
				const [x1, y1] = pt(a.rect[2], a.rect[3]);
				const want = {
					x: Math.min(x0, x1) / vp.width,
					y: Math.min(y0, y1) / vp.height,
					w: Math.abs(x1 - x0) / vp.width,
					h: Math.abs(y1 - y0) / vp.height
				};
				for (const k of ['x', 'y', 'w', 'h'] as const) expect(box[k]).toBeCloseTo(want[k], 5);
				expect(fields.get(a.fieldName)!.widgets[0].pageIndex).toBe(i - 1);
				checked++;
			}
		}
		await task.destroy();
		expect(checked).toBe(8);
	}, T);
});

describe('undrawableChars', () => {
	it('allows WinAnsi only', () => {
		expect(undrawableChars('Grüße, Café — “quotes” € ½ ÿ\nnext')).toBe('');
		expect(undrawableChars('Ωμέγα 漢字 Ω')).toBe('Ω μ έ γ α 漢 字');
		expect(undrawableChars('soft­hyphen')).toBe('­');
		expect(undrawableChars('emoji 🙂')).toBe('🙂');
	});
});
