/**
 * The "fill-in" standard: would a person filling in the form be happy with where
 * their typing or tick lands? The app would not create a field; it places ordinary
 * text (Text tool) or a tick mark. All tolerances here are guesses at what a person
 * accepts, not measured.
 *
 * Text placed from a text snap (rectangle R, tap p):
 *   baseline = R bottom − PAD; start x = p.x clamped to [R left + PAD, R right − PAD]
 *   ('tap' mode), or always R left + PAD ('left' mode).
 * Plain text, as the editor places it today (PageEditor.svelte `textOrigin`): 11 pt
 * text whose first line box (1.2 em) is centred on the tap, starting at the tap's x;
 * the baseline is STAMP_BASELINE_EM (0.988 em) below the line box top, i.e.
 * tap.y + 0.388 × 11 pt = tap.y + 4.27 pt.
 * A tick from a check snap: a mark box equal to the snapped square (its centre and
 * min side). Plain tick, as the Check tool places it today: a square of
 * 0.026 × the page's shorter side (15.9 pt on Letter) centred on the tap.
 *
 * FILL-GOOD, text-like widget T (height h):
 *   the snap target covers the widget (intersection ≥ half the smaller of the two
 *   areas), and the start x lies in [T left − 1, T right − 3], and the baseline is
 *   within max(3 pt, 30% of h) of T bottom − PAD (single-line widget), or anywhere
 *   from T top + 8 pt to T bottom + 3 pt (tall widget: h ≥ 26.4 pt, two lines of
 *   11 pt text).
 * FILL-GOOD, check-like widget: the tick centre lies inside T or inside the printed
 *   box at T, and the tick size is 0.5–1.5 × that box (the printed box when there is
 *   one, else T's shorter side).
 * Wrong type (a tick on a text widget, text on a check widget) that passes the other
 * class's rule is FILL-GOOD-OTHER-TYPE ('other').
 * Otherwise FILL-BAD when the target covers the widget (right area, wrong spot) and
 * WRONG-TARGET when it does not; for plain placement (no target), WRONG-TARGET when
 * the text start or tick centre lands inside another widget, else FILL-BAD.
 */
import type { SnapPage, SnapResult } from '../../src/lib/engine/forms-snap';
import { textLike, type Rect, type Truth } from '../forms-detect/match';
import type { InkPage } from './worker';

export type Fill = 'good' | 'other' | 'nosnap' | 'bad' | 'wrong';

export const PAD = 2;
const TEXT_PT = 11;
const BASELINE_BELOW_TAP = (0.988 - 0.6) * TEXT_PT;
const TALL = 2 * 1.2 * TEXT_PT;

export interface TextPlace {
	x: number;
	base: number;
}
export interface TickPlace {
	cx: number;
	cy: number;
	side: number;
}

const inside = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];
const area = (r: Rect) => Math.max(0, r[2] - r[0]) * Math.max(0, r[3] - r[1]);
function covers(a: Rect, b: Rect): boolean {
	const ox = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
	const oy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
	return ox * oy >= 0.5 * Math.min(area(a), area(b)) && ox * oy > 0;
}

export function snapText(s: SnapResult, p: [number, number], mode: 'tap' | 'left'): TextPlace {
	const r = s.rect;
	const lo = r[0] + PAD;
	const hi = Math.max(lo, r[2] - PAD);
	return { x: mode === 'left' ? lo : Math.min(Math.max(p[0], lo), hi), base: r[3] - PAD };
}
export const plainText = (p: [number, number]): TextPlace => ({ x: p[0], base: p[1] + BASELINE_BELOW_TAP });
export const snapTick = (s: SnapResult): TickPlace => ({ cx: (s.rect[0] + s.rect[2]) / 2, cy: (s.rect[1] + s.rect[3]) / 2, side: Math.min(s.rect[2] - s.rect[0], s.rect[3] - s.rect[1]) });
export const plainTick = (p: [number, number], ink: InkPage): TickPlace => ({ cx: p[0], cy: p[1], side: 0.026 * Math.min(ink.w, ink.h) });

/** Text start and baseline acceptable for this widget. */
export function textOk(t: Rect, at: TextPlace): boolean {
	const h = t[3] - t[1];
	if (at.x < t[0] - 1 || at.x > t[2] - 3) return false;
	if (h >= TALL) return at.base >= t[1] + 8 && at.base <= t[3] + 3;
	return Math.abs(at.base - (t[3] - PAD)) <= Math.max(3, 0.3 * h);
}

/** The printed box at a widget: a small drawn box, ring, box glyph or snap square whose centre is in the widget or that holds the widget's centre. */
export function printedBox(ink: InkPage, page: SnapPage, t: Rect): Rect | null {
	const tc: [number, number] = [(t[0] + t[2]) / 2, (t[1] + t[3]) / 2];
	let best: Rect | null = null;
	let bd = Infinity;
	const consider = (b: Rect) => {
		const w = b[2] - b[0];
		const h = b[3] - b[1];
		if (w < 3 || w > 24 || h < 3 || h > 24) return;
		const c: [number, number] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
		if (!inside(c[0], c[1], t) && !inside(tc[0], tc[1], b)) return;
		const d = Math.hypot(c[0] - tc[0], c[1] - tc[1]);
		if (d < bd) {
			bd = d;
			best = b;
		}
	};
	for (const b of ink.ink.boxes) if (b.light < 0.9) consider(b.r);
	for (const c of ink.ink.circles) consider(c);
	for (const g of ink.ink.glyphs) if (g.shape) consider(g.shape.r);
	for (const c of page.cands) if (c.rule === 'square') consider(c.rect);
	return best;
}

export function tickOk(t: Rect, box: Rect | null, at: TickPlace): boolean {
	if (!inside(at.cx, at.cy, t) && !(box && inside(at.cx, at.cy, box))) return false;
	const ref = box ? Math.min(box[2] - box[0], box[3] - box[1]) : Math.min(t[2] - t[0], t[3] - t[1]);
	const ratio = at.side / Math.max(ref, 0.01);
	return ratio >= 0.5 && ratio <= 1.5;
}

/** FILL outcome of a snap (null: no snap) on widget t. */
export function fillSnap(t: Truth, s: SnapResult | null, p: [number, number], mode: 'tap' | 'left', box: Rect | null): Fill {
	if (!s) return 'nosnap';
	const text = textLike(t.type);
	let ok: boolean;
	if (s.kind === 'text') ok = textOk(t.rect, snapText(s, p, mode));
	else ok = tickOk(t.rect, box, snapTick(s));
	if (ok) return text === (s.kind === 'text') ? 'good' : 'other';
	return covers(s.rect, t.rect) ? 'bad' : 'wrong';
}

/** FILL outcome of today's plain placement at the tap: text for text-like widgets, a tick for check-like ones. */
export function fillPlain(t: Truth, p: [number, number], ink: InkPage, box: Rect | null, others: Truth[]): Fill {
	if (textLike(t.type)) {
		const at = plainText(p);
		if (textOk(t.rect, at)) return 'good';
		return others.some((o) => o !== t && inside(at.x + 1, at.base - 3, o.rect)) ? 'wrong' : 'bad';
	}
	const at = plainTick(p, ink);
	if (tickOk(t.rect, box, at)) return 'good';
	return others.some((o) => o !== t && inside(at.cx, at.cy, o.rect)) ? 'wrong' : 'bad';
}

/** Plain tick judged on position only (its default size is 15.9 pt, larger than most boxes). */
export function plainTickPlaced(t: Rect, box: Rect | null, p: [number, number]): boolean {
	return inside(p[0], p[1], t) || (!!box && inside(p[0], p[1], box));
}
