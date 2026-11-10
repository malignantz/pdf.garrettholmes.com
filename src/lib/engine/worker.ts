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
	}
});

serveEngine(self as unknown as DedicatedWorkerGlobalScope, engine);
