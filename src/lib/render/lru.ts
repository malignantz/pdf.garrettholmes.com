/** Least-recently-used cache with a byte budget. Framework-free. */

export interface ByteLruOptions<V> {
	maxBytes: number;
	/** Called for every entry that leaves the cache (evicted, replaced, deleted, cleared). */
	onEvict?: (value: V, key: string) => void;
}

interface Entry<V> {
	value: V;
	bytes: number;
}

export class ByteLru<V> {
	#map = new Map<string, Entry<V>>();
	#bytes = 0;
	#max: number;
	#onEvict?: (value: V, key: string) => void;

	constructor(opts: ByteLruOptions<V>) {
		this.#max = opts.maxBytes;
		this.#onEvict = opts.onEvict;
	}

	get bytes(): number {
		return this.#bytes;
	}
	get size(): number {
		return this.#map.size;
	}
	get maxBytes(): number {
		return this.#max;
	}

	has(key: string): boolean {
		return this.#map.has(key);
	}

	/** Returns the value and marks it most recently used. */
	get(key: string): V | undefined {
		const e = this.#map.get(key);
		if (!e) return undefined;
		this.#map.delete(key);
		this.#map.set(key, e);
		return e.value;
	}

	/**
	 * Insert a value. An entry larger than the whole budget is not stored (it is
	 * passed to onEvict straight away so the owner can free it).
	 */
	set(key: string, value: V, bytes: number): void {
		this.delete(key);
		if (bytes > this.#max) {
			this.#onEvict?.(value, key);
			return;
		}
		this.#map.set(key, { value, bytes });
		this.#bytes += bytes;
		this.#trim();
	}

	delete(key: string): boolean {
		const e = this.#map.get(key);
		if (!e) return false;
		this.#map.delete(key);
		this.#bytes -= e.bytes;
		this.#onEvict?.(e.value, key);
		return true;
	}

	/** Delete every entry whose key starts with `prefix`. */
	deletePrefix(prefix: string): number {
		let n = 0;
		for (const key of [...this.#map.keys()]) {
			if (key.startsWith(prefix)) {
				this.delete(key);
				n++;
			}
		}
		return n;
	}

	clear(): void {
		for (const key of [...this.#map.keys()]) this.delete(key);
	}

	setMaxBytes(maxBytes: number): void {
		this.#max = maxBytes;
		this.#trim();
	}

	#trim(): void {
		while (this.#bytes > this.#max) {
			const oldest = this.#map.keys().next();
			if (oldest.done) break;
			this.delete(oldest.value);
		}
	}
}
