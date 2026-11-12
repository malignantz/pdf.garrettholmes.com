/**
 * libdeflate (MIT) for the stream pass (pack.ts): at level 6 about twice as fast
 * as zlib for the same size, at level 12 about 5% smaller than zlib -9 (measured
 * on survey files, 2026-11-11). The 58 KB module is vendored as base64
 * (vendor/libdeflate/wasm.ts, provenance there) and loaded by dynamic `import()`
 * on the first compressed export: no fetch, no network.
 *
 * Memory: the module's heap only grows. After a call that left it above 96 MB the
 * instance is dropped and the next call makes a fresh one from the compiled module.
 */

import type { Deflater } from './pack';

interface Exports {
	c: WebAssembly.Memory;
	d: () => void;
	e: (level: number) => number;
	g: (c: number) => void;
	j: (c: number, inPtr: number, inLen: number, outPtr: number, outMax: number) => number;
	k: (c: number, inLen: number) => number;
	n: (size: number) => number;
	o: (ptr: number) => void;
}

const MAX_HEAP = 2 ** 31;
const KEEP_HEAP = 96 * 1024 * 1024;

let compiled: Promise<WebAssembly.Module> | null = null;
let instance: Exports | null = null;

async function moduleOf(): Promise<WebAssembly.Module> {
	compiled ??= (async () => {
		const b64 = (await import('./vendor/libdeflate/wasm')).default;
		const bin = atob(b64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return WebAssembly.compile(bytes);
	})().catch((e) => {
		compiled = null;
		throw e;
	});
	return compiled;
}

async function instantiate(): Promise<Exports> {
	const mod = await moduleOf();
	let ex: Exports | null = null;
	const imports = {
		a: {
			// emscripten_resize_heap(requested): grow by at least 20%, in 64 KB pages.
			a: (requested: number) => {
				const mem = ex!.c;
				const old = mem.buffer.byteLength;
				requested >>>= 0;
				if (requested > MAX_HEAP) return 0;
				const want = Math.min(MAX_HEAP, Math.max(requested, Math.ceil(old * 1.2)));
				try {
					mem.grow(Math.ceil((want - old) / 65536));
					return 1;
				} catch {
					try {
						mem.grow(Math.ceil((requested - old) / 65536));
						return 1;
					} catch {
						return 0;
					}
				}
			},
			// emscripten_memcpy_big(dest, src, n)
			b: (dest: number, src: number, n: number) => {
				new Uint8Array(ex!.c.buffer).copyWithin(dest, src, src + n);
			}
		}
	};
	const inst = await WebAssembly.instantiate(mod, imports);
	ex = inst.exports as unknown as Exports;
	ex.d();
	return ex;
}

/** zlib-format compression at `level` (1-12). Throws when the module fails. */
export async function libdeflateZlib(data: Uint8Array, level: number): Promise<Uint8Array> {
	instance ??= await instantiate();
	const ex = instance;
	const comp = ex.e(level);
	if (!comp) throw new Error('libdeflate: no compressor');
	let inPtr = 0;
	let outPtr = 0;
	try {
		inPtr = ex.n(Math.max(1, data.length));
		if (!inPtr) throw new Error('libdeflate: out of memory');
		new Uint8Array(ex.c.buffer).set(data, inPtr);
		const max = ex.k(comp, data.length);
		outPtr = ex.n(max);
		if (!outPtr) throw new Error('libdeflate: out of memory');
		const n = ex.j(comp, inPtr, data.length, outPtr, max);
		if (n === 0) throw new Error('libdeflate: compression failed');
		return new Uint8Array(ex.c.buffer).slice(outPtr, outPtr + n);
	} catch (e) {
		// A trap may leave the heap inconsistent: never reuse this instance.
		instance = null;
		throw e;
	} finally {
		if (instance === ex) {
			if (outPtr) ex.o(outPtr);
			if (inPtr) ex.o(inPtr);
			ex.g(comp);
			if (ex.c.buffer.byteLength > KEEP_HEAP) instance = null;
		}
	}
}

/** A Deflater at a fixed libdeflate level. */
export function libdeflate(level: number): Deflater {
	return { name: `libdeflate-${level}`, zlib: (d) => libdeflateZlib(d, level) };
}
