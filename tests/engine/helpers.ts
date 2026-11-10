import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createCoreEngine, type EngineAssets } from '../../src/lib/engine/core';
import type { PdfjsLib } from '../../src/lib/engine/pdfjs';
import type { Engine, PageRef, Source, Stamp } from '../../src/lib/core/types';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '../..');
export const corpusDir = path.join(root, 'tests/corpus/files');

const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');

let pdfjsP: Promise<PdfjsLib> | null = null;
/** PDF.js with the in-thread ("fake") worker, as Node needs. */
export function loadPdfjs(): Promise<PdfjsLib> {
	pdfjsP ??= (async () => {
		await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
		return import('pdfjs-dist/legacy/build/pdf.mjs');
	})();
	return pdfjsP;
}

export function nodeAssets(): EngineAssets {
	return {
		qpdf: {
			location: wasmPath,
			compile: async () => WebAssembly.compile(fs.readFileSync(wasmPath))
		},
		font: async () => new Uint8Array(fs.readFileSync(path.join(root, 'src/lib/engine/fonts/NotoSans-Regular.ttf'))),
		pdfjs: loadPdfjs
	};
}

let shared: Engine | null = null;
export function engine(): Engine {
	shared ??= createCoreEngine(nodeAssets());
	return shared;
}

export function corpus(name: string): Uint8Array {
	return new Uint8Array(fs.readFileSync(path.join(corpusDir, name)));
}

export const manifest = JSON.parse(fs.readFileSync(path.join(corpusDir, 'manifest.json'), 'utf8')) as Record<
	string,
	Record<string, unknown>
>;

const sourceCache = new Map<string, Promise<Source>>();
export function openCorpus(name: string, password?: string): Promise<Source> {
	const key = `${name}\0${password ?? ''}`;
	let p = sourceCache.get(key);
	if (!p) {
		p = engine().openPdf(corpus(name), name, password);
		sourceCache.set(key, p);
	}
	return p;
}

let n = 0;
export function ref(source: Source, pageIndex: number, rotation: PageRef['rotation'] = 0, stamps: Stamp[] = []): PageRef {
	return { id: `p${n++}`, sourceId: source.id, pageIndex, rotation, stamps };
}

export const defaultOptions = { filename: 'out.pdf', compress: false, stripMetadata: false } as const;

/** Text of each page, joined per page, via PDF.js. */
export async function pageTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, isEvalSupported: false, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const tc = await page.getTextContent();
			out.push(
				tc.items
					.map((it) => ('str' in it ? it.str : ''))
					.join('')
					.trim()
			);
		}
		return out;
	} finally {
		await task.destroy();
	}
}

export async function pageSizes(bytes: Uint8Array, password?: string) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), password, isEvalSupported: false, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: { width: number; height: number; rotate: number; view: number[] }[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const vp = page.getViewport({ scale: 1 });
			out.push({ width: vp.width, height: vp.height, rotate: page.rotate, view: [...page.view] });
		}
		return out;
	} finally {
		await task.destroy();
	}
}

/** Deterministic PRNG (mulberry32). */
export function prng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
