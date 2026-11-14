/**
 * Damage for good exports, to test the final check (final-check.ts): each fault takes a
 * file and returns a damaged copy, or null when the file has nothing it applies to.
 * Byte-level and deterministic. Unless the fault is about lengths or offsets, every damage
 * keeps the file's length and every offset, so it hits exactly one thing.
 *
 * Used by tests/engine/fast-check.test.ts and tools/fast-check/measure.ts.
 */

export interface Fault {
	name: string;
	apply(bytes: Uint8Array): Uint8Array | null;
}

const latin1 = (b: Uint8Array) => new TextDecoder('latin1').decode(b);
const encode = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);

export interface PdfObject {
	num: number;
	/** Offset of "N G obj". */
	start: number;
	/** The dictionary text (from "<<" to the matching ">>", when the object is a dictionary or stream). */
	dict: string;
	dictStart: number;
	/** Stream data span, when a stream: [dataStart, dataEnd) using the "endstream" keyword found. */
	data?: [number, number];
}

/** Top-level objects found by scanning (good enough for qpdf's own, well-formed output). */
export function objects(bytes: Uint8Array): PdfObject[] {
	const s = latin1(bytes);
	const out: PdfObject[] = [];
	const re = /(?:^|[\r\n])(\d+) (\d+) obj\b/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(s))) {
		const start = m.index + (m[0].startsWith('\n') || m[0].startsWith('\r') ? 1 : 0);
		let i = start + m[0].trimStart().length;
		while (/\s/.test(s[i])) i++;
		let dict = '';
		const dictStart = i;
		if (s.startsWith('<<', i)) {
			let depth = 0;
			let j = i;
			for (; j < s.length; j++) {
				if (s.startsWith('<<', j)) {
					depth++;
					j++;
				} else if (s.startsWith('>>', j)) {
					depth--;
					j++;
					if (depth === 0) break;
				} else if (s[j] === '(') {
					// Skip a literal string (balanced parentheses, backslash escapes).
					let d = 0;
					for (; j < s.length; j++) {
						if (s[j] === '\\') j++;
						else if (s[j] === '(') d++;
						else if (s[j] === ')' && --d === 0) break;
					}
				}
			}
			dict = s.slice(i, j + 1);
			i = j + 1;
		}
		const obj: PdfObject = { num: Number(m[1]), start, dict, dictStart };
		const after = /^\s*stream(\r\n|\n|\r)/.exec(s.slice(i, i + 20));
		if (after) {
			const dataStart = i + after[0].length;
			const end = s.indexOf('endstream', dataStart);
			if (end > 0) {
				let dataEnd = end;
				if (s[dataEnd - 1] === '\n') dataEnd--;
				if (s[dataEnd - 1] === '\r') dataEnd--;
				obj.data = [dataStart, dataEnd];
				re.lastIndex = end;
			}
		}
		out.push(obj);
	}
	return out;
}

function copy(bytes: Uint8Array): Uint8Array {
	return new Uint8Array(bytes);
}

/** The largest stream whose dictionary matches `test`. */
function biggest(bytes: Uint8Array, test: (dict: string) => boolean): PdfObject | null {
	let best: PdfObject | null = null;
	for (const o of objects(bytes)) {
		if (!o.data || !test(o.dict)) continue;
		if (!best || o.data[1] - o.data[0] > best.data![1] - best.data![0]) best = o;
	}
	return best;
}

const isImage = (d: string) => /\/Subtype\s*\/Image/.test(d);
const filterIs = (d: string, f: string) => new RegExp(`/Filter\\s*(?:\\[\\s*)?/${f}\\b`).test(d);
/** A page content stream as qpdf writes it: nothing but /Filter /FlateDecode and /Length. */
const isContent = (d: string) => /^<<\s*\/Filter\s*\/FlateDecode\s*\/Length\s+\d+(?:\s+0\s+R)?\s*>>$/.test(d);

/** Overwrites `n` bytes at the middle (+ `at` fraction) of a stream's data with a pattern. */
function stomp(bytes: Uint8Array, o: PdfObject | null, at: number, pattern: number[]): Uint8Array | null {
	if (!o?.data) return null;
	const [a, b] = o.data;
	if (b - a < pattern.length + 8) return null;
	const out = copy(bytes);
	const p = a + Math.floor((b - a - pattern.length) * at);
	out.set(pattern, p);
	return out;
}

/** Replaces the first match of `re` in the file (same length required) at or after `from`. */
function replaceSame(bytes: Uint8Array, re: RegExp, to: (m: RegExpExecArray) => string, from = 0): Uint8Array | null {
	const s = latin1(bytes);
	const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
	r.lastIndex = from;
	const m = r.exec(s);
	if (!m) return null;
	const rep = to(m);
	if (rep.length !== m[0].length || rep === m[0]) return null;
	const out = copy(bytes);
	out.set(encode(rep), m.index);
	return out;
}

/** Same number of digits, different value. */
function otherNumber(n: string, delta = 1): string {
	const v = (Number(n) + delta) % 10 ** n.length;
	return String(v).padStart(n.length, '0').slice(-n.length).replace(/^0(?=\d)/, n.startsWith('0') ? '0' : '1');
}

export const FAULTS: Fault[] = [
	{ name: 'truncated: last 200 bytes cut', apply: (b) => (b.length > 400 ? b.slice(0, b.length - 200) : null) },
	{ name: 'truncated: half the file', apply: (b) => b.slice(0, Math.floor(b.length / 2)) },
	{ name: 'truncated: first 90%', apply: (b) => b.slice(0, Math.floor(b.length * 0.9)) },
	{
		name: 'truncated stream: image data shortened, /Length kept',
		apply: (b) => {
			const o = biggest(b, isImage);
			if (!o?.data) return null;
			const [a, e] = o.data;
			const cut = Math.min(1000, Math.floor((e - a) / 3));
			return new Uint8Array([...b.subarray(0, e - cut), ...b.subarray(e)]);
		}
	},
	{
		name: 'wrong /Length: image stream, one less in the last digit',
		apply: (b) => {
			const o = biggest(b, (d) => isImage(d) && /\/Length\s+\d+/.test(d));
			if (!o) return null;
			return replaceSame(b, /\/Length\s+(\d+)/, (m) => m[0].replace(m[1], otherNumber(m[1], -1)), o.dictStart);
		}
	},
	{
		name: 'wrong /Length: content stream, larger',
		apply: (b) => {
			const o = biggest(b, (d) => isContent(d) && /\/Length\s+\d+/.test(d));
			if (!o) return null;
			return replaceSame(b, /\/Length\s+(\d+)/, (m) => m[0].replace(m[1], otherNumber(m[1], 3)), o.dictStart);
		}
	},
	{ name: 'corrupt Flate: content stream (pipeline-written), middle', apply: (b) => stomp(b, biggest(b, isContent), 0.5, [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x13, 0x37]) },
	{ name: 'corrupt Flate: content stream, zlib header', apply: (b) => stomp(b, biggest(b, isContent), 0, [0x00, 0x00]) },
	{ name: 'corrupt Flate: content stream, adler32 trailer', apply: (b) => stomp(b, biggest(b, isContent), 1, [0x00, 0x01, 0x02, 0x03]) },
	{ name: 'corrupt Flate: image stream, middle', apply: (b) => stomp(b, biggest(b, (d) => isImage(d) && filterIs(d, 'FlateDecode')), 0.5, [0xde, 0xad, 0xbe, 0xef, 0x00, 0xff, 0x13, 0x37]) },
	{ name: 'corrupt Flate: image stream, zlib header', apply: (b) => stomp(b, biggest(b, (d) => isImage(d) && filterIs(d, 'FlateDecode')), 0, [0x00, 0x00]) },
	{ name: 'corrupt Flate: font or other non-image stream', apply: (b) => stomp(b, biggest(b, (d) => !isImage(d) && !isContent(d) && filterIs(d, 'FlateDecode') && !/ObjStm|XRef/.test(d)), 0.5, [0xde, 0xad, 0xbe, 0xef]) },
	{ name: 'corrupt JPEG: copied image, bytes in the middle', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 0.5, [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc]) },
	{ name: 'corrupt JPEG: bad marker in the entropy data', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 0.6, [0xff, 0x01]) },
	{ name: 'corrupt JPEG: early EOI', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 0.4, [0xff, 0xd9]) },
	{ name: 'corrupt JPEG: SOI destroyed', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 0, [0x00, 0x00]) },
	{ name: 'corrupt JPEG: EOI destroyed', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 1, [0x00, 0x00]) },
	{ name: 'corrupt JPEG: header (SOF) bytes', apply: (b) => stomp(b, biggest(b, (d) => filterIs(d, 'DCTDecode')), 0.002, [0xff, 0xff, 0xff, 0xff]) },
	{
		name: 'corrupt JPEG: smallest DCT image, middle',
		apply: (b) => {
			let best: PdfObject | null = null;
			for (const o of objects(b)) if (o.data && filterIs(o.dict, 'DCTDecode') && (!best || o.data[1] - o.data[0] < best.data![1] - best.data![0])) best = o;
			return stomp(b, best, 0.5, [0xff, 0x01, 0x00, 0x00]);
		}
	},
	{ name: 'corrupt object stream data', apply: (b) => stomp(b, biggest(b, (d) => /\/Type\s*\/ObjStm/.test(d)), 0.5, [0xde, 0xad, 0xbe, 0xef]) },
	{
		name: 'bad object stream: /First off by one',
		apply: (b) => {
			const o = biggest(b, (d) => /\/Type\s*\/ObjStm/.test(d));
			return o ? replaceSame(b, /\/First\s+(\d+)/, (m) => m[0].replace(m[1], otherNumber(m[1], 1)), o.dictStart) : null;
		}
	},
	{
		name: 'bad object stream: /N one more',
		apply: (b) => {
			const o = biggest(b, (d) => /\/Type\s*\/ObjStm/.test(d));
			return o ? replaceSame(b, /\/N\s+(\d+)/, (m) => m[0].replace(m[1], otherNumber(m[1], 1)), o.dictStart) : null;
		}
	},
	{ name: 'corrupt xref stream data', apply: (b) => stomp(b, biggest(b, (d) => /\/Type\s*\/XRef/.test(d)), 0.5, [0xde, 0xad]) },
	{
		name: 'broken xref: an entry offset changed',
		apply: (b) => {
			const s = latin1(b);
			const x = s.lastIndexOf('\nxref');
			if (x < 0) return null;
			// The third in-use entry (skip object 0's free entry).
			return replaceSame(b, /(\d{10}) 00000 n/, (m) => `${otherNumber(m[1], 7)} 00000 n`, x + 20 + 40);
		}
	},
	{
		name: 'broken xref: startxref points elsewhere',
		apply: (b) => replaceSame(b, /startxref\s+(\d+)/, (m) => m[0].replace(m[1], otherNumber(m[1], 5)), Math.max(0, b.length - 200))
	},
	{
		name: 'broken xref: "xref" keyword damaged',
		apply: (b) => {
			const s = latin1(b);
			const x = s.lastIndexOf('\nxref');
			return x < 0 ? null : replaceSame(b, /\nxref/, () => '\nxreg', x);
		}
	},
	{
		name: 'dangling reference: a page /Contents to a missing object',
		apply: (b) => replaceSame(b, /\/Contents (\d+) 0 R/, (m) => m[0].replace(m[1], String(9 * 10 ** (m[1].length - 1) + (Number(m[1]) % 10 ** (m[1].length - 1))).slice(0, m[1].length)))
	},
	{
		name: 'dangling reference: an image XObject to a missing object',
		apply: (b) => replaceSame(b, /\/(Im\d*|X\d+|I\d+) (\d+) 0 R/, (m) => m[0].replace(` ${m[2]} 0 R`, ` ${'9'.repeat(m[2].length)} 0 R`))
	},
	{
		name: 'dangling reference: a page in /Kids to a missing object',
		apply: (b) => replaceSame(b, /\/Kids \[ ?(\d+) 0 R/, (m) => m[0].replace(m[1], '9'.repeat(m[1].length)))
	},
	{ name: 'wrong page tree /Count (one more)', apply: (b) => replaceSame(b, /\/Count (\d+)/, (m) => `/Count ${otherNumber(m[1], 1)}`) },
	{ name: 'wrong page tree /Count (one less)', apply: (b) => replaceSame(b, /\/Count (\d+)/, (m) => `/Count ${otherNumber(m[1], 9)}`) },
	{ name: 'page tree /Type damaged', apply: (b) => replaceSame(b, /\/Type \/Pages/, () => '/Type /Pagez') },
	{ name: 'catalog /Type damaged', apply: (b) => replaceSame(b, /\/Type \/Catalog/, () => '/Type /Catalop') },
	{ name: 'catalog /Pages to a missing object', apply: (b) => replaceSame(b, /\/Type \/Catalog[^>]*?\/Pages (\d+) 0 R|\/Pages (\d+) 0 R[^>]*?\/Type \/Catalog/, (m) => m[0].replace(/\/Pages \d+/, (p) => '/Pages ' + '9'.repeat(p.length - 7))) },
	{ name: 'content syntax: stray ) in a content stream', apply: (b) => stompUncompressedContent(b, ')') },
	{ name: 'content syntax: unbalanced string', apply: (b) => stompUncompressedContent(b, '(') },
	{ name: 'content syntax: unbalanced dict', apply: (b) => stompUncompressedContent(b, '<<') },
	{ name: 'content syntax: unbalanced array', apply: (b) => stompUncompressedContent(b, '[') },
	{ name: 'object syntax: endobj damaged', apply: (b) => replaceSame(b, /endobj/, () => 'endobk', Math.floor(b.length / 3)) },
	{ name: 'object syntax: "obj" keyword damaged', apply: (b) => replaceSame(b, /\n(\d+) 0 obj/, (m) => m[0].replace(' obj', ' obk'), Math.floor(b.length / 3)) },
	{ name: 'object syntax: dict close damaged', apply: (b) => replaceSame(b, />>\nendobj/, () => '>]\nendobj', Math.floor(b.length / 4)) },
	{ name: 'trailer /Root to a missing object', apply: (b) => replaceSame(b, /\/Root (\d+) 0 R/, (m) => m[0].replace(m[1], '9'.repeat(m[1].length)), Math.max(0, b.length - 600)) },
	{ name: 'trailer /Size too small', apply: (b) => replaceSame(b, /\/Size (\d+)/, (m) => `/Size ${otherNumber(m[1], m[1].length > 1 ? -5 : -1)}`, Math.max(0, b.length - 600)) },
	{ name: 'header damaged', apply: (b) => replaceSame(b, /%PDF-/, () => '%PDX-') },
	{ name: 'encryption dict: /R changed', apply: (b) => replaceSame(b, /\/R (\d)/, (m) => `/R ${m[1] === '6' ? '5' : '6'}`, encryptAt(b)) },
	{ name: 'encryption dict: /V changed', apply: (b) => replaceSame(b, /\/V (\d)/, (m) => `/V ${m[1] === '5' ? '4' : '5'}`, encryptAt(b)) },
	{ name: 'encryption dict: /U damaged', apply: (b) => replaceSame(b, /\/U <([0-9a-f]{8})/i, (m) => m[0].replace(m[1], flipHex(m[1])), encryptAt(b)) },
	{ name: 'encryption dict: /UE damaged', apply: (b) => replaceSame(b, /\/UE <([0-9a-f]{8})/i, (m) => m[0].replace(m[1], flipHex(m[1])), encryptAt(b)) },
	{ name: 'encryption dict: /Perms damaged', apply: (b) => replaceSame(b, /\/Perms <([0-9a-f]{8})/i, (m) => m[0].replace(m[1], flipHex(m[1])), encryptAt(b)) },
	{ name: 'encryption dict: /P changed', apply: (b) => replaceSame(b, /\/P (-?\d+)/, (m) => `/P ${m[1].startsWith('-') ? '-' : ''}${otherNumber(m[1].replace('-', ''), 1)}`, encryptAt(b)) },
	{ name: 'encryption dict: crypt filter method damaged', apply: (b) => replaceSame(b, /\/CFM \/AESV3/, () => '/CFM /AESV4', encryptAt(b)) },
	{ name: 'encrypted: string in a page dict damaged', apply: (b) => (encryptAt(b) >= 0 ? replaceSame(b, /<([0-9a-f]{16})>/i, (m) => `<${flipHex(m[1])}>`, Math.floor(b.length / 3)) : null) },
	{ name: 'encrypted: stream data byte flipped (AES block)', apply: (b) => (encryptAt(b) >= 0 ? stomp(b, biggest(b, isContent), 0.5, [0x5a]) : null) },
	{ name: 'encrypted: image data byte flipped (AES block)', apply: (b) => (encryptAt(b) >= 0 ? stomp(b, biggest(b, isImage), 0.5, [0x5a]) : null) },
	{ name: 'binary garbage over 64 bytes in the middle of the file', apply: (b) => { const out = copy(b); const p = Math.floor(b.length / 2); for (let i = 0; i < 64 && p + i < b.length; i++) out[p + i] = (i * 37) & 255; return out; } },
	{ name: 'zeroed 4 KB block at 70%', apply: (b) => { const out = copy(b); out.fill(0, Math.floor(b.length * 0.7), Math.min(b.length, Math.floor(b.length * 0.7) + 4096)); return out; } }
];

function encryptAt(b: Uint8Array): number {
	const s = latin1(b);
	const m = /\/Encrypt (\d+) 0 R/.exec(s);
	if (!m) return -1;
	const o = new RegExp(`(?:^|\\n)${m[1]} 0 obj`).exec(s);
	return o ? o.index : -1;
}

function flipHex(h: string): string {
	return h.replace(/[0-9a-f]/i, (c) => ((parseInt(c, 16) ^ 5).toString(16)));
}

/** Content-syntax damage needs readable content: the first uncompressed content stream, or null. */
function stompUncompressedContent(b: Uint8Array, junk: string): Uint8Array | null {
	for (const o of objects(b)) {
		if (!o.data || /\/Filter|\/Type|\/Subtype/.test(o.dict) || o.data[1] - o.data[0] < 40) continue;
		const s = latin1(b.subarray(...o.data));
		if (!/\b(?:BT|re|cm|Do)\b/.test(s)) continue;
		// Replace whitespace before an operator with the junk (same length: drop spaces after it).
		const at = s.search(/ (?:BT|q|Q|cm|Do|re|f|S)\b/);
		if (at < 0 || at + junk.length > s.length) continue;
		const out = copy(b);
		out.set(encode(junk), o.data[0] + at);
		return out;
	}
	return null;
}
