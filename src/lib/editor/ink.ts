/**
 * Pure pixel and stroke helpers for the signature pad: pen smoothing, tight
 * cropping by alpha, and paper-background removal for photographed signatures.
 */

import type { Point } from './geometry';

export type Stroke = Point[];

/** One drawing command in the units of the points. */
export type PathCmd =
	| { op: 'M'; x: number; y: number }
	| { op: 'L'; x: number; y: number }
	| { op: 'Q'; cx: number; cy: number; x: number; y: number }
	| { op: 'dot'; x: number; y: number };

/** Append a pointer sample unless it is closer than `minDist` to the last one. */
export function addPoint(stroke: Stroke, p: Point, minDist = 1.5): boolean {
	const last = stroke[stroke.length - 1];
	if (last && Math.hypot(p.x - last.x, p.y - last.y) < minDist) return false;
	stroke.push({ x: p.x, y: p.y });
	return true;
}

/**
 * Smooth pen path: quadratic curves whose control points are the samples and whose
 * end points are the midpoints between samples, so the curve is continuous and
 * tangent-smooth. Starts and ends exactly at the first and last sample.
 */
export function strokePath(points: readonly Point[]): PathCmd[] {
	if (points.length === 0) return [];
	if (points.length === 1) return [{ op: 'dot', x: points[0].x, y: points[0].y }];
	if (points.length === 2) {
		return [
			{ op: 'M', x: points[0].x, y: points[0].y },
			{ op: 'L', x: points[1].x, y: points[1].y }
		];
	}
	const out: PathCmd[] = [{ op: 'M', x: points[0].x, y: points[0].y }];
	for (let i = 1; i < points.length - 1; i++) {
		const p = points[i];
		const n = points[i + 1];
		out.push({ op: 'Q', cx: p.x, cy: p.y, x: (p.x + n.x) / 2, y: (p.y + n.y) / 2 });
	}
	const last = points[points.length - 1];
	out.push({ op: 'L', x: last.x, y: last.y });
	return out;
}

/** Minimal surface of a CanvasRenderingContext2D used to draw strokes. */
export interface PenContext {
	beginPath(): void;
	moveTo(x: number, y: number): void;
	lineTo(x: number, y: number): void;
	quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
	arc(x: number, y: number, r: number, a0: number, a1: number): void;
	stroke(): void;
	fill(): void;
}

/** Draw strokes with the context's current stroke/fill style; `width` is the pen width. */
export function drawStrokes(ctx: PenContext, strokes: readonly Stroke[], width: number, scale = 1) {
	for (const s of strokes) {
		const cmds = strokePath(s);
		ctx.beginPath();
		for (const c of cmds) {
			if (c.op === 'dot') {
				ctx.arc(c.x * scale, c.y * scale, (width * scale) / 2, 0, Math.PI * 2);
				ctx.fill();
			} else if (c.op === 'M') ctx.moveTo(c.x * scale, c.y * scale);
			else if (c.op === 'L') ctx.lineTo(c.x * scale, c.y * scale);
			else ctx.quadraticCurveTo(c.cx * scale, c.cy * scale, c.x * scale, c.y * scale);
		}
		if (cmds[0]?.op !== 'dot') ctx.stroke();
	}
}

/** Bounding box of all stroke points, grown by `pad`, or null for no strokes. */
export function strokesBounds(strokes: readonly Stroke[], pad: number) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (const s of strokes)
		for (const p of s) {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x);
			y1 = Math.max(y1, p.y);
		}
	if (!Number.isFinite(x0)) return null;
	return { x: x0 - pad, y: y0 - pad, width: x1 - x0 + 2 * pad, height: y1 - y0 + 2 * pad };
}

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Tight bounds of pixels whose alpha exceeds `threshold` in RGBA data, grown by
 * `pad` pixels and kept inside the image. Null when nothing is visible.
 */
export function alphaBounds(data: ArrayLike<number>, width: number, height: number, threshold = 8, pad = 0): Rect | null {
	let x0 = width;
	let y0 = height;
	let x1 = -1;
	let y1 = -1;
	for (let y = 0; y < height; y++) {
		const row = y * width * 4;
		for (let x = 0; x < width; x++) {
			if (data[row + x * 4 + 3] > threshold) {
				if (x < x0) x0 = x;
				if (x > x1) x1 = x;
				if (y < y0) y0 = y;
				if (y > y1) y1 = y;
			}
		}
	}
	if (x1 < 0) return null;
	x0 = Math.max(0, x0 - pad);
	y0 = Math.max(0, y0 - pad);
	x1 = Math.min(width - 1, x1 + pad);
	y1 = Math.min(height - 1, y1 + pad);
	return { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

/** Rec. 709 luma of an sRGB pixel, 0..255. */
export function luminance(r: number, g: number, b: number): number {
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Brightness of the paper: the 90th percentile of luminance over opaque pixels.
 * A signature covers a small part of a photo, so this lands on the paper.
 */
export function paperLevel(data: ArrayLike<number>): number {
	const hist = new Uint32Array(256);
	let n = 0;
	for (let i = 0; i < data.length; i += 4) {
		if (data[i + 3] < 128) continue;
		hist[Math.round(luminance(data[i], data[i + 1], data[i + 2]))]++;
		n++;
	}
	if (n === 0) return 255;
	let acc = 0;
	for (let v = 0; v < 256; v++) {
		acc += hist[v];
		if (acc >= n * 0.9) return v;
	}
	return 255;
}

export interface BackgroundOptions {
	/**
	 * 0..1: how much darker than the paper a pixel must be to count as ink.
	 * Higher keeps fainter strokes but also more shadows. Default 0.5.
	 */
	strength?: number;
	/** Paint the kept pixels this colour (RGB 0..255). Omit to keep their own colour. */
	ink?: readonly [number, number, number];
}

/**
 * Luminance threshold to alpha: pixels as bright as the paper become transparent,
 * clearly darker ones opaque, with a short linear ramp between so edges stay smooth.
 * Deterministic: the same photo and settings always give the same result.
 * Returns a new RGBA array.
 */
export function removeBackground(data: ArrayLike<number>, opts: BackgroundOptions = {}): Uint8ClampedArray {
	const strength = Math.min(1, Math.max(0, opts.strength ?? 0.5));
	const paper = paperLevel(data);
	// Ink must be below `cut`; fully opaque below `cut - ramp`.
	const cut = paper * (0.55 + 0.4 * strength);
	const ramp = Math.max(6, paper * 0.18);
	const out = new Uint8ClampedArray(data.length);
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		const l = luminance(r, g, b);
		const a = Math.min(1, Math.max(0, (cut - l) / ramp)) * (data[i + 3] / 255);
		if (opts.ink) {
			out[i] = opts.ink[0];
			out[i + 1] = opts.ink[1];
			out[i + 2] = opts.ink[2];
		} else {
			out[i] = r;
			out[i + 1] = g;
			out[i + 2] = b;
		}
		out[i + 3] = Math.round(a * 255);
	}
	return out;
}

/** Copy a sub-rectangle of RGBA data. */
export function cropRgba(data: ArrayLike<number>, width: number, r: Rect): Uint8ClampedArray {
	const out = new Uint8ClampedArray(r.width * r.height * 4);
	for (let y = 0; y < r.height; y++) {
		const src = ((r.y + y) * width + r.x) * 4;
		for (let k = 0; k < r.width * 4; k++) out[y * r.width * 4 + k] = data[src + k];
	}
	return out;
}

/** Scale (w, h) down so neither side exceeds `max`, keeping the aspect. */
export function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
	const s = Math.min(1, max / Math.max(w, h));
	return { width: Math.max(1, Math.round(w * s)), height: Math.max(1, Math.round(h * s)) };
}
