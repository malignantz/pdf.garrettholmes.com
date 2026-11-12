/// <reference lib="webworker" />
/**
 * Web Worker entry. Every engine file is served from our own origin: qpdf.wasm, the
 * stamp font and PDF.js's worker come in as Vite `?url` assets; MuPDF's wasm is
 * emitted by Vite from the package's own `new URL(..., import.meta.url)` (see
 * mupdf.ts). PDF.js runs in a nested worker of its own (importing its worker
 * module here would make it take over this worker's message port).
 */

import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import pdfjsWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import fontUrl from './fonts/NotoSans-Regular.ttf?url';
import { createCoreEngine } from './core';
import { serveEngine } from './host';
import { discardMupdf, isWasmFault, mupdfRestartNeeded } from './mupdf';
import { TAG, type EngineRestart } from './protocol';

async function fetchBytes(url: string): Promise<Uint8Array> {
	const res = await fetch(url);
	if (!res.ok) throw new Error(`Could not load ${url}: ${res.status}`);
	return new Uint8Array(await res.arrayBuffer());
}

const engine = createCoreEngine({
	qpdf: {
		location: qpdfWasmUrl,
		compile: async () => {
			try {
				return await WebAssembly.compileStreaming(fetch(qpdfWasmUrl));
			} catch {
				// Served without application/wasm: compile from bytes instead.
				return WebAssembly.compile((await fetchBytes(qpdfWasmUrl)) as Uint8Array<ArrayBuffer>);
			}
		}
	},
	font: () => fetchBytes(fontUrl),
	pdfjs: async () => {
		const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
		lib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
		return lib;
	},
	// MuPDF's wasm is on the device once the service worker has kept it in its 'lazy'
	// cache (src/service-worker/index.ts, LAZY); then compressing may use it more readily.
	mupdfCached: async () => {
		if (typeof caches === 'undefined' || !(await caches.has('lazy'))) return false;
		const keys = await (await caches.open('lazy')).keys();
		return keys.some((r) => /\/mupdf-wasm[-.][^/]*\.wasm$/.test(new URL(r.url).pathname));
	}
}, {
	// Stages that skip themselves ("avoid, don't fail") leave a note for anyone debugging.
	debug: (note) => console.debug('[engine]', note)
});

serveEngine(self as unknown as DedicatedWorkerGlobalScope, engine, { restartNeeded: mupdfRestartNeeded });

// A MuPDF trap outside any call (inside a finalizer, which no try/catch sees): this
// worker's MuPDF is not trusted again. Ask for a replacement instead of dying; the
// client re-sends what this worker had not answered.
self.addEventListener('error', (event: ErrorEvent) => {
	if (!isWasmFault(event.error)) return;
	event.preventDefault();
	discardMupdf();
	self.postMessage({ tag: TAG, restart: true } satisfies EngineRestart);
});
