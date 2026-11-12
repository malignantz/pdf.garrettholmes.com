/**
 * tesseract.js with line grouping, for the text-layer prototype. Same setup as
 * ../lib/tess.ts (local models, chosen core, LSTM, automatic segmentation), but the
 * result keeps blocks → paragraphs → lines → words, which the layer writer needs.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { OCR_DIR, coreFor, type Model } from '../lib/tess';

const require = createRequire(path.join(OCR_DIR, 'package.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const T: any = require('tesseract.js');

/** [text, x0, y0, x1, y1, confidence], pixels of the image OCR saw (origin top-left). */
export type LWord = [string, number, number, number, number, number];

export interface OcrLine {
	bbox: [number, number, number, number];
	/** Baseline from (x0,y0) to (x1,y1), pixels; null when Tesseract has none. */
	baseline: [number, number, number, number] | null;
	words: LWord[];
}

export interface OcrPage {
	w: number;
	h: number;
	dpi: number;
	ms: number;
	lines: OcrLine[];
}

export async function lineWorker(model: Model = 'fast') {
	process.env.OCR_CORE = coreFor(model);
	const w = await T.createWorker('eng', 1, {
		workerPath: path.join(OCR_DIR, 'node-worker.cjs'),
		langPath: path.join(OCR_DIR, 'models', model),
		gzip: false,
		cacheMethod: 'none'
	});
	await w.setParameters({ tessedit_pageseg_mode: '3' });
	return {
		async recognize(png: Uint8Array, w0: number, h0: number, dpi: number): Promise<OcrPage> {
			const t0 = performance.now();
			const r = await w.recognize(Buffer.from(png), { user_defined_dpi: String(dpi) }, { blocks: true, text: false });
			const lines: OcrLine[] = [];
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			for (const b of (r.data.blocks as any[]) ?? [])
				for (const p of b.paragraphs ?? [])
					for (const l of p.lines ?? []) {
						const words: LWord[] = (l.words ?? [])
							// eslint-disable-next-line @typescript-eslint/no-explicit-any
							.map((x: any) => [x.text, x.bbox.x0, x.bbox.y0, x.bbox.x1, x.bbox.y1, Math.round(x.confidence * 10) / 10] as LWord)
							.filter((x: LWord) => x[0].trim() !== '');
						if (!words.length) continue;
						const bl = l.baseline;
						lines.push({
							bbox: [l.bbox.x0, l.bbox.y0, l.bbox.x1, l.bbox.y1],
							baseline: bl && bl.has_baseline !== false ? [bl.x0, bl.y0, bl.x1, bl.y1] : null,
							words
						});
					}
			return { w: w0, h: h0, dpi, ms: Math.round(performance.now() - t0), lines };
		},
		terminate: () => w.terminate()
	};
}
