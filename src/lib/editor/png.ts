/** Canvas helpers that turn ink into tightly cropped transparent PNGs (browser only). */

import { alphaBounds, cropRgba, drawStrokes, fitWithin, removeBackground, strokesBounds, type Stroke } from './ink';

export interface PngResult {
	png: Uint8Array;
	width: number;
	height: number;
}

function canvas(w: number, h: number): HTMLCanvasElement {
	const c = document.createElement('canvas');
	c.width = w;
	c.height = h;
	return c;
}

export async function canvasPng(c: HTMLCanvasElement): Promise<Uint8Array> {
	const blob = await new Promise<Blob | null>((res) => c.toBlob(res, 'image/png'));
	if (!blob) throw new Error('Could not encode the image.');
	return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Render strokes (in pad CSS px) at `scale` into a PNG cropped to the ink, with
 * a margin of one pen width so round caps are not clipped.
 */
export async function strokesToPng(strokes: readonly Stroke[], pen: number, color: string, scale = 3): Promise<PngResult | null> {
	const b = strokesBounds(strokes, pen);
	if (!b) return null;
	const w = Math.max(1, Math.ceil(b.width * scale));
	const h = Math.max(1, Math.ceil(b.height * scale));
	const c = canvas(w, h);
	const ctx = c.getContext('2d');
	if (!ctx) throw new Error('Canvas is not available.');
	ctx.translate(-b.x * scale, -b.y * scale);
	ctx.strokeStyle = color;
	ctx.fillStyle = color;
	ctx.lineWidth = pen * scale;
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	drawStrokes(ctx, strokes, pen, scale);
	// Crop again by pixels: strokesBounds is conservative.
	const data = ctx.getImageData(0, 0, w, h);
	const r = alphaBounds(data.data, w, h, 4, 2);
	if (!r) return null;
	const out = canvas(r.width, r.height);
	out.getContext('2d')!.putImageData(new ImageData(cropRgba(data.data, w, r) as Uint8ClampedArray<ArrayBuffer>, r.width, r.height), 0, 0);
	return { png: await canvasPng(out), width: r.width, height: r.height };
}

export interface PhotoOptions {
	removeBackground: boolean;
	strength: number;
	ink?: readonly [number, number, number];
	/** Longest side of the working image. */
	maxSide?: number;
}

/** Pixels of a photo, scaled down to `maxSide`. */
export function photoPixels(img: CanvasImageSource & { width: number; height: number }, maxSide = 1600): ImageData {
	const { width, height } = fitWithin(img.width, img.height, maxSide);
	const c = canvas(width, height);
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	ctx.drawImage(img, 0, 0, width, height);
	return ctx.getImageData(0, 0, width, height);
}

/** Process photo pixels into a cropped RGBA image (for preview) or null when nothing is left. */
export function processPhoto(src: ImageData, opts: PhotoOptions): ImageData | null {
	const rgba = opts.removeBackground ? removeBackground(src.data, { strength: opts.strength, ink: opts.ink }) : src.data;
	const r = alphaBounds(rgba, src.width, src.height, 8, 2);
	if (!r) return null;
	return new ImageData(cropRgba(rgba, src.width, r) as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
}

export async function imageDataPng(img: ImageData): Promise<PngResult> {
	const c = canvas(img.width, img.height);
	c.getContext('2d')!.putImageData(img, 0, 0);
	return { png: await canvasPng(c), width: img.width, height: img.height };
}
