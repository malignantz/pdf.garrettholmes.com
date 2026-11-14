/**
 * Child process for `tools/outline/measure.ts`: one survey file per job.
 *
 * Job kinds:
 *  - 'title': whether the file (as given) has an Info /Title and an XMP packet (qpdf only, no
 *    engine): for the share of survey files with a title.
 *  - 'full': a file with bookmarks. Steps (each recorded; a step that throws records its error and
 *    the next one runs):
 *    - inspect: open with the real engine and read the outline as the export would
 *      (outline.ts inspectOutline): items, actions dropped, destinations unresolved, names, time.
 *    - base / t1: the app's default export (Optimize and the print-size cap on), all pages, with
 *      the outline code off (keepOutline false: before this branch) and on, for time and size.
 *      Checked independently of outline.ts with PDF.js: the preorder list of (title, page, view
 *      kind) of the bookmarks that go to a page or a web address, in the source (names resolved
 *      by PDF.js) and in the export, must be equal (dropping a bookmark and lifting its children
 *      keeps the preorder of the rest); the named destinations PDF.js lists, and the Info title.
 *    - del1 / halfKept / rev: one random page removed, a random half kept, all pages reversed:
 *      the same list, the source's restricted to kept pages and mapped to their (first) output page.
 *    - merge: the file followed by another file with bookmarks: both lists, one after the other.
 *    - redact: one word that occurs once in the page text (preferring one that is also in a
 *      bookmark title), blacked out: no bookmarks or details may be kept, and the word must not be
 *      in the export's bytes after full decompression.
 */
import fs from 'node:fs';
import type { PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { inspectOutline } from '../../src/lib/engine/outline';
import { QPDF_OK, QPDF_WARNINGS } from '../../src/lib/engine/qpdf';
import { debugNotes, engine, loadPdfjs, nodeAssets, qpdf } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';

export interface OutlineJob {
	kind: 'full' | 'title';
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: 'tune' | 'held';
	/** Another file with bookmarks, for the merge step. */
	partner?: string;
}

export interface StepResult {
	status: 'kept' | 'dropped' | 'none' | 'error' | 'skipped';
	reason?: string;
	/** ExportResult.docInfo. */
	info?: string;
	code?: string;
	message?: string;
	/** Independent check (PDF.js): 'same' or what differs. */
	marks?: string;
	names?: string;
	title?: string;
	items?: number;
	ms?: number;
	bytes?: number;
	/** outline.ts time inside the export: graft and final check. */
	outlineMs?: { graft: number; verify: number };
	leak?: string;
	/** Notes the engine wrote: the check failed and the export was rebuilt, the cleanup turned down. */
	fellBack?: string;
	cleanup?: string;
}

export interface OutlineResult {
	kind: OutlineJob['kind'];
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: OutlineJob['half'];
	/** 'title' jobs and 'full' inspect: Info /Title (text, not empty), XMP packet. */
	title?: boolean;
	xmp?: boolean;
	pages?: number;
	size?: number;
	open: 'ok' | 'error';
	openMessage?: string;
	outline?: 'none' | 'ok' | 'damaged' | 'large';
	outlineDetail?: string;
	items?: number;
	unresolved?: number;
	actions?: Record<string, number>;
	viewsFixed?: number;
	depth?: number;
	namesCount?: number;
	namesProblem?: string;
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

let plain: ReturnType<typeof createCoreEngine> | null = null;
const without = () => (plain ??= createCoreEngine(nodeAssets(), { keepOutline: false, debug: (n) => debugNotes.push(n) }));

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
const plan = (src: Source, idx: number[], stamps: Map<number, Stamp[]> = new Map(), prefix = 'p'): PageRef[] =>
	idx.map((i, k) => ({ id: `${prefix}${k}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: stamps.get(k) ?? [] }));

async function run(sources: Source[], pages: PageRef[], eng = engine()): Promise<{ r: StepResult; bytes?: Uint8Array }> {
	debugNotes.length = 0;
	const t0 = Date.now();
	try {
		const res = await eng.exportPlan({ pages, options: opts }, sources, []);
		const b = res.bookmarks;
		const r: StepResult = { status: b === undefined ? 'none' : b.kept ? 'kept' : 'dropped', ms: Date.now() - t0, bytes: res.bytes.length };
		if (b && !b.kept) r.reason = b.reason;
		if (b?.kept) r.items = b.items;
		if (res.docInfo) r.info = res.docInfo.kept ? 'kept' : res.docInfo.reason;
		const g = debugNotes.find((n) => /^outline: \d+ bookmarks/.test(n));
		const v = res.checks.find((c) => c.name === 'outline');
		if (g) r.outlineMs = { graft: Number(/, (\d+) ms$/.exec(g)?.[1] ?? 0), verify: Number(/\((\d+) ms\)\.$/.exec(v?.detail ?? '')?.[1] ?? 0) };
		const fb = debugNotes.find((n) => /title and bookmarks failed their check|packed file failed verification/.test(n));
		if (fb) r.fellBack = fb.slice(0, 300);
		const cl = debugNotes.find((n) => /^cleanup: (result rejected|\d+ →|not smaller)/.test(n));
		if (cl) r.cleanup = cl.replace(/^cleanup: /, '').slice(0, 120);
		return { r, bytes: res.bytes };
	} catch (e) {
		return { r: { status: 'error', code: e instanceof EngineError ? e.code : 'exception', message: (e instanceof Error ? e.message : String(e)).slice(0, 300), ms: Date.now() - t0 } };
	}
}

interface Facts {
	/** Bookmarks with a page or web target, preorder: [title, page index (0-based) or url, view kind]. */
	marks: [string, number | string, string][];
	names: Map<string, number>;
	title: string | null;
}

/** What PDF.js sees (independent of outline.ts). */
async function facts(bytes: Uint8Array): Promise<Facts> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false } as Parameters<typeof lib.getDocument>[0]);
	const doc = await task.promise;
	try {
		const pageOf = async (d0: unknown): Promise<[number, string] | null> => {
			let d = d0;
			if (typeof d === 'string') d = await doc.getDestination(d).catch(() => null);
			if (!Array.isArray(d) || !d[0] || typeof d[0] !== 'object') return null;
			try {
				return [await doc.getPageIndex(d[0] as { num: number; gen: number }), (d[1] as { name?: string } | undefined)?.name ?? '?'];
			} catch {
				return null;
			}
		};
		type Raw = { title: string; dest: unknown; url?: string | null; items: Raw[] };
		const marks: Facts['marks'] = [];
		const seen = new Set<Raw>();
		const walk = async (items: Raw[] | null, depth: number) => {
			for (const o of items ?? []) {
				if (seen.has(o) || depth > 64 || marks.length > 30_000) return;
				seen.add(o);
				if (o.url) marks.push([o.title, o.url, 'url']);
				else {
					const p = await pageOf(o.dest);
					if (p) marks.push([o.title, p[0], p[1]]);
				}
				await walk(o.items, depth + 1);
			}
		};
		await walk((await doc.getOutline()) as Raw[] | null, 0);
		const names = new Map<string, number>();
		const dests = (await doc.getDestinations()) as Map<string, unknown> | Record<string, unknown>;
		let k = 0;
		for (const [key, v] of dests instanceof Map ? dests : Object.entries(dests)) {
			if (++k > 20_000) break;
			const p = await pageOf(v);
			if (p) names.set(key, p[0]);
		}
		const info = (await doc.getMetadata()).info as Record<string, unknown>;
		return { marks, names, title: typeof info.Title === 'string' && info.Title !== '' ? info.Title : null };
	} finally {
		await task.destroy();
	}
}

/** The source's marks restricted to kept pages, mapped to output pages (`out[sourcePage]` = first output index). */
function mapMarks(f: Facts, out: Map<number, number>): Facts['marks'] {
	return f.marks.flatMap(([t, p, kind]) => (typeof p === 'string' ? [[t, p, kind] as Facts['marks'][number]] : out.has(p) ? [[t, out.get(p)!, kind] as Facts['marks'][number]] : []));
}
function firstOut(idx: number[]): Map<number, number> {
	const m = new Map<number, number>();
	idx.forEach((p, k) => {
		if (!m.has(p)) m.set(p, k);
	});
	return m;
}
function diffMarks(got: Facts['marks'], want: Facts['marks']): string {
	if (got.length !== want.length) {
		const i = got.findIndex((g, k) => JSON.stringify(g) !== JSON.stringify(want[k]));
		return `${got.length} vs ${want.length} bookmarks; first difference at ${i + 1}: ${JSON.stringify(got[i] ?? null).slice(0, 120)} vs ${JSON.stringify(want[i] ?? null).slice(0, 120)}`;
	}
	for (let i = 0; i < got.length; i++) if (JSON.stringify(got[i]) !== JSON.stringify(want[i])) return `bookmark ${i + 1}: ${JSON.stringify(got[i]).slice(0, 120)} vs ${JSON.stringify(want[i]).slice(0, 120)}`;
	return 'same';
}
function diffNames(got: Map<string, number>, src: Map<string, number>, out: Map<number, number>): string {
	const want = new Map<string, number>();
	for (const [k, p] of src) if (out.has(p)) want.set(k, out.get(p)!);
	if (got.size !== want.size) return `${got.size} vs ${want.size} names`;
	for (const [k, p] of want) if (got.get(k) !== p) return `name ${k.slice(0, 40)}: ${got.get(k)} vs ${p}`;
	return 'same';
}

/** A word that occurs once in the page text (prefer one in a bookmark title), and its box. */
async function uniqueWord(bytes: Uint8Array, titles: string[], pick: () => number): Promise<{ page: number; word: string; inTitle: boolean; box: { x: number; y: number; w: number; h: number } } | null> {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	try {
		const n = doc.countPages();
		if (n > 300) return null;
		const words = new Map<string, { page: number; quad: number[]; count: number; text: string }>();
		const bounds: number[][] = [];
		for (let i = 0; i < n; i++) {
			const page = doc.loadPage(i);
			bounds.push(page.getBounds() as number[]);
			const st = page.toStructuredText('preserve-whitespace');
			let cur = '';
			let quads: number[][] = [];
			const flush = () => {
				if (cur.length >= 5) {
					const w = words.get(cur.toLowerCase());
					if (w) w.count++;
					else if (/^[A-Za-z]+$/.test(cur)) {
						const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
						const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
						words.set(cur.toLowerCase(), { page: i, quad: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)], count: 1, text: cur });
					}
				}
				cur = '';
				quads = [];
			};
			st.walk({
				onChar(c: string, _o: unknown, _f: unknown, _s: unknown, q: number[]) {
					if (!/[A-Za-z]/.test(c)) flush();
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
		const once = [...words].filter(([, w]) => w.count === 1);
		if (!once.length) return null;
		const lower = titles.join(' ').toLowerCase();
		const inTitles = once.filter(([k]) => new RegExp(`(^|[^a-z])${k}([^a-z]|$)`).test(lower));
		const pool = inTitles.length ? inTitles : once;
		const [, w] = pool[Math.floor(pick() * pool.length)];
		const b = bounds[w.page];
		const W = b[2] - b[0];
		const H = b[3] - b[1];
		const x0 = Math.max(0, (w.quad[0] - b[0] - 1) / W);
		const y0 = Math.max(0, (w.quad[1] - b[1] - 1) / H);
		const x1 = Math.min(1, (w.quad[2] - b[0] + 1) / W);
		const y1 = Math.min(1, (w.quad[3] - b[1] + 1) / H);
		if (!(x1 > x0 && y1 > y0)) return null;
		return { page: w.page, word: w.text, inTitle: inTitles.length > 0, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
	} finally {
		doc.destroy();
	}
}

/** Where the word is in the decompressed export, outside font programs, or 'none'. */
async function leakOf(out: Uint8Array, word: string): Promise<string> {
	const res = await qpdf().run({ args: ['--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'], inputs: { '/i.pdf': out }, outputs: ['/o.pdf'] });
	const file = res.files.get('/o.pdf');
	if (!file) return 'unchecked';
	const buf = Buffer.from(file);
	const letter = (c: number | undefined) => c !== undefined && ((c >= 65 && c <= 90) || (c >= 97 && c <= 122));
	for (const [enc, b] of [
		['latin1', Buffer.from(word, 'latin1')],
		['utf16be', Buffer.from(word, 'utf16le').swap16()],
		['utf16le', Buffer.from(word, 'utf16le')]
	] as const) {
		for (let at = buf.indexOf(b); at >= 0; at = buf.indexOf(b, at + 1)) {
			const before = enc === 'latin1' ? buf[at - 1] : enc === 'utf16be' ? buf[at - 1] : buf[at - 2];
			const after = enc === 'latin1' ? buf[at + b.length] : enc === 'utf16be' ? buf[at + b.length + 1] : buf[at + b.length];
			if (letter(before) || letter(after) || buf[at - 1] === 0x2f) continue;
			const head = buf.lastIndexOf('\n%% Original object ID', at);
			const dict = buf.subarray(head < 0 ? 0 : head, Math.min(at, (head < 0 ? 0 : head) + 4000)).toString('latin1');
			if (/\/Length[123] |\/Subtype \/(Type1C|CIDFontType0C|OpenType)|\/Type \/EmbeddedFile|\/Type \/Metadata/.test(dict.split('stream\n')[0])) continue;
			return `${enc} at ${at}: ${buf.subarray(Math.max(0, at - 60), at + b.length + 20).toString('latin1').replace(/[^\x20-\x7e]/g, '.')}`;
		}
	}
	return 'none';
}

/** Info /Title and catalog XMP of the file as given (qpdf only). */
async function titleOf(bytes: Uint8Array): Promise<{ title: boolean; xmp: boolean } | null> {
	const q = qpdf();
	const show = async (what: string) => {
		const r = await q.run({ args: ['--json=2', '--json-key=qpdf', `--json-object=${what}`, '--json-stream-data=none', '/t.pdf', '/t.json'], inputs: { '/t.pdf': bytes }, outputs: ['/t.json'] });
		const f = r.files.get('/t.json');
		if ((r.code !== QPDF_OK && r.code !== QPDF_WARNINGS) || !f) return null;
		return (JSON.parse(new TextDecoder().decode(f)) as { qpdf: [unknown, Record<string, { value?: Record<string, unknown> }>] }).qpdf[1];
	};
	const t = await show('trailer');
	const tr = t?.trailer?.value;
	if (!tr) return null;
	const arg = (r: unknown) => (typeof r === 'string' ? r.replace(/^(\d+) (\d+) R$/, '$1,$2') : null);
	const info = arg(tr['/Info']);
	const root = arg(tr['/Root']);
	const io = info ? await show(info) : null;
	const ro = root ? await show(root) : null;
	const id = io ? Object.values(io).find((o) => o.value && typeof o.value === 'object')?.value : undefined;
	const cat = ro ? Object.values(ro).find((o) => o.value && typeof o.value === 'object')?.value : undefined;
	let title = id?.['/Title'];
	if (typeof title === 'string' && /^\d+ \d+ R$/.test(title)) {
		const x = await show(arg(title)!);
		title = x ? Object.values(x)[0]?.value : undefined;
	}
	return { title: typeof title === 'string' && title !== 'u:' && title !== 'b:', xmp: cat?.['/Metadata'] !== undefined };
}

serveJobs<OutlineJob, OutlineResult>(async (job, io) => {
	const t0 = Date.now();
	const r: OutlineResult = { kind: job.kind, sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', ms: 0 };
	const done = () => {
		r.ms = Date.now() - t0;
		io.result(r);
	};
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	r.size = bytes.length;
	if (job.kind === 'title') {
		io.progress('title');
		try {
			const t = await titleOf(bytes);
			if (t) {
				r.open = 'ok';
				r.title = t.title;
				r.xmp = t.xmp;
			} else r.openMessage = 'qpdf could not read the trailer';
		} catch (e) {
			r.openMessage = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		}
		return done();
	}
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
	const ins = await inspectOutline(qpdf(), src.bytes, src.pages.length);
	if (ins) {
		r.title = ins.title;
		r.xmp = ins.xmp;
		r.outline = ins.outline;
		r.outlineDetail = ins.detail;
		r.items = ins.stats.items;
		r.unresolved = ins.stats.unresolved;
		r.actions = ins.stats.actions;
		r.viewsFixed = ins.stats.viewsFixed;
		r.depth = ins.stats.depth;
		r.namesCount = ins.names;
		r.namesProblem = ins.namesProblem;
		r.inspectMs = ins.ms;
	}
	let sf: Facts | null = null;
	try {
		io.progress('facts');
		sf = await facts(src.bytes);
	} catch {
		sf = null;
	}
	const all = src.pages.map((_, i) => i);
	const check = (step: StepResult, out: Uint8Array | undefined, idx: number[], f: Facts | null, extra?: Facts['marks']) => async () => {
		if (!out || !sf || step.status !== 'kept') return;
		try {
			const of = await facts(out);
			const fo = firstOut(idx);
			step.marks = diffMarks(of.marks, [...mapMarks(sf, fo), ...(extra ?? [])]);
			step.names = extra ? undefined : diffNames(of.names, sf.names, fo);
			if (f) step.title = of.title === sf.title ? 'same' : `${JSON.stringify(of.title)?.slice(0, 60)} vs ${JSON.stringify(sf.title)?.slice(0, 60)}`;
		} catch (e) {
			step.marks = `error ${(e as Error).message}`.slice(0, 200);
		}
	};
	// MuPDF loaded before both exports: the cleanup's rule depends on whether it is (core.ts), and
	// the first export to load it would otherwise decide differently from the second.
	await mupdf();
	io.progress('base');
	r.base = (await run([src], plan(src, all), without())).r;
	io.progress('t1');
	const t1 = await run([src], plan(src, all));
	r.t1 = t1.r;
	await check(t1.r, t1.bytes, all, sf)();
	const pick = rng(job.sha256);
	const variant = async (name: 'del1' | 'halfKept' | 'rev', idx: number[]) => {
		io.progress(name);
		const v = await run([src], plan(src, idx));
		r[name] = v.r;
		await check(v.r, v.bytes, idx, null)();
	};
	if (all.length >= 2) {
		const k = Math.floor(pick() * all.length);
		await variant('del1', all.filter((i) => i !== k));
		const half = all.filter(() => pick() < 0.5);
		await variant('halfKept', half.length ? half : [0]);
		await variant('rev', [...all].reverse());
	}
	if (job.partner) {
		io.progress('merge');
		try {
			const other = await engine().openPdf(new Uint8Array(fs.readFileSync(job.partner)), 'partner.pdf');
			const m = await run([src, other], [...plan(src, all), ...plan(other, other.pages.map((_, i) => i), new Map(), 'q')]);
			r.merge = m.r;
			if (m.bytes && m.r.status === 'kept' && sf) {
				const pf = await facts(other.bytes);
				const shifted = pf.marks.map(([t, p, kind]) => [t, typeof p === 'number' ? p + all.length : p, kind] as Facts['marks'][number]);
				await check(m.r, m.bytes, all, null, shifted)();
			}
		} catch (e) {
			r.merge = { status: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
		}
	}
	io.progress('redact');
	try {
		const w = await uniqueWord(src.bytes, sf?.marks.map((m) => m[0]) ?? [], pick);
		if (!w) r.redact = { status: 'skipped', message: 'no word that occurs once' };
		else {
			const stamps = new Map<number, Stamp[]>([[w.page, [{ id: 'r', kind: 'redact', box: w.box }]]]);
			const v = await run([src], plan(src, all, stamps));
			r.redact = v.r;
			r.redact.message = `${w.word} on page ${w.page + 1}${w.inTitle ? ', also in a bookmark title' : ''}`;
			if (v.bytes) r.redact.leak = await leakOf(v.bytes, w.word);
		}
	} catch (e) {
		r.redact = { status: 'error', message: (e instanceof Error ? e.message : String(e)).slice(0, 200) };
	}
	done();
});
