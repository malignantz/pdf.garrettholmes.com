/**
 * Title, document details, bookmarks and named destinations kept in exports: engine/outline.ts
 * and its wiring in core.ts. Corpus: tests/corpus/generate-outline.mjs. What an export keeps is
 * checked twice: by the engine's own 'outline' check, and here independently with PDF.js
 * (getOutline, getMetadata, getDestinations, link annotations) and raw qpdf reads.
 */
import { describe, expect, it } from 'vitest';
import type { Asset, ExportOptions, ExportResult, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { MAX_ITEMS, inspectOutline, outlineLines, parsePdfValue, stringBytes, verifyOutline, type OutlineExpected } from '../../src/lib/engine/outline';
import { corpus, defaultOptions, engine, loadPdfjs, manifest, nodeAssets, openCorpus, pageTexts, ref } from './helpers';

const T = 60_000;
const qpdf = new Qpdf(nodeAssets().qpdf);
const BASIC_TITLE = 'Quarterly Report – Übersicht';
const CHAPTER2 = 'Chapitre 2 — Été';
const ZETA = 'zeta é';

type Mark = { t: string; d: unknown; n?: number; color?: number[]; bold?: boolean; kids: Mark[] };

/** What PDF.js sees: the outline (destinations as [page number, view…] or a URL), details, names, links. */
async function pdfjsFacts(bytes: Uint8Array, password?: string) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const dest = async (d0: unknown): Promise<unknown> => {
			const d = typeof d0 === 'string' ? await doc.getDestination(d0) : d0;
			if (!Array.isArray(d)) return d ?? null;
			const page = d[0] && typeof d[0] === 'object' ? (await doc.getPageIndex(d[0])) + 1 : `not a page: ${JSON.stringify(d[0])}`;
			return [page, (d[1] as { name: string }).name, ...d.slice(2)];
		};
		type Raw = { title: string; dest: unknown; url?: string | null; count?: number; color?: Uint8ClampedArray; bold?: boolean; items: Raw[] };
		const walk = async (items: Raw[] | null): Promise<Mark[]> =>
			items
				? Promise.all(
						items.map(async (o) => ({
							t: o.title,
							d: o.url ?? (await dest(o.dest)),
							...(o.count !== undefined && o.items.length ? { n: o.count } : {}),
							...(o.color && [...o.color].some((c) => c !== 0) ? { color: [...o.color] } : {}),
							...(o.bold ? { bold: true } : {}),
							kids: await walk(o.items)
						}))
					)
				: [];
		const md = await doc.getMetadata();
		const dests = (await doc.getDestinations()) as Map<string, unknown> | Record<string, unknown>;
		const names: Record<string, unknown> = {};
		for (const [k, v] of dests instanceof Map ? dests : Object.entries(dests)) names[k] = await dest(v);
		const links: unknown[][] = [];
		const texts: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const p = await doc.getPage(i);
			const list: unknown[] = [];
			for (const a of (await p.getAnnotations()) as { subtype: string; dest?: unknown; url?: string }[]) if (a.subtype === 'Link') list.push(a.url ?? (await dest(a.dest)));
			links.push(list);
			const tc = await p.getTextContent();
			texts.push(tc.items.map((it) => ('str' in it ? it.str : '')).join('').trim());
		}
		return { outline: await walk((await doc.getOutline()) as Raw[] | null), info: md.info as Record<string, unknown>, xmp: md.metadata, names, links, texts };
	} finally {
		await task.destroy();
	}
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
function spellings(s: string): Buffer[] {
	const latin = Buffer.from(s, 'latin1');
	const be = Buffer.from(s, 'utf16le').swap16();
	return [latin, be, Buffer.from(s, 'utf16le'), Buffer.from(latin.toString('hex')), Buffer.from(latin.toString('hex').toUpperCase()), Buffer.from(be.toString('hex')), Buffer.from(be.toString('hex').toUpperCase())];
}
const found = (buf: Buffer, s: string) => spellings(s).some((sp) => buf.indexOf(sp) >= 0);

async function catalogOf(bytes: Uint8Array): Promise<string> {
	const t = await qpdf.run({ args: ['--show-object=trailer', '/c.pdf'], inputs: { '/c.pdf': bytes } });
	const root = /\/Root (\d+) (\d+) R/.exec(t.stdout)!;
	return (await qpdf.run({ args: [`--show-object=${root[1]},${root[2]}`, '/c.pdf'], inputs: { '/c.pdf': bytes } })).stdout;
}

function all(src: Source, rotation: (i: number) => PageRef['rotation'] = () => 0): PageRef[] {
	return src.pages.map((_, i) => ref(src, i, rotation(i)));
}
async function run(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}, assets: Asset[] = []): Promise<ExportResult> {
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, assets);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res;
}
const outlineCheck = (res: ExportResult) => res.checks.find((c) => c.name === 'outline');

/** The bookmarks of outline-basic.pdf, as PDF.js reads them, when every page is kept in order. */
const BASIC: Mark[] = [
	{
		t: 'Chapter 1',
		d: [1, 'XYZ', 72, 720, 0],
		n: 2,
		kids: [
			{ t: 'Section 1.1', d: [1, 'FitH', 500], kids: [] },
			{ t: 'Section 1.2', d: [2, 'Fit'], kids: [] }
		]
	},
	{
		t: CHAPTER2,
		d: [3, 'FitR', 10, 20, 300, 400.5],
		n: -2,
		color: [255, 0, 0],
		bold: true,
		kids: [
			// The JavaScript item went; its child took its place. The Launch item went.
			{ t: 'Inside the script item', d: [3, 'Fit'], kids: [] },
			{ t: 'Web page', d: 'https://example.org/report', kids: [] }
		]
	},
	{
		t: 'Appendix',
		d: null,
		n: 2,
		kids: [
			{ t: 'Last page', d: [4, 'XYZ', null, null, null], kids: [] },
			{ t: '“Quoted” — PDFDoc', d: [4, 'FitB'], kids: [] }
		]
	},
	{ t: 'Empty heading', d: null, kids: [] },
	// A short /XYZ view is padded with nulls (what viewers read it as); page 99 does not exist.
	{ t: 'Short view', d: [2, 'XYZ', 72, null, null], kids: [] }
];

describe('outline: one file, all its pages', () => {
	it('keeps every bookmark that goes somewhere, the details, /Lang, /ViewerPreferences and /PageMode; drops scripts, Launch, XMP', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run(all(src), [src]);
		expect(res.bookmarks).toEqual({ kept: true, items: 11 });
		expect(res.docInfo).toEqual({ kept: true });
		expect(outlineCheck(res)?.detail).toMatch(/^Document details kept \(Title, Author, Subject, Keywords, Creator, CreationDate\).*11 bookmarks kept/);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline).toEqual(BASIC);
		expect(f.info.Title).toBe(BASIC_TITLE);
		expect(f.info.Author).toBe('Ana María — Niño');
		expect(f.info.Subject).toBe('Outline corpus');
		expect(f.info.Keywords).toBe('bookmarks, title');
		expect(f.info.Creator).toBe('generate-outline.mjs');
		expect(f.info.CreationDate).toBe("D:20260102030405+01'00'");
		expect(f.info.Producer).toBeUndefined();
		expect(f.info.ModDate).toBeUndefined();
		expect(f.info.Custom).toBeUndefined();
		expect(f.xmp).toBeNull();
		const cat = await catalogOf(res.bytes);
		expect(cat).toMatch(/\/Lang \(en-GB\)/);
		expect(cat).toMatch(/\/ViewerPreferences << \/Direction \/L2R \/DisplayDocTitle true >>|\/ViewerPreferences << \/DisplayDocTitle true \/Direction \/L2R >>/);
		expect(cat).toMatch(/\/PageMode \/UseOutlines/);
		expect(cat).not.toMatch(/PrintPageRange|OpenAction|Metadata/);
		const raw = await expanded(res.bytes);
		for (const s of ['SCRIPT-BODY', 'SCRIPTED-BOOKMARK', 'LAUNCH-BOOKMARK', 'calc.exe', 'XMP-ONLY-TITLE', 'CUSTOM-INFO-VALUE', '/JavaScript', '/Launch']) expect(found(raw, s), s).toBe(false);
		// The link on page 2 (explicit destination) still goes to page 4.
		expect(f.links[1]).toEqual([[4, 'Fit']]);
	}, T);

	it('says nothing and adds nothing when the file has no title or bookmarks', async () => {
		const src = await openCorpus('multi.pdf');
		const res = await run([ref(src, 0)], [src]);
		expect(res.bookmarks).toBeUndefined();
		expect(res.docInfo).toBeUndefined();
		expect(outlineCheck(res)).toBeUndefined();
	}, T);

	it('keeps them through Optimize (MuPDF cleanup, object streams) and a password', async () => {
		const src = await openCorpus('outline-basic.pdf');
		for (const options of [{ compress: true, printCap: true }, { compress: true, password: 'pw 1' }]) {
			const res = await run(all(src), [src], options);
			expect(res.bookmarks).toEqual({ kept: true, items: 11 });
			const f = await pdfjsFacts(res.bytes, options.password);
			expect(f.outline).toEqual(BASIC);
			expect(f.info.Title).toBe(BASIC_TITLE);
		}
	}, T);

	it('reads the source as the export would: actions dropped, destinations unresolved, views fixed', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const i = await inspectOutline(qpdf, src.bytes, src.pages.length);
		expect(i).toMatchObject({ title: true, info: true, xmp: true, outline: 'ok', names: 0 });
		expect(i!.stats).toMatchObject({ items: 14, unresolved: 1, actions: { '/JavaScript': 1, '/Launch': 1 }, viewsFixed: 1, depth: 3 });
	}, T);
});

describe('outline: pages removed, reordered, rotated, repeated', () => {
	it('a bookmark to a removed page goes and its kept children take its place', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run([ref(src, 0), ref(src, 1), ref(src, 3)], [src]);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline).toEqual([
			BASIC[0],
			// Chapitre 2 (page 3) and its child on page 3 went; the web link under it stays, lifted
			// (it belongs to no page).
			{ t: 'Web page', d: 'https://example.org/report', kids: [] },
			{ t: 'Appendix', d: null, n: 2, kids: [{ t: 'Last page', d: [3, 'XYZ', null, null, null], kids: [] }, { t: '“Quoted” — PDFDoc', d: [3, 'FitB'], kids: [] }] },
			// The empty heading belongs to no page: kept only when the whole file is.
			{ t: 'Short view', d: [2, 'XYZ', 72, null, null], kids: [] }
		]);
		expect(res.bookmarks).toEqual({ kept: true, items: 8 });
		const raw = await expanded(res.bytes);
		expect(found(raw, CHAPTER2)).toBe(false);
		expect(found(raw, 'Inside the script item')).toBe(false);
		expect(found(raw, 'Empty heading')).toBe(false);
		expect(f.info.Title).toBe(BASIC_TITLE);
	}, T);

	it('a web link under a kept bookmark stays under it when other pages are removed', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run([ref(src, 2)], [src]);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline).toEqual([
			{ t: CHAPTER2, d: [1, 'FitR', 10, 20, 300, 400.5], n: -2, color: [255, 0, 0], bold: true, kids: [{ t: 'Inside the script item', d: [1, 'Fit'], kids: [] }, { t: 'Web page', d: 'https://example.org/report', kids: [] }] }
		]);
	}, T);

	it('reordered and rotated pages: every bookmark stays with its page, in the original order, with its view', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run([ref(src, 3), ref(src, 2, 90), ref(src, 1), ref(src, 0, 270)], [src]);
		const f = await pdfjsFacts(res.bytes);
		const pageOf = (n: number) => f.texts[n - 1];
		expect(f.outline[0].t).toBe('Chapter 1');
		expect(f.outline[0].d).toEqual([4, 'XYZ', 72, 720, 0]);
		expect(pageOf(4)).toBe('outline p1');
		expect(f.outline[1].d).toEqual([2, 'FitR', 10, 20, 300, 400.5]);
		expect(pageOf(2)).toBe('outline p3');
		expect(f.outline[2].kids[0].d).toEqual([1, 'XYZ', null, null, null]);
		expect(f.outline.map((m) => m.t)).toEqual(BASIC.map((m) => m.t));
	}, T);

	it('a page used twice: its bookmarks go to the first copy', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run([ref(src, 1), ref(src, 0), ref(src, 1), ref(src, 2), ref(src, 3), ref(src, 0)], [src]);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline[0].d).toEqual([2, 'XYZ', 72, 720, 0]);
		expect(f.outline[0].kids[1].d).toEqual([1, 'Fit']);
		expect(f.outline[4].d).toEqual([1, 'XYZ', 72, null, null]);
	}, T);

	it('blank pages and a picture added: the title stays (one PDF), bookmarks shift with their pages', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const blank = await engine().blankPage({ width: 612, height: 792 });
		const photo = await engine().openImage(corpus('photo-plain.jpg'), 'image/jpeg', 'photo.jpg');
		const res = await run([ref(blank, 0), ...all(src), ref(photo, 0)], [src, blank, photo]);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline[0].d).toEqual([2, 'XYZ', 72, 720, 0]);
		expect(f.info.Title).toBe(BASIC_TITLE);
		expect(res.docInfo).toEqual({ kept: true });
	}, T);
});

describe('outline: named destinations and links', () => {
	it('resolves bookmarks through /Dests and the name tree, carries both, and points links straight at their page', async () => {
		const src = await openCorpus('outline-named.pdf');
		const res = await run(all(src), [src]);
		expect(res.bookmarks).toEqual({ kept: true, items: 5 });
		expect(outlineCheck(res)?.detail).toMatch(/5 bookmarks kept.*6 named destinations kept; 3 links to named destinations go to their page/);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline).toEqual([
			{ t: 'Intro', d: [1, 'Fit'], kids: [] },
			{ t: 'Second', d: [2, 'XYZ', 0, 700, 0], kids: [] },
			{ t: 'Alpha', d: [1, 'FitH', 600], kids: [] },
			{ t: 'Gamma', d: [3, 'Fit'], kids: [] },
			{ t: 'Zeta', d: [3, 'XYZ', 0, 100, 0], kids: [] }
		]);
		expect(f.names).toEqual({ intro: [1, 'Fit'], second: [2, 'XYZ', 0, 700, 0], alpha: [1, 'FitH', 600], beta: [2, 'Fit'], gamma: [3, 'Fit'], [ZETA]: [3, 'XYZ', 0, 100, 0] });
		expect(f.links).toEqual([[[3, 'Fit'], [2, 'XYZ', 0, 700, 0]], [[3, 'XYZ', 0, 100, 0]], []]);
		// The links are explicit now (they work whatever a viewer makes of the names' encoding).
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).not.toMatch(/\/Dest \(gamma\)|\/D \/second/);
		// The name tree is sorted by bytes: the UTF-16 key (FE FF …) comes last.
		const lines = await outlineLines(qpdf, res.bytes);
		expect('names' in lines && lines.names.filter((l) => l.startsWith('["tree"')).map((l) => JSON.parse(l)[1])).toEqual(['u:alpha', 'u:beta', 'u:gamma', `u:${ZETA}`]);
	}, T);

	it('names of a removed page go; links to them stay as they were (they did nothing before either)', async () => {
		const src = await openCorpus('outline-named.pdf');
		const res = await run([ref(src, 0), ref(src, 1)], [src]);
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline.map((m) => m.t)).toEqual(['Intro', 'Second', 'Alpha']);
		expect(Object.keys(f.names).sort()).toEqual(['alpha', 'beta', 'intro', 'second']);
		expect(f.links[0]).toEqual([null, [2, 'XYZ', 0, 700, 0]]);
		expect(f.links[1]).toEqual([null]);
	}, T);

	it('a name two merged files define differently is dropped from both; the others are kept', async () => {
		const a = await openCorpus('outline-named.pdf');
		const b = await openCorpus('outline-second.pdf');
		const res = await run([...all(a), ...all(b)], [a, b]);
		const f = await pdfjsFacts(res.bytes);
		expect(Object.keys(f.names).sort()).toEqual(['beta', 'delta', 'gamma', 'intro', 'second', ZETA].sort());
		expect(f.names.delta).toEqual([4, 'Fit']);
		// Bookmarks of the first file (Alpha resolved from its own names), then the second file's.
		expect(f.outline.map((m) => [m.t, m.d])).toEqual([
			['Intro', [1, 'Fit']],
			['Second', [2, 'XYZ', 0, 700, 0]],
			['Alpha', [1, 'FitH', 600]],
			['Gamma', [3, 'Fit']],
			['Zeta', [3, 'XYZ', 0, 100, 0]],
			['Second file', [4, 'Fit']],
			['Second file, page 2', [5, 'XYZ', 10.1235, 700.988, null]]
		]);
	}, T);
});

describe('outline: several files', () => {
	it('concatenates the outlines in the order the files first appear, keeps no title, keeps a shared /Lang', async () => {
		const a = await openCorpus('outline-basic.pdf');
		const b = await openCorpus('outline-second.pdf');
		const res = await run([ref(b, 0), ...all(a), ref(b, 1)], [a, b]);
		expect(res.docInfo).toEqual({ kept: false, reason: 'merged' });
		const f = await pdfjsFacts(res.bytes);
		expect(f.outline.map((m) => m.t)).toEqual(['Second file', 'Second file, page 2', ...BASIC.map((m) => m.t)]);
		expect(f.outline[1].d).toEqual([6, 'XYZ', 10.1235, 700.988, null]);
		expect(f.outline[2].d).toEqual([2, 'XYZ', 72, 720, 0]);
		expect(f.info.Title).toBeUndefined();
		expect(f.info.Author).toBeUndefined();
		const cat = await catalogOf(res.bytes);
		expect(cat).toMatch(/\/Lang \(en-GB\)/);
		expect(cat).not.toMatch(/PageMode|ViewerPreferences/);
	}, T);
});

describe('outline: avoid, don’t fail', () => {
	it('a cyclic or damaged outline: no bookmarks, the export and its title are fine', async () => {
		for (const name of ['outline-cyclic.pdf', 'outline-damaged.pdf']) {
			const src = await openCorpus(name);
			const res = await run(all(src), [src]);
			expect(res.bookmarks, name).toEqual({ kept: false, reason: 'damaged' });
			expect(res.docInfo).toEqual({ kept: true });
			const f = await pdfjsFacts(res.bytes);
			expect(f.outline).toEqual([]);
			expect(typeof f.info.Title).toBe('string');
		}
	}, T);

	it(`more than ${MAX_ITEMS} bookmarks: none kept`, async () => {
		const bytes = bigOutline(MAX_ITEMS + 1);
		const src = await engine().openPdf(bytes, 'big.pdf');
		const res = await run(all(src), [src]);
		expect(res.bookmarks).toEqual({ kept: false, reason: 'large' });
		expect((await pdfjsFacts(res.bytes)).outline).toEqual([]);
	}, T);

	it('the check catches a changed title, a broken chain, a destination off the file, a wrong /Count and changed details', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run(all(src), [src]);
		const exp = await expectedOf(res.bytes);
		expect((await verifyOutline(qpdf, res.bytes, exp)).check.ok).toBe(true);
		const cases: [string, (o: Record<string, { value?: Record<string, unknown> }>) => void, 'bookmarks' | 'info', RegExp][] = [
			['title', (o) => edit(o, 'u:Section 1.1', (d) => (d['/Title'] = 'u:Section 1.9')), 'bookmarks', /bookmarks: .*Section 1\.9/],
			['prev', (o) => edit(o, 'u:Section 1.2', (d) => delete d['/Prev']), 'bookmarks', /wrong \/Prev/],
			['dest', (o) => edit(o, 'u:Last page', (d) => (d['/Dest'] = [7, '/Fit'])), 'bookmarks', /does not go to a page/],
			['count', (o) => edit(o, 'u:Chapter 1', (d) => (d['/Count'] = 3)), 'bookmarks', /\/Count/],
			['info', (o) => edit(o, '/Author', (d) => (d['/Author'] = 'u:Someone')), 'info', /document details differ/]
		];
		for (const [what, change, part, why] of cases) {
			const bad = await tamper(res.bytes, change);
			const v = await verifyOutline(qpdf, bad, exp);
			expect(v.check.ok, what).toBe(false);
			expect(v.check.detail, what).toMatch(why);
			expect(v.failed[part], what).toBe(true);
			expect(v.failed[part === 'info' ? 'bookmarks' : 'info'], what).toBe(false);
		}
	}, T);
});

describe('outline: redaction and "Remove hidden details"', () => {
	const meta = manifest['outline-secret.pdf'] as unknown as { secretBox: [number, number, number, number]; secrets: string[] };
	const box = { x: meta.secretBox[0] / 612, y: 1 - meta.secretBox[3] / 792, w: (meta.secretBox[2] - meta.secretBox[0]) / 612, h: (meta.secretBox[3] - meta.secretBox[1]) / 792 };

	it('anything blacked out: no bookmarks, names or details, and none of their text is left', async () => {
		const src = await openCorpus('outline-secret.pdf');
		const before = await expanded(src.bytes);
		for (const s of meta.secrets) expect(found(before, s), s).toBe(true);
		for (const compress of [false, true]) {
			const stamps: Stamp[] = [{ id: 'r', kind: 'redact', box }];
			const res = await run([ref(src, 0, 0, stamps), ref(src, 1)], [src], { compress });
			expect(res.bookmarks).toEqual({ kept: false, reason: 'redacted' });
			expect(res.docInfo).toEqual({ kept: false, reason: 'redacted' });
			const raw = await expanded(res.bytes);
			for (const s of [...meta.secrets, 'SECRET-WORD']) expect(found(raw, s), s).toBe(false);
			expect(raw.toString('latin1')).not.toMatch(/\/Outlines|\/Dests/);
			expect((await pageTexts(res.bytes))[1]).toBe('outline-secret p2');
		}
	}, T);

	it('"Remove hidden details": no title or details; bookmarks (visible navigation) stay', async () => {
		const src = await openCorpus('outline-basic.pdf');
		const res = await run(all(src), [src], { stripMetadata: true });
		expect(res.docInfo).toEqual({ kept: false, reason: 'removed' });
		expect(res.bookmarks).toEqual({ kept: true, items: 11 });
		const f = await pdfjsFacts(res.bytes);
		expect(f.info.Title).toBeUndefined();
		expect(f.xmp).toBeNull();
		expect(f.outline).toEqual(BASIC);
		expect(res.checks.find((c) => /Metadata removed/.test(c.detail))?.ok).toBe(true);
	}, T);
});

describe('outline: forms (the in-place assemble path)', () => {
	it('a form exported whole or with a page removed keeps its bookmarks, title and field', async () => {
		const src = await openCorpus('outline-form.pdf');
		let res = await run(all(src), [src]);
		let f = await pdfjsFacts(res.bytes);
		expect(f.outline.map((m) => [m.t, m.d])).toEqual([
			['Form page', [1, 'Fit']],
			['After the form', [2, 'Fit']]
		]);
		expect(f.info.Title).toBe('Outline form');
		res = await run([ref(src, 1)], [src], { flattenForms: true });
		f = await pdfjsFacts(res.bytes);
		expect(f.outline.map((m) => [m.t, m.d])).toEqual([['After the form', [1, 'Fit']]]);
	}, T);
});

describe('outline: numbers', () => {
	it('view coordinates are written with six significant digits, so the MuPDF cleanup is not turned down by them', async () => {
		const notes: string[] = [];
		const e = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n), lossless: { cleanup: 'always' } });
		const src = await e.openPdf(corpus('outline-second.pdf'), 'second.pdf');
		const res = await e.exportPlan({ pages: all(src), options: { ...defaultOptions, compress: true } }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(notes.some((n) => /^cleanup: estimate/.test(n))).toBe(true);
		expect(notes.filter((n) => /rejected/.test(n))).toEqual([]);
		expect((await pdfjsFacts(res.bytes)).outline[1].d).toEqual([2, 'XYZ', 10.1235, 700.988, null]);
	}, T);
});

describe('outline: strings', () => {
	it('parsePdfValue reads qpdf\'s printed syntax into its JSON form, strings as exact bytes', () => {
		const text = '<< /A [ 1 0 R -2 .5 3. 0.50 12345678901234567890 null true ] /B (a\\(b\\)\\n\\101\xe9) /C <FEFF00e9> /D /x#20y#2F /E << >> /F () >>\n';
		const v = parsePdfValue(text) as Record<string, unknown[]>;
		expect(v['/A'].slice(0, 2)).toEqual(['1 0 R', -2]);
		expect(v['/A'].slice(2, 5).map(Number)).toEqual([0.5, 3, 0.5]);
		expect(v['/A'].slice(6)).toEqual([null, true]);
		expect(String(Number(v['/A'][5]))).toBe('12345678901234567000');
		expect(v['/B']).toBe('b:612862290a41e9');
		expect(v['/C']).toBe('b:feff00e9');
		expect(v['/D']).toBe('/x y/');
		expect(v['/E']).toEqual({});
		expect(v['/F']).toBe('b:');
	});

	it('stringBytes: b: exact, u: ASCII as ASCII, other u: as UTF-16BE with a byte order mark', () => {
		expect([...stringBytes('b:e9ff')]).toEqual([0xe9, 0xff]);
		expect([...stringBytes('u:ab')]).toEqual([0x61, 0x62]);
		expect([...stringBytes('u:é')]).toEqual([0xfe, 0xff, 0x00, 0xe9]);
	});
});

// ------------------------------------------------------------------------------ helpers

/** The expected form of a file's own outline (read back), to test the check against changes. */
async function expectedOf(bytes: Uint8Array): Promise<OutlineExpected> {
	const lines = await outlineLines(qpdf, bytes);
	if ('error' in lines) throw new Error(lines.error);
	const info = await infoOf(bytes);
	return { items: lines.lines, names: lines.names.length ? lines.names : null, info, links: new Map(), lang: 'u:en-GB' };
}
async function infoOf(bytes: Uint8Array): Promise<Record<string, string>> {
	const d = await json(bytes);
	const t = d.objects.trailer.value as Record<string, string>;
	const info = d.objects[`obj:${t['/Info']}`].value as Record<string, string>;
	const { textOf } = await import('../../src/lib/engine/tags');
	return Object.fromEntries(Object.entries(info).map(([k, v]) => [k, textOf(v)]));
}
async function json(bytes: Uint8Array) {
	const res = await qpdf.run({ args: ['--json=2', '--json-key=qpdf', '--json-stream-data=none', '/j.pdf', '/j.json'], inputs: { '/j.pdf': bytes }, outputs: ['/j.json'] });
	const parsed = JSON.parse(new TextDecoder().decode(res.files.get('/j.json')!)) as { qpdf: [Record<string, unknown>, Record<string, { value?: Record<string, unknown> }>] };
	return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
}
/** Changes the first object whose dictionary has `key` (a key, or a title value) in place. */
function edit(objects: Record<string, { value?: Record<string, unknown> }>, key: string, change: (d: Record<string, unknown>) => void) {
	for (const [k, o] of Object.entries(objects)) {
		const d = o.value;
		if (!d || typeof d !== 'object' || Array.isArray(d) || k === 'trailer') continue;
		if (key in d || d['/Title'] === key) {
			change(d);
			(objects as Record<string, unknown>).__changed = k;
			return;
		}
	}
	throw new Error(`nothing has ${key}`);
}
async function tamper(bytes: Uint8Array, change: (o: Record<string, { value?: Record<string, unknown> }>) => void): Promise<Uint8Array> {
	const d = await json(bytes);
	change(d.objects);
	const k = (d.objects as Record<string, unknown>).__changed as string;
	const upd = new TextEncoder().encode(JSON.stringify({ qpdf: [d.header, { [k]: d.objects[k] }] }));
	const res = await qpdf.run({ args: ['/t.pdf', '--update-from-json=/t.json', '/t-out.pdf'], inputs: { '/t.pdf': bytes, '/t.json': upd }, outputs: ['/t-out.pdf'] });
	return res.files.get('/t-out.pdf')!;
}

/** A one-page PDF with `n` bookmarks in one level. */
function bigOutline(n: number): Uint8Array {
	const objs: string[] = [];
	const add = (s: string) => objs.push(s);
	add('<< /Type /Catalog /Pages 2 0 R /Outlines 4 0 R >>');
	add('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
	add('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>');
	add(`<< /Type /Outlines /First 5 0 R /Last ${4 + n} 0 R /Count ${n} >>`);
	for (let i = 0; i < n; i++) {
		const me = 5 + i;
		add(`<< /Title (B${i}) /Parent 4 0 R${i ? ` /Prev ${me - 1} 0 R` : ''}${i < n - 1 ? ` /Next ${me + 1} 0 R` : ''} /Dest [3 0 R /Fit] >>`);
	}
	let s = '%PDF-1.7\n';
	const offs: number[] = [];
	objs.forEach((o, i) => {
		offs.push(s.length);
		s += `${i + 1} 0 obj\n${o}\nendobj\n`;
	});
	const x = s.length;
	s += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
	return new Uint8Array(Buffer.from(s, 'latin1'));
}
