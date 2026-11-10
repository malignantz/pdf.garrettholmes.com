/**
 * Loads PDF.js and wires every asset it needs from our own origin.
 *
 * This module is only ever reached through a dynamic import() from renderer.ts,
 * so none of it (the library, the asset URL tables) is in the entry bundle.
 *
 * Assets are emitted by Vite as hashed files (`?url&no-inline` stops small ones
 * becoming data: URLs, which a `connect-src 'self'` CSP would block). PDF.js
 * normally fetches them as `<baseUrl><filename>`, which hashed names break, so
 * we give it a BinaryDataFactory that maps filename -> emitted URL instead.
 *
 * Not wired: the CMYK ICC profile (`iccUrl`). PDF.js reads it with a synchronous
 * XHR at `<iccUrl><fixed filename>`, which needs an unhashed directory. Without it
 * PDF.js falls back to its built-in CMYK conversion (slightly different colours
 * for ICC-based CMYK images). Fix later by putting it under static/.
 */

import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline';

const cmapUrls = import.meta.glob('/node_modules/pdfjs-dist/cmaps/*.bcmap', {
	eager: true,
	query: '?url&no-inline',
	import: 'default'
}) as Record<string, string>;

const fontUrls = import.meta.glob('/node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', {
	eager: true,
	query: '?url&no-inline',
	import: 'default'
}) as Record<string, string>;

const wasmUrls = import.meta.glob(
	[
		'/node_modules/pdfjs-dist/wasm/*.wasm',
		'/node_modules/pdfjs-dist/wasm/*_nowasm_fallback.js',
		'!/node_modules/pdfjs-dist/wasm/quickjs-eval.*'
	],
	{ eager: true, query: '?url&no-inline', import: 'default' }
) as Record<string, string>;

function byName(table: Record<string, string>): Map<string, string> {
	const m = new Map<string, string>();
	for (const [path, url] of Object.entries(table)) m.set(path.slice(path.lastIndexOf('/') + 1), url);
	return m;
}

const tables = {
	cMapUrl: byName(cmapUrls),
	standardFontDataUrl: byName(fontUrls),
	wasmUrl: byName(wasmUrls)
} as const;

/** PDF.js calls `new BinaryDataFactory({cMapUrl, ...})` then `.fetch({kind, filename})`. */
class OwnOriginBinaryDataFactory {
	async fetch({ kind, filename }: { kind: keyof typeof tables; filename: string }): Promise<Uint8Array> {
		const url = tables[kind]?.get(filename);
		if (!url) throw new Error(`Unknown PDF.js asset ${kind}/${filename}`);
		const res = await fetch(url);
		if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
		return new Uint8Array(await res.arrayBuffer());
	}
}

export type PdfJs = typeof import('pdfjs-dist');

let pdfjsPromise: Promise<PdfJs> | undefined;

export function loadPdfJs(): Promise<PdfJs> {
	pdfjsPromise ??= import('pdfjs-dist').then((lib) => {
		lib.GlobalWorkerOptions.workerSrc = workerUrl;
		return lib;
	});
	return pdfjsPromise;
}

/** Extra getDocument() options that route all PDF.js asset loads to our origin. */
export const documentAssetOptions = {
	BinaryDataFactory: OwnOriginBinaryDataFactory,
	// Required: with true PDF.js would fetch `<baseUrl><filename>` itself in the worker.
	useWorkerFetch: false
};
