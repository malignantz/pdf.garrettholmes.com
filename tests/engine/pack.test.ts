import { describe, expect, it } from 'vitest';
import zlib from 'node:zlib';
import { nativeDeflate, packStream, strictInflate, unpredict, type Deflater, type QpdfObject } from '../../src/lib/engine/pack';
import { pngPredict } from '../../src/lib/engine/shrink';
import { prng } from './helpers';

const z = (d: Uint8Array, level = 6) => new Uint8Array(zlib.deflateSync(d, { level }));
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));

function smooth(w: number, h: number, n: number, seed = 1): Uint8Array {
	const rnd = prng(seed);
	const px = new Uint8Array(w * h * n);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			for (let c = 0; c < n; c++) px[(y * w + x) * n + c] = (x * (c + 1) + y * 2 + Math.floor(rnd() * 3)) & 255;
	return px;
}

describe('strictInflate', () => {
	const data = new TextEncoder().encode('BT /F1 12 Tf (hello hello hello) Tj ET\n'.repeat(50));
	it('inflates a complete zlib stream, also with trailing end-of-line bytes', () => {
		expect(strictInflate(z(data))).toEqual(data);
		expect(strictInflate(cat(z(data), [13, 10]))).toEqual(data);
	});
	it('refuses truncated data, junk after the end, a wrong checksum and a bad header', () => {
		const good = z(data);
		expect(strictInflate(good.subarray(0, good.length - 9))).toBeNull();
		expect(strictInflate(cat(good, [1, 2, 3]))).toBeNull();
		const bad = good.slice();
		bad[bad.length - 1] ^= 1;
		expect(strictInflate(bad)).toBeNull();
		expect(strictInflate(cat([0x78, 0x00], good.subarray(2)))).toBeNull();
		expect(strictInflate(new Uint8Array(zlib.deflateRawSync(data)))).toBeNull();
	});
});

describe('unpredict', () => {
	it('inverts pngPredict for 1, 3 and 4 components', () => {
		for (const n of [1, 3, 4]) {
			const px = smooth(37, 19, n, n);
			const back = unpredict(pngPredict(px, 37, 19, n), { predictor: 15, colors: n, bpc: 8, columns: 37 });
			expect(back).toEqual(px);
		}
	});
	it('undoes the TIFF predictor (8-bit) and refuses layouts that do not fit', () => {
		const px = smooth(10, 4, 3);
		const tiff = px.slice();
		for (let r = 0; r < 4; r++) for (let i = 29; i >= 3; i--) tiff[r * 30 + i] = (px[r * 30 + i] - px[r * 30 + i - 3]) & 255;
		expect(unpredict(tiff, { predictor: 2, colors: 3, bpc: 8, columns: 10 })).toEqual(px);
		expect(unpredict(px.subarray(1), { predictor: 15, colors: 3, bpc: 8, columns: 10 })).toBeNull();
		const bad = pngPredict(px, 10, 4, 3);
		bad[0] = 7;
		expect(unpredict(bad, { predictor: 15, colors: 3, bpc: 8, columns: 10 })).toBeNull();
	});
});

describe('packStream', () => {
	const objects: Record<string, QpdfObject> = {};
	const image = (w: number, h: number, extra: Record<string, unknown> = {}) => ({
		'/Type': '/XObject',
		'/Subtype': '/Image',
		'/Width': w,
		'/Height': h,
		'/BitsPerComponent': 8,
		'/ColorSpace': '/DeviceRGB',
		'/Filter': '/FlateDecode',
		...extra
	});

	it('keeps a PNG predictor that qpdf would drop, and never grows the stream', async () => {
		const px = smooth(200, 120, 3);
		const predicted = pngPredict(px, 200, 120, 3);
		const raw = z(predicted, 9);
		const parms = { '/Predictor': 15, '/Colors': 3, '/BitsPerComponent': 8, '/Columns': 200 };
		const c = await packStream(objects, image(200, 120, { '/DecodeParms': parms }) as never, raw, nativeDeflate);
		if (c) {
			expect(c.data.length).toBeLessThan(raw.length);
			expect(c.dict['/DecodeParms']).toBeDefined();
			expect(unpredict(strictInflate(c.data)!, { predictor: 15, colors: 3, bpc: 8, columns: 200 })).toEqual(px);
		}
		// Without the predictor (what qpdf --recompress-flate writes) the image is much bigger.
		expect(z(px).length).toBeGreaterThan(raw.length * 1.3);
	});

	it('gives an image without a predictor one, pixels unchanged', async () => {
		const px = smooth(200, 120, 3);
		const raw = z(px, 9);
		const c = (await packStream(objects, image(200, 120) as never, raw, nativeDeflate))!;
		expect(c).not.toBeNull();
		expect(c.predicted).toBe(true);
		expect(c.data.length).toBeLessThan(raw.length * 0.8);
		expect(c.dict['/DecodeParms']).toEqual({ '/BitsPerComponent': 8, '/Colors': 3, '/Columns': 200, '/Predictor': 15 });
		expect(unpredict(strictInflate(c.data)!, { predictor: 15, colors: 3, bpc: 8, columns: 200 })).toEqual(px);
	});

	it('leaves damaged, multi-filter, external and metadata streams alone', async () => {
		const data = new TextEncoder().encode('q 1 0 0 1 0 0 cm Q\n'.repeat(200));
		const stored = data; // uncompressed: always compressible
		const cases: Record<string, unknown>[] = [
			{ '/Type': '/Metadata', '/Subtype': '/XML' },
			{ '/F': 'u:file.bin' },
			{ '/Filter': ['/ASCIIHexDecode', '/FlateDecode'] },
			{ '/Filter': '/LZWDecode' },
			{ '/DecodeParms': { '/Predictor': 12 } }
		];
		for (const d of cases) expect(await packStream(objects, d as never, stored, nativeDeflate), JSON.stringify(d)).toBeNull();
		const broken = z(data).slice(0, 40);
		expect(await packStream(objects, { '/Filter': '/FlateDecode' }, broken, nativeDeflate)).toBeNull();
	});

	it('re-deflates other streams only when smaller, data unchanged', async () => {
		const data = new TextEncoder().encode('BT /F1 9 Tf 72 700 Td (Line of text) Tj ET\n'.repeat(400));
		const loose = z(data, 1);
		const c = (await packStream(objects, { '/Filter': '/FlateDecode' }, loose, nativeDeflate))!;
		expect(c.data.length).toBeLessThan(loose.length);
		expect(strictInflate(c.data)).toEqual(data);
		const tight = z(data, 9);
		const worse: Deflater = { name: 'stored', zlib: (d) => z(d, 0) };
		expect(await packStream(objects, { '/Filter': '/FlateDecode' }, tight, worse)).toBeNull();
	});

	it('refuses a candidate whose compressor does not round-trip', async () => {
		const data = new TextEncoder().encode('0 0 m 10 10 l S\n'.repeat(300));
		const liar: Deflater = { name: 'liar', zlib: (d) => z(d.subarray(1)) };
		expect(await packStream(objects, { '/Filter': '/FlateDecode' }, z(data, 1), liar)).toBeNull();
	});
});
