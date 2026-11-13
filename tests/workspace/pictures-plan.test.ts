import { describe, expect, it } from 'vitest';
import type { Source } from '../../src/lib/core/types';
import { PICTURE_MAX_PIXELS, PICTURE_MAX_SIDE, pictureSize } from '../../src/lib/render/sizing';
import {
	estimatePictures,
	pictureBudget,
	pictureExportOptions,
	pictureName,
	picturesLine,
	qualityDpi,
	reducedLine,
	tooManyPictures
} from '../../src/lib/workspace/pictures-plan';

const MB = 1024 * 1024;

describe('pictureSize', () => {
	it('exact pixel sizes at the two qualities', () => {
		expect(pictureSize(612, 792, 150)).toEqual({ width: 1275, height: 1650, dpi: 150, reduced: false });
		expect(pictureSize(612, 792, 300)).toEqual({ width: 2550, height: 3300, dpi: 300, reduced: false });
		expect(pictureSize(595.28, 841.89, 150)).toEqual({ width: 1240, height: 1754, dpi: 150, reduced: false });
		expect(pictureSize(792, 612, 150)).toEqual({ width: 1650, height: 1275, dpi: 150, reduced: false });
	});

	it('lowers the dpi of a page too large for the cap, to the largest whole dpi that fits', () => {
		// A3 at 300 dpi is 3508 × 4961 = 17.4 MP.
		const a3 = pictureSize(841.89, 1190.55, 300);
		expect(a3.reduced).toBe(true);
		expect(a3.width * a3.height).toBeLessThanOrEqual(PICTURE_MAX_PIXELS);
		expect(Number.isInteger(a3.dpi)).toBe(true);
		const next = pictureSize(841.89, 1190.55, a3.dpi + 1);
		expect(next.reduced).toBe(true);
		// A long strip hits the side cap instead.
		const strip = pictureSize(612, 14400, 150);
		expect(strip.height).toBeLessThanOrEqual(PICTURE_MAX_SIDE);
		expect(strip.reduced).toBe(true);
		// Absurd pages still fit.
		const huge = pictureSize(14400 * 20, 14400 * 20, 300);
		expect(huge.width * huge.height).toBeLessThanOrEqual(PICTURE_MAX_PIXELS);
		expect(huge.reduced).toBe(true);
	});
});

describe('names, budget, estimate', () => {
	it('names are zero-padded in page order', () => {
		expect(pictureName('report', 0, 12, 'jpg')).toBe('report-001.jpg');
		expect(pictureName('report', 11, 12, 'png')).toBe('report-012.png');
		expect(pictureName('report', 41, 1200, 'jpg')).toBe('report-0042.jpg');
		expect(qualityDpi('screen')).toBe(150);
		expect(qualityDpi('print')).toBe(300);
	});

	it('budget: an eighth of memory, 256 MB to 1.5 GB', () => {
		expect(pictureBudget({ deviceMemoryGB: 8, coarse: false })).toBe(1024 * MB);
		expect(pictureBudget({ deviceMemoryGB: 1, coarse: true })).toBe(256 * MB);
		expect(pictureBudget({ deviceMemoryGB: 32, coarse: false })).toBe(1536 * MB);
		expect(pictureBudget({ coarse: true })).toBe(384 * MB);
		expect(pictureBudget({ coarse: false })).toBe(1024 * MB);
	});

	const letter = { id: 's', name: 's.pdf', kind: 'pdf', bytes: new Uint8Array(), pages: [{ width: 612, height: 792 }, { width: 841.89, height: 1190.55 }], originalSize: 1, wasEncrypted: false, notes: [] } satisfies Source;

	it('estimate counts pixels as exported (rotation) and pages that will be reduced', () => {
		const pages = [
			{ sourceId: 's', pageIndex: 0, rotation: 90 as const },
			{ sourceId: 's', pageIndex: 1, rotation: 0 as const }
		];
		const e = estimatePictures(pages, [letter], 'jpg', 300, 1024 * MB);
		expect(e.reduced).toBe(1);
		expect(e.pixels).toBeGreaterThan(2550 * 3300);
		expect(e.pixels).toBeLessThanOrEqual(2550 * 3300 + PICTURE_MAX_PIXELS);
	});

	it('too many pictures for the device is said before starting', () => {
		const pages = Array.from({ length: 260 }, () => ({ sourceId: 's', pageIndex: 0, rotation: 0 as const }));
		const budget = 256 * MB;
		const jpg = estimatePictures(pages, [letter], 'jpg', 150, budget);
		expect(tooManyPictures(260, jpg, budget, 'jpg', 150)).toBeNull();
		const png = estimatePictures(pages, [letter], 'png', 300, budget);
		const msg = tooManyPictures(260, png, budget, 'png', 300)!;
		expect(msg).toMatch(/^260 pictures at this quality would need about \d+ MB, more than this device can hold at once\. Save up to \d+ pages at a time or choose Screen quality\.$/);
		expect(png.fit).toBeLessThan(260);
		expect(png.fit * (png.bytes / 260)).toBeLessThanOrEqual(budget);
	});

	it('result lines', () => {
		expect(picturesLine(12, 3.4 * MB)).toBe('12 pictures in one zip, 3.4 MB');
		expect(picturesLine(1, 420 * 1024)).toBe('1 picture, 420 KB');
		expect(reducedLine([], 300)).toBeNull();
		expect(reducedLine([{ page: 4, dpi: 290.2 }], 300)).toBe(
			'Page 4 is very large, so it was saved at 290 dpi instead of 300 to stay within what this device can draw.'
		);
		expect(reducedLine([{ page: 2, dpi: 290 }, { page: 3, dpi: 280 }], 300)).toMatch(/^Pages 2, 3 are very large, .* \(down to 280 dpi\)/);
	});

	it('the PDF behind the pictures keeps only what changes how pages look', () => {
		const numbering = { style: 'n', position: 'bottom-center', start: 1, skip: 0, size: 10 } as const;
		expect(
			pictureExportOptions({
				filename: 'x.zip',
				compress: true,
				password: 'secret',
				stripMetadata: true,
				flattenForms: true,
				numbering,
				targetBytes: 5 * MB,
				blankFields: true,
				ocr: true,
				printCap: true
			})
		).toEqual({ filename: 'x.zip', compress: false, stripMetadata: true, flattenForms: true, numbering });
	});
});
