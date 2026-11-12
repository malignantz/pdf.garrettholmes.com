/**
 * Snap on tap: where text typed with the Text tool, or a tick placed with the Check
 * tool, lands on a flat (non-AcroForm) form. The user points; this only decides
 * whether the tap meant a blank the page draws (a line, a box or cell, a comb row, a
 * small square) and places the text or tick in it. Otherwise it answers null and the
 * editor places as it always did. Pure, synchronous, page space (points, origin
 * top-left, the page as displayed); the data comes from the engine worker
 * (engine/snap-tap.ts) and is cached per page by snap-cache.ts.
 *
 * Every rule here was fixed on the tuning sample of real forms and checked on the
 * held-out one (tools/forms-snap/wired.ts; the plan, "Snap on tap (built)"):
 * - Text: `snapAt` with all rules; snap only to a text blank with confidence ≥ 0.42
 *   (the fill-in cutoff chosen on sample A), and only when the spot where the text
 *   lands shows a visible cue by the measurement's own notion (`cueAt`: a line along
 *   its top or bottom, a box about its size, underscores). Baseline 2 pt above the
 *   blank's bottom, start at the tap's x clamped 2 pt inside the blank. A blank two
 *   text lines tall or more (a big box, a tall table column) keeps the tap's line,
 *   clamped inside the blank, instead of dropping to its bottom; in the middle of
 *   such a box no line is under the text, so the cue check leaves it unsnapped
 *   (plain, at the tap), and near its edges the text is kept inside the box.
 * - Check: only drawn checkboxes (squares, rings, hollow box glyphs), confidence ≥
 *   0.6, so a tap about equally near two stacked boxes stays where it was tapped.
 *   The tick takes the box: centred on it, its side the box's shorter side.
 */
import { cueAt } from '../engine/forms-cue';
import { snapAt, type SnapResult } from '../engine/forms-snap';
import type { TapData } from '../engine/snap-tap';

type Rect = [number, number, number, number];

/** Default text size, points (the Text tool's 11 pt). */
export const TEXT_PT = 11;
/** Smallest size a short blank steps text down to. */
export const MIN_TEXT_PT = 8;
/** Fill-in cutoff for text snaps, chosen on sample A (plan: "new 0.42", all rules). */
export const TEXT_MIN_CONFIDENCE = 0.42;
/** Drawn-checkbox snaps below this are two boxes about equally near: left unsnapped. */
export const CHECK_MIN_CONFIDENCE = 0.6;
export const CHECK_RULES = ['square', 'circle', 'glyph'] as const;
/** Baseline above the blank's bottom, and the start's inset from its sides, points. */
export const PAD = 2;
/** A blank this tall (two lines of 11 pt text) keeps the tapped line. */
export const TALL = 2 * 1.2 * TEXT_PT;
/** In a tall blank the baseline stays at least this far below its top. */
const TALL_TOP = 10;
/** Noto Sans: baseline below the top of the line box (STAMP_BASELINE_EM) and cap height, em. */
const BASELINE_EM = 0.988;
const CAP_EM = 0.72;
/** Where the editor's plain placement puts the baseline: the first line box (1.2 em) centred on the tap. */
const PLAIN_BASELINE_EM = BASELINE_EM - 0.6;

export interface TextPlace {
	/** Start of the text (left edge), points. */
	x: number;
	/** Baseline of the first line, points. */
	baseline: number;
	/** Font size, points. */
	size: number;
	snap: SnapResult;
}

export interface TickPlace {
	/** The tick's square, points. */
	box: Rect;
	snap: SnapResult;
}

/** The text placement for a tap at `p`, or null (place plainly). */
export function textAt(data: TapData, p: [number, number]): TextPlace | null {
	const s = snapAt(data.snap, p);
	if (!s || s.kind !== 'text' || s.confidence < TEXT_MIN_CONFIDENCE) return null;
	const r = s.rect;
	const h = r[3] - r[1];
	const lo = r[0] + PAD;
	const x = Math.min(Math.max(p[0], lo), Math.max(lo, r[2] - PAD));
	// A short box: step the size down so capitals stay inside it (never below 8 pt).
	const size = Math.min(TEXT_PT, Math.max(MIN_TEXT_PT, (h - PAD - 0.5) / CAP_EM));
	const plain = p[1] + PLAIN_BASELINE_EM * size;
	const baseline = h >= TALL ? Math.min(Math.max(plain, r[1] + TALL_TOP), r[3] - PAD) : r[3] - PAD;
	// A visible cue where the text lands: the line or box it will sit in.
	const landing: Rect = [x, baseline - (CAP_EM * TEXT_PT + 1), Math.max(x + 4, Math.min(r[2], x + 60)), baseline + PAD];
	if (!cueAt(data.cue, landing)) return null;
	return { x, baseline, size, snap: s };
}

/** The tick for a Check tap at `p` on a drawn checkbox, or null (place plainly). */
export function tickAt(data: TapData, p: [number, number]): TickPlace | null {
	const s = snapAt(data.snap, p, { rules: CHECK_RULES, minConfidence: CHECK_MIN_CONFIDENCE });
	if (!s || s.kind !== 'check') return null;
	const [x0, y0, x1, y1] = s.rect;
	const side = Math.min(x1 - x0, y1 - y0);
	const cx = (x0 + x1) / 2;
	const cy = (y0 + y1) / 2;
	return { box: [cx - side / 2, cy - side / 2, cx + side / 2, cy + side / 2], snap: s };
}

/** Top of the first line box for a baseline (the text stamp's stored y), points. */
export const lineTop = (t: TextPlace) => t.baseline - BASELINE_EM * t.size;
