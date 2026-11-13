/**
 * Lossless stream packing for compressed exports (the default "compress" option).
 *
 * qpdf's own `--recompress-flate` decodes every Flate stream, PNG predictors
 * included, and writes it back at zlib level 6 without a predictor, so a well
 * predicted image could come out much bigger (one survey file: 4.57 → 6.57 MB).
 * This pass replaces it. Per stream it keeps the smallest of:
 *
 *   A  the stream as it is;
 *   B  its inflated bytes deflated again, same /DecodeParms (any stream);
 *   C1 8-bit images: the pixels with a PNG predictor chosen per row (Predictor 15);
 *   C2 8-bit images that had a predictor: the pixels with none (what qpdf wrote);
 *   J  JPEG images (/DCTDecode, alone or behind one /FlateDecode): the same DCT
 *      coefficients with optimised Huffman tables, baseline (jpeg-repack.ts), kept
 *      only when every check below passes and the stored stream is smaller.
 *
 * Every candidate is decoded again before it is used and must give back exactly
 * the bytes it was made from (for C1, through the same PNG un-prediction a viewer
 * runs), so the decoded data, and with it every pixel and glyph, is unchanged.
 * A stream that is damaged, oddly filtered, encrypted, external or XMP metadata
 * is left alone; so is everything once the time budget is spent ("avoid, don't fail").
 *
 * How: qpdf writes every stream's raw bytes to its virtual file system
 * (`--json-output --decode-level=none --json-stream-data=file`), this module
 * decides in JavaScript, and qpdf writes the chosen data back
 * (`--update-from-json`, streams otherwise preserved byte for byte). The
 * finalize step afterwards packs objects into object streams and compresses
 * what is still uncompressed, without `--recompress-flate`.
 */

import { inflateSync, zlibSync } from 'fflate';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';
import { pngPredict } from './shrink';
import { outputRefusal, parseJpeg, repackRefusal } from './jpeg';
import { loadJpegRepack, repackJpeg, verifyJpeg } from './jpeg-repack';

/** zlib-format (RFC 1950) compressor. */
export interface Deflater {
	name: string;
	zlib(data: Uint8Array): Uint8Array | Promise<Uint8Array>;
}

/** The platform's zlib (CompressionStream 'deflate', zlib's default level 6); fflate where it is missing. */
export const nativeDeflate: Deflater = {
	name: 'native-6',
	zlib: async (d) => {
		if (typeof CompressionStream === 'undefined') return zlibSync(d, { level: 6 });
		const stream = new Blob([d as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
		return new Uint8Array(await new Response(stream).arrayBuffer());
	}
};

export interface PackOptions {
	/** Picks each stream's encoding (fast). Default `nativeDeflate`. */
	deflate?: Deflater;
	/** Optional slower, stronger compressor for the chosen encodings, biggest streams first, while time remains. */
	polish?: Deflater;
	/** Performance.now() value after which no further stream is touched. */
	deadline?: number;
	/**
	 * Decoded bytes polishing may compress in all (a work budget, so the result does not
	 * depend on how busy the device is). Default: no limit.
	 */
	polishBytes?: number;
	/** Hard wall-clock cap on polishing, from the end of the fast pass (a safety net for slow devices). */
	polishMs?: number;
	/** Streams whose decoded size is above this are left as they are. Default 64 MB. */
	maxStreamBytes?: number;
	/** Lossless JPEG repack of DCT images (jpeg-repack.ts); off when absent or false. */
	jpeg?: JpegPassOptions | false;
	/** Debug notes (never shown to the user). */
	note?: (s: string) => void;
	/** Progress of the main pass: `done` of `total` bytes of stream data looked at (ExportProgress 'pack'). */
	progress?: (done: number, total: number) => void;
}

export interface JpegPassOptions {
	/**
	 * Images whose coefficient buffers would exceed this are left as they are (memory:
	 * the check decodes input and output at once, so about twice this). Default 48 MB
	 * (about 16 megapixels of 4:4:4 colour, 24 of 4:2:0, 25 of grey).
	 */
	maxCoefBytes?: number;
	/** Wall-clock cap on all JPEG work of one export; images not started by then stay as they are. */
	ms?: number;
	/** JPEG bytes the repack may take in all (a work budget). */
	bytes?: number;
	/** The file is digitally signed: its images are left exactly as they are. */
	signed?: boolean;
}

const JPEG_MAX_COEF = 48 * 1024 * 1024;

export interface PackStats {
	streams: number;
	changed: number;
	/** Raw bytes saved over the streams changed (before object streams). */
	saved: number;
	/** Streams re-encoded with a (new) PNG predictor. */
	predicted: number;
	/** Streams made smaller again by `polish`. */
	polished: number;
	skipped: number;
	outOfTime: number;
	ms: number;
	/** JPEG images repacked, left as they are (any reason), and the time spent on JPEGs. */
	jpeg: number;
	jpegSaved: number;
	jpegKept: number;
	jpegMs: number;
}

// --- qpdf JSON -------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Dict = Record<string, Json>;

export interface QpdfObject {
	value?: Json;
	stream?: { dict: Dict; datafile?: string };
}

export interface StreamDump {
	header: Record<string, Json>;
	objects: Record<string, QpdfObject>;
	/** Raw (still encoded) stream data by object key ("obj:12 0 R"). */
	data: Map<string, Uint8Array>;
}

const DUMP_DIR = '/s';

/** Every object of the file and the raw bytes of every stream, or null if qpdf cannot dump it. */
export async function dumpStreams(qpdf: Qpdf, bytes: Uint8Array): Promise<StreamDump | null> {
	const res = await qpdf.run({
		args: ['--json-output', '--decode-level=none', '--json-stream-data=file', `--json-stream-prefix=${DUMP_DIR}/x`, '/d.pdf', '/d.json'],
		inputs: { '/d.pdf': bytes },
		outputs: ['/d.json'],
		outputDirs: [DUMP_DIR]
	});
	const file = res.files.get('/d.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	let parsed: { qpdf: [Record<string, Json>, Record<string, QpdfObject>] };
	try {
		parsed = JSON.parse(new TextDecoder().decode(file));
	} catch {
		return null;
	}
	const [header, objects] = parsed.qpdf;
	const data = new Map<string, Uint8Array>();
	for (const [key, obj] of Object.entries(objects)) {
		const f = obj.stream?.datafile;
		if (!f) continue;
		const d = res.files.get(f);
		if (!d) return null;
		data.set(key, d);
	}
	return { header, objects, data };
}

const REF = /^(\d+) (\d+) R$/;

/** The direct value behind an indirect reference (one level is enough for qpdf output). */
export function resolve(objects: Record<string, QpdfObject>, v: Json | undefined, depth = 0): Json | undefined {
	if (typeof v === 'string' && REF.test(v) && depth < 8) {
		const o = objects[`obj:${v}`];
		if (!o) return null;
		return o.stream ? (o.stream.dict as Json) : resolve(objects, o.value, depth + 1);
	}
	return v;
}

function isDict(v: Json | undefined): v is Dict {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// --- zlib helpers ----------------------------------------------------------------------

function adler32(d: Uint8Array): number {
	let a = 1;
	let b = 0;
	const n = d.length;
	let i = 0;
	while (i < n) {
		const end = Math.min(i + 3800, n);
		for (; i < end; i++) {
			a += d[i];
			b += a;
		}
		a %= 65521;
		b %= 65521;
	}
	return ((b << 16) | a) >>> 0;
}

/**
 * Inflates a zlib stream only when it is exactly one complete, intact zlib stream
 * (valid header, no preset dictionary, Adler-32 matching), optionally followed by
 * whitespace. Anything else (damaged, truncated, junk after the end) gives null:
 * such a stream is left exactly as it is.
 */
export function strictInflate(raw: Uint8Array, maxOut = Infinity): Uint8Array | null {
	// The checksum's own last bytes may look like end-of-line padding: try the whole
	// stream, then one padding byte less at a time (up to 15).
	const pad = (b: number) => b === 0x0a || b === 0x0d || b === 0x20 || b === 0x09 || b === 0x00;
	for (let end = raw.length, tries = 0; end > 0 && tries < 16; end--, tries++) {
		const r = inflateExact(raw, end, maxOut);
		if (r !== undefined) return r;
		if (!pad(raw[end - 1])) return null;
	}
	return null;
}

/** raw[0, end) as one zlib stream: its data, null when too big, undefined when not exact. */
function inflateExact(raw: Uint8Array, end: number, maxOut: number): Uint8Array | null | undefined {
	if (end < 6) return undefined;
	const cmf = raw[0];
	const flg = raw[1];
	if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) return undefined;
	let out: Uint8Array;
	try {
		out = inflateSync(raw.subarray(2, end - 4));
	} catch {
		return undefined;
	}
	const want = ((raw[end - 4] << 24) | (raw[end - 3] << 16) | (raw[end - 2] << 8) | raw[end - 1]) >>> 0;
	if (adler32(out) !== want) return undefined;
	return out.length > maxOut ? null : out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

// --- predictors ------------------------------------------------------------------------

interface Predictor {
	predictor: number;
	colors: number;
	bpc: number;
	columns: number;
}

/** /DecodeParms of a single-filter stream: null when absent, undefined when not understood. */
function predictorOf(objects: Record<string, QpdfObject>, parms: Json | undefined): Predictor | null | undefined {
	if (parms === undefined || parms === null) return null;
	const p = resolve(objects, parms);
	if (p === null) return null;
	if (!isDict(p)) return undefined;
	const num = (k: string, dflt: number) => {
		const v = resolve(objects, p[k]);
		return v === undefined || v === null ? dflt : typeof v === 'number' && Number.isInteger(v) ? v : NaN;
	};
	const predictor = num('/Predictor', 1);
	const r = { predictor, colors: num('/Colors', 1), bpc: num('/BitsPerComponent', 8), columns: num('/Columns', 1) };
	if (![r.predictor, r.colors, r.bpc, r.columns].every(Number.isFinite)) return undefined;
	return r.predictor === 1 ? null : r;
}

/** Undoes a PNG (10-15) or TIFF (2, 8-bit) predictor; null when the layout does not fit the data exactly. */
export function unpredict(d: Uint8Array, p: Predictor): Uint8Array | null {
	if (p.colors < 1 || p.colors > 32 || p.columns < 1 || ![1, 2, 4, 8, 16].includes(p.bpc)) return null;
	const bpp = Math.max(1, Math.ceil((p.colors * p.bpc) / 8));
	const row = Math.ceil((p.colors * p.bpc * p.columns) / 8);
	if (p.predictor === 2) {
		if (p.bpc !== 8 || d.length % row !== 0) return null;
		const out = d.slice();
		for (let r = 0; r < out.length; r += row) for (let i = r + bpp; i < r + row; i++) out[i] = (out[i] + out[i - bpp]) & 0xff;
		return out;
	}
	if (p.predictor < 10 || p.predictor > 15) return null;
	if (d.length % (row + 1) !== 0) return null;
	const h = d.length / (row + 1);
	const out = new Uint8Array(row * h);
	for (let y = 0; y < h; y++) {
		const type = d[y * (row + 1)];
		const src = y * (row + 1) + 1;
		const o = y * row;
		const up = o - row;
		for (let i = 0; i < row; i++) {
			const x = d[src + i];
			const a = i >= bpp ? out[o + i - bpp] : 0;
			const b = y > 0 ? out[up + i] : 0;
			let v: number;
			switch (type) {
				case 0:
					v = x;
					break;
				case 1:
					v = x + a;
					break;
				case 2:
					v = x + b;
					break;
				case 3:
					v = x + ((a + b) >> 1);
					break;
				case 4: {
					const c = y > 0 && i >= bpp ? out[up + i - bpp] : 0;
					const pp = a + b - c;
					const pa = Math.abs(pp - a);
					const pb = Math.abs(pp - b);
					const pc = Math.abs(pp - c);
					v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
					break;
				}
				default:
					return null;
			}
			out[o + i] = v & 0xff;
		}
	}
	return out;
}

// --- the pass --------------------------------------------------------------------------

/** Filters of a stream as names, or null when not a plain name / one-element array. */
function filtersOf(objects: Record<string, QpdfObject>, f: Json | undefined): string[] | null {
	const v = resolve(objects, f);
	if (v === undefined || v === null) return [];
	if (typeof v === 'string') return [v];
	if (Array.isArray(v) && v.every((x) => typeof resolve(objects, x) === 'string')) return v.map((x) => resolve(objects, x) as string);
	return null;
}

const FLATE = new Set(['/FlateDecode', '/Fl']);

interface Choice {
	/** Bytes that were deflated (what a decoder gets back after inflating); for a bare JPEG, the JPEG. */
	input: Uint8Array;
	data: Uint8Array;
	dict: Dict;
	predicted: boolean;
	/** A repacked JPEG: never polished (bare: `data` is the JPEG itself). */
	jpeg?: boolean;
}

/**
 * The cheapest exact encoding of one stream, or null to leave it as it is.
 * `raw` is the stored data, `dict` its dictionary (qpdf JSON form). The result
 * is checked: inflating `data` gives `input`, and for a new predictor,
 * un-predicting `input` gives the image's pixels.
 */
export async function packStream(
	objects: Record<string, QpdfObject>,
	dict: Dict,
	raw: Uint8Array,
	deflate: Deflater,
	maxStreamBytes = 64 * 1024 * 1024
): Promise<Choice | null> {
	const type = resolve(objects, dict['/Type']);
	if (type === '/Metadata' || type === '/XRef' || type === '/ObjStm') return null;
	if ('/F' in dict || '/FFilter' in dict) return null;
	const filters = filtersOf(objects, dict['/Filter']);
	if (filters === null || filters.length > 1) return null;
	const flate = filters.length === 1;
	if (flate && !FLATE.has(filters[0])) return null;
	let parmsJson = dict['/DecodeParms'];
	if (Array.isArray(parmsJson)) {
		if (parmsJson.length > 1) return null;
		parmsJson = parmsJson[0] ?? null;
	}
	const pred = flate ? predictorOf(objects, parmsJson) : null;
	if (pred === undefined) return null;
	if (!flate && dict['/DecodeParms'] !== undefined) return null;

	const decoded = flate ? strictInflate(raw, maxStreamBytes) : raw;
	if (!decoded || decoded.length > maxStreamBytes) return null;

	const base: Dict = { ...dict };
	if (!flate) base['/Filter'] = '/FlateDecode';
	// What each candidate deflates, and the dictionary that goes with it.
	const cands: { input: Uint8Array; dict: Dict; predicted: boolean; check?: (input: Uint8Array) => boolean }[] = [
		{ input: decoded, dict: base, predicted: false }
	];

	if (resolve(objects, dict['/Subtype']) === '/Image' && resolve(objects, dict['/ImageMask']) !== true) {
		const w = resolve(objects, dict['/Width']);
		const h = resolve(objects, dict['/Height']);
		const bpc = resolve(objects, dict['/BitsPerComponent']);
		if (typeof w === 'number' && typeof h === 'number' && Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && bpc === 8) {
			const pixels = pred ? unpredict(decoded, pred) : decoded;
			const n = pixels ? pixels.length / (w * h) : 0;
			if (pixels && Number.isInteger(n) && n >= 1 && n <= 8) {
				const png = { predictor: 15, colors: n, bpc: 8, columns: w };
				// C1 unless the file already has a PNG predictor laid out like ours that
				// filters its rows (then the producer has made this choice already).
				const same = pred && pred.predictor >= 10 && pred.colors === n && pred.bpc === 8 && pred.columns === w;
				if (!same || !filtersRows(decoded, w * n)) {
					const parms: Dict = { '/BitsPerComponent': 8, '/Colors': n, '/Columns': w, '/Predictor': 15 };
					cands.push({
						input: pngPredict(pixels, w, h, n),
						dict: { ...base, '/Filter': '/FlateDecode', '/DecodeParms': parms },
						predicted: true,
						// Checked only if chosen: a viewer's un-prediction gives back the pixels.
						check: (input) => {
							const back = unpredict(input, png);
							return back !== null && sameBytes(back, pixels);
						}
					});
				}
				// C2: the plain pixels (what qpdf wrote).
				if (pred) {
					const c2: Dict = { ...base, '/Filter': '/FlateDecode' };
					delete c2['/DecodeParms'];
					cands.push({ input: pixels, dict: c2, predicted: false });
				}
			}
		}
	}

	// Every candidate is deflated in full: picking by samples chose badly on large images
	// with flat areas (a survey file came out 9% bigger than qpdf's).
	let best: (Choice & { check?: (input: Uint8Array) => boolean }) | null = null;
	for (const c of cands) {
		const data = await deflate.zlib(c.input);
		// A changed dictionary costs a few bytes too; demand a clear gain for it.
		const dictCost = c.dict['/DecodeParms'] !== dict['/DecodeParms'] || c.dict['/Filter'] !== dict['/Filter'] ? 72 : 0;
		if (data.length + dictCost < (best ? best.data.length : raw.length)) best = { ...c, data };
	}
	if (!best) return null;
	if (best.check && !best.check(best.input)) return null;
	if (!checks(best.data, best.input)) return null;
	return { input: best.input, data: best.data, dict: best.dict, predicted: best.predicted };
}

const DCT = '/DCTDecode';

/** True when the stream is a JPEG the pass may consider (an image, DCT last). */
export function isJpegImage(objects: Record<string, QpdfObject>, dict: Dict): boolean {
	const f = filtersOf(objects, dict['/Filter']);
	return !!f && f.length > 0 && f[f.length - 1] === DCT && resolve(objects, dict['/Subtype']) === '/Image';
}

/**
 * J: the repacked JPEG of one image stream, or the reason it stays as it is. Checks, in
 * order: an image XObject with /DCTDecode alone or [/FlateDecode /DCTDecode] (no
 * predictor, intact zlib data); the JPEG's markers (jpeg.ts: one 8-bit Huffman frame,
 * SOI to EOI); the coefficient buffers under `maxCoef`; libjpeg reads it without a
 * warning; the output is baseline with the same frame and the same colour segments byte
 * for byte; the stored stream is smaller; and a second, separate decode of input and
 * output finds every DCT coefficient identical. The dictionary is not changed.
 */
export async function packJpegStream(
	objects: Record<string, QpdfObject>,
	dict: Dict,
	raw: Uint8Array,
	deflate: Deflater,
	maxCoef = JPEG_MAX_COEF,
	maxStreamBytes = 64 * 1024 * 1024
): Promise<{ choice: Choice } | { why: string }> {
	if (resolve(objects, dict['/Subtype']) !== '/Image') return { why: 'not an image' };
	if ('/F' in dict || '/FFilter' in dict) return { why: 'external' };
	const filters = filtersOf(objects, dict['/Filter']);
	if (!filters) return { why: 'filters' };
	const flate = filters.length === 2 && FLATE.has(filters[0]) && filters[1] === DCT;
	if (!(flate || (filters.length === 1 && filters[0] === DCT))) return { why: `filters ${filters.join(' ')}` };
	if (flate) {
		const parms = resolve(objects, dict['/DecodeParms']);
		if (parms !== undefined && parms !== null) {
			if (!Array.isArray(parms) || parms.length !== 2) return { why: 'decode parameters' };
			if (predictorOf(objects, parms[0]) !== null) return { why: 'predictor on the Flate filter' };
		}
	}
	const jpeg = flate ? strictInflate(raw, maxStreamBytes) : raw;
	if (!jpeg) return { why: 'damaged Flate data' };
	const parsed = parseJpeg(jpeg);
	if (!parsed.ok) return { why: parsed.why };
	const refusal = repackRefusal(parsed.info);
	if (refusal) return { why: refusal };
	if (parsed.info.coefBytes > maxCoef) return { why: 'too big' };
	const r = await repackJpeg(jpeg, maxCoef);
	if (!r.ok) return { why: `libjpeg: ${r.why}${r.code ? ` ${r.code}` : ''}` };
	const out = parseJpeg(r.jpeg);
	if (!out.ok) return { why: `output: ${out.why}` };
	const changed = outputRefusal(parsed.info, out.info);
	if (changed) return { why: changed };
	const data = flate ? await deflate.zlib(r.jpeg) : r.jpeg;
	if (data.length >= raw.length) return { why: 'not smaller' };
	if (flate && !checks(data, r.jpeg)) return { why: 'deflate check' };
	if (!(await verifyJpeg(jpeg, r.jpeg, maxCoef))) return { why: 'coefficients differ' };
	return { choice: { input: r.jpeg, data, dict, predicted: false, jpeg: true } };
}

/**
 * The rule the app uses for "this file is signed" (PDF.js IsSignaturesPresent: the
 * AcroForm's /SigFlags bit 1), widened to any signature dictionary (/Type /Sig or a
 * /ByteRange), since assembling may drop /SigFlags while keeping the fields.
 */
export function isSigned(objects: Record<string, QpdfObject>): boolean {
	const look = (v: Json | undefined, depth: number): boolean => {
		if (!isDict(v) || depth > 3) return false;
		if (v['/Type'] === '/Sig' || '/ByteRange' in v) return true;
		const flags = v['/SigFlags'];
		if (typeof flags === 'number' && flags & 1) return true;
		for (const x of Object.values(v)) if (isDict(x) && look(x, depth + 1)) return true;
		return false;
	};
	for (const o of Object.values(objects)) if (!o.stream && look(o.value, 0)) return true;
	return false;
}

/** True when inflating `data` gives exactly `input`. */
function checks(data: Uint8Array, input: Uint8Array): boolean {
	const back = strictInflate(data);
	return back !== null && sameBytes(back, input);
}

/** True when a PNG-predicted buffer uses any row filter other than None. */
function filtersRows(d: Uint8Array, row: number): boolean {
	for (let i = 0; i < d.length; i += row + 1) if (d[i] !== 0) return true;
	return false;
}

/**
 * Re-encodes the streams of `bytes` (a file without object streams, as every
 * export stage writes) where that makes them smaller, exactly. Returns the new
 * file (or `bytes` itself when nothing changed or anything went wrong) and stats.
 * `dump` may be passed when the caller already has one of these same bytes.
 */
export async function packStreams(
	qpdf: Qpdf,
	bytes: Uint8Array,
	opts: PackOptions = {},
	dump?: StreamDump | null
): Promise<{ bytes: Uint8Array; stats: PackStats }> {
	const t0 = now();
	const note = opts.note ?? (() => {});
	const deflate = opts.deflate ?? nativeDeflate;
	const stats: PackStats = { streams: 0, changed: 0, saved: 0, predicted: 0, polished: 0, skipped: 0, outOfTime: 0, ms: 0, jpeg: 0, jpegSaved: 0, jpegKept: 0, jpegMs: 0 };
	const done = (b: Uint8Array) => {
		stats.ms = Math.round(now() - t0);
		return { bytes: b, stats };
	};
	const d = dump ?? (await dumpStreams(qpdf, bytes));
	if (!d) {
		note('pack: qpdf could not dump the streams; left as they are');
		return done(bytes);
	}
	const keys = [...d.data.keys()].sort((a, b) => d.data.get(b)!.length - d.data.get(a)!.length);
	const chosen = new Map<string, Choice>();
	const jpeg = await jpegPass(d, opts, note);
	let deadline = opts.deadline;
	const progress = opts.progress;
	let seen = 0;
	const all = progress ? keys.reduce((n, k) => n + d.data.get(k)!.length, 0) : 0;
	progress?.(0, all);
	for (const key of keys) {
		const raw = d.data.get(key)!;
		if (progress) {
			progress(seen, all);
			seen += raw.length;
		}
		const obj = d.objects[key];
		if (!obj.stream) continue;
		stats.streams++;
		if (raw.length < 16) continue;
		if (isJpegImage(d.objects, obj.stream.dict)) {
			// JPEG time has its own budget and does not count against the Flate deadline.
			const t = now();
			const c = await jpeg.one(key, obj.stream.dict, raw, deflate);
			const dt = now() - t;
			stats.jpegMs += dt;
			if (deadline !== undefined) deadline += dt;
			if (c) {
				chosen.set(key, c);
				stats.jpeg++;
				stats.jpegSaved += raw.length - c.data.length;
			} else stats.jpegKept++;
			continue;
		}
		if (deadline !== undefined && now() > deadline) {
			stats.outOfTime++;
			continue;
		}
		let choice: Choice | null = null;
		try {
			choice = await packStream(d.objects, obj.stream.dict, raw, deflate, opts.maxStreamBytes);
		} catch (e) {
			stats.skipped++;
			note(`pack: ${key} skipped (${e instanceof Error ? e.message : String(e)})`);
			continue;
		}
		if (choice) chosen.set(key, choice);
	}
	if (stats.outOfTime) note(`pack: time budget spent, ${stats.outOfTime} streams left as they are`);
	jpeg.done(stats);

	// Polish: the same input through the stronger compressor, biggest first, while time remains.
	const polishBy = opts.polishMs !== undefined ? now() + opts.polishMs : undefined;
	if (opts.polish) {
		// Throughput seen so far (bytes per ms), starting from a cautious guess, so a
		// stream that would run past the deadline is not started.
		let rate = 2_000;
		let polishLeft = opts.polishBytes ?? Infinity;
		let spentMs = 0;
		let spentBytes = 0;
		for (const key of keys) {
			const c = chosen.get(key) ?? null;
			if (c?.jpeg) continue;
			if (polishBy !== undefined && now() > polishBy) break;
			const raw = d.data.get(key)!;
			let input: Uint8Array | null = c?.input ?? null;
			let dict = c?.dict ?? null;
			if (!c) {
				// Not re-encoded by the fast pass: a plain Flate stream may still shrink.
				const obj = d.objects[key].stream!;
				const f = filtersOf(d.objects, obj.dict['/Filter']);
				if (!f || f.length !== 1 || !FLATE.has(f[0]) || raw.length < 64) continue;
				const t = resolve(d.objects, obj.dict['/Type']);
				if (t === '/Metadata' || '/F' in obj.dict) continue;
				input = strictInflate(raw, opts.maxStreamBytes ?? 64 * 1024 * 1024);
				dict = obj.dict;
			}
			if (!input || !dict) continue;
			if (polishBy !== undefined && now() + input.length / rate > polishBy) continue;
			if (input.length > polishLeft) continue;
			polishLeft -= input.length;
			let data: Uint8Array;
			try {
				const t = now();
				data = await opts.polish.zlib(input);
				spentMs += now() - t;
				spentBytes += input.length;
				if (spentMs > 50) rate = spentBytes / spentMs;
			} catch (e) {
				note(`pack: polish failed (${e instanceof Error ? e.message : String(e)}); fast encodings kept`);
				break;
			}
			if (data.length < (c ? c.data.length : raw.length) && checks(data, input)) {
				chosen.set(key, { input, data, dict, predicted: c?.predicted ?? false });
				stats.polished++;
			}
		}
	}

	const updates: Record<string, { stream: { dict: Dict; datafile: string } }> = {};
	const inputs: Record<string, Uint8Array> = { '/p.pdf': bytes };
	let i = 0;
	for (const [key, choice] of chosen) {
		const file = `/u/${i++}`;
		updates[key] = { stream: { dict: choice.dict, datafile: file } };
		inputs[file] = choice.data;
		stats.changed++;
		stats.saved += d.data.get(key)!.length - choice.data.length;
		if (choice.predicted) stats.predicted++;
	}
	if (stats.changed === 0) return done(bytes);
	inputs['/u.json'] = new TextEncoder().encode(JSON.stringify({ qpdf: [d.header, updates] }));
	const res = await qpdf.run({
		args: ['/p.pdf', '--update-from-json=/u.json', '--compress-streams=n', '--decode-level=none', '--object-streams=disable', '/q.pdf'],
		inputs,
		outputs: ['/q.pdf']
	});
	const out = res.files.get('/q.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !out) {
		note(`pack: qpdf could not write the packed streams (exit ${res.code}); left as they are`);
		stats.changed = 0;
		stats.saved = 0;
		return done(bytes);
	}
	return done(out);
}

/**
 * The JPEG side of the pass: loads the module once (only when the file has a JPEG image),
 * applies the file-level rules (signed files, module that does not load) and the budgets,
 * and repacks one image at a time. Every refusal is a debug note; the stream stays as it is.
 */
async function jpegPass(d: StreamDump, opts: PackOptions, note: (s: string) => void) {
	const o = opts.jpeg;
	const reasons = new Map<string, number>();
	const keep = (why: string) => {
		reasons.set(why, (reasons.get(why) ?? 0) + 1);
		return null;
	};
	let enabled = !!o;
	let anyJpeg = false;
	for (const [key, obj] of Object.entries(d.objects)) if (obj.stream && d.data.has(key) && isJpegImage(d.objects, obj.stream.dict)) anyJpeg = true;
	if (enabled && anyJpeg && (o as JpegPassOptions).signed) {
		note('pack: signed file, JPEG images left as they are');
		enabled = false;
	}
	if (enabled && anyJpeg) {
		try {
			await loadJpegRepack();
		} catch (e) {
			note(`pack: JPEG repack did not load (${e instanceof Error ? e.message : String(e)}); JPEG images left as they are`);
			enabled = false;
		}
	}
	const cfg = o || {};
	const maxCoef = cfg.maxCoefBytes ?? JPEG_MAX_COEF;
	const start = now();
	let bytesLeft = cfg.bytes ?? Infinity;
	// Throughput (JPEG bytes per ms, repack and check), starting from a cautious guess,
	// so an image that would run past the time cap is not started.
	let rate = 2_000;
	let spentMs = 0;
	let spentBytes = 0;
	return {
		async one(key: string, dict: Dict, raw: Uint8Array, deflate: Deflater): Promise<Choice | null> {
			if (!enabled) return keep(o ? 'off for this file' : 'off');
			if (cfg.ms !== undefined && now() + raw.length / rate > start + cfg.ms) return keep('out of time');
			if (raw.length > bytesLeft) return keep('over the work budget');
			bytesLeft -= raw.length;
			const t = now();
			let r: Awaited<ReturnType<typeof packJpegStream>>;
			try {
				r = await packJpegStream(d.objects, dict, raw, deflate, maxCoef);
			} catch (e) {
				r = { why: `error ${e instanceof Error ? e.message : String(e)}` };
			}
			spentMs += now() - t;
			spentBytes += raw.length;
			if (spentMs > 50) rate = spentBytes / spentMs;
			if ('why' in r) {
				if (r.why === 'coefficients differ') note(`pack: ${key} JPEG repack failed its coefficient check; left as it is`);
				return keep(r.why);
			}
			return r.choice;
		},
		done(stats: PackStats) {
			if (!anyJpeg) return;
			const why = [...reasons].map(([k, n]) => `${k} ${n}`).join(', ');
			note(`pack: JPEG ${stats.jpeg} repacked (${stats.jpegSaved} bytes saved), ${stats.jpegKept} left as they are${why ? ` (${why})` : ''}, ${Math.round(stats.jpegMs)} ms`);
		}
	};
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
