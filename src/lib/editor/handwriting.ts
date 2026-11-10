/**
 * Handwriting fonts for typed signatures. Bundled (SIL OFL 1.1, from @fontsource,
 * Latin + Latin Extended subsets) and served from our own origin; loaded only when
 * the Type tab opens. See THIRD-PARTY.md.
 */

import greatVibesLatin from './fonts/great-vibes-latin-400-normal.woff2?url';
import greatVibesExt from './fonts/great-vibes-latin-ext-400-normal.woff2?url';
import dancingLatin from './fonts/dancing-script-latin-400-normal.woff2?url';
import dancingExt from './fonts/dancing-script-latin-ext-400-normal.woff2?url';
import caveatLatin from './fonts/caveat-latin-400-normal.woff2?url';
import caveatExt from './fonts/caveat-latin-ext-400-normal.woff2?url';
import { alphaBounds, cropRgba } from './ink';

const LATIN =
	'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
	'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

export interface HandFont {
	id: string;
	/** Private CSS family name, so it never matches an installed font. */
	family: string;
	/** Short description for the picker. */
	label: string;
	files: [string, string];
}

export const HAND_FONTS: readonly HandFont[] = [
	{ id: 'great-vibes', family: 'PdfHandGreatVibes', label: 'Formal', files: [greatVibesLatin, greatVibesExt] },
	{ id: 'dancing-script', family: 'PdfHandDancingScript', label: 'Flowing', files: [dancingLatin, dancingExt] },
	{ id: 'caveat', family: 'PdfHandCaveat', label: 'Casual', files: [caveatLatin, caveatExt] }
];

let loading: Promise<void> | null = null;

/** Load all three fonts (both subsets). Resolves when every face is ready. */
export function loadHandFonts(): Promise<void> {
	if (loading) return loading;
	if (typeof FontFace === 'undefined') return Promise.resolve();
	const faces = HAND_FONTS.flatMap((f) => [
		new FontFace(f.family, `url(${f.files[0]}) format('woff2')`, { unicodeRange: LATIN, display: 'block' }),
		new FontFace(f.family, `url(${f.files[1]}) format('woff2')`, { unicodeRange: LATIN_EXT, display: 'block' })
	]);
	loading = Promise.all(
		faces.map((face) =>
			face.load().then((loaded) => {
				document.fonts.add(loaded);
			})
		)
	).then(
		() => undefined,
		(e) => {
			loading = null;
			throw e;
		}
	);
	return loading;
}

/** Fallback stacks that give clearly different widths for almost every character. */
export const PROBE_FALLBACKS = ['monospace', 'serif', 'sans-serif'] as const;

/**
 * Characters of `text` the font does not have. A character the font has is drawn
 * by the font whatever fallback follows it, so its width is the same with every
 * fallback; a missing one falls through to the fallbacks and the widths differ.
 * `measure(ch, fallback)` returns the advance width of `ch` in "<font>, <fallback>".
 * Whitespace is ignored. Returns unique characters in order of first use.
 */
export function missingChars(text: string, measure: (ch: string, fallback: string) => number): string {
	let bad = '';
	const seen = new Set<string>();
	for (const ch of text.normalize('NFC')) {
		if (seen.has(ch) || /\s/u.test(ch)) continue;
		seen.add(ch);
		const widths = PROBE_FALLBACKS.map((fb) => measure(ch, fb));
		if (/[\p{C}]/u.test(ch) || widths.some((w) => Math.abs(w - widths[0]) > 0.01)) bad += ch;
	}
	return bad;
}

/** Canvas-based measurer for missingChars. Call after loadHandFonts(). */
export function canvasMeasure(family: string): (ch: string, fallback: string) => number {
	const ctx = document.createElement('canvas').getContext('2d')!;
	return (ch, fallback) => {
		ctx.font = `100px "${family}", ${fallback}`;
		return ctx.measureText(ch).width;
	};
}

/** Canvas size for drawing `advance`-wide text at `px`: generous margins for swashes. */
export function textCanvasSize(advance: number, px: number) {
	const pad = Math.ceil(px * 0.9);
	return { width: Math.ceil(advance) + 2 * pad, height: Math.ceil(px * 2.6), x: pad, baseline: Math.ceil(px * 1.7) };
}

/**
 * Tight crop of RGBA pixels to the visible ink, with `pad` pixels kept around it.
 * Null when the image is empty.
 */
export function cropToInk(data: Uint8ClampedArray, width: number, height: number, pad = 2) {
	const r = alphaBounds(data, width, height, 4, pad);
	if (!r) return null;
	return { rect: r, data: cropRgba(data, width, r) };
}

/**
 * Render `text` in a handwriting font at high resolution and crop it to the ink.
 * Returns RGBA pixels ready for PNG encoding.
 */
export function renderTyped(text: string, family: string, color: string, px = 160): ImageData | null {
	const probe = document.createElement('canvas').getContext('2d')!;
	probe.font = `${px}px "${family}"`;
	const size = textCanvasSize(probe.measureText(text).width, px);
	const c = document.createElement('canvas');
	c.width = size.width;
	c.height = size.height;
	const ctx = c.getContext('2d', { willReadFrequently: true })!;
	ctx.font = `${px}px "${family}"`;
	ctx.fillStyle = color;
	ctx.textBaseline = 'alphabetic';
	ctx.fillText(text, size.x, size.baseline);
	const img = ctx.getImageData(0, 0, size.width, size.height);
	const crop = cropToInk(img.data, size.width, size.height, 3);
	if (!crop) return null;
	return new ImageData(crop.data as Uint8ClampedArray<ArrayBuffer>, crop.rect.width, crop.rect.height);
}
