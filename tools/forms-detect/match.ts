/**
 * Scoring for the blank detector: matches suggestions to the true widgets of a page.
 * Pure functions; rectangles are [x0, y0, x1, y1] in MuPDF page space (y down).
 *
 * Classes. A true widget is "text-like" (text, choice, signature: the user types or
 * signs on a line or in a box) or "check-like" (checkbox, radio). A suggestion is
 * 'text' or 'checkbox'. A suggestion of the wrong class on a widget counts as found
 * but bad ("wrong type").
 *
 * Found (the suggestion points at this widget):
 *   text-like:  the x ranges overlap by at least half the shorter one, and the y ranges
 *               overlap once the widget is grown by max(3 pt, 25% of its height).
 *   check-like: IoU ≥ 0.2, or the centre of either box lies inside the other.
 * Good (a user would accept the rectangle as is):
 *   text-like:  x IoU ≥ 0.75 (both ends within about an eighth of the length),
 *               y IoU ≥ 0.4 and bottoms within max(4 pt, 40% of the widget height).
 *               So a one-line suggestion for a tall multi-line box is bad.
 *   check-like: centres within a quarter of the larger side, side ratio within 0.6–1.67;
 *               or the suggestion lies inside the widget (a widget drawn with a generous
 *               hit area around the printed box), at least 0.4 of its side, centres
 *               within 0.3 of the widget's side.
 * One-to-one: pairs are taken best first (by IoU); a second suggestion on the same
 * widget is a false positive ("duplicate").
 */

export type Rect = [number, number, number, number];
export type TruthType = 'text' | 'checkbox' | 'radio' | 'choice' | 'signature';

export interface Truth {
	type: TruthType;
	rect: Rect;
	/** The page content shows something at the widget (a line, box, underscores, box glyph). */
	cue: boolean;
}

export interface Sugg {
	kind: 'text' | 'checkbox';
	rect: Rect;
	confidence: number;
}

export type SuggVerdict = 'correct' | 'bad-rect' | 'wrong-type' | 'duplicate' | 'false-positive' | 'neutral';

export interface PageScore {
	/** Per truth: index of the matched suggestion or -1, and whether it is good. */
	truth: { s: number; good: boolean }[];
	sugg: { t: number; verdict: SuggVerdict }[];
}

export const textLike = (t: TruthType) => t === 'text' || t === 'choice' || t === 'signature';

function overlap1(a0: number, a1: number, b0: number, b1: number) {
	return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
}
function iou1(a0: number, a1: number, b0: number, b1: number) {
	const o = overlap1(a0, a1, b0, b1);
	const u = Math.max(a1, b1) - Math.min(a0, b0);
	return u > 0 ? o / u : 0;
}
export function iou(a: Rect, b: Rect): number {
	const o = overlap1(a[0], a[2], b[0], b[2]) * overlap1(a[1], a[3], b[1], b[3]);
	const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - o;
	return u > 0 ? o / u : 0;
}
const inside = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const centre = (r: Rect): [number, number] => [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];

export function found(t: Truth, s: Sugg): boolean {
	if (textLike(t.type)) {
		const tw = t.rect[2] - t.rect[0];
		const sw = s.rect[2] - s.rect[0];
		const xo = overlap1(t.rect[0], t.rect[2], s.rect[0], s.rect[2]);
		if (xo < 0.5 * Math.min(tw, sw)) return false;
		const th = t.rect[3] - t.rect[1];
		const g = Math.max(3, 0.25 * th);
		return overlap1(t.rect[1] - g, t.rect[3] + g, s.rect[1], s.rect[3]) > 0;
	}
	if (iou(t.rect, s.rect) >= 0.2) return true;
	const [tx, ty] = centre(t.rect);
	const [sx, sy] = centre(s.rect);
	return inside(sx, sy, t.rect) || inside(tx, ty, s.rect);
}

export function good(t: Truth, s: Sugg): boolean {
	if (textLike(t.type) !== (s.kind === 'text')) return false;
	if (textLike(t.type)) {
		const th = t.rect[3] - t.rect[1];
		return (
			iou1(t.rect[0], t.rect[2], s.rect[0], s.rect[2]) >= 0.75 &&
			iou1(t.rect[1], t.rect[3], s.rect[1], s.rect[3]) >= 0.4 &&
			Math.abs(t.rect[3] - s.rect[3]) <= Math.max(4, 0.4 * th)
		);
	}
	const [tx, ty] = centre(t.rect);
	const [sx, sy] = centre(s.rect);
	const tside = Math.max(t.rect[2] - t.rect[0], t.rect[3] - t.rect[1]);
	const sside = Math.max(s.rect[2] - s.rect[0], s.rect[3] - s.rect[1]);
	const ratio = sside / Math.max(tside, 0.01);
	if (Math.hypot(tx - sx, ty - sy) <= 0.25 * Math.max(tside, sside) && ratio >= 0.6 && ratio <= 1.67) return true;
	// The drawn box inside a larger widget (a generous hit area around it): the field
	// lands on the box the user sees, so it is right.
	const inside = s.rect[0] >= t.rect[0] - 1 && s.rect[1] >= t.rect[1] - 1 && s.rect[2] <= t.rect[2] + 1 && s.rect[3] <= t.rect[3] + 1;
	return inside && ratio >= 0.4 && Math.hypot(tx - sx, ty - sy) <= 0.3 * tside;
}

/**
 * Scores one page. `neutral` rectangles (push buttons, hidden widgets) make a
 * suggestion that is found on them neither right nor wrong.
 */
export function scorePage(truths: Truth[], suggs: Sugg[], neutral: Rect[] = []): PageScore {
	const pairs: { t: number; s: number; v: number }[] = [];
	truths.forEach((t, ti) =>
		suggs.forEach((s, si) => {
			if (found(t, s)) pairs.push({ t: ti, s: si, v: (good(t, s) ? 10 : 0) + iou(t.rect, s.rect) });
		})
	);
	pairs.sort((a, b) => b.v - a.v || a.t - b.t || a.s - b.s);
	const truth = truths.map(() => ({ s: -1, good: false }));
	const sugg = suggs.map(() => ({ t: -1, verdict: 'false-positive' as SuggVerdict }));
	for (const p of pairs) {
		if (truth[p.t].s >= 0 || sugg[p.s].t >= 0) continue;
		const g = good(truths[p.t], suggs[p.s]);
		truth[p.t] = { s: p.s, good: g };
		const typeOk = textLike(truths[p.t].type) === (suggs[p.s].kind === 'text');
		sugg[p.s] = { t: p.t, verdict: g ? 'correct' : typeOk ? 'bad-rect' : 'wrong-type' };
	}
	suggs.forEach((s, si) => {
		if (sugg[si].t >= 0) return;
		if (truths.some((t) => found(t, s))) sugg[si].verdict = 'duplicate';
		else if (neutral.some((n) => iou(n, s.rect) > 0.2 || inside(...centre(s.rect), n))) sugg[si].verdict = 'neutral';
	});
	return { truth, sugg };
}
