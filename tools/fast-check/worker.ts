/**
 * Child process for tools/fast-check/measure.ts: one file per job (corpus, generated or
 * survey; survey files are untrusted data and are only read).
 *
 * Steps:
 *  - raw: `qpdf --check` of the file as given, the full way and the fast way (prelude and
 *    check in one instance, no fallback): same exit code, stdout and stderr?
 *  - open with the real engine.
 *  - exports (all pages): plain (Optimize off) and the app's default (Optimize and the
 *    print-size cap on; survey files up to 12 MB), each with the fast check and with `fullCheck` (order alternates by
 *    job), comparing outcome, checks and warnings; time of the whole export and of the
 *    final check (the engine's debug note).
 *  - corpus and generated files only: breakdown on the plain export's bytes: a fresh qpdf instance; copying the file into
 *    the wasm FS; parsing (page count); a structural write without decoding; the full and
 *    the fast check; the other verify steps (is-encrypted, PDF.js re-open).
 *  - raw check of both exports, full vs fast (same output?).
 */
import fs from 'node:fs';
import type { Engine, ExportOptions, PageRef, Source } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { checkIsClean, FAST_CHECK_PRELUDE } from '../../src/lib/engine/final-check';
import { inspectWithPdfjs } from '../../src/lib/engine/pdfjs';
import type { QpdfResult } from '../../src/lib/engine/qpdf';
import { loadPdfjs, nodeAssets, qpdf } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';
import { agree } from './agree';

export interface FastJob {
	id: string;
	path: string;
	kind: 'corpus' | 'generated' | 'survey';
	source: string;
	half: 'tune' | 'held';
	/** Alternate which engine exports first. */
	fullFirst: boolean;
	/** Skip the exports (raw check comparison only). */
	rawOnly?: boolean;
	password?: string;
}

export interface RawCompare {
	full: { code: number; clean: boolean; ms: number; first?: string };
	fast: { code: number; clean: boolean; ms: number; prelude?: number };
	same: boolean;
}

export interface ExportRun {
	status: 'ok' | 'error';
	code?: string;
	message?: string;
	ms: number;
	/** Final structure check: mode and time (debug note). */
	check?: string;
	checkMs?: number;
	bytes?: number;
	/** name:ok:detail of every check, warnings. */
	checks?: string;
	warnings?: string;
}

export interface FastResult {
	id: string;
	path: string;
	kind: FastJob['kind'];
	source: string;
	half: FastJob['half'];
	size: number;
	pages?: number;
	raw?: RawCompare;
	open?: 'ok' | 'error';
	openMessage?: string;
	openMs?: number;
	plain?: { fast: ExportRun; full: ExportRun; agree: boolean };
	optimized?: { fast: ExportRun; full: ExportRun; agree: boolean };
	breakdown?: Record<string, number>;
	exportRaw?: { plain?: RawCompare; optimized?: RawCompare };
	ms: number;
}

const notes: string[] = [];
let fastEngine: Engine | null = null;
let fullEngine: Engine | null = null;
const engines = () => {
	fastEngine ??= createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n) });
	fullEngine ??= createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n), fullCheck: true });
	return { fast: fastEngine, full: fullEngine };
};

const now = () => performance.now();
/** Survey files above this get the plain export pair only. */
const OPTIMIZED_MAX = 12e6;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
	const t = now();
	const r = await fn();
	return [r, Math.round(now() - t)];
}

const checkArgs = (password?: string) => [...(password ? [`--password=${password}`] : []), '--check', '--show-npages', '/v.pdf'];

export async function rawCompare(bytes: Uint8Array, password?: string): Promise<RawCompare> {
	const q = qpdf();
	const [a, ta] = await timed(() => q.run({ args: checkArgs(password), inputs: { '/v.pdf': bytes } }));
	const [b, tb] = await timed(() => q.run({ args: checkArgs(password), inputs: { '/v.pdf': bytes }, prelude: FAST_CHECK_PRELUDE }));
	const first = (r: QpdfResult) => (r.stderr.split('\n').find((l) => l.trim()) ?? '').slice(0, 200);
	return {
		full: { code: a.code, clean: checkIsClean(a), ms: ta, ...(checkIsClean(a) ? {} : { first: first(a) }) },
		fast: { code: b.code, clean: checkIsClean(b), ms: tb, prelude: b.prelude },
		same: b.prelude === 0 && a.code === b.code && a.stdout === b.stdout && a.stderr === b.stderr
	};
}

async function exportOnce(e: Engine, src: Source, options: Partial<ExportOptions>): Promise<{ run: ExportRun; bytes?: Uint8Array }> {
	notes.length = 0;
	const pages: PageRef[] = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] }));
	const t = now();
	try {
		const res = await e.exportPlan({ pages, options: { filename: 'out.pdf', compress: false, stripMetadata: false, ...options } }, [src], []);
		const run: ExportRun = {
			status: 'ok',
			ms: Math.round(now() - t),
			bytes: res.bytes.length,
			checks: res.checks.map((c) => `${c.name}:${c.ok}:${c.detail}`).join(' | '),
			warnings: res.warnings.join(' | ')
		};
		noteCheck(run);
		return { run, bytes: res.bytes };
	} catch (err) {
		const run: ExportRun = {
			status: 'error',
			code: err instanceof EngineError ? err.code : 'exception',
			message: (err instanceof Error ? err.message : String(err)).slice(0, 300),
			ms: Math.round(now() - t)
		};
		const checks = (err as { checks?: { name: string; ok: boolean; detail: string }[] }).checks;
		if (checks) run.checks = checks.map((c) => `${c.name}:${c.ok}:${c.detail}`).join(' | ');
		noteCheck(run);
		return { run };
	}
}

function noteCheck(run: ExportRun) {
	// The last final-check note (a compressed export may verify a second, uncompressed file).
	const all = notes.filter((n) => n.startsWith('final-check:'));
	if (!all.length) return;
	run.check = all.map((n) => n.replace(/^final-check: /, '')).join('; ');
	run.checkMs = all.reduce((s, n) => s + [...n.matchAll(/(\d+) ms/g)].reduce((t, m) => t + Number(m[1]), 0), 0);
}


async function pair(src: Source, options: Partial<ExportOptions>, fullFirst: boolean, io: { progress(s: string): void }, label: string) {
	const { fast, full } = engines();
	const out: { fast?: { run: ExportRun; bytes?: Uint8Array }; full?: { run: ExportRun; bytes?: Uint8Array } } = {};
	for (const which of fullFirst ? (['full', 'fast'] as const) : (['fast', 'full'] as const)) {
		io.progress(`${label} ${which}`);
		out[which] = await exportOnce(which === 'fast' ? fast : full, src, options);
	}
	return { fast: out.fast!, full: out.full! };
}

async function seq<T>(n: number, fn: () => Promise<T>): Promise<T[]> {
	const out: T[] = [];
	for (let i = 0; i < n; i++) out.push(await fn());
	return out;
}

async function breakdown(bytes: Uint8Array): Promise<Record<string, number>> {
	const q = qpdf();
	const b: Record<string, number> = {};
	const inputs = { '/v.pdf': bytes };
	// Fresh instance and copy into the wasm FS: the quickest of three (they are short and noisy).
	const best = async (fn: () => Promise<unknown>) => Math.min(...(await seq(3, async () => (await timed(fn))[1])));
	b.instanceMs = await best(() => q.run({ args: ['--version'] }));
	b.copyInMs = Math.max(0, (await best(() => q.run({ args: ['--version'], inputs }))) - b.instanceMs);
	b.parseMs = (await timed(() => q.run({ args: ['--show-npages', '/v.pdf'], inputs })))[1];
	b.writeNoDecodeMs = (await timed(() => q.run({ args: ['--stream-data=preserve', '/v.pdf', '/dev/null'], inputs })))[1];
	b.writeDecodeNoCompressMs = (await timed(() => q.run({ args: ['--decode-level=all', '--compress-streams=n', '/v.pdf', '/dev/null'], inputs })))[1];
	b.fullCheckMs = (await timed(() => q.run({ args: checkArgs(), inputs })))[1];
	b.fastCheckMs = (await timed(() => q.run({ args: checkArgs(), inputs, prelude: FAST_CHECK_PRELUDE })))[1];
	b.isEncryptedMs = (await timed(() => q.run({ args: ['--is-encrypted', '/v.pdf'], inputs })))[1];
	const lib = await loadPdfjs();
	b.pdfjsReopenMs = (await timed(() => inspectWithPdfjs(lib, bytes)))[1];
	return b;
}

serveJobs<FastJob, FastResult>(async (job, io) => {
	const t0 = now();
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	const r: FastResult = { id: job.id, path: job.path, kind: job.kind, source: job.source, half: job.half, size: bytes.length, ms: 0 };
	io.progress('raw');
	r.raw = await rawCompare(bytes, job.password);
	if (!job.rawOnly) {
		io.progress('open');
		const { fast } = engines();
		let src: Source | null = null;
		const [res, ms] = await timed(async () => {
			try {
				return await fast.openPdf(bytes, 'in.pdf', job.password);
			} catch (e) {
				return e as Error;
			}
		});
		r.openMs = ms;
		if (res instanceof Error) {
			r.open = 'error';
			r.openMessage = `${res instanceof EngineError ? res.code : 'exception'}: ${res.message}`.slice(0, 200);
		} else {
			src = res;
			r.open = 'ok';
			r.pages = src.pages.length;
		}
		if (src) {
			const plain = await pair(src, {}, job.fullFirst, io, 'plain');
			r.plain = { fast: plain.fast.run, full: plain.full.run, agree: agree(plain.fast.run, plain.full.run) };
			// The default export too, except for large survey files (time: the box is shared).
			const opt = job.kind === 'survey' && bytes.length > OPTIMIZED_MAX ? null : await pair(src, { compress: true, printCap: true }, !job.fullFirst, io, 'optimized');
			if (opt) r.optimized = { fast: opt.fast.run, full: opt.full.run, agree: agree(opt.fast.run, opt.full.run) };
			// Survey files: the export pairs above already compare the two checks' verdicts; the
			// breakdown and raw comparisons of the exports are for corpus and generated files (time).
			if (job.kind !== 'survey') {
				r.exportRaw = {};
				if (plain.fast.bytes) {
					io.progress('breakdown');
					r.breakdown = await breakdown(plain.fast.bytes);
					r.exportRaw.plain = await rawCompare(plain.fast.bytes);
				}
				if (opt?.fast.bytes) r.exportRaw.optimized = await rawCompare(opt.fast.bytes);
			}
		}
	}
	r.ms = Math.round(now() - t0);
	io.result(r);
});
