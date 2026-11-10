import { describe, expect, it } from 'vitest';
import {
	imagePageSize,
	orientationMatrix,
	orientedPixels,
	parseJpeg,
	readExifOrientation,
	stripJpegMetadata,
	type Orientation
} from '../../src/lib/engine/images';
import { applyMatrix } from '../../src/lib/engine/geometry';
import { createCoreEngine } from '../../src/lib/engine/core';
import { corpus, nodeAssets } from './helpers';

describe('image page size rule', () => {
	it('fits within Letter turned to the image, never above 1 pt per pixel', () => {
		expect(imagePageSize(4032, 3024)).toEqual({ width: 792, height: 594 });
		expect(imagePageSize(3024, 4032)).toEqual({ width: 594, height: 792 });
		expect(imagePageSize(2550, 3300)).toEqual({ width: 612, height: 792 });
		expect(imagePageSize(300, 200)).toEqual({ width: 300, height: 200 });
		expect(imagePageSize(1000, 1000)).toEqual({ width: 612, height: 612 });
		expect(imagePageSize(20000, 10)).toEqual({ width: 792, height: 1 });
	});
});

describe('EXIF orientation', () => {
	it('reads little- and big-endian TIFF headers', () => {
		const le = new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0]);
		const be = new Uint8Array([0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0]);
		expect(readExifOrientation(le)).toBe(6);
		expect(readExifOrientation(be)).toBe(8);
		expect(readExifOrientation(new Uint8Array([1, 2, 3]))).toBeUndefined();
	});

	it('the corpus JPEG says 6 and is stored 400×240', () => {
		expect(parseJpeg(corpus('photo-exif6.jpg'))).toEqual({ width: 400, height: 240, components: 3, orientation: 6 });
	});

	// Where each stored corner (unit square, y up) must land on a W×H page, per the EXIF spec.
	const W = 30;
	const H = 50;
	const storedTopLeft: Record<Orientation, [number, number]> = {
		1: [0, H],
		2: [W, H],
		3: [W, 0],
		4: [0, 0],
		5: [0, H],
		6: [W, H],
		7: [W, 0],
		8: [0, 0]
	};
	const storedTopRight: Record<Orientation, [number, number]> = {
		1: [W, H],
		2: [0, H],
		3: [0, 0],
		4: [W, 0],
		5: [0, 0],
		6: [W, 0],
		7: [W, H],
		8: [0, H]
	};
	for (const o of [1, 2, 3, 4, 5, 6, 7, 8] as Orientation[]) {
		it(`orientation ${o} maps stored corners correctly`, () => {
			const m = orientationMatrix(o, W, H);
			expect(applyMatrix(m, 0, 1)).toEqual(storedTopLeft[o]);
			expect(applyMatrix(m, 1, 1)).toEqual(storedTopRight[o]);
			const shown = orientedPixels(400, 240, o);
			expect(shown).toEqual(o >= 5 ? { width: 240, height: 400 } : { width: 400, height: 240 });
		});
	}
});

describe('JPEG metadata stripping', () => {
	it('drops EXIF and comments, keeps JFIF, ICC and Adobe segments and the image data', () => {
		const original = corpus('photo-exif6.jpg');
		const seg = (marker: number, body: number[]) => [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255, ...body];
		// Insert an ICC (APP2) and Adobe (APP14) segment after SOI.
		const withExtras = new Uint8Array([
			0xff,
			0xd8,
			...seg(0xe2, [...new TextEncoder().encode('ICC_PROFILE\0'), 1, 1, 9, 9]),
			...seg(0xee, [...new TextEncoder().encode('Adobe'), 0, 100, 0, 0, 0, 0, 1]),
			...original.subarray(2)
		]);
		const out = stripJpegMetadata(withExtras);
		const text = Buffer.from(out).toString('latin1');
		expect(text).not.toContain('Exif');
		expect(text).not.toContain('corpus comment');
		expect(text).toContain('ICC_PROFILE');
		expect(text).toContain('Adobe');
		expect(text).toContain('JFIF');
		const sos = Buffer.from(withExtras).indexOf(Buffer.from([0xff, 0xda]));
		expect(Buffer.from(out).subarray(out.length - (withExtras.length - sos))).toEqual(Buffer.from(withExtras).subarray(sos));
		expect(parseJpeg(out)).toMatchObject({ width: 400, height: 240, orientation: 1 });
	});

	it('refuses JPEG modes PDF cannot carry', () => {
		const jpeg = Buffer.from(corpus('photo-plain.jpg'));
		const sof = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
		const progressiveArithmetic = Buffer.from(jpeg);
		progressiveArithmetic[sof + 1] = 0xca;
		expect(() => parseJpeg(new Uint8Array(progressiveArithmetic))).toThrow(/compression mode/);
		const twelveBit = Buffer.from(jpeg);
		twelveBit[sof + 4] = 12;
		expect(() => parseJpeg(new Uint8Array(twelveBit))).toThrow(/12-bit/);
	});
});

describe('size limits', () => {
	it('reports too-large inputs plainly', async () => {
		const e = createCoreEngine(nodeAssets(), { maxInputBytes: 1000 });
		await expect(e.openPdf(corpus('multi.pdf'), 'm')).rejects.toMatchObject({ code: 'too-large' });
		await expect(e.openImage(corpus('alpha.png'), 'image/png', 'a')).rejects.toMatchObject({ code: 'too-large' });
	});
});
