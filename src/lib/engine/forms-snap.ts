/**
 * Tap to snap on flat forms: a measured prototype, not wired into the app. See the
 * plan, "Stretch: make a flat form fillable", for the method and the numbers
 * (tools/forms-snap/ measures it against real AcroForm widgets).
 *
 * The user points; this only snaps. With the Text tool the user taps roughly where
 * they want to write. `snapAt` returns the field rectangle near the tap that the
 * page's ink suggests (a line to sit on, a box or table cell to fill, a small square
 * to tick, a comb row), or null ("no snap": the app would place its plain default
 * box at the tap). Whether there is a blank at all, and how many fields a blank is,
 * the user has already answered by tapping.
 *
 * - `prepareSnap(ink)` once per page (after `collectInk`): the page's geometry and
 *   every candidate field the blank detector finds in raw mode, at any confidence,
 *   plus the ruling under each line-like candidate (for "more like this").
 * - `snapAt(page, point)` picks among the candidates by where the tap is. Pure,
 *   deterministic, a linear scan over the candidates (well under a millisecond).
 * - `similarTo(page, examples)`: given fields the user has confirmed, the other
 *   candidates on the page with the same rule and similar geometry.
 */

import { declines, detectBlanks, overlaps, pageGeometry, type BlankSource, type PageGeometry, type PageInk, type Rect } from './forms-detect';

export type SnapKind = 'text' | 'check';
export type SnapRule = BlankSource;

export interface SnapResult {
	rect: Rect;
	kind: SnapKind;
	/** The detector rule that produced the candidate. */
	rule: SnapRule;
	/** 0 … 1. */
	confidence: number;
	label: string;
	/** What the confidence was made from. */
	why?: SnapWhy;
}

export interface SnapWhy {
	/** Distance from the tap to the rectangle (0 inside), points. */
	d: number;
	/** Score gap to the next candidate (Infinity when alone). */
	gap: number;
	/** The tap is on a word. */
	onWord: boolean;
	/** The detector's confidence that the candidate is a blank. */
	base: number;
	/** The tap is across a drawn rule from the field. */
	cross: boolean;
}

interface Candidate extends SnapResult {
	/** The detector's own confidence that this is a blank at all. */
	base: number;
	/** The ruling the field sits on (line-like rules), for similarity. */
	floor?: { w: number; dashed: boolean };
	area: number;
}

export interface SnapPage {
	geo: PageGeometry;
	cands: Candidate[];
	declined: boolean;
}

export interface SnapOptions {
	/** How far outside a candidate a tap may land, points (text, check). */
	reachText?: number;
	reachCheck?: number;
	/** Score added for a candidate on the other side of a drawn rule from the tap, points. */
	cross?: number;
	/** Only these rules may answer (a narrower scope); default all. */
	rules?: readonly SnapRule[];
	/** Snaps below this confidence are dropped (no snap); default 0. */
	minConfidence?: number;
}

export interface PrepareOptions {
	/** An empty small cell is a checkbox when width ≤ this × height (detector default 2.5). */
	cellCheckRatio?: number;
	/** An open rule with another rule above it within this many line heights fills the band between them (0: off). */
	band?: number;
}

const TEXT_REACH = 8;
const CHECK_REACH = 7;

const LINE_RULES = new Set<SnapRule>(['rule', 'cell', 'cell-band', 'cell-right', 'lines']);

export function prepareSnap(ink: PageInk, opts: PrepareOptions = {}): SnapPage {
	if (declines(ink)) return { geo: pageGeometry({ ...ink, glyphs: [], lines: [], boxes: [], circles: [] }), cands: [], declined: true };
	const geo = pageGeometry(ink);
	const lineH = geo.body * 1.25;
	const band = opts.band ?? 2.5;
	const cands: Candidate[] = detectBlanks(ink, { raw: true, minRule: 12, cellCheckRatio: opts.cellCheckRatio ?? 1.4 }, geo).map((s) => {
		let rect = s.rect;
		if (s.source === 'rule' && band > 0) {
			// Lined paper: the band up to the rule above, when no text stands in it.
			const [x0, , x1, y] = rect;
			const span = (a: number, b: number) => Math.min(b, x1) - Math.max(a, x0) >= 0.8 * (x1 - x0);
			const ceil = Math.max(-Infinity, ...geo.h.filter((r) => r.at < y - 2 && span(r.a, r.b)).map((r) => r.at));
			const text = Math.max(-Infinity, ...geo.ws.filter((w) => w.r[3] < y - 1 && Math.min(w.r[2], x1) - Math.max(w.r[0], x0) > 1).map((w) => w.r[3]));
			if (ceil > text && y - ceil <= band * lineH && ceil + 1 < rect[1]) rect = [x0, ceil + 1, x1, y];
		}
		const c: Candidate = {
			rect,
			kind: s.kind === 'checkbox' ? 'check' : 'text',
			rule: s.source,
			confidence: s.confidence,
			base: s.confidence,
			label: s.label,
			area: (rect[2] - rect[0]) * (rect[3] - rect[1])
		};
		if (LINE_RULES.has(s.source)) {
			const y = s.rect[3];
			const under = geo.h.filter((r) => Math.abs(r.at - y) <= 1.5 && r.a <= s.rect[0] + 2 && r.b >= s.rect[2] - 2).sort((p, q) => Math.abs(p.at - y) - Math.abs(q.at - y))[0];
			if (under) c.floor = { w: under.w, dashed: under.pieces >= 6 };
		}
		return c;
	});
	return { geo, cands, declined: false };
}

/** Distance from a point to a rectangle (0 inside). */
function dist(p: [number, number], r: Rect): number {
	const dx = Math.max(r[0] - p[0], 0, p[0] - r[2]);
	const dy = Math.max(r[1] - p[1], 0, p[1] - r[3]);
	return Math.hypot(dx, dy);
}

/**
 * How often a snap by this rule, at the detector's confidence `base` that it is a
 * blank, gave a rectangle the user would accept (measured on tuning sample A: taps on
 * real-world form widgets with a visible cue). The detector's confidence means "is
 * this a blank at all"; this means "is this the right rectangle".
 */
function calibrated(rule: SnapRule, base: number): number {
	switch (rule) {
		case 'circle':
			return 0.99;
		case 'comb':
			return 0.97;
		case 'glyph':
			return 0.96;
		case 'square':
			return 0.94;
		case 'cell-check':
			return base >= 0.8 ? 0.97 : 0.8;
		case 'cell-right':
			return base >= 0.8 ? 0.98 : 0.88;
		case 'underscore':
			return 0.88;
		case 'cell-band':
			return base >= 0.7 ? 0.9 : base >= 0.45 ? 0.84 : 0.75;
		case 'cell':
			// Tall cells (detector 0.45) and narrow or unlabelled ones are often drawn differently by the author.
			if (base >= 0.9) return 0.97;
			if (base >= 0.75 && base < 0.8) return 0.97;
			if (base >= 0.8) return 0.89;
			if (base >= 0.7) return 0.66;
			if (base >= 0.4 && base < 0.45) return 0.88;
			if (base >= 0.45) return 0.64;
			return base >= 0.35 ? 0.76 : 0.1;
		case 'rule':
			if (base >= 0.85) return 0.9;
			if (base >= 0.7) return 0.8;
			if (base >= 0.55) return 0.7;
			if (base >= 0.5) return 0.45;
			return 0.78;
		default:
			return 0.5 * base;
	}
}

/** A drawn rule runs between the tap and the candidate (the tap is on the other side of a line). */
function crosses(page: SnapPage, p: [number, number], r: Rect): boolean {
	const [x, y] = p;
	if (y > r[3] || y < r[1]) {
		const cx = Math.min(Math.max(x, r[0]), r[2]);
		const lo = y > r[3] ? r[3] - 1 : y;
		const hi = y > r[3] ? y : r[1] + 1;
		if (page.geo.h.some((l) => l.at > lo && l.at < hi && l.a <= cx && l.b >= cx && l.b - l.a >= 6)) return true;
	}
	if (x > r[2] || x < r[0]) {
		const cy = Math.min(Math.max(y, r[1]), r[3]);
		const lo = x > r[2] ? r[2] - 1 : x;
		const hi = x > r[2] ? x : r[0] + 1;
		if (page.geo.v.some((l) => l.at > lo && l.at < hi && l.a <= cy && l.b >= cy && l.b - l.a >= 6)) return true;
	}
	return false;
}

/** The field to place for a tap at `p` (page space, points, y down), or null. */
export function snapAt(page: SnapPage, p: [number, number], opts: SnapOptions = {}): SnapResult | null {
	if (page.declined) return null;
	const reach = (c: Candidate) => (c.kind === 'check' ? (opts.reachCheck ?? CHECK_REACH) : (opts.reachText ?? TEXT_REACH));
	const near: { c: Candidate; d: number; score: number; x: boolean }[] = [];
	for (const c of page.cands) {
		if (opts.rules && !opts.rules.includes(c.rule)) continue;
		const d = dist(p, c.rect);
		if (d > reach(c)) continue;
		// A tap on or beside a small square means the square; otherwise the nearest, the smaller on a tie.
		const x = d > 0 && crosses(page, p, c.rect);
		const score = d - (c.kind === 'check' && d <= 3 ? 3 : 0) + Math.min(1, c.area / 1e5) + (x ? (opts.cross ?? 4) : 0);
		near.push({ c, d, score, x });
	}
	if (!near.length) return null;
	near.sort((a, b) => a.score - b.score || a.c.rect[1] - b.c.rect[1] || a.c.rect[0] - b.c.rect[0]);
	const best = near[0];
	const second = near[1];
	const gap = second ? second.score - best.score : Infinity;
	const onWord = page.geo.ws.some((w) => p[0] >= w.r[0] && p[0] <= w.r[2] && p[1] >= w.r[1] + 0.15 * w.size && p[1] <= w.r[3]);
	const text = best.c.kind === 'text';
	let conf = calibrated(best.c.rule, best.c.base);
	// Free space right of a number or an amount in a table cell: a data table, not a label and a blank.
	if (best.c.rule === 'cell-right' && best.c.base < 0.8 && /^[\d.,%$€£()+\-/: ]+$/.test(best.c.label)) conf *= 0.5;
	// Another candidate about as near: a coin toss between neighbours (worst in tight checkbox columns).
	if (gap < 2) conf *= text ? 0.8 : 0.6;
	if (best.c.rule === 'cell-check' && best.d > 0) conf *= 0.85;
	if (text && best.d >= 3) conf *= 0.85;
	if (text && best.x) conf *= 0.85;
	if (onWord && (best.c.rule === 'rule' || best.c.rule === 'cell-band')) conf *= 0.9;
	if (conf < (opts.minConfidence ?? 0)) return null;
	const { rect, kind, rule, label } = best.c;
	return { rect, kind, rule, label, confidence: Math.round(Math.max(0, Math.min(1, conf)) * 100) / 100, why: { d: best.d, gap, onWord, base: best.c.base, cross: best.x } };
}

export interface SimilarOptions {
	/** Relative tolerance on length, height and side (default 0.35). */
	tol?: number;
}

/**
 * "More like this": candidates sharing the rule of one of the confirmed `examples`
 * with similar geometry (line thickness and style, height, length or column
 * alignment; for squares the side), excluding the examples themselves.
 */
export function similarTo(page: SnapPage, examples: SnapResult[], opts: SimilarOptions = {}): SnapResult[] {
	if (page.declined) return [];
	const tol = opts.tol ?? 0.35;
	const close = (a: number, b: number, t = tol) => Math.abs(a - b) <= t * Math.max(a, b);
	const ex = examples.map((e) => page.cands.find((c) => c.rule === e.rule && Math.abs(c.rect[0] - e.rect[0]) < 0.5 && Math.abs(c.rect[3] - e.rect[3]) < 0.5) ?? null);
	const out: SnapResult[] = [];
	for (const c of page.cands) {
		if (examples.some((e) => overlaps(e.rect, c.rect, 1))) continue;
		const match = examples.some((e, i) => {
			if (e.rule !== c.rule || e.kind !== c.kind) return false;
			const w = c.rect[2] - c.rect[0];
			const h = c.rect[3] - c.rect[1];
			const ew = e.rect[2] - e.rect[0];
			const eh = e.rect[3] - e.rect[1];
			if (c.kind === 'check') return close(w, ew, 0.2) && close(h, eh, 0.2);
			const f = ex[i]?.floor;
			if (f && c.floor && (Math.abs(f.w - c.floor.w) > 0.3 || f.dashed !== c.floor.dashed)) return false;
			if (!close(h, eh)) return false;
			const aligned = Math.abs(c.rect[0] - e.rect[0]) <= 2 || Math.abs(c.rect[2] - e.rect[2]) <= 2;
			return aligned || close(w, ew);
		});
		if (match) out.push({ rect: c.rect, kind: c.kind, rule: c.rule, label: c.label, confidence: c.base });
	}
	return out;
}
