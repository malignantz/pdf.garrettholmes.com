/**
 * Accessibility tags (structure tree) kept in exports: engine/tags.ts and its wiring in core.ts.
 * Corpus: tests/corpus/generate-tags.mjs. Every kept tree is checked twice: by the engine's own
 * 'tags' check, and here independently with PDF.js (getStructTree of every page, compared with
 * the source page's) and with raw qpdf reads of the catalog and pages.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, ExportOptions, ExportResult, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { MAX_ELEMENTS, canonicalTree, graftTags, planTags, verifyTags } from '../../src/lib/engine/tags';
import { markedContent } from '../../src/lib/engine/marked';
import { corpus, defaultOptions, engine, loadPdfjs, manifest, nodeAssets, openCorpus, pageTexts, ref } from './helpers';

const T = 60_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

type Node = { role?: string; alt?: string; children?: Node[]; type?: string; id?: string; [k: string]: unknown };

/** PDF.js structure tree of every page, content ids reduced to their MCID. */
async function trees(bytes: Uint8Array, password?: string): Promise<(Node | null)[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: (Node | null)[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const t = (await (await doc.getPage(i)).getStructTree()) as Node | null;
			out.push(t ? norm(t) : null);
		}
		return out;
	} finally {
		await task.destroy();
	}
}
function norm(n: Node): Node {
	const o: Node = {};
	for (const [k, v] of Object.entries(n)) {
		if (k === 'children') continue;
		o[k] = k === 'id' ? (typeof v === 'string' && /_mc(\d+)$/.test(v) ? `mc${/_mc(\d+)$/.exec(v)![1]}` : 'annot') : v;
	}
	if (n.children) o.children = n.children.map(norm);
	return o;
}
function roles(n: Node | null, out: string[] = []): string[] {
	if (!n) return out;
	if (n.role) out.push(n.role);
	for (const c of n.children ?? []) roles(c, out);
	return out;
}
function altsOf(n: Node | null, out: string[] = []): string[] {
	if (!n) return out;
	if (typeof n.alt === 'string') out.push(n.alt);
	for (const c of n.children ?? []) altsOf(c, out);
	return out;
}

/** Every object decompressed (qpdf --qdf), so raw searches see inside streams. */
async function expanded(bytes: Uint8Array, password?: string): Promise<Buffer> {
	const res = await qpdf.run({
		args: [...(password ? [`--password=${password}`, '--decrypt'] : []), '--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'],
		inputs: { '/i.pdf': bytes },
		outputs: ['/o.pdf']
	});
	const out = res.files.get('/o.pdf');
	if (!out) throw new Error(`qpdf failed: ${res.stderr}`);
	return Buffer.from(out);
}
/** The ways a string can be spelled in a PDF's bytes. */
function spellings(s: string): Buffer[] {
	const latin = Buffer.from(s, 'latin1');
	const be = Buffer.from(s, 'utf16le').swap16();
	return [latin, be, Buffer.from(s, 'utf16le'), Buffer.from(latin.toString('hex')), Buffer.from(latin.toString('hex').toUpperCase()), Buffer.from(be.toString('hex')), Buffer.from(be.toString('hex').toUpperCase())];
}
const found = (buf: Buffer, s: string) => spellings(s).some((sp) => buf.indexOf(sp) >= 0);

async function catalogOf(bytes: Uint8Array, password?: string): Promise<string> {
	const pw = password ? [`--password=${password}`] : [];
	const t = await qpdf.run({ args: [...pw, '--show-object=trailer', '/c.pdf'], inputs: { '/c.pdf': bytes } });
	const root = /\/Root (\d+) (\d+) R/.exec(t.stdout)!;
	return (await qpdf.run({ args: [...pw, `--show-object=${root[1]},${root[2]}`, '/c.pdf'], inputs: { '/c.pdf': bytes } })).stdout;
}

function all(src: Source, stamps: (i: number) => Stamp[] = () => [], rotation: (i: number) => PageRef['rotation'] = () => 0): PageRef[] {
	return src.pages.map((_, i) => ref(src, i, rotation(i), stamps(i)));
}
async function run(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}, assets: Asset[] = [], eng = engine()): Promise<ExportResult> {
	const res = await eng.exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, assets);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res;
}
function keptCheck(res: ExportResult) {
	expect(res.tags).toEqual({ kept: true });
	const c = res.checks.find((x) => x.name === 'tags');
	expect(c?.ok, c?.detail).toBe(true);
	return c!;
}

/** The export's pages carry exactly their source pages' trees (PDF.js, independent of tags.ts). */
async function sameTrees(src: Source, res: ExportResult, from: number[], password?: string) {
	const a = await trees(src.bytes);
	const b = await trees(res.bytes, password);
	from.forEach((p, i) => expect(b[i], `output page ${i + 1} (source page ${p + 1})`).toEqual(a[p]));
}

const basicMeta = manifest['tags-basic.pdf'] as { elements: number; alt: number; actualText: number };
const sig: Asset = { id: 'sig', kind: 'signature', png: corpus('signature.png'), width: 240, height: 80 };

describe('tags: one tagged file, all its pages (tier 1)', () => {
	it('keeps the whole tree, /MarkInfo, /Lang, /ViewerPreferences, /Tabs and the annotation /StructParent', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run(all(src), [src]);
		const c = keptCheck(res);
		expect(c.detail).toContain(`${basicMeta.elements} structure elements, ${basicMeta.alt} picture descriptions (/Alt), ${basicMeta.actualText} replacement text (/ActualText)`);
		await sameTrees(src, res, [0, 1, 2]);
		expect(await canonicalTree(qpdf, res.bytes)).toEqual(await canonicalTree(qpdf, src.bytes));
		const cat = await catalogOf(res.bytes);
		expect(cat).toMatch(/\/MarkInfo << \/Marked true >>/);
		expect(cat).toMatch(/\/Lang \(en-US\)/);
		expect(cat).toMatch(/\/ViewerPreferences << \/DisplayDocTitle true >>/);
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw.match(/\/Tabs \/S/g)?.length).toBe(3);
		expect(raw).toMatch(/\/StructParent 3/);
		expect(raw).toMatch(/\/RoleMap <<\s*\/Heading1 \/H1\s*>>/);
		expect(raw).toMatch(/\/IDTree/);
		expect(raw).toMatch(/\(th-name\)/);
		// PDF.js sees the RoleMap, the IDs, /Headers, the link's OBJR, /Alt and /ActualText.
		const [p1, p2, p3] = await trees(res.bytes);
		expect(roles(p1)).toContain('H1');
		expect(altsOf(p2)).toEqual(['A grey test picture', 'H two O']);
		expect(JSON.stringify(p3)).toContain('"headers":["th-name"]');
		expect(JSON.stringify(p3)).toContain('"type":"annotation"');
	}, T);

	it('says nothing when the file has no tags', async () => {
		const src = await openCorpus('multi.pdf');
		const res = await run([ref(src, 0)], [src]);
		expect(res.tags).toBeUndefined();
		expect(res.checks.some((c) => c.name === 'tags')).toBe(false);
	}, T);

	it('with rotation', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run(all(src, undefined, (i) => (i === 1 ? 90 : i === 2 ? 270 : 0)), [src]);
		keptCheck(res);
		await sameTrees(src, res, [0, 1, 2]);
	}, T);

	it('with stamps, a signature, ticks, highlights and page numbers: what is added is an artifact', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const stamps = (i: number): Stamp[] =>
			i === 0
				? [
						{ id: 't', kind: 'text', text: 'APPROVED BY ME', x: 0.5, y: 0.3, size: 0.02, color: 'red' },
						{ id: 'i', kind: 'image', assetId: 'sig', box: { x: 0.5, y: 0.4, w: 0.2, h: 0.06 } },
						{ id: 'm', kind: 'mark', mark: 'check', box: { x: 0.1, y: 0.4, w: 0.03, h: 0.03 } },
						{ id: 'h', kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.07, w: 0.4, h: 0.04 } }
					]
				: [];
		for (const numbering of [
			{ style: 'page-n', position: 'bottom-right', start: 1, skip: 0, size: 10 },
			{ style: 'bates', position: 'top-left', start: 7, skip: 0, size: 9, bates: { prefix: 'CASE-', digits: 5 } }
		] as const) {
			const res = await run(all(src, stamps), [src], { numbering }, [sig]);
			keptCheck(res);
			await sameTrees(src, res, [0, 1, 2]);
			const texts = await pageTexts(res.bytes);
			expect(texts[0]).toContain('APPROVED BY ME');
			expect(texts[2]).toMatch(numbering.style === 'bates' ? /CASE-00009/ : /3/);
			// The stamp layer is one /Artifact sequence after the page's own content, and nothing is left open.
			const raw = (await expanded(res.bytes)).toString('latin1');
			expect(raw.match(/\/Artifact BMC/g)?.length).toBe(3);
		}
	}, T);

	it('closes a marked-content sequence the page leaves open before drawing stamps', () => {
		const open = markedContent(new TextEncoder().encode('/P << /MCID 0 >> BDC BT (a) Tj ET /Span <</MCID 1>> BDC (x) Tj'));
		expect(open).toMatchObject({ mcids: [0, 1], open: 2, unbalanced: false });
		const tricky = markedContent(new TextEncoder().encode('(/MCID 9 BDC) Tj BI /W 2 /H 1 ID \x00EMC\xff EI /P /MC4 BDC EMC % /MCID 7 BDC\n'));
		expect(tricky).toMatchObject({ mcids: [], named: ['MC4'], open: 0, unbalanced: false });
	});

	it('with form answers in a tagged form (Form elements keep their widgets)', async () => {
		const src = await openCorpus('tags-form.pdf');
		const res = await engine().exportPlan(
			{ pages: all(src), options: { ...defaultOptions }, formValues: { [src.id]: { name: 'Ada Lovelace', city: 'London', subscribe: true } } },
			[src],
			[]
		);
		for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
		keptCheck(res);
		expect(res.checks.some((c) => c.name === 'forms' && c.ok)).toBe(true);
		const [t] = await trees(res.bytes);
		expect(JSON.stringify(t).match(/"type":"annotation"/g)?.length).toBe(3);
		expect(altsOf(t)).toEqual(['Your name', 'Your city', 'Subscribe to the letter']);
	}, T);

	it('a tagged form, filled, stamped, numbered, compressed and with a password, all at once', async () => {
		const src = await openCorpus('tags-form.pdf');
		const pw = 'pw';
		const res = await engine().exportPlan(
			{
				pages: all(src, () => [{ id: 't', kind: 'text', text: 'Signed today', x: 0.5, y: 0.5, size: 0.02, color: 'blue' }]),
				options: { ...defaultOptions, compress: true, password: pw, numbering: { style: 'page-n', position: 'bottom-right', start: 1, skip: 0, size: 10 } },
				formValues: { [src.id]: { name: 'Ada', subscribe: true } }
			},
			[src],
			[]
		);
		for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
		keptCheck(res);
		await sameTrees(src, res, [0], pw);
	}, T);

	it('with "Keep filled blanks editable" (the new fields are outside the tree, the tree is whole)', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const blank = { x: 0.1, y: 0.5, w: 0.4, h: 0.03 };
		const s: Stamp = { id: 'b1', kind: 'text', text: 'Jane Doe', x: 0.12, y: 0.503, size: 0.016, color: 'black', blank: { kind: 'text', box: blank } };
		const res = await run(all(src, (i) => (i === 0 ? [s] : [])), [src], { blankFields: true });
		keptCheck(res);
		expect(res.blankFields).toEqual({ fields: 1, plain: 0 });
		await sameTrees(src, res, [0, 1, 2]);
	}, T);

	it('with Optimize: every lossless pass, MuPDF cleanup on every file, the print-size cap and JPEG repack', async () => {
		const always = createCoreEngine(nodeAssets(), { lossless: { cleanup: 'always' } });
		for (const name of ['tags-basic.pdf', 'tags-photo.pdf', 'tags-xobject.pdf', 'tags-form.pdf']) {
			const src = await always.openPdf(corpus(name), name);
			const res = await run(all(src), [src], { compress: true, printCap: true }, [], always);
			keptCheck(res);
			await sameTrees(src, res, src.pages.map((_, i) => i));
			if (name === 'tags-photo.pdf') expect(res.printCap?.images).toBe(1);
		}
	}, T * 2);

	it('with a size target (pictures shrunk)', async () => {
		const src = await openCorpus('tags-photo.pdf');
		const res = await run(all(src), [src], { compress: true, targetBytes: 30_000 });
		keptCheck(res);
		expect(res.shrink?.imagesChanged).toBeGreaterThan(0);
		await sameTrees(src, res, [0]);
	}, T);

	it('with a password, and from an owner-locked file', async () => {
		const src = await openCorpus('tags-locked.pdf');
		expect(src.wasEncrypted).toBe(true);
		const res = await run(all(src), [src], { password: 'secret ✓', compress: true });
		keptCheck(res);
		await sameTrees(src, res, [0, 1, 2], 'secret ✓');
		expect(await catalogOf(res.bytes, 'secret ✓')).toMatch(/\/Lang \(en-US\)/);
		expect(await canonicalTree(qpdf, res.bytes, 'secret ✓')).toEqual(await canonicalTree(qpdf, (await openCorpus('tags-basic.pdf')).bytes));
	}, T);

	it('with metadata removal', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run(all(src), [src], { stripMetadata: true, compress: true });
		keptCheck(res);
	}, T);

	it('a form XObject with its own marked content (MCR /Stm)', async () => {
		const src = await openCorpus('tags-xobject.pdf');
		const res = await run(all(src), [src], { compress: true });
		keptCheck(res);
		expect(await canonicalTree(qpdf, res.bytes)).toEqual(await canonicalTree(qpdf, src.bytes));
	}, T);
});

describe('tags: OCR (real OCR engine)', () => {
	it('a tagged scan made searchable keeps its tags; the text layer is an artifact', { timeout: 180_000 }, async () => {
		const { nodeOcr } = await import('./ocr-node');
		const eng = createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots: 1 }) });
		const src = await eng.openPdf(corpus('tags-scan.pdf'), 'tags-scan.pdf');
		const res = await run(all(src), [src], { compress: true, ocr: true }, [], eng);
		expect(res.ocr?.searchable).toEqual([1]);
		keptCheck(res);
		await sameTrees(src, res, [0]);
		expect((await pageTexts(res.bytes))[0]).toContain('Dear');
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).toMatch(/\/Artifact BMC\s+BT 3 Tr/);
	});
});

describe('tags: subsets, order, blank pages (tier 2)', () => {
	it('page 1 removed: its elements go, the paragraph that runs on stays, the section loses its title', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run([ref(src, 1), ref(src, 2)], [src]);
		const c = keptCheck(res);
		expect(c.detail).toContain('15 structure elements, 2 picture descriptions (/Alt), 1 replacement text (/ActualText)');
		await sameTrees(src, res, [1, 2]);
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).not.toContain('Introduction');
		expect(raw).toContain('/ParentTreeNextKey 4');
	}, T);

	it('page 2 removed: the figure, its /Alt and the span with /ActualText go', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run([ref(src, 0), ref(src, 2)], [src]);
		const c = keptCheck(res);
		expect(c.detail).toContain('14 structure elements, 1 picture description (/Alt), 0 replacement texts');
		const raw = (await expanded(res.bytes)).toString('latin1');
		for (const s of ['A grey test picture', 'H two O', 'water']) expect(found(Buffer.from(raw, 'latin1'), s), s).toBe(false);
		const [p1] = await trees(res.bytes);
		expect(p1).toEqual((await trees(src.bytes))[0]);
	}, T);

	it('page 3 removed: the link element and its OBJR go with the annotation; the table goes', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src]);
		expect(keptCheck(res).detail).toContain('6 structure elements');
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).not.toContain('Go back to page one');
		expect(raw).not.toContain('th-name');
		expect(raw).not.toMatch(/\/OBJR/);
		await sameTrees(src, res, [0, 1]);
	}, T);

	it('reordered pages keep the tree in its logical order', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run([ref(src, 2), ref(src, 0), ref(src, 1)], [src]);
		keptCheck(res);
		await sameTrees(src, res, [2, 0, 1]);
		// The tree itself is the source's, element for element.
		const a = (await canonicalTree(qpdf, src.bytes))!;
		const b = (await canonicalTree(qpdf, res.bytes))!;
		expect(b.map((l) => l.replace(/([PA])\d/g, '$1'))).toEqual(a.map((l) => l.replace(/([PA])\d/g, '$1')));
	}, T);

	it('blank pages added keep the tags', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const blank = await engine().blankPage({ width: 612, height: 792 });
		const res = await run([ref(src, 0), ref(blank, 0), ref(src, 1), ref(src, 2), ref(blank, 0)], [src, blank]);
		keptCheck(res);
		const t = await trees(res.bytes);
		const s = await trees(src.bytes);
		expect([t[0], t[2], t[3]]).toEqual(s);
		// PDF.js: a page without tagged content has an empty tree.
		for (const i of [1, 4]) expect(t[i]?.children ?? []).toEqual([]);
	}, T);

	it('a split part that is part of the file is pruned; one that is the whole file keeps all', async () => {
		const src = await openCorpus('tags-second.pdf');
		const a = await run([ref(src, 0)], [src]);
		keptCheck(a);
		const b = await run([ref(src, 1)], [src]);
		expect(keptCheck(b).detail).toContain('2 structure elements');
		const whole = await run(all(src), [src]);
		expect(keptCheck(whole).detail).toContain('4 structure elements');
	}, T);
});

describe('tags: several tagged files merged (tier 2)', () => {
	it('puts both trees under one root, keys of the second file moved past the first’s', async () => {
		const a = await openCorpus('tags-basic.pdf');
		const b = await openCorpus('tags-second.pdf');
		const res = await run([...all(a), ...all(b)], [a, b], { compress: true });
		expect(keptCheck(res).detail).toContain('20 structure elements, 2 picture descriptions (/Alt), 2 replacement texts');
		const ta = await trees(a.bytes);
		const tb = await trees(b.bytes);
		expect(await trees(res.bytes)).toEqual([...ta, ...tb]);
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).toMatch(/\/RoleMap <<\s*\/Heading1 \/H1\s*\/Title \/H1\s*>>/);
		expect(raw).toMatch(/\/ParentTreeNextKey 6/);
		expect(raw.match(/\/StructParents [45]\b/g)?.length).toBe(2);
		// The IDTree holds the IDs of both, sorted.
		expect(raw).toMatch(/\/Names \[\s*\(t2-title\)\s+\d+ 0 R\s*\(th-name\)\s+\d+ 0 R\s*\(th-value\)\s+\d+ 0 R\s*\]/);
	}, T);

	it('interleaved, pruned, with a blank page; a second file in another language gets its /Lang on its elements', async () => {
		const a = await openCorpus('tags-basic.pdf');
		const f = await openCorpus('tags-form.pdf');
		const blank = await engine().blankPage({ width: 612, height: 792 });
		const res = await run([ref(a, 2), ref(f, 0), ref(blank, 0), ref(a, 0)], [a, f, blank], { compress: true });
		keptCheck(res);
		const ta = await trees(a.bytes);
		const [tf] = await trees(f.bytes);
		const out = await trees(res.bytes);
		expect(out[0]).toEqual(ta[2]);
		expect(out[3]).toEqual(ta[0]);
		const doc = (out[1]!.children![0] as Node);
		expect(doc.lang).toBe('en-GB');
		expect({ ...doc, lang: undefined }).toEqual({ ...(tf!.children![0] as Node), lang: undefined });
		expect(await catalogOf(res.bytes)).toMatch(/\/Lang \(en-US\)/);
	}, T);

	it('unusual spellings: indirect /S and /Lang, PDFDocEncoding text, an empty name', async () => {
		const a = await openCorpus('tags-basic.pdf');
		const o = await openCorpus('tags-odd.pdf');
		const whole = await run(all(o), [o], { compress: true });
		keptCheck(whole);
		const [t] = await trees(whole.bytes);
		expect(altsOf(t)).toEqual(['\u201cQuoted\u201d']);
		const res = await run([...all(a), ...all(o)], [a, o], { compress: true });
		keptCheck(res);
		// The second file's language (an indirect string in its catalog) goes on its top element.
		const out = await trees(res.bytes);
		expect((out[3]!.children![0] as Node).lang).toBe('de-DE');
	}, T);

	it('declines trees that map one role two ways or share an ID', async () => {
		const a = await openCorpus('tags-basic.pdf');
		const b = await openCorpus('tags-locked.pdf');
		// The same IDs in both (a copy of the same file).
		const res = await run([...all(a), ...all(b)], [a, b]);
		expect(res.tags).toEqual({ kept: false, reason: 'merged' });
	}, T);
});

describe('tags: not kept, with a reason (the export is as before)', () => {
	it('a page used twice', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const res = await run([ref(src, 0), ref(src, 1), ref(src, 0)], [src]);
		expect(res.tags).toEqual({ kept: false, reason: 'repeated' });
		expect(await catalogOf(res.bytes)).not.toMatch(/StructTreeRoot/);
	}, T);

	it('pages from a file without tags, or a picture', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const plain = await openCorpus('multi.pdf');
		const img = await engine().openImage(corpus('photo-plain.jpg'), 'image/jpeg', 'photo.jpg');
		for (const other of [plain, img]) {
			const res = await run([...all(src), ref(other, 0)], [src, other]);
			expect(res.tags, other.name).toEqual({ kept: false, reason: 'merged' });
			expect(await catalogOf(res.bytes)).not.toMatch(/StructTreeRoot|MarkInfo/);
		}
	}, T);

	it('a locked (flattened) tagged form', async () => {
		const src = await openCorpus('tags-form.pdf');
		const res = await run(all(src), [src], { flattenForms: true });
		expect(res.tags).toEqual({ kept: false, reason: 'flattened' });
	}, T);

	it('a tree over the element budget', async () => {
		// One page, a Document with MAX_ELEMENTS empty paragraphs (MAX_ELEMENTS + 1 elements).
		const n = MAX_ELEMENTS;
		const parts: string[] = ['%PDF-1.7\n'];
		const off: number[] = [];
		let len = parts[0].length;
		const obj = (body: string) => {
			off.push(len);
			const s = `${off.length} 0 obj\n${body}\nendobj\n`;
			parts.push(s);
			len += s.length;
		};
		obj('<< /Type /Catalog /Pages 2 0 R /StructTreeRoot 4 0 R /MarkInfo << /Marked true >> >>');
		obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
		obj('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /StructParents 0 >>');
		obj('<< /Type /StructTreeRoot /K 5 0 R /ParentTree << /Nums [] >> >>');
		obj(`<< /Type /StructElem /S /Document /P 4 0 R /K [${Array.from({ length: n }, (_, i) => `${i + 6} 0 R`).join(' ')}] >>`);
		for (let i = 0; i < n; i++) obj('<< /Type /StructElem /S /P /P 5 0 R >>');
		const xref = len;
		parts.push(`xref\n0 ${off.length + 1}\n0000000000 65535 f \n${off.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${off.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
		const src = await engine().openPdf(new Uint8Array(Buffer.from(parts.join(''), 'latin1')), 'big.pdf');
		const res = await run(all(src), [src]);
		expect(res.tags).toEqual({ kept: false, reason: 'large' });
	}, T);

	it('a file whose ParentTree names the wrong elements exports without tags, not an error', async () => {
		const src = await openCorpus('tags-broken.pdf');
		const res = await run(all(src), [src]);
		expect(res.tags).toEqual({ kept: false, reason: 'damaged' });
		expect(await catalogOf(res.bytes)).not.toMatch(/StructTreeRoot/);
		expect((await pageTexts(res.bytes))[0]).toContain('Heading One');
	}, T);

	it('the check catches a tree that does not match its content', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const by = new Map([[src.id, src]]);
		const pages = all(src);
		const plan = await planTags(qpdf, pages, by, [src], { redaction: false, flatten: false });
		expect(plan.kind).toBe('keep');
		if (plan.kind !== 'keep') return;
		const assembled = (await qpdf.run({ args: ['--empty', '--pages', '/a.pdf', '1-z', '--', '/o.pdf'], inputs: { '/a.pdf': src.bytes }, outputs: ['/o.pdf'] })).files.get('/o.pdf')!;
		const g = (await graftTags(qpdf, assembled, plan))!;
		expect((await verifyTags(qpdf, g.bytes, g.expected)).ok).toBe(true);
		// The heading's MCID moved in the content: the tree no longer matches.
		const swapped = await rewriteFirst(g.bytes, '/H1 << /MCID 0 >>', '/H1 << /MCID 7 >>');
		const bad = await verifyTags(qpdf, swapped, g.expected);
		expect(bad.ok).toBe(false);
		expect(bad.detail).toMatch(/mcid-missing/);
		// An element lost its /Alt: the canonical tree differs.
		const noAlt = await rewriteFirst(g.bytes, '/Alt (A grey test picture)', '/Alt (A grey test pictur!)');
		const bad2 = await verifyTags(qpdf, noAlt, g.expected);
		expect(bad2.ok).toBe(false);
		expect(bad2.detail).toMatch(/differs from the original/);
	}, T);
});

describe('tags: redaction drops the tree and leaves no hidden text', () => {
	const meta = manifest['tags-secret.pdf'] as unknown as { secretBox: [number, number, number, number]; secrets: string[]; namedSecret: string };
	const box = { x: meta.secretBox[0] / 612, y: 1 - meta.secretBox[3] / 792, w: (meta.secretBox[2] - meta.secretBox[0]) / 612, h: (meta.secretBox[3] - meta.secretBox[1]) / 792 };

	it('a box over the line whose element holds secrets in /Alt, /ActualText, /E, /T and a BDC /ActualText', async () => {
		const src = await openCorpus('tags-secret.pdf');
		// Before: every secret is in the opened file.
		const before = await expanded(src.bytes);
		for (const s of [...meta.secrets, meta.namedSecret]) expect(found(before, s), s).toBe(true);
		for (const compress of [false, true]) {
			const res = await run([ref(src, 0, 0, [{ id: 'r', kind: 'redact', box }]), ref(src, 1)], [src], { compress });
			expect(res.tags).toEqual({ kept: false, reason: 'redacted' });
			const raw = await expanded(res.bytes);
			for (const s of [...meta.secrets, meta.namedSecret]) expect(found(raw, s), s).toBe(false);
			expect(raw.toString('latin1')).not.toMatch(/StructTreeRoot|\/ActualText|\/Alt/);
			const texts = await pageTexts(res.bytes);
			expect(texts[0]).toContain('KEEP-THIS-LINE');
			expect(texts[1]).toContain('KEEP-PAGE-TWO');
		}
	}, T);

	it('a box on another page still drops the whole tree (its text attributes too)', async () => {
		const src = await openCorpus('tags-secret.pdf');
		const res = await run([ref(src, 0), ref(src, 1, 0, [{ id: 'r', kind: 'redact', box: { x: 0.1, y: 0.05, w: 0.3, h: 0.05 } }])], [src]);
		expect(res.tags).toEqual({ kept: false, reason: 'redacted' });
		const raw = await expanded(res.bytes);
		for (const s of ['SECRET-STRUCT-ALT', 'SECRET-STRUCT-ACTUAL', 'SECRET-STRUCT-EXPANSION', 'SECRET-STRUCT-TITLE', 'KEEP-ALT-TWO']) expect(found(raw, s), s).toBe(false);
	}, T);
});

/** `bytes` with the first content stream or object containing `from` changed to `to` (qpdf --qdf keeps lengths fixable). */
async function rewriteFirst(bytes: Uint8Array, from: string, to: string): Promise<Uint8Array> {
	const qdf = (await expanded(bytes)).toString('latin1');
	expect(qdf).toContain(from);
	const changed = Buffer.from(qdf.replace(from, to), 'latin1');
	const res = await qpdf.run({ args: ['/i.pdf', '/o.pdf'], inputs: { '/i.pdf': new Uint8Array(changed) }, outputs: ['/o.pdf'] });
	return res.files.get('/o.pdf')!;
}
