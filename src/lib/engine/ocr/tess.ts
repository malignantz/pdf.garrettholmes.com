/**
 * A small client for tesseract.js's worker script (tesseract.js 7.0.0, Apache-2.0),
 * speaking its message protocol directly instead of through tesseract.js's own
 * `createWorker`. That keeps every file under our control: the worker script, the
 * core (`corePath`, a `.wasm.js` with the wasm inside) and the language data, which
 * we fetch ourselves and write into the worker's file system, so tesseract.js never
 * builds a URL of its own (its defaults point at jsDelivr). The browser and Node
 * differ only in how a worker is spawned (`TessPort`).
 *
 * Protocol (tesseract.js src/worker-script/index.js): the worker takes
 * `{ workerId, jobId, action, payload }` and answers `{ jobId, action, status, data }`
 * with status 'resolve', 'reject' or 'progress'. Actions used: load (core),
 * FS (writeFile), initialize (language, engine mode), setParameters, recognize, detect.
 *
 * Settings are the measurement's (tools/ocr/lib/tess.ts, chosen on the dev set):
 * LSTM engine, `fast` English model, automatic page segmentation (PSM 3), Tesseract's
 * own deskew (`rotateAuto`), Sauvola binarisation (`thresholding_method` 2), the page
 * rendered at 300 dpi. Orientation and script come from a second worker with the
 * legacy core and `osd.traineddata`.
 */

import type { OcrWord } from './gate';

/** A spawned worker, as either environment provides it. */
export interface TessPort {
	post(message: unknown): void;
	/** Called with every message the worker sends. */
	onMessage(fn: (data: unknown) => void): void;
	/** Called once if the worker dies (an uncaught error in it, or it could not start). */
	onError(fn: (error: unknown) => void): void;
	terminate(): void;
}

/** One OCR line, in pixels of the image as Tesseract saw it (after its deskew). */
export interface OcrLine {
	/** Baseline from (x0, y0) to (x1, y1); null when Tesseract has none. */
	baseline: [number, number, number, number] | null;
	words: OcrWord[];
}

/** What Tesseract read on one page image. */
export interface OcrRead {
	/** Image size, pixels. */
	width: number;
	height: number;
	/**
	 * Deskew Tesseract applied, radians (0 when none): the image was turned by this about
	 * its centre before reading, so lines and boxes are in that turned image.
	 */
	rotate: number;
	lines: OcrLine[];
}

export interface Orientation {
	/** Degrees the page must turn to be upright (0, 90, 180, 270), or null when OSD found too little. */
	angle: number | null;
	script: string | null;
}

export class TessError extends Error {}

let nextWorker = 1;

/** One tesseract.js worker. Every call rejects once the worker has died. */
export class TessWorker {
	private readonly id = `ocr-${nextWorker++}`;
	private job = 1;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> }>();
	private dead: unknown = null;

	constructor(private readonly port: TessPort) {
		port.onMessage((data) => this.receive(data));
		port.onError((e) => this.fail(e ?? new TessError('The OCR worker stopped.')));
	}

	get alive(): boolean {
		return this.dead === null;
	}

	private receive(data: unknown) {
		const d = data as { jobId?: unknown; action?: unknown; status?: unknown; data?: unknown } | null;
		if (!d || typeof d.jobId !== 'string' || typeof d.action !== 'string') return;
		const key = `${d.action}-${d.jobId}`;
		const p = this.pending.get(key);
		if (!p || d.status === 'progress') return;
		this.pending.delete(key);
		if (p.timer) clearTimeout(p.timer);
		if (d.status === 'resolve') p.resolve(d.data);
		else p.reject(new TessError(String(d.data)));
	}

	private fail(e: unknown) {
		if (this.dead !== null) return;
		this.dead = e;
		for (const p of this.pending.values()) {
			if (p.timer) clearTimeout(p.timer);
			p.reject(e instanceof Error ? e : new TessError(String(e)));
		}
		this.pending.clear();
		try {
			this.port.terminate();
		} catch {
			// Already gone.
		}
	}

	/** Sends one job. A job that takes longer than `timeoutMs` kills the worker. */
	call(action: string, payload: unknown, timeoutMs = 0): Promise<unknown> {
		if (this.dead !== null) return Promise.reject(new TessError('The OCR worker stopped.'));
		const jobId = `job-${this.job++}`;
		return new Promise((resolve, reject) => {
			const entry: { resolve: (v: unknown) => void; reject: (e: unknown) => void; timer?: ReturnType<typeof setTimeout> } = { resolve, reject };
			if (timeoutMs > 0) entry.timer = setTimeout(() => this.fail(new TessError(`OCR ${action} took longer than ${timeoutMs} ms.`)), timeoutMs);
			this.pending.set(`${action}-${jobId}`, entry);
			try {
				this.port.post({ workerId: this.id, jobId, action, payload });
			} catch (e) {
				this.fail(e);
			}
		});
	}

	terminate(): void {
		this.fail(new TessError('The OCR worker was stopped.'));
	}
}

/** Start-up budget for a worker (core compile, model load). */
const START_MS = 120_000;
/** Budget for one page; desktop Chrome takes about 5 s (p90 6.4 s). */
export const PAGE_MS = 120_000;

/** A worker with the English `fast` model, ready to read pages. */
export class Reader {
	private constructor(private readonly w: TessWorker) {}

	static async start(port: TessPort, corePath: string, eng: Uint8Array): Promise<Reader> {
		const w = new TessWorker(port);
		try {
			await w.call('load', { options: { lstmOnly: true, corePath, logging: false } }, START_MS);
			// Written where tesseract.js's own loadLanguage puts it (dataPath '.').
			await w.call('FS', { method: 'writeFile', args: ['./eng.traineddata', eng] }, START_MS);
			await w.call('initialize', { langs: 'eng', oem: 1 }, START_MS);
			await w.call('setParameters', { params: { tessedit_pageseg_mode: '3' } }, START_MS);
		} catch (e) {
			w.terminate();
			throw e;
		}
		return new Reader(w);
	}

	get alive(): boolean {
		return this.w.alive;
	}

	/** Reads one page image (PNG) rendered at `dpi`. */
	async read(png: Uint8Array, width: number, height: number, dpi: number): Promise<OcrRead> {
		const data = (await this.w.call(
			'recognize',
			{
				image: png,
				options: { rotateAuto: true, user_defined_dpi: String(Math.round(dpi)), thresholding_method: '2' },
				output: { blocks: true, text: false }
			},
			PAGE_MS
		)) as { blocks?: unknown; rotateRadians?: unknown } | null;
		return parseRead(data, width, height);
	}

	terminate(): void {
		this.w.terminate();
	}
}

/** A worker with the legacy core and `osd.traineddata`, for orientation and script. */
export class Orienter {
	private constructor(private readonly w: TessWorker) {}

	static async start(port: TessPort, corePath: string, osd: Uint8Array): Promise<Orienter> {
		const w = new TessWorker(port);
		try {
			await w.call('load', { options: { lstmOnly: false, corePath, logging: false } }, START_MS);
			await w.call('FS', { method: 'writeFile', args: ['./osd.traineddata', osd] }, START_MS);
			await w.call('initialize', { langs: 'osd', oem: 0 }, START_MS);
		} catch (e) {
			w.terminate();
			throw e;
		}
		return new Orienter(w);
	}

	get alive(): boolean {
		return this.w.alive;
	}

	async detect(png: Uint8Array): Promise<Orientation> {
		const d = (await this.w.call('detect', { image: png }, PAGE_MS)) as { orientation_degrees?: unknown; script?: unknown } | null;
		return {
			angle: typeof d?.orientation_degrees === 'number' ? d.orientation_degrees : null,
			script: typeof d?.script === 'string' ? d.script : null
		};
	}

	terminate(): void {
		this.w.terminate();
	}
}

/** Lines and words of a tesseract.js `blocks` result. */
export function parseRead(data: { blocks?: unknown; rotateRadians?: unknown } | null, width: number, height: number): OcrRead {
	const lines: OcrLine[] = [];
	type B = { x0: number; y0: number; x1: number; y1: number };
	type W = { text?: unknown; confidence?: unknown; bbox?: B };
	type L = { words?: W[]; baseline?: (B & { has_baseline?: boolean }) | null };
	const blocks = Array.isArray(data?.blocks) ? (data!.blocks as { paragraphs?: { lines?: L[] }[] }[]) : [];
	for (const b of blocks)
		for (const p of b.paragraphs ?? [])
			for (const l of p.lines ?? []) {
				const words: OcrWord[] = [];
				for (const w of l.words ?? []) {
					if (typeof w.text !== 'string' || !w.bbox) continue;
					const conf = typeof w.confidence === 'number' ? w.confidence : 0;
					words.push([w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1, Math.round(conf * 10) / 10]);
				}
				if (!words.some((w) => w[0].trim() !== '')) continue;
				const bl = l.baseline;
				lines.push({
					baseline: bl && bl.has_baseline !== false && [bl.x0, bl.y0, bl.x1, bl.y1].every(Number.isFinite) ? [bl.x0, bl.y0, bl.x1, bl.y1] : null,
					words: words.filter((w) => w[0].trim() !== '')
				});
			}
	const rot = typeof data?.rotateRadians === 'number' && Number.isFinite(data.rotateRadians) ? data.rotateRadians : 0;
	return { width, height, rotate: rot, lines };
}
