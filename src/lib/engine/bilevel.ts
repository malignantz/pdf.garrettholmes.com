/**
 * "Make scanned pages black and white": the picture of a scanned page, stored as a
 * colour or grey photo (usually JPEG), becomes a 1-bit black/white picture of the same
 * pixel size, stored with exact (lossless) bilevel compression. It stays a picture of the
 * real page: nothing is retyped, nothing is resampled, and the page content that draws it
 * is untouched (only the image stream and its dictionary change).
 *
 * Measured, not wired into the app yet (phase 1: tools/bilevel/, report in
 * /home/garrett/pdf-survey/out-bilevel/report.md). This module is the reusable core; every
 * function is pure (samples in, verdict or bytes out) so the rules are unit-tested:
 *
 *   analyse   the qualify test: only a page that is already essentially black on white
 *             goes on. Paper and ink levels from Otsu's split of the grey histogram; the
 *             page is refused for low contrast, colour (block chroma measured against the
 *             paper's own colour, so yellowed paper is not colour but a highlighter, a
 *             stamp or blue ink is), or grey content: mid-grey pixels with no dark ink near
 *             them (faint pencil, light grey text, shading, photos, shadows of uneven
 *             light), counted per small block so a small faint mark is seen as well as a
 *             large grey area. Edges of black strokes are mid-grey too, but always have
 *             ink beside them, so they do not count.
 *   binarize  one global threshold (Otsu's), samples at or below it black.
 *   vanished  the "nothing vanished" check: the original (its grey levels mapped so paper
 *             is white and ink black) and the black/white result are both averaged down to
 *             about 75 and 25 pixels per inch and compared; a cell that became clearly
 *             lighter (faint content wiped out) or darker (grey filled in) refuses the page.
 *   encodeG4  CCITT Group 4 (ITU-T T.6), exact. PDF readers have decoded it since PDF 1.0.
 *   flateRows 1 bit per pixel rows with PNG predictors, for FlateDecode (the fallback).
 *
 * Bit convention throughout: packed rows, most significant bit first, each row padded to
 * a whole byte, 1 = white and 0 = black: what a 1-bit /DeviceGray image without /Decode
 * means, and what CCITTFaxDecode delivers with /BlackIs1 false (the default).
 *
 * Never lossy JBIG2 symbol matching (pattern substitution can swap one digit for another).
 */

/** Tunable rules (BILEVEL_RULES are the measured defaults; measurements may override). */
export interface BilevelRules {
	/** Paper minus ink (grey levels) below which the page is not black on white. */
	minContrast: number;
	/** Ink (pixels at or below the threshold) must be between these shares of the picture. */
	minInk: number;
	maxInk: number;
	/** A colour block's chroma (0–255, measured against the paper colour) above this is colour. */
	chroma: number;
	/** At most this many colour blocks (about 1/75 inch each). */
	maxColourBlocks: number;
	/** Darkness band of a "mid-grey" pixel (0 = paper, 1 = ink). */
	midLow: number;
	midHigh: number;
	/** A mid-grey pixel with a pixel at least this dark within EDGE_REACH inch is a stroke edge. */
	edgeDark: number;
	/** Orphan (not edge) mid-grey share above which a grey block (about 1/12 inch) counts as grey. */
	greyBlockShare: number;
	/** At most this many grey blocks, and at most this share of orphan pixels over the picture. */
	maxGreyBlocks: number;
	maxOrphanShare: number;
	/** "Nothing vanished": a 1/75 inch cell this much lighter / darker (0–255, edges excused) is changed content. */
	cellLoss: number;
	cellGain: number;
	/** A region of changed cells this big (inches, largest side) refuses the page. */
	minExtent: number;
	/** Largest lighter / darker difference allowed over about 1/25 inch (0–255). */
	lossCoarse: number;
	gainCoarse: number;
	/** Pictures under this resolution (pixels per inch as drawn) are not converted. */
	minPpi: number;
}

export const BILEVEL_RULES: Readonly<BilevelRules> = {
	minContrast: 100,
	minInk: 0.002,
	maxInk: 0.35,
	chroma: 40,
	maxColourBlocks: 24,
	midLow: 0.3,
	midHigh: 0.7,
	edgeDark: 0.8,
	greyBlockShare: 0.04,
	maxGreyBlocks: 6,
	maxOrphanShare: 0.002,
	cellLoss: 24,
	cellGain: 24,
	minExtent: 0.1,
	lossCoarse: 64,
	gainCoarse: 64,
	minPpi: 200
};

/** How far (inches) a stroke's dark core may be from one of its mid-grey edge pixels. */
export const EDGE_REACH = 1 / 150;
/** Colour blocks, grey blocks and the check's grids, in pixels per inch (one cell each). */
export const COLOUR_PPI = 75;
export const GREY_BLOCK_PPI = 12;
export const FINE_PPI = 75;
/** Coarse cells are COARSE × COARSE fine cells (25 ppi at 75). */
export const COARSE = 3;

export type Refusal = 'resolution' | 'contrast' | 'ink' | 'colour' | 'grey' | 'vanished';

export interface Analysis {
	ok: boolean;
	reason?: Refusal;
	/** Grey of each pixel (luma, 0–255), row by row. */
	grey: Uint8Array;
	/** Otsu's threshold: grey ≤ threshold is black. */
	threshold: number;
	/** Median grey of the paper and of the ink (the classes either side of the threshold). */
	paper: number;
	ink: number;
	/** Share of pixels at or below the threshold. */
	inkShare: number;
	colourBlocks: number;
	greyBlocks: number;
	orphanShare: number;
}

/** BT.601 luma, as integer weights summing to 256. */
const lumaOf = (r: number, g: number, b: number) => (77 * r + 150 * g + 29 * b + 128) >> 8;

/** Grey of 8-bit grey (n 1) or RGB (n 3) samples, rows packed. */
export function greyOf(samples: ArrayLike<number>, w: number, h: number, n: 1 | 3): Uint8Array {
	const out = new Uint8Array(w * h);
	if (n === 1) {
		for (let i = 0; i < w * h; i++) out[i] = samples[i];
		return out;
	}
	for (let i = 0, j = 0; i < w * h; i++, j += 3) out[i] = lumaOf(samples[j], samples[j + 1], samples[j + 2]);
	return out;
}

/** Otsu's threshold of a 256-bin histogram: the level t that best splits [0, t] from (t, 255]. */
export function otsu(hist: ArrayLike<number>): number {
	let total = 0;
	let sum = 0;
	for (let i = 0; i < 256; i++) {
		total += hist[i];
		sum += i * hist[i];
	}
	let w0 = 0;
	let s0 = 0;
	let best = 0;
	let bestVar = -1;
	for (let t = 0; t < 255; t++) {
		w0 += hist[t];
		s0 += t * hist[t];
		const w1 = total - w0;
		if (w0 === 0 || w1 === 0) continue;
		const d = s0 / w0 - (sum - s0) / w1;
		const v = w0 * w1 * d * d;
		if (v > bestVar) {
			bestVar = v;
			best = t;
		}
	}
	return best;
}

/** Median level of hist[a..b] (inclusive); a when empty. */
function medianOf(hist: ArrayLike<number>, a: number, b: number): number {
	let n = 0;
	for (let i = a; i <= b; i++) n += hist[i];
	let half = n / 2;
	for (let i = a; i <= b; i++) {
		half -= hist[i];
		if (half <= 0) return i;
	}
	return a;
}

/**
 * The qualify test on a picture's samples (8-bit grey or RGB, rows packed) drawn at `ppi`
 * pixels per inch. Returns the verdict with the grey samples and the levels found, so the
 * caller can binarize and check without decoding again.
 */
export function analyse(samples: ArrayLike<number>, w: number, h: number, n: 1 | 3, ppi: number, rules: BilevelRules = BILEVEL_RULES): Analysis {
	const grey = greyOf(samples, w, h, n);
	const hist = new Float64Array(256);
	for (let i = 0; i < grey.length; i++) hist[grey[i]]++;
	const threshold = otsu(hist);
	const ink = medianOf(hist, 0, threshold);
	const paper = medianOf(hist, threshold + 1, 255);
	let inkCount = 0;
	for (let i = 0; i <= threshold; i++) inkCount += hist[i];
	const inkShare = inkCount / Math.max(1, grey.length);
	const a: Analysis = { ok: false, grey, threshold, paper, ink, inkShare, colourBlocks: 0, greyBlocks: 0, orphanShare: 0 };
	if (Math.round(ppi) < rules.minPpi) return { ...a, reason: 'resolution' };
	// (A flat picture has nothing on one side of the split: no ink and no contrast.)
	if (inkCount === 0 || inkCount === grey.length || paper - ink < rules.minContrast) return { ...a, reason: 'contrast' };
	if (inkShare < rules.minInk || inkShare > rules.maxInk) return { ...a, reason: 'ink' };
	if (n === 3) {
		a.colourBlocks = colourBlocks(samples, grey, w, h, ppi, paper, rules);
		if (a.colourBlocks > rules.maxColourBlocks) return { ...a, reason: 'colour' };
	}
	const g = greyContent(grey, w, h, ppi, paper, ink, rules);
	a.greyBlocks = g.blocks;
	a.orphanShare = g.share;
	if (g.blocks > rules.maxGreyBlocks || g.share > rules.maxOrphanShare) return { ...a, reason: 'grey' };
	return { ...a, ok: true };
}

/**
 * Blocks (about 1/75 inch) whose mean colour, with each channel scaled so the paper's own
 * colour is white, has a chroma (largest minus smallest channel) above rules.chroma.
 * Averaging over a block keeps JPEG chroma noise and the colour fringes scanners leave
 * on black strokes from counting; a coloured mark fills its blocks and does count.
 */
function colourBlocks(samples: ArrayLike<number>, grey: Uint8Array, w: number, h: number, ppi: number, paper: number, rules: BilevelRules): number {
	// The paper's colour: mean RGB of pixels within 6 levels of the paper's grey.
	const pc = [0, 0, 0];
	let pn = 0;
	for (let i = 0, j = 0; i < grey.length; i++, j += 3) {
		if (Math.abs(grey[i] - paper) > 6) continue;
		pc[0] += samples[j];
		pc[1] += samples[j + 1];
		pc[2] += samples[j + 2];
		pn++;
	}
	const scale = pc.map((c) => (pn && c > 0 ? (255 * pn) / c : 1));
	const b = Math.max(2, Math.round(ppi / COLOUR_PPI));
	let count = 0;
	for (let by = 0; by + b <= h; by += b) {
		for (let bx = 0; bx + b <= w; bx += b) {
			let r = 0;
			let g = 0;
			let bl = 0;
			for (let y = by; y < by + b; y++) {
				for (let x = bx, j = (y * w + bx) * 3; x < bx + b; x++, j += 3) {
					r += samples[j];
					g += samples[j + 1];
					bl += samples[j + 2];
				}
			}
			const k = 1 / (b * b);
			const cr = Math.min(255, r * k * scale[0]);
			const cg = Math.min(255, g * k * scale[1]);
			const cb = Math.min(255, bl * k * scale[2]);
			if (Math.max(cr, cg, cb) - Math.min(cr, cg, cb) > rules.chroma) count++;
		}
	}
	return count;
}

/**
 * Orphan mid-grey pixels: darkness ((paper − grey) / (paper − ink)) inside the mid band
 * with no pixel at least rules.edgeDark dark within EDGE_REACH inch. Returns the number of
 * grey blocks (about 1/12 inch) whose orphan share is above rules.greyBlockShare, and the
 * orphan share of the whole picture. Stops counting once the picture is refused anyway.
 */
function greyContent(grey: Uint8Array, w: number, h: number, ppi: number, paper: number, ink: number, rules: BilevelRules): { blocks: number; share: number } {
	const c = paper - ink;
	const midHi = paper - rules.midLow * c; // lighter end of the mid band (grey < midHi)
	const midLo = paper - rules.midHigh * c; // darker end (grey > midLo)
	const dark = paper - rules.edgeDark * c; // a pixel this dark or darker is ink
	const r = Math.max(1, Math.round(ppi * EDGE_REACH));
	const B = Math.max(4, Math.round(ppi / GREY_BLOCK_PPI));
	const bw = Math.ceil(w / B);
	const perBlock = new Uint32Array(bw * Math.ceil(h / B));
	const limit = rules.maxOrphanShare * w * h;
	let orphans = 0;
	for (let y = 0; y < h && orphans <= limit; y++) {
		const y0 = Math.max(0, y - r);
		const y1 = Math.min(h - 1, y + r);
		const row = y * w;
		for (let x = 0; x < w; x++) {
			const v = grey[row + x];
			if (v >= midHi || v <= midLo) continue;
			const x0 = Math.max(0, x - r);
			const x1 = Math.min(w - 1, x + r);
			let edge = false;
			for (let yy = y0; yy <= y1 && !edge; yy++) {
				const o = yy * w;
				for (let xx = x0; xx <= x1; xx++) {
					if (grey[o + xx] <= dark) {
						edge = true;
						break;
					}
				}
			}
			if (edge) continue;
			orphans++;
			perBlock[Math.floor(y / B) * bw + Math.floor(x / B)]++;
		}
	}
	let blocks = 0;
	const need = rules.greyBlockShare * B * B;
	for (let i = 0; i < perBlock.length; i++) if (perBlock[i] > need) blocks++;
	return { blocks, share: orphans / Math.max(1, w * h) };
}

/** Bytes per packed row of a 1-bit picture `w` pixels wide. */
export const rowBytesOf = (w: number) => (w + 7) >> 3;

/** Packed 1-bit rows (1 = white): grey ≤ threshold is black. Padding bits are 0. */
export function binarize(grey: Uint8Array, w: number, h: number, threshold: number): Uint8Array {
	const rb = rowBytesOf(w);
	const out = new Uint8Array(rb * h);
	for (let y = 0; y < h; y++) {
		const row = y * w;
		const o = y * rb;
		for (let x = 0; x < w; x++) if (grey[row + x] > threshold) out[o + (x >> 3)] |= 0x80 >> (x & 7);
	}
	return out;
}

/** Whether two packed 1-bit pictures have the same pixels (padding bits ignored). */
export function sameBits(a: Uint8Array, b: Uint8Array, w: number, h: number): boolean {
	const rb = rowBytesOf(w);
	if (a.length < rb * h || b.length < rb * h) return false;
	const full = w >> 3;
	const tailMask = w & 7 ? (0xff << (8 - (w & 7))) & 0xff : 0;
	for (let y = 0; y < h; y++) {
		const o = y * rb;
		for (let i = 0; i < full; i++) if (a[o + i] !== b[o + i]) return false;
		if (tailMask && (a[o + full] & tailMask) !== (b[o + full] & tailMask)) return false;
	}
	return true;
}

/** A connected area of cells where the result differs from the original beyond the excused edges. */
export interface Region {
	/** Largest side of its bounding box, inches. */
	extent: number;
	/** Cells in it, and its mean difference over them (0–255). */
	cells: number;
	mean: number;
	/** Top-left of its bounding box, picture pixels. */
	at: [number, number];
}

export interface VanishReport {
	ok: boolean;
	/** Largest cell difference (0–255) where the result is lighter (loss) or darker (gain), edges excused. */
	lossFine: number;
	gainFine: number;
	/** Largest difference over COARSE × COARSE cells (about 1/25 inch). */
	lossCoarse: number;
	gainCoarse: number;
	/** The largest lost and gained regions (by extent), if any. */
	lost: Region | null;
	gained: Region | null;
	/** Where to look first (the largest region, or the largest fine loss). */
	at: [number, number];
}

/** `mask` grown by r pixels in every direction (square), in place via `tmp`. */
function dilate(mask: Uint8Array, tmp: Uint8Array, w: number, h: number, r: number) {
	for (let y = 0; y < h; y++) {
		const o = y * w;
		// Two sweeps per row: distance to the nearest set pixel on the left and on the right.
		let last = -Infinity;
		for (let x = 0; x < w; x++) {
			if (mask[o + x]) last = x;
			tmp[o + x] = x - last <= r ? 1 : 0;
		}
		last = Infinity;
		for (let x = w - 1; x >= 0; x--) {
			if (mask[o + x]) last = x;
			if (last - x <= r) tmp[o + x] = 1;
		}
	}
	for (let x = 0; x < w; x++) {
		let last = -Infinity;
		for (let y = 0; y < h; y++) {
			if (tmp[y * w + x]) last = y;
			mask[y * w + x] = y - last <= r ? 1 : 0;
		}
		last = Infinity;
		for (let y = h - 1; y >= 0; y--) {
			if (tmp[y * w + x]) last = y;
			if (last - y <= r) mask[y * w + x] = 1;
		}
	}
}

/** 8-connected regions of cells whose value is at least `min`; the one with the largest extent. */
function largestRegion(v: Float64Array, cw: number, ch: number, min: number, F: number, ppi: number): Region | null {
	const seen = new Uint8Array(cw * ch);
	const stack: number[] = [];
	let best: Region | null = null;
	for (let i = 0; i < v.length; i++) {
		if (seen[i] || v[i] < min) continue;
		let x0 = cw;
		let y0 = ch;
		let x1 = -1;
		let y1 = -1;
		let cells = 0;
		let sum = 0;
		seen[i] = 1;
		stack.push(i);
		while (stack.length) {
			const j = stack.pop()!;
			const x = j % cw;
			const y = (j - x) / cw;
			cells++;
			sum += v[j];
			if (x < x0) x0 = x;
			if (x > x1) x1 = x;
			if (y < y0) y0 = y;
			if (y > y1) y1 = y;
			for (let dy = -1; dy <= 1; dy++) {
				const yy = y + dy;
				if (yy < 0 || yy >= ch) continue;
				for (let dx = -1; dx <= 1; dx++) {
					const xx = x + dx;
					if (xx < 0 || xx >= cw) continue;
					const k = yy * cw + xx;
					if (!seen[k] && v[k] >= min) {
						seen[k] = 1;
						stack.push(k);
					}
				}
			}
		}
		const extent = (Math.max(x1 - x0, y1 - y0) + 1) * (F / ppi);
		if (!best || extent > best.extent) best = { extent, cells, mean: sum / cells, at: [x0 * F, y0 * F] };
	}
	return best;
}

/**
 * The "nothing vanished" check. The original's grey is mapped so paper is white (255) and
 * ink black (0), linearly, clamped; the result is 0 or 255 per pixel.
 *
 * Thresholding always moves the soft edges of strokes: a black stroke comes out a little
 * thinner or bolder. Those differences are excused: a pixel that became lighter within
 * EDGE_REACH of a pixel the result keeps black (the stroke is still there), and one that
 * became darker within EDGE_REACH of paper in the original. What is left is content that
 * disappeared (faint pencil, light print, a pale stamp, shading, a paper shadow) or grey
 * that was filled in black (a photo, a dark tint).
 *
 * Those differences are averaged over cells of about 1/75 inch; cells over rules.cellLoss
 * (lighter) or rules.cellGain (darker) are joined into 8-connected regions, and a region
 * whose bounding box reaches rules.minExtent inch refuses the page: marks and words are at
 * least that big, while a dust speck or a scanner's stray dot that faded is smaller and is
 * let go. The largest per-cell and per-COARSE-block differences are reported too.
 */
export function vanished(grey: Uint8Array, bits: Uint8Array, w: number, h: number, ppi: number, paper: number, ink: number, rules: BilevelRules = BILEVEL_RULES): VanishReport {
	const F = Math.max(1, Math.round(ppi / FINE_PPI));
	const cw = Math.floor(w / F);
	const ch = Math.floor(h / F);
	const rb = rowBytesOf(w);
	const c = Math.max(1, paper - ink);
	const r = Math.max(1, Math.round(ppi * EDGE_REACH));
	// Paper-white value of each grey level.
	const white = new Float64Array(256);
	for (let v = 0; v < 256; v++) white[v] = Math.max(0, Math.min(255, ((v - ink) * 255) / c));
	// Near kept black (result), and near paper (original: at most rules.midLow dark).
	const nearBlack = new Uint8Array(w * h);
	const nearPaper = new Uint8Array(w * h);
	const paperGrey = paper - rules.midLow * c;
	for (let y = 0; y < h; y++) {
		const row = y * w;
		const brow = y * rb;
		for (let x = 0; x < w; x++) {
			if (!(bits[brow + (x >> 3)] & (0x80 >> (x & 7)))) nearBlack[row + x] = 1;
			if (grey[row + x] >= paperGrey) nearPaper[row + x] = 1;
		}
	}
	const tmp = new Uint8Array(w * h);
	dilate(nearBlack, tmp, w, h, r);
	dilate(nearPaper, tmp, w, h, r);
	const loss = new Float64Array(cw * ch);
	const gain = new Float64Array(cw * ch);
	let lossFine = 0;
	let gainFine = 0;
	let at: [number, number] = [0, 0];
	for (let cy = 0; cy < ch; cy++) {
		for (let cx = 0; cx < cw; cx++) {
			let l = 0;
			let g = 0;
			for (let y = cy * F; y < cy * F + F; y++) {
				const row = y * w;
				const brow = y * rb;
				for (let x = cx * F; x < cx * F + F; x++) {
					const o = white[grey[row + x]];
					if (bits[brow + (x >> 3)] & (0x80 >> (x & 7))) {
						if (!nearBlack[row + x]) l += 255 - o;
					} else if (!nearPaper[row + x]) g += o;
				}
			}
			l /= F * F;
			g /= F * F;
			loss[cy * cw + cx] = l;
			gain[cy * cw + cx] = g;
			if (l > lossFine) {
				lossFine = l;
				at = [cx * F, cy * F];
			}
			if (g > gainFine) gainFine = g;
		}
	}
	let lossCoarse = 0;
	let gainCoarse = 0;
	for (let cy = 0; cy + COARSE <= ch; cy++) {
		for (let cx = 0; cx + COARSE <= cw; cx++) {
			let sl = 0;
			let sg = 0;
			for (let y = cy; y < cy + COARSE; y++)
				for (let x = cx; x < cx + COARSE; x++) {
					sl += loss[y * cw + x];
					sg += gain[y * cw + x];
				}
			lossCoarse = Math.max(lossCoarse, sl / (COARSE * COARSE));
			gainCoarse = Math.max(gainCoarse, sg / (COARSE * COARSE));
		}
	}
	const lost = largestRegion(loss, cw, ch, rules.cellLoss, F, ppi);
	const gained = largestRegion(gain, cw, ch, rules.cellGain, F, ppi);
	const ok = (!lost || lost.extent < rules.minExtent) && (!gained || gained.extent < rules.minExtent) && lossCoarse <= rules.lossCoarse && gainCoarse <= rules.gainCoarse;
	const worst = [lost, gained].filter((x): x is Region => !!x).sort((a, b) => b.extent - a.extent)[0];
	return { ok, lossFine, gainFine, lossCoarse, gainCoarse, lost, gained, at: worst?.at ?? at };
}

export interface Bilevel {
	ok: boolean;
	reason?: Refusal;
	analysis: Omit<Analysis, 'grey'>;
	check?: VanishReport;
	/** The black/white picture (packed rows, 1 = white) when ok. */
	bits?: Uint8Array;
}

/** analyse → binarize → vanished, for one picture. */
export function makeBilevel(samples: ArrayLike<number>, w: number, h: number, n: 1 | 3, ppi: number, rules: BilevelRules = BILEVEL_RULES): Bilevel {
	const { grey, ...analysis } = analyse(samples, w, h, n, ppi, rules);
	if (!analysis.ok) return { ok: false, reason: analysis.reason, analysis };
	const bits = binarize(grey, w, h, analysis.threshold);
	const check = vanished(grey, bits, w, h, ppi, analysis.paper, analysis.ink, rules);
	if (!check.ok) return { ok: false, reason: 'vanished', analysis, check };
	return { ok: true, analysis, check, bits };
}

// --- CCITT Group 4 (ITU-T T.6) -----------------------------------------------------------------

/** [code, length] of run-length codes, terminating (0–63) then make-up (64, 128, … 1728). */
type Code = readonly [number, number];
const c = (s: string): Code => [Number.parseInt(s, 2), s.length];

const WHITE_TERM: readonly Code[] = [
	'00110101', '000111', '0111', '1000', '1011', '1100', '1110', '1111', '10011', '10100', '00111', '01000', '001000', '000011', '110100', '110101',
	'101010', '101011', '0100111', '0001100', '0001000', '0010111', '0000011', '0000100', '0101000', '0101011', '0010011', '0100100', '0011000',
	'00000010', '00000011', '00011010', '00011011', '00010010', '00010011', '00010100', '00010101', '00010110', '00010111', '00101000', '00101001',
	'00101010', '00101011', '00101100', '00101101', '00000100', '00000101', '00001010', '00001011', '01010010', '01010011', '01010100', '01010101',
	'00100100', '00100101', '01011000', '01011001', '01011010', '01011011', '01001010', '01001011', '00110010', '00110011', '00110100'
].map(c);
const WHITE_MAKEUP: readonly Code[] = [
	'11011', '10010', '010111', '0110111', '00110110', '00110111', '01100100', '01100101', '01101000', '01100111', '011001100', '011001101',
	'011010010', '011010011', '011010100', '011010101', '011010110', '011010111', '011011000', '011011001', '011011010', '011011011', '010011000',
	'010011001', '010011010', '011000', '010011011'
].map(c);
const BLACK_TERM: readonly Code[] = [
	'0000110111', '010', '11', '10', '011', '0011', '0010', '00011', '000101', '000100', '0000100', '0000101', '0000111', '00000100', '00000111',
	'000011000', '0000010111', '0000011000', '0000001000', '00001100111', '00001101000', '00001101100', '00000110111', '00000101000', '00000010111',
	'00000011000', '000011001010', '000011001011', '000011001100', '000011001101', '000001101000', '000001101001', '000001101010', '000001101011',
	'000011010010', '000011010011', '000011010100', '000011010101', '000011010110', '000011010111', '000001101100', '000001101101', '000011011010',
	'000011011011', '000001010100', '000001010101', '000001010110', '000001010111', '000001100100', '000001100101', '000001010010', '000001010011',
	'000000100100', '000000110111', '000000111000', '000000100111', '000000101000', '000001011000', '000001011001', '000000101011', '000000101100',
	'000001011010', '000001100110', '000001100111'
].map(c);
const BLACK_MAKEUP: readonly Code[] = [
	'0000001111', '000011001000', '000011001001', '000001011011', '000000110011', '000000110100', '000000110101', '0000001101100', '0000001101101',
	'0000001001010', '0000001001011', '0000001001100', '0000001001101', '0000001110010', '0000001110011', '0000001110100', '0000001110101',
	'0000001110110', '0000001110111', '0000001010010', '0000001010011', '0000001010100', '0000001010101', '0000001011010', '0000001011011',
	'0000001100100', '0000001100101'
].map(c);
/** Make-up codes shared by both colours: 1792, 1856, … 2560. */
const EXT_MAKEUP: readonly Code[] = [
	'00000001000', '00000001100', '00000001101', '000000010010', '000000010011', '000000010100', '000000010101', '000000010110', '000000010111',
	'000000011100', '000000011101', '000000011110', '000000011111'
].map(c);
const PASS = c('0001');
const HORIZ = c('001');
/** Vertical mode codes for a1 − b1 = −3 … 3. */
const VERT: readonly Code[] = ['0000010', '000010', '010', '1', '011', '000011', '0000011'].map(c);
const EOL = c('000000000001');

class BitWriter {
	private buf: Uint8Array;
	private pos = 0;
	private acc = 0;
	private nacc = 0;
	constructor(size: number) {
		this.buf = new Uint8Array(Math.max(64, size));
	}
	put([code, len]: Code) {
		this.acc = (this.acc << len) | code;
		this.nacc += len;
		while (this.nacc >= 8) {
			this.nacc -= 8;
			if (this.pos === this.buf.length) {
				const b = new Uint8Array(this.buf.length * 2);
				b.set(this.buf);
				this.buf = b;
			}
			this.buf[this.pos++] = (this.acc >>> this.nacc) & 0xff;
		}
		this.acc &= (1 << this.nacc) - 1;
	}
	finish(): Uint8Array {
		if (this.nacc > 0) this.put([0, 8 - this.nacc]);
		return this.buf.slice(0, this.pos);
	}
}

function putRun(out: BitWriter, run: number, black: boolean) {
	const term = black ? BLACK_TERM : WHITE_TERM;
	const makeup = black ? BLACK_MAKEUP : WHITE_MAKEUP;
	while (run >= 2560) {
		out.put(EXT_MAKEUP[12]);
		run -= 2560;
	}
	if (run >= 64) {
		const m = run >> 6; // 1 … 39
		out.put(m <= 27 ? makeup[m - 1] : EXT_MAKEUP[m - 28]);
		run -= m << 6;
	}
	out.put(term[run]);
}

/**
 * Positions where the colour changes along one packed row (1 = white): the pixel at each
 * listed position differs from the one before it, the pixel before 0 counting as white.
 * Ends with w, w (the "imaginary" changing elements past the line). Returns the count.
 */
function changes(bits: Uint8Array, o: number, w: number, out: Int32Array): number {
	let k = 0;
	let white = true;
	for (let x = 0; x < w; ) {
		const byte = bits[o + (x >> 3)];
		// Whole bytes of the current colour are skipped.
		if ((x & 7) === 0 && x + 8 <= w && byte === (white ? 0xff : 0x00)) {
			x += 8;
			continue;
		}
		const isWhite: boolean = (byte & (0x80 >> (x & 7))) !== 0;
		if (isWhite !== white) {
			out[k++] = x;
			white = isWhite;
		}
		x++;
	}
	out[k] = w;
	out[k + 1] = w;
	return k;
}

/**
 * CCITT Group 4 (T.6) of packed 1-bit rows (1 = white), with an end-of-block (two EOLs).
 * For /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns w /Rows h >> (BlackIs1 false,
 * EncodedByteAlign false, EndOfBlock true: the defaults).
 */
export function encodeG4(bits: Uint8Array, w: number, h: number): Uint8Array {
	const rb = rowBytesOf(w);
	const out = new BitWriter(rb * h >> 3);
	let ref = new Int32Array(w + 2);
	let cur = new Int32Array(w + 2);
	// The reference line before the first row is all white.
	ref[0] = w;
	ref[1] = w;
	let nref = 0;
	for (let y = 0; y < h; y++) {
		const ncur = changes(bits, y * rb, w, cur);
		let a0 = -1;
		let black = false; // colour of a0
		let ia = 0; // index in cur of the first change after a0
		let ib = 0; // search start in ref
		for (;;) {
			// a1: next change on the coding line after a0; a2: the one after it.
			while (ia < ncur && cur[ia] <= a0) ia++;
			const a1 = cur[ia];
			const a2 = cur[ia + 1];
			// b1: first change on the reference line after a0 to the colour opposite a0's
			// (changes at even indices go to black, odd to white); b2: the next one.
			while (ib > 0 && ref[ib - 1] > a0) ib--;
			while (ib < nref && (ref[ib] <= a0 || ((ib & 1) === 0) === black)) ib++;
			const b1 = ref[ib];
			const b2 = ref[ib + 1];
			if (b2 < a1) {
				out.put(PASS);
				a0 = b2;
			} else if (Math.abs(a1 - b1) <= 3) {
				out.put(VERT[a1 - b1 + 3]);
				a0 = a1;
				black = !black;
			} else {
				out.put(HORIZ);
				putRun(out, a1 - Math.max(0, a0), black);
				putRun(out, a2 - a1, !black);
				a0 = a2;
			}
			if (a0 >= w) break;
		}
		[ref, cur] = [cur, ref];
		nref = ncur;
	}
	out.put(EOL);
	out.put(EOL);
	return out.finish();
}

/** Stream dictionary entries of a G4 picture (to merge into the image dictionary). */
export function g4Params(w: number, h: number): { K: number; Columns: number; Rows: number } {
	return { K: -1, Columns: w, Rows: h };
}

/**
 * Rows for FlateDecode with /DecodeParms << /Predictor 15 /Colors 1 /BitsPerComponent 1
 * /Columns w >>: each packed row with its PNG filter byte (chosen per row; for 1-bit rows
 * a "pixel" is one byte, as PNG defines filters for bit depths under 8). Deflate the result.
 */
export function flateRows(bits: Uint8Array, w: number, h: number): Uint8Array {
	const rb = rowBytesOf(w);
	const out = new Uint8Array((rb + 1) * h);
	const up = new Uint8Array(rb);
	for (let y = 0; y < h; y++) {
		const o = y * rb;
		// None or Up, whichever leaves more zero bytes (Sub, Average and Paeth do not suit bit rows).
		let zNone = 0;
		let zUp = 0;
		for (let i = 0; i < rb; i++) {
			const v = bits[o + i];
			const u = y > 0 ? (v - bits[o - rb + i]) & 0xff : v;
			up[i] = u;
			if (v === 0 || v === 0xff) zNone++;
			if (u === 0) zUp++;
		}
		const d = y * (rb + 1);
		if (zUp > zNone) {
			out[d] = 2;
			out.set(up, d + 1);
		} else {
			out[d] = 0;
			out.set(bits.subarray(o, o + rb), d + 1);
		}
	}
	return out;
}
