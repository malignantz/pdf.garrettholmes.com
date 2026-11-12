import { describe, expect, it } from 'vitest';
import { OCR_CAP } from '../../src/lib/engine/ocr/stage';
import { OCR_PAGE_CAP, countScanned, ocrCapNotice, ocrProgressText, ocrSummary } from '../../src/lib/workspace/ocr-option';
import { DEFAULT_FORM, buildExportOptions } from '../../src/lib/workspace/logic';
import type { PageRef, Source } from '../../src/lib/core/types';

describe('Make scanned pages searchable: dialog words', () => {
	it('uses the engine cap', () => {
		expect(OCR_PAGE_CAP).toBe(OCR_CAP);
	});

	it('says before export when more pages are scanned than one export reads', () => {
		expect(ocrCapNotice(20)).toBeNull();
		expect(ocrCapNotice(34)).toBe('This file has 34 scanned pages. The first 20 will be made searchable.');
	});

	it('shows reading progress', () => {
		expect(ocrProgressText(null)).toBeNull();
		expect(ocrProgressText({ stage: 'ocr-load' })).toBe('Getting the text reader ready…');
		expect(ocrProgressText({ stage: 'ocr', done: 2, total: 12 })).toBe('Reading page 3 of 12');
		expect(ocrProgressText({ stage: 'ocr', done: 12, total: 12 })).toBe('Reading page 12 of 12');
	});

	it('says what happened after export, without alarm for declined pages', () => {
		const r = (searchable: number, declined: number, eligible = searchable + declined) => ({
			eligible,
			cap: 20,
			searchable: Array.from({ length: searchable }, (_, i) => i + 1),
			declined: Array.from({ length: declined }, (_, i) => i + 50)
		});
		expect(ocrSummary(undefined)).toEqual([]);
		expect(ocrSummary(r(0, 0))).toEqual([]);
		expect(ocrSummary(r(12, 2))).toEqual(['12 pages made searchable. 2 pages were left as they were because the text could not be read well enough.']);
		expect(ocrSummary(r(1, 1))).toEqual(['1 page made searchable. 1 page was left as it was because the text could not be read well enough.']);
		expect(ocrSummary(r(3, 0))).toEqual(['3 pages made searchable.']);
		expect(ocrSummary(r(0, 2))).toEqual(['No pages were made searchable: the text could not be read well enough. The pages are unchanged.']);
		expect(ocrSummary(r(18, 2, 34))).toEqual([
			'18 pages made searchable. 2 pages were left as they were because the text could not be read well enough.',
			'This file has 34 scanned pages. Only the first 20 were read.'
		]);
	});

	it('counts scanned pages of the plan, without redaction pages, asking each source once', async () => {
		let asks = 0;
		const engine = {
			scannedPages: async (s: Source) => {
				asks++;
				return s.id === 'a' ? [0, 2] : [];
			}
		};
		const src = (id: string, kind: Source['kind'] = 'pdf') => ({ id, kind }) as Source;
		const page = (sourceId: string, pageIndex: number, redact = false) =>
			({ id: `${sourceId}${pageIndex}`, sourceId, pageIndex, rotation: 0, stamps: redact ? [{ id: 'r', kind: 'redact', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] : [] }) as PageRef;
		const pages = [page('a', 0), page('a', 1), page('a', 2, true), page('a', 2), page('b', 0), page('c', 0)];
		expect(await countScanned(engine, pages, [src('a'), src('b'), src('c', 'image')])).toBe(2);
		expect(await countScanned(engine, pages, [src('a'), src('b'), src('c', 'image')])).toBe(2);
		expect(asks).toBe(2);
	});

	it('asks the engine only when the option is on and a page qualifies', () => {
		const f = { ...DEFAULT_FORM, filename: 'x.pdf', ocr: true };
		expect(DEFAULT_FORM.ocr).toBe(false);
		const ctx = { pageCount: 3, redactions: 0, hasForm: false };
		const on = buildExportOptions(f, { ...ctx, scanned: 2 });
		const none = buildExportOptions(f, { ...ctx, scanned: 0 });
		const off = buildExportOptions({ ...f, ocr: false }, { ...ctx, scanned: 2 });
		expect(on.ok && on.options.ocr).toBe(true);
		expect(none.ok && none.options.ocr).toBeFalsy();
		expect(off.ok && off.options.ocr).toBeFalsy();
	});
});
