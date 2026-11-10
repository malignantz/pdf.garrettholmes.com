/**
 * Shared on-screen drawing rules for stamps, used by StampLayer (thumbnails) and
 * the page editor, so both look like the exported file:
 *  - text uses the engine's bundled font file, served from our own origin;
 *  - marks use the engine's vector definitions (engine/geometry.ts MARKS);
 *  - images use one object URL per asset, reference-counted.
 */

import type { Asset, AssetId, HighlightColor, Stamp } from '../core/types';
import { MARKS, STAMP_COLORS, STAMP_FONT } from '../engine/geometry';
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

/** On-screen fill of a highlight stamp (the export blends with Multiply; this is a preview). */
export const HIGHLIGHT_CSS: Record<HighlightColor, string> = {
	yellow: 'rgb(255 230 0 / 0.4)',
	green: 'rgb(80 220 100 / 0.4)',
	pink: 'rgb(255 110 180 / 0.4)'
};

export const TEXT_LINE_HEIGHT = STAMP_FONT.lineHeight;

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

/**
 * Inline style placing a stamp inside a layer that fills the displayed page and
 * has `container-type: size` (text size uses `cqh`, a fraction of page height).
 */
export function stampStyle(s: Stamp): string {
	if (s.kind === 'text') {
		return `left:${pct(s.x)};top:${pct(s.y)};font-size:calc(${s.size.toFixed(6)} * 100cqh);color:${cssColor(s.color)}`;
	}
	return `left:${pct(s.box.x)};top:${pct(s.box.y)};width:${pct(s.box.w)};height:${pct(s.box.h)}`;
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
	if (s.kind === 'highlight') return 'Highlight';
	if (s.kind === 'redact') return 'Redaction';
	const a = assets.find((x) => x.id === s.assetId);
	return a?.kind === 'initials' ? 'Initials' : a?.kind === 'signature' ? 'Signature' : 'Image';
}
