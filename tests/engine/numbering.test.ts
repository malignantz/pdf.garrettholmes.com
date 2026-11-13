import { describe, expect, it } from 'vitest';
import type { PageNumbering } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { numberingLabels, validateNumbering } from '../../src/lib/engine/numbering';

const base: PageNumbering = { style: 'n', position: 'bottom-center', start: 1, skip: 0, size: 10 };
const nb = (over: Partial<PageNumbering>): PageNumbering => ({ ...base, ...over });

function fails(fn: () => unknown): EngineError {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineError;
	}
	throw new Error('expected an error');
}

describe('numberingLabels', () => {
	it('numbers every page from 1 by default', () => {
		expect(numberingLabels(base, 3)).toEqual(['1', '2', '3']);
	});

	it('each style', () => {
		expect(numberingLabels(nb({ style: 'n-of-total' }), 3)).toEqual(['1 of 3', '2 of 3', '3 of 3']);
		expect(numberingLabels(nb({ style: 'page-n' }), 2)).toEqual(['Page 1', 'Page 2']);
		expect(numberingLabels(nb({ style: 'page-n-of-total' }), 2)).toEqual(['Page 1 of 2', 'Page 2 of 2']);
		expect(numberingLabels(nb({ style: 'bates', bates: { prefix: 'ABC', digits: 6 } }), 2)).toEqual(['ABC000001', 'ABC000002']);
	});

	it('skip leaves cover pages unnumbered and uncounted', () => {
		expect(numberingLabels(nb({ style: 'n-of-total', skip: 2 }), 5)).toEqual([null, null, '1 of 3', '2 of 3', '3 of 3']);
	});

	it('start shifts numbers and total (total = numbered pages + start - 1)', () => {
		expect(numberingLabels(nb({ style: 'n-of-total', start: 10 }), 3)).toEqual(['10 of 12', '11 of 12', '12 of 12']);
		expect(numberingLabels(nb({ style: 'page-n-of-total', start: 5, skip: 1 }), 3)).toEqual([null, 'Page 5 of 6', 'Page 6 of 6']);
		expect(numberingLabels(nb({ start: 0 }), 2)).toEqual(['0', '1']);
	});

	it('bates pads with zeros, start 0 allowed, empty prefix allowed', () => {
		expect(numberingLabels(nb({ style: 'bates', start: 0, bates: { prefix: '', digits: 3 } }), 2)).toEqual(['000', '001']);
		expect(numberingLabels(nb({ style: 'bates', start: 998, bates: { prefix: 'X-', digits: 3 } }), 2)).toEqual(['X-998', 'X-999']);
	});

	it('bates refuses numbers that do not fit the digits', () => {
		const e = fails(() => numberingLabels(nb({ style: 'bates', start: 999, bates: { prefix: 'X', digits: 3 } }), 2));
		expect(e.code).toBe('unsupported');
		expect(e.message).toMatch(/digits/);
	});

	it('skipping every page gives all null; zero pages gives []', () => {
		expect(numberingLabels(nb({ skip: 3 }), 2)).toEqual([null, null]);
		expect(numberingLabels(base, 0)).toEqual([]);
	});

	it('bates settings are ignored for other styles', () => {
		expect(numberingLabels(nb({ bates: { prefix: 'Z', digits: 99 } }), 1)).toEqual(['1']);
	});
});

describe('numbering total (a part of a split file)', () => {
	it('prints the given total in the of-total styles only', () => {
		expect(numberingLabels(nb({ style: 'page-n-of-total', start: 7, total: 12 }), 2)).toEqual(['Page 7 of 12', 'Page 8 of 12']);
		expect(numberingLabels(nb({ style: 'n-of-total', start: 3, skip: 1, total: 9 }), 3)).toEqual([null, '3 of 9', '4 of 9']);
		expect(numberingLabels(nb({ style: 'page-n', start: 7, total: 12 }), 1)).toEqual(['Page 7']);
	});

	it('refuses a total below the last number, and bad values', () => {
		expect(fails(() => numberingLabels(nb({ style: 'n-of-total', start: 5, total: 5 }), 2)).code).toBe('internal');
		expect(fails(() => validateNumbering(nb({ total: -1 }))).code).toBe('unsupported');
		expect(fails(() => validateNumbering(nb({ total: 1.5 }))).code).toBe('unsupported');
	});
});

describe('validateNumbering', () => {
	const bad: [string, Partial<PageNumbering>][] = [
		['style', { style: 'roman' as never }],
		['position', { position: 'middle' as never }],
		['negative start', { start: -1 }],
		['fractional start', { start: 1.5 }],
		['negative skip', { skip: -1 }],
		['fractional skip', { skip: 0.5 }],
		['size too small', { size: 5 }],
		['size too large', { size: 25 }],
		['size NaN', { size: Number.NaN }],
		['bates without settings', { style: 'bates' }],
		['bates prefix too long', { style: 'bates', bates: { prefix: 'x'.repeat(21), digits: 5 } }],
		['bates prefix control char', { style: 'bates', bates: { prefix: 'a\nb', digits: 5 } }],
		['bates digits too few', { style: 'bates', bates: { prefix: 'A', digits: 2 } }],
		['bates digits too many', { style: 'bates', bates: { prefix: 'A', digits: 11 } }]
	];
	for (const [name, over] of bad) {
		it(`refuses ${name}`, () => {
			const e = fails(() => validateNumbering(nb(over)));
			expect(e.code).toBe('unsupported');
			expect(e.message.length).toBeGreaterThan(10);
		});
	}

	it('accepts the edges', () => {
		expect(() => validateNumbering(nb({ size: 6 }))).not.toThrow();
		expect(() => validateNumbering(nb({ size: 24, start: 0, skip: 100 }))).not.toThrow();
		expect(() => validateNumbering(nb({ style: 'bates', bates: { prefix: 'x'.repeat(20), digits: 10 } }))).not.toThrow();
		expect(() => validateNumbering(nb({ style: 'bates', bates: { prefix: 'Ünï', digits: 3 } }))).not.toThrow();
	});
});
