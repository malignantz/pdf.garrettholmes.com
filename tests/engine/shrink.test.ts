import { describe, expect, it } from 'vitest';
import type { PDFDocument, PDFObject } from 'mupdf';
import type { ExportOptions, ExportResult, PageRef, Source } from '../../src/lib/core/types';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { metadataLeft } from '../../src/lib/engine/core';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import {
	LIMITS,
	comparePixels,
	formatSize,
	isPhotoLike,
	metricsPass,
	pngPredict,
	renderAndCompare,
	shrinkToTarget,
	walk
} from '../../src/lib/engine/shrink';
import { corpus, defaultOptions, engine, manifest, nodeAssets, openCorpus, pageTexts, prng, ref } from './helpers';

const T = 120_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

async function run(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}): Promise<ExportResult> {
	return engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, []);
}

function allOk(res: ExportResult) {
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['visual', 'target-size']));
}

const detail = (res: ExportResult, name: string) => res.checks.find((c) => c.name === name)?.detail ?? '';

interface ImageInfo {
	/** "p<page>/<name>" or "p<page>/<form>/<name>" */
	key: string;
	num: number;
	width: number;
	height: number;
	filter: string;
	cs: string;
	raw: string;
	/** Decoded samples (the stored encoding may change in lossless repacking; these may not). */
	data: string;
	smask: { width: number; height: number; raw: string } | null;
	profile: string | null;
}

function hash(b: Uint8Array): string {
	let h1 = 0x811c9dc5;
	let h2 = 0;
	for (let i = 0; i < b.length; i++) {
		h1 = Math.imul(h1 ^ b[i], 0x01000193);
		h2 = (h2 + b[i] * (i + 1)) >>> 0;
	}
	return `${b.length}:${(h1 >>> 0).toString(16)}:${h2.toString(16)}`;
}

function raw(o: PDFObject): string {
	const b = o.readRawStream();
	const s = hash(b.asUint8Array());
	b.destroy();
	return s;
}

function decoded(o: PDFObject): string {
	const b = o.readStream();
	const s = hash(b.asUint8Array());
	b.destroy();
	return s;
}

/** Every image XObject on every page (and one level of forms), keyed by where it is drawn. */
async function images(bytes: Uint8Array, password?: string): Promise<Map<string, ImageInfo>> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	if (password !== undefined) doc.authenticatePassword(password);
	const out = new Map<string, ImageInfo>();
	const visit = (xo: PDFObject, prefix: string, depth: number) => {
		if (!xo.isDictionary()) return;
		xo.forEach((v, k) => {
			const key = `${prefix}/${k}`;
			const sub = v.get('Subtype').asName();
			if (sub === 'Form' && depth < 2) visit(v.get('Resources').get('XObject'), key, depth + 1);
			if (sub !== 'Image') return;
			const sm = v.get('SMask');
			const cs = v.get('ColorSpace');
			out.set(key, {
				key,
				num: v.asIndirect(),
				width: v.get('Width').asNumber(),
				height: v.get('Height').asNumber(),
				filter: v.get('Filter').toString(),
				cs: cs.toString().replace(/\d+ 0 R/g, 'R'),
				raw: raw(v),
				data: decoded(v),
				smask: sm.isNull() ? null : { width: sm.get('Width').asNumber(), height: sm.get('Height').asNumber(), raw: decoded(sm) },
				profile: cs.isArray() && cs.get(0).asName() === 'ICCBased' ? decoded(cs.get(1)) : null
			});
		});
	};
	for (let p = 0; p < doc.countPages(); p++) visit(doc.findPage(p).getInheritable('Resources').get('XObject'), `p${p + 1}`, 0);
	doc.destroy();
	return out;
}

async function qpdfJson(bytes: Uint8Array, password?: string) {
	const res = await qpdf.run({
		args: [...(password ? [`--password=${password}`] : []), '--json-output', '--json-stream-data=none', '/a.pdf', '/a.json'],
		inputs: { '/a.pdf': bytes },
		outputs: ['/a.json']
	});
	const j = JSON.parse(new TextDecoder().decode(res.files.get('/a.json')!));
	return { header: j.qpdf[0], objects: j.qpdf[1] };
}

async function whole(name: string) {
	const src = await openCorpus(name);
	return { src, pages: src.pages.map((_, i) => ref(src, i)) };
}

/** The lossless result: what shrinking starts from and must never exceed. */
async function lossless(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}) {
	return run(pages, sources, { ...options, compress: true });
}

describe('shrink: reaching the target', () => {
	it('reaches a reachable target with the mildest step that fits; text is untouched', async () => {
		const { src, pages } = await whole('shrink-photos.pdf');
		const base = await lossless(pages, [src]);
		const target = Math.round(base.bytes.length * 0.5);
		const res = await run(pages, [src], { targetBytes: target });
		allOk(res);
		expect(res.shrink).toMatchObject({ targetBytes: target, reached: true, dpi: 200 });
		expect(res.shrink!.imagesChanged).toBe(8);
		expect(res.bytes.length).toBeLessThanOrEqual(target);
		expect(detail(res, 'target-size')).toMatch(/^\d+ KB, under the \d+ KB target\. 8 images were reduced to at most 200 pixels per inch\.$/);
		expect(detail(res, 'visual')).toMatch(/^Rendered all 12 pages of the original and the reduced file at 50 pixels per inch/);
		expect(await pageTexts(res.bytes)).toEqual(await pageTexts(base.bytes));
	}, T);

	it('goes further down the ladder for smaller targets, never above the lossless size', async () => {
		const { src, pages } = await whole('shrink-photos.pdf');
		const base = await lossless(pages, [src]);
		let prev = { size: Infinity, dpi: Infinity };
		// dpi 0: no image was changed (the target was reached losslessly).
		const cap = (dpi: number) => (dpi === 0 ? Infinity : dpi);
		for (const target of [400_000, 80_000, 50_000, 40_000]) {
			const res = await run(pages, [src], { targetBytes: target });
			allOk(res);
			expect(res.bytes.length).toBeLessThanOrEqual(base.bytes.length);
			expect(res.bytes.length).toBeLessThanOrEqual(prev.size);
			expect(cap(res.shrink!.dpi)).toBeLessThanOrEqual(prev.dpi);
			if (res.shrink!.reached) expect(res.bytes.length).toBeLessThanOrEqual(target);
			prev = { size: res.bytes.length, dpi: cap(res.shrink!.dpi) };
		}
		expect(prev.dpi).toBeLessThan(200);
	}, T);

	it('returns the smallest file with reached false when the target is out of reach', async () => {
		const { src, pages } = await whole('shrink-photos.pdf');
		const base = await lossless(pages, [src]);
		const res = await run(pages, [src], { targetBytes: 20_000 });
		allOk(res);
		expect(res.shrink).toMatchObject({ targetBytes: 20_000, reached: false, dpi: 72 });
		expect(res.bytes.length).toBeGreaterThan(20_000);
		expect(res.bytes.length).toBeLessThan(base.bytes.length / 5);
		expect(detail(res, 'target-size')).toMatch(/; the target was 20 KB\. This is the smallest this file can get without damaging text\./);
		// Nothing milder is smaller.
		const milder = await run(pages, [src], { targetBytes: 30_000 });
		expect(milder.bytes.length).toBeGreaterThanOrEqual(res.bytes.length);
	}, T);

	it('leaves files with nothing safe to reduce exactly as the lossless export', async () => {
		for (const name of ['shrink-skips.pdf', 'shrink-text.pdf']) {
			const { src, pages } = await whole(name);
			const base = await lossless(pages, [src]);
			const res = await run(pages, [src], { targetBytes: 20_000 });
			allOk(res);
			// The same file (qpdf gives each run a fresh /ID, so compare size and images).
			expect(res.bytes.length).toBe(base.bytes.length);
			expect(await images(res.bytes)).toEqual(await images(base.bytes));
			expect(res.shrink!.imagesChanged).toBe(0);
			expect(res.shrink!.dpi).toBe(0);
			expect(detail(res, 'visual')).toBe('No image was changed, so every page is exactly as before.');
			if (name === 'shrink-skips.pdf') {
				expect(res.shrink!.reached).toBe(false);
				expect(detail(res, 'target-size')).toMatch(/It has no photos or scans that can be reduced safely\.$/);
			} else {
				expect(res.shrink!.reached).toBe(true);
				expect(detail(res, 'target-size')).toMatch(/under the 20 KB target\. No image needed to change\.$/);
			}
		}
	}, T);
});

describe('shrink: which images change and how', () => {
	it('keeps every skipped kind byte-identical while photos in the same file shrink', async () => {
		const photos = await openCorpus('shrink-photos.pdf');
		const skips = await openCorpus('shrink-skips.pdf');
		const pages = [...skips.pages.map((_, i) => ref(skips, i)), ...photos.pages.map((_, i) => ref(photos, i))];
		const base = await lossless(pages, [skips, photos]);
		const res = await run(pages, [skips, photos], { targetBytes: Math.round(base.bytes.length * 0.6) });
		allOk(res);
		expect(res.shrink!.reached).toBe(true);
		const before = await images(base.bytes);
		const after = await images(res.bytes);
		expect([...after.keys()]).toEqual([...before.keys()]);
		// Skips: pages 1–6. 1-bit, CMYK, Indexed, tiny icons, /Mask (colour key and stencil), ImageMask, 16-bit, /Decode.
		const skipKeys = [...before.keys()].filter((k) => Number(k.slice(1, k.indexOf('/'))) <= 6);
		expect(skipKeys.length).toBe(10);
		// Same samples; the stored bytes may differ, since lossless repacking spends a time budget.
		const same = ({ raw: _raw, ...rest }: ImageInfo) => rest;
		for (const k of skipKeys) expect(same(after.get(k)!), k).toEqual(same(before.get(k)!));
		// Flat line art (photos p12) is not JPEG'd; downsampled Flate was not smaller here, so it is unchanged.
		expect(same(after.get('p18/Im0')!)).toEqual(same(before.get('p18/Im0')!));
		// Every photo-like image on photos pages 1–11 changed.
		for (const p of [1, 2, 3, 4, 5, 6, 7, 8, 10, 11]) expect(after.get(`p${p + 6}/Im0`)!.raw, `photos p${p}`).not.toBe(before.get(`p${p + 6}/Im0`)!.raw);
	}, T);

	it('caps resolution by the largest placement, through forms, on rotated pages, keeping ICC and soft masks', async () => {
		const { src, pages } = await whole('shrink-photos.pdf');
		const base = await lossless(pages, [src]);
		const res = await run(pages, [src], { targetBytes: Math.round(base.bytes.length * 0.5) });
		allOk(res);
		expect(res.shrink!.dpi).toBe(200);
		const before = await images(base.bytes);
		const after = await images(res.bytes);
		const at = (k: string) => after.get(k)!;
		// p1: 360×270 drawn 1.2 in wide → 240×180 JPEG; the same object on p6–p8.
		expect(at('p1/Im0')).toMatchObject({ width: 240, height: 180, filter: '/DCTDecode', cs: '/DeviceRGB' });
		for (const p of [6, 7, 8]) expect(at(`p${p}/Im0`).num).toBe(at('p1/Im0').num);
		// p2: Flate photo → JPEG.
		expect(at('p2/Im0')).toMatchObject({ width: 200, height: 150, filter: '/DCTDecode' });
		// p3: grey scan stays grey.
		expect(at('p3/Im0')).toMatchObject({ width: 300, height: 400, filter: '/DCTDecode', cs: '/DeviceGray' });
		// p4: rotated page.
		expect(at('p4/Im0')).toMatchObject({ width: 200, height: 150 });
		// p5: drawn at 0.5 in and 1.6 in: capped by the larger one (1.6 × 200 = 320).
		expect(at('p5/Im0')).toMatchObject({ width: 320, height: 240 });
		expect(at('p5/Im1').num).toBe(at('p5/Im0').num);
		// p9: only inside a Form XObject whose /Matrix scales it to 1 in.
		expect(at('p9/Im0/F0')).toMatchObject({ width: 200, height: 150, filter: '/DCTDecode' });
		// p10: ICC profile reference kept, profile bytes unchanged.
		expect(at('p10/Im0').cs).toBe('[/ICCBased R]');
		expect(at('p10/Im0').profile).toBe(before.get('p10/Im0')!.profile);
		expect(at('p10/Im0').width).toBe(240);
		// p11: base image reduced; its soft mask kept as it was (its own size, same samples).
		expect(at('p11/Im0')).toMatchObject({ width: 200, height: 150, filter: '/DCTDecode' });
		expect(at('p11/Im0').smask).toEqual(before.get('p11/Im0')!.smask);
		expect(at('p11/Im0').smask).toMatchObject({ width: 150, height: 112 });
	}, T);

	it('decides photo versus line art by colours and flat runs', () => {
		const rnd = prng(3);
		const w = 200;
		const h = 120;
		const photo = new Uint8Array(w * h * 3).map((_, i) => 100 + ((i * 7) % 50) + Math.floor(rnd() * 12));
		const flat = new Uint8Array(w * h * 3).map((_, i) => (Math.floor(i / 3 / 40) % 2 ? 255 : 20));
		const grey = new Uint8Array(w * h).map((_, i) => 40 + ((i * 3) % 150) + Math.floor(rnd() * 30));
		expect(isPhotoLike(photo, w, h, 3)).toBe(true);
		expect(isPhotoLike(flat, w, h, 3)).toBe(false);
		expect(isPhotoLike(grey, w, h, 1)).toBe(true);
	});

	it('writes PNG-predicted Flate that decodes back to the same samples', async () => {
		const m = await mupdf();
		const rnd = prng(9);
		const w = 37;
		const h = 23;
		for (const n of [1, 3]) {
			const px = new Uint8Array(w * h * n).map((_, i) => (i % 5 === 0 ? Math.floor(rnd() * 256) : (i * 3) & 255));
			const doc = new m.PDFDocument();
			const parms = doc.newDictionary();
			parms.put('Predictor', 15);
			parms.put('Colors', n);
			parms.put('BitsPerComponent', 8);
			parms.put('Columns', w);
			const dict = doc.newDictionary();
			dict.put('Filter', doc.newName('FlateDecode'));
			dict.put('DecodeParms', parms);
			const zipped = await new Response(new Blob([pngPredict(px, w, h, n)]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
			const s = doc.addRawStream(new Uint8Array(zipped), dict);
			expect(Array.from(s.readStream().asUint8Array())).toEqual(Array.from(px));
			doc.destroy();
		}
	});
});

describe('shrink: content walking', () => {
	async function walkPage(content: string, forms: Record<string, string> = {}) {
		const m = await mupdf();
		const doc = new m.PDFDocument();
		const img = doc.addRawStream(new Uint8Array(4), doc.newDictionary());
		img.put('Subtype', doc.newName('Image'));
		const xo = doc.newDictionary();
		xo.put('Im0', img);
		for (const [name, body] of Object.entries(forms)) {
			const fres = doc.newDictionary();
			const fxo = doc.newDictionary();
			fxo.put('Im0', img);
			fres.put('XObject', fxo);
			const f = doc.addStream(body, doc.newDictionary());
			f.put('Subtype', doc.newName('Form'));
			f.put('Resources', fres);
			const mtx = doc.newArray();
			for (const v of [2, 0, 0, 2, 0, 0]) mtx.push(v);
			f.put('Matrix', mtx);
			xo.put(name, f);
			fxo.put(name, f);
		}
		const res = doc.newDictionary();
		res.put('XObject', xo);
		const hits: number[][] = [];
		walk(new TextEncoder().encode(content), res, [1, 0, 0, 1, 0, 0], [], (_n, ctm) => hits.push(ctm.map((v) => Math.round(v * 100) / 100)), () => {});
		return hits;
	}

	it('tracks q/Q/cm and form matrices; skips strings, arrays and inline images', async () => {
		const content = [
			'q 100 0 0 50 10 20 cm /Im0 Do Q',
			'BT (a\\) (Do) q 9 9 9 9 9 9 cm) Tj [(x) 5 (y)] TJ ET',
			'BI /W 4 /H 1 /CS /G /BPC 8 ID \x00EI\x01 EI',
			'q 0 1 -1 0 0 0 cm 10 0 0 10 0 0 cm /Im0 Do Q',
			'/Fm#30 Do',
			'% comment /Im0 Do',
			'<< /MCID 1 >> BDC 3 0 0 3 0 0 cm /Im0 Do EMC'
		].join('\n');
		const hits = await walkPage(content, { Fm0: 'q 5 0 0 5 1 1 cm /Im0 Do Q' });
		expect(hits).toEqual([
			[100, 0, 0, 50, 10, 20],
			[0, 10, -10, 0, 0, 0],
			[10, 0, 0, 10, 2, 2],
			[3, 0, 0, 3, 0, 0]
		]);
	});

	it('refuses content it cannot follow', async () => {
		await expect(walkPage('q 1 0 0 cm /Im0 Do Q')).rejects.toThrow(/bad cm/);
		await expect(walkPage('BI /W 4 ID garbage-without-end')).rejects.toThrow(/inline image/);
		await expect(walkPage('/Fm0 Do', { Fm0: '/Fm0 Do' })).rejects.toThrow(/cycle/);
	});
});

describe('shrink: visual check', () => {
	const w = 64;
	const h = 48;
	const base = () => {
		const rnd = prng(5);
		return new Uint8Array(w * h * 3).map((_, i) => 60 + ((i * 13) % 120) + Math.floor(rnd() * 20));
	};

	it('passes identical and mildly noisy renders', () => {
		const a = base();
		expect(comparePixels(a, a, w, h, 3)).toEqual({ pageMean: 0, blockMean: 0, blockBias: 0 });
		const rnd = prng(6);
		const b = a.map((v) => Math.max(0, Math.min(255, v + Math.round((rnd() - 0.5) * 12))));
		expect(metricsPass(comparePixels(a, b, w, h, 3))).toBe(true);
	});

	it('fails inverted, blacked-out, shifted and colour-shifted renders', () => {
		const a = base();
		const inverted = a.map((v) => 255 - v);
		const black = a.slice();
		for (let y = 10; y < 30; y++) black.fill(0, (y * w + 10) * 3, (y * w + 30) * 3);
		const shifted = new Uint8Array(a.length).fill(255);
		for (let y = 0; y < h; y++) for (let x = 6; x < w; x++) for (let k = 0; k < 3; k++) shifted[(y * w + x) * 3 + k] = a[(y * w + x - 6) * 3 + k];
		const tinted = a.map((v, i) => (i % 3 === 0 ? Math.min(255, v + 20) : v));
		for (const [name, b] of Object.entries({ inverted, black, shifted, tinted })) {
			expect(metricsPass(comparePixels(a, b, w, h, 3)), name).toBe(false);
		}
	});

	/** Applies `change` to a copy of the photos corpus file and compares page `p` with the original. */
	async function corrupt(p: number, change: (doc: PDFDocument, image: PDFObject, page: PDFObject) => void) {
		const m = await mupdf();
		const bytes = corpus('shrink-photos.pdf');
		const a = new m.PDFDocument(bytes);
		const b = new m.PDFDocument(bytes);
		const page = b.findPage(p);
		change(b, page.getInheritable('Resources').get('XObject').get('Im0'), page);
		const c = new m.PDFDocument(b.saveToBuffer('').asUint8Array().slice());
		const x = renderAndCompare(m, a, c, p);
		a.destroy();
		b.destroy();
		c.destroy();
		return x!;
	}

	async function solidJpeg(w: number, h: number, value: number) {
		const m = await mupdf();
		const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
		pix.clear(value);
		return pix.asJPEG(90).slice();
	}

	it('catches real breakage in rendered pages, and passes the harshest honest reduction', async () => {
		const white = await solidJpeg(360, 270, 255);
		const black = await solidJpeg(360, 270, 0);
		const cases: Record<string, PageMetricsLike> = {
			inverted: await corrupt(0, (d, im) => {
				const arr = d.newArray();
				for (const v of [1, 0, 1, 0, 1, 0]) arr.push(v);
				im.put('Decode', arr);
			}),
			missing: await corrupt(0, (_d, im) => im.writeRawStream(white)),
			black: await corrupt(0, (_d, im) => im.writeRawStream(black)),
			shifted: await corrupt(0, (d, _im, page) => {
				const contents = page.get('Contents');
				for (let i = 0; i < contents.length; i++) {
					const s = contents.get(i);
					const text = s.readStream().asString();
					if (text.includes('/Im0 Do')) s.writeStream(text.replace(/ 72 600 cm/, ' 90 600 cm'));
				}
				void d;
			}),
			'ICC profile dropped': await corrupt(9, (d, im) => im.put('ColorSpace', d.newName('DeviceRGB'))),
			'grey read as RGB': await corrupt(2, (d, im) => im.put('ColorSpace', d.newName('DeviceRGB')))
		};
		for (const [name, x] of Object.entries(cases)) expect(metricsPass(x), `${name}: ${JSON.stringify(x)}`).toBe(false);

		// The harshest step, compared the same way, passes with room to spare.
		const { src, pages } = await whole('shrink-photos.pdf');
		const res = await run(pages, [src], { targetBytes: 20_000 });
		expect(res.shrink!.dpi).toBe(72);
		const m = await mupdf();
		const a = new m.PDFDocument(corpus('shrink-photos.pdf'));
		const b = new m.PDFDocument(res.bytes);
		for (let p = 0; p < 12; p++) {
			const x = renderAndCompare(m, a, b, p)!;
			expect(x.blockMean, `page ${p + 1}`).toBeLessThan(LIMITS.blockMean / 2);
			expect(x.blockBias, `page ${p + 1}`).toBeLessThan(LIMITS.blockBias / 2);
		}
		a.destroy();
		b.destroy();
	}, T);

	it('restores the original file when reduced pages do not match', async () => {
		const bytes = corpus('shrink-photos.pdf');
		const deps = { mupdf } as unknown as EngineDeps;
		const finalize = async (b: Uint8Array) => {
			const r = await qpdf.run({ args: ['/i.pdf', '--object-streams=generate', '--compress-streams=y', '--recompress-flate', '/o.pdf'], inputs: { '/i.pdf': b }, outputs: ['/o.pdf'] });
			return r.files.get('/o.pdf')!;
		};
		const lossless = await finalize(bytes);
		const strict = { blockMean: 0.01, blockBias: 0.01, pageMean: 0.01 };
		const r = await shrinkToTarget(deps, bytes, 200_000, finalize, { limits: strict });
		expect(r.bytes.length).toBe(lossless.length);
		expect(r.shrink).toEqual({ targetBytes: 200_000, reached: false, imagesChanged: 0, dpi: 0 });
		expect(r.checks.every((c) => c.ok)).toBe(true);
		expect(r.checks.find((c) => c.name === 'visual')!.detail).toMatch(/did not match the original closely enough on page 1, 2, 3/);

		// Strict enough to fail only the grey scan (p3): its image is restored, the rest stay reduced.
		const lines: string[] = [];
		const partial = await shrinkToTarget(deps, bytes, 200_000, finalize, { limits: { ...LIMITS, blockMean: 4 }, trace: (l) => lines.push(l) });
		expect(partial.checks.every((c) => c.ok)).toBe(true);
		expect(partial.shrink).toMatchObject({ reached: true, imagesChanged: 7, dpi: 200 });
		expect(partial.checks.find((c) => c.name === 'visual')!.detail).toMatch(/Images on page 3 were kept as they were/);
		expect(lines.some((l) => /visual check .*: 1 pages failed/.test(l))).toBe(true);
		const kept = await images(partial.bytes);
		expect(kept.get('p3/Im0')).toEqual((await images(lossless)).get('p3/Im0'));
		expect(kept.get('p1/Im0')!.width).toBe(240);
	}, T);
});

type PageMetricsLike = ReturnType<typeof comparePixels>;

describe('shrink: through the whole export', () => {
	it('works with a password and metadata removal', async () => {
		const { src, pages } = await whole('shrink-photos.pdf');
		const base = await lossless(pages, [src]);
		const res = await run(pages, [src], { targetBytes: Math.round(base.bytes.length * 0.3), password: 'pw ✓', stripMetadata: true });
		allOk(res);
		expect(res.checks.find((c) => c.name === 'encryption')?.ok).toBe(true);
		expect(res.shrink!.reached).toBe(true);
		expect(res.shrink!.imagesChanged).toBeGreaterThan(0);
		expect(await pageTexts(res.bytes, 'pw ✓')).toEqual(await pageTexts(base.bytes));
		expect(metadataLeft(await qpdfJson(res.bytes, 'pw ✓'))).toEqual([]);
		const imgs = await images(res.bytes, 'pw ✓');
		expect(imgs.get('p1/Im0')!.filter).toBe('/DCTDecode');
	}, T);

	it('gives clean results for every corpus file at the smallest target', async () => {
		for (const [name, meta] of Object.entries(manifest)) {
			if (meta.expect === 'unreadable') continue;
			let src: Source;
			if (name.endsWith('.jpg')) src = await engine().openImage(corpus(name), 'image/jpeg', name);
			else if (name.endsWith('.png')) src = await engine().openImage(corpus(name), 'image/png', name);
			else src = await openCorpus(name, typeof meta.password === 'string' ? meta.password : undefined);
			const res = await run(src.pages.map((_, i) => ref(src, i)), [src], { targetBytes: 20_000 });
			allOk(res);
			expect(res.shrink!.reached, name).toBe(res.bytes.length <= 20_000);
		}
		// Everything at once, with rotations.
		const all: Source[] = [];
		for (const name of ['multi.pdf', 'rotated.pdf', 'userunit.pdf', 'form.pdf', 'shrink-photos.pdf', 'shrink-skips.pdf', 'inherited.pdf']) all.push(await openCorpus(name));
		const pages = all.flatMap((s) => s.pages.map((_, i) => ref(s, i, ((i % 4) * 90) as 0)));
		const res = await run(pages, all, { targetBytes: 20_000 });
		allOk(res);
		expect(res.shrink!.reached).toBe(false);
		expect(res.shrink!.imagesChanged).toBe(8);
	}, T);

	it('formats sizes in plain words', () => {
		expect(formatSize(640_400)).toBe('640 KB');
		expect(formatSize(3_140_000)).toBe('3.1 MB');
		expect(formatSize(10_000_000)).toBe('10 MB');
		expect(formatSize(12_340_000)).toBe('12.3 MB');
	});
});
