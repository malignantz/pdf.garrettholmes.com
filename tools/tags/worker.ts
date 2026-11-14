/**
 * Child process for `tools/tags/measure.ts`: one tagged survey file per job.
 *
 * Steps (each recorded; a step that throws records its error and the next one runs):
 *  - inspect: open with the real engine, read and check the tree as the export would
 *    (tags.ts inspectTags): elements, problems by kind, time.
 *  - t1: the app's default export (Optimize and the print-size cap on), all pages, and the
 *    same export with tags off (keepTags false: today's result) for time and size. Checked
 *    independently of tags.ts: PDF.js `getStructTree()` of every page (first 60) of the
 *    source and the export, normalised (content ids by MCID only), must be equal; MuPDF
 *    text (first 30 pages, ActualText applied, whitespace removed) and renders (first 3
 *    pages, 40 dpi) of the source and the export must be equal.
 *  - del1 / half / rev: one random page removed, a random half kept (in order), all pages
 *    reversed. Each kept page's PDF.js tree must equal its source page's tree, except that
 *    /Alt and /ActualText may be missing (dropped on elements that lost content), and every
 *    picture description left must be one the source page had.
 *  - merge: the file followed by another tagged file: tags must not be kept ('merged').
 *  - redact: one word that occurs once in the file's text (MuPDF, first 50 pages), boxed
 *    and blacked out: tags must not be kept ('redacted') and the word must not be anywhere
 *    in the export's bytes after full decompression (qpdf --qdf --decode-level=all), in
 *    PDFDocEncoding/Latin-1, UTF-16BE or UTF-16LE.
 */
import fs from 'node:fs';
import type { PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { inspectTags } from '../../src/lib/engine/tags';
import { debugNotes, engine, loadPdfjs, nodeAssets, qpdf } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';
import { compare, openDoc, renderPage, renderScale } from '../survey/lib/raster';

export interface TagsJob {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: 'tune' | 'held';
	/** Another tagged file, for the merge step. */
	partner?: string;
}

export interface StepResult {
	status: 'kept' | 'dropped' | 'none' | 'error' | 'skipped';
	reason?: string;
	code?: string;
	message?: string;
	/** Independent check: 'same' or what differs. */
	tree?: string;
	text?: string;
	pixels?: string;
	ms?: number;
	bytes?: number;
	/** tags.ts time inside the export: source read (first export only), graft, final check. */
	tagsMs?: { read: number; graft: number; verify: number };
	elements?: number;
	leak?: string;
}

export interface TagsResult {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: TagsJob['half'];
	pages?: number;
	open: 'ok' | 'error';
	openMessage?: string;
	tagged?: boolean;
	elements?: number;
	problems?: Record<string, number>;
	firstProblem?: string;
	streams?: boolean;
	inspectMs?: number;
	base?: StepResult;
	t1?: StepResult;
	del1?: StepResult;
	halfKept?: StepResult;
	rev?: StepResult;
	merge?: StepResult;
	redact?: StepResult;
	ms: number;
}

const TREE_PAGES = 60;
const TEXT_PAGES = 30;
const PIXEL_PAGES = 3;

let plain: ReturnType<typeof createCoreEngine> | null = null;
const untagged = () => (plain ??= createCoreEngine(nodeAssets(), { keepTags: false }));

/** Deterministic random numbers from the file's hash. */
function rng(seed: string) {
	let x = Number.parseInt(seed.slice(0, 8), 16) || 1;
	return () => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return ((x >>> 0) % 1_000_000) / 1_000_000;
	};
}

const opts = { filename: 'out.pdf', compress: true, stripMetadata: false, printCap: true };
const plan = (src: Source, idx: number[], stamps: Map<number, Stamp[]> = new Map()): PageRef[] =>
	idx.map((i, k) => ({ id: `p${k}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: stamps.get(k) ?? [] }));

async function run(sources: Source[], pages: PageRef[], eng = engine()): Promise<{ r: StepResult; bytes?: Uint8Array }> {
	debugNotes.length = 0;
	const t0 = Date.now();
	try {
		const res = await eng.exportPlan({ pages, options: opts }, sources, []);
		const r: StepResult = { status: res.tags === undefined ? 'none' : res.tags.kept ? 'kept' : 'dropped', ms: Date.now() - t0, bytes: res.bytes.length };
		if (res.tags && !res.tags.kept) r.reason = res.tags.reason;
		const g = debugNotes.find((n) => /^tags: \d+ elements kept/.test(n));
		const v = res.checks.find((c) => c.name === 'tags');
		if (g) {
			const m = /(\d+) elements kept .*graft (\d+) ms, source read (\d+) ms/.exec(g);
			if (m) {
				r.elements = Number(m[1]);
				r.tagsMs = { graft: Number(m[2]), read: Number(m[3]), verify: Number(/\((\d+) ms\)\.$/.exec(v?.detail ?? '')?.[1] ?? 0) };
			}
		}
		const failed = debugNotes.find((n) => /tags failed their check/.test(n));
		if (failed) r.message = failed.slice(0, 300);
		return { r, bytes: res.bytes };
	} catch (e) {
		return { r: { status: 'error', code: e instanceof EngineError ? e.code : 'exception', message: (e instanceof Error ? e.message : String(e)).slice(0, 300), ms: Date.now() - t0 } };
	}
}

type Node = { role?: string; alt?: string; children?: Node[]; type?: string; id?: string; [k: string]: unknown };

/** PDF.js structure tree of each page (null for pages past `max`), normalised. */
async function pageTrees(bytes: Uint8Array, pages: number[]): Promise<Map<number, Node | null>> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false } as Parameters<typeof lib.getDocument>[0]);
	const doc = await task.promise;
	const out = new Map<number, Node | null>();
	try {
		for (const i of pages) {
			const page = await doc.getPage(i + 1);
			const t = (await page.getStructTree()) as Node | null;
			out.set(i, t ? norm(t) : null);
			page.cleanup();
		}
	} finally {
		await task.destroy();
	}
	return out;
}

function norm(n: Node): Node {
	const o: Node = {};
	for (const [k, v] of Object.entries(n)) {
		if (k === 'children') continue;
		if (k === 'id') o.id = typeof v === 'string' ? (/_mc(\d+)$/.exec(v)?.[1] ? `mc${/_mc(\d+)$/.exec(v)![1]}` : n.type === 'annotation' ? 'annot' : 'x') : 'x';
		else o[k] = v;
	}
	if (n.children) o.children = n.children.map(norm);
	return o;
}

/**
 * Without /Alt texts and without elements that hold no content on the page: PDF.js lists an
 * element on every page its /Pg names, also when all its content lies on another page, and
 * a pruned tree drops such elements when that other page was removed.
 */
function stripAlt(n: Node | null): Node | null {
	if (!n) return n;
	const { alt: _a, ...rest } = n;
	if (!n.children) return rest;
	const kids = n.children.map((c) => (c.type ? c : stripAlt(c))).filter((c): c is Node => c !== null && (c.type !== undefined || (c.children?.length ?? 0) > 0));
	return { ...rest, children: kids };
}
function alts(n: Node | null, out: string[] = []): string[] {
	if (!n) return out;
	if (typeof n.alt === 'string') out.push(n.alt);
	for (const c of n.children ?? []) alts(c, out);
	return out;
}

/** Compares output pages' trees with their source pages' (`from[j]` = source page of output page j). */
async function treeCheck(src: Uint8Array, out: Uint8Array, from: number[], exact: boolean): Promise<string> {
	const j = from.map((_, k) => k).slice(0, TREE_PAGES);
	const a = await pageTrees(src, j.map((k) => from[k]));
	const b = await pageTrees(out, j);
	for (const k of j) {
		const sa = a.get(from[k]) ?? null;
		const sb = b.get(k) ?? null;
		if (exact) {
			if (JSON.stringify(sa) !== JSON.stringify(sb)) return `page ${k + 1} (source page ${from[k] + 1}) differs: ${JSON.stringify(sb).slice(0, 200)} vs ${JSON.stringify(sa).slice(0, 200)}`;
		} else {
			if (JSON.stringify(stripAlt(sa)) !== JSON.stringify(stripAlt(sb))) return `page ${k + 1} (source page ${from[k] + 1}) shape differs: ${JSON.stringify(stripAlt(sb)).slice(0, 200)} vs ${JSON.stringify(stripAlt(sa)).slice(0, 200)}`;
			const have = alts(sa);
			for (const t of alts(sb)) {
				const at = have.indexOf(t);
				if (at < 0) return `page ${k + 1}: description "${t.slice(0, 60)}" is not on the source page`;
				have.splice(at, 1);
			}
		}
	}
	return 'same';
}

async function textCheck(src: Uint8Array, out: Uint8Array): Promise<string> {
	const m = await mupdf();
	const textOf = (b: Uint8Array) => {
		const doc = m.Document.openDocument(b.slice(), 'application/pdf');
		try {
			const n = Math.min(TEXT_PAGES, doc.countPages());
			const pages: string[] = [];
			for (let i = 0; i < n; i++) {
				const page = doc.loadPage(i);
				const st = page.toStructuredText();
				pages.push(st.asText().replace(/\s+/g, ''));
				st.destroy();
				page.destroy();
			}
			return pages;
		} finally {
			doc.destroy();
		}
	};
	const a = textOf(src);
	const b = textOf(out);
	const diff = a.findIndex((t, i) => t !== b[i]);
	return diff < 0 && a.length === b.length ? 'same' : `page ${diff + 1}: ${a[diff]?.length} vs ${b[diff]?.length ?? 0} characters`;
}

async function pixelCheck(src: Uint8Array, out: Uint8Array): Promise<string> {
	const m = await mupdf();
	const da = openDoc(m, src);
	const db = openDoc(m, out);
	try {
		const n = Math.min(PIXEL_PAGES, da.countPages());
		for (let i = 0; i < n; i++) {
			const b = da.loadPage(i).getBounds();
			const s = renderScale(b[2] - b[0], b[3] - b[1]);
			const d = compare(renderPage(m, da, i, s), renderPage(m, db, i, s));
			if (!d.sameSize || d.differing > 0) return `page ${i + 1}: ${d.differing} pixels differ`;
		}
		return 'same';
	} finally {
		da.destroy();
		db.destroy();
	}
}

/** A word that occurs once in the file's text, and its box as stamp fractions of its page. */
async function uniqueWord(bytes: Uint8Array, pick: () => number): Promise<{ page: number; word: string; box: { x: number; y: number; w: number; h: number } } | null> {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	try {
		const n = Math.min(50, doc.countPages());
		const words = new Map<string, { page: number; quad: number[]; count: number }>();
		const bounds: number[][] = [];
		for (let i = 0; i < n; i++) {
			const page = doc.loadPage(i);
			bounds.push(page.getBounds() as number[]);
			const st = page.toStructuredText('preserve-whitespace');
			let cur = '';
			let quads: number[][] = [];
			const flush = () => {
				if (/^[A-Za-z]{6,}$/.test(cur)) {
					const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
					const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
					const w = words.get(cur.toLowerCase());
					if (w) w.count++;
					else words.set(cur.toLowerCase(), { page: i, quad: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], count: 1 });
				} else if (cur.length >= 6) {
					const w = words.get(cur.toLowerCase());
					if (w) w.count++;
				}
				cur = '';
				quads = [];
			};
			st.walk({
				onChar(c: string, _o: unknown, _f: unknown, _s: unknown, q: number[]) {
					if (/\s/.test(c)) flush();
					else {
						cur += c;
						quads.push(q);
					}
				},
				endLine: flush
			} as Parameters<typeof st.walk>[0]);
			flush();
			st.destroy();
			page.destroy();
		}
		const all = doc.countPages() > n ? '' : 'all';
		const once = [...words].filter(([, w]) => w.count === 1);
		if (!once.length || !all) {
			if (!once.length) return null;
		}
		const [word, w] = once[Math.floor(pick() * once.length)];
		const b = bounds[w.page];
		const W = b[2] - b[0];
		const H = b[3] - b[1];
		const pad = 1;
		const x0 = Math.max(0, (w.quad[0] - b[0] - pad) / W);
		const y0 = Math.max(0, (w.quad[1] - b[1] - pad) / H);
		const x1 = Math.min(1, (w.quad[2] - b[0] + pad) / W);
		const y1 = Math.min(1, (w.quad[3] - b[1] + pad) / H);
		if (!(x1 > x0 && y1 > y0)) return null;
		return { page: w.page, word, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
	} finally {
		doc.destroy();
	}
}

async function leakOf(out: Uint8Array, word: string): Promise<string> {
	const res = await qpdf().run({ args: ['--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'], inputs: { '/i.pdf': out }, outputs: ['/o.pdf'] });
	const file = res.files.get('/o.pdf');
	if (!file) return 'unchecked';
	const buf = Buffer.from(file);
	const variants = [word, word.toLowerCase(), word.toUpperCase()];
	for (const v of variants) {
		for (const [enc, b] of [
			['latin1', Buffer.from(v, 'latin1')],
			['utf16be', Buffer.from(v, 'utf16le').swap16()],
			['utf16le', Buffer.from(v, 'utf16le')]
		] as const) {
			const at = buf.indexOf(b);
			if (at >= 0) return `${enc} at ${at}: ${buf.subarray(Math.max(0, at - 60), at + b.length + 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`;
		}
	}
	return 'none';
}

serveJobs<TagsJob, TagsResult>(async (job, io) => {
	const t0 = Date.now();
	const r: TagsResult = { sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', ms: 0 };
	const done = () => {
		r.ms = Date.now() - t0;
		io.result(r);
	};
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	io.progress('open');
	let src: Source;
	try {
		src = await engine().openPdf(bytes, 'survey.pdf');
		r.open = 'ok';
		r.pages = src.pages.length;
	} catch (e) {
		r.openMessage = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		return done();
	}
	io.progress('inspect');
	const ins = await inspectTags(qpdf(), src.bytes);
	r.tagged = ins?.tagged ?? false;
	if (!ins?.tagged) return done();
	r.elements = ins.elements;
	r.streams = ins.streams;
	r.inspectMs = ins.ms;
	r.problems = {};
	for (const p of ins.problems) r.problems[p.kind] = (r.problems[p.kind] ?? 0) + 1;
	if (ins.problems[0]) r.firstProblem = `${ins.problems[0].kind}${ins.problems[0].page !== undefined ? ` p${ins.problems[0].page + 1}` : ''} ${ins.problems[0].detail ?? ''}`.slice(0, 200);

	const all = src.pages.map((_, i) => i);
	io.progress('base');
	r.base = (await run([src], plan(src, all), untagged())).r;
	io.progress('t1');
	const t1 = await run([src], plan(src, all));
	r.t1 = t1.r;
	if (t1.bytes && t1.r.status === 'kept') {
		try {
			io.progress('t1-tree');
			r.t1.tree = await treeCheck(src.bytes, t1.bytes, all, true);
			io.progress('t1-text');
			r.t1.text = await textCheck(src.bytes, t1.bytes);
			io.progress('t1-pixels');
			r.t1.pixels = await pixelCheck(src.bytes, t1.bytes);
		} catch (e) {
			r.t1.tree ??= `error ${(e as Error).message}`.slice(0, 200);
		}
	}
	const pick = rng(job.sha256);
	const variant = async (name: 'del1' | 'halfKept' | 'rev', idx: number[], exact: boolean) => {
		io.progress(name);
		const v = await run([src], plan(src, idx));
		r[name] = v.r;
		if (v.bytes && v.r.status === 'kept') {
			try {
				v.r.tree = await treeCheck(src.bytes, v.bytes, idx, exact);
			} catch (e) {
				v.r.tree = `error ${(e as Error).message}`.slice(0, 200);
			}
		}
	};
	if (all.length >= 2) {
		const k = Math.floor(pick() * all.length);
		await variant('del1', all.filter((i) => i !== k), false);
		const half = all.filter(() => pick() < 0.5);
		await variant('halfKept', half.length ? half : [0], false);
		await variant('rev', [...all].reverse(), true);
	}
	if (job.partner) {
		io.progress('merge');
		try {
			const other = await engine().openPdf(new Uint8Array(fs.readFileSync(job.partner)), 'partner.pdf');
			const pages = [...plan(src, all), ...other.pages.map((_, i) => ({ id: `q${i}`, sourceId: other.id, pageIndex: i, rotation: 0 as const, stamps: [] }))];
			r.merge = (await run([src, other], pages)).r;
		} catch (e) {
			r.merge = { status: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
		}
	}
	io.progress('redact');
	try {
		const w = await uniqueWord(src.bytes, pick);
		if (!w) r.redact = { status: 'skipped', message: 'no word that occurs once' };
		else {
			const stamps = new Map<number, Stamp[]>([[w.page, [{ id: 'r', kind: 'redact', box: w.box }]]]);
			const v = await run([src], plan(src, all, stamps));
			r.redact = v.r;
			r.redact.message = `${w.word} on page ${w.page + 1}${v.r.message ? `; ${v.r.message}` : ''}`;
			if (v.bytes) r.redact.leak = await leakOf(v.bytes, w.word);
		}
	} catch (e) {
		r.redact = { status: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
	}
	done();
});
