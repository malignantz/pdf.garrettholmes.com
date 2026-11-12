/**
 * Lossless JPEG repack (libjpeg-turbo in WebAssembly) for the stream pass (pack.ts).
 *
 * `repackJpeg` rewrites only the entropy coding of a JPEG: the same DCT coefficients,
 * baseline sequential with optimised Huffman tables (never progressive). The source's
 * JFIF, ICC and Adobe (APP14) segments are copied byte for byte; other APPn and COM
 * segments are dropped. `verifyJpeg` decodes two JPEGs to coefficients afresh and
 * compares them exactly (a separate run, so an encoder fault cannot hide itself).
 *
 * The 185 KB module (vendor/jpeg-repack, provenance and build script there) is vendored
 * as base64 and loaded by dynamic `import()` on the first compressed export: no fetch,
 * no network. It needs no JavaScript glue: its only import is a memory-growth notice.
 * libjpeg errors trap; a trapped instance is never reused (the next call makes a fresh
 * one from the compiled module). After a call that left the heap above 96 MB the
 * instance is dropped too, so a large image does not keep its memory.
 */

interface Exports {
	memory: WebAssembly.Memory;
	_initialize: () => void;
	jr_repack: (inPtr: number, n: number, maxCoef: number) => number;
	jr_verify: (a: number, na: number, b: number, nb: number, maxCoef: number) => number;
	jr_out_ptr: () => number;
	jr_out_len: () => number;
	jr_out_free: () => void;
	jr_malloc: (n: number) => number;
	jr_free: (p: number) => void;
	jr_last_error: () => number;
	jr_test_tamper: (t: number) => void;
}

const KEEP_HEAP = 96 * 1024 * 1024;

export type RepackResult =
	| { ok: true; jpeg: Uint8Array }
	| { ok: false; why: 'warning' | 'unsupported' | 'too-big' | 'error'; code?: number };

let compiled: Promise<WebAssembly.Module> | null = null;
let instance: Exports | null = null;
/** Test hook: replaces the module bytes (a corrupt module must only make the pass skip JPEGs). */
let override: (() => Promise<Uint8Array>) | null = null;

async function moduleOf(): Promise<WebAssembly.Module> {
	compiled ??= (async () => {
		let bytes: Uint8Array;
		if (override) bytes = await override();
		else {
			const b64 = (await import('./vendor/jpeg-repack/wasm')).default;
			const bin = atob(b64);
			bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		}
		return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
	})().catch((e) => {
		compiled = null;
		throw e;
	});
	return compiled;
}

async function instantiate(): Promise<Exports> {
	const mod = await moduleOf();
	const inst = await WebAssembly.instantiate(mod, { env: { emscripten_notify_memory_growth: () => {} } });
	const ex = inst.exports as unknown as Exports;
	ex._initialize();
	return ex;
}

/** Loads the module (once); throws when it cannot be compiled or instantiated. */
export async function loadJpegRepack(): Promise<void> {
	instance ??= await instantiate();
}

/** For tests: use these module bytes instead of the vendored ones (null restores them). */
export function setJpegRepackModuleForTest(bytes: (() => Promise<Uint8Array>) | null): void {
	override = bytes;
	compiled = null;
	instance = null;
}

/** For tests: add `t` to the first DC coefficient of every repack output (0 turns it off). */
export async function setJpegTamperForTest(t: number): Promise<void> {
	instance ??= await instantiate();
	instance.jr_test_tamper(t);
}

function copyIn(ex: Exports, data: Uint8Array): number {
	const p = ex.jr_malloc(Math.max(1, data.length));
	if (!p) throw new Error('jpeg-repack: out of memory');
	new Uint8Array(ex.memory.buffer).set(data, p);
	return p;
}

/** libjpeg's message code of the last trapped call (debug notes). */
let trappedCode = 0;

/**
 * Runs `f` on a live instance. A trap or any other error drops the instance (its heap is
 * not trusted again, so nothing is freed); so does a heap grown above KEEP_HEAP.
 */
async function withInstance<T>(f: (ex: Exports) => T): Promise<T> {
	instance ??= await instantiate();
	const ex = instance;
	try {
		return f(ex);
	} catch (e) {
		instance = null;
		try {
			trappedCode = ex.jr_last_error();
		} catch {
			trappedCode = 0;
		}
		throw e;
	} finally {
		if (instance === ex && ex.memory.buffer.byteLength > KEEP_HEAP) instance = null;
	}
}

const WHY: Record<number, 'warning' | 'unsupported' | 'too-big'> = { [-2]: 'warning', [-3]: 'unsupported', [-4]: 'too-big' };

/**
 * Repacks one JPEG. `maxCoefBytes` caps the coefficient buffers (memory); larger
 * images give `too-big`. Never throws for bad input: a libjpeg error is `error`.
 * Throws only when the module itself cannot be loaded.
 */
export async function repackJpeg(jpeg: Uint8Array, maxCoefBytes: number): Promise<RepackResult> {
	instance ??= await instantiate();
	try {
		return await withInstance((ex): RepackResult => {
			const p = copyIn(ex, jpeg);
			const rc = ex.jr_repack(p, jpeg.length, maxCoefBytes);
			ex.jr_free(p);
			if (rc !== 0) {
				ex.jr_out_free();
				return { ok: false, why: WHY[rc] ?? 'error', code: rc };
			}
			const out = new Uint8Array(ex.memory.buffer, ex.jr_out_ptr(), ex.jr_out_len()).slice();
			ex.jr_out_free();
			return { ok: true, jpeg: out };
		});
	} catch {
		return { ok: false, why: 'error', code: trappedCode };
	}
}

/**
 * Decodes both JPEGs to DCT coefficients and compares them exactly (and dimensions,
 * components, sampling, quantisation tables, JFIF/Adobe flags). True only when identical;
 * false for any difference, warning, error or a module that does not load.
 */
export async function verifyJpeg(a: Uint8Array, b: Uint8Array, maxCoefBytes: number): Promise<boolean> {
	try {
		return await withInstance((ex) => {
			const pa = copyIn(ex, a);
			const pb = copyIn(ex, b);
			const rc = ex.jr_verify(pa, a.length, pb, b.length, maxCoefBytes);
			ex.jr_free(pa);
			ex.jr_free(pb);
			return rc === 0;
		});
	} catch {
		return false;
	}
}
