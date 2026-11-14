/**
 * The export stage of "Make scanned pages searchable" (ExportOptions.ocr).
 *
 *   readScans   which output pages to try (eligible.ts, at most OCR_CAP in document
 *               order), then per page: render at 300 dpi (MuPDF, grey) → orientation
 *               and script (OSD; only upright Latin pages go on) → OCR (tess.ts) →
 *               the page gate (gate.ts) → drop words under confidence 50. Runs in
 *               OCR workers (`OcrBackend.slots` readers and one orientation worker);
 *               a worker that fails (a wasm trap, a time-out) is replaced and the page
 *               tried once more in the fresh one, then declined; readers are also
 *               replaced every REPLACE_AFTER pages (the measurement saw traps only in
 *               long-lived workers). Progress and cancel come from ExportControl.
 *   addLayers   writes the layers into the assembled file (layer.ts) and checks every
 *               page that got one: rendered pixels identical before and after (MuPDF),
 *               every written word where it was written (MuPDF structured text) and in
 *               the page's text as PDF.js reads it. A page that fails is written again
 *               without its layer; if that does not clear it, no layer is written at all.
 *   verifyTextLayer  the same PDF.js read-back on the final file (a VerifyCheck).
 *
 * A declined page is left exactly as it was: no layer is ever written for it.
 */

import type * as MU from 'mupdf';
import type { ExportControl, OcrReport, PageRef, Rotation, Source, VerifyCheck } from '../../core/types';
import type { EngineDeps } from '../deps';
import { EngineError } from '../errors';
import { rethrowFault, type Mupdf } from '../mupdf';
import type { PdfjsLib } from '../pdfjs';
import { renderAndCompare } from '../shrink';
import { OCR_DPI, scannedPagesOf } from './eligible';
import { WORD_MIN_CONF, gateAccepts, norm, signals, type Signals } from './gate';
import { writeLayers, type LayerPage, type WrittenWord } from './layer';
import type { OcrRead, Orientation } from './tess';

/** Most pages one export tries. */
export const OCR_CAP = 20;
/** A reader is replaced after this many pages. */
export const REPLACE_AFTER = 10;

export interface OcrReader {
	read(png: Uint8Array, width: number, height: number, dpi: number): Promise<OcrRead>;
	terminate(): void;
}
export interface OcrOrienter {
	detect(png: Uint8Array): Promise<Orientation>;
	terminate(): void;
}
/** Where OCR workers come from (the browser: tesseract.js workers; Node: worker threads). */
export interface OcrBackend {
	/** Readers working at once. */
	slots: number;
	reader(): Promise<OcrReader>;
	orienter(): Promise<OcrOrienter>;
}

export type DeclineReason = 'orientation' | 'script' | 'gate' | 'no words' | 'failed';

export type PageOutcome = { ok: true; read: OcrRead; signals: Signals } | { ok: false; why: DeclineReason; signals?: Signals };

/** One page's story, for measurement tools (EngineOptions.ocrTrace); never shown to the user. */
export interface OcrTrace {
	sourceId: string;
	pageIndex: number;
	outcome: PageOutcome;
	/** Everything OCR returned (before the gate and the word filter), when it ran. */
	raw?: OcrRead;
	orientation?: Orientation;
	ms: { render: number; orient: number; read: number };
	attempts: number;
}

export interface ScanJob {
	key: string;
	source: Source;
	pageIndex: number;
}

export interface ScanReading {
	/** Eligible output pages (0-based), in document order. */
	eligible: number[];
	/** Output pages tried (the first OCR_CAP eligible ones). */
	tried: number[];
	/** Outcome per job key (`sourceId:pageIndex`). */
	outcomes: Map<string, PageOutcome>;
}

/** Thrown in a slot that stops because another one failed. */
class Halt extends Error {}

const keyOf = (sourceId: string, pageIndex: number) => `${sourceId}:${pageIndex}`;
const now = () => performance.now();
const cancelled = () => new EngineError('cancelled', 'Export cancelled. Nothing was saved.');

export function throwIfCancelled(control?: ExportControl): void {
	if (control?.signal?.aborted) throw cancelled();
}

/** Eligible pages of every PDF source the export uses, by source id. */
export async function eligiblePages(deps: EngineDeps, pages: PageRef[], byId: Map<string, Source>): Promise<number[]> {
	const perSource = new Map<string, Set<number>>();
	const out: number[] = [];
	for (const [i, ref] of pages.entries()) {
		const src = byId.get(ref.sourceId);
		if (!src || src.kind !== 'pdf') continue;
		// Redaction boxes: OCR of the original picture would put the hidden text back as text.
		if (ref.stamps.some((s) => s.kind === 'redact')) continue;
		let set = perSource.get(src.id);
		if (!set) {
			set = new Set(await scannedPagesOf(deps.qpdf, deps.mupdf, src.bytes, src.pages));
			perSource.set(src.id, set);
		}
		if (set.has(ref.pageIndex)) out.push(i);
	}
	return out;
}

export interface ReadOptions {
	backend: () => Promise<OcrBackend>;
	control?: ExportControl;
	trace?: (t: OcrTrace) => void;
	debug?: (note: string) => void;
}

/** Picks the pages to try and reads them. Throws EngineError 'cancelled' when the signal fires. */
export async function readScans(deps: EngineDeps, pages: PageRef[], byId: Map<string, Source>, opts: ReadOptions): Promise<ScanReading> {
	const { control } = opts;
	throwIfCancelled(control);
	const eligible = await eligiblePages(deps, pages, byId);
	const tried = eligible.slice(0, OCR_CAP);
	const jobs = new Map<string, ScanJob>();
	for (const i of tried) {
		const ref = pages[i];
		const key = keyOf(ref.sourceId, ref.pageIndex);
		if (!jobs.has(key)) jobs.set(key, { key, source: byId.get(ref.sourceId)!, pageIndex: ref.pageIndex });
	}
	const outcomes = new Map<string, PageOutcome>();
	if (!jobs.size) return { eligible, tried, outcomes };

	throwIfCancelled(control);
	control?.onProgress?.({ stage: 'ocr-load' });
	let backend: OcrBackend;
	try {
		backend = await opts.backend();
	} catch (e) {
		opts.debug?.(`ocr: backend did not load: ${String(e)}`);
		throw new EngineError('internal', 'The text reader could not be loaded. Try again, or export without making pages searchable.');
	}
	const m = await deps.mupdf();
	const docs = new Map<string, MU.Document>();
	const workers = new Set<{ terminate(): void }>();
	const own = <T extends { terminate(): void }>(w: T): T => {
		workers.add(w);
		return w;
	};
	const drop = (w: { terminate(): void } | null) => {
		if (!w) return;
		workers.delete(w);
		try {
			w.terminate();
		} catch {
			// Gone.
		}
	};
	const onAbort = () => {
		for (const w of [...workers]) drop(w);
	};
	control?.signal?.addEventListener('abort', onAbort);
	// Set when one slot failed: the others stop at their next step.
	let halted = false;
	const check = () => {
		throwIfCancelled(control);
		if (halted) throw new Halt();
	};

	let orienter: Promise<OcrOrienter> | null = null;
	let orientQueue: Promise<unknown> = Promise.resolve();
	/** Orientation, serialized on the one worker; retried once in a fresh worker. */
	const orient = (png: Uint8Array): Promise<Orientation | null> => {
		const run = async () => {
			for (let attempt = 0; attempt < 2; attempt++) {
				check();
				orienter ??= backend.orienter().then(own);
				let w: OcrOrienter | null = null;
				try {
					w = await orienter;
					return await w.detect(png);
				} catch (e) {
					check();
					opts.debug?.(`ocr: orientation worker failed (${String(e)}); replacing it`);
					drop(w);
					orienter = null;
				}
			}
			return null;
		};
		const p = orientQueue.then(run, run);
		orientQueue = p.catch(() => undefined);
		return p;
	};

	const queue = [...jobs.values()];
	let done = 0;
	const total = jobs.size;
	control?.onProgress?.({ stage: 'ocr', done, total });

	const render = (job: ScanJob): { png: Uint8Array; w: number; h: number } => {
		let doc = docs.get(job.source.id);
		if (!doc) {
			doc = m.Document.openDocument(job.source.bytes, 'application/pdf');
			docs.set(job.source.id, doc);
		}
		const page = doc.loadPage(job.pageIndex);
		try {
			const pix = page.toPixmap(m.Matrix.scale(OCR_DPI / 72, OCR_DPI / 72), m.ColorSpace.DeviceGray, false, false);
			try {
				return { png: pix.asPNG().slice(), w: pix.getWidth(), h: pix.getHeight() };
			} finally {
				pix.destroy();
			}
		} finally {
			page.destroy();
			m.emptyStore();
		}
	};

	const slot = async () => {
		let reader: OcrReader | null = null;
		let used = 0;
		while (queue.length) {
			check();
			const job = queue.shift()!;
			const ms = { render: 0, orient: 0, read: 0 };
			let attempts = 0;
			let raw: OcrRead | undefined;
			let orientation: Orientation | undefined;
			let outcome: PageOutcome;
			let t = now();
			let img: { png: Uint8Array; w: number; h: number } | null = null;
			try {
				img = render(job);
			} catch (e) {
				rethrowFault(e);
				opts.debug?.(`ocr: could not render ${job.key}: ${String(e)}`);
			}
			ms.render = now() - t;
			t = now();
			const o = img ? await orient(img.png) : null;
			ms.orient = now() - t;
			if (!o || !img) outcome = { ok: false, why: 'failed' };
			else {
				orientation = o;
				if (o.angle !== 0) outcome = { ok: false, why: 'orientation' };
				else if (o.script !== 'Latin') outcome = { ok: false, why: 'script' };
				else {
					t = now();
					for (let attempt = 0; attempt < 2 && !raw; attempt++) {
						check();
						attempts++;
						if (reader && used >= REPLACE_AFTER) {
							drop(reader);
							reader = null;
						}
						try {
							if (!reader) {
								reader = own(await backend.reader());
								used = 0;
							}
							used++;
							raw = await reader.read(img.png, img.w, img.h, OCR_DPI);
						} catch (e) {
							check();
							opts.debug?.(`ocr: reader failed on ${job.key} (${String(e)}); replacing it`);
							drop(reader);
							reader = null;
						}
					}
					ms.read = now() - t;
					outcome = raw ? judge(raw) : { ok: false, why: 'failed' };
				}
			}
			outcomes.set(job.key, outcome);
			opts.trace?.({ sourceId: job.source.id, pageIndex: job.pageIndex, outcome, raw, orientation, ms, attempts });
			opts.debug?.(`ocr: page ${job.pageIndex + 1} ${outcome.ok ? 'accepted' : `declined (${outcome.why})`}; render ${Math.round(ms.render)} ms, orientation ${Math.round(ms.orient)} ms, reading ${Math.round(ms.read)} ms`);
			done++;
			check();
			control?.onProgress?.({ stage: 'ocr', done, total });
		}
		drop(reader);
	};

	try {
		const n = Math.max(1, Math.min(backend.slots, total));
		const settled = await Promise.allSettled(
			Array.from({ length: n }, () =>
				slot().catch((e) => {
					halted = true;
					onAbort();
					throw e;
				})
			)
		);
		throwIfCancelled(control);
		const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected' && !(r.reason instanceof Halt));
		if (failure) throw failure.reason;
	} finally {
		control?.signal?.removeEventListener('abort', onAbort);
		onAbort();
		for (const d of docs.values()) d.destroy();
		m.emptyStore();
	}
	return { eligible, tried, outcomes };
}

/** The gate, then the word filter. */
export function judge(raw: OcrRead): PageOutcome {
	const sig = signals(raw.lines.flatMap((l) => l.words));
	if (!gateAccepts(sig)) return { ok: false, why: 'gate', signals: sig };
	const lines = raw.lines.map((l) => ({ ...l, words: l.words.filter((w) => w[5] >= WORD_MIN_CONF) })).filter((l) => l.words.length > 0);
	if (!lines.some((l) => l.words.some((w) => norm(w[0]) !== ''))) return { ok: false, why: 'no words', signals: sig };
	return { ok: true, read: { ...raw, lines }, signals: sig };
}

export interface LayerOutcome {
	bytes: Uint8Array;
	report: OcrReport;
	/** Words written, by output page index (for the final check). */
	written: Map<number, WrittenWord[]>;
}

/** Writes the layers of the pages OCR accepted into the assembled file, checked page by page. */
export async function addLayers(
	deps: EngineDeps,
	bytes: Uint8Array,
	pages: PageRef[],
	reading: ScanReading,
	debug?: (note: string) => void,
	/** The export keeps accessibility tags: the layer is drawn as an artifact (ocr/layer.ts). */
	artifacts = false
): Promise<LayerOutcome> {
	const want: LayerPage[] = [];
	for (const i of reading.tried) {
		const ref = pages[i];
		const o = reading.outcomes.get(keyOf(ref.sourceId, ref.pageIndex));
		if (o?.ok) want.push({ pageIndex: i, userRotation: ref.rotation as Rotation, read: o.read, dpi: OCR_DPI });
	}
	let out = bytes;
	let written = new Map<number, WrittenWord[]>();
	if (want.length) {
		const lib = await deps.pdfLib();
		let todo = want;
		for (let round = 0; round < 2 && todo.length; round++) {
			const r = await writeLayers(lib, bytes, todo, artifacts);
			for (const [p, why] of r.skipped) debug?.(`ocr: page ${p + 1} left without a layer: ${why}`);
			const failed = await checkLayers(deps, bytes, r.bytes, r.written);
			for (const [p, why] of failed) debug?.(`ocr: page ${p + 1} failed its check (${why}); its layer is dropped`);
			if (!failed.size) {
				out = r.bytes;
				written = r.written;
				break;
			}
			todo = todo.filter((p) => r.written.has(p.pageIndex) && !failed.has(p.pageIndex));
		}
	}
	const searchable = [...written.keys()].sort((a, b) => a - b);
	const set = new Set(searchable);
	return {
		bytes: out,
		written,
		report: {
			eligible: reading.eligible.length,
			cap: OCR_CAP,
			searchable: searchable.map((i) => i + 1),
			declined: reading.tried.filter((i) => !set.has(i)).map((i) => i + 1)
		}
	};
}

type Quad = [number, number][];

/** Pages (index → why) whose layer fails a check. */
async function checkLayers(deps: EngineDeps, before: Uint8Array, after: Uint8Array, written: Map<number, WrittenWord[]>): Promise<Map<number, string>> {
	const failed = new Map<number, string>();
	if (!written.size) return failed;
	const m = await deps.mupdf();
	const a = new m.PDFDocument(before);
	const b = new m.PDFDocument(after);
	try {
		for (const [p, words] of written) {
			const px = renderAndCompare(m, a, b, p);
			m.emptyStore();
			if (!px || px.pageMean !== 0 || px.blockMean !== 0) {
				failed.set(p, 'rendered pixels changed');
				continue;
			}
			const misplaced = placeCheck(m, b, p, words);
			if (misplaced) failed.set(p, `${misplaced} word(s) not where they were written`);
		}
	} finally {
		a.destroy();
		b.destroy();
		m.emptyStore();
	}
	const lib = await deps.pdfjs();
	const missing = await readBack(lib, after, written, undefined);
	for (const [p, n] of missing) if (n > 0 && !failed.has(p)) failed.set(p, `${n} word(s) missing from the text PDF.js reads`);
	return failed;
}

/** Written words whose characters MuPDF does not find inside the box they were written in. */
function placeCheck(m: Mupdf, doc: MU.PDFDocument, p: number, words: WrittenWord[]): number {
	const page = doc.loadPage(p);
	try {
		const t = page.getTransform() as number[];
		const toPage = (x: number, y: number): [number, number] => [x * t[0] + y * t[2] + t[4], x * t[1] + y * t[3] + t[5]];
		const chars: { c: string; x: number; y: number }[] = [];
		const st = page.toStructuredText('preserve-whitespace');
		try {
			st.walk({
				onChar(c, _origin, _font, _size, quad) {
					const q = quad as number[];
					chars.push({ c, x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 });
				}
			});
		} finally {
			st.destroy();
		}
		// Characters bucketed by 8 pt rows, in reading order within each.
		const rows = new Map<number, number[]>();
		chars.forEach((ch, i) => {
			const r = Math.floor(ch.y / 8);
			const list = rows.get(r) ?? [];
			list.push(i);
			rows.set(r, list);
		});
		let bad = 0;
		for (const w of words) {
			const want = norm(w.text);
			if (!want) continue;
			const pts = (w.quad as Quad).map(([x, y]) => toPage(x, y));
			const xs = pts.map((q) => q[0]);
			const ys = pts.map((q) => q[1]);
			const h = Math.hypot(pts[0][0] - pts[2][0], pts[0][1] - pts[2][1]);
			const tol = Math.max(1, 0.15 * h);
			const [x0, x1, y0, y1] = [Math.min(...xs) - tol, Math.max(...xs) + tol, Math.min(...ys) - tol, Math.max(...ys) + tol];
			const hits: number[] = [];
			for (let r = Math.floor(y0 / 8); r <= Math.floor(y1 / 8); r++)
				for (const i of rows.get(r) ?? []) {
					const ch = chars[i];
					if (ch.x >= x0 && ch.x <= x1 && ch.y >= y0 && ch.y <= y1) hits.push(i);
				}
			hits.sort((x, y) => x - y);
			if (!norm(hits.map((i) => chars[i].c).join('')).includes(want)) bad++;
		}
		return bad;
	} finally {
		page.destroy();
	}
}

/** Per page, how many written words PDF.js does not read back. */
async function readBack(lib: PdfjsLib, bytes: Uint8Array, written: Map<number, WrittenWord[]>, password: string | undefined): Promise<Map<number, number>> {
	const out = new Map<number, number>();
	const task = lib.getDocument({
		data: bytes.slice(),
		password,
		useWasm: false,
		useWorkerFetch: false,
		useSystemFonts: false,
		disableFontFace: true,
		enableXfa: false,
		verbosity: 0
	});
	try {
		const doc = await task.promise;
		for (const [p, words] of written) {
			const page = await doc.getPage(p + 1);
			const tc = await page.getTextContent();
			const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
			const have = new Map<string, number>();
			for (const tok of text.split(/\s+/)) {
				const k = norm(tok);
				if (k) have.set(k, (have.get(k) ?? 0) + 1);
			}
			let missing = 0;
			for (const w of words) {
				const k = norm(w.text);
				if (!k) continue;
				const c = have.get(k) ?? 0;
				if (c > 0) have.set(k, c - 1);
				else missing++;
			}
			out.set(p, missing);
			page.cleanup();
		}
	} catch {
		for (const p of written.keys()) out.set(p, Infinity);
	} finally {
		await task.destroy().catch(() => undefined);
	}
	return out;
}

/** The final file's check: every layered page reads back with its words in PDF.js. */
export async function verifyTextLayer(lib: PdfjsLib, bytes: Uint8Array, written: Map<number, WrittenWord[]>, password: string | undefined): Promise<VerifyCheck> {
	const missing = await readBack(lib, bytes, written, password);
	const bad = [...missing].filter(([, n]) => n > 0).map(([p]) => p + 1);
	const words = [...written.values()].reduce((s, w) => s + w.length, 0);
	return {
		name: 'text-layer',
		ok: bad.length === 0,
		detail: bad.length === 0
			? `PDF.js reads the ${words} words written on ${written.size} page${written.size === 1 ? '' : 's'}.`
			: `Words written on page${bad.length === 1 ? '' : 's'} ${bad.slice(0, 5).join(', ')} do not read back.`
	};
}
