/**
 * MuPDF.js (`mupdf`, AGPL-3.0), the second PDF engine: forms, redaction, image
 * shrinking. About 10 MB of WebAssembly (4.8 MB gzip, 3.6 MB Brotli), so it is
 * loaded by dynamic `import()` the first time a stage needs it: never from the
 * entry bundle, never from the engine worker's own chunk, never at intake.
 *
 * Where the .wasm comes from:
 * - Node (Vitest): the package reads `mupdf-wasm.wasm` next to its own module.
 * - Browser worker: the package locates it with `new URL('mupdf-wasm.wasm',
 *   import.meta.url)`, which Vite rewrites to the hashed asset it emits under
 *   `_app/immutable/workers/assets/`, so it is fetched from our own origin
 *   (CSP `script-src 'wasm-unsafe-eval'` already allows compiling it). The
 *   service worker does not precache it; it is cached on first use
 *   (scripts/precache-list.mjs, src/service-worker/index.ts).
 *
 * API notes for the stage modules: docs/research/2026-11-10-mupdf-api.md.
 */

export type Mupdf = typeof import('mupdf');

let loading: Promise<Mupdf> | null = null;

/** The MuPDF module, loaded once on first use. A failed load is retried on the next call. */
export function mupdf(): Promise<Mupdf> {
	loading ??= import('mupdf').catch((e) => {
		loading = null;
		throw e;
	});
	return loading;
}
