/**
 * The blank measurement's notion of a visible cue (moved here from
 * tools/forms-detect/cue.ts, unchanged, so the editor's snap on tap and the
 * measurement share one definition): does the page content (not a form widget)
 * draw something at a rectangle? A line along its top or bottom, a box about its
 * size, a ring, underscores or a hollow box glyph.
 */
import type { InkBox, InkGlyph, InkLine, Rect } from './forms-detect';

/** The parts of a page's ink the cue test reads. */
export interface CueInk {
	lines: InkLine[];
	boxes: InkBox[];
	circles: Rect[];
	/** Only underscores and box glyphs matter. */
	glyphs: Pick<InkGlyph, 'ch' | 'r' | 'shape'>[];
}

/** Keeps only what `cueAt` reads (smaller to send from the engine worker). */
export function cueInk(ink: CueInk): CueInk {
	return {
		lines: ink.lines.filter((l) => l.light <= 0.92),
		boxes: ink.boxes,
		circles: ink.circles,
		glyphs: ink.glyphs.filter((g) => g.ch === '_' || g.shape).map((g) => ({ ch: g.ch, r: g.r, ...(g.shape ? { shape: g.shape } : {}) }))
	};
}

/** Something drawn in the page content marks rectangle `r`; `check`: a checkbox or radio spot (vertical edges count too). */
export function cueAt(ink: CueInk, r: Rect, check = false): boolean {
	const w = r[2] - r[0];
	const h = r[3] - r[1];
	const g = Math.max(3, 0.3 * h);
	// Horizontal ink along the top or bottom covering half the width (pieces add up).
	let cover = 0;
	for (const l of ink.lines) {
		if (l.light > 0.92) continue;
		if (l.dir === 'h') {
			const o = Math.min(l.x1, r[2]) - Math.max(l.x0, r[0]);
			if (o > 0 && l.y0 >= r[1] - g && l.y0 <= r[3] + g) cover += o;
		} else if (check) {
			const o = Math.min(l.y1, r[3]) - Math.max(l.y0, r[1]);
			if (o >= 0.5 * h && l.x0 >= r[0] - g && l.x0 <= r[2] + g) return true;
		}
	}
	if (cover >= 0.5 * w) return true;
	for (const b of ink.boxes) {
		const ox = Math.min(b.r[2], r[2]) - Math.max(b.r[0], r[0]);
		const oy = Math.min(b.r[3], r[3]) - Math.max(b.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		const bArea = (b.r[2] - b.r[0]) * (b.r[3] - b.r[1]);
		// A box about the rectangle's size (not a page-wide background).
		if ((ox * oy) / (w * h) >= 0.5 && bArea <= 6 * w * h && (b.stroked || b.light < 0.97)) return true;
	}
	for (const c of ink.circles) {
		const ox = Math.min(c[2], r[2]) - Math.max(c[0], r[0]);
		const oy = Math.min(c[3], r[3]) - Math.max(c[1], r[1]);
		if (ox > 0 && oy > 0) return true;
	}
	for (const gl of ink.glyphs) {
		const ox = Math.min(gl.r[2], r[2]) - Math.max(gl.r[0], r[0]);
		const oy = Math.min(gl.r[3], r[3]) - Math.max(gl.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		if (gl.ch === '_' || gl.shape) return true;
	}
	return false;
}
