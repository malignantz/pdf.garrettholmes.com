import { describe, expect, it } from 'vitest';
import type { ExportResult } from '../../src/lib/core/types';
import {
	DEFAULT_FORM,
	MB,
	blankFieldsLine,
	buildExportOptions,
	filledBlankCount,
	keepBlanksBlocked,
	keepBlanksHint,
	buildNumbering,
	formatMB,
	numberingPreview,
	parseMegabytes,
	plainCheck,
	redactionCount,
	shrinkSummary,
	targetBytesFor,
	type ExportForm
} from '../../src/lib/workspace/logic';

const form = (over: Partial<ExportForm> = {}): ExportForm => ({ ...DEFAULT_FORM, filename: 'a.pdf', ...over });
const ctx = { pageCount: 12, redactions: 0, hasForm: false };

describe('size target', () => {
	it('parses megabytes', () => {
		expect(parseMegabytes('2')).toBe(2);
		expect(parseMegabytes(' 0,5 ')).toBe(0.5);
		expect(parseMegabytes('0.1')).toBe(0.1);
		expect(parseMegabytes('500')).toBe(500);
		for (const bad of ['', 'abc', '0.09', '501', '-1', '1e3', '1.2.3', '.']) expect(parseMegabytes(bad)).toBeNull();
	});

	it('uses the unit formatBytes shows', () => {
		expect(targetBytesFor('10', '')).toBe(10 * MB);
		expect(targetBytesFor('other', '1.5')).toBe(Math.round(1.5 * MB));
		expect(targetBytesFor('other', 'x')).toBeNull();
		expect(formatMB(2 * MB)).toBe('2 MB');
		expect(formatMB(Math.round(0.1 * MB))).toBe('0.1 MB');
		expect(formatMB(25 * MB)).toBe('25 MB');
	});
});

describe('options mapping', () => {
	it('keeps defaults plain', () => {
		const r = buildExportOptions(form(), ctx);
		expect(r).toEqual({ ok: true, options: { filename: 'a.pdf', compress: true, stripMetadata: false, password: undefined, printCap: true } });
	});

	it('sends the print-size cap only with compression (fit implies it), whatever the dialog counted', () => {
		expect(buildExportOptions(form({ compress: false }), ctx)).toMatchObject({ ok: true, options: { compress: false } });
		expect((buildExportOptions(form({ compress: false }), ctx) as { options: object }).options).not.toHaveProperty('printCap');
		expect(buildExportOptions(form({ compress: false, fit: true }), ctx)).toMatchObject({ ok: true, options: { compress: true, printCap: true } });
		expect((buildExportOptions(form({ printCap: false }), ctx) as { options: object }).options).not.toHaveProperty('printCap');
	});

	it('fit implies compress and sets targetBytes', () => {
		const r = buildExportOptions(form({ compress: false, fit: true, fitChoice: '5' }), ctx);
		expect(r.ok && r.options).toMatchObject({ compress: true, targetBytes: 5 * MB });
		expect(buildExportOptions(form({ fit: true, fitChoice: 'other', fitOther: '0' }), ctx)).toMatchObject({ ok: false });
	});

	it('maps numbering and bates', () => {
		const r = buildExportOptions(form({ number: true, style: 'bates', prefix: 'ABC', digits: '7', start: '5', skip: '2', size: 'large', position: 'top-right' }), ctx);
		expect(r.ok && r.options.numbering).toEqual({
			style: 'bates',
			position: 'top-right',
			start: 5,
			skip: 2,
			size: 12,
			bates: { prefix: 'ABC', digits: 7 }
		});
		expect(buildExportOptions(form({ number: false, style: 'bates' }), ctx)).toMatchObject({ ok: true });
	});

	it('flattens forms only when asked, and always when redacting', () => {
		const none = buildExportOptions(form({ lockForms: true }), ctx);
		expect(none.ok && none.options.flattenForms).toBeUndefined();
		expect(buildExportOptions(form({ lockForms: true }), { ...ctx, hasForm: true })).toMatchObject({ options: { flattenForms: true } });
		const red = buildExportOptions(form({ stripMetadata: false }), { ...ctx, redactions: 2, hasForm: true });
		expect(red).toMatchObject({ ok: true, options: { stripMetadata: true, flattenForms: true } });
	});

	it('counts redaction stamps', () => {
		const box = { x: 0, y: 0, w: 0.1, h: 0.1 };
		expect(redactionCount([{ stamps: [{ id: 'a', kind: 'redact', box }, { id: 'b', kind: 'highlight', box, color: '#ff0' } as never] }, { stamps: [{ id: 'c', kind: 'redact', box }] }])).toBe(2);
	});
});

describe('numbering form', () => {
	it('explains invalid settings in plain words', () => {
		const p = (over: Partial<ExportForm>) => {
			const r = buildNumbering(form({ number: true, ...over }), 12);
			return 'problem' in r ? r.problem : null;
		};
		expect(p({ style: 'bates', digits: '2' })).toMatch(/between 3 and 10 digits/);
		expect(p({ style: 'bates', digits: 'x' })).toMatch(/between 3 and 10 digits/);
		expect(p({ start: '-1' })).toMatch(/first page number/);
		expect(p({ skip: '12' })).toMatch(/Every page would be skipped/);
		expect(p({ style: 'bates', prefix: 'x'.repeat(21) })).toMatch(/at most 20/);
		expect(p({})).toBeNull();
	});

	it('previews the first and last label', () => {
		const n = (over: Partial<ExportForm>) => {
			const r = buildNumbering(form({ number: true, ...over }), 12);
			return 'numbering' in r ? numberingPreview(r.numbering, 12) : 'problem';
		};
		expect(n({})).toBe('First: "Page 1 of 12" · Last: "Page 12 of 12"');
		expect(n({ skip: '2', style: 'n' })).toBe('First: "1" · Last: "10". The first 2 pages get no number.');
		expect(n({ style: 'bates', prefix: 'ID-', digits: '4' })).toBe('First: "ID-0001" · Last: "ID-0012"');
	});
});

describe('result copy', () => {
	const result = (shrink: ExportResult['shrink'], size: number) =>
		({ bytes: new Uint8Array(size), pageCount: 3, checks: [], warnings: [], elapsedMs: 1, shrink }) as ExportResult;

	it('says what happened to the size', () => {
		expect(shrinkSummary(result(undefined, 10))).toBeNull();
		expect(shrinkSummary(result({ targetBytes: 5 * MB, reached: true, imagesChanged: 4, dpi: 96 }, 4 * MB))).toEqual({
			size: 'Fits under 5 MB: 4.0 MB.',
			changed: 'Photos and scans were reduced to about 96 dpi.'
		});
		expect(shrinkSummary(result({ targetBytes: 2 * MB, reached: false, imagesChanged: 2, dpi: 72 }, Math.round(3.1 * MB)))).toEqual({
			size: 'Smallest possible is 3.1 MB. You asked for 2 MB.',
			changed: 'Photos and scans were reduced to about 72 dpi.'
		});
		expect(shrinkSummary(result({ targetBytes: 5 * MB, reached: true, imagesChanged: 0, dpi: 0 }, MB))?.changed).toBeNull();
	});

	it('words the new checks without tool names', () => {
		const names = ['redaction', 'forms', 'numbering', 'visual', 'target-size'] as const;
		for (const name of names) {
			for (const ok of [true, false]) {
				expect(plainCheck({ name, ok, detail: 'x' }, 3)).not.toMatch(/MuPDF|PDF\.js|qpdf/);
			}
		}
		expect(plainCheck({ name: 'target-size', ok: true, detail: '3 MB; the target was 2 MB.' }, 3)).toMatch(/smallest/);
	});
});

describe('keep filled blanks editable', () => {
	const blank = { kind: 'text' as const, box: { x: 0.1, y: 0.1, w: 0.3, h: 0.02 } };
	const square = { kind: 'check' as const, box: { x: 0.5, y: 0.5, w: 0.02, h: 0.015 } };
	const pages = [
		{
			stamps: [
				{ id: 'a', kind: 'text' as const, text: 'Jane', x: 0.1, y: 0.1, size: 0.01, color: 'black' as const, blank },
				{ id: 'b', kind: 'text' as const, text: '  ', x: 0.1, y: 0.2, size: 0.01, color: 'black' as const, blank },
				{ id: 'c', kind: 'text' as const, text: 'plain', x: 0.1, y: 0.3, size: 0.01, color: 'black' as const },
				{ id: 'd', kind: 'mark' as const, mark: 'check' as const, box: square.box, blank: square },
				{ id: 'e', kind: 'mark' as const, mark: 'check' as const, box: square.box }
			]
		}
	];

	it('counts linked text with something typed and linked ticks', () => {
		expect(filledBlankCount(pages)).toBe(2);
		expect(filledBlankCount([])).toBe(0);
	});

	it('is off by default and only asked for when there are filled blanks and nothing flattens', () => {
		expect(DEFAULT_FORM.keepBlanks).toBe(false);
		const on = form({ keepBlanks: true });
		const opt = (f: ExportForm, c: Parameters<typeof buildExportOptions>[1]) => {
			const r = buildExportOptions(f, c);
			if (!r.ok) throw new Error(r.problem);
			return r.options;
		};
		expect(opt(on, { ...ctx, blanks: 2 }).blankFields).toBe(true);
		expect('blankFields' in opt(on, { ...ctx, blanks: 0 })).toBe(false);
		expect('blankFields' in opt(form(), { ...ctx, blanks: 2 })).toBe(false);
		const locked = opt(form({ keepBlanks: true, lockForms: true }), { ...ctx, hasForm: true, blanks: 2 });
		expect([locked.flattenForms, 'blankFields' in locked]).toEqual([true, false]);
		const redacting = opt(on, { ...ctx, redactions: 1, blanks: 2 });
		expect([redacting.flattenForms, 'blankFields' in redacting]).toEqual([true, false]);
	});

	it('says why it is not available, what it does and what happened', () => {
		expect(keepBlanksBlocked({ lockForms: false }, { redactions: 0, hasForm: true })).toBeNull();
		expect(keepBlanksBlocked({ lockForms: true }, { redactions: 0, hasForm: true })).toBe('Not available with Lock form answers.');
		expect(keepBlanksBlocked({ lockForms: false }, { redactions: 2, hasForm: false })).toMatch(/^Not available when redacting/);
		expect(keepBlanksHint(7)).toBe('The 7 blanks you filled become form fields, so the next person can change them.');
		expect(keepBlanksHint(1)).toBe('The blank you filled becomes a form field, so the next person can change it.');
		const r = (fields: number, plain: number) => ({ blankFields: { fields, plain } }) as ExportResult;
		expect(blankFieldsLine(r(7, 0))).toBe('7 blanks are now form fields.');
		expect(blankFieldsLine(r(7, 2))).toBe('7 blanks are now form fields. 2 stayed as plain text.');
		expect(blankFieldsLine(r(1, 1))).toBe('1 blank is now a form field. 1 stayed as plain text.');
		expect(blankFieldsLine(r(0, 3))).toBe('The 3 filled blanks stayed as plain text.');
		expect(blankFieldsLine(r(0, 0))).toBeNull();
		expect(blankFieldsLine({} as ExportResult)).toBeNull();
		expect(plainCheck({ name: 'blank-fields', ok: true, detail: '' }, 1)).toBe('Every filled blank is a form field with your answer.');
	});
});
