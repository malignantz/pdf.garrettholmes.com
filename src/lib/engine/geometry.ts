/**
 * Pure page geometry shared by the engine and (optionally) the editor.
 * No dependencies, so the editor can import it without pulling in an engine.
 *
 * Conventions
 * - PDF user space: origin bottom-left of the page box, y up, units are user units.
 * - Display space: the page as the viewer sees it after /Rotate (clockwise) and
 *   any extra user rotation; origin top-left, y down, same units as user space.
 *   (UserUnit only scales both uniformly, so fractions are unaffected.)
 * - The page box is CropBox clipped to MediaBox, exactly as PDF.js computes `page.view`.
 */

import type { PageSize, Rotation, StampBox } from '../core/types';

export interface Box {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** A 2D affine matrix [a b c d e f]: x' = a*x + c*y + e, y' = b*x + d*y + f. */
export type Matrix = [number, number, number, number, number, number];

export const LETTER: Box = { x0: 0, y0: 0, x1: 612, y1: 792 };

/** Same rule as PDF.js: non-multiples of 90 become 0, others are reduced to 0..270. */
export function normalizeRotation(value: unknown): Rotation {
	if (typeof value !== 'number' || !Number.isInteger(value) || value % 90 !== 0) return 0;
	return ((((value % 360) + 360) % 360) as Rotation);
}

export function addRotation(a: Rotation, b: Rotation): Rotation {
	return ((a + b) % 360) as Rotation;
}

export function normalizeBox(r: readonly number[]): Box {
	return {
		x0: Math.min(r[0], r[2]),
		y0: Math.min(r[1], r[3]),
		x1: Math.max(r[0], r[2]),
		y1: Math.max(r[1], r[3])
	};
}

function validRect(r: unknown): r is number[] {
	return Array.isArray(r) && r.length === 4 && r.every((n) => typeof n === 'number' && Number.isFinite(n));
}

/**
 * The visible page box, mirroring PDF.js: MediaBox (Letter if invalid or empty), then
 * CropBox intersected with it when that intersection is non-empty.
 */
export function visibleBox(mediaBox: unknown, cropBox: unknown): Box {
	let media = validRect(mediaBox) ? normalizeBox(mediaBox) : LETTER;
	if (media.x1 - media.x0 <= 0 || media.y1 - media.y0 <= 0) media = LETTER;
	if (!validRect(cropBox)) return media;
	const c = normalizeBox(cropBox);
	const box = {
		x0: Math.max(c.x0, media.x0),
		y0: Math.max(c.y0, media.y0),
		x1: Math.min(c.x1, media.x1),
		y1: Math.min(c.y1, media.y1)
	};
	if (box.x1 - box.x0 > 0 && box.y1 - box.y0 > 0) return box;
	return media;
}

/** Displayed size in user units (not scaled by UserUnit). */
export function displayedUserSize(box: Box, rotation: Rotation): PageSize {
	const w = box.x1 - box.x0;
	const h = box.y1 - box.y0;
	return rotation === 90 || rotation === 270 ? { width: h, height: w } : { width: w, height: h };
}

export function rotateSize(size: PageSize, rotation: Rotation): PageSize {
	return rotation === 90 || rotation === 270 ? { width: size.height, height: size.width } : { ...size };
}

/**
 * Map a display-space point (dx right, dy down, from the displayed top-left corner,
 * in user units) to PDF user space.
 */
export function displayToPdf(box: Box, rotation: Rotation, dx: number, dy: number): [number, number] {
	switch (rotation) {
		case 0:
			return [box.x0 + dx, box.y1 - dy];
		case 90:
			return [box.x0 + dy, box.y0 + dx];
		case 180:
			return [box.x1 - dx, box.y0 + dy];
		case 270:
			return [box.x1 - dy, box.y1 - dx];
	}
}

/**
 * Matrix for a local frame whose origin is the display point (dx, dy), whose x axis
 * points right on screen and whose y axis points up on screen. Content drawn in this
 * frame appears upright to the viewer whatever the page rotation.
 */
export function uprightFrame(box: Box, rotation: Rotation, dx: number, dy: number): Matrix {
	const [e, f] = displayToPdf(box, rotation, dx, dy);
	switch (rotation) {
		case 0:
			return [1, 0, 0, 1, e, f];
		case 90:
			return [0, 1, -1, 0, e, f];
		case 180:
			return [-1, 0, 0, -1, e, f];
		case 270:
			return [0, -1, 1, 0, e, f];
	}
}

export function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
	return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function multiply(m: Matrix, n: Matrix): Matrix {
	// Result applies m first, then n (PDF `cm` order: m cm then n cm => m × n).
	return [
		m[0] * n[0] + m[1] * n[2],
		m[0] * n[1] + m[1] * n[3],
		m[2] * n[0] + m[3] * n[2],
		m[2] * n[1] + m[3] * n[3],
		m[4] * n[0] + m[5] * n[2] + n[4],
		m[4] * n[1] + m[5] * n[3] + n[5]
	];
}

/** Display-space rectangle of a stamp box, in user units. */
export function stampDisplayRect(box: Box, rotation: Rotation, s: StampBox) {
	const size = displayedUserSize(box, rotation);
	return { left: s.x * size.width, top: s.y * size.height, width: s.w * size.width, height: s.h * size.height };
}

/**
 * Matrix that maps the unit square (0..1, y up in display terms) onto the stamp box,
 * upright on screen. This is the `cm` used before `Do` for image stamps.
 */
export function stampBoxMatrix(box: Box, rotation: Rotation, s: StampBox): Matrix {
	const r = stampDisplayRect(box, rotation, s);
	const frame = uprightFrame(box, rotation, r.left, r.top + r.height);
	return multiply([r.width, 0, 0, r.height, 0, 0], frame);
}

/** Axis-aligned PDF user-space rectangle covered by a stamp box. */
export function stampPdfRect(box: Box, rotation: Rotation, s: StampBox): Box {
	const r = stampDisplayRect(box, rotation, s);
	const [ax, ay] = displayToPdf(box, rotation, r.left, r.top);
	const [bx, by] = displayToPdf(box, rotation, r.left + r.width, r.top + r.height);
	return normalizeBox([ax, ay, bx, by]);
}

// ---------------------------------------------------------------------------
// Text stamps. The editor should render text with the bundled font
// (src/lib/engine/fonts/NotoSans-Regular.ttf), `line-height: 1.2`, and
// `font-kerning: none; font-variant-ligatures: none` so it matches the export.

/** Noto Sans metrics (OS/2 typo, USE_TYPO_METRICS set), in em. */
export const STAMP_FONT = {
	family: 'Noto Sans',
	ascent: 1.069,
	descent: 0.293,
	lineHeight: 1.2
} as const;

/**
 * Distance from the top of a line box to its baseline, in em: CSS half-leading model,
 * (lineHeight - (ascent + descent)) / 2 + ascent.
 */
export const STAMP_BASELINE_EM =
	(STAMP_FONT.lineHeight - (STAMP_FONT.ascent + STAMP_FONT.descent)) / 2 + STAMP_FONT.ascent;

export const STAMP_COLORS = {
	black: [0, 0, 0],
	blue: [0.051, 0.227, 0.62],
	red: [0.784, 0.063, 0.18]
} as const satisfies Record<'black' | 'blue' | 'red', readonly [number, number, number]>;

/** Normalize stamp text the same way for checking and drawing. */
export function normalizeStampText(text: string): string {
	return text.normalize('NFC').replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------
// Highlights. The editor draws the same shapes with CSS/SVG.

/**
 * Corner radius of a box highlight: this fraction of the displayed page height
 * (about 2.8 pt on Letter), and never more than a quarter of the box's shorter side.
 */
export const HIGHLIGHT_RADIUS = 0.0035;

/** Corner radius in the units of `pageHeight`, `w` and `h`. */
export function highlightRadius(pageHeight: number, w: number, h: number): number {
	return Math.max(0, Math.min(HIGHLIGHT_RADIUS * pageHeight, 0.25 * Math.min(w, h)));
}

// ---------------------------------------------------------------------------
// Marks, as vector paths in a box. Coordinates are fractions of the box,
// origin top-left, y down (display terms). The editor can draw the same SVG.

export const MARKS = {
	check: {
		kind: 'stroke',
		points: [
			[0.14, 0.54],
			[0.4, 0.8],
			[0.88, 0.2]
		],
		/** Stroke width as a fraction of min(box width, box height). */
		width: 0.13
	},
	cross: {
		kind: 'stroke',
		segments: [
			[
				[0.18, 0.18],
				[0.82, 0.82]
			],
			[
				[0.82, 0.18],
				[0.18, 0.82]
			]
		],
		width: 0.13
	},
	dot: {
		kind: 'fill',
		/** Circle centered in the box; radius as a fraction of min(width, height). */
		radius: 0.3
	}
} as const;
