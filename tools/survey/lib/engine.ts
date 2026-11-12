/**
 * The product's engine core, wired for Node exactly as tests/engine/helpers.ts does
 * (qpdf.wasm from the package, the bundled stamp font, PDF.js with its in-thread worker).
 * This is the same `createCoreEngine` the browser's engine worker runs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createCoreEngine, type EngineAssets } from '../../../src/lib/engine/core';
import type { PdfjsLib } from '../../../src/lib/engine/pdfjs';
import { Qpdf } from '../../../src/lib/engine/qpdf';
import type { Engine } from '../../../src/lib/core/types';
import { repoRoot } from './paths';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');

let pdfjsP: Promise<PdfjsLib> | null = null;
export function loadPdfjs(): Promise<PdfjsLib> {
	pdfjsP ??= (async () => {
		// Importing the worker module installs PDF.js's in-thread ("fake") worker.
		await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
		return import('pdfjs-dist/legacy/build/pdf.mjs');
	})();
	return pdfjsP;
}

let compiled: Promise<WebAssembly.Module> | null = null;
const qpdfLoader = {
	location: wasmPath,
	compile: () => (compiled ??= WebAssembly.compile(fs.readFileSync(wasmPath)))
};

export function nodeAssets(): EngineAssets {
	return {
		qpdf: qpdfLoader,
		font: async () => new Uint8Array(fs.readFileSync(path.join(repoRoot, 'src/lib/engine/fonts/NotoSans-Regular.ttf'))),
		pdfjs: loadPdfjs
	};
}

/** Debug notes the engine wrote (stages that skipped themselves); measurement scripts read and clear it. */
export const debugNotes: string[] = [];

let shared: Engine | null = null;
export function engine(): Engine {
	// SURVEY_LOSSLESS=pack,level9 (a comma list of passes to keep on) is for measuring passes one at a time.
	const env = process.env.SURVEY_LOSSLESS;
	const on = env === undefined ? null : new Set(env.split(',').filter(Boolean));
	const lossless = on ? { pack: on.has('pack'), level9: on.has('level9'), cleanup: on.has('cleanup'), libdeflate: on.has('libdeflate') } : undefined;
	shared ??= createCoreEngine(nodeAssets(), { debug: (n) => debugNotes.push(n), lossless });
	return shared;
}

let qpdfShared: Qpdf | null = null;
/** A standalone qpdf runner (same wasm build) for profiling. */
export function qpdf(): Qpdf {
	qpdfShared ??= new Qpdf(qpdfLoader);
	return qpdfShared;
}
