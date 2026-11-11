import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from '@cantoo/pdf-lib';
import type { EngineErrorShape, ExportOptions, ExportResult, PageRef, Source } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { metadataLeft } from '../../src/lib/engine/core';
import { defaultOptions, engine, loadPdfjs, manifest, nodeAssets, openCorpus, pageSizes, pageTexts, ref } from './helpers';

const T = 60_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

async function exportPages(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}) {
	return engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, []);
}

async function rejects(p: Promise<unknown>): Promise<EngineErrorShape> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineErrorShape;
	}
	throw new Error('expected a rejection');
}

function allOk(res: ExportResult) {
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['structure', 'page-count', 'page-sizes', 'reopen', 'encryption']));
}

async function qpdfJson(bytes: Uint8Array, password?: string) {
	const res = await qpdf.run({
		args: [...(password ? [`--password=${password}`] : []), '--json-output', '--json-stream-data=none', '/a.pdf', '/a.json'],
		inputs: { '/a.pdf': bytes },
		outputs: ['/a.json']
	});
	expect(res.code).toBe(0);
	const j = JSON.parse(new TextDecoder().decode(res.files.get('/a.json')!));
	return { header: j.qpdf[0], objects: j.qpdf[1] };
}

describe('exportPlan: assembly', () => {
	it('merges several files in plan order', async () => {
		const multi = await openCorpus('multi.pdf');
		const sizes = await openCorpus('sizes.pdf');
		const crop = await openCorpus('cropbox.pdf');
		const pages = [ref(sizes, 5), ref(multi, 0), ref(crop, 1), ref(multi, 5), ref(sizes, 0), ref(multi, 2)];
		const res = await exportPages(pages, [multi, sizes, crop]);
		allOk(res);
		expect(res.pageCount).toBe(6);
		expect(await pageTexts(res.bytes)).toEqual(['sizes p6', 'multi p1', 'cropbox p2', 'multi p6', 'sizes p1', 'multi p3']);
		const got = await pageSizes(res.bytes);
		const sz = manifest['sizes.pdf'].sizes as number[][];
		const want = [sz[5], [612, 792], [350, 450], [612, 792], sz[0], [612, 792]];
		got.forEach((g, i) => {
			expect(g.width).toBeCloseTo(want[i][0], 2);
			expect(g.height).toBeCloseTo(want[i][1], 2);
		});
	}, T);

	it('repeats the same page with independent rotations', async () => {
		const multi = await openCorpus('multi.pdf');
		const pages = [ref(multi, 1, 0), ref(multi, 1, 90), ref(multi, 1, 180), ref(multi, 1, 270), ref(multi, 1, 0)];
		const res = await exportPages(pages, [multi]);
		allOk(res);
		expect(await pageTexts(res.bytes)).toEqual(Array(5).fill('multi p2'));
		const got = await pageSizes(res.bytes);
		expect(got.map((g) => g.rotate)).toEqual([0, 90, 180, 270, 0]);
		// Distinct page objects, so a stamp on one copy can never appear on another.
		const doc = await PDFDocument.load(res.bytes);
		const refs = doc.getPages().map((p) => p.ref.toString());
		expect(new Set(refs).size).toBe(5);
	}, T);

	it('adds user rotation to every intrinsic rotation', async () => {
		const src = await openCorpus('rotated.pdf');
		const intrinsic = [0, 90, 180, 270, 270, 90];
		const pages: PageRef[] = [];
		for (let i = 0; i < 6; i++) for (const r of [0, 90, 180, 270] as const) pages.push(ref(src, i, r));
		const res = await exportPages(pages, [src]);
		allOk(res);
		const got = await pageSizes(res.bytes);
		pages.forEach((p, k) => {
			const total = (intrinsic[p.pageIndex] + p.rotation) % 360;
			expect(got[k].rotate, `page ${k + 1}`).toBe(total);
			const [w, h] = total % 180 === 0 ? [400, 600] : [600, 400];
			expect(got[k].width).toBeCloseTo(w, 3);
			expect(got[k].height).toBeCloseTo(h, 3);
		});
	}, T);

	it('handles inherited attributes, crop offsets and UserUnit when rotated', async () => {
		const inh = await openCorpus('inherited.pdf');
		const crop = await openCorpus('cropbox.pdf');
		const uu = await openCorpus('userunit.pdf');
		const pages = [ref(inh, 0, 90), ref(inh, 2, 270), ref(crop, 1, 90), ref(crop, 4, 180), ref(uu, 0, 90)];
		const res = await exportPages(pages, [inh, crop, uu]);
		allOk(res);
		const got = await pageSizes(res.bytes);
		const want = [
			[300, 500],
			[500, 300],
			[450, 350],
			[450, 350],
			[400, 600]
		];
		got.forEach((g, i) => {
			expect(g.width).toBeCloseTo(want[i][0], 3);
			expect(g.height).toBeCloseTo(want[i][1], 3);
		});
		expect(got[2].view).toEqual([150, 250, 500, 700]);
	}, T);

	it('exports linearized, object-stream, damaged, form, image and blank sources together', async () => {
		const sources = await Promise.all([
			openCorpus('linearized.pdf'),
			openCorpus('objstm.pdf'),
			openCorpus('damaged-xref.pdf'),
			openCorpus('form.pdf'),
			openCorpus('enc-aes-256.pdf', 'user')
		]);
		const img = await engine().openImage(
			new Uint8Array(await import('node:fs').then((fs) => fs.readFileSync('tests/corpus/files/photo-exif6.jpg'))),
			'image/jpeg',
			'photo'
		);
		const blank = await engine().blankPage({ width: 300, height: 300 });
		const all = [...sources, img, blank];
		const pages = all.map((s) => ref(s, 0));
		const res = await exportPages(pages, all);
		allOk(res);
		expect(res.warnings).toEqual(['enc-aes-256.pdf had a password; the exported file has none.']);
		const texts = await pageTexts(res.bytes);
		expect(texts.slice(0, 5)).toEqual(['multi p1', 'sizes p1', 'damaged p1', 'form p1', 'enc p1']);
		const sizes = await pageSizes(res.bytes);
		expect(sizes[5].width).toBeCloseTo(240, 3);
		expect(sizes[5].height).toBeCloseTo(400, 3);
		expect(sizes[6].width).toBeCloseTo(300, 3);
	}, T);

	it('keeps form fields working', async () => {
		const form = await openCorpus('form.pdf');
		const res = await exportPages([ref(form, 1), ref(form, 0)], [form]);
		allOk(res);
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: res.bytes.slice(), verbosity: 0 });
		const doc = await task.promise;
		const fields = (await doc.getFieldObjects()) as unknown as Map<string, { value?: unknown }[]>;
		expect([...fields.keys()].sort()).toEqual(['agree', 'name', 'notes']);
		expect(fields.get('name')!.map((f) => f.value)).toContain('Ada Lovelace');
		expect(fields.get('agree')!.map((f) => f.value)).toContain('Yes');
		await task.destroy();
	}, T);

	it('passes an independent parse by pdf-lib as well', async () => {
		const multi = await openCorpus('multi.pdf');
		const res = await exportPages([ref(multi, 3), ref(multi, 4, 90)], [multi], { compress: true });
		const doc = await PDFDocument.load(res.bytes, { throwOnInvalidObject: true });
		expect(doc.getPageCount()).toBe(2);
		expect(doc.getPages()[1].getRotation().angle).toBe(90);
	}, T);
});

describe('exportPlan: options', () => {
	it('compress packs objects into object streams and does not grow the file', async () => {
		const src = await openCorpus('sizes.pdf');
		const pages = src.pages.map((_, i) => ref(src, i));
		const plain = await exportPages(pages, [src]);
		const small = await exportPages(pages, [src], { compress: true });
		allOk(small);
		expect(small.bytes.length).toBeLessThanOrEqual(plain.bytes.length);
		const json = await qpdfJson(small.bytes);
		const objstm = Object.values(json.objects).filter(
			(o) => (o as { stream?: { dict?: Record<string, unknown> } }).stream?.dict?.['/Type'] === '/ObjStm'
		);
		expect(objstm.length).toBeGreaterThan(0);
		expect(await pageTexts(small.bytes)).toEqual(await pageTexts(plain.bytes));
	}, T);

	it('encrypts with AES-256 and the file opens only with the password', async () => {
		const multi = await openCorpus('multi.pdf');
		const res = await exportPages([ref(multi, 0), ref(multi, 1, 90)], [multi], { password: 's3cret pass' });
		allOk(res);
		expect(res.checks.find((c) => c.name === 'encryption')!.detail).toMatch(/AES-256/);
		const e = engine();
		expect((await rejects(e.openPdf(res.bytes, 'out.pdf'))).code).toBe('password-required');
		expect((await rejects(e.openPdf(res.bytes, 'out.pdf', 'wrong'))).code).toBe('password-wrong');
		const back = await e.openPdf(res.bytes, 'out.pdf', 's3cret pass');
		expect(back.wasEncrypted).toBe(true);
		expect(back.pages).toHaveLength(2);
		expect(back.pages[1].width).toBeCloseTo(792, 3);
		expect(await pageTexts(res.bytes, 's3cret pass')).toEqual(['multi p1', 'multi p2']);
		// Encrypted output never carries the password in the clear.
		expect(Buffer.from(res.bytes).toString('latin1')).not.toContain('s3cret');
	}, T);

	it('round-trips a non-ASCII password and combines with compress and metadata removal', async () => {
		const meta = await openCorpus('metadata.pdf');
		const res = await exportPages([ref(meta, 0), ref(meta, 1)], [meta], {
			password: 'pässwörd ✓',
			compress: true,
			stripMetadata: true
		});
		allOk(res);
		const back = await engine().openPdf(res.bytes, 'x', 'pässwörd ✓');
		expect(back.pages).toHaveLength(2);
		expect(metadataLeft(await qpdfJson(res.bytes, 'pässwörd ✓'))).toEqual([]);
	}, T);

	it('refuses passwords that cannot be made reliable', async () => {
		const multi = await openCorpus('multi.pdf');
		for (const pw of ['', 'a\u0000b', 'x'.repeat(128), 'ﬁle']) {
			expect((await rejects(exportPages([ref(multi, 0)], [multi], { password: pw }))).code).toBe('unsupported');
		}
	}, T);

	it('strips Info, XMP and PieceInfo, and verifies it', async () => {
		const meta = await openCorpus('metadata.pdf');
		const pages = [ref(meta, 0), ref(meta, 1), ref(meta, 0, 90)];
		// Without the option, page-level metadata travels with the pages.
		const kept = await exportPages(pages, [meta]);
		expect(metadataLeft(await qpdfJson(kept.bytes)).length).toBeGreaterThan(0);

		const res = await exportPages(pages, [meta], { stripMetadata: true });
		allOk(res);
		const metaCheck = res.checks.filter((c) => c.name === 'structure').map((c) => c.detail);
		expect(metaCheck.join(' ')).toMatch(/Metadata removed/);
		const json = await qpdfJson(res.bytes);
		expect(metadataLeft(json)).toEqual([]);
		expect(json.objects.trailer.value['/Info']).toBeUndefined();
		const raw = Buffer.from(res.bytes).toString('latin1');
		for (const secret of ['Quarterly secrets', 'Jane Doe', 'Page author', 'app data', 'xmpmeta']) {
			expect(raw).not.toContain(secret);
		}
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: res.bytes.slice(), verbosity: 0 });
		const md = await (await task.promise).getMetadata();
		expect(md.metadata).toBeNull();
		expect((md.info as Record<string, unknown>).Title).toBeUndefined();
		await task.destroy();
		expect(await pageTexts(res.bytes)).toEqual(['metadata p1', 'metadata p2', 'metadata p1']);
	}, T);

	it('strips XMP that is not under a top-level /Metadata key (survey: marked-content property lists)', async () => {
		// As Office and Illustrator write it: page /Properties entries that are direct
		// dictionaries with their own /Metadata, an XMP stream used as a property list
		// itself, and (damaged) a metadata dictionary whose stream is missing.
		const doc = await PDFDocument.create({ updateMetadata: false });
		const page = doc.addPage([300, 300]);
		const xmp = (who: string) =>
			doc.context.register(
				doc.context.stream(`<x:xmpmeta xmlns:x="adobe:ns:meta/"><dc:creator>${who}</dc:creator></x:xmpmeta>`, { Type: 'Metadata', Subtype: 'XML' })
			);
		const bare = doc.context.register(doc.context.obj({ Type: 'Metadata', Subtype: 'XML' }));
		const props = doc.context.obj({
			MC0: { Type: 'OCG', Name: 'Background', Metadata: xmp('Nested author') },
			MC1: xmp('Property-list author'),
			MC2: bare,
			MC3: { Kids: [{ PieceInfo: { App: { Private: 'nested app data' } } }] }
		});
		page.node.set(PDFName.of('Resources'), doc.context.obj({ Properties: props }));
		const src = await engine().openPdf(await doc.save(), 'nested-xmp.pdf');
		expect(metadataLeft(await qpdfJson(src.bytes)).length).toBeGreaterThanOrEqual(3);

		const res = await exportPages([ref(src, 0)], [src], { stripMetadata: true });
		allOk(res);
		expect(metadataLeft(await qpdfJson(res.bytes))).toEqual([]);
		const qdf = await qpdf.run({ args: ['--qdf', '--object-streams=disable', '/i.pdf', '/o.pdf'], inputs: { '/i.pdf': res.bytes }, outputs: ['/o.pdf'] });
		const raw = Buffer.from(qdf.files.get('/o.pdf')!).toString('latin1');
		for (const secret of ['Nested author', 'Property-list author', 'nested app data', 'xmpmeta']) expect(raw).not.toContain(secret);
	}, T);

	it('strips metadata and encrypts a file qpdf reads only with warnings (a name with a stray #)', async () => {
		const src = await openCorpus('stray-hash-name.pdf');
		const res = await exportPages([ref(src, 0)], [src], { stripMetadata: true, password: 'pw' });
		expect(res.checks.every((c) => c.ok)).toBe(true);
		const qdf = await qpdf.run({
			args: ['--password=pw', '--qdf', '--object-streams=disable', '--decrypt', '/i.pdf', '/o.pdf'],
			inputs: { '/i.pdf': res.bytes },
			outputs: ['/o.pdf']
		});
		const raw = Buffer.from(qdf.files.get('/o.pdf')!).toString('latin1');
		expect(raw).toContain('stray-hash p1');
		expect(raw).not.toContain('SECRETAUTHOR');
		expect(await pageTexts(res.bytes, 'pw')).toEqual(['stray-hash p1']);
	}, T);

	it('strips metadata from pages kept in object streams (qpdf loses JSON updates there)', async () => {
		const src = await openCorpus('objstm-metadata.pdf');
		for (const compress of [false, true]) {
			const res = await exportPages([ref(src, 2), ref(src, 0)], [src], { stripMetadata: true, compress });
			allOk(res);
			expect(metadataLeft(await qpdfJson(res.bytes))).toEqual([]);
			const qdf = await qpdf.run({ args: ['--qdf', '--object-streams=disable', '/i.pdf', '/o.pdf'], inputs: { '/i.pdf': res.bytes }, outputs: ['/o.pdf'] });
			const raw = Buffer.from(qdf.files.get('/o.pdf')!).toString('latin1');
			expect(raw).toContain('objstm-metadata p3');
			for (const secret of ['SECRETPIECE', 'SECRETXMP', 'SECRETAUTHOR']) expect(raw).not.toContain(secret);
		}
	}, T);

	it('the metadata check also sees metadata keys nested in direct dictionaries', () => {
		const json = { header: {}, objects: { 'obj:1 0 R': { value: { '/Properties': { '/MC0': { '/Metadata': 'obj:2 0 R' } } } } } };
		expect(metadataLeft(json)).toEqual(['obj:1 0 R nested /Metadata']);
	});
});

describe('exportPlan: refusals', () => {
	it('refuses an empty plan', async () => {
		expect((await rejects(exportPages([], []))).code).toBe('unsupported');
	});

	it('refuses references to missing sources and pages', async () => {
		const multi = await openCorpus('multi.pdf');
		expect((await rejects(exportPages([ref(multi, 6)], [multi]))).code).toBe('internal');
		expect((await rejects(exportPages([ref(multi, 0)], []))).code).toBe('internal');
		expect((await rejects(exportPages([{ ...ref(multi, 0), rotation: 45 as 0 }], [multi]))).code).toBe('internal');
	}, T);

	it('fails verification instead of returning a file that does not match the plan', async () => {
		const multi = await openCorpus('multi.pdf');
		// A source whose recorded size disagrees with its bytes.
		const lying: Source = { ...multi, id: 'lying', pages: multi.pages.map(() => ({ width: 500, height: 500 })) };
		const e = await rejects(exportPages([ref(lying, 0)], [lying]));
		expect(e.code).toBe('verification-failed');
		const sizes = e.checks!.find((c) => c.name === 'page-sizes')!;
		expect(sizes.ok).toBe(false);
		expect(sizes.detail).toMatch(/expected 500×500, got 612×792/);
		expect(e.checks!.find((c) => c.name === 'structure')!.ok).toBe(true);
	}, T);

	it('does not modify source bytes', async () => {
		const multi = await openCorpus('multi.pdf');
		const before = multi.bytes.slice();
		await exportPages([ref(multi, 0, 90)], [multi], { compress: true, password: 'x', stripMetadata: true });
		expect(multi.bytes).toEqual(before);
	}, T);
});
