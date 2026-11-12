/**
 * tesseract.js in Node for the measurement: local language data only (models/<name>/),
 * the core build chosen explicitly (node-worker.cjs), LSTM engine, automatic page
 * segmentation. Same wasm and data as the browser would load.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import type { OcrWord } from './score';

const here = path.dirname(fileURLToPath(import.meta.url));
export const OCR_DIR = path.resolve(here, '..');
const require = createRequire(path.join(OCR_DIR, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T: any = require('tesseract.js');

/** Models: tessdata_fast, tessdata_best (float, needs a non-relaxed-SIMD core), the int LSTM of tessdata ("best_int", as tesseract.js ships it). */
export const MODELS = ['fast', 'best_int', 'best'] as const;
export type Model = (typeof MODELS)[number];

export function coreFor(model: Model): string {
	// The relaxed-SIMD build of tesseract.js-core 7.0.0 lacks the float dot product: the float model aborts there.
	return model === 'best' ? 'simd-lstm' : 'relaxedsimd-lstm';
}

export interface Ocr {
	words: OcrWord[];
	ms: number;
	meanConf: number;
	/** Deskew angle Tesseract applied (radians; 0 when none). Boxes are already turned back. */
	rot: number;
}

/** Boxes from an image turned by `a` radians about its centre (tesseract.js rotateAuto) back to the image as given. */
export function unturn(words: OcrWord[], a: number, w: number, h: number): OcrWord[] {
	if (!a) return words;
	const cx = w / 2;
	const cy = h / 2;
	const c = Math.cos(-a);
	const s = Math.sin(-a);
	const back = (x: number, y: number) => [c * (x - cx) - s * (y - cy) + cx, s * (x - cx) + c * (y - cy) + cy];
	return words.map((wd) => {
		const pts = [back(wd[1], wd[2]), back(wd[3], wd[2]), back(wd[1], wd[4]), back(wd[3], wd[4])];
		const xs = pts.map((q) => q[0]);
		const ys = pts.map((q) => q[1]);
		return [wd[0], Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), wd[5]];
	});
}

export interface TessWorker {
	recognize(img: Uint8Array, dpi: number, params?: Record<string, string>, opts?: { deskew?: boolean; w?: number; h?: number }): Promise<Ocr>;
	terminate(): Promise<void>;
}

/** Words of a tesseract.js `blocks` result. */
export function wordsOf(blocks: unknown): OcrWord[] {
	const out: OcrWord[] = [];
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	for (const b of (blocks as any[]) ?? [])
		for (const p of b.paragraphs ?? [])
			for (const l of p.lines ?? [])
				for (const w of l.words ?? []) out.push([w.text, w.bbox.x0, w.bbox.y0, w.bbox.x1, w.bbox.y1, Math.round(w.confidence * 10) / 10]);
	return out;
}

export async function tessWorker(model: Model, opts: { core?: string; psm?: string } = {}): Promise<TessWorker> {
	process.env.OCR_CORE = opts.core ?? coreFor(model);
	const w = await T.createWorker('eng', 1, {
		workerPath: path.join(OCR_DIR, 'node-worker.cjs'),
		langPath: path.join(OCR_DIR, 'models', model),
		gzip: false,
		cacheMethod: 'none'
	});
	await w.setParameters({ tessedit_pageseg_mode: opts.psm ?? '3' });
	return {
		async recognize(img, dpi, params = {}, o = {}) {
			const t0 = performance.now();
			const r = await w.recognize(Buffer.from(img), { user_defined_dpi: String(Math.round(dpi)), rotateAuto: !!o.deskew, ...params }, { blocks: true, text: false });
			const rot = r.data.rotateRadians ?? 0;
			const words = rot && o.w && o.h ? unturn(wordsOf(r.data.blocks), rot, o.w, o.h) : wordsOf(r.data.blocks);
			return { words, ms: Math.round(performance.now() - t0), meanConf: r.data.confidence, rot };
		},
		terminate: () => w.terminate()
	};
}
