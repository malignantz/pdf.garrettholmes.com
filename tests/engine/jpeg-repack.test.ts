/**
 * Lossless JPEG repack (jpeg.ts, jpeg-repack.ts, the J candidate in pack.ts): smaller,
 * the same DCT coefficients, colour segments byte for byte, every skip case untouched,
 * and a module that fails, traps, runs out of time or lies only leaves images as they are.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { JpegImage } from 'pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs';
import type { Source } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { nativeDeflate, packJpegStream, packStreams, strictInflate } from '../../src/lib/engine/pack';
import { parseJpeg, type JpegInfo } from '../../src/lib/engine/jpeg';
import { repackJpeg, setJpegRepackModuleForTest, setJpegTamperForTest, verifyJpeg } from '../../src/lib/engine/jpeg-repack';
import wasm64, { JPEG_REPACK_WASM_SHA256 } from '../../src/lib/engine/vendor/jpeg-repack/wasm';
import { corpus, nodeAssets } from './helpers';

const T = 120_000;
const MB48 = 48 * 1024 * 1024;
const qpdf = new Qpdf(nodeAssets().qpdf);
const notes: string[] = [];
const eng = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n) });

afterEach(async () => {
	setJpegRepackModuleForTest(null);
	await setJpegTamperForTest(0);
});

async function exportAll(src: Source, compress = true) {
	const pages = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
	const res = await eng.exportPlan({ pages, options: { filename: 'o.pdf', compress, stripMetadata: false } }, [src], []);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res.bytes;
}

interface Img {
	page: number;
	name: string;
	filter: string;
	dict: string;
	raw: Uint8Array;
	/** The JPEG inside (Flate undone). */
	jpeg: Uint8Array;
	/** MuPDF's decoded image samples. */
	samples: Uint8Array;
}

/** Every image XObject of every page (and its /SMask), as MuPDF reads it. */
async function images(bytes: Uint8Array): Promise<Img[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes.slice());
	try {
		const out: Img[] = [];
		for (let p = 0; p < doc.countPages(); p++) {
			const xo = doc.loadPage(p).getObject().get('Resources').get('XObject');
			if (!xo.isDictionary()) continue;
			const visit = (name: string, o: ReturnType<typeof xo.get>) => {
				if (!o.isStream() || o.get('Subtype').asName() !== 'Image') return;
				const raw = new Uint8Array(o.readRawStream().asUint8Array());
				const filter = String(o.get('Filter'));
				const jpeg = /Flate/.test(filter) ? new Uint8Array(zlib.inflateSync(raw)) : raw;
				const pix = doc.loadImage(o).toPixmap();
				const samples = new Uint8Array(pix.getPixels());
				pix.destroy();
				const d = o.resolve();
				const keys: string[] = [];
				d.forEach((v, k) => {
					if (k !== 'Length' && k !== 'SMask') keys.push(`${k}=${v}`);
				});
				out.push({ page: p, name, filter, dict: keys.sort().join(' '), raw, jpeg, samples });
				if (o.get('SMask').isStream()) visit(`${name}/SMask`, o.get('SMask'));
			};
			xo.forEach((v, k) => visit(String(k), v));
		}
		return out;
	} finally {
		doc.destroy();
	}
}

/** Page renders by MuPDF (RGB). */
async function renders(bytes: Uint8Array): Promise<Uint8Array[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes.slice());
	try {
		const out: Uint8Array[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			const pix = doc.loadPage(i).toPixmap(m.Matrix.scale(1.5, 1.5), m.ColorSpace.DeviceRGB, false, true);
			out.push(new Uint8Array(pix.getPixels()));
			pix.destroy();
		}
		return out;
	} finally {
		doc.destroy();
	}
}

/** PDF.js's own decoder (pure JavaScript, shares no code with libjpeg): the samples as a PDF reader gets them. */
function pdfjsDecode(jpeg: Uint8Array, colorTransform = -1): Uint8Array {
	const j = new JpegImage({ decodeTransform: undefined, colorTransform });
	j.parse(jpeg.slice());
	return j.getData({ width: j.width, height: j.height, forceRGB: false, isSourcePDF: true });
}

function info(jpeg: Uint8Array): JpegInfo {
	const p = parseJpeg(jpeg);
	if (!p.ok) throw new Error(p.why);
	return p.info;
}

const hex = (d: Uint8Array) => Buffer.from(d).toString('hex');

describe('jpeg-repack module', () => {
	it('is the vendored build (SHA-256) and imports nothing but a memory notice', () => {
		const bin = Buffer.from(wasm64, 'base64');
		expect(createHash('sha256').update(bin).digest('hex')).toBe(JPEG_REPACK_WASM_SHA256);
		const mod = new WebAssembly.Module(bin);
		expect(WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`)).toEqual(['env.emscripten_notify_memory_growth']);
	});

	it('a trap (libjpeg error) gives an error result, and the next call works on a fresh instance', async () => {
		const good = (await images(corpus('jpeg-kinds.pdf')))[0].jpeg;
		const bad = await repackJpeg(good.subarray(200), MB48);
		expect(bad).toMatchObject({ ok: false, why: 'error' });
		const ok = await repackJpeg(good, MB48);
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(await verifyJpeg(good, ok.jpeg, MB48)).toBe(true);
		expect(await verifyJpeg(good, good.subarray(0, 100), MB48)).toBe(false);
	});

	it('verifyJpeg catches one changed DC coefficient', async () => {
		const good = (await images(corpus('jpeg-kinds.pdf')))[0].jpeg;
		await setJpegTamperForTest(1);
		const r = await repackJpeg(good, MB48);
		await setJpegTamperForTest(0);
		expect(r.ok).toBe(true);
		if (r.ok) expect(await verifyJpeg(good, r.jpeg, MB48)).toBe(false);
	});

	it('refuses images whose coefficients would exceed the memory cap', async () => {
		const good = (await images(corpus('jpeg-kinds.pdf')))[0].jpeg;
		expect(await repackJpeg(good, 10_000)).toMatchObject({ ok: false, why: 'too-big' });
	});
});

describe('lossless JPEG repack at export', () => {
	it(
		'jpeg-kinds: every kind smaller, the same coefficients and samples (two decoders), colour segments byte for byte, baseline, dictionary unchanged, pages identical',
		async () => {
			const src = await eng.openPdf(corpus('jpeg-kinds.pdf'), 'k.pdf');
			notes.length = 0;
			const plain = await exportAll(src, false);
			const packed = await exportAll(src);
			expect(notes.join('\n')).toMatch(/pack: JPEG 12 repacked/);
			expect(packed.length).toBeLessThan(plain.length);
			const a = await images(plain);
			const b = await images(packed);
			expect(b.map((x) => `${x.page}${x.name}`)).toEqual(a.map((x) => `${x.page}${x.name}`));
			expect(a).toHaveLength(12);
			for (let i = 0; i < a.length; i++) {
				const what = `page ${a[i].page + 1} ${a[i].name}`;
				expect(b[i].raw.length, what).toBeLessThan(a[i].raw.length);
				expect(b[i].filter, what).toBe(a[i].filter);
				expect(b[i].dict, what).toBe(a[i].dict);
				expect(await verifyJpeg(a[i].jpeg, b[i].jpeg, MB48), what).toBe(true);
				expect(hex(b[i].samples), what).toBe(hex(a[i].samples));
				const ct = /ColorTransform 0/.test(a[i].dict) ? 0 : -1;
				expect(hex(pdfjsDecode(b[i].jpeg, ct)), what).toBe(hex(pdfjsDecode(a[i].jpeg, ct)));
				const ia = info(a[i].jpeg);
				const ib = info(b[i].jpeg);
				expect(ib.sof, what).toBe(0xc0);
				expect(ib.kept.map(hex), what).toEqual(ia.kept.map(hex));
				expect(ib.dropped, what).toBe(0);
			}
			// The colour segments that decide decoding, by kind.
			const adobeTransform = (img: Img) => info(img.jpeg).kept.filter((k) => k[1] === 0xee).map((k) => k[k.length - 1]);
			expect(b.map(adobeTransform)).toEqual([[], [], [], [0], [0], [2], [1], [0], [], [], [], []]);
			expect(b.map((x) => info(x.jpeg).kept.filter((k) => k[1] === 0xe0).length)).toEqual([1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 0]);
			// Page 7: ICC kept, EXIF, XMP and the comment dropped.
			const p7a = info(a[6].jpeg);
			const p7b = info(b[6].jpeg);
			expect(p7a.dropped).toBe(3);
			expect(p7b.kept.map((k) => k[1])).toEqual([0xee, 0xe2]);
			// Page 3 was progressive; the output is baseline.
			expect(info(a[2].jpeg).sof).toBe(0xc2);
			// Page 9 stays Flate-wrapped.
			expect(b[8].filter).toMatch(/FlateDecode.*DCTDecode/);
			expect(await renders(packed)).toEqual(await renders(plain));
		},
		T
	);

	it(
		'jpeg-skips: an APP14 after the frame, A85, a Flate predictor, two EXIF blocks, an inline image: all byte for byte',
		async () => {
			const src = await eng.openPdf(corpus('jpeg-skips.pdf'), 's.pdf');
			notes.length = 0;
			const plain = await exportAll(src, false);
			const packed = await exportAll(src);
			const why = notes.find((n) => n.startsWith('pack: JPEG')) ?? '';
			expect(why).toMatch(/JPEG 0 repacked/);
			for (const w of ['colour segment after the frame header', 'filters /ASCII85Decode /DCTDecode', 'predictor on the Flate filter', 'more than one EXIF block']) {
				expect(why).toContain(w);
			}
			const a = await images(plain);
			const b = await images(packed);
			expect(a).toHaveLength(4);
			for (let i = 0; i < a.length; i++) expect(hex(b[i].raw)).toBe(hex(a[i].raw));
			// The inline JPEG is still in the page content, byte for byte.
			const m = await mupdf();
			const inlineJpeg = (bytes: Uint8Array) => {
				const doc = new m.PDFDocument(bytes.slice());
				try {
					const c = doc.loadPage(4).getObject().get('Contents');
					const parts = c.isArray() ? Array.from({ length: c.length }, (_, k) => c.get(k)) : [c];
					const all = Buffer.concat(parts.map((p) => Buffer.from(p.readStream().asUint8Array())));
					const at = all.indexOf(Buffer.from(' ID '));
					return all.subarray(at + 4, all.indexOf(Buffer.from([0xff, 0xd9]), at) + 2).toString('hex');
				} finally {
					doc.destroy();
				}
			};
			expect(inlineJpeg(packed)).toBe(inlineJpeg(plain));
			expect(inlineJpeg(packed).startsWith('ffd8')).toBe(true);
			expect(await renders(packed)).toEqual(await renders(plain));
		},
		T
	);

	it(
		'jpeg-broken: truncated, 12-bit, arithmetic, lossless and junk before SOI are left byte for byte by the stream pass',
		async () => {
			const bytes = corpus('jpeg-broken.pdf');
			const pnotes: string[] = [];
			const before = await images(bytes);
			const r = await packStreams(qpdf, bytes, { jpeg: {}, note: (n) => pnotes.push(n) });
			const why = pnotes.find((n) => n.startsWith('pack: JPEG')) ?? '';
			expect(why).toMatch(/JPEG 0 repacked/);
			for (const w of ['no EOI', '12-bit', 'frame type c9', 'frame type c3', 'no SOI at the start']) expect(why).toContain(w);
			const m = await mupdf();
			const raws = (b: Uint8Array) => {
				const doc = new m.PDFDocument(b.slice());
				try {
					return Array.from({ length: doc.countPages() }, (_, p) => hex(doc.loadPage(p).getObject().get('Resources').get('XObject').get('Im1').readRawStream().asUint8Array()));
				} finally {
					doc.destroy();
				}
			};
			expect(raws(r.bytes)).toEqual(raws(bytes));
			expect(before).toBeDefined();
		},
		T
	);

	it(
		'a signed file keeps its JPEG images as they are',
		async () => {
			const src = await eng.openPdf(corpus('jpeg-signed.pdf'), 'sig.pdf');
			expect(src.notes.join(' ')).toMatch(/digital signature/);
			notes.length = 0;
			const plain = await exportAll(src, false);
			const packed = await exportAll(src);
			expect(notes.join('\n')).toMatch(/signed file, JPEG images left as they are/);
			const [a] = await images(plain);
			const [b] = await images(packed);
			expect(hex(b.raw)).toBe(hex(a.raw));
		},
		T
	);

	it('leaves a JPEG alone when the repack is not smaller (already repacked)', async () => {
		const img = (await images(corpus('jpeg-kinds.pdf')))[0];
		const first = await repackJpeg(img.jpeg, MB48);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const dict = { '/Type': '/XObject', '/Subtype': '/Image', '/Filter': '/DCTDecode', '/Width': 160, '/Height': 120 };
		expect(await packJpegStream({}, dict, first.jpeg, nativeDeflate)).toEqual({ why: 'not smaller' });
		const again = await packJpegStream({}, dict, img.jpeg, nativeDeflate);
		expect('choice' in again).toBe(true);
		// Not an image, a filter after DCT, a stray filter: left alone.
		expect(await packJpegStream({}, { ...dict, '/Subtype': '/Form' }, img.jpeg, nativeDeflate)).toEqual({ why: 'not an image' });
		expect(await packJpegStream({}, { ...dict, '/Filter': ['/DCTDecode', '/FlateDecode'] }, img.jpeg, nativeDeflate)).toMatchObject({ why: expect.stringMatching(/^filters/) });
		const z = new Uint8Array(zlib.deflateSync(img.jpeg));
		const wrapped = await packJpegStream({}, { ...dict, '/Filter': ['/FlateDecode', '/DCTDecode'] }, z, nativeDeflate);
		expect(wrapped).toHaveProperty('choice');
		if ('choice' in wrapped) expect(strictInflate(wrapped.choice.data)).toEqual(wrapped.choice.input);
		const damaged = z.slice(0, z.length - 30);
		expect(await packJpegStream({}, { ...dict, '/Filter': ['/FlateDecode', '/DCTDecode'] }, damaged, nativeDeflate)).toEqual({ why: 'damaged Flate data' });
	});
});

describe('fallbacks: the images stay as they are', () => {
	async function packKinds(opts: Parameters<typeof packStreams>[2]) {
		const bytes = corpus('jpeg-kinds.pdf');
		const pnotes: string[] = [];
		const r = await packStreams(qpdf, bytes, { ...opts, note: (n) => pnotes.push(n) });
		const a = await images(bytes);
		const b = await images(r.bytes);
		return { r, pnotes, same: a.every((x, i) => hex(x.raw) === hex(b[i].raw)) };
	}

	it(
		'a module that does not compile: no JPEG touched, the rest of the pass and the export still work',
		async () => {
			setJpegRepackModuleForTest(async () => new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 99]));
			const k = await packKinds({ jpeg: {} });
			expect(k.pnotes.join('\n')).toMatch(/JPEG repack did not load/);
			expect(k.same).toBe(true);
			const src = await eng.openPdf(corpus('jpeg-kinds.pdf'), 'k2.pdf');
			notes.length = 0;
			const packed = await exportAll(src);
			expect(notes.join('\n')).toMatch(/JPEG repack did not load/);
			const plain = await exportAll(src, false);
			expect(packed.length).toBeLessThanOrEqual(plain.length);
		},
		T
	);

	it(
		'a repack that changes a coefficient fails its check and is not used',
		async () => {
			await setJpegTamperForTest(3);
			const k = await packKinds({ jpeg: {} });
			expect(k.pnotes.join('\n')).toMatch(/failed its coefficient check/);
			expect(k.r.stats.jpeg).toBe(0);
			expect(k.same).toBe(true);
		},
		T
	);

	it(
		'out of time and over the work budget: nothing started, nothing changed',
		async () => {
			const t = await packKinds({ jpeg: { ms: 0 } });
			expect(t.pnotes.join('\n')).toMatch(/out of time 12/);
			expect(t.same).toBe(true);
			const b = await packKinds({ jpeg: { bytes: 0 } });
			expect(b.pnotes.join('\n')).toMatch(/over the work budget 12/);
			expect(b.same).toBe(true);
			const off = await packKinds({});
			expect(off.r.stats.jpeg).toBe(0);
			expect(off.same).toBe(true);
		},
		T
	);

	it(
		'images over the coefficient cap are left as they are',
		async () => {
			const k = await packKinds({ jpeg: { maxCoefBytes: 10_000 } });
			expect(k.pnotes.join('\n')).toMatch(/too big 12/);
			expect(k.same).toBe(true);
		},
		T
	);
});
