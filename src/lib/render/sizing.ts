/** Pure sizing maths for the renderer. No DOM, no PDF.js. */

import type { Rotation } from '../core/types';

/** iOS Safari refuses canvases above about 16.7 megapixels (4096 x 4096). */
export const MAX_PIXELS = 16_777_216;
export const MAX_SIDE = 4096;

/**
 * Round a width up to a bucket so that small resizes land on the same cache
 * entry: 32px steps up to 512, 64px steps up to 1536, 256px steps above.
 */
export function bucketWidth(width: number): number {
	const w = Math.max(1, Math.ceil(width));
	const step = w <= 512 ? 32 : w <= 1536 ? 64 : 256;
	return Math.ceil(w / step) * step;
}

export function isSwapped(rotation: number): boolean {
	return rotation % 180 !== 0;
}

export interface RenderSize {
	/** PDF.js viewport scale (device pixels per PDF point). */
	scale: number;
	/** Output bitmap size in device pixels, after rotation. */
	width: number;
	height: number;
	/** True when the requested size had to be reduced. */
	clamped: boolean;
}

/**
 * Work out the scale and bitmap size for a page.
 *
 * `pageWidth` / `pageHeight` are the page size in points with its intrinsic
 * rotation applied (as in `Source.pages`). `targetWidth` is the width of the
 * page *before* the extra user rotation, in device pixels. The result is
 * clamped to MAX_SIDE per side and MAX_PIXELS in total.
 */
export function computeRenderSize(
	pageWidth: number,
	pageHeight: number,
	rotation: Rotation | number,
	targetWidth: number
): RenderSize {
	const pw = Math.max(1e-3, pageWidth);
	const ph = Math.max(1e-3, pageHeight);
	const swap = isSwapped(rotation);
	const rw = swap ? ph : pw;
	const rh = swap ? pw : ph;
	const wanted = Math.max(1, targetWidth) / pw;
	const scale = Math.min(wanted, MAX_SIDE / rw, MAX_SIDE / rh, Math.sqrt(MAX_PIXELS / (rw * rh)));
	const width = Math.max(1, Math.floor(rw * scale));
	const height = Math.max(1, Math.floor(rh * scale));
	return { scale, width, height, clamped: scale < wanted };
}

/** Estimated memory cost of a bitmap. */
export function bitmapBytes(width: number, height: number): number {
	return width * height * 4;
}

/**
 * Pictures of whole pages (the export dialog's "JPG/PNG pictures"): at most this many
 * pixels per picture (iOS Safari's canvas limit, as for the page view) and this many
 * per side (well inside every browser's canvas limits).
 */
export const PICTURE_MAX_PIXELS = MAX_PIXELS;
export const PICTURE_MAX_SIDE = 8192;

export interface PictureSize {
	width: number;
	height: number;
	/** The resolution used: `dpi` asked for, or lower when the page would exceed the caps. */
	dpi: number;
	/** True when the resolution had to be lowered. */
	reduced: boolean;
}

/**
 * Pixel size of a page picture. `w` and `h` are the page as displayed, in points (its
 * /Rotate applied). Sides are rounded to whole pixels (a letter page at 150 dpi is
 * 1275 × 1650). When the page would exceed PICTURE_MAX_PIXELS or PICTURE_MAX_SIDE, the
 * resolution is lowered to the largest whole dpi that fits.
 */
export function pictureSize(w: number, h: number, dpi: number): PictureSize {
	const pw = Math.max(1e-3, w);
	const ph = Math.max(1e-3, h);
	const at = (d: number) => ({ width: Math.max(1, Math.round((pw * d) / 72)), height: Math.max(1, Math.round((ph * d) / 72)) });
	const fits = (s: { width: number; height: number }) =>
		s.width * s.height <= PICTURE_MAX_PIXELS && Math.max(s.width, s.height) <= PICTURE_MAX_SIDE;
	const first = at(dpi);
	if (fits(first)) return { ...first, dpi, reduced: false };
	let d = Math.floor(Math.min(dpi * Math.sqrt(PICTURE_MAX_PIXELS / (first.width * first.height)), (dpi * PICTURE_MAX_SIDE) / Math.max(first.width, first.height)));
	while (d > 1 && !fits(at(d))) d--;
	// A page so large that even 1 dpi is too big (beyond PDF's own size limits): scale to fit.
	if (d <= 1 && !fits(at(1))) {
		const k = Math.min(Math.sqrt(PICTURE_MAX_PIXELS / (pw * ph)), PICTURE_MAX_SIDE / Math.max(pw, ph));
		return { width: Math.max(1, Math.floor(pw * k)), height: Math.max(1, Math.floor(ph * k)), dpi: Math.max(0.01, k * 72), reduced: true };
	}
	return { ...at(d), dpi: d, reduced: true };
}
