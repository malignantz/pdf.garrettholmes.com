/**
 * Shared on-screen drawing rules for stamps, used by StampLayer (thumbnails) and
 * the page editor, so both look like the exported file:
 *  - text uses the engine's bundled font file, served from our own origin;
 *  - marks use the engine's vector definitions (engine/geometry.ts MARKS);
 *  - images use one object URL per asset, reference-counted.
 */

import type { Asset, AssetId, HighlightColor, PenStroke, Stamp, StampBox } from '../core/types';
import { HIGHLIGHT_RADIUS, MARKS, STAMP_COLORS, STAMP_FONT } from '../engine/geometry';
import fontUrl from '../engine/fonts/NotoSans-Regular.ttf?url';

/** CSS family name for the stamp font. Private so it never matches a system font. */
export const STAMP_FAMILY = 'PdfStampNotoSans';

let fontPromise: Promise<void> | null = null;

/** Load the stamp font once (about 600 KB, from our origin). Safe to call often. */
export function ensureStampFont(): Promise<void> {
	if (fontPromise) return fontPromise;
	if (typeof FontFace === 'undefined' || typeof document === 'undefined') return Promise.resolve();
	const face = new FontFace(STAMP_FAMILY, `url(${fontUrl})`, { style: 'normal', weight: '400', display: 'block' });
	fontPromise = face
		.load()
		.then((f) => {
			document.fonts.add(f);
		})
		.catch((e) => {
			fontPromise = null;
			console.warn('Stamp font failed to load', e);
		});
	return fontPromise;
}

export function cssColor(color: 'black' | 'blue' | 'red'): string {
	const [r, g, b] = STAMP_COLORS[color];
	return `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)})`;
}

/** RGB 0..255 for ink colours shared with the signature pad. */
export function inkRgb(color: 'black' | 'blue'): [number, number, number] {
	const [r, g, b] = STAMP_COLORS[color];
	return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * On-screen fill of a highlight stamp: the export's colours (engine/stamps.ts
 * HIGHLIGHT_RGB), drawn with `mix-blend-mode: multiply` like the export.
 */
export const HIGHLIGHT_CSS: Record<HighlightColor, string> = {
	yellow: '#FFEB3B',
	green: '#A5F36B',
	pink: '#FF9CCB'
};

export const HIGHLIGHT_COLORS: readonly HighlightColor[] = ['yellow', 'green', 'pink'];

/**
 * Corner radius of a box highlight in a layer with `container-type: size`: the
 * engine's highlightRadius (a share of the page height, at most a quarter of the
 * shorter side).
 */
export function highlightRadiusCss(box: StampBox): string {
	const f = (v: number) => v.toFixed(5);
	return `min(${f(HIGHLIGHT_RADIUS * 100)}cqh, ${f(box.w * 25)}cqw, ${f(box.h * 25)}cqh)`;
}

export interface PenSvg {
	viewBox: string;
	d: string;
	/** Stroke width in viewBox units. */
	width: number;
}

/**
 * SVG for a pen highlight drawn in its own box. viewBox units are page heights on
 * both axes (x is scaled by the page aspect), so the stroke keeps one width
 * whatever its direction, as in the export.
 */
export function penSvg(box: StampBox, pen: PenStroke, aspect: number): PenSvg {
	const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
	const f = (v: number) => v.toFixed(5);
	const d = pen.points.map((p, i) => `${i === 0 ? 'M' : 'L'}${f((p.x - box.x) * a)} ${f(p.y - box.y)}`).join('');
	return { viewBox: `0 0 ${f(box.w * a)} ${f(box.h)}`, d, width: pen.width };
}

export interface RectsSvg {
	viewBox: string;
	/** One path: every rectangle, rounded like a box highlight, filled once (nonzero). */
	d: string;
}

/**
 * SVG for a text highlight's rectangles in its own box. viewBox units are page heights
 * on both axes (x scaled by the page aspect), like penSvg; corners are rounded like a
 * box highlight's (engine highlightRadius). Every rectangle runs clockwise, so with the
 * nonzero rule overlaps are filled once, as in the export.
 */
export function rectsSvg(box: StampBox, rects: readonly StampBox[], aspect: number): RectsSvg {
	const a = aspect > 0 && Number.isFinite(aspect) ? aspect : 1;
	const f = (v: number) => v.toFixed(5);
	const d = rects
		.map((r) => {
			const x0 = (r.x - box.x) * a;
			const y0 = r.y - box.y;
			const x1 = x0 + r.w * a;
			const y1 = y0 + r.h;
			const rad = Math.max(0, Math.min(HIGHLIGHT_RADIUS, 0.25 * Math.min(x1 - x0, y1 - y0)));
			return (
				`M${f(x0 + rad)} ${f(y0)}H${f(x1 - rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x1)} ${f(y0 + rad)}` +
				`V${f(y1 - rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x1 - rad)} ${f(y1)}H${f(x0 + rad)}` +
				`A${f(rad)} ${f(rad)} 0 0 1 ${f(x0)} ${f(y1 - rad)}V${f(y0 + rad)}A${f(rad)} ${f(rad)} 0 0 1 ${f(x0 + rad)} ${f(y0)}Z`
			);
		})
		.join('');
	return { viewBox: `0 0 ${f(box.w * a)} ${f(box.h)}`, d };
}

/**
 * Draw order matching the export: redaction is applied to the page itself, then
 * highlights are drawn, then every other stamp in its own order.
 */
export function paintOrder<T extends Stamp>(stamps: readonly T[]): T[] {
	const rank = (s: Stamp) => (s.kind === 'redact' ? 0 : s.kind === 'highlight' ? 1 : 2);
	return stamps
		.map((s, i) => ({ s, i }))
		.sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i)
		.map((x) => x.s);
}

export const TEXT_LINE_HEIGHT = STAMP_FONT.lineHeight;

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

/**
 * Inline style placing a stamp inside a layer that fills the displayed page and
 * has `container-type: size` (text size uses `cqh`, a fraction of page height).
 */
export function stampStyle(s: Stamp): string {
	if (s.kind === 'text') {
		const turn = s.turn ? `;transform-origin:0 0;transform:rotate(${s.turn}deg)` : '';
		return `left:${pct(s.x)};top:${pct(s.y)};font-size:calc(${s.size.toFixed(6)} * 100cqh);color:${cssColor(s.color)}${turn}`;
	}
	return `left:${pct(s.box.x)};top:${pct(s.box.y)};width:${pct(s.box.w)};height:${pct(s.box.h)}`;
}

/**
 * Style of the element that holds a turned picture or check mark: upright in a box of
 * swapped sides (for a quarter turn), turned clockwise into the stamp's box (`turn`,
 * as the export does). `box` is the stamp's own box, the turned one.
 */
export function turnerStyle(box: StampBox, turn: 90 | 180 | 270): string {
	const w = (box.w * 100).toFixed(4);
	const h = (box.h * 100).toFixed(4);
	if (turn === 180) return `width:100%;height:100%;transform-origin:0 0;transform:translate(${w}cqw,${h}cqh) rotate(180deg)`;
	if (turn === 90) return `width:${h}cqh;height:${w}cqw;transform-origin:0 0;transform:translate(${w}cqw,0) rotate(90deg)`;
	return `width:${h}cqh;height:${w}cqw;transform-origin:0 0;transform:translate(0,${h}cqh) rotate(270deg)`;
}

export interface MarkSvg {
	viewBox: string;
	/** Path `d` for stroked marks. */
	d?: string;
	strokeWidth?: number;
	/** Circle for the dot. */
	circle?: { cx: number; cy: number; r: number };
}

/**
 * SVG for a mark in a box of display size (w, h) in any unit: the same points,
 * stroke width and radius the engine draws.
 */
export function markSvg(mark: 'check' | 'cross' | 'dot', w: number, h: number): MarkSvg {
	const def = MARKS[mark];
	const viewBox = `0 0 ${w.toFixed(5)} ${h.toFixed(5)}`;
	const m = Math.min(w, h);
	if (def.kind === 'fill') return { viewBox, circle: { cx: w / 2, cy: h / 2, r: def.radius * m } };
	const lines: ReadonlyArray<ReadonlyArray<readonly number[]>> = 'points' in def ? [def.points] : def.segments;
	const d = lines
		.map((line) => line.map((p, i) => `${i === 0 ? 'M' : 'L'}${(p[0] * w).toFixed(5)} ${(p[1] * h).toFixed(5)}`).join(''))
		.join('');
	return { viewBox, d, strokeWidth: def.width * m };
}

// ------------------------------------------------------------------ image URLs

const urls = new Map<AssetId, { url: string; refs: number }>();

/** Object URL for an asset's PNG. Call `releaseAssetUrl` once per acquire. */
export function acquireAssetUrl(asset: Asset): string {
	let e = urls.get(asset.id);
	if (!e) {
		const blob = new Blob([asset.png as Uint8Array<ArrayBuffer>], { type: 'image/png' });
		e = { url: URL.createObjectURL(blob), refs: 0 };
		urls.set(asset.id, e);
	}
	e.refs++;
	return e.url;
}

export function releaseAssetUrl(id: AssetId): void {
	const e = urls.get(id);
	if (!e) return;
	if (--e.refs <= 0) {
		urls.delete(id);
		URL.revokeObjectURL(e.url);
	}
}

/** For tests: how many object URLs are alive. */
export function liveAssetUrls(): number {
	return urls.size;
}

/** Readable name for a stamp, for ARIA labels and announcements. */
export function stampName(s: Stamp, assets: readonly Asset[]): string {
	if (s.kind === 'text') {
		const t = s.text.trim().split('\n')[0] ?? '';
		return t ? `Text "${t.length > 40 ? t.slice(0, 40) + '…' : t}"` : 'Empty text';
	}
	if (s.kind === 'mark') return s.mark === 'check' ? 'Check mark' : s.mark === 'cross' ? 'Cross mark' : 'Dot';
	if (s.kind === 'highlight') return `Highlight, ${s.color}`;
	if (s.kind === 'redact') return 'Redaction';
	const a = assets.find((x) => x.id === s.assetId);
	return a?.kind === 'initials' ? 'Initials' : a?.kind === 'signature' ? 'Signature' : 'Image';
}
