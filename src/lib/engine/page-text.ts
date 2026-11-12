/**
 * The selectable words of a page, for the text highlighter (Engine.pageText).
 *
 * Source: MuPDF structured text of the page's own content (annotations and form
 * widgets are not part of it), read twice from one display list: once with the
 * font's nominal boxes (each character from its origin along its advance, ascent to
 * descent) and once with "accurate-bboxes" (each glyph's outline box: its ink). Both
 * passes list the same characters in the same order (checked; if not, the nominal
 * boxes stand in for the ink). The "clip" option leaves out characters that are
 * clipped away entirely; text in hidden layers is not run at all. Invisible text (an
 * OCR layer, render mode 3) is listed like any other. MuPDF puts right-to-left text in
 * logical order, so the word order is the reading order.
 *
 * Geometry (all in MuPDF page space: points, the page as displayed, origin top-left):
 * every line is laid out in its own frame (u along the writing direction, v across it,
 * ascent towards -v), so level, upright, upside-down and nearly level lines are the same
 * case. Lines more than MAX_TILT degrees off the page axes are not offered.
 *  - Across the line (v): from the font's ascent to its descent, but no further than the
 *    tallest ink that font has on this page (plus a margin), and never short of this
 *    line's own ink; then kept off the ink of the lines next to it (the band stops
 *    halfway between the two inks).
 *  - Along the line (u): each word's advance box (and ink) plus a margin that stays
 *    within half the gap to the next word.
 * A word's box is that frame rectangle turned back to the page and boxed.
 */

import type * as MU from 'mupdf';
import type { PageText, TextWord } from '../core/types';
import type { Mupdf } from './mupdf';

/** Lines this far (degrees) or less from a page axis are offered; others are not. */
export const MAX_TILT = 3;
/** Margin around the letters, as a share of the font size. */
export const MARGIN_EM = 0.1;
/** Pages with more characters than this are not offered (none have been seen near it). */
export const MAX_CHARS = 200_000;

/** One character as structured text gives it. Quads are 8 numbers: ul, ur, ll, lr corners. */
export interface RawChar {
	c: string;
	origin: [number, number];
	size: number;
	font: string;
	quad: number[];
	/** Ink quad (outline box), null when the glyph has none. */
	ink: number[] | null;
}

export interface RawLine {
	dir: [number, number];
	chars: RawChar[];
}

const destroy = (o: unknown) => {
	try {
		(o as { destroy?: () => void })?.destroy?.();
	} catch {
		// Already gone.
	}
};

/** The structured-text lines of a page's own content, nominal and ink boxes paired. */
export function readRawLines(page: MU.PDFPage): RawLine[] {
	const dl = page.toDisplayList(false);
	try {
		const read = (opts: string) => {
			const lines: { dir: [number, number]; chars: { c: string; origin: [number, number]; size: number; font: string; quad: number[] }[] }[] = [];
			const st = dl.toStructuredText(opts);
			try {
				st.walk({
					beginLine(_bbox, _wmode, dir) {
						lines.push({ dir: [dir[0], dir[1]], chars: [] });
					},
					onChar(c, origin, font, size, quad) {
						const line = lines[lines.length - 1];
						if (!line) return;
						let name = '';
						try {
							name = font.getName();
						} catch {
							name = '';
						}
						line.chars.push({ c, origin: [origin[0], origin[1]], size, font: name, quad: Array.from(quad as number[]) });
					}
				});
			} finally {
				destroy(st);
			}
			return lines;
		};
		const nominal = read('preserve-whitespace,clip');
		const ink = read('preserve-whitespace,clip,accurate-bboxes');
		const flatN = nominal.flatMap((l) => l.chars);
		const flatI = ink.flatMap((l) => l.chars);
		const paired = flatN.length === flatI.length && flatN.every((x, i) => x.c === flatI[i].c);
		let k = 0;
		return nominal.map((l) => ({
			dir: l.dir,
			chars: l.chars.map((ch) => {
				const q = paired ? flatI[k++].quad : ch.quad;
				return { ...ch, ink: hasArea(q) ? q : null };
			})
		}));
	} finally {
		destroy(dl);
	}
}

function hasArea(q: number[]): boolean {
	const xs = [q[0], q[2], q[4], q[6]];
	const ys = [q[1], q[3], q[5], q[7]];
	return Math.max(...xs) - Math.min(...xs) > 1e-3 && Math.max(...ys) - Math.min(...ys) > 1e-3 && [...xs, ...ys].every(Number.isFinite);
}

// ---------------------------------------------------------------------------
// Layout

interface Frame {
	c: number;
	s: number;
}
const toFrame = (f: Frame, x: number, y: number): [number, number] => [x * f.c + y * f.s, -x * f.s + y * f.c];
const fromFrame = (f: Frame, u: number, v: number): [number, number] => [u * f.c - v * f.s, u * f.s + v * f.c];

interface Span {
	u0: number;
	u1: number;
	v0: number;
	v1: number;
}

function quadSpan(f: Frame, q: number[]): Span {
	let u0 = Infinity;
	let u1 = -Infinity;
	let v0 = Infinity;
	let v1 = -Infinity;
	for (let i = 0; i < 8; i += 2) {
		const [u, v] = toFrame(f, q[i], q[i + 1]);
		u0 = Math.min(u0, u);
		u1 = Math.max(u1, u);
		v0 = Math.min(v0, v);
		v1 = Math.max(v1, v);
	}
	return { u0, u1, v0, v1 };
}

interface LChar {
	c: string;
	blank: boolean;
	font: string;
	em: number;
	/** Baseline (v of the origin). */
	base: number;
	nom: Span;
	ink: Span | null;
}

interface LLine {
	angle: number;
	frame: Frame;
	chars: LChar[];
	/** Band across the line, after trimming. */
	top: number;
	bottom: number;
	inkTop: number;
	inkBottom: number;
	u0: number;
	u1: number;
	em: number;
}

const blank = (c: string) => c.trim() === '';
const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? s[Math.floor(s.length / 2)] : 0;
};

/**
 * Words of a page from its raw lines. `width` and `height` are the page's displayed
 * size in points (MuPDF page space is [0 0 width height]).
 */
export function layoutWords(raw: RawLine[], width: number, height: number): PageText {
	let skipped = 0;
	let total = 0;
	for (const l of raw) total += l.chars.length;
	if (total > MAX_CHARS || !(width > 0 && height > 0)) {
		return { words: [], skipped: raw.reduce((n, l) => n + l.chars.filter((c) => !blank(c.c)).length, 0) };
	}

	// 1. Lines in their own frames; tilted lines and unusable glyphs are left out.
	const lines: LLine[] = [];
	for (const l of raw) {
		const visible = l.chars.filter((c) => !blank(c.c)).length;
		const [dx, dy] = l.dir;
		const len = Math.hypot(dx, dy);
		if (!(len > 0) || !Number.isFinite(len)) {
			skipped += visible;
			continue;
		}
		const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
		const off = Math.abs(angle - 90 * Math.round(angle / 90));
		if (off > MAX_TILT) {
			skipped += visible;
			continue;
		}
		const frame = { c: dx / len, s: dy / len };
		const chars: LChar[] = [];
		for (const ch of l.chars) {
			const nom = quadSpan(frame, ch.quad);
			const isBlank = blank(ch.c);
			const h = nom.v1 - nom.v0;
			const em = Number.isFinite(ch.size) && ch.size > 0 ? ch.size : h;
			// A glyph with no height and no ink (a font without metrics) cannot be placed.
			const ink = ch.ink ? quadSpan(frame, ch.ink) : null;
			if (!isBlank && !(h > 0.05 * em) && !ink) {
				skipped++;
				continue;
			}
			if (![nom.u0, nom.u1, nom.v0, nom.v1].every(Number.isFinite) || !(em > 0)) {
				if (!isBlank) skipped++;
				continue;
			}
			const [, base] = toFrame(frame, ch.origin[0], ch.origin[1]);
			chars.push({ c: ch.c, blank: isBlank, font: ch.font, em, base, nom, ink });
		}
		if (!chars.some((c) => !c.blank)) continue;
		lines.push({ angle, frame, chars, top: 0, bottom: 0, inkTop: 0, inkBottom: 0, u0: 0, u1: 0, em: 0 });
	}

	// 2. How tall each font's ink is on this page, in ems above and below the baseline.
	const inkUp = new Map<string, number>();
	const inkDown = new Map<string, number>();
	for (const l of lines)
		for (const ch of l.chars) {
			if (ch.blank || !ch.ink) continue;
			inkUp.set(ch.font, Math.max(inkUp.get(ch.font) ?? 0, (ch.base - ch.ink.v0) / ch.em));
			inkDown.set(ch.font, Math.max(inkDown.get(ch.font) ?? 0, (ch.ink.v1 - ch.base) / ch.em));
		}

	// 3. Each line's band: the font's ascent and descent, capped by that font's ink on the
	//    page plus a margin, never short of the line's own ink plus a margin.
	for (const l of lines) {
		let top = Infinity;
		let bottom = -Infinity;
		let inkTop = Infinity;
		let inkBottom = -Infinity;
		let u0 = Infinity;
		let u1 = -Infinity;
		const ems: number[] = [];
		for (const ch of l.chars) {
			if (ch.blank) continue;
			ems.push(ch.em);
			const m = MARGIN_EM * ch.em;
			const up = inkUp.get(ch.font);
			const down = inkDown.get(ch.font);
			let a = ch.base - ch.nom.v0;
			let d = ch.nom.v1 - ch.base;
			if (up !== undefined) a = Math.min(a, up * ch.em + m);
			if (down !== undefined) d = Math.min(d, down * ch.em + m);
			let t = ch.base - a;
			let b = ch.base + d;
			if (ch.ink) {
				t = Math.min(t, ch.ink.v0 - m);
				b = Math.max(b, ch.ink.v1 + m);
				inkTop = Math.min(inkTop, ch.ink.v0);
				inkBottom = Math.max(inkBottom, ch.ink.v1);
			} else {
				inkTop = Math.min(inkTop, ch.nom.v0);
				inkBottom = Math.max(inkBottom, ch.nom.v1);
			}
			if (!(b > t)) {
				t = ch.nom.v0;
				b = ch.nom.v1;
			}
			top = Math.min(top, t);
			bottom = Math.max(bottom, b);
			u0 = Math.min(u0, ch.nom.u0, ch.ink?.u0 ?? Infinity);
			u1 = Math.max(u1, ch.nom.u1, ch.ink?.u1 ?? -Infinity);
		}
		Object.assign(l, { top, bottom, inkTop, inkBottom, u0, u1, em: median(ems) });
	}

	// 4. Keep each band off the ink of the lines beside it (same direction, overlapping
	//    along the line): it stops halfway between the two inks.
	trimBands(lines);

	// 5. Words, with a margin along the line that stays within half the gap to the next word.
	const words: TextWord[] = [];
	lines.forEach((l, li) => {
		const groups: LChar[][] = [];
		let cur: LChar[] = [];
		for (const ch of l.chars) {
			if (ch.blank) {
				if (cur.length) groups.push(cur);
				cur = [];
			} else cur.push(ch);
		}
		if (cur.length) groups.push(cur);
		const spans = groups.map((g) => {
			let a = Infinity;
			let b = -Infinity;
			for (const ch of g) {
				a = Math.min(a, ch.nom.u0, ch.ink?.u0 ?? Infinity);
				b = Math.max(b, ch.nom.u1, ch.ink?.u1 ?? -Infinity);
			}
			return { a, b, em: median(g.map((c) => c.em)) };
		});
		// Neighbours along the line, in position order (right-to-left words come reversed).
		const order = spans.map((_, i) => i).sort((i, j) => spans[i].a - spans[j].a);
		const padL = new Array<number>(spans.length);
		const padR = new Array<number>(spans.length);
		order.forEach((wi, k) => {
			const m = MARGIN_EM * spans[wi].em;
			const prev = k > 0 ? spans[order[k - 1]] : null;
			const next = k < order.length - 1 ? spans[order[k + 1]] : null;
			padL[wi] = prev ? Math.max(0, Math.min(m, (spans[wi].a - prev.b) / 2)) : m;
			padR[wi] = next ? Math.max(0, Math.min(m, (next.a - spans[wi].b) / 2)) : m;
		});
		groups.forEach((g, gi) => {
			const s = spans[gi];
			const corners = [
				fromFrame(l.frame, s.a - padL[gi], l.top),
				fromFrame(l.frame, s.b + padR[gi], l.top),
				fromFrame(l.frame, s.a - padL[gi], l.bottom),
				fromFrame(l.frame, s.b + padR[gi], l.bottom)
			];
			const xs = corners.map((p) => p[0]);
			const ys = corners.map((p) => p[1]);
			const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
			const x0 = clamp(Math.min(...xs), width);
			const x1 = clamp(Math.max(...xs), width);
			const y0 = clamp(Math.min(...ys), height);
			const y1 = clamp(Math.max(...ys), height);
			if (!(x1 - x0 > 0.01 && y1 - y0 > 0.01)) {
				skipped += g.length;
				return;
			}
			words.push({
				text: g.map((c) => c.c).join(''),
				box: { x: x0 / width, y: y0 / height, w: (x1 - x0) / width, h: (y1 - y0) / height },
				line: li
			});
		});
	});
	// Renumber lines densely (a line can lose all its words to the page edge).
	let last = -1;
	let n = -1;
	for (const w of words) {
		if (w.line !== last) {
			last = w.line;
			n++;
		}
		w.line = n;
	}
	return { words, skipped };
}

/** Same direction within the tilt limit. */
const sameDir = (a: LLine, b: LLine) => {
	const d = Math.abs(((a.angle - b.angle + 540) % 360) - 180);
	return d <= 2 * MAX_TILT;
};

function trimBands(lines: LLine[]) {
	const limits = lines.map((l) => ({ top: l.top, bottom: l.bottom }));
	// Group by direction, then sweep pairs whose bands could touch.
	const buckets = new Map<number, number[]>();
	lines.forEach((l, i) => {
		const k = ((Math.round(l.angle / 90) % 4) + 4) % 4;
		const list = buckets.get(k) ?? [];
		list.push(i);
		buckets.set(k, list);
	});
	for (const [k, ids] of buckets) {
		// Each line's extent across the writing direction in the bucket's axis frame, so
		// lines a degree or two apart sort and compare on one scale.
		const axis: Frame = { c: [1, 0, -1, 0][k], s: [0, 1, 0, -1][k] };
		const ext = new Map<number, [number, number]>();
		for (const i of ids) {
			const l = lines[i];
			const vs = [
				fromFrame(l.frame, l.u0, l.top),
				fromFrame(l.frame, l.u1, l.top),
				fromFrame(l.frame, l.u0, l.bottom),
				fromFrame(l.frame, l.u1, l.bottom)
			].map(([x, y]) => toFrame(axis, x, y)[1]);
			ext.set(i, [Math.min(...vs), Math.max(...vs)]);
		}
		ids.sort((i, j) => ext.get(i)![0] - ext.get(j)![0]);
		for (let a = 0; a < ids.length; a++) {
			const L = lines[ids[a]];
			const lb = ext.get(ids[a])![1];
			for (let b = a + 1; b < ids.length; b++) {
				if (ext.get(ids[b])![0] > lb) break;
				if (!sameDir(L, lines[ids[b]])) continue;
				trimPair(lines, limits, ids[a], ids[b]);
			}
		}
	}
	lines.forEach((l, i) => {
		l.top = limits[i].top;
		l.bottom = limits[i].bottom;
	});
}

/** Two lines whose bands overlap: if they are distinct lines side by side across the writing direction, split at the gap between their inks. */
function trimPair(lines: LLine[], limits: { top: number; bottom: number }[], i: number, j: number) {
	const A = lines[i];
	const B = lines[j];
	// Along-the-line overlap, in A's frame (B's corners mapped into it).
	const bu = [
		fromFrame(B.frame, B.u0, B.top),
		fromFrame(B.frame, B.u1, B.top),
		fromFrame(B.frame, B.u0, B.bottom),
		fromFrame(B.frame, B.u1, B.bottom)
	].map(([x, y]) => toFrame(A.frame, x, y)[0]);
	const bu0 = Math.min(...bu);
	const bu1 = Math.max(...bu);
	if (bu1 <= A.u0 || bu0 >= A.u1) return;
	const ca = (A.inkTop + A.inkBottom) / 2;
	const cb = (B.inkTop + B.inkBottom) / 2;
	// The same line split in two (one baseline), or text on text: nothing to keep apart.
	if (Math.abs(ca - cb) < 0.3 * Math.min(A.inkBottom - A.inkTop, B.inkBottom - B.inkTop)) return;
	const [upper, lower, ui, li] = ca < cb ? [A, B, i, j] : [B, A, j, i];
	const cut = upper.inkBottom <= lower.inkTop ? (upper.inkBottom + lower.inkTop) / 2 : null;
	limits[ui].bottom = Math.min(limits[ui].bottom, cut ?? upper.inkBottom);
	limits[li].top = Math.max(limits[li].top, cut ?? lower.inkTop);
}

// ---------------------------------------------------------------------------
// Pages of an opened document

/** Words of page `index` of an opened MuPDF document. */
export function pageTextOf(doc: MU.Document, index: number): PageText {
	const page = doc.loadPage(index) as MU.PDFPage;
	try {
		const [x0, y0, x1, y1] = page.getBounds();
		const raw = readRawLines(page);
		// Page space starts at the bounds' corner (always 0 0 for a PDF page; kept general).
		if (x0 !== 0 || y0 !== 0)
			for (const l of raw)
				for (const ch of l.chars) {
					ch.origin = [ch.origin[0] - x0, ch.origin[1] - y0];
					ch.quad = ch.quad.map((v, k) => v - (k % 2 ? y0 : x0));
					if (ch.ink) ch.ink = ch.ink.map((v, k) => v - (k % 2 ? y0 : x0));
				}
		return layoutWords(raw, x1 - x0, y1 - y0);
	} finally {
		destroy(page);
	}
}

/** Opened documents by source id, the most recent last; a few are kept. */
export class TextDocs {
	private docs = new Map<string, { m: Mupdf; doc: MU.Document }>();
	constructor(private readonly keep = 2) {}

	get(m: Mupdf, id: string, bytes: Uint8Array | undefined): MU.Document | null {
		const hit = this.docs.get(id);
		if (hit && hit.m === m) {
			this.docs.delete(id);
			this.docs.set(id, hit);
			return hit.doc;
		}
		if (hit) this.drop(id);
		if (!bytes) return null;
		// MuPDF copies the bytes into its own memory.
		const doc = m.Document.openDocument(bytes, 'application/pdf');
		this.docs.set(id, { m, doc });
		while (this.docs.size > this.keep) this.drop(this.docs.keys().next().value!);
		return doc;
	}

	drop(id: string) {
		const e = this.docs.get(id);
		this.docs.delete(id);
		if (e) destroy(e.doc);
	}

	clear() {
		for (const id of [...this.docs.keys()]) this.drop(id);
	}
}
