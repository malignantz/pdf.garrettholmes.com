/**
 * Lossless compression at export (core.ts finalize → cleanup.ts, pack.ts, libdeflate.ts):
 * never bigger, pixels and text unchanged, structure kept, form fonts not subset.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import type { ExportOptions, PageRef, Source } from '../../src/lib/core/types';
import { createCoreEngine, type LosslessPasses } from '../../src/lib/engine/core';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { dumpStreams, packStreams, strictInflate } from '../../src/lib/engine/pack';
import { cleanupWithMupdf, estimateCleanup, needsFormFonts, sameStructure } from '../../src/lib/engine/cleanup';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { libdeflateZlib } from '../../src/lib/engine/libdeflate';
import { LIBDEFLATE_WASM_SHA256 } from '../../src/lib/engine/vendor/libdeflate/wasm';
import wasm64 from '../../src/lib/engine/vendor/libdeflate/wasm';
import { corpus, loadPdfjs, manifest, nodeAssets, pageTexts } from './helpers';

const T = 120_000;
const qpdf = new Qpdf(nodeAssets().qpdf);
const deps = { mupdf } as unknown as EngineDeps;

function engineWith(lossless?: LosslessPasses) {
	const notes: string[] = [];
	const e = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n), lossless });
	return { e, notes };
}
const auto = engineWith();
const always = engineWith({ cleanup: 'always' });

async function exportAll(e: ReturnType<typeof engineWith>['e'], src: Source, options: Partial<ExportOptions> = {}, pages?: PageRef[]) {
	const refs = pages ?? src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
	const res = await e.exportPlan({ pages: refs, options: { filename: 'o.pdf', compress: true, stripMetadata: false, ...options } }, [src], []);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res.bytes;
}

/** Every page rendered by MuPDF, RGB bytes. */
async function renders(bytes: Uint8Array): Promise<Uint8ClampedArray[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes.slice());
	try {
		const out: Uint8ClampedArray[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			const pix = doc.loadPage(i).toPixmap(m.Matrix.scale(1, 1), m.ColorSpace.DeviceRGB, false, true);
			out.push(pix.getPixels().slice());
			pix.destroy();
		}
		return out;
	} finally {
		doc.destroy();
	}
}

/** Image and font-file streams: object count and decoded bytes. */
async function streamsOf(bytes: Uint8Array) {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes.slice());
	try {
		const images: { parms: string; pixels: Uint8Array }[] = [];
		const fonts: number[] = [];
		const n = doc.countObjects();
		for (let i = 1; i < n; i++) {
			const o = doc.newIndirect(i);
			if (o.isStream() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Image') {
				images.push({ parms: String(o.get('DecodeParms')), pixels: o.readStream().asUint8Array().slice() });
			}
			if (!o.isStream() && o.isDictionary() && o.get('Type').isName() && o.get('Type').asName() === 'FontDescriptor') {
				for (const k of ['FontFile', 'FontFile2', 'FontFile3']) if (o.get(k).isStream()) fonts.push(o.get(k).readStream().getLength());
			}
		}
		return { images, fonts };
	} finally {
		doc.destroy();
	}
}

describe('lossless compress', () => {
	it(
		'keeps a PNG predictor and pixels exactly (the predictor growth bug)',
		async () => {
			const input = corpus('compress-predictor.pdf');
			const src = await auto.e.openPdf(input, 'p.pdf');
			const plain = await exportAll(auto.e, src, { compress: false });
			const packed = await exportAll(auto.e, src);
			// Before the fix qpdf --recompress-flate dropped the predictor: 71 KB in, 190 KB out.
			expect(packed.length).toBeLessThanOrEqual(plain.length);
			expect(packed.length).toBeLessThan(input.length);
			const a = await streamsOf(plain);
			const b = await streamsOf(packed);
			expect(b.images).toHaveLength(1);
			expect(b.images[0].parms).toMatch(/Predictor/);
			expect(b.images[0].pixels).toEqual(a.images[0].pixels);
			expect(await renders(packed)).toEqual(await renders(plain));
			expect(await pageTexts(packed)).toEqual(['predictor p1']);
		},
		T
	);

	it(
		'gives images-to-PDF pages a PNG predictor',
		async () => {
			const png = corpus('alpha.png');
			const src = await auto.e.openImage(png, 'image/png', 'a.png');
			const plain = await exportAll(auto.e, src, { compress: false });
			const packed = await exportAll(auto.e, src);
			expect(packed.length).toBeLessThanOrEqual(plain.length);
			const a = await streamsOf(plain);
			const b = await streamsOf(packed);
			expect(b.images.map((i) => i.pixels)).toEqual(a.images.map((i) => i.pixels));
			expect(await renders(packed)).toEqual(await renders(plain));
		},
		T
	);

	it(
		'merges a font and an image embedded twice; pages and text unchanged',
		async () => {
			const src = await auto.e.openPdf(corpus('compress-dupes.pdf'), 'd.pdf');
			auto.notes.length = 0;
			const plain = await exportAll(auto.e, src, { compress: false });
			const packed = await exportAll(auto.e, src);
			expect(auto.notes.join('\n')).toMatch(/cleanup: .*run/);
			expect(packed.length).toBeLessThan(plain.length * 0.4);
			const a = await streamsOf(plain);
			const b = await streamsOf(packed);
			expect(a.images).toHaveLength(2);
			expect(a.fonts).toHaveLength(2);
			expect(b.images).toHaveLength(1);
			expect(b.fonts).toHaveLength(1);
			expect(await renders(packed)).toEqual(await renders(plain));
			expect(await pageTexts(packed)).toEqual(await pageTexts(plain));
		},
		T
	);

	it(
		'does not subset the fonts of a fillable form, which stays fillable',
		async () => {
			const input = corpus('compress-form-fonts.pdf');
			const dump = (await dumpStreams(qpdf, input))!;
			expect(needsFormFonts(dump.objects)).toBe(true);
			expect((await estimateCleanup(dump)).subset).toBe(false);
			const src = await always.e.openPdf(input, 'f.pdf');
			const plain = await exportAll(always.e, src, { compress: false });
			const packed = await exportAll(always.e, src);
			const a = await streamsOf(plain);
			const b = await streamsOf(packed);
			expect(b.fonts).toEqual(a.fonts);
			const fields = await always.e.formFields({ ...src, bytes: packed });
			expect(fields.map((f) => f.name)).toContain('name');
			// Typing new letters after compressing still works and reads back.
			const again = await always.e.openPdf(packed, 'again.pdf');
			const refs = again.pages.map((_, i) => ({ id: `q${i}`, sourceId: again.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
			const res = await always.e.exportPlan(
				{ pages: refs, options: { filename: 'o.pdf', compress: true, stripMetadata: false }, formValues: { [again.id]: { name: 'Zoë Quinn-Wexford' } } },
				[again],
				[]
			);
			expect(res.checks.every((c) => c.ok)).toBe(true);
			expect(await renders(res.bytes)).toHaveLength(1);
		},
		T
	);

	it(
		'subsets an embedded font; text, outline, link, page labels and attachment unchanged',
		async () => {
			const src = await always.e.openPdf(corpus('compress-subset.pdf'), 's.pdf');
			const plain = await exportAll(always.e, src, { compress: false });
			const packed = await exportAll(always.e, src);
			const a = await streamsOf(plain);
			const b = await streamsOf(packed);
			expect(b.fonts).toHaveLength(1);
			expect(b.fonts[0]).toBeLessThan(a.fonts[0] * 0.7);
			expect(await renders(packed)).toEqual(await renders(plain));
			expect(await pageTexts(packed)).toEqual(await pageTexts(plain));
			expect(await facts(packed)).toEqual(await facts(plain));
			// The export drops the attachments (and kept the outline only since outline.ts); the
			// cleanup itself keeps both: run it on the file directly.
			const input = corpus('compress-subset.pdf');
			const cleaned = await cleanupWithMupdf(deps, input, true, () => {});
			expect(cleaned).not.toBeNull();
			const fi = await facts(input);
			expect(JSON.parse(fi.outline)).toHaveLength(2);
			expect(fi.attachments).toHaveLength(1);
			expect(await facts(cleaned!)).toEqual(fi);
			expect(sameStructure((await dumpStreams(qpdf, input))!, (await dumpStreams(qpdf, cleaned!))!)).toBeNull();
		},
		T
	);

	it(
		'keeps tagged-PDF structure, layers, metadata and signature fields',
		async () => {
			const input = await structured();
			const src = await always.e.openPdf(input, 't.pdf');
			const plain = await exportAll(always.e, src, { compress: false });
			const packed = await exportAll(always.e, src);
			expect(packed.length).toBeLessThanOrEqual(plain.length);
			expect(await facts(packed)).toEqual(await facts(plain));
			expect(await renders(packed)).toEqual(await renders(plain));
			const cleaned = await cleanupWithMupdf(deps, input, false, () => {});
			expect(await facts(cleaned!)).toEqual(await facts(input));
			expect((await facts(input)).pages[0].tree).not.toBeNull();
			expect(sameStructure((await dumpStreams(qpdf, input))!, (await dumpStreams(qpdf, cleaned!))!)).toBeNull();
			const layers = await always.e.openPdf(corpus('layers.pdf'), 'l.pdf');
			expect(await facts(await exportAll(always.e, layers))).toEqual(await facts(await exportAll(always.e, layers, { compress: false })));
		},
		T
	);

	it(
		'is never bigger than the same export without compression, across the corpus',
		async () => {
			const names = Object.keys(manifest).filter((n) => n.endsWith('.pdf') && !manifest[n].expect && !/^enc-|password/.test(n));
			let checked = 0;
			for (const name of names) {
				let src: Source;
				try {
					src = await auto.e.openPdf(corpus(name), name);
				} catch {
					continue;
				}
				const refs = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0 as const, stamps: [] }));
				const run = async (compress: boolean) => {
					try {
						return (await auto.e.exportPlan({ pages: refs, options: { filename: 'o.pdf', compress, stripMetadata: false } }, [src], [])).bytes;
					} catch {
						return null;
					}
				};
				const plain = await run(false);
				const packed = await run(true);
				if (!plain) continue;
				expect(packed, name).not.toBeNull();
				expect(packed!.length, name).toBeLessThanOrEqual(plain.length);
				checked++;
			}
			expect(checked).toBeGreaterThan(40);
		},
		10 * T
	);
});

describe('cleanup guard', () => {
	it(
		'does not use a MuPDF result that rounded a number (MuPDF keeps reals as 32-bit floats)',
		async () => {
			// A4 in points to five decimals, and a page that repeats an image (worth merging).
			const doc = await PDFDocument.load(corpus('compress-dupes.pdf'));
			for (const p of doc.getPages()) p.setMediaBox(0, 0, 595.27559, 841.88977);
			const input = await doc.save({ useObjectStreams: false });
			const src = await always.e.openPdf(input, 'r.pdf');
			always.notes.length = 0;
			const plain = await exportAll(always.e, src, { compress: false });
			const packed = await exportAll(always.e, src);
			expect(always.notes.join('\n')).toMatch(/cleanup: result rejected \(number .* is new/);
			expect(packed.length).toBeLessThanOrEqual(plain.length);
			expect(await renders(packed)).toEqual(await renders(plain));
		},
		T
	);
});

describe('cleanup rules', () => {
	it(
		'keeps two equal layers two layers (a merged result is not used)',
		async () => {
			const doc = await PDFDocument.load(corpus('compress-dupes.pdf'));
			const ctx = doc.context;
			const a = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Names') }));
			const b = ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of('Names') }));
			doc.catalog.set(PDFName.of('OCProperties'), ctx.obj({ OCGs: [a, b], D: { Order: [a, b], ON: [a, b] } }));
			doc.getPages().forEach((p, i) => {
				const res = p.node.Resources()!;
				res.set(PDFName.of('Properties'), ctx.obj({ L: i === 0 ? a : b }));
				p.pushOperators();
				const contents = p.node.Contents()!;
				(contents as unknown as { push: (r: unknown) => void }).push(ctx.register(ctx.stream('/OC /L BDC 0 0 m 10 10 l S EMC\n')));
			});
			const input = await doc.save({ useObjectStreams: false });
			const src = await always.e.openPdf(input, 'oc.pdf');
			always.notes.length = 0;
			const plain = await exportAll(always.e, src, { compress: false });
			const packed = await exportAll(always.e, src);
			expect(always.notes.join('\n')).toMatch(/cleanup: result rejected \(\/OCG objects 2 → 1\)/);
			const layers = (await facts(packed)).oc;
			expect(layers).toEqual((await facts(plain)).oc);
			expect(layers).toHaveLength(2);
		},
		T
	);

	it('does not subset when a Type 1 font is embedded', async () => {
		const objects = {
			trailer: { value: { '/Root': '1 0 R' } },
			'obj:1 0 R': { value: { '/Type': '/Catalog' } },
			'obj:2 0 R': { value: { '/Type': '/FontDescriptor', '/FontName': '/CMR10', '/FontFile': '3 0 R' } },
			'obj:3 0 R': { stream: { dict: { '/Length1': 10 } } }
		};
		const est = await estimateCleanup({ header: {}, objects, data: new Map([['obj:3 0 R', new Uint8Array(5000)]]) });
		expect(est.subset).toBe(false);
		expect(est.fullFontBytes).toBe(5000);
		expect(est.gain).toBe(0);
	});
});

describe('stream pass limits', () => {
	it('leaves every stream alone once the time budget is spent, and survives a failing compressor', async () => {
		const input = corpus('compress-predictor.pdf');
		const late = await packStreams(qpdf, input, { deadline: 0 });
		expect(late.bytes).toBe(input);
		expect(late.stats.outOfTime).toBeGreaterThan(0);
		const notes: string[] = [];
		const broken = await packStreams(qpdf, input, { deflate: { name: 'x', zlib: () => Promise.reject(new Error('boom')) }, note: (n) => notes.push(n) });
		expect(broken.bytes).toBe(input);
		expect(notes.join(' ')).toMatch(/boom/);
	});
});

describe('vendored libdeflate', () => {
	it('is the recorded module and round-trips at every level', async () => {
		const bytes = Uint8Array.from(atob(wasm64), (c) => c.charCodeAt(0));
		const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
		expect([...hash].map((b) => b.toString(16).padStart(2, '0')).join('')).toBe(LIBDEFLATE_WASM_SHA256);
		const data = new TextEncoder().encode('0 0 m 100 100 l S\n'.repeat(5000));
		for (const level of [1, 6, 9, 12]) expect(strictInflate(await libdeflateZlib(data, level))).toEqual(data);
		expect(strictInflate(await libdeflateZlib(new Uint8Array(0), 12))).toEqual(new Uint8Array(0));
	});
});

/** Outline, attachments, page labels, links, fields, signatures, layers, struct trees, metadata (PDF.js). */
async function facts(bytes: Uint8Array) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const att = await doc.getAttachments();
		const fields = await doc.getFieldObjects();
		const oc = await doc.getOptionalContentConfig();
		const md = await doc.getMetadata();
		const pages = [];
		// Destinations by page number, not object number (objects are renumbered).
		const dest = async (d: unknown) => (Array.isArray(d) && d[0] && typeof d[0] === 'object' ? [await doc.getPageIndex(d[0]), ...d.slice(1)] : (d ?? null));
		const outline = async (items: { title: string; dest: unknown; items: unknown[] }[] | null): Promise<unknown> =>
			items ? Promise.all(items.map(async (o) => [o.title, await dest(o.dest), await outline(o.items as never)])) : null;
		for (let i = 1; i <= doc.numPages; i++) {
			const p = await doc.getPage(i);
			const annots = [];
			for (const a of (await p.getAnnotations()) as Record<string, unknown>[]) annots.push([a.subtype, await dest(a.dest), a.url ?? null, a.fieldName ?? null]);
			pages.push({
				annots,
				// Content ids name the page object (p5R_mc0), whose number the writers choose: compared by MCID.
				tree: JSON.parse(JSON.stringify(await p.getStructTree()).replace(/"p\d+R_mc(\d+)"/g, '"mc$1"').replace(/"pdfjs_internal_id_\d+R"/g, '"annot"'))
			});
		}
		const { PDFFormatVersion: _v, ...info } = md.info as Record<string, unknown>;
		return {
			outline: JSON.stringify(await outline(await doc.getOutline())),
			attachments: att
				? ((att instanceof Map ? [...att.values()] : Object.values(att)) as { filename: string; description?: string }[]).map((a) => [a.filename, a.description ?? null])
				: null,
			labels: await doc.getPageLabels(),
			fields: fields ? Object.entries(fields).map(([k, v]) => [k, (v as { type: string; value: unknown }[]).map((x) => [x.type, x.value])]) : null,
			oc: oc ? [...oc].map(([, g]: [string, { name: string; visible: boolean }]) => [g.name, g.visible]) : null,
			info,
			xmp: md.metadata?.getRaw?.() ?? null,
			pages
		};
	} finally {
		await task.destroy();
	}
}

/** Tagged page (MarkInfo, StructTreeRoot, MCIDs), XMP metadata, an unsigned-looking signature field with a value. */
async function structured(): Promise<Uint8Array> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const page = doc.addPage([300, 200]);
	const ctx = doc.context;
	const content = ctx.stream(`/P <</MCID 0>> BDC BT /F1 12 Tf 20 150 Td (Tagged paragraph) Tj ET EMC\n`);
	page.node.set(PDFName.of('Contents'), ctx.register(content));
	page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font.ref } }));
	page.node.set(PDFName.of('StructParents'), ctx.obj(0));
	const root = ctx.nextRef();
	const p = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: root, Pg: page.ref, K: 0 }));
	const doc1 = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Document', P: root, K: [p] }));
	ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: [doc1], ParentTree: { Nums: [0, [p]] }, ParentTreeNextKey: 1 }));
	doc.catalog.set(PDFName.of('StructTreeRoot'), root);
	doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: true }));
	const xmp = ctx.stream('<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"></x:xmpmeta><?xpacket end="w"?>', { Type: 'Metadata', Subtype: 'XML' });
	doc.catalog.set(PDFName.of('Metadata'), ctx.register(xmp));
	const sigV = ctx.register(ctx.obj({ Type: 'Sig', Filter: 'Adobe.PPKLite', SubFilter: 'adbe.pkcs7.detached', ByteRange: [0, 10, 20, 30], Contents: PDFString.of('0000') }));
	const field = ctx.register(ctx.obj({ FT: 'Sig', T: PDFString.of('Signature1'), V: sigV, Type: 'Annot', Subtype: 'Widget', Rect: [0, 0, 0, 0], F: 132, P: page.ref }));
	page.node.set(PDFName.of('Annots'), ctx.obj([field]));
	doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [field], SigFlags: 3 }));
	doc.setTitle('Structured', { showInWindowTitleBar: false });
	return doc.save({ useObjectStreams: false });
}
