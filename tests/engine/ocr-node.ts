/**
 * The OCR backend in Node, for tests and measurements: the same client (ocr/tess.ts),
 * stage and data as the app, with worker threads instead of Web Workers and the core
 * read from node_modules (relaxed-SIMD builds, as desktop Chrome picks).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { Orienter, Reader, type TessPort } from '../../src/lib/engine/ocr/tess';
import type { OcrBackend } from '../../src/lib/engine/ocr/stage';

const here = path.dirname(fileURLToPath(import.meta.url));
const vendor = path.resolve(here, '../../src/lib/engine/vendor/tesseract');
const script = path.join(here, 'ocr-node-worker.cjs');

let data: { eng: Uint8Array; osd: Uint8Array } | null = null;
function load() {
	data ??= {
		eng: new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(vendor, 'eng.traineddata.gz')))),
		osd: new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(vendor, 'osd.traineddata.gz'))))
	};
	return data;
}

export function nodePort(core: string): TessPort {
	const w = new Worker(script, { workerData: { core } });
	let failed = false;
	return {
		post: (m) => w.postMessage(m),
		onMessage: (fn) => void w.on('message', fn),
		onError: (fn) => {
			w.on('error', (e) => {
				failed = true;
				fn(e);
			});
			w.on('exit', (code) => {
				if (!failed && code !== 0) fn(new Error(`OCR worker exited with ${code}`));
			});
		},
		terminate: () => void w.terminate()
	};
}

export interface NodeOcrOptions {
	slots?: number;
	/** Wraps each reader, e.g. to make one fail (tests). */
	wrapReader?: (r: Awaited<ReturnType<OcrBackend['reader']>>) => Awaited<ReturnType<OcrBackend['reader']>>;
}

export function nodeOcr(opts: NodeOcrOptions = {}): () => Promise<OcrBackend> {
	return async () => {
		const { eng, osd } = load();
		return {
			slots: opts.slots ?? 1,
			reader: async () => {
				const r = await Reader.start(nodePort('relaxedsimd-lstm'), '', eng);
				return opts.wrapReader ? opts.wrapReader(r) : r;
			},
			orienter: () => Orienter.start(nodePort('relaxedsimd'), '', osd)
		};
	};
}
