/**
 * The OCR backend in the browser: tesseract.js workers started from the engine
 * worker, every file from our own origin. Imported with `import()` only when an export
 * asks for OCR; the files below are Vite `?url` assets (hashed names under
 * `_app/immutable/`), which the service worker does not precache but keeps on first
 * use (scripts/precache-list.mjs lists them as lazy), so they work offline afterwards.
 *
 *   worker.min.js                tesseract.js's worker script (classic worker)
 *   tesseract-core-*.wasm.js     the core with its wasm inside; one is fetched, chosen
 *                                by the device's WebAssembly features (relaxed SIMD,
 *                                SIMD, plain): an LSTM-only build for reading and a
 *                                legacy build for orientation detection
 *   eng / osd .traineddata.gz    tessdata_fast English and orientation data, gzipped
 *                                (served as they are; unpacked here with fflate)
 *
 * No URL is built by tesseract.js itself: the worker gets `corePath` as a full file
 * URL and the data through its file system (tess.ts), so nothing points at a CDN.
 */

import workerUrl from 'tesseract.js/dist/worker.min.js?url';
import lstmRelaxed from 'tesseract.js-core/tesseract-core-relaxedsimd-lstm.wasm.js?url';
import lstmSimd from 'tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url';
import lstmPlain from 'tesseract.js-core/tesseract-core-lstm.wasm.js?url';
import legacyRelaxed from 'tesseract.js-core/tesseract-core-relaxedsimd.wasm.js?url';
import legacySimd from 'tesseract.js-core/tesseract-core-simd.wasm.js?url';
import legacyPlain from 'tesseract.js-core/tesseract-core.wasm.js?url';
import engUrl from '../vendor/tesseract/eng.traineddata.gz?url';
import osdUrl from '../vendor/tesseract/osd.traineddata.gz?url';
import { gunzipSync } from 'fflate';
import type { OcrBackend } from './stage';
import { Orienter, Reader, type TessPort } from './tess';

// wasm-feature-detect's probes (Apache-2.0), as tesseract.js itself uses them.
const SIMD = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
const RELAXED = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11]);

function valid(bytes: Uint8Array): boolean {
	try {
		return WebAssembly.validate(bytes as Uint8Array<ArrayBuffer>);
	} catch {
		return false;
	}
}

function abs(url: string): string {
	return new URL(url, self.location.href).href;
}

async function data(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
	const bytes = new Uint8Array(await res.arrayBuffer());
	return bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
}

function spawn(): TessPort {
	const w = new Worker(abs(workerUrl), { name: 'pdf-ocr' });
	return {
		post: (m) => w.postMessage(m),
		onMessage: (fn) => w.addEventListener('message', (e: MessageEvent) => fn(e.data)),
		onError: (fn) => {
			w.addEventListener('error', (e: ErrorEvent) => {
				e.preventDefault();
				fn(new Error(e.message || 'The OCR worker stopped.'));
			});
			w.addEventListener('messageerror', () => fn(new Error('The OCR worker sent a message that could not be read.')));
		},
		terminate: () => w.terminate()
	};
}

export async function browserOcr(): Promise<OcrBackend> {
	const relaxed = valid(RELAXED);
	const simd = relaxed || valid(SIMD);
	const lstm = abs(relaxed ? lstmRelaxed : simd ? lstmSimd : lstmPlain);
	const legacy = abs(relaxed ? legacyRelaxed : simd ? legacySimd : legacyPlain);
	const [eng, osd] = await Promise.all([data(engUrl), data(osdUrl)]);
	const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
	return {
		// Two readers on a desktop (the measurement: twice the throughput for +150 MB), one on a small machine.
		slots: cores >= 4 ? 2 : 1,
		reader: () => Reader.start(spawn(), lstm, eng),
		orienter: () => Orienter.start(spawn(), legacy, osd)
	};
}
