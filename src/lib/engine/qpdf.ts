/**
 * qpdf (WebAssembly, CLI interface) runner.
 *
 * Findings that shape this file (qpdf 12.2.0 in @neslinesli93/qpdf-wasm 0.3.1):
 * - An instance survives repeated `callMain` calls, but qpdf keeps static state
 *   between runs (e.g. its default logger: running `--json` after a run that wrote to
 *   stdout fails with "called setSave on standard output after standard output has
 *   already been used"). So every run gets a fresh instance.
 * - The build has no `instantiateWasm`/`wasmBinary`/`print` hooks. Re-instantiation
 *   is made cheap by compiling the WebAssembly.Module once and substituting it while
 *   the factory runs (see `withCachedModule`); a fresh instance then costs ~4 ms.
 *   Output is captured by calling `FS.init` with our own stdout/stderr callbacks in `preRun`.
 * - In Node the Emscripten exit handler writes `process.exitCode`; we restore it.
 */

import { EngineError, isOutOfMemory } from './errors';

interface EmscriptenFS {
	init(input: () => number | null, output: (c: number | null) => void, error: (c: number | null) => void): void;
	mkdir(path: string): void;
	writeFile(path: string, data: Uint8Array): void;
	readFile(path: string): Uint8Array;
	unlink(path: string): void;
	readdir(path: string): string[];
}

interface QpdfInstance {
	callMain(args: string[]): number;
	FS: EmscriptenFS;
}

interface FactoryArgs {
	locateFile: (name: string, prefix: string) => string;
	noInitialRun: boolean;
	thisProgram: string;
	preRun: Array<(m: QpdfInstance) => void>;
}

type QpdfFactory = (args: FactoryArgs) => Promise<QpdfInstance>;

export interface QpdfRunOptions {
	args: string[];
	/** Files to place in the virtual FS before the run (copied; the caller's buffers are untouched). */
	inputs?: Record<string, Uint8Array>;
	/** Files to read back after the run (missing ones are omitted). */
	outputs?: string[];
	/**
	 * Folders created empty before the run; every file qpdf writes into one is read
	 * back after it (for `--json-stream-data=file`, whose file names are not known in advance).
	 */
	outputDirs?: string[];
}

export interface QpdfResult {
	code: number;
	stdout: string;
	stderr: string;
	files: Map<string, Uint8Array>;
}

export interface QpdfLoader {
	/** Compiled qpdf.wasm. Called once; the result is cached. */
	compile(): Promise<WebAssembly.Module>;
	/**
	 * Path or URL the Emscripten loader reads. It still fetches (browser) or reads (Node)
	 * this file on each instantiation, but its bytes are ignored in favour of the cached
	 * module; in the browser this is an HTTP-cache hit.
	 */
	location: string;
}

/** Exit codes documented by qpdf. */
export const QPDF_OK = 0;
export const QPDF_ERROR = 2;
export const QPDF_WARNINGS = 3;

type WA = {
	instantiate: (src: unknown, imports?: unknown) => Promise<unknown>;
	instantiateStreaming?: (src: unknown, imports?: unknown) => Promise<unknown>;
};

export class Qpdf {
	#loader: QpdfLoader;
	#module: Promise<WebAssembly.Module> | null = null;
	#factory: Promise<QpdfFactory> | null = null;
	#lock: Promise<unknown> = Promise.resolve();

	constructor(loader: QpdfLoader) {
		this.#loader = loader;
	}

	#getModule(): Promise<WebAssembly.Module> {
		this.#module ??= this.#loader.compile().catch((e) => {
			this.#module = null;
			throw e;
		});
		return this.#module;
	}

	#getFactory(): Promise<QpdfFactory> {
		this.#factory ??= import('@neslinesli93/qpdf-wasm').then((m) => {
			const mod = m as unknown as { default?: unknown };
			const f = (typeof mod.default === 'function' ? mod.default : m) as unknown;
			if (typeof f !== 'function') throw new Error('qpdf factory not found');
			return f as QpdfFactory;
		});
		return this.#factory;
	}

	/** Runs one qpdf command line in a fresh instance. Runs are serialized. */
	run(options: QpdfRunOptions): Promise<QpdfResult> {
		const next = this.#lock.then(() => this.#runNow(options));
		this.#lock = next.catch(() => undefined);
		return next;
	}

	async #runNow({ args, inputs = {}, outputs = [], outputDirs = [] }: QpdfRunOptions): Promise<QpdfResult> {
		const [module, factory] = await Promise.all([this.#getModule(), this.#getFactory()]);
		const out: number[] = [];
		const err: number[] = [];
		const qpdf = await withCachedModule(module, this.#loader.location, () =>
			factory({
				locateFile: () => this.#loader.location,
				noInitialRun: true,
				thisProgram: 'qpdf',
				preRun: [
					(m) => {
						m.FS.init(
							() => null,
							(c) => {
								if (c !== null) out.push(c);
							},
							(c) => {
								if (c !== null) err.push(c);
							}
						);
					}
				]
			})
		);

		const proc = (globalThis as { process?: { exitCode?: number | string } }).process;
		const savedExitCode = proc?.exitCode;
		const written: string[] = [];
		try {
			for (const [path, data] of Object.entries(inputs)) {
				ensureDirs(qpdf.FS, path);
				// MEMFS copies the bytes (this build's minifier renamed the `canOwn` option).
				qpdf.FS.writeFile(path, data);
				written.push(path);
			}
			for (const path of outputs) ensureDirs(qpdf.FS, path);
			for (const dir of outputDirs) ensureDirs(qpdf.FS, `${dir}/x`);
			let code: number;
			try {
				code = qpdf.callMain([...args]);
			} catch (e) {
				if (isOutOfMemory(e)) {
					throw new EngineError('too-large', 'This file is too large to process on this device.');
				}
				throw e;
			}
			const files = new Map<string, Uint8Array>();
			for (const path of outputs) {
				try {
					files.set(path, qpdf.FS.readFile(path));
				} catch {
					// Not produced.
				}
			}
			for (const dir of outputDirs) {
				let names: string[] = [];
				try {
					names = qpdf.FS.readdir(dir).filter((n) => n !== '.' && n !== '..');
				} catch {
					// Not created.
				}
				for (const n of names) {
					const path = `${dir}/${n}`;
					files.set(path, qpdf.FS.readFile(path));
					try {
						qpdf.FS.unlink(path);
					} catch {
						// Already gone.
					}
				}
			}
			return { code, stdout: decode(out), stderr: decode(err), files };
		} finally {
			if (proc) proc.exitCode = savedExitCode;
			for (const path of [...written, ...outputs]) {
				try {
					qpdf.FS.unlink(path);
				} catch {
					// Already gone.
				}
			}
		}
	}
}

function ensureDirs(fs: EmscriptenFS, path: string) {
	const parts = path.split('/').filter(Boolean);
	let dir = '';
	for (const part of parts.slice(0, -1)) {
		dir += '/' + part;
		try {
			fs.mkdir(dir);
		} catch {
			// Exists.
		}
	}
}

function decode(bytes: number[]): string {
	if (bytes.length === 0) return '';
	return new TextDecoder().decode(Uint8Array.from(bytes));
}

let patchQueue: Promise<unknown> = Promise.resolve();

/**
 * While `create` runs, make WebAssembly.instantiate(Streaming) use our compiled module
 * (and short-circuit the loader's fetch of qpdf.wasm).
 * Only the first instantiation with qpdf's import object is redirected, and the
 * originals are restored right after. Calls are serialized across all Qpdf objects.
 * Instantiations by other engines in that window (MuPDF) are passed through untouched;
 * without that check MuPDF could be handed qpdf's module ("function import requires a callable").
 */
function withCachedModule<T>(module: WebAssembly.Module, location: string, create: () => Promise<T>): Promise<T> {
	const run = async () => {
		const wa = WebAssembly as unknown as WA;
		const origInstantiate = wa.instantiate;
		const origStreaming = wa.instantiateStreaming;
		const g = globalThis as { fetch?: typeof fetch };
		const origFetch = g.fetch;
		const restore = () => {
			wa.instantiate = origInstantiate;
			if (origStreaming) wa.instantiateStreaming = origStreaming;
			if (origFetch) g.fetch = origFetch;
		};
		// The browser loader fetches qpdf.wasm before instantiating; answer that request
		// with an empty body instead of re-reading 1.3 MB we would discard anyway.
		if (origFetch && typeof Response !== 'undefined') {
			g.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
				String(input) === location
					? Promise.resolve(new Response(new Uint8Array(0), { headers: { 'Content-Type': 'application/wasm' } }))
					: origFetch(input, init)) as typeof fetch;
		}
		// Another engine (MuPDF) may instantiate its own WebAssembly while qpdf's factory runs;
		// only a call whose import object supplies everything qpdf.wasm imports is ours.
		const wanted = WebAssembly.Module.imports(module);
		const isQpdf = (imports: unknown) =>
			wanted.every((d) => {
				const ns = (imports as Record<string, Record<string, unknown> | undefined> | undefined)?.[d.module];
				return ns !== undefined && ns !== null && ns[d.name] !== undefined;
			});
		const useCached = async (imports: unknown) => {
			restore();
			const instance = (await origInstantiate.call(WebAssembly, module, imports)) as WebAssembly.Instance;
			return { module, instance };
		};
		wa.instantiate = (src: unknown, imports?: unknown) => {
			if (src instanceof WebAssembly.Module || !isQpdf(imports)) return origInstantiate.call(WebAssembly, src as never, imports as never);
			return useCached(imports);
		};
		if (origStreaming) {
			wa.instantiateStreaming = (src: unknown, imports?: unknown) => {
				if (!isQpdf(imports)) return origStreaming.call(WebAssembly, src as never, imports as never);
				// Discard the response body; the compiled module is already in hand.
				Promise.resolve(src)
					.then((r) => (r as Response | undefined)?.body?.cancel())
					.catch(() => undefined);
				return useCached(imports);
			};
		}
		try {
			return await create();
		} finally {
			restore();
		}
	};
	const next = patchQueue.then(run);
	patchQueue = next.catch(() => undefined);
	return next;
}
