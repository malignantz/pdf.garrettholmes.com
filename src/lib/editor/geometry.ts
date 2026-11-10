/**
 * Pure maths for the page editor: the zoom/pan view, screen <-> page-fraction
 * conversion, and moving/resizing stamp boxes inside the page. No DOM.
 *
 * Page fractions are the contract's display space (core/types.ts StampBox):
 * 0..1 of the page as displayed, origin top-left, y down.
 */

import type { StampBox } from '../core/types';

export interface Size {
	width: number;
	height: number;
}

export interface Point {
	x: number;
	y: number;
}

/**
 * The editor view. `zoom` 1 means "page fits the viewport". `panX`/`panY` are the
 * page's top-left corner in viewport CSS pixels.
 */
export interface View {
	zoom: number;
	panX: number;
	panY: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 6;

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** Page size in CSS px at zoom 1: as large as fits inside `viewport` minus `margin` on each side. */
export function fitSize(viewport: Size, pageAspect: number, margin = 16): Size {
	const aw = Math.max(1, viewport.width - 2 * margin);
	const ah = Math.max(1, viewport.height - 2 * margin);
	const a = pageAspect > 0 && Number.isFinite(pageAspect) ? pageAspect : 1;
	if (aw / ah > a) return { width: ah * a, height: ah };
	return { width: aw, height: aw / a };
}

export function clampZoom(z: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
	return Number.isFinite(z) ? clamp(z, min, max) : min;
}

/** Displayed page size at the view's zoom. */
export function scaledSize(base: Size, zoom: number): Size {
	return { width: base.width * zoom, height: base.height * zoom };
}

/** The page centred in the viewport at `zoom`. */
export function centeredView(viewport: Size, base: Size, zoom = 1): View {
	const s = scaledSize(base, zoom);
	return { zoom, panX: (viewport.width - s.width) / 2, panY: (viewport.height - s.height) / 2 };
}

/**
 * Keep the page reachable: on an axis where the page is smaller than the viewport
 * it is centred; where it is larger, no gap wider than `margin` may open at either edge.
 */
export function clampPan(view: View, viewport: Size, base: Size, margin = 16): View {
	const s = scaledSize(base, view.zoom);
	const axis = (pan: number, page: number, port: number) => {
		if (page + 2 * margin <= port) return (port - page) / 2;
		return clamp(pan, port - page - margin, margin);
	};
	return { zoom: view.zoom, panX: axis(view.panX, s.width, viewport.width), panY: axis(view.panY, s.height, viewport.height) };
}

/** Viewport point (CSS px, relative to the viewport's top-left) to page fraction. Not clamped. */
export function screenToFraction(p: Point, view: View, base: Size): Point {
	const s = scaledSize(base, view.zoom);
	return { x: (p.x - view.panX) / s.width, y: (p.y - view.panY) / s.height };
}

export function fractionToScreen(f: Point, view: View, base: Size): Point {
	const s = scaledSize(base, view.zoom);
	return { x: view.panX + f.x * s.width, y: view.panY + f.y * s.height };
}

/** Change zoom so the page point under `anchor` (viewport px) stays under it. */
export function zoomAt(view: View, base: Size, zoom: number, anchor: Point): View {
	const z = clampZoom(zoom);
	const f = screenToFraction(anchor, view, base);
	const s = scaledSize(base, z);
	return { zoom: z, panX: anchor.x - f.x * s.width, panY: anchor.y - f.y * s.height };
}

/**
 * Two-finger pinch. `start` is the view when the second finger landed, `m0`/`d0`
 * the midpoint and distance then, `m1`/`d1` now. The page point under the starting
 * midpoint follows the current midpoint.
 */
export function pinchView(start: View, base: Size, m0: Point, d0: number, m1: Point, d1: number): View {
	const z = clampZoom(start.zoom * (d0 > 0 ? d1 / d0 : 1));
	const f = screenToFraction(m0, start, base);
	const s = scaledSize(base, z);
	return { zoom: z, panX: m1.x - f.x * s.width, panY: m1.y - f.y * s.height };
}

// ------------------------------------------------------------------ stamp boxes

/** Smallest stamp side, as a fraction of the page side. */
export const MIN_SIDE = 0.008;

/** Keep a box inside the page; shrinks it (keeping its aspect) only if it is larger than the page. */
export function clampBox(b: StampBox): StampBox {
	let { w, h } = b;
	const over = Math.max(w / 1, h / 1);
	if (over > 1) {
		w /= over;
		h /= over;
	}
	w = Math.max(w, 1e-6);
	h = Math.max(h, 1e-6);
	return { x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h), w, h };
}

/** A box of size w x h centred on `p`, kept inside the page. */
export function boxAround(p: Point, w: number, h: number): StampBox {
	return clampBox({ x: p.x - w / 2, y: p.y - h / 2, w, h });
}

export function moveBox(b: StampBox, dx: number, dy: number): StampBox {
	return clampBox({ ...b, x: b.x + dx, y: b.y + dy });
}

export type Handle = 'nw' | 'ne' | 'sw' | 'se';

/**
 * Resize by dragging a corner handle to `p` (page fraction). The opposite corner
 * stays put. With `lockAspect` (images, marks, text) the box keeps its shape
 * and the larger of the two scale factors wins, so the box follows the finger.
 * The result never leaves the page and never gets smaller than `minSide`.
 */
export function resizeBox(start: StampBox, handle: Handle, p: Point, lockAspect = true, minSide = MIN_SIDE): StampBox {
	const west = handle === 'nw' || handle === 'sw';
	const north = handle === 'nw' || handle === 'ne';
	const ax = west ? start.x + start.w : start.x;
	const ay = north ? start.y + start.h : start.y;
	// Room from the anchor towards the dragged corner.
	const roomX = west ? ax : 1 - ax;
	const roomY = north ? ay : 1 - ay;
	let w = Math.max(0, west ? ax - p.x : p.x - ax);
	let h = Math.max(0, north ? ay - p.y : p.y - ay);
	if (lockAspect && start.w > 0 && start.h > 0) {
		const minScale = Math.max(minSide / start.w, minSide / start.h);
		const maxScale = Math.min(roomX / start.w, roomY / start.h);
		const scale = clamp(Math.max(w / start.w, h / start.h), Math.min(minScale, maxScale), maxScale);
		w = start.w * scale;
		h = start.h * scale;
	} else {
		w = clamp(w, Math.min(minSide, roomX), roomX);
		h = clamp(h, Math.min(minSide, roomY), roomY);
	}
	return { x: west ? ax - w : ax, y: north ? ay - h : ay, w, h };
}

/**
 * Move a box to another page with a different displayed aspect (width / height)
 * so it keeps its on-screen shape: same x, y and width fraction, height adjusted.
 */
export function adaptBox(b: StampBox, fromAspect: number, toAspect: number): StampBox {
	if (!(fromAspect > 0) || !(toAspect > 0)) return clampBox(b);
	return clampBox({ ...b, h: (b.h * toAspect) / fromAspect });
}

/** Nudge step for arrow keys, as a page fraction. */
export function nudgeStep(large: boolean): number {
	return large ? 0.02 : 0.002;
}

/** Arrow key to direction, or null. */
export function arrowDelta(key: string): Point | null {
	switch (key) {
		case 'ArrowLeft':
			return { x: -1, y: 0 };
		case 'ArrowRight':
			return { x: 1, y: 0 };
		case 'ArrowUp':
			return { x: 0, y: -1 };
		case 'ArrowDown':
			return { x: 0, y: 1 };
		default:
			return null;
	}
}

// ------------------------------------------------------------------ defaults

/**
 * Default box for a new image stamp: `widthFrac` of the page width, keeping the
 * image's aspect on screen. `pageAspect` is displayed width / height.
 */
export function imageBoxSize(imgW: number, imgH: number, pageAspect: number, widthFrac: number): Size {
	const w = widthFrac;
	// Display px: width = w * W, height = h * H; want (w*W)/(h*H) = imgW/imgH.
	const h = (w * pageAspect * imgH) / imgW;
	if (h <= 0.5) return { width: w, height: h };
	// Very tall images: cap the height instead.
	return { width: (0.5 * imgW) / (pageAspect * imgH), height: 0.5 };
}

/** A square on screen whose side is `frac` of the page's shorter displayed side. */
export function squareBoxSize(pageAspect: number, frac: number): Size {
	// shorter side in units of page height: min(aspect, 1)
	const sideInH = frac * Math.min(pageAspect, 1);
	return { width: sideInH / pageAspect, height: sideInH };
}
