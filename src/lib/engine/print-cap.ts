/**
 * Print-size cap ("Reduce oversized pictures", ExportOptions.printCap; compressed
 * exports only). A PDF is for printing and reading: a photo or scan holding more
 * pixels than a 300 ppi print of the size it is drawn at only costs file size. Such
 * pictures are brought down to 300 ppi as drawn (JPEG); everything else stays
 * exactly as it is. See the plan's "Print-size cap for pictures".
 *
 *   1. qpdf lists every object (no stream data). Nothing to do unless an 8-bit image
 *      of at least CAP_MIN_PIXELS exists, so MuPDF is not loaded for ordinary files;
 *      a digitally signed file is left alone (the JPEG repack's rule).
 *   2. MuPDF finds the images and the largest size each is drawn at (shrink.ts
 *      `findCandidates`: only plain 8-bit grey/RGB images whose every use was
 *      walked; masks, 1-bit, CMYK, indexed, /Decode, annotation, pattern and Type 3
 *      images are never candidates). A candidate is capped when 300 ppi as drawn
 *      keeps at most CAP_KEEP of its pixels, it is photo-like (a JPEG source, or
 *      shrink.ts `isPhotoLike` on its samples: screenshots, logos and charts stay),
 *      and it fits the memory rule (CAP_MAX_PIXELS_JPEG / CAP_MAX_PIXELS_OTHER).
 *   3. One image at a time: decoded, scaled by MuPDF's draw device, encoded as JPEG
 *      at the source's own quality estimate, at most CAP_QUALITY; kept only when the
 *      new stream is at most CAP_GAIN of the old one.
 *   4. qpdf writes the new streams back (--update-from-json: every other object
 *      byte for byte, unlike a MuPDF save, which rounds real numbers).
 *   5. Visual check (shrink.ts `compareDocs`) of every page that shows a changed
 *      picture; a page that differs gets its pictures back and is checked again;
 *      if it still differs, nothing is changed.
 *
 * Any doubt (an error, a check that fails) means the file goes on unchanged: the
 * stage never fails an export. Cancel (ExportControl.signal) is honoured between
 * images; progress is reported per image ({ stage: 'pictures' }).
 */

import type { PDFDocument, Pixmap } from 'mupdf';
import type { ExportControl, PageSize } from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { isRetired, isWasmFault, rethrowFault, type Mupdf } from './mupdf';
import { outputRefusal, parseJpeg } from './jpeg';
import { repackJpeg, verifyJpeg } from './jpeg-repack';
import { isSigned, resolve, type QpdfObject } from './pack';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';
import { LIMITS, MIN_SIDE, RENDER_PPI, compareDocs, findCandidates, isPhotoLike, stripJpeg, type Candidate, type Limits } from './shrink';

/** The print resolution pictures are brought down to, as drawn. */
export const CAP_PPI = 300;
/** JPEG quality ceiling; a JPEG source is never encoded above its own estimated quality. */
export const CAP_QUALITY = 85;
/** Capped only when 300 ppi keeps at most this share of the pixels (0.8: above about 335 ppi). */
export const CAP_KEEP = 0.8;
/** A capped image is used only when its stream is at most this share of the original stream. */
export const CAP_GAIN = 0.8;
/** Smaller images are left alone (and do not make the stage load MuPDF). */
export const CAP_MIN_PIXELS = 500_000;
/**
 * Memory: a JPEG is decoded by MuPDF from its compressed data (about 7 bytes a pixel
 * at the peak, measured: 50 MP ≈ 350 MB); other images are read as samples and copied
 * (about twice that). Larger images are left alone rather than risk a phone's heap.
 */
export const CAP_MAX_PIXELS_JPEG = 50_000_000;
export const CAP_MAX_PIXELS_OTHER = 25_000_000;

export interface CapRules {
	ppi: number;
	quality: number;
	/** Encode JPEG sources at no more than their own estimated quality. */
	matchSource: boolean;
	keep: number;
	gain: number;
	minPixels: number;
	maxPixelsJpeg: number;
	maxPixelsOther: number;
}

/** The rules the app uses (EngineOptions.printCapRules overrides them for measurements only). */
export const CAP_RULES: Readonly<CapRules> = {
	ppi: CAP_PPI,
	quality: CAP_QUALITY,
	matchSource: true,
	keep: CAP_KEEP,
	gain: CAP_GAIN,
	minPixels: CAP_MIN_PIXELS,
	maxPixelsJpeg: CAP_MAX_PIXELS_JPEG,
	maxPixelsOther: CAP_MAX_PIXELS_OTHER
};

/** Pixel size of a capped image, or null when the cap leaves it alone (too few pixels to drop). */
export function capSize(width: number, height: number, inW: number, inH: number, r: CapRules = CAP_RULES): [number, number] | null {
	if (!(inW > 0 && inH > 0)) return null;
	// (A tolerance: 4.8 in drawn from 345.6 pt is 4.8000000000000007 in floating point.)
	const w = Math.min(width, Math.max(1, Math.ceil(inW * r.ppi - 1e-6)));
	const h = Math.min(height, Math.max(1, Math.ceil(inH * r.ppi - 1e-6)));
	return w * h <= r.keep * width * height ? [w, h] : null;
}

/** Effective resolution of an image drawn at inW × inH inches (pixels per inch, area-weighted). */
export function effectivePpi(width: number, height: number, inW: number, inH: number): number {
	return Math.sqrt((width * height) / Math.max(1e-12, inW * inH));
}

export interface CapBuild {
	/** The file with the capped pictures, not finalized. */
	bytes: Uint8Array;
	/** Pictures changed. */
	images: number;
	/** Stored stream bytes saved over the changed pictures. */
	streamSaved: number;
	/** The visual check's detail line. */
	visual: string;
	/** The resolution pictures were brought down to. */
	ppi: number;
}

export interface CapOptions {
	control?: ExportControl;
	debug?: (note: string) => void;
	/** Measurement and test hooks. */
	rules?: Partial<CapRules>;
	limits?: Limits;
	trace?: (line: string) => void;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Objects = Record<string, QpdfObject>;
interface Listing {
	header: Record<string, Json>;
	objects: Objects;
}

const cancelled = () => new EngineError('cancelled', 'Export cancelled. Nothing was saved.');
const now = () => performance.now();
const ms = (t: number) => Math.round(performance.now() - t);

/**
 * Caps the oversized pictures of `bytes` (a file after the stamp stage, no object
 * streams). Returns the new file and what changed, or null when nothing changed.
 * Throws only EngineError 'cancelled' and MuPDF traps (core.ts replaces MuPDF).
 */
export async function capPictures(deps: EngineDeps, bytes: Uint8Array, opts: CapOptions = {}): Promise<CapBuild | null> {
	const note = opts.debug ?? (() => {});
	const r: CapRules = { ...CAP_RULES, ...opts.rules };
	const trace = opts.trace ?? (() => {});
	const signal = opts.control?.signal;
	const check = () => {
		if (signal?.aborted) throw cancelled();
	};
	const t0 = now();
	let t = t0;
	const list = await listObjects(deps.qpdf, bytes);
	if (!list) {
		note('print-cap: qpdf could not list the objects; pictures left as they are');
		return null;
	}
	const big = bigImages(list.objects, r);
	trace(`listing ${ms(t)} ms: ${big.size} big images`);
	if (big.size === 0) return null;
	if (isSigned(list.objects)) {
		note('print-cap: signed file, pictures left as they are');
		return null;
	}
	check();
	let m: Mupdf;
	try {
		m = await deps.mupdf();
	} catch {
		note('print-cap: MuPDF did not load; pictures left as they are');
		return null;
	}
	let orig: PDFDocument | null = null;
	try {
		t = now();
		orig = new m.PDFDocument(bytes);
		const found = findCandidates(orig).filter((c) => big.has(c.num) && pick(c, r, note));
		// Flat-colour images are told apart on their samples before counting, so the count is
		// the dialog's (Engine.oversizedPictures); photo-like ones are decoded again below.
		const cands: Candidate[] = [];
		for (const c of found) {
			check();
			if (c.jpegSource || photoLike(m, orig, c)) cands.push(c);
		}
		trace(`analysis ${ms(t)} ms: ${found.length} oversized, ${cands.length} photo-like`);
		if (cands.length === 0) return null;
		// JPEG originals: their delivered size, and any that libjpeg finds corrupt (left alone).
		const facts = await jpegFacts(deps.qpdf, bytes, orig, cands, opts.control?.onProgress && ((done, total) => opts.control!.onProgress!({ stage: 'pictures-read', done, total })));
		for (const [num, f] of facts) if (f.damaged) note(`print-cap: ${num} has JPEG data libjpeg finds corrupt; left as it is`);
		cands.splice(0, cands.length, ...cands.filter((c) => !facts.get(c.num)?.damaged));
		if (cands.length === 0) return null;
		const total = cands.length;
		const progress = (done: number) => opts.control?.onProgress?.({ stage: 'pictures', done, total });
		progress(0);
		const enc = new Map<number, Capped>();
		t = now();
		for (const [i, c] of cands.entries()) {
			check();
			// An image MuPDF reads with any complaint (damaged data it papers over) stays as it is:
			// re-encoding would bake MuPDF's guess into a clean new stream.
			const complaints: string[] = [];
			m.setLog({ error: (x: string) => complaints.push(x), warning: (x: string) => complaints.push(x) });
			let e: Capped | null;
			try {
				e = capImage(m, orig, c, r, note);
			} finally {
				m.setLog(null);
			}
			if (e && complaints.length) {
				note(`print-cap: ${c.num} read with "${complaints[0].slice(0, 80)}"; left as it is`);
				e = null;
			}
			if (e) {
				e.data = await baseline(e.data, note);
				// Measured against the original as a compressed export delivers it: a JPEG
				// source after the lossless repack (often 5–30% smaller than stored).
				e.before = facts.get(c.num)?.before ?? c.rawLength;
				if (e.data.length <= r.gain * e.before) enc.set(c.num, e);
			}
			progress(i + 1);
			// A macrotask, so the worker sees a cancel message between images.
			await new Promise((r) => setTimeout(r, 0));
		}
		trace(`encode ${ms(t)} ms: ${enc.size} of ${total} smaller`);
		check();
		if (enc.size === 0) {
			note(`print-cap: 0 of ${total} oversized pictures capped (none smaller enough), ${Math.round(now() - t0)} ms`);
			return null;
		}
		const keys = keyIndex(list.objects);
		const exclude = new Set<number>();
		const write = async () => {
			const t = now();
			const out = await writeBack(deps.qpdf, bytes, list, keys, enc, exclude);
			trace(`write ${ms(t)} ms`);
			return out;
		};
		let out = await write();
		if (!out) {
			note('print-cap: qpdf could not write the pictures back; left as they are');
			return null;
		}
		const shownOn = new Set<number>();
		for (const c of cands) if (enc.has(c.num)) for (const p of c.pages) shownOn.add(p);
		const touched = [...shownOn].sort((a, b) => a - b);
		const limits = opts.limits ?? LIMITS;
		t = now();
		const compared = opts.control?.onProgress && ((done: number, total: number) => opts.control!.onProgress!({ stage: 'compare', done, total }));
		const v = compareDocs(m, orig, out, touched, limits, compared);
		trace(`visual ${ms(t)} ms: ${touched.length} pages, ${v.failed.length} failed`);
		if (v.failed.length) {
			for (const c of cands) if ([...c.pages].some((p) => v.failed.includes(p))) exclude.add(c.num);
			if ([...enc.keys()].every((n) => exclude.has(n))) {
				note(`print-cap: pages ${v.failed.map((p) => p + 1).join(', ')} differed; pictures left as they are`);
				return null;
			}
			out = await write();
			if (!out) return null;
			const again = compareDocs(m, orig, out, v.failed, limits, compared);
			if (again.failed.length) {
				note('print-cap: pages still differed with their pictures restored; pictures left as they are');
				return null;
			}
		}
		check();
		if (isRetired(m)) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
		let images = 0;
		let saved = 0;
		for (const c of cands) {
			const e = enc.get(c.num);
			if (!e || exclude.has(c.num)) continue;
			images++;
			saved += (e.before ?? c.rawLength) - e.data.length;
		}
		note(`print-cap: ${images} of ${total} oversized pictures capped, ${saved} stream bytes saved, ${Math.round(now() - t0)} ms`);
		const shown = touched.filter((p) => !v.failed.includes(p)).length;
		let visual =
			`Rendered the ${shown} page${shown === 1 ? '' : 's'} with reduced pictures, before and after, at ${RENDER_PPI} pixels per inch ` +
			`and compared them in blocks: largest block difference ${v.worst.blockMean.toFixed(1)} of 255 (limit ${limits.blockMean}), ` +
			`largest colour shift ${v.worst.blockBias.toFixed(1)} (limit ${limits.blockBias}).`;
		if (v.failed.length) {
			const ps = v.failed.map((p) => p + 1);
			visual += ` Pictures on page${ps.length === 1 ? '' : 's'} ${ps.join(', ')} were kept as they were because the reduced version did not match closely enough.`;
		}
		return { bytes: out, images, streamSaved: saved, visual, ppi: r.ppi };
	} catch (e) {
		if (e instanceof EngineError && e.code === 'cancelled') throw e;
		if (isWasmFault(e) || isRetired(m)) throw e;
		note(`print-cap: ${e instanceof Error ? e.message : String(e)}; pictures left as they are`);
		return null;
	} finally {
		if (!isRetired(m)) {
			try {
				orig?.destroy();
				m.emptyStore();
			} catch (e) {
				rethrowFault(e);
			}
		}
	}
}

/** Whether a candidate is one the cap brings down (size and memory rules; photo-likeness is decided on decode). */
function pick(c: Candidate, r: CapRules, note: (s: string) => void): boolean {
	if (c.width * c.height < r.minPixels) return false;
	if (!capSize(c.width, c.height, c.inW, c.inH, r)) return false;
	const max = c.jpegSource ? r.maxPixelsJpeg : r.maxPixelsOther;
	if (c.width * c.height > max) {
		note(`print-cap: ${c.num} has ${Math.round((c.width * c.height) / 1e6)} MP, over the memory limit; left as it is`);
		return false;
	}
	return true;
}

// --- one image ---------------------------------------------------------------------------

type Capped = {
	data: Uint8Array;
	width: number;
	height: number;
	/** The original's stream size as a compressed export would deliver it (jpegFacts). */
	before?: number;
};

/**
 * What the JPEG originals among `cands` are like, before anything is decoded for the cap:
 * - `before`: the stored size as the lossless passes leave it (the repack's size when it is
 *   smaller, as pack.ts would deliver it; the coefficient check is left to that pass);
 * - `damaged`: libjpeg (the repack's module, or qpdf --check for images too big for it)
 *   finds the data corrupt. MuPDF decodes such data without a word, so re-encoding would
 *   bake its guess into a clean stream and turn a file today's export refuses into one it
 *   delivers: such images stay as they are.
 */
async function jpegFacts(
	qpdf: Qpdf,
	bytes: Uint8Array,
	doc: PDFDocument,
	cands: Candidate[],
	progress?: (done: number, total: number) => void
): Promise<Map<number, { before: number; damaged: boolean }>> {
	const out = new Map<number, { before: number; damaged: boolean }>();
	const unchecked: number[] = [];
	const jpegs = cands.filter((c) => c.jpegSource);
	for (const [i, c] of jpegs.entries()) {
		progress?.(i, jpegs.length);
		const fact = { before: c.rawLength, damaged: false };
		out.set(c.num, fact);
		const obj = doc.newIndirect(c.num);
		const f = obj.get('Filter');
		const name = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : null;
		if (name !== 'DCTDecode' && name !== 'DCT') {
			unchecked.push(c.num);
			continue;
		}
		const raw = obj.readRawStream();
		try {
			const jpeg = raw.asUint8Array();
			const a = parseJpeg(jpeg);
			if (!a.ok) fact.damaged = true;
			else if (a.info.coefBytes > BASELINE_MAX_COEF) unchecked.push(c.num);
			else {
				const r = await repackJpeg(jpeg, BASELINE_MAX_COEF);
				if (r.ok) fact.before = Math.min(c.rawLength, r.jpeg.length);
				else if (r.why === 'warning') fact.damaged = true;
				else unchecked.push(c.num);
			}
		} catch {
			unchecked.push(c.num);
		} finally {
			raw.destroy();
		}
	}
	if (unchecked.length) {
		// One qpdf --check of the file (it decodes every JPEG with libjpeg); it does not say
		// which image, so on a complaint every unchecked one stays.
		const res = await qpdf.run({ args: ['--check', '/c.pdf'], inputs: { '/c.pdf': bytes } });
		if (/Pl_DCT|JPEG/i.test(`${res.stderr}\n${res.stdout}`)) for (const n of unchecked) out.get(n)!.damaged = true;
	}
	return out;
}

/**
 * Decodes one image, scales it to 300 ppi as drawn and encodes it as JPEG. Null when
 * the image is not photo-like, cannot be read the expected way, or the result is
 * clearly over CAP_GAIN of the stored stream (the caller applies the rule exactly).
 *
 * JPEG sources without a soft mask are loaded by MuPDF from their compressed data and
 * drawn into a pixmap of their own colour space (no colour conversion: the samples are
 * those the stream decodes to, measured identical to reading the stream). Other images
 * are read as stored into a plain grey/RGB container (shrink.ts does the same). The
 * dictionary keeps its own /ColorSpace (ICC, CalRGB …) and soft mask in both cases.
 */
function capImage(m: Mupdf, doc: PDFDocument, c: Candidate, r: CapRules, note: (s: string) => void): Capped | null {
	const size = capSize(c.width, c.height, c.inW, c.inH, r);
	if (!size) return null;
	const [w, h] = size;
	const obj = doc.newIndirect(c.num);
	let quality = r.quality;
	let img: InstanceType<Mupdf['Image']> | null = null;
	let src: Pixmap | null = null;
	let dst: Pixmap | null = null;
	try {
		let cs: InstanceType<Mupdf['ColorSpace']> | null = null;
		if (c.jpegSource) {
			const q = jpegQualityOf(obj);
			if (q !== null && r.matchSource) quality = Math.min(r.quality, q);
			if (obj.get('SMask').isNull()) {
				img = doc.loadImage(obj);
				const ics = img.getColorSpace();
				if (img.getWidth() === c.width && img.getHeight() === c.height && ics && ics.getNumberOfComponents() === c.n && !img.getMask()) cs = ics;
				else {
					img.destroy();
					img = null;
				}
			}
		}
		if (!img) {
			if (c.width * c.height > r.maxPixelsOther) {
				note(`print-cap: ${c.num} would be read in full (${Math.round((c.width * c.height) / 1e6)} MP), over the memory limit; left as it is`);
				return null;
			}
			cs = c.n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB;
			const buf = obj.readStream();
			if (buf.getLength() === c.width * c.height * c.n) {
				src = new m.Pixmap(cs, [0, 0, c.width, c.height], false);
				if (src.getStride() === c.width * c.n) src.getPixels().set(buf.asUint8Array());
				else {
					src.destroy();
					src = null;
				}
			}
			buf.destroy();
			if (!src) {
				note(`print-cap: ${c.num} did not decode to the expected size; left as it is`);
				return null;
			}
			img = new m.Image(src);
		}
		dst = new m.Pixmap(cs!, [0, 0, w, h], false);
		dst.clear(255);
		const dev = new m.DrawDevice(m.Matrix.identity, dst);
		dev.fillImage(img, [w, 0, 0, h, 0, 0], 1);
		dev.close();
		dev.destroy();
		// MuPDF's JPEG writer takes the pixmap's colour space at its word (an ICC grey pixmap came
		// out as a 3-component JPEG): the samples are encoded from a plain grey/RGB container.
		const plain = c.n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB;
		if (dst.getColorSpace()?.getName() !== plain.getName()) {
			const copy = new m.Pixmap(plain, [0, 0, w, h], false);
			if (copy.getStride() !== dst.getStride() || dst.getNumberOfComponents() !== c.n) {
				copy.destroy();
				return null;
			}
			copy.getPixels().set(dst.getPixels());
			dst.destroy();
			dst = copy;
		}
		const data = stripJpeg(dst.asJPEG(quality));
		// Not worth decoding twice more (baseline, check) when even this is too big.
		if (data.length > r.gain * c.rawLength * 1.1) return null;
		return { data, width: w, height: h };
	} finally {
		dst?.destroy();
		img?.destroy();
		src?.destroy();
		m.emptyStore();
	}
}

/** Coefficient buffers above this stay as MuPDF wrote them (the repack's own limit). */
const BASELINE_MAX_COEF = 48 * 1024 * 1024;

/**
 * MuPDF writes progressive JPEGs. The same coefficients as optimised baseline (the
 * lossless repack's module, jpeg-repack.ts, checked the same way: structure, then every
 * coefficient decoded again and compared): faster to decode, and what old printers
 * and readers expect. Any refusal keeps MuPDF's file.
 */
async function baseline(jpeg: Uint8Array, note: (s: string) => void): Promise<Uint8Array> {
	try {
		const a = parseJpeg(jpeg);
		if (!a.ok || a.info.coefBytes > BASELINE_MAX_COEF) return jpeg;
		const r = await repackJpeg(jpeg, BASELINE_MAX_COEF);
		if (!r.ok) return jpeg;
		const b = parseJpeg(r.jpeg);
		if (!b.ok || outputRefusal(a.info, b.info) || !(await verifyJpeg(jpeg, r.jpeg, BASELINE_MAX_COEF))) return jpeg;
		return r.jpeg;
	} catch (e) {
		note(`print-cap: baseline repack failed (${e instanceof Error ? e.message : String(e)}); progressive kept`);
		return jpeg;
	}
}

/** Estimated quality of a JPEG source (null when it cannot be read: then CAP_QUALITY applies). */
function jpegQualityOf(obj: ReturnType<PDFDocument['newIndirect']>): number | null {
	const f = obj.get('Filter');
	const name = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : null;
	if (name !== 'DCTDecode' && name !== 'DCT') return null;
	const raw = obj.readRawStream();
	try {
		return estimateJpegQuality(raw.asUint8Array());
	} finally {
		raw.destroy();
	}
}

/** IJG luminance table (Annex K), natural order. */
const STD_LUMA = [
	16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56,
	68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99
];
const ZIGZAG = [
	0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50,
	43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63
];

/**
 * The IJG quality (1–100) whose scaled luminance table is closest on average to the
 * JPEG's first quantisation table (as ImageMagick estimates it). Cameras use their
 * own tables, so this is an estimate; null when there is no DQT before the scan.
 */
export function estimateJpegQuality(j: Uint8Array): number | null {
	if (j.length < 4 || j[0] !== 0xff || j[1] !== 0xd8) return null;
	let i = 2;
	while (i + 4 <= j.length) {
		if (j[i] !== 0xff) return null;
		const marker = j[i + 1];
		if (marker === 0xff) {
			i++;
			continue;
		}
		if (marker === 0xda || marker === 0xd9) return null;
		const len = (j[i + 2] << 8) | j[i + 3];
		if (len < 2 || i + 2 + len > j.length) return null;
		if (marker === 0xdb) {
			let k = i + 4;
			const end = i + 2 + len;
			while (k < end) {
				const pq = j[k] >> 4;
				const tq = j[k] & 15;
				const size = pq ? 128 : 64;
				if (k + 1 + size > end) return null;
				if (tq === 0) {
					let sum = 0;
					let std = 0;
					for (let z = 0; z < 64; z++) {
						sum += pq ? (j[k + 1 + 2 * z] << 8) | j[k + 2 + 2 * z] : j[k + 1 + z];
						std += STD_LUMA[ZIGZAG[z]];
					}
					const scale = (100 * sum) / std;
					const q = scale <= 100 ? (200 - scale) / 2 : 5000 / scale;
					return Math.max(1, Math.min(100, Math.round(q)));
				}
				k += 1 + size;
			}
		}
		i += 2 + len;
	}
	return null;
}

// --- qpdf: listing and writing back ----------------------------------------------------------

async function listObjects(qpdf: Qpdf, bytes: Uint8Array): Promise<Listing | null> {
	const res = await qpdf.run({
		args: ['--json-output', '--json-stream-data=none', '/l.pdf', '/l.json'],
		inputs: { '/l.pdf': bytes },
		outputs: ['/l.json']
	});
	const file = res.files.get('/l.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, Json>, Objects] };
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
	} catch {
		return null;
	}
}

/** Object numbers of 8-bit image streams with at least CAP_MIN_PIXELS pixels. */
function bigImages(objects: Objects, r: CapRules): Set<number> {
	const out = new Set<number>();
	for (const [key, o] of Object.entries(objects)) {
		const d = o.stream?.dict;
		if (!d || resolve(objects, d['/Subtype']) !== '/Image') continue;
		const w = resolve(objects, d['/Width']);
		const h = resolve(objects, d['/Height']);
		const bpc = resolve(objects, d['/BitsPerComponent']);
		if (typeof w !== 'number' || typeof h !== 'number' || bpc !== 8) continue;
		if (resolve(objects, d['/ImageMask']) === true) continue;
		if (w < MIN_SIDE || h < MIN_SIDE || w * h < r.minPixels) continue;
		const m = /^obj:(\d+) \d+ R$/.exec(key);
		if (m) out.add(Number(m[1]));
	}
	return out;
}

function keyIndex(objects: Objects): Map<number, string> {
	const out = new Map<number, string>();
	for (const key of Object.keys(objects)) {
		const m = /^obj:(\d+) \d+ R$/.exec(key);
		if (m) out.set(Number(m[1]), key);
	}
	return out;
}

async function writeBack(
	qpdf: Qpdf,
	bytes: Uint8Array,
	list: Listing,
	keys: Map<number, string>,
	enc: Map<number, Capped>,
	exclude: Set<number>
): Promise<Uint8Array | null> {
	const updates: Record<string, { stream: { dict: Record<string, Json>; datafile: string } }> = {};
	const inputs: Record<string, Uint8Array> = { '/p.pdf': bytes };
	let i = 0;
	for (const [num, e] of enc) {
		if (exclude.has(num)) continue;
		const key = keys.get(num);
		const old = key ? list.objects[key]?.stream?.dict : undefined;
		if (!key || !old) return null;
		const dict: Record<string, Json> = { ...old, '/Width': e.width, '/Height': e.height, '/BitsPerComponent': 8, '/Filter': '/DCTDecode' };
		for (const k of ['/DecodeParms', '/DL', '/Length']) delete dict[k];
		const file = `/u/${i++}`;
		updates[key] = { stream: { dict, datafile: file } };
		inputs[file] = e.data;
	}
	if (i === 0) return bytes;
	inputs['/u.json'] = new TextEncoder().encode(JSON.stringify({ qpdf: [list.header, updates] }));
	const res = await qpdf.run({
		args: ['/p.pdf', '--update-from-json=/u.json', '--compress-streams=n', '--decode-level=none', '--object-streams=disable', '/q.pdf'],
		inputs,
		outputs: ['/q.pdf']
	});
	const out = res.files.get('/q.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !out) return null;
	return out;
}

// --- the export dialog's question ------------------------------------------------------------

/**
 * Engine.oversizedPictures: the pictures capPictures would bring down, each with the
 * 0-based pages it is drawn on. Same rules, without encoding (so without the gain
 * rule and the visual check: the export may still leave one alone). An image source
 * whose page the app built around one JPEG is answered from qpdf's listing alone.
 */
export async function oversizedPictures(
	qpdf: Qpdf,
	mupdf: () => Promise<Mupdf>,
	source: { kind: string; bytes: Uint8Array; pages: PageSize[] }
): Promise<number[][]> {
	if (source.kind === 'blank') return [];
	const list = await listObjects(qpdf, source.bytes);
	if (!list) return [];
	const big = bigImages(list.objects, CAP_RULES);
	if (big.size === 0 || isSigned(list.objects)) return [];
	if (source.kind === 'image' && source.pages.length === 1 && big.size === 1) {
		const quick = placedPhoto(list.objects, [...big][0], source.pages[0]);
		if (quick !== undefined) return quick ? [[0]] : [];
	}
	const m = await mupdf();
	const doc = new m.PDFDocument(source.bytes);
	try {
		const out: number[][] = [];
		for (const c of findCandidates(doc)) {
			if (!big.has(c.num) || !pick(c, CAP_RULES, () => {})) continue;
			if (!c.jpegSource && !photoLike(m, doc, c)) continue;
			out.push([...c.pages].sort((a, b) => a - b));
		}
		return out;
	} finally {
		doc.destroy();
		m.emptyStore();
	}
}

function photoLike(m: Mupdf, doc: PDFDocument, c: Candidate): boolean {
	const buf = doc.newIndirect(c.num).readStream();
	try {
		const px = buf.asUint8Array();
		return px.length === c.width * c.height * c.n && isPhotoLike(px, c.width, c.height, c.n);
	} finally {
		buf.destroy();
		m.emptyStore();
	}
}

/**
 * The app's own picture page (core.ts openImage: one image drawn over the whole page,
 * turned by its EXIF orientation): a plain grey or RGB JPEG is answered without MuPDF.
 * Undefined when the page is not of that shape (then MuPDF decides).
 */
function placedPhoto(objects: Objects, num: number, page: PageSize): boolean | undefined {
	const key = keyIndex(objects).get(num);
	const d = key ? objects[key]?.stream?.dict : undefined;
	if (!d) return undefined;
	const filter = resolve(objects, d['/Filter']);
	const cs = resolve(objects, d['/ColorSpace']);
	const w = resolve(objects, d['/Width']);
	const h = resolve(objects, d['/Height']);
	if (filter !== '/DCTDecode' || (cs !== '/DeviceRGB' && cs !== '/DeviceGray')) return undefined;
	if (typeof w !== 'number' || typeof h !== 'number') return undefined;
	for (const k of ['/SMask', '/Mask', '/Decode']) if (d[k] !== undefined) return undefined;
	// Upright or turned a quarter: the image's own axes follow the page's or are swapped.
	const upright = Math.abs(w / h - page.width / page.height) <= Math.abs(h / w - page.width / page.height);
	const inW = (upright ? page.width : page.height) / 72;
	const inH = (upright ? page.height : page.width) / 72;
	if (w * h > CAP_MAX_PIXELS_JPEG) return false;
	return capSize(w, h, inW, inH) !== null;
}
