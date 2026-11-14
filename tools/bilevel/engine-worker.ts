/**
 * Child process for tools/bilevel/engine-run.ts: one file per job through the real engine
 * (Engine.exportPlan, the app's own options), with "Make scanned pages black and white" on.
 * Survey files and the notice are only read; synthetic jobs build their scan in memory
 * (synth.ts). Nothing is written next to the inputs or into the repo.
 *
 * Variants (each a full export, verified by the engine or refused):
 *   base      Optimize on (the app's default, with the print-size cap), switch off: the size to beat
 *   alone     the switch on, Optimize off
 *   optimize  the switch on with Optimize (the app's default)
 *   ocr       the switch on with Optimize and "Make scanned pages searchable" (scanned pages ≤ 20)
 */
import fs from 'node:fs';
import type { ExportOptions, ExportResult, PageRef, Source } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { nodeOcr } from '../../tests/engine/ocr-node';
import { nodeAssets } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';
import { synthScan } from './synth';

export interface EngineJob {
	id: string;
	path: string;
	kind: 'notice' | 'survey' | 'synth';
	source: string;
	page?: number;
	seed?: number;
	/** Most pages exported (the first ones). */
	maxPages: number;
	variants: Variant[];
}

export type Variant = 'base' | 'alone' | 'optimize' | 'ocr';

export interface VariantRun {
	variant: Variant;
	status: 'ok' | 'error';
	code?: string;
	message?: string;
	ms: number;
	bytes?: number;
	bilevel?: ExportResult['bilevel'];
	ocr?: { searchable: number; declined: number };
	/** Every check's name and ok. */
	checks?: string;
	/** The engine's debug notes about the black and white stage (rebuilds after a failed check). */
	notes?: string[];
}

export interface EngineResult {
	id: string;
	path: string;
	kind: EngineJob['kind'];
	source: string;
	size: number;
	pages: number;
	bilevelPages?: number;
	runs: VariantRun[];
	message?: string;
}

const notes: string[] = [];
const plainEngine = createCoreEngine(nodeAssets(), { debug: (n) => notes.push(n) });
let ocrEngine: ReturnType<typeof createCoreEngine> | null = null;

serveJobs<EngineJob, EngineResult>(async (job, io) => {
	let bytes: Uint8Array = new Uint8Array(fs.readFileSync(job.path));
	const r: EngineResult = { id: job.id, path: job.path, kind: job.kind, source: job.source, size: bytes.length, pages: 0, runs: [] };
	if (job.kind === 'synth') {
		const s = await synthScan(await mupdf(), bytes, job.page ?? 0, job.seed ?? 1);
		if (!s) {
			r.message = 'page not usable for a synthetic scan';
			io.result(r);
			return;
		}
		bytes = s.pdf;
		r.size = bytes.length;
	}
	let src: Source;
	try {
		src = await plainEngine.openPdf(bytes, 'input.pdf');
	} catch (e) {
		r.message = e instanceof Error ? e.message.slice(0, 160) : String(e);
		io.result(r);
		return;
	}
	const pages: PageRef[] = src.pages.slice(0, job.maxPages).map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] }));
	r.pages = pages.length;
	io.progress('pages');
	const candidates = (await plainEngine.bilevelPages(src)).filter((i) => i < pages.length);
	r.bilevelPages = candidates.length;
	for (const variant of job.variants) {
		if (variant === 'ocr' && (candidates.length === 0 || candidates.length > 20)) continue;
		io.progress(variant);
		const options: ExportOptions = { filename: 'out.pdf', compress: variant !== 'alone', stripMetadata: false };
		if (variant !== 'alone') options.printCap = true;
		if (variant !== 'base') options.bilevel = true;
		if (variant === 'ocr') options.ocr = true;
		const eng = variant === 'ocr' ? (ocrEngine ??= createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots: 1 }) }, { debug: (n) => notes.push(n) })) : plainEngine;
		notes.length = 0;
		const t = performance.now();
		const run: VariantRun = { variant, status: 'ok', ms: 0 };
		try {
			const res = await eng.exportPlan({ pages, options }, [src], [], {});
			run.bytes = res.bytes.length;
			run.bilevel = res.bilevel;
			if (res.ocr) run.ocr = { searchable: res.ocr.searchable.length, declined: res.ocr.declined.length };
			run.checks = res.checks.map((c) => `${c.name}:${c.ok ? 'ok' : 'FAIL'}`).join(' ');
		} catch (e) {
			run.status = 'error';
			run.code = e instanceof EngineError ? e.code : 'thrown';
			run.message = e instanceof Error ? e.message.slice(0, 200) : String(e);
		}
		run.ms = Math.round(performance.now() - t);
		run.notes = notes.filter((n) => /bilevel/.test(n)).map((n) => n.slice(0, 200));
		r.runs.push(run);
	}
	io.result(r);
});
