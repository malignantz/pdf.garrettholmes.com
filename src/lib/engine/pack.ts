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
 *   C2 8-bit images that had a predictor: the pixels with none (what qpdf wrote).
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
	/** Debug notes (never shown to the user). */
	note?: (s: string) => void;
}

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
	let end = raw.length;
	while (end > 0 && (raw[end - 1] === 0x0a || raw[end - 1] === 0x0d || raw[end - 1] === 0x20 || raw[end - 1] === 0x09 || raw[end - 1] === 0x00)) end--;
	if (end < 6) return null;
	const cmf = raw[0];
	const flg = raw[1];
	if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7 || ((cmf << 8) | flg) % 31 !== 0 || flg & 0x20) return null;
	let out: Uint8Array;
	try {
		out = inflateSync(raw.subarray(2, end - 4));
	} catch {
		return null;
	}
	if (out.length > maxOut) return null;
	const want = ((raw[end - 4] << 24) | (raw[end - 3] << 16) | (raw[end - 2] << 8) | raw[end - 1]) >>> 0;
	return adler32(out) === want ? out : null;
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
	/** Bytes that were deflated (what a decoder gets back after inflating). */
	input: Uint8Array;
	data: Uint8Array;
	dict: Dict;
	predicted: boolean;
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
	const stats: PackStats = { streams: 0, changed: 0, saved: 0, predicted: 0, polished: 0, skipped: 0, outOfTime: 0, ms: 0 };
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
	for (const key of keys) {
		const raw = d.data.get(key)!;
		const obj = d.objects[key];
		if (!obj.stream) continue;
		stats.streams++;
		if (raw.length < 16) continue;
		if (opts.deadline !== undefined && now() > opts.deadline) {
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

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
