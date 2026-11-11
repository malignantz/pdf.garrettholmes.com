/**
 * Child process for `run`: opens one file with the real engine and runs the
 * scenarios through Engine.exportPlan as the app would, then checks each output
 * independently (poppler, MuPDF renders, PDF.js form read-back).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import type { Engine, ExportOptions, ExportPlan, ExportResult, FormValue, PageRef, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { shortError, tool } from './lib/common';
import { engine, loadPdfjs } from './lib/engine';
import { serveJobs } from './lib/pool';
import {
	INK_LUMA,
	MIN_DIFF_PIXELS,
	LOSSY_MEAN_SUSPECT,
	SUSPECT_FRACTION,
	WRONG_FRACTION,
	compare,
	openDoc,
	renderPage,
	renderScale,
	writePng,
	type Diff,
	type Raster,
	type Region
} from './lib/raster';
import { prng } from './lib/sampler';

export const SCENARIOS = ['open', 'plain', 'arrange', 'stamps', 'protect', 'redact', 'forms', 'forms-flat', 'target'] as const;
export type Scenario = (typeof SCENARIOS)[number];

export type Outcome = 'verified' | 'refused' | 'crashed' | 'wrong' | 'suspect' | 'needs-password' | 'skipped';

export interface RunJob {
	sha256: string;
	path: string;
	size: number;
	scenarios: Scenario[];
	/** Profile says the file has images (scenario "target" runs only then). */
	hasImages: boolean;
	out: string;
	knownGood: string;
	/** The open row was already written by an earlier (crashed) child. */
	reopen?: boolean;
}

export interface RunResult {
	sha256: string;
	path: string;
	scenario: Scenario;
	outcome: Outcome;
	ms: number;
	/** Peak resident memory of the child process so far, MB. */
	peakMB: number;
	/** EngineError code (refused, crashed internal) or crash kind (timeout, oom, exit, exception). */
	code?: string;
	message?: string;
	/** Failed VerifyCheck names (verification-failed) or independent-check details. */
	detail?: string;
	/** Files written for a human to look at. */
	evidence?: string[];
	warnings?: string[];
	notes?: string[];
}

/** Text drawn by the stamps scenario; fixed so its region can be excluded from the pixel check. */
const STAMP_TEXT = 'Survey stamp';
const STAMP_TEXT_POS = { x: 0.06, y: 0.04, size: 0.025 };
const CHECK_BOX: StampBox = { x: 0.82, y: 0.04, w: 0.06, h: 0.06 };
const HIGHLIGHT_BOX: StampBox = { x: 0.06, y: 0.88, w: 0.4, h: 0.04 };
const NUMBER_SIZE = 10;
const FORM_TEXT = 'Survey 42';
const PASSWORD = 'survey-pw-1';
/** Margin added around excluded regions, as a fraction of the page. */
const MARGIN = 0.015;
/** A highlight/mark/redaction box counts as visible when at least this share of its pixels changed. */
const VISIBLE_FRACTION = 0.3;
/** Fewer light pixels than this under a must-change region: not judged (noted). */
const MIN_LIGHT_PIXELS = 6;
/** A redaction box counts as black when its mean luminance is below this. */
const BLACK_LUMA = 60;

serveJobs<RunJob, RunResult>(async (job, io) => {
	await runFile(job, io);
});

let n = 0;
const ref = (source: Source, pageIndex: number, rotation: PageRef['rotation'] = 0, stamps: Stamp[] = []): PageRef => ({
	id: `p${n++}`,
	sourceId: source.id,
	pageIndex,
	rotation,
	stamps
});

const peakMB = () => Math.round(process.resourceUsage().maxRSS / 1024);

async function runFile(job: RunJob, io: { progress(s: string): void; result(r: RunResult): void }) {
	const eng = engine();
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	const name = path.basename(job.path);
	const emit = (scenario: Scenario, r: Omit<RunResult, 'sha256' | 'path' | 'scenario' | 'peakMB'>) =>
		io.result({ sha256: job.sha256, path: job.path, scenario, peakMB: peakMB(), ...r });

	// After a crash the file is opened again for the remaining scenarios; a second crash
	// while opening is charged to the first of them.
	io.progress(job.reopen ? job.scenarios[0] : 'open');
	let t0 = Date.now();
	let src: Source;
	try {
		src = await eng.openPdf(bytes, name);
	} catch (e) {
		const c = classify(e);
		const ms = Date.now() - t0;
		if (c.code === 'password-required') {
			for (const s of job.scenarios) emit(s, { outcome: 'needs-password', ms: s === 'open' ? ms : 0, code: c.code, message: c.message });
			return;
		}
		if (!job.reopen && job.scenarios.includes('open')) emit('open', { ...c, ms });
		for (const s of job.scenarios) if (s !== 'open') emit(s, { outcome: 'skipped', ms: 0, message: 'The file did not open.' });
		return;
	}
	const openMs = Date.now() - t0;
	const tmp = path.join(job.out, 'tmp');
	fs.mkdirSync(tmp, { recursive: true });
	const ctx: Ctx = { job, eng, src, bytes, tmp, rand: prng(parseInt(job.sha256.slice(0, 8), 16)) };

	if (job.scenarios.includes('open') && !job.reopen) {
		const r = await checkOpen(ctx);
		emit('open', { ...r, ms: openMs, notes: src.notes });
	}
	for (const s of job.scenarios) {
		if (s === 'open') continue;
		io.progress(s);
		t0 = Date.now();
		let r: Partial<RunResult>;
		try {
			r = await SCENARIO_FNS[s](ctx);
		} catch (e) {
			r = classify(e);
		}
		emit(s, { outcome: 'crashed', ...r, ms: Date.now() - t0 } as RunResult);
	}
	for (const f of fs.readdirSync(tmp)) if (f.startsWith(job.sha256.slice(0, 16))) fs.rmSync(path.join(tmp, f), { force: true });
}

interface Ctx {
	job: RunJob;
	eng: Engine;
	src: Source;
	bytes: Uint8Array;
	tmp: string;
	rand: () => number;
}

type Partial2 = Partial<RunResult> & { outcome: Outcome };

/** EngineError → refused (or crashed for 'internal'); anything else → crashed. */
function classify(e: unknown): Partial2 {
	if (e instanceof EngineError) {
		const failed = e.checks?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`.slice(0, 200));
		const cause = (e as { cause?: unknown }).cause;
		if (e.code === 'internal') {
			return { outcome: 'crashed', code: 'internal', message: e.message, detail: cause !== undefined ? shortError(cause, 400) : undefined };
		}
		if (e.code === 'password-required') return { outcome: 'needs-password', code: e.code, message: e.message };
		return { outcome: 'refused', code: e.code, message: e.message, detail: failed?.join(' | ') };
	}
	return { outcome: 'crashed', code: 'exception', message: shortError(e, 400) };
}

const SCENARIO_FNS: Record<Exclude<Scenario, 'open'>, (c: Ctx) => Promise<Partial2>> = {
	plain: plainScenario,
	arrange: arrangeScenario,
	stamps: stampsScenario,
	protect: protectScenario,
	redact: redactScenario,
	forms: (c) => formsScenario(c, false),
	'forms-flat': (c) => formsScenario(c, true),
	target: targetScenario
};

const baseOptions: ExportOptions = { filename: 'out.pdf', compress: false, stripMetadata: false };

async function exportPlan(c: Ctx, plan: ExportPlan, extraSources: Source[] = []): Promise<ExportResult> {
	return c.eng.exportPlan(plan, [c.src, ...extraSources], []);
}

const allPages = (c: Ctx) => c.src.pages.map((_, i) => ref(c.src, i));

// --- independent checks ------------------------------------------------------

interface Problem {
	/** 'note': a check that could not judge this file; recorded, not counted. */
	level: 'wrong' | 'suspect' | 'note';
	text: string;
}

/** Output re-opened by poppler and MuPDF with the expected page count. */
async function reopenChecks(c: Ctx, out: Uint8Array, expectedPages: number, scenario: string, password?: string): Promise<{ problems: Problem[]; file: string }> {
	const file = path.join(c.tmp, `${c.job.sha256.slice(0, 16)}-${scenario}.pdf`);
	fs.writeFileSync(file, out);
	const problems: Problem[] = [];
	const info = await tool('pdfinfo', [...(password ? ['-upw', password] : []), file], 60_000);
	const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
	if (info.code !== 0) problems.push({ level: 'wrong', text: `poppler could not open the output: ${info.timedOut ? 'timeout' : firstLine(info.stderr)}` });
	else if (pages !== expectedPages) problems.push({ level: 'wrong', text: `poppler counts ${pages} pages, expected ${expectedPages}` });
	try {
		const doc = openDoc(mupdf, out, password);
		const count = doc.countPages();
		doc.destroy();
		if (count !== expectedPages) problems.push({ level: 'wrong', text: `MuPDF counts ${count} pages, expected ${expectedPages}` });
	} catch (e) {
		// A WebAssembly fault ("memory access out of bounds") is MuPDF's own state in this
		// process, often left by an earlier stage, not proof the output is bad.
		const wasmFault = e instanceof Error && /RuntimeError|memory access out of bounds|unreachable/i.test(`${e.name} ${e.message}`);
		problems.push({ level: wasmFault ? 'suspect' : 'wrong', text: `MuPDF could not open the output: ${shortError(e, 150)}` });
	}
	return { problems, file };
}

function firstLine(s: string) {
	return (s.split('\n').find((l) => l.trim()) ?? 'failed').slice(0, 200);
}

/**
 * Renders input page `i` from the original bytes and from the engine's normalized copy
 * (`norm`; null when it renders the same as the original) and output page `j`, at one scale.
 * When MuPDF cannot render the original, `before` is the normalized copy.
 */
function renderPair(c: Ctx, out: Uint8Array, i: number, j: number, password?: string): { before: Raster; after: Raster; norm: Raster | null } {
	const size = c.src.pages[i];
	const scale = renderScale(size.width, size.height);
	const render = (bytes: Uint8Array) => {
		const d = openDoc(mupdf, bytes);
		try {
			return renderPage(mupdf, d, i, scale);
		} finally {
			d.destroy();
		}
	};
	const norm = render(c.src.bytes);
	let before: Raster;
	try {
		before = render(c.bytes);
	} catch {
		before = norm;
	}
	const d2 = openDoc(mupdf, out, password);
	try {
		const same = before === norm || (() => {
			const d = compare(before, norm);
			return d.sameSize && d.fraction <= SUSPECT_FRACTION;
		})();
		return { before, after: renderPage(mupdf, d2, j, scale), norm: same ? null : norm };
	} finally {
		d2.destroy();
	}
}

/** Pixels darker than the ink threshold. */
function inkPixels(r: Raster): number {
	let n = 0;
	for (let k = 0; k < r.px.length; k += 3) if (0.299 * r.px[k] + 0.587 * r.px[k + 1] + 0.114 * r.px[k + 2] < INK_LUMA) n++;
	return n;
}

function saveEvidence(c: Ctx, scenario: string, label: string, pair: { before: Raster; after: Raster }, diff: Diff | null, pdf?: string): string[] {
	const dir = path.join(c.job.out, 'suspects', c.job.sha256.slice(0, 16));
	fs.mkdirSync(dir, { recursive: true });
	const base = path.join(dir, `${scenario}-${label}`);
	writePng(`${base}-before.png`, pair.before);
	writePng(`${base}-after.png`, pair.after);
	const files = [`${base}-before.png`, `${base}-after.png`];
	if (diff) {
		writePng(`${base}-diff.png`, diff.diff);
		files.push(`${base}-diff.png`);
	}
	if (pdf && fs.existsSync(pdf)) {
		const keep = path.join(dir, `${scenario}-output.pdf`);
		fs.copyFileSync(pdf, keep);
		files.push(keep);
	}
	return files;
}

function judge(problems: Problem[], evidence: string[] = [], extra: Partial2 = { outcome: 'verified' }): Partial2 {
	const notes = problems.filter((p) => p.level === 'note').map((p) => p.text);
	if (notes.length) extra = { ...extra, notes: [...(extra.notes ?? []), ...notes] };
	const wrong = problems.filter((p) => p.level === 'wrong');
	const suspect = problems.filter((p) => p.level === 'suspect');
	if (wrong.length) return { ...extra, outcome: 'wrong', detail: [...wrong, ...suspect].map((p) => p.text).join(' | '), evidence };
	if (suspect.length) return { ...extra, outcome: 'suspect', detail: suspect.map((p) => p.text).join(' | '), evidence };
	return { ...extra, outcome: 'verified', evidence: undefined };
}

/** Pixel check of output page j against input page i; `allowed` regions may differ. */
function pixelCheck(
	c: Ctx,
	scenario: string,
	out: Uint8Array,
	i: number,
	j: number,
	file: string,
	opts: { allowed?: Region[]; mustChange?: Region[]; mustBeBlack?: Region[]; lossy?: boolean; password?: string; softer?: boolean } = {}
): { problems: Problem[]; evidence: string[] } {
	const problems: Problem[] = [];
	let pair;
	try {
		pair = renderPair(c, out, i, j, opts.password);
	} catch (e) {
		return { problems: [{ level: 'suspect', text: `could not render page ${i + 1} for comparison: ${shortError(e, 120)}` }], evidence: [] };
	}
	const inside = [...(opts.mustChange ?? []), ...(opts.mustBeBlack ?? [])];
	const where = `page ${i + 1}→${j + 1}`;
	if (pair.norm && inkPixels(pair.before) < MIN_DIFF_PIXELS) {
		// MuPDF draws the original blank but the engine's opened copy is not (e.g. qpdf decrypts a
		// file MuPDF cannot): there is no independent "before"; compare with the opened copy.
		problems.push({ level: 'suspect', text: `${where}: MuPDF renders the original blank; compared with the engine's opened copy` });
		pair.before = pair.norm;
	}
	const d = compare(pair.before, pair.after, opts.allowed ?? [], inside);
	if (!d.sameSize) {
		problems.push({ level: 'wrong', text: `${where}: rendered size ${pair.before.w}×${pair.before.h} became ${pair.after.w}×${pair.after.h}` });
	} else if (opts.lossy) {
		if (d.mean > LOSSY_MEAN_SUSPECT) problems.push({ level: 'suspect', text: `${where}: mean pixel difference ${d.mean.toFixed(1)} after shrinking` });
	} else if (d.fraction > WRONG_FRACTION) {
		problems.push({ level: opts.softer ? 'suspect' : 'wrong', text: `${where}: ${(d.fraction * 100).toFixed(2)}% of inked pixels differ outside the edited areas` });
	} else if (d.fraction > SUSPECT_FRACTION) {
		problems.push({ level: 'suspect', text: `${where}: ${(d.fraction * 100).toFixed(2)}% of inked pixels differ outside the edited areas` });
	}
	(opts.mustChange ?? []).forEach((r, k) => {
		const pxW = (r.x1 - r.x0) * pair.before.w;
		const pxH = (r.y1 - r.y0) * pair.before.h;
		if (pxW < 3 || pxH < 3) {
			problems.push({ level: 'note', text: `${where}: edit ${k + 1} not checked (${pxW.toFixed(1)}×${pxH.toFixed(1)} px at this resolution)` });
			return;
		}
		// Judged on the pixels that were light before: a multiply highlight cannot show
		// over dark content, and a region of a few pixels says nothing.
		if (d.insideLight[k] < MIN_LIGHT_PIXELS) {
			problems.push({ level: 'note', text: `${where}: edit ${k + 1} not checked (only ${d.insideLight[k]} light pixels under it)` });
		} else if (d.insideLightFractions[k] < VISIBLE_FRACTION) {
			problems.push({ level: 'suspect', text: `${where}: edit ${k + 1} barely visible (${(d.insideLightFractions[k] * 100).toFixed(0)}% of light pixels changed)` });
		}
	});
	const off = (opts.mustChange ?? []).length;
	(opts.mustBeBlack ?? []).forEach((_, k) => {
		const luma = d.insideLuma[off + k];
		if (luma > BLACK_LUMA) problems.push({ level: 'wrong', text: `${where}: redaction box not black (mean luminance ${luma.toFixed(0)})` });
	});
	const evidence = problems.length ? saveEvidence(c, scenario, `p${i + 1}`, pair, d, file) : [];
	return { problems, evidence };
}

// --- scenarios ---------------------------------------------------------------

async function checkOpen(c: Ctx): Promise<Partial2> {
	const info = await tool('pdfinfo', [c.job.path], 60_000);
	const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
	const extra = { message: c.src.hasForm ? `${c.src.pages.length} pages, has form` : `${c.src.pages.length} pages` };
	if (info.code === 0 && pages !== c.src.pages.length) {
		return { outcome: 'suspect', detail: `poppler counts ${pages} pages in the original, the engine ${c.src.pages.length}`, ...extra };
	}
	return { outcome: 'verified', ...extra };
}

async function plainScenario(c: Ctx): Promise<Partial2> {
	const res = await exportPlan(c, { pages: allPages(c), options: { ...baseOptions, compress: true } });
	const n = c.src.pages.length;
	const { problems, file } = await reopenChecks(c, res.bytes, n, 'plain');
	const evidence: string[] = [];
	const pagesToCheck = [...new Set([0, Math.floor(c.rand() * n)])];
	for (const i of pagesToCheck) {
		const r = pixelCheck(c, 'plain', res.bytes, i, i, file, { softer: c.src.hasForm });
		problems.push(...r.problems);
		evidence.push(...r.evidence);
	}
	return judge(problems, evidence, { outcome: 'verified', warnings: res.warnings });
}

async function arrangeScenario(c: Ctx): Promise<Partial2> {
	const good = await c.eng.openPdf(new Uint8Array(fs.readFileSync(c.job.knownGood)), 'known-good.pdf');
	const n = c.src.pages.length;
	const order = c.src.pages.map((_, i) => n - 1 - i);
	const deleted = n >= 2 ? order.splice(Math.floor(n / 2), 1)[0] : -1;
	const pages = order.map((i, k) => ref(c.src, i, k === 0 ? 90 : 0));
	pages.push(ref(c.src, 0)); // duplicate of the first source page, unrotated
	pages.push(ref(good, 0), ref(good, Math.min(1, good.pages.length - 1)));
	const res = await exportPlan(c, { pages, options: { ...baseOptions, compress: true } }, [good]);
	const { problems, file } = await reopenChecks(c, res.bytes, pages.length, 'arrange');
	// Independent page sizes: MuPDF's size of each output page against MuPDF's size of the
	// source page it shows (rotated as planned). The plan's sizes come from PDF.js; on pages
	// with degenerate boxes the two readers disagree about the original already.
	try {
		const doc = openDoc(mupdf, res.bytes);
		const srcDoc = (() => {
			try {
				const d = openDoc(mupdf, c.bytes);
				if (d.countPages() === c.src.pages.length) return d;
				d.destroy();
			} catch {
				// MuPDF cannot read the original: use the engine's opened copy.
			}
			return openDoc(mupdf, c.src.bytes);
		})();
		const goodDoc = openDoc(mupdf, good.bytes);
		const bad: string[] = [];
		pages.forEach((p, k) => {
			if (k >= doc.countPages()) return;
			const sb = (p.sourceId === good.id ? goodDoc : srcDoc).loadPage(p.pageIndex).getBounds();
			const s = { width: sb[2] - sb[0], height: sb[3] - sb[1] };
			const [w, h] = p.rotation % 180 ? [s.height, s.width] : [s.width, s.height];
			const b = doc.loadPage(k).getBounds();
			if (Math.abs(b[2] - b[0] - w) > 1 || Math.abs(b[3] - b[1] - h) > 1) bad.push(`page ${k + 1}: ${(b[2] - b[0]).toFixed(1)}×${(b[3] - b[1]).toFixed(1)}, planned ${w.toFixed(1)}×${h.toFixed(1)}`);
		});
		doc.destroy();
		srcDoc.destroy();
		goodDoc.destroy();
		if (bad.length) problems.push({ level: 'wrong', text: `MuPDF page sizes differ from the source pages: ${bad.slice(0, 3).join('; ')}` });
	} catch (e) {
		problems.push({ level: 'suspect', text: `MuPDF size check failed: ${shortError(e, 120)}` });
	}
	// The duplicate of page 1 must look like page 1.
	const r = pixelCheck(c, 'arrange', res.bytes, 0, order.length, file, { softer: c.src.hasForm });
	return judge([...problems, ...r.problems], r.evidence, { outcome: 'verified', warnings: res.warnings, message: deleted >= 0 ? undefined : 'single page: nothing deleted' });
}

function textRegion(page: { width: number; height: number }): Region {
	const { x, y, size } = STAMP_TEXT_POS;
	const w = (STAMP_TEXT.length * size * 0.7 * page.height) / page.width;
	return { x0: x - MARGIN, y0: y - MARGIN, x1: x + w + MARGIN, y1: y + size * 1.5 + MARGIN };
}
const boxRegion = (b: StampBox, m = MARGIN): Region => ({ x0: b.x - m, y0: b.y - m, x1: b.x + b.w + m, y1: b.y + b.h + m });
const innerRegion = (b: StampBox): Region => ({ x0: b.x + b.w * 0.2, y0: b.y + b.h * 0.2, x1: b.x + b.w * 0.8, y1: b.y + b.h * 0.8 });

function numberRegion(page: { width: number; height: number }): Region {
	const h = Math.max(0.12, (36 + NUMBER_SIZE * 3) / page.height);
	const w = Math.max(0.25, 80 / page.width);
	return { x0: 0.5 - w, y0: 1 - h, x1: 0.5 + w, y1: 1 };
}

async function stampsScenario(c: Ctx): Promise<Partial2> {
	const n = c.src.pages.length;
	const stamps = (): Stamp[] => [
		{ id: 't', kind: 'text', text: STAMP_TEXT, ...STAMP_TEXT_POS, color: 'black' },
		{ id: 'm', kind: 'mark', mark: 'check', box: CHECK_BOX },
		{ id: 'h', kind: 'highlight', color: 'yellow', box: HIGHLIGHT_BOX }
	];
	const pages = c.src.pages.map((_, i) => ref(c.src, i, 0, i === 0 || i === n - 1 ? stamps() : []));
	const res = await exportPlan(c, {
		pages,
		options: { ...baseOptions, numbering: { style: 'page-n-of-total', position: 'bottom-center', start: 1, skip: 0, size: NUMBER_SIZE } }
	});
	const { problems, file } = await reopenChecks(c, res.bytes, n, 'stamps');
	const evidence: string[] = [];
	for (const i of [...new Set([0, n - 1])]) {
		const page = c.src.pages[i];
		const allowed = [textRegion(page), boxRegion(CHECK_BOX), boxRegion(HIGHLIGHT_BOX), numberRegion(page)];
		const r = pixelCheck(c, 'stamps', res.bytes, i, i, file, { allowed, mustChange: [innerRegion(HIGHLIGHT_BOX)], softer: c.src.hasForm });
		problems.push(...r.problems);
		evidence.push(...r.evidence);
		// Page number read back by poppler, in content-stream order (-raw): the label is
		// drawn last as one string, and layout order would interleave it with page text
		// that shares its baseline.
		const t = await tool('pdftotext', ['-raw', '-f', String(i + 1), '-l', String(i + 1), '-enc', 'UTF-8', file, '-'], 60_000);
		const label = `Page ${i + 1} of ${n}`;
		if (/Failed to create page/.test(t.stderr)) {
			problems.push({ level: 'note', text: `poppler cannot build page ${i + 1}; page number not checked` });
		} else if (t.code === 0 && !squash(t.stdout).includes(squash(label))) {
			problems.push({ level: 'suspect', text: `poppler does not find "${label}" on page ${i + 1}` });
		}
	}
	return judge(problems, evidence, { outcome: 'verified', warnings: res.warnings });
}

const squash = (s: string) => s.replace(/\s+/g, '');

async function protectScenario(c: Ctx): Promise<Partial2> {
	const res = await exportPlan(c, { pages: allPages(c), options: { ...baseOptions, password: PASSWORD, stripMetadata: true } });
	const n = c.src.pages.length;
	const { problems, file } = await reopenChecks(c, res.bytes, n, 'protect', PASSWORD);
	const locked = await tool('pdfinfo', [file], 60_000);
	if (locked.code === 0) problems.push({ level: 'wrong', text: 'poppler opens the output without the password' });
	const info = await tool('pdfinfo', ['-upw', PASSWORD, file], 60_000);
	if (info.code === 0) {
		const enc = /^Encrypted:\s+(.*)$/m.exec(info.stdout)?.[1] ?? '';
		const algo = /algorithm:(\S+)/.exec(enc)?.[1];
		if (!/^yes/.test(enc)) problems.push({ level: 'wrong', text: `poppler says Encrypted: ${enc}` });
		else if (algo && algo.replace(/\)$/, '') !== 'AES-256') problems.push({ level: 'wrong', text: `poppler says the algorithm is ${algo}` });
		for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
			const v = new RegExp(`^${k}:\\s+(.*)$`, 'm').exec(info.stdout)?.[1];
			if (v) problems.push({ level: 'wrong', text: `metadata left after stripping: ${k} = ${v.slice(0, 60)}` });
		}
		const meta = await tool('pdfinfo', ['-upw', PASSWORD, '-meta', file], 60_000);
		if (meta.code === 0 && meta.stdout.trim()) problems.push({ level: 'wrong', text: 'XMP metadata left after stripping' });
	}
	return judge(problems, [], { outcome: 'verified', warnings: res.warnings });
}

interface Line {
	text: string;
	box: StampBox;
}

/** First line of text on page 1 with at least three letters or digits, from MuPDF's text extraction. */
function firstTextLine(c: Ctx): Line | null {
	const doc = openDoc(mupdf, c.src.bytes);
	try {
		const page = doc.loadPage(0);
		const b = page.getBounds();
		const W = b[2] - b[0];
		const H = b[3] - b[1];
		const st = JSON.parse(page.toStructuredText('preserve-whitespace').asJSON()) as {
			blocks: { type: string; lines?: { text: string; bbox: { x: number; y: number; w: number; h: number } }[] }[];
		};
		for (const block of st.blocks ?? []) {
			for (const line of block.lines ?? []) {
				const alnum = line.text.replace(/[^\p{L}\p{N}]/gu, '');
				const bb = line.bbox;
				if (alnum.length < 3 || bb.w < 2 || bb.h < 2) continue;
				const pad = 1;
				const x0 = Math.max(0, (bb.x - b[0] - pad) / W);
				const y0 = Math.max(0, (bb.y - b[1] - pad) / H);
				const x1 = Math.min(1, (bb.x - b[0] + bb.w + pad) / W);
				const y1 = Math.min(1, (bb.y - b[1] + bb.h + pad) / H);
				if (x1 - x0 <= 0.001 || y1 - y0 <= 0.001) continue;
				return { text: line.text, box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
			}
		}
		return null;
	} finally {
		doc.destroy();
	}
}

/** Words poppler extracts from page 1 whose centre lies inside `box` (shrunk a little), in displayed-page fractions. */
export async function popplerWordsIn(file: string, box: StampBox, password?: string): Promise<string[] | null> {
	const pw = password ? ['-upw', password] : [];
	const [txt, info] = await Promise.all([
		tool('pdftotext', [...pw, '-cropbox', '-bbox', '-f', '1', '-l', '1', file, '-'], 60_000),
		tool('pdfinfo', [...pw, '-f', '1', '-l', '1', file], 60_000)
	]);
	if (txt.code !== 0 || info.code !== 0) return null;
	const rot = Number(/^Page\s+1 rot:\s+(\d+)/m.exec(info.stdout)?.[1] ?? 0) % 180 !== 0;
	const pm = /<page width="([\d.]+)" height="([\d.]+)"/.exec(txt.stdout);
	if (!pm) return null;
	const [pw0, ph0] = [Number(pm[1]), Number(pm[2])];
	const [W, H] = rot ? [ph0, pw0] : [pw0, ph0];
	// Shrink the box by a fifth of its thinner side (in points) so neighbouring lines that
	// merely touch it are not counted; along the line the words stay inside.
	const s = 0.2 * Math.min(box.w * W, box.h * H);
	const shrinkX = s / W;
	const shrinkY = s / H;
	const words: string[] = [];
	for (const m of txt.stdout.matchAll(/<word xMin="([\d.-]+)" yMin="([\d.-]+)" xMax="([\d.-]+)" yMax="([\d.-]+)">([^<]*)<\/word>/g)) {
		const cx = (Number(m[1]) + Number(m[3])) / 2 / W;
		const cy = (Number(m[2]) + Number(m[4])) / 2 / H;
		if (cx >= box.x + shrinkX && cx <= box.x + box.w - shrinkX && cy >= box.y + shrinkY && cy <= box.y + box.h - shrinkY) {
			const w = m[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
			if (/[\p{L}\p{N}]/u.test(w)) words.push(w);
		}
	}
	return words;
}

async function redactScenario(c: Ctx): Promise<Partial2> {
	const line = firstTextLine(c);
	if (!line) return { outcome: 'skipped', message: 'No text line found on page 1.' };
	const pages = allPages(c);
	pages[0].stamps = [{ id: 'r', kind: 'redact', box: line.box }];
	const res = await exportPlan(c, { pages, options: baseOptions });
	const { problems, file } = await reopenChecks(c, res.bytes, pages.length, 'redact');
	// Independent text check with poppler: nothing readable left in the box.
	const srcFile = path.join(c.tmp, `${c.job.sha256.slice(0, 16)}-src.pdf`);
	fs.writeFileSync(srcFile, c.src.bytes);
	const before = await popplerWordsIn(srcFile, line.box);
	const after = await popplerWordsIn(file, line.box);
	let note = `line "${line.text.trim().slice(0, 40)}"`;
	if (after === null) problems.push({ level: 'suspect', text: 'poppler could not extract text from the output page 1' });
	else if (after.length) problems.push({ level: 'wrong', text: `poppler still reads ${after.length} word(s) under the box: ${after.slice(0, 5).join(' ').slice(0, 80)}` });
	if (before !== null && before.length === 0) note += '; poppler saw no words in the box on the input either (text check vacuous)';
	const r = pixelCheck(c, 'redact', res.bytes, 0, 0, file, {
		allowed: [boxRegion(line.box, 0.01)],
		mustBeBlack: [innerRegion(line.box)],
		softer: true // flattening forms and redacting overlapping images may legitimately change nearby pixels
	});
	return judge([...problems, ...r.problems], r.evidence, { outcome: 'verified', message: note, warnings: res.warnings });
}

/** Field names or labels that ask for a number (dates, amounts, codes). */
const NUMERIC = /date|year|\byr\b|month|\bmo\b|day|\bdd\b|\bmm\b|yyyy|zip|postal|phone|tel|fax|ssn|social security|\bno\b|\bno\.|number|num\b|#|amount|\$|total|qty|quantity|count|age\b|percent|%|code|digit|routing|account|ein|tin\b/i;

/**
 * An answer a person could type into this text field: digits for number-like fields, and no
 * longer than the box shows at the form's usual 10-12 pt (or its MaxLen), down to 2-3
 * characters for small boxes. (One fixed string for every field made most refusals mean
 * "the survey typed too much".)
 */
function textAnswer(c: Ctx, f: { name: string; label?: string; maxLength?: number; multiline?: boolean; widgets: { pageIndex: number; box: StampBox }[] }): string {
	const numeric = NUMERIC.test(`${f.name} ${f.label ?? ''}`);
	const full = numeric ? '4242424242' : FORM_TEXT;
	// Narrowest visible widget, in points.
	let width = Infinity;
	let height = Infinity;
	for (const w of f.widgets) {
		const page = c.src.pages[w.pageIndex];
		if (!page) continue;
		width = Math.min(width, w.box.w * page.width);
		height = Math.min(height, w.box.h * page.height);
	}
	let fit = full.length;
	if (Number.isFinite(width)) {
		const size = f.multiline ? 10 : Math.min(12, Math.max(6, height * 0.7));
		const lines = f.multiline ? Math.max(1, Math.floor((height - 2) / (size * 1.2))) : 1;
		fit = Math.floor((width - 4) / (size * 0.6)) * lines;
	}
	if (f.maxLength) fit = Math.min(fit, f.maxLength);
	fit = Math.max(1, Math.min(fit, full.length));
	if (fit >= full.length) return full;
	if (numeric) return full.slice(0, fit);
	return fit >= 3 ? 'S42'.slice(0, fit) : 'S4'.slice(0, fit);
}

async function formsScenario(c: Ctx, flatten: boolean): Promise<Partial2> {
	if (!c.src.hasForm) return { outcome: 'skipped', message: 'No fillable form.' };
	const fields = await c.eng.formFields(c.src);
	const values: Record<string, FormValue> = {};
	for (const f of fields) {
		if (f.readOnly) continue;
		if (f.kind === 'text') values[f.name] = textAnswer(c, f);
		else if (f.kind === 'checkbox') values[f.name] = true;
		else if (f.kind === 'radio') {
			const opt = f.widgets.find((w) => w.option)?.option;
			if (opt) values[f.name] = opt;
		} else if (f.kind === 'choice' && f.options?.length && !f.multiSelect) values[f.name] = [f.options[0].value];
	}
	if (Object.keys(values).length === 0) return { outcome: 'skipped', message: `No editable fields (${fields.length} listed).` };
	const res = await exportPlan(c, { pages: allPages(c), options: { ...baseOptions, flattenForms: flatten }, formValues: { [c.src.id]: values } });
	const scenario = flatten ? 'forms-flat' : 'forms';
	const { problems, file } = await reopenChecks(c, res.bytes, c.src.pages.length, scenario);
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: res.bytes.slice(), verbosity: 0, useWasm: false, useSystemFonts: false, disableFontFace: true });
	try {
		const doc = await task.promise;
		if (!flatten) {
			// PDF.js 6 returns a Map (older versions a plain object).
			const raw = (await doc.getFieldObjects()) as unknown;
			const byName = (raw instanceof Map ? Object.fromEntries(raw) : (raw ?? {})) as Record<string, { value?: unknown }[]>;
			// The assemble step copies a field with widgets on several pages once per page and
			// renames the copies ("name+1"); every copy must hold the answer.
			const objs: Record<string, { value?: unknown }[]> = {};
			for (const [k, v] of Object.entries(byName)) (objs[k.replace(/\+\d+(?=\.|$)/g, '')] ??= []).push(...v);
			let missing = 0;
			const mismatches: string[] = [];
			for (const [name, want] of Object.entries(values)) {
				const got = objs[name];
				if (!got?.length) {
					missing++;
					continue;
				}
				// Parent (container) fields are listed too, with a null value.
				const all = got.map((g) => g.value);
				const vals = all.some((v) => v !== null && v !== undefined) ? all.filter((v) => v !== null && v !== undefined) : all;
				const ok =
					typeof want === 'string'
						? vals.every((v) => v === want || (Array.isArray(v) && v.includes(want)))
						: want === true
							? vals.every((v) => typeof v === 'string' && v !== 'Off' && v !== '')
							: Array.isArray(want) && vals.every((v) => v === want[0] || (Array.isArray(v) && v.includes(want[0])));
				if (!ok) mismatches.push(`${name}: wanted ${JSON.stringify(want)}, PDF.js reads ${JSON.stringify(vals.slice(0, 3)).slice(0, 60)}`);
			}
			if (mismatches.length) problems.push({ level: 'wrong', text: `${mismatches.length} field(s) read back differently: ${mismatches.slice(0, 3).join('; ')}` });
			if (missing) problems.push({ level: 'suspect', text: `${missing} answered field(s) not found by name in PDF.js` });
		} else {
			let widgets = 0;
			for (let i = 1; i <= doc.numPages; i++) {
				const annots = await (await doc.getPage(i)).getAnnotations();
				widgets += annots.filter((a: { subtype?: string }) => a.subtype === 'Widget').length;
			}
			if (widgets) problems.push({ level: 'wrong', text: `${widgets} form widget(s) left after flattening` });
			const longText = fields.find((f) => f.kind === 'text' && String(values[f.name] ?? '').length >= 6);
			const long = longText ? (values[longText.name] as string) : undefined;
			if (long) {
				const t = await tool('pdftotext', ['-enc', 'UTF-8', file, '-'], 60_000);
				if (t.code === 0 && !squash(t.stdout).includes(squash(long))) {
					problems.push({ level: 'wrong', text: `poppler does not find the flattened answer "${long}" anywhere` });
				}
			}
		}
	} finally {
		await task.destroy().catch(() => undefined);
	}
	return judge(problems, [], { outcome: 'verified', message: `${Object.keys(values).length} of ${fields.length} fields answered`, warnings: res.warnings });
}

async function targetScenario(c: Ctx): Promise<Partial2> {
	if (!c.job.hasImages) return { outcome: 'skipped', message: 'No images.' };
	const target = Math.max(20_000, Math.floor(c.src.originalSize / 2));
	const res = await exportPlan(c, { pages: allPages(c), options: { ...baseOptions, targetBytes: target } });
	const { problems, file } = await reopenChecks(c, res.bytes, c.src.pages.length, 'target');
	const r = pixelCheck(c, 'target', res.bytes, 0, 0, file, { lossy: true });
	const s = res.shrink;
	const message = s ? `target ${target}, got ${res.bytes.length} (${s.reached ? 'reached' : 'not reached'}), ${s.imagesChanged} images at ${s.dpi} dpi` : undefined;
	return judge([...problems, ...r.problems], r.evidence, { outcome: 'verified', message, warnings: res.warnings });
}
