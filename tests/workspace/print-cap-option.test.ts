import { describe, expect, it } from 'vitest';
import type { ExportResult, PageRef, Source } from '../../src/lib/core/types';
import { DEFAULT_FORM, shrinkSummary } from '../../src/lib/workspace/logic';
import { CAP_PPI } from '../../src/lib/engine/print-cap';
import { PRINT_CAP_PPI, PRINT_CAP_LABEL, countOversized, printCapHint, printCapLine, printCapProgressText } from '../../src/lib/workspace/print-cap-option';
import { ocrProgressText } from '../../src/lib/workspace/ocr-option';

describe('Reduce oversized pictures: dialog words', () => {
	it('states the engine\'s cap', () => {
		expect(PRINT_CAP_PPI).toBe(CAP_PPI);
	});

	it('is on by default and says what it does', () => {
		expect(DEFAULT_FORM.printCap).toBe(true);
		expect(PRINT_CAP_LABEL).toBe('Reduce oversized pictures');
		expect(printCapHint(3)).toBe('3 pictures hold more detail than a printer can use. They are brought down to 300 dpi; text stays sharp.');
		expect(printCapHint(1)).toBe('One picture holds more detail than a printer can use. It is brought down to 300 dpi; text stays sharp.');
	});

	it('shows progress per picture, and the OCR words only for OCR', () => {
		expect(printCapProgressText(null)).toBeNull();
		expect(printCapProgressText({ stage: 'pictures', done: 2, total: 20 })).toBe('Reducing picture 3 of 20');
		expect(printCapProgressText({ stage: 'pictures', done: 20, total: 20 })).toBeNull();
		expect(printCapProgressText({ stage: 'ocr', done: 1, total: 4 })).toBeNull();
		expect(ocrProgressText({ stage: 'pictures', done: 1, total: 4 })).toBeNull();
	});

	it('says what changed after export, and nothing when nothing did', () => {
		expect(printCapLine({})).toBeNull();
		expect(printCapLine({ printCap: { images: 0, savedBytes: 0, ppi: 300 } })).toBeNull();
		expect(printCapLine({ printCap: { images: 4, savedBytes: 3.2 * 1024 * 1024, ppi: 300 } })).toBe('4 pictures reduced to 300 dpi, 3.2 MB saved.');
		expect(printCapLine({ printCap: { images: 1, savedBytes: 600 * 1024, ppi: 300 } })).toBe('1 picture reduced to 300 dpi, 600 KB saved.');
	});

	it('does not repeat the cap in the size-target lines', () => {
		const r = (shrink: ExportResult['shrink'], printCap?: ExportResult['printCap']) =>
			({ bytes: new Uint8Array(10), pageCount: 1, checks: [], warnings: [], elapsedMs: 1, shrink, printCap }) as ExportResult;
		expect(shrinkSummary(r({ targetBytes: 100, reached: true, imagesChanged: 2, dpi: 300 }, { images: 2, savedBytes: 5, ppi: 300 }))?.changed).toBeNull();
		expect(shrinkSummary(r({ targetBytes: 100, reached: true, imagesChanged: 2, dpi: 150 }, { images: 0, savedBytes: 0, ppi: 300 }))?.changed).toBe(
			'Photos and scans were reduced to about 150 dpi.'
		);
	});

	it('counts pictures drawn on the exported pages once, asking each source once', async () => {
		let asks = 0;
		const engine = {
			oversizedPictures: async (s: Source) => {
				asks++;
				return s.id === 'a' ? [[0, 2], [1], [3]] : s.id === 'b' ? [[0]] : [];
			}
		};
		const src = (id: string, kind: Source['kind'] = 'pdf') => ({ id, kind }) as Source;
		const page = (sourceId: string, pageIndex: number) => ({ id: `${sourceId}${pageIndex}`, sourceId, pageIndex, rotation: 0, stamps: [] }) as PageRef;
		const sources = [src('a'), src('b', 'image'), src('c', 'blank')];
		expect(await countOversized(engine, [page('a', 0), page('a', 2), page('b', 0), page('c', 0)], sources)).toBe(2);
		expect(await countOversized(engine, [page('a', 1), page('a', 2), page('a', 3)], sources)).toBe(3);
		expect(await countOversized(engine, [page('c', 0)], sources)).toBe(0);
		expect(asks).toBe(2);
	});
});
