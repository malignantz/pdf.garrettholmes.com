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
