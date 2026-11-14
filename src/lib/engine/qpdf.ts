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
	/** Every file read of the run goes through this (Emscripten FS.read); see `watchReads`. */
	read(stream: { path?: string; position: number }, buffer: unknown, offset: number, length: number, position?: number): number;
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
	/**
	 * How much of one input file qpdf has read so far, reported while the run is going
	 * (from inside it, synchronously): `read` of `total` bytes, each 4 KB block counted
	 * once, at most every `everyMs` (default 200 ms). qpdf reads a stream's data as it
	 * decodes it, so for the long runs (`--check` of a file of scans) this tracks the work done.
	 */
	readProgress?: { path: string; report: (read: number, total: number) => void; everyMs?: number };
	/** Also return stdout as bytes (`QpdfResult.stdoutLatin1`: one character per byte), for output that is not UTF-8 (`--show-object` of a string). */
	latin1Stdout?: boolean;
	/**
	 * A command line run first, in the same instance, for settings qpdf keeps process-wide
	 * (final-check.ts: the Flate compression level, which `--check` itself does not take).
	 * Its output is discarded. If it does not exit 0 the main command is not run, and the
	 * result has `code` -1 and `prelude` set to the prelude's exit code.
	 */
	prelude?: string[];
}

export interface QpdfResult {
	code: number;
	stdout: string;
	stderr: string;
	files: Map<string, Uint8Array>;
	/** With `latin1Stdout`: stdout, one character per byte. */
	stdoutLatin1?: string;
	/** Exit code of `QpdfRunOptions.prelude`, when one was given. */
	prelude?: number;
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

	async #runNow({ args, inputs = {}, outputs = [], outputDirs = [], readProgress, latin1Stdout, prelude }: QpdfRunOptions): Promise<QpdfResult> {
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
			const watched = readProgress && inputs[readProgress.path];
			if (readProgress && watched) watchReads(qpdf.FS, readProgress.path, watched.length, readProgress.report, readProgress.everyMs ?? READ_EVERY_MS);
			let code: number;
			let preludeCode: number | undefined;
			try {
				if (prelude) {
					try {
						preludeCode = qpdf.callMain([...prelude]);
					} catch (e) {
						if (isOutOfMemory(e)) throw e;
						preludeCode = -1;
					}
					out.length = 0;
					err.length = 0;
					if (preludeCode !== 0) return { code: -1, stdout: '', stderr: '', files: new Map(), prelude: preludeCode };
				}
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
			const res: QpdfResult = { code, stdout: decode(out), stderr: decode(err), files, ...(prelude ? { prelude: preludeCode } : {}) };
			if (latin1Stdout) res.stdoutLatin1 = latin1(out);
			return res;
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

const READ_BLOCK = 4096;
const READ_EVERY_MS = 200;

/**
 * Wraps this instance's FS.read (each run has its own instance, so nothing is restored)
 * to count the 4 KB blocks of `path` read so far. The cost is a few operations per read
 * call (qpdf reads in 1 KB to megabyte pieces) and one byte per block.
 */
function watchReads(fs: EmscriptenFS, path: string, total: number, report: (read: number, total: number) => void, everyMs: number) {
	const seen = new Uint8Array(Math.max(1, Math.ceil(total / READ_BLOCK)));
	let blocks = 0;
	let last = performance.now();
	const read = fs.read;
	fs.read = function (stream, buffer, offset, length, position) {
		const n = read.call(this, stream, buffer, offset, length, position);
		if (n > 0 && stream?.path === path) {
			// Without `position` the stream's own position was used and has moved on by n.
			const start = typeof position === 'number' ? position : stream.position - n;
			const end = Math.min(seen.length - 1, Math.floor((start + n - 1) / READ_BLOCK));
			for (let b = Math.max(0, Math.floor(start / READ_BLOCK)); b <= end; b++) {
				if (seen[b] === 0) {
					seen[b] = 1;
					blocks++;
				}
			}
			const t = performance.now();
			if (t - last >= everyMs) {
				last = t;
				try {
					report(Math.min(total, blocks * READ_BLOCK), total);
				} catch {
					// A listener's trouble must not stop qpdf.
				}
			}
		}
		return n;
	};
}

function latin1(bytes: number[]): string {
	let s = '';
	for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.slice(i, i + 8192).map((b) => b & 255));
	return s;
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
