/**
 * Compress to a target size (ExportOptions.targetBytes): lower the resolution
 * and quality of plain 8-bit grey/RGB photos and scans, one ladder step at a
 * time, until the finalized file fits. This is the one deliberately lossy
 * feature, so every rule below leans towards leaving an image alone. See the
 * plan's "Phase 2 design".
 *
 * 1. Finalize without touching images. If that fits, stop.
 * 2. Find every image XObject and the largest size it is drawn at, by walking
 *    page content streams and the Form XObjects they draw (CTM tracked through
 *    q/Q/cm/Do). An image is a candidate only if every place it is used was
 *    walked: images reachable from annotations, patterns, Type3 fonts,
 *    soft-mask groups, shadings, thumbnails, or a page whose content could not
 *    be followed are never touched.
 * 3. Ladder of steps (resolution cap in pixels per inch as placed, JPEG
 *    quality). A sample of up to SAMPLE_SIZE images is encoded at every step to
 *    estimate each step's size; the mildest step estimated to fit is built for
 *    real (each image decoded once, scaled by MuPDF's draw device, encoded),
 *    finalized and measured. If it does not fit the next step is built; if a
 *    milder step was estimated close, it is tried too.
 * 4. Visual check: every page of the reduced file and of the input is rendered
 *    by MuPDF at RENDER_PPI and compared in blocks. A page that differs too much
 *    gets the images it uses restored and is checked again; if it still
 *    differs, the lossless file is returned. The stage never fails an export.
 *
 * Memory: one image is decoded at a time (its samples, one scaled copy and the
 * encoded bytes); pages are rendered one at a time and freed. Encoded images
 * of the chosen step are kept until the file is written (they total about the
 * size of the result). Re-decoding per built step is preferred over caching
 * decoded pixels, which for a 100-page scan would be gigabytes.
 */

import type { Matrix, PDFDocument, PDFObject, Pixmap } from 'mupdf';
import type { ExportResult, VerifyCheck } from '../core/types';
import type { CapBuild } from './print-cap';
import type { EngineDeps } from './deps';
import { EngineError } from './errors';
import { isRetired, isWasmFault, rethrowFault, type Mupdf } from './mupdf';

export type ShrinkReport = NonNullable<ExportResult['shrink']>;
export type PrintCapReport = NonNullable<ExportResult['printCap']>;

export interface LadderStep {
	/** Cap on pixels per inch as the image is drawn at its largest. */
	ppi: number;
	/** JPEG quality, 1–100. */
	quality: number;
}

/**
 * Mildest first. 200/80 is visually lossless for office photos and scans at
 * screen and print sizes; 72/45 is the floor where scanned text at normal
 * sizes is still readable on screen.
 */
export const LADDER: readonly LadderStep[] = [
	{ ppi: 200, quality: 80 },
	{ ppi: 150, quality: 72 },
	{ ppi: 120, quality: 65 },
	{ ppi: 96, quality: 55 },
	{ ppi: 72, quality: 45 }
];

/** Flat-colour images (screenshots, logos, charts) are never taken below this. */
export const LINE_ART_MIN_PPI = 150;
/** Images smaller than this on a side, or than MIN_IMAGE_BYTES stored, are left alone. */
export const MIN_SIDE = 64;
export const MIN_IMAGE_BYTES = 4096;
/** A re-encoded image is used only when it is under this share of the original stream. */
const MIN_GAIN = 0.97;
/** At a step, images that would keep more than this share of their pixels are left alone. */
const MIN_PIXEL_REDUCTION = 0.9;
/** Images encoded at every step to estimate sizes. */
const SAMPLE_SIZE = 8;

/** Visual check: render resolution and a pixel cap per page (memory on phones). */
export const RENDER_PPI = 50;
const RENDER_MAX_PIXELS = 1_500_000;
/** Comparison block size in rendered pixels (about a third of an inch at 50 ppi). */
export const BLOCK = 16;
/**
 * Thresholds on 0–255 values. See shrink.test.ts for what honest reduction
 * measures and what broken images measure.
 */
export const LIMITS: Readonly<Limits> = { blockMean: 24, blockBias: 14, pageMean: 6 };

/** A re-encoded image. Flate output uses PNG row predictors (/Predictor 15). */
export type Encoded = { data: Uint8Array; filter: 'DCTDecode' | 'FlateDecode'; width: number; height: number; n: number };

export interface Candidate {
	num: number;
	width: number;
	height: number;
	n: 1 | 3;
	jpegSource: boolean;
	/** Stored (filtered) stream length. */
	rawLength: number;
	/** Largest drawn size along the image's own axes, in inches. */
	inW: number;
	inH: number;
	pages: Set<number>;
	/** Decided on first decode for non-JPEG sources (isPhotoLike). */
	photo?: boolean;
}

/** Test and measurement hooks; the engine passes none. */
export interface ShrinkOptions {
	/** Override the visual-check thresholds. */
	limits?: Limits;
	/** Called with a line per phase (timings, sizes). */
	trace?: (line: string) => void;
	/**
	 * The print-size cap (print-cap.ts), when ExportOptions.printCap is on: applied when
	 * the lossless file fits already, and otherwise tried as the mildest step before the
	 * ladder (the ladder starts again from the original pixels).
	 */
	cap?: () => Promise<CapBuild | null>;
	/** The cap's resolution, for the report when it changed nothing. */
	capPpi?: number;
}
export type Limits = { blockMean: number; blockBias: number; pageMean: number };

export interface PageMetrics {
	/** Mean absolute difference over the page. */
	pageMean: number;
	/** Largest per-block mean absolute difference. */
	blockMean: number;
	/** Largest per-block, per-channel mean signed difference (a colour or brightness shift). */
	blockBias: number;
}

/**
 * `bytes` is the file after stamps, before finalize. `finalize` runs the qpdf
 * finalize step (compress, metadata, password) and returns the final bytes; it
 * is called for every candidate so the size measured is the size delivered.
 * Returns the finalized bytes to deliver (the smallest verified one when the
 * target cannot be reached), the report, and this stage's checks ('visual',
 * 'target-size'). Every returned check is ok: when reducing images is not
 * safe the lossless file is returned instead.
 */
export async function shrinkToTarget(
	deps: EngineDeps,
	bytes: Uint8Array,
	targetBytes: number,
	finalize: (b: Uint8Array) => Promise<Uint8Array>,
	opts: ShrinkOptions = {}
): Promise<{ bytes: Uint8Array; shrink: ShrinkReport; checks: VerifyCheck[]; printCap?: PrintCapReport }> {
	const trace = opts.trace ?? (() => {});
	let t = now();
	const lossless = await finalize(bytes);
	trace(`lossless finalize ${ms(t)} ms → ${lossless.length} bytes`);
	// The print-size cap's file, finalized, when it changed anything and came out smaller.
	let capped: { build: CapBuild; final: Uint8Array } | null = null;
	const report = (): PrintCapReport | undefined =>
		opts.cap ? { images: capped?.build.images ?? 0, savedBytes: capped ? lossless.length - capped.final.length : 0, ppi: opts.capPpi ?? 300 } : undefined;
	const done = (out: Uint8Array, changed: number, ppi: number, visual: string, why?: string) => {
		const reached = out.length <= targetBytes;
		const fromCap = capped !== null && out === capped.final;
		if (capped && !fromCap) capped = null;
		return {
			bytes: out,
			shrink: { targetBytes, reached, imagesChanged: changed, dpi: changed > 0 ? ppi : 0 },
			checks: [
				{ name: 'visual' as const, ok: true, detail: visual },
				{ name: 'target-size' as const, ok: true, detail: sizeDetail(out.length, targetBytes, changed, ppi, why) }
			],
			printCap: report()
		};
	};
	const untouched = 'No image was changed, so every page is exactly as before.';
	if (opts.cap) {
		t = now();
		const build = await opts.cap();
		if (build) {
			const final = await finalize(build.bytes);
			if (final.length < lossless.length) capped = { build, final };
		}
		trace(`print-size cap ${ms(t)} ms: ${capped ? `${capped.build.images} images → ${capped.final.length} bytes` : 'nothing changed'}`);
	}
	const cappedDone = (why?: string) => done(capped!.final, capped!.build.images, capped!.build.ppi, capped!.build.visual, why);
	if (capped && capped.final.length <= targetBytes) return cappedDone();
	if (lossless.length <= targetBytes) return done(lossless, 0, 0, untouched);
	// Below: the ladder from the original pixels; the capped file is the fallback when it cannot help.
	const fallback = (why: string, visual = untouched) => (capped ? cappedDone(why) : done(lossless, 0, 0, visual, why));

	let m: Mupdf;
	try {
		m = await deps.mupdf();
	} catch {
		return fallback('The image engine could not be loaded on this device.');
	}
	let orig: PDFDocument | null = null;
	try {
		t = now();
		orig = new m.PDFDocument(bytes);
		const candidates = findCandidates(orig);
		trace(`analysis ${ms(t)} ms: ${candidates.length} candidate images`);
		if (candidates.length === 0) return fallback('It has no photos or scans that can be reduced safely.');
		const outcome = await search(m, bytes, orig, candidates, lossless.length, capped?.final.length ?? lossless.length, targetBytes, finalize, opts.limits ?? LIMITS, trace);
		if (!outcome) return fallback('Reducing its images did not make it smaller.');
		if (outcome.kind === 'reverted') {
			return fallback(
				'Its images could not be reduced without changing how pages look.',
				`Reduced images did not match the original closely enough on page ${outcome.pages.map((p) => p + 1).join(', ')}, so no image was changed.`
			);
		}
		if (isRetired(m)) throw new EngineError('internal', 'The PDF engine had to restart. Try again.');
		return done(outcome.final, outcome.changed, outcome.step.ppi, outcome.visual);
	} catch (e) {
		// A wasm trap is not a soft "could not reduce": MuPDF must be replaced (core.ts).
		if (isWasmFault(e) || isRetired(m)) throw e;
		return fallback('Its images could not be reduced safely.');
	} finally {
		// After a trap, touching the instance again could trap once more and hide the first error.
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

// --- search over the ladder ---------------------------------------------------------------

type Built = { step: LadderStep; pdf: Uint8Array; final: Uint8Array; changed: number; enc: Map<number, Encoded> };
type Outcome =
	| { kind: 'ok'; final: Uint8Array; changed: number; step: LadderStep; visual: string }
	| { kind: 'reverted'; pages: number[] };

async function search(
	m: Mupdf,
	bytes: Uint8Array,
	orig: PDFDocument,
	cands: Candidate[],
	losslessSize: number,
	/** A step is used only when its file is smaller than this (the lossless or the print-capped file). */
	beat: number,
	target: number,
	finalize: (b: Uint8Array) => Promise<Uint8Array>,
	limits: Limits,
	trace: (line: string) => void
): Promise<Outcome | null> {
	const last = LADDER.length - 1;
	let t = now();
	const est = await estimate(m, orig, cands, losslessSize);
	trace(`estimate ${ms(t)} ms: ${est.map((e) => Math.round(e)).join(', ')}`);
	let k = est.findIndex((e) => e <= target * 0.99);
	if (k < 0) k = last;
	const exclude = new Set<number>();
	const reverted = new Set<number>();
	const revertedOutcome = (): Outcome => ({ kind: 'reverted', pages: [...reverted].sort((x, y) => x - y) });

	const assemble = async (step: LadderStep, enc: Map<number, Encoded>): Promise<Built> => {
		let t = now();
		const pdf = rewrite(m, bytes, enc, exclude);
		const tw = ms(t);
		t = now();
		const final = await finalize(pdf);
		let changed = 0;
		for (const num of enc.keys()) if (!exclude.has(num)) changed++;
		trace(`step ${step.ppi}/${step.quality}: write ${tw} ms, finalize ${ms(t)} ms → ${final.length} bytes, ${changed} images`);
		return { step, pdf, final, changed, enc };
	};
	const build = async (index: number): Promise<Built> => {
		const step = LADDER[index];
		const enc = new Map<number, Encoded>();
		const t = now();
		for (const c of cands) {
			if (exclude.has(c.num)) continue;
			const [e] = await encodeImage(m, orig, c, [step]);
			if (e) enc.set(c.num, e);
		}
		trace(`step ${step.ppi}/${step.quality}: encode ${ms(t)} ms`);
		if (enc.size === 0) return { step, pdf: bytes, final: new Uint8Array(0), changed: 0, enc };
		return assemble(step, enc);
	};

	const tried = new Set<number>();
	for (let guard = 0; guard < 3 * LADDER.length; guard++) {
		tried.add(k);
		let b = await build(k);
		if (b.changed === 0 || b.final.length >= beat) {
			if (k < last) {
				k++;
				continue;
			}
			return reverted.size ? revertedOutcome() : null;
		}
		// Estimates can be pessimistic: try one milder step when it was estimated close.
		if (b.final.length <= target && k > 0 && !tried.has(k - 1) && est[k - 1] <= target * 1.03) {
			tried.add(k - 1);
			const milder = await build(k - 1);
			if (milder.changed > 0 && milder.final.length <= target) {
				b = milder;
				k--;
			}
		}
		if (b.final.length > target && k < last) {
			k++;
			continue;
		}
		// Verify the file we mean to return.
		t = now();
		const v = compareDocs(m, orig, b.pdf, null, limits);
		trace(`visual check ${ms(t)} ms: ${v.failed.length} pages failed`);
		if (v.failed.length === 0) return finish(b, v.worst, v.pages, reverted, limits);
		for (const p of v.failed) reverted.add(p);
		for (const c of cands) if (v.failed.some((p) => c.pages.has(p))) exclude.add(c.num);
		b = await assemble(b.step, b.enc);
		if (b.changed > 0) {
			const again = compareDocs(m, orig, b.pdf, v.failed, limits);
			if (again.failed.length > 0) return revertedOutcome();
		}
		if (b.changed === 0 || b.final.length >= beat || (b.final.length > target && k < last)) {
			if (k < last) {
				k++;
				continue;
			}
			return revertedOutcome();
		}
		return finish(b, v.worst, v.pages, reverted, limits);
	}
	return null;
}

function finish(b: Built, worst: PageMetrics, pages: number, reverted: Set<number>, limits: Limits): Outcome {
	let visual =
		`Rendered all ${pages} page${pages === 1 ? '' : 's'} of the original and the reduced file at ${RENDER_PPI} pixels per inch ` +
		`and compared them in ${BLOCK}-pixel blocks: largest block difference ${worst.blockMean.toFixed(1)} of 255 (limit ${limits.blockMean}), ` +
		`largest colour shift ${worst.blockBias.toFixed(1)} (limit ${limits.blockBias}).`;
	if (reverted.size) {
		const ps = [...reverted].sort((x, y) => x - y).map((p) => p + 1);
		visual += ` Images on page${ps.length === 1 ? '' : 's'} ${ps.join(', ')} were kept as they were because the reduced version did not match closely enough.`;
	}
	return { kind: 'ok', final: b.final, changed: b.changed, step: b.step, visual };
}

/** Estimated finalized size at each ladder step (exact image sizes for a sample, scaled up). */
async function estimate(m: Mupdf, orig: PDFDocument, cands: Candidate[], losslessSize: number): Promise<number[]> {
	const sorted = [...cands].sort((a, b) => a.rawLength - b.rawLength);
	const sample =
		sorted.length <= SAMPLE_SIZE
			? sorted
			: Array.from({ length: SAMPLE_SIZE }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (SAMPLE_SIZE - 1))]);
	const total = cands.reduce((s, c) => s + c.rawLength, 0);
	const sampleTotal = sample.reduce((s, c) => s + c.rawLength, 0);
	const saved = LADDER.map(() => 0);
	for (const c of sample) {
		const encs = await encodeImage(m, orig, c, LADDER);
		encs.forEach((e, i) => {
			if (e) saved[i] += c.rawLength - e.data.length;
		});
	}
	return saved.map((s) => losslessSize - (sampleTotal > 0 ? (s / sampleTotal) * total : 0));
}

/** A copy of the input with the encoded images swapped in (same object numbers, every reference keeps working). */
function rewrite(m: Mupdf, bytes: Uint8Array, enc: Map<number, Encoded>, exclude: Set<number>): Uint8Array {
	const work = new m.PDFDocument(bytes);
	try {
		for (const [num, e] of enc) {
			if (exclude.has(num)) continue;
			const obj = work.newIndirect(num);
			obj.put('Width', e.width);
			obj.put('Height', e.height);
			obj.put('BitsPerComponent', 8);
			obj.put('Filter', work.newName(e.filter));
			if (e.filter === 'FlateDecode') {
				const parms = work.newDictionary();
				parms.put('Predictor', 15);
				parms.put('Colors', e.n);
				parms.put('BitsPerComponent', 8);
				parms.put('Columns', e.width);
				obj.put('DecodeParms', parms);
			} else obj.delete('DecodeParms');
			obj.delete('DL');
			obj.writeRawStream(e.data);
		}
		const buf = work.saveToBuffer('');
		const out = buf.asUint8Array().slice();
		buf.destroy();
		return out;
	} finally {
		work.destroy();
	}
}

// --- encoding ------------------------------------------------------------------------------

/**
 * Decodes the image once and encodes it at each step. An entry is null when the
 * step leaves the image alone (already within the cap, or not smaller). The
 * samples are taken as stored (no colour conversion) into a plain grey/RGB
 * container, and the image dictionary keeps its own /ColorSpace (ICC profile,
 * CalRGB …), so colours mean what they meant before.
 */
async function encodeImage(m: Mupdf, doc: PDFDocument, c: Candidate, steps: readonly LadderStep[]): Promise<(Encoded | null)[]> {
	const out: (Encoded | null)[] = steps.map(() => null);
	const dims = (ppi: number): [number, number] | null => {
		const w = Math.min(c.width, Math.max(1, Math.ceil(c.inW * ppi)));
		const h = Math.min(c.height, Math.max(1, Math.ceil(c.inH * ppi)));
		return w * h <= MIN_PIXEL_REDUCTION * c.width * c.height ? [w, h] : null;
	};
	if (steps.every((s) => dims(s.ppi) === null)) return out;

	const cs = c.n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB;
	let src: Pixmap | null = null;
	let img: InstanceType<Mupdf['Image']> | null = null;
	try {
		const buf = doc.newIndirect(c.num).readStream();
		const ok = buf.getLength() === c.width * c.height * c.n;
		if (ok) {
			src = new m.Pixmap(cs, [0, 0, c.width, c.height], false);
			if (src.getStride() === c.width * c.n) src.getPixels().set(buf.asUint8Array());
			else {
				src.destroy();
				src = null;
			}
		}
		buf.destroy();
		if (!src) return out;
		if (!c.jpegSource && c.photo === undefined) c.photo = isPhotoLike(src.getPixels(), c.width, c.height, c.n);
		const asJpeg = c.jpegSource || c.photo === true;
		img = new m.Image(src);
		for (const [i, step] of steps.entries()) {
			const d = dims(asJpeg ? step.ppi : Math.max(step.ppi, LINE_ART_MIN_PPI));
			if (!d) continue;
			const [w, h] = d;
			const dst = new m.Pixmap(cs, [0, 0, w, h], false);
			try {
				dst.clear(255);
				const dev = new m.DrawDevice(m.Matrix.identity, dst);
				dev.fillImage(img, [w, 0, 0, h, 0, 0], 1);
				dev.close();
				dev.destroy();
				const data = asJpeg ? stripJpeg(dst.asJPEG(step.quality)) : await deflate(pngPredict(dst.getPixels(), w, h, c.n));
				if (data.length < c.rawLength * MIN_GAIN) out[i] = { data, filter: asJpeg ? 'DCTDecode' : 'FlateDecode', width: w, height: h, n: c.n };
			} finally {
				dst.destroy();
			}
		}
		return out;
	} finally {
		img?.destroy();
		src?.destroy();
		m.emptyStore();
	}
}

/**
 * Photo-like: many distinct values and few pixels equal to their right-hand
 * neighbour. Screenshots, logos and charts have long exact runs and few
 * colours; JPEG blurs their edges and rings around text, and Flate already
 * stores them compactly, so they keep Flate and are only downsampled, never
 * below LINE_ART_MIN_PPI. Photos and scans carry sensor or paper noise, so
 * exact neighbour matches are rare. (JPEG sources are already lossy and are
 * re-encoded as JPEG regardless.)
 */
export function isPhotoLike(px: ArrayLike<number>, w: number, h: number, n: number): boolean {
	const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 65536)));
	const seen = new Set<number>();
	let pairs = 0;
	let same = 0;
	for (let y = 0; y < h; y += step) {
		for (let x = 0; x + 1 < w; x += step) {
			const o = (y * w + x) * n;
			let v = 0;
			let eq = true;
			for (let k = 0; k < n; k++) {
				v = v * 256 + px[o + k];
				if (px[o + k] !== px[o + n + k]) eq = false;
			}
			seen.add(v);
			pairs++;
			if (eq) same++;
		}
	}
	const minColours = n === 1 ? 64 : 1024;
	return seen.size >= Math.min(minColours, pairs / 4) && same / Math.max(1, pairs) < 0.5;
}

/** Drops APP1–APP13, APP15 and COM segments (metadata, embedded profiles); keeps JFIF APP0 and Adobe APP14. */
export function stripJpeg(j: Uint8Array): Uint8Array {
	const parts: Uint8Array[] = [j.subarray(0, 2)];
	let i = 2;
	while (i + 4 <= j.length && j[i] === 0xff) {
		const marker = j[i + 1];
		if (marker === 0xda) break;
		const len = (j[i + 2] << 8) | j[i + 3];
		const drop = (marker >= 0xe1 && marker <= 0xed) || marker === 0xef || marker === 0xfe;
		if (!drop) parts.push(j.subarray(i, i + 2 + len));
		i += 2 + len;
	}
	parts.push(j.subarray(i));
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

/** PNG row filters, chosen per row by the smallest sum of absolute values (as PNG encoders do). */
export function pngPredict(px: ArrayLike<number>, w: number, h: number, n: number): Uint8Array<ArrayBuffer> {
	const row = w * n;
	const out = new Uint8Array((row + 1) * h);
	const cand = Array.from({ length: 5 }, () => new Uint8Array(row));
	for (let y = 0; y < h; y++) {
		const cur = y * row;
		const prev = (y - 1) * row;
		for (let i = 0; i < row; i++) {
			const x = px[cur + i];
			const a = i >= n ? px[cur + i - n] : 0;
			const b = y > 0 ? px[prev + i] : 0;
			const c = y > 0 && i >= n ? px[prev + i - n] : 0;
			const p = a + b - c;
			const pa = Math.abs(p - a);
			const pb = Math.abs(p - b);
			const pc = Math.abs(p - c);
			const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			cand[0][i] = x;
			cand[1][i] = x - a;
			cand[2][i] = x - b;
			cand[3][i] = x - ((a + b) >> 1);
			cand[4][i] = x - paeth;
		}
		let best = 0;
		let bestSum = Infinity;
		for (let f = 0; f < 5; f++) {
			let sum = 0;
			const r = cand[f];
			for (let i = 0; i < row; i++) sum += r[i] < 128 ? r[i] : 256 - r[i];
			if (sum < bestSum) {
				bestSum = sum;
				best = f;
			}
		}
		out[y * (row + 1)] = best;
		out.set(cand[best], y * (row + 1) + 1);
	}
	return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
	const stream = new Blob([data.slice()]).stream().pipeThrough(new CompressionStream('deflate'));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- finding images and where they are drawn ----------------------------------------------------

const ALLOWED_FILTERS = new Set([
	'FlateDecode',
	'Fl',
	'DCTDecode',
	'DCT',
	'LZWDecode',
	'LZW',
	'RunLengthDecode',
	'RL',
	'ASCIIHexDecode',
	'AHx',
	'ASCII85Decode',
	'A85'
]);
const SKIP_KEYS = new Set(['Parent', 'P', 'Annots', 'Dest', 'A', 'Next', 'Prev', 'First', 'Last', 'Popup', 'IRT', 'StructParent', 'Pg']);

export function findCandidates(doc: PDFDocument): Candidate[] {
	const placed = new Map<number, { inW: number; inH: number; pages: Set<number> }>();
	const foreign = new Set<number>();
	const visited = new Set<number>();

	/** Marks every image reachable from `o` as not to be touched. */
	const collect = (o: PDFObject, depth = 0) => {
		if (depth > 64 || o.isNull()) return;
		if (o.isIndirect()) {
			const num = o.asIndirect();
			if (visited.has(num)) return;
			if (visited.size > 500_000) throw new Error('too many objects');
			visited.add(num);
			if (o.isStream() && o.get('Subtype').isName() && o.get('Subtype').asName() === 'Image') foreign.add(num);
		}
		if (o.isDictionary() || o.isStream()) {
			o.forEach((v, k) => {
				if (!SKIP_KEYS.has(String(k))) collect(v, depth + 1);
			});
		} else if (o.isArray()) {
			o.forEach((v) => collect(v, depth + 1));
		}
	};

	/** Images reachable through resources the walker does not interpret. */
	const scanResources = (res: PDFObject) => {
		if (!res.isDictionary()) return;
		for (const key of ['Pattern', 'Shading']) {
			const d = res.get(key);
			if (!d.isNull()) collect(d);
		}
		const fonts = res.get('Font');
		if (fonts.isDictionary()) {
			fonts.forEach((f) => {
				if (f.get('Subtype').isName() && f.get('Subtype').asName() === 'Type3') collect(f.get('Resources'));
			});
		}
		const gs = res.get('ExtGState');
		if (gs.isDictionary()) {
			gs.forEach((g) => {
				const sm = g.get('SMask');
				if (sm.isDictionary()) collect(sm);
			});
		}
	};

	const pageCount = doc.countPages();
	for (let p = 0; p < pageCount; p++) {
		const page = doc.findPage(p);
		const res = page.getInheritable('Resources');
		const uuObj = page.get('UserUnit');
		const uu = uuObj.isNumber() && uuObj.asNumber() > 0 ? uuObj.asNumber() : 1;
		try {
			walk(readContents(page.get('Contents')), res, [uu, 0, 0, uu, 0, 0], [], (num, ctm) => {
				const inW = Math.hypot(ctm[0], ctm[1]) / 72;
				const inH = Math.hypot(ctm[2], ctm[3]) / 72;
				if (!Number.isFinite(inW + inH)) throw new Error('bad matrix');
				if (inW < 1e-4 || inH < 1e-4) return; // drawn with no area: invisible
				const e = placed.get(num);
				if (e) {
					e.inW = Math.max(e.inW, inW);
					e.inH = Math.max(e.inH, inH);
					e.pages.add(p);
				} else placed.set(num, { inW, inH, pages: new Set([p]) });
			}, scanResources);
		} catch (e) {
			rethrowFault(e);
			// Content this walker cannot follow: nothing it can reach may change.
			collect(res);
		}
		const annots = page.get('Annots');
		if (annots.isArray()) annots.forEach((a) => collect(a.get('AP')));
		collect(page.get('Thumb'));
	}

	// Images used as another image's mask are not candidates themselves.
	const masks = new Set<number>();
	for (const num of placed.keys()) {
		const o = doc.newIndirect(num);
		for (const key of ['SMask', 'Mask']) {
			const r = o.get(key);
			if (r.isIndirect()) masks.add(r.asIndirect());
		}
	}
	const out: Candidate[] = [];
	for (const [num, use] of placed) {
		if (foreign.has(num) || masks.has(num)) continue;
		const c = inspect(doc.newIndirect(num), num);
		if (c) out.push({ ...c, inW: use.inW, inH: use.inH, pages: use.pages });
	}
	return out;
}

function readContents(c: PDFObject): Uint8Array {
	const parts: Uint8Array[] = [];
	const add = (s: PDFObject) => {
		if (!s.isStream()) throw new Error('content is not a stream');
		const b = s.readStream();
		parts.push(b.asUint8Array().slice());
		b.destroy();
	};
	if (c.isArray()) c.forEach((s) => add(s));
	else if (!c.isNull()) add(c);
	const out = new Uint8Array(parts.reduce((s, p) => s + p.length + 1, 0));
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		out[o + p.length] = 10;
		o += p.length + 1;
	}
	return out;
}

/** Is this image XObject one the stage may re-encode? Returns its facts, or null. */
function inspect(o: PDFObject, num: number): Omit<Candidate, 'inW' | 'inH' | 'pages'> | null {
	if (!o.isStream()) return null;
	const name = (k: string) => (o.get(k).isName() ? o.get(k).asName() : null);
	const int = (k: string) => (o.get(k).isNumber() ? o.get(k).asNumber() : NaN);
	if (name('Subtype') !== 'Image') return null;
	if (o.get('ImageMask').isBoolean() && o.get('ImageMask').asBoolean()) return null;
	if (int('BitsPerComponent') !== 8) return null;
	const width = int('Width');
	const height = int('Height');
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < MIN_SIDE || height < MIN_SIDE) return null;
	if (width * height > 250_000_000) return null;
	for (const k of ['Mask', 'Alternates', 'OPI']) if (!o.get(k).isNull()) return null;
	const smask = o.get('SMask');
	// A soft mask stays as it is (its size may differ from the image's: that is legal),
	// unless /Matte says the colours were premultiplied against a mask of the same size.
	if (!smask.isNull() && (!smask.isStream() || !smask.get('Matte').isNull())) return null;
	if (o.get('SMaskInData').isNumber() && o.get('SMaskInData').asNumber() !== 0) return null;

	// Filters: only ones MuPDF decodes losslessly to plain samples (no JPX, JBIG2, CCITT, Crypt).
	const f = o.get('Filter');
	const filters: string[] = [];
	if (f.isName()) filters.push(f.asName());
	else if (f.isArray()) {
		for (let i = 0; i < f.length; i++) {
			if (!f.get(i).isName()) return null;
			filters.push(f.get(i).asName());
		}
	} else if (!f.isNull()) return null;
	if (!filters.every((x) => ALLOWED_FILTERS.has(x))) return null;
	const jpegSource = filters.some((x) => x === 'DCTDecode' || x === 'DCT');

	// Colour space: plain grey/RGB, ICC with 1 or 3 components, CalGray/CalRGB.
	const csObj = o.get('ColorSpace');
	let n: 0 | 1 | 3 = 0;
	if (csObj.isName()) {
		const cs = csObj.asName();
		n = cs === 'DeviceGray' ? 1 : cs === 'DeviceRGB' ? 3 : 0;
	} else if (csObj.isArray() && csObj.length === 2 && csObj.get(0).isName()) {
		const fam = csObj.get(0).asName();
		const arg = csObj.get(1);
		if (fam === 'ICCBased' && arg.isStream()) {
			const N = arg.get('N').isNumber() ? arg.get('N').asNumber() : 0;
			n = N === 1 ? 1 : N === 3 ? 3 : 0;
		} else if (fam === 'CalRGB' && arg.isDictionary()) n = 3;
		else if (fam === 'CalGray' && arg.isDictionary()) n = 1;
	}
	if (n === 0) return null;

	const decode = o.get('Decode');
	if (!decode.isNull()) {
		if (!decode.isArray() || decode.length !== 2 * n) return null;
		for (let i = 0; i < decode.length; i++) {
			const v = decode.get(i);
			if (!v.isNumber() || v.asNumber() !== (i % 2 === 0 ? 0 : 1)) return null;
		}
	}
	const raw = o.readRawStream();
	const rawLength = raw.getLength();
	raw.destroy();
	if (rawLength < MIN_IMAGE_BYTES) return null;
	return { num, width, height, n, jpegSource, rawLength };
}

// --- content stream walking ------------------------------------------------------------------

type Operand = number | { name: string } | null;
const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;
const NUMBER = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function mul(a: Matrix, b: Matrix): Matrix {
	return [
		a[0] * b[0] + a[1] * b[2],
		a[0] * b[1] + a[1] * b[3],
		a[2] * b[0] + a[3] * b[2],
		a[2] * b[1] + a[3] * b[3],
		a[4] * b[0] + a[5] * b[2] + b[4],
		a[4] * b[1] + a[5] * b[3] + b[5]
	];
}

/**
 * Follows q/Q/cm/Do through a content stream and the Form XObjects it draws,
 * reporting each image XObject drawn with its CTM. Throws on anything it cannot
 * follow (a form cycle, malformed operands), so the caller can leave that page
 * alone. Exported for tests.
 */
export function walk(
	data: Uint8Array,
	res: PDFObject,
	ctm0: Matrix,
	stack: number[],
	onImage: (num: number, ctm: Matrix) => void,
	onResources: (res: PDFObject) => void
): void {
	if (stack.length > 16) throw new Error('forms nested too deeply');
	onResources(res);
	let ctm = ctm0;
	const saved: Matrix[] = [];
	const ops: Operand[] = [];
	const n = data.length;
	let i = 0;
	const xobjects = res.isDictionary() ? res.get('XObject') : null;
	while (i < n) {
		const c = data[i];
		if (WS[c]) {
			i++;
			continue;
		}
		if (c === 0x25) {
			// Comment.
			while (i < n && data[i] !== 10 && data[i] !== 13) i++;
			continue;
		}
		if (c === 0x2f) {
			let j = i + 1;
			while (j < n && !WS[data[j]] && !DELIM[data[j]]) j++;
			ops.push({ name: decodeName(data, i + 1, j) });
			i = j;
			continue;
		}
		if (c === 0x28) {
			// Literal string, with nesting and escapes.
			let depth = 1;
			i++;
			while (i < n && depth > 0) {
				const d = data[i];
				if (d === 0x5c) i += 2;
				else {
					if (d === 0x28) depth++;
					else if (d === 0x29) depth--;
					i++;
				}
			}
			ops.push(null);
			continue;
		}
		if (c === 0x3c) {
			if (data[i + 1] === 0x3c) i += 2;
			else {
				while (i < n && data[i] !== 0x3e) i++;
				i++;
			}
			ops.push(null);
			continue;
		}
		if (c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x29) {
			i += c === 0x3e && data[i + 1] === 0x3e ? 2 : 1;
			ops.push(null);
			continue;
		}
		let j = i;
		while (j < n && !WS[data[j]] && !DELIM[data[j]]) j++;
		const tok = ascii(data, i, j);
		i = j;
		if (NUMBER.test(tok)) {
			ops.push(Number(tok));
			continue;
		}
		switch (tok) {
			case 'true':
			case 'false':
			case 'null':
				ops.push(null);
				continue;
			case 'q':
				saved.push(ctm);
				break;
			case 'Q':
				if (saved.length) ctm = saved.pop()!;
				break;
			case 'cm': {
				const v = ops.slice(-6);
				if (v.length !== 6 || !v.every((x) => typeof x === 'number')) throw new Error('bad cm');
				ctm = mul(v as Matrix, ctm);
				break;
			}
			case 'Do': {
				const nm = ops[ops.length - 1];
				if (!nm || typeof nm !== 'object') throw new Error('bad Do');
				const xo = xobjects && xobjects.isDictionary() ? xobjects.get(nm.name) : null;
				if (!xo || xo.isNull()) break;
				if (!xo.isIndirect()) throw new Error('direct XObject');
				const num = xo.asIndirect();
				const sub = xo.get('Subtype').isName() ? xo.get('Subtype').asName() : '';
				if (sub === 'Image') onImage(num, ctm);
				else if (sub === 'Form') {
					if (stack.includes(num)) throw new Error('form cycle');
					const mo = xo.get('Matrix');
					let fm: Matrix = [1, 0, 0, 1, 0, 0];
					if (mo.isArray() && mo.length === 6) {
						fm = [0, 1, 2, 3, 4, 5].map((k) => (mo.get(k).isNumber() ? mo.get(k).asNumber() : NaN)) as Matrix;
						if (!fm.every(Number.isFinite)) throw new Error('bad form matrix');
					} else if (!mo.isNull()) throw new Error('bad form matrix');
					const fres = xo.get('Resources');
					const buf = xo.readStream();
					const body = buf.asUint8Array().slice();
					buf.destroy();
					walk(body, fres.isDictionary() ? fres : res, mul(fm, ctm), [...stack, num], onImage, onResources);
				}
				break;
			}
			case 'BI':
				i = skipInlineImage(data, i);
				break;
			default:
				break;
		}
		ops.length = 0;
	}
}

function ascii(d: Uint8Array, a: number, b: number): string {
	let s = '';
	for (let k = a; k < b; k++) s += String.fromCharCode(d[k]);
	return s;
}

function decodeName(d: Uint8Array, a: number, b: number): string {
	const raw = ascii(d, a, b);
	return raw.includes('#') ? raw.replace(/#([0-9a-fA-F]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))) : raw;
}

/** Skips an inline image (BI … ID data EI) starting just after BI. Returns the index after EI. */
function skipInlineImage(d: Uint8Array, i: number): number {
	const n = d.length;
	let length = -1;
	let lastKey = '';
	for (;;) {
		while (i < n && WS[d[i]]) i++;
		if (i >= n) throw new Error('unterminated inline image');
		let j = i + 1;
		while (j < n && !WS[d[j]] && !DELIM[d[j]]) j++;
		const tok = ascii(d, i, j);
		i = j;
		if (tok === 'ID') break;
		if (tok.startsWith('/')) lastKey = tok;
		else if ((lastKey === '/L' || lastKey === '/Length') && /^\d+$/.test(tok)) length = Number(tok);
	}
	i++; // the single white-space byte after ID
	if (length >= 0) {
		let k = i + length;
		while (k < n && WS[d[k]]) k++;
		if (d[k] === 0x45 && d[k + 1] === 0x49) return k + 2;
	}
	for (let k = i; k + 1 < n; k++) {
		if (d[k] === 0x45 && d[k + 1] === 0x49 && WS[d[k - 1]] && (k + 2 >= n || WS[d[k + 2]] || DELIM[d[k + 2]])) return k + 2;
	}
	throw new Error('unterminated inline image');
}

// --- visual comparison ---------------------------------------------------------------------

/**
 * Compares two renders of the same page (same size, `n` components, rows
 * packed). A pure function so the thresholds can be unit-tested.
 */
export function comparePixels(a: ArrayLike<number>, b: ArrayLike<number>, w: number, h: number, n: number): PageMetrics {
	let total = 0;
	let blockMean = 0;
	let blockBias = 0;
	const sums = new Float64Array(n);
	for (let by = 0; by < h; by += BLOCK) {
		const y1 = Math.min(h, by + BLOCK);
		for (let bx = 0; bx < w; bx += BLOCK) {
			const x1 = Math.min(w, bx + BLOCK);
			let abs = 0;
			sums.fill(0);
			for (let y = by; y < y1; y++) {
				let o = (y * w + bx) * n;
				for (let x = bx; x < x1; x++) {
					for (let k = 0; k < n; k++, o++) {
						const d = a[o] - b[o];
						abs += d < 0 ? -d : d;
						sums[k] += d;
					}
				}
			}
			const count = (y1 - by) * (x1 - bx);
			total += abs;
			blockMean = Math.max(blockMean, abs / (count * n));
			for (let k = 0; k < n; k++) blockBias = Math.max(blockBias, Math.abs(sums[k]) / count);
		}
	}
	return { pageMean: total / Math.max(1, w * h * n), blockMean, blockBias };
}

export function metricsPass(x: PageMetrics, limits: Limits = LIMITS): boolean {
	return x.pageMean <= limits.pageMean && x.blockMean <= limits.blockMean && x.blockBias <= limits.blockBias;
}

/**
 * Renders pages of `orig` and of `candidate` one at a time (pixmaps freed as
 * soon as they are compared). Returns the failing pages and the worst metrics
 * among the pages that passed.
 */
export function compareDocs(
	m: Mupdf,
	orig: PDFDocument,
	candidate: Uint8Array,
	only: number[] | null,
	limits: Limits
): { failed: number[]; worst: PageMetrics; pages: number } {
	const cand = new m.PDFDocument(candidate);
	const worst: PageMetrics = { pageMean: 0, blockMean: 0, blockBias: 0 };
	const failed: number[] = [];
	try {
		const count = orig.countPages();
		const pages = only ?? Array.from({ length: count }, (_, i) => i);
		if (cand.countPages() !== count) return { failed: pages, worst, pages: pages.length };
		for (const p of pages) {
			const x = renderAndCompare(m, orig, cand, p);
			m.emptyStore(); // decoded images of this page are not needed again
			if (!x || !metricsPass(x, limits)) {
				failed.push(p);
				continue;
			}
			worst.pageMean = Math.max(worst.pageMean, x.pageMean);
			worst.blockMean = Math.max(worst.blockMean, x.blockMean);
			worst.blockBias = Math.max(worst.blockBias, x.blockBias);
		}
		return { failed, worst, pages: pages.length };
	} finally {
		cand.destroy();
		m.emptyStore();
	}
}

/** Renders page `p` of both documents the same way and compares them; null if they cannot be compared. */
export function renderAndCompare(m: Mupdf, a: PDFDocument, b: PDFDocument, p: number): PageMetrics | null {
	const pa = a.loadPage(p);
	const pb = b.loadPage(p);
	let xa: Pixmap | null = null;
	let xb: Pixmap | null = null;
	try {
		const [x0, y0, x1, y1] = pa.getBounds();
		const area = Math.max(1, (x1 - x0) * (y1 - y0));
		const s = Math.min(RENDER_PPI / 72, Math.sqrt(RENDER_MAX_PIXELS / area));
		const mtx = m.Matrix.scale(s, s);
		xa = pa.toPixmap(mtx, m.ColorSpace.DeviceRGB, false, true);
		xb = pb.toPixmap(mtx, m.ColorSpace.DeviceRGB, false, true);
		const w = xa.getWidth();
		const h = xa.getHeight();
		if (w !== xb.getWidth() || h !== xb.getHeight() || xa.getStride() !== w * 3 || xb.getStride() !== w * 3) return null;
		return comparePixels(xa.getPixels(), xb.getPixels(), w, h, 3);
	} finally {
		xa?.destroy();
		xb?.destroy();
		pa.destroy();
		pb.destroy();
	}
}

const now = () => performance.now();
const ms = (t: number) => Math.round(performance.now() - t);

// --- words ------------------------------------------------------------------------------------

/** Plain size for people: "640 KB", "3.1 MB", "12 MB". */
export function formatSize(n: number): string {
	if (n < 1_000_000) return `${Math.max(1, Math.round(n / 1000))} KB`;
	const mb = n / 1_000_000;
	if (mb < 10) return `${mb.toFixed(1)} MB`;
	const r = Math.round(mb * 10) / 10;
	return `${Number.isInteger(r) ? r.toFixed(0) : r.toFixed(1)} MB`;
}

function sizeDetail(size: number, target: number, changed: number, ppi: number, why?: string): string {
	const t = formatSize(target);
	let s = formatSize(size);
	// Same at the usual precision ("20 KB; the target was 20 KB"): show one more digit.
	if (s === t && size !== target) s = size < 1_000_000 ? `${(size / 1000).toFixed(1)} KB` : `${(size / 1_000_000).toFixed(2)} MB`;
	if (size <= target) {
		const how =
			changed > 0
				? ` ${changed} image${changed === 1 ? ' was' : 's were'} reduced to at most ${ppi} pixels per inch.`
				: ' No image needed to change.';
		return `${s}, under the ${t} target.${how}`;
	}
	return `${s}; the target was ${t}. This is the smallest this file can get without damaging text.${why ? ` ${why}` : ''}`;
}
