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
 * Faults. MuPDF runs inside one long-lived WebAssembly instance (the package keeps
 * it in a module-level variable). After a wasm trap ("memory access out of bounds",
 * "null function or function signature mismatch", "unreachable") its heap can no
 * longer be trusted, so the instance is never used again:
 * - `isWasmFault(e)` recognises a trap; `discardMupdf()` retires the current
 *   instance. core.ts does both for every call and turns the trap into a plain
 *   refusal; stage code that catches errors lets traps through (`rethrowFault`).
 * - In Node (tests, the survey) the next `mupdf()` evaluates a fresh copy of the
 *   package (the same file under a new module URL, so a new wasm instance).
 * - In the browser a bundled module cannot be evaluated twice, so the engine
 *   worker is replaced instead: host.ts sees `mupdfRestartNeeded()` after its
 *   reply and asks the client for a new worker (client.ts).
 *
 * mupdf.js 1.28.6 bugs worked around: the device callback `fillShade` wraps a
 * borrowed shade without keeping it, so the wrapper's finalizer frees a shade
 * MuPDF still owns; that corrupted the heap and surfaced later, inside a
 * finalizer, as a trap no try/catch can see (the stages call `disown`). And
 * reading from `PDFObject.Null` threw (`patch`).
 *
 * API notes for the stage modules: docs/research/2026-11-10-mupdf-api.md.
 */

import { EngineError } from './errors';

export type Mupdf = typeof import('mupdf');

let loading: Promise<Mupdf> | null = null;
let current: Mupdf | null = null;
let instances = 0;
let restart = false;
const retired = new WeakSet<object>();

const isNode = typeof process !== 'undefined' && typeof process.versions?.node === 'string';

/** The MuPDF module, loaded on first use (and anew after a fault). A failed load is retried on the next call. */
export function mupdf(): Promise<Mupdf> {
	loading ??= load().then(
		(m) => {
			current = m;
			return m;
		},
		(e) => {
			loading = null;
			throw e;
		}
	);
	return loading;
}

async function load(): Promise<Mupdf> {
	return patch(await loadModule());
}

async function loadModule(): Promise<Mupdf> {
	const n = instances++;
	if (n === 0) return import('mupdf');
	// The browser worker is replaced after a fault, so only Node gets here.
	if (!isNode) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
	// A fresh evaluation of the package: same file, new module URL, new wasm instance.
	const nodeModule = 'node:module';
	const nodeUrl = 'node:url';
	const { createRequire } = (await import(/* @vite-ignore */ nodeModule)) as typeof import('node:module');
	const { pathToFileURL } = (await import(/* @vite-ignore */ nodeUrl)) as typeof import('node:url');
	const file = createRequire(import.meta.url).resolve('mupdf');
	return (await import(/* @vite-ignore */ `${pathToFileURL(file).href}?instance=${n}`)) as Mupdf;
}

/**
 * `PDFObject.Null` (what `get` returns for a missing key, and what an array holds
 * for a `null` entry) has no document, so `get`/`resolve` on it threw a TypeError
 * ("reading '_fromPDFObjectKeep'") instead of returning null as MuPDF's C API does.
 * Give it a stand-in so reads of a null yield null; writes to it still throw.
 */
function patch(m: Mupdf): Mupdf {
	const Null = m.PDFObject.Null as unknown as { _doc: unknown };
	if (!Null._doc) {
		Null._doc = {
			_fromPDFObjectKeep: () => m.PDFObject.Null,
			_fromPDFObjectNew: () => m.PDFObject.Null,
			_toPDFObject: () => {
				throw new TypeError('cannot write into a null PDF object');
			}
		};
	}
	return m;
}

/** True when MuPDF is loaded in this realm already (using it costs no download or compile). */
export function mupdfLoaded(): boolean {
	return current !== null;
}

/** True for a WebAssembly trap (from any realm), as opposed to an error MuPDF reported. */
export function isWasmFault(e: unknown): boolean {
	if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return true;
	const err = e as { name?: unknown; message?: unknown } | null;
	if (!err || typeof err !== 'object') return false;
	return (
		err.name === 'RuntimeError' &&
		/memory access out of bounds|null function|signature mismatch|unreachable|table index|divide by zero|integer overflow|call stack/i.test(
			String(err.message)
		)
	);
}

/** Throws `e` again when it is a wasm trap (for catch blocks that would otherwise turn it into a soft result). */
export function rethrowFault(e: unknown): void {
	if (isWasmFault(e)) throw e;
}

/**
 * Retires the current MuPDF instance after a trap: it is never handed out again.
 * The next `mupdf()` loads a new one (Node), or the worker is replaced (browser).
 */
export function discardMupdf(): void {
	if (current) retired.add(current);
	if (loading || current) restart = true;
	current = null;
	loading = null;
}

/** True when `m` was retired by a fault (for a stage that was still using it). */
export function isRetired(m: Mupdf): boolean {
	return retired.has(m);
}

/** True once an instance was discarded where no new one can be loaded (the browser worker). */
export function mupdfRestartNeeded(): boolean {
	return restart && !isNode;
}

/**
 * For a wrapper mupdf.js created around a pointer it borrowed without taking a
 * reference: stop its finalizer from releasing what it never owned. The object
 * may only be used during the callback that received it.
 */
export function disown(o: unknown): void {
	const ctor = (o as { constructor?: { _finalizer?: FinalizationRegistry<unknown> } } | null)?.constructor;
	ctor?._finalizer?.unregister(o as object);
}
