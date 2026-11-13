/**
 * A small store-only ZIP writer (no compression: PDFs, JPEGs and PNGs are compressed
 * already) for the export dialog's "several files in one zip". Written here rather than
 * taken as a dependency: it is about a hundred lines, and only this subset is needed.
 *
 * - Entries are stored (method 0) with their CRC-32 and sizes in the local header, so
 *   any unzip tool reads them without data descriptors. Names are UTF-8 (flag bit 11).
 * - The archive is a Blob made of the entries' own Blobs or byte arrays plus small
 *   headers: nothing is copied into one big buffer (browsers may keep large Blobs on disk).
 * - No ZIP64: at most 65,535 entries and 4 GB in all; past that `add` throws, and the
 *   caller says the export is too large before it gets there.
 */

const TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c >>> 0;
	}
	return t;
})();

/** CRC-32 (ISO-HDLC, as ZIP and PNG use). Pass the previous value to continue over several chunks. */
export function crc32(data: Uint8Array, previous = 0): number {
	let c = (previous ^ 0xffffffff) >>> 0;
	for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

export const ZIP_MAX_ENTRIES = 0xffff;
/** Offsets and sizes are 32-bit without ZIP64. */
export const ZIP_MAX_BYTES = 0xffffffff;

interface Entry {
	name: Uint8Array;
	crc: number;
	size: number;
	offset: number;
}

/** DOS date and time of `d` (local time, 2-second resolution; 1980 at the earliest). */
function dosTime(d: Date): { time: number; date: number } {
	const year = Math.max(1980, d.getFullYear());
	return {
		time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
		date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
	};
}

export class ZipWriter {
	readonly #parts: BlobPart[] = [];
	readonly #entries: Entry[] = [];
	readonly #names = new Set<string>();
	#offset = 0;
	readonly #time: { time: number; date: number };

	constructor(date = new Date()) {
		this.#time = dosTime(date);
	}

	get count(): number {
		return this.#entries.length;
	}

	/** Bytes written so far (entries and their headers, not the closing directory). */
	get size(): number {
		return this.#offset;
	}

	/**
	 * Add one file. `crc` may be given when the caller has already computed it over
	 * exactly these bytes (it is not checked); otherwise `data` must be bytes.
	 */
	add(name: string, data: Uint8Array | { blob: Blob; crc: number }): void {
		if (!name || name.length > 255 || /[\\\0]|^\/|(^|\/)\.\.(\/|$)/.test(name)) throw new Error(`Bad file name for the zip: ${name}`);
		if (this.#names.has(name)) throw new Error(`Two files in the zip are called ${name}`);
		if (this.#entries.length >= ZIP_MAX_ENTRIES) throw new Error('Too many files for one zip.');
		const bytes = data instanceof Uint8Array ? data : null;
		const size = bytes ? bytes.length : (data as { blob: Blob }).blob.size;
		const crc = bytes ? crc32(bytes) : (data as { crc: number }).crc >>> 0;
		const nameBytes = new TextEncoder().encode(name);
		const header = new Uint8Array(30 + nameBytes.length);
		const v = new DataView(header.buffer);
		v.setUint32(0, 0x04034b50, true);
		v.setUint16(4, 10, true); // version needed: 1.0 (stored)
		v.setUint16(6, 0x0800, true); // UTF-8 names
		v.setUint16(8, 0, true); // stored
		v.setUint16(10, this.#time.time, true);
		v.setUint16(12, this.#time.date, true);
		v.setUint32(14, crc, true);
		v.setUint32(18, size, true);
		v.setUint32(22, size, true);
		v.setUint16(26, nameBytes.length, true);
		v.setUint16(28, 0, true);
		header.set(nameBytes, 30);
		if (this.#offset + header.length + size + 22 + 46 * (this.#entries.length + 1) > ZIP_MAX_BYTES) {
			throw new Error('The zip would be larger than 4 GB.');
		}
		this.#entries.push({ name: nameBytes, crc, size, offset: this.#offset });
		this.#names.add(name);
		this.#parts.push(header, bytes ? (bytes as BlobPart) : (data as { blob: Blob }).blob);
		this.#offset += header.length + size;
	}

	/** The finished archive. The writer must not be used afterwards. */
	finish(type = 'application/zip'): Blob {
		const dirStart = this.#offset;
		let dirSize = 0;
		for (const e of this.#entries) {
			const h = new Uint8Array(46 + e.name.length);
			const v = new DataView(h.buffer);
			v.setUint32(0, 0x02014b50, true);
			v.setUint16(4, 0x031e, true); // made by: Unix, spec 3.0
			v.setUint16(6, 10, true);
			v.setUint16(8, 0x0800, true);
			v.setUint16(10, 0, true);
			v.setUint16(12, this.#time.time, true);
			v.setUint16(14, this.#time.date, true);
			v.setUint32(16, e.crc, true);
			v.setUint32(20, e.size, true);
			v.setUint32(24, e.size, true);
			v.setUint16(28, e.name.length, true);
			// extra, comment, disk start, internal attributes: 0
			v.setUint32(38, (0o100644 << 16) >>> 0, true); // external: regular file, rw-r--r--
			v.setUint32(42, e.offset, true);
			h.set(e.name, 46);
			this.#parts.push(h);
			dirSize += h.length;
		}
		const end = new Uint8Array(22);
		const v = new DataView(end.buffer);
		v.setUint32(0, 0x06054b50, true);
		v.setUint16(8, this.#entries.length, true);
		v.setUint16(10, this.#entries.length, true);
		v.setUint32(12, dirSize, true);
		v.setUint32(16, dirStart, true);
		this.#parts.push(end);
		return new Blob(this.#parts, { type });
	}
}
