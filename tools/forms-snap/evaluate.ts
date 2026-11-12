/**
 * `forms:snap run`: simulated taps on the cached page ink (see worker.ts), scored
 * against the true widgets with the blank detector's acceptance rules
 * (../forms-detect/match.ts: `good` and `found`, unchanged).
 *
 * Taps on a widget (models, reported separately):
 *   centre    the widget's centre;
 *   sloppy    5 seeded-random points: text-like, x in the left third, y anywhere in the
 *             box; check-like, anywhere in the box grown by 3 pt;
 *   near      3 points 0.5–6 pt outside the widget on the side of its label (the
 *             nearest word left, above, below or right; widgets with no word next to
 *             them get no near taps), along the part of the edge facing the label.
 * Outcome of a tap: GOOD (good rectangle of the right class on the tapped widget),
 * NO-SNAP, BAD-RECT (found on the tapped widget but not good, including the wrong
 * class), WRONG-TARGET (anything else: a neighbour widget, a button, non-widget ink).
 *
 * Taps on places that are not blanks (harm): on non-form pages, words of paragraph
 * lines, empty margins, and words inside ruled table cells; on form pages, points at
 * least 15 pt from any widget (on a word or on empty paper).
 *
 * "More like this": on each form page, k = 1, 2, 3 seeded-random widgets whose
 * centre tap snaps GOOD are the user's confirmed examples; `similarTo` proposes the
 * rest, scored one-to-one (match.ts `scorePage`) against the remaining widgets.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { prepareSnap, similarTo, snapAt, type PrepareOptions, type SnapOptions, type SnapPage, type SnapResult, type SnapRule } from '../../src/lib/engine/forms-snap';
import { textLines, type Rect as DRect } from '../../src/lib/engine/forms-detect';
import { found, good, scorePage, textLike, type Rect, type Sugg, type Truth } from '../forms-detect/match';
import type { SampleFile } from '../forms-detect/measure';
import type { Args } from '../survey/lib/common';
import type { DrawMark, InkFile } from './worker';
import { loadSample } from './sample';
import { fillPlain, fillSnap, plainTickPlaced, printedBox, snapText } from './fill';
import { d0, fillReport, oldGroup, writeFillFails, type FillFail, type FillJson, type FillTap } from './fill-report';

type Model = 'centre' | 'sloppy' | 'near';
type Outcome = 'good' | 'nosnap' | 'bad' | 'wrong';
type HarmPlace = 'paragraph' | 'margin' | 'table-cell' | 'form-away-text' | 'form-away-empty';

interface Tap {
	model: Model;
	cls: 'text' | 'check';
	cue: boolean;
	real: boolean;
	source: string;
	rule: string;
	conf: number;
	outcome: Outcome;
	/** WRONG-TARGET detail: 'neighbour' | 'button' | 'other'; BAD-RECT: 'type' | 'rect'. */
	detail: string;
	side: string;
	why?: SnapResult['why'];
}

interface Harm {
	place: HarmPlace;
	real: boolean;
	rule: string;
	conf: number;
	why?: SnapResult['why'];
	scope: string;
}

/** A tap scored under a narrower scope (only some rules may answer). */
interface Scoped {
	scope: string;
	model: Model;
	cls: 'text' | 'check';
	cue: boolean;
	real: boolean;
	conf: number;
	outcome: Outcome;
	/** The page draws a small box, ring or box glyph at the widget (raw ink, not the detector). */
	shape: boolean;
}

/** Scopes: which rules may answer, and which widget class the scope is for (null rules: all, the main run). */
export const SCOPES: [string, SnapRule[] | null, 'text' | 'check' | 'all'][] = [
	['all', null, 'all'],
	['checks (squares, rings, box glyphs, small cells)', ['square', 'circle', 'glyph', 'cell-check'], 'check'],
	['drawn checks (squares, rings, box glyphs)', ['square', 'circle', 'glyph'], 'check'],
	['lines and boxes (rules, empty cells, underscores, combs)', ['rule', 'cell', 'underscore', 'comb'], 'text'],
	['empty cells and combs', ['cell', 'comb'], 'text'],
	['text, every text rule', ['rule', 'cell', 'cell-band', 'cell-right', 'underscore', 'comb', 'lines'], 'text'],
	['drawn checks + empty cells + combs', ['square', 'circle', 'glyph', 'cell', 'comb'], 'all']
];

interface Fail {
	sha: string;
	page: number;
	model: Model;
	outcome: Outcome;
	detail: string;
	rule: string;
	conf: number;
	cls: string;
	truth: Rect;
	tap: [number, number];
	snap: Rect | null;
	source: string;
}

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s / 0x100000000;
	};
}
function seedOf(sha: string, page: number, salt: number) {
	return (parseInt(sha.slice(0, 8), 16) ^ (page * 7919) ^ (salt * 104729)) >>> 0;
}
const U = (r: () => number, a: number, b: number) => a + (b - a) * r();

/** The side of the widget its label is on, and the label word's box. */
function labelSide(page: SnapPage, t: Truth): { side: 'left' | 'above' | 'below' | 'right'; w: DRect } | null {
	const r = t.rect;
	let best: { side: 'left' | 'above' | 'below' | 'right'; d: number; w: DRect } | null = null;
	const consider = (side: 'left' | 'above' | 'below' | 'right', d: number, w: DRect) => {
		if (d < -1) return;
		if (!best || d < best.d) best = { side, d, w };
	};
	for (const w of page.geo.ws) {
		const s = w.size;
		const yo = Math.min(w.r[3], r[3]) - Math.max(w.r[1], r[1]);
		const xo = Math.min(w.r[2], r[2]) - Math.max(w.r[0], r[0]);
		if (yo > 0.3 * Math.min(w.r[3] - w.r[1], r[3] - r[1])) {
			if (w.r[2] <= r[0] + 1 && r[0] - w.r[2] <= 3 * s) consider('left', r[0] - w.r[2], w.r);
			if (w.r[0] >= r[2] - 1 && w.r[0] - r[2] <= 3 * s) consider('right', w.r[0] - r[2] + (textLike(t.type) ? 2 : 0), w.r);
		}
		if (xo > 0) {
			if (w.r[3] <= r[1] + 1 && r[1] - w.r[3] <= 1.5 * s) consider('above', r[1] - w.r[3] + 1, w.r);
			if (w.r[1] >= r[3] - 1 && w.r[1] - r[3] <= 1.2 * s) consider('below', w.r[1] - r[3] + 1, w.r);
		}
	}
	const b = best as { side: 'left' | 'above' | 'below' | 'right'; w: DRect } | null;
	return b ? { side: b.side, w: b.w } : null;
}

function tapsFor(page: SnapPage, t: Truth, r: () => number): { model: Model; p: [number, number]; side: string }[] {
	const [x0, y0, x1, y1] = t.rect;
	const out: { model: Model; p: [number, number]; side: string }[] = [{ model: 'centre', p: [(x0 + x1) / 2, (y0 + y1) / 2], side: '' }];
	const text = textLike(t.type);
	for (let i = 0; i < 5; i++) {
		if (text) out.push({ model: 'sloppy', p: [U(r, x0, x0 + (x1 - x0) / 3), U(r, y0, y1)], side: '' });
		else out.push({ model: 'sloppy', p: [U(r, x0 - 3, x1 + 3), U(r, y0 - 3, y1 + 3)], side: '' });
	}
	// No label word next to the widget: no near-miss taps (the model needs a label side).
	const ls = labelSide(page, t);
	if (!ls) return out;
	const { side, w } = ls;
	for (let i = 0; i < 3; i++) {
		const u = U(r, 0.5, 6);
		// Along the edge: the part facing the label word (or the whole edge).
		const ya = Math.max(y0, w[1]);
		const yb = Math.min(y1, w[3]);
		const xa = Math.max(x0, w[0]);
		const xb = Math.min(x1, w[2]);
		const along = (a: number, b: number, lo: number, hi: number) => (b > a ? U(r, a, b) : U(r, lo, hi));
		let p: [number, number];
		if (side === 'left') p = [x0 - u, along(ya, yb, y0, y1)];
		else if (side === 'right') p = [x1 + u, along(ya, yb, y0, y1)];
		else if (side === 'above') p = [along(xa, xb, x0, x1), y0 - u];
		else p = [along(xa, xb, x0, x1), y1 + u];
		out.push({ model: 'near', p, side });
	}
	return out;
}

/** The widget is one box of the snapped comb row (an author's one-widget-per-character comb). */
function combCell(t: Truth, s: SnapResult): boolean {
	const tw = t.rect[2] - t.rect[0];
	const sw = s.rect[2] - s.rect[0];
	const yo = Math.min(t.rect[3], s.rect[3]) - Math.max(t.rect[1], s.rect[1]);
	const yu = Math.max(t.rect[3], s.rect[3]) - Math.min(t.rect[1], s.rect[1]);
	return textLike(t.type) && tw <= 0.6 * sw && t.rect[0] >= s.rect[0] - 3 && t.rect[2] <= s.rect[2] + 3 && yu > 0 && yo / yu >= 0.4;
}

const asSugg = (s: SnapResult): Sugg => ({ kind: s.kind === 'check' ? 'checkbox' : 'text', rect: s.rect, confidence: s.confidence });
const insideR = (x: number, y: number, r: Rect) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3];

function classify(t: Truth, s: SnapResult | null, truths: Truth[], neutral: Rect[]): { outcome: Outcome; detail: string } {
	if (!s) return { outcome: 'nosnap', detail: '' };
	const g = asSugg(s);
	if (good(t, g)) return { outcome: 'good', detail: '' };
	if (s.rule === 'comb' && combCell(t, s)) return { outcome: 'good', detail: 'comb-cell' };
	if (found(t, g)) return { outcome: 'bad', detail: textLike(t.type) !== (s.kind === 'text') ? 'type' : 'rect' };
	if (truths.some((o) => o !== t && found(o, g))) return { outcome: 'wrong', detail: 'neighbour' };
	const c: [number, number] = [(s.rect[0] + s.rect[2]) / 2, (s.rect[1] + s.rect[3]) / 2];
	if (neutral.some((n) => insideR(c[0], c[1], n))) return { outcome: 'wrong', detail: 'button' };
	return { outcome: 'wrong', detail: 'other' };
}

/**
 * A small drawn box, ring or hollow box glyph (4–20 pt) centred inside the widget,
 * straight from the page's ink (not from the snap rules), for the "drawn checkboxes"
 * population.
 */
function shapeCue(ink: InkFile['pages'][number]['ink'], r: Rect): boolean {
	const ok = (b: Rect) => {
		const w = b[2] - b[0];
		const h = b[3] - b[1];
		const cx = (b[0] + b[2]) / 2;
		const cy = (b[1] + b[3]) / 2;
		return w >= 4 && w <= 20 && h >= 4 && h <= 20 && Math.abs(w - h) <= 0.25 * Math.max(w, h) && insideR(cx, cy, r);
	};
	return ink.boxes.some((b) => b.light < 0.9 && ok(b.r)) || ink.circles.some(ok) || ink.glyphs.some((g) => !!g.shape && ok(g.shape.r));
}

/** Places that are not blanks, on one page. */
function harmTaps(page: SnapPage, ink: InkFile['pages'][number], form: boolean, r: () => number): { place: HarmPlace; p: [number, number] }[] {
	const out: { place: HarmPlace; p: [number, number] }[] = [];
	const ws = page.geo.ws;
	if (!ws.length) return out;
	const W = ink.w;
	const H = ink.h;
	const onWord = (x: number, y: number) => ws.some((w) => insideR(x, y, w.r));
	if (form) {
		const keep = [...ink.truths.map((t) => t.rect), ...ink.neutral];
		const far = (x: number, y: number) => keep.every((k) => Math.hypot(Math.max(k[0] - x, 0, x - k[2]), Math.max(k[1] - y, 0, y - k[3])) >= 15);
		let tries = 0;
		let nText = 0;
		let nEmpty = 0;
		while (tries++ < 400 && (nText < 5 || nEmpty < 5)) {
			// Words (text taps) and random points of paper inside the text area.
			if (nText < 5) {
				const w = ws[Math.floor(r() * ws.length)];
				const p: [number, number] = [(w.r[0] + w.r[2]) / 2, (w.r[1] + w.r[3]) / 2];
				if (far(...p)) {
					out.push({ place: 'form-away-text', p });
					nText++;
				}
			}
			if (nEmpty < 5) {
				const p: [number, number] = [U(r, 36, W - 36), U(r, 36, H - 36)];
				if (far(...p) && !onWord(...p)) {
					out.push({ place: 'form-away-empty', p });
					nEmpty++;
				}
			}
		}
		return out;
	}
	// Paragraph words: lines of 6 or more words.
	const lines = textLines(ws).filter((l) => l.text.split(' ').length >= 6);
	const pwords = ws.filter((w) => lines.some((l) => Math.abs(l.base - w.base) < 0.3 * w.size && w.r[0] >= l.r[0] - 1 && w.r[2] <= l.r[2] + 1));
	for (let i = 0; i < Math.min(10, pwords.length); i++) {
		const w = pwords[Math.floor(r() * pwords.length)];
		out.push({ place: 'paragraph', p: [U(r, w.r[0], w.r[2]), U(r, w.r[1] + 1, w.r[3] - 1)] });
	}
	// Margins: points outside the bounding box of the page's text, with nothing within 10 pt.
	const bx = [Math.min(...ws.map((w) => w.r[0])), Math.min(...ws.map((w) => w.r[1])), Math.max(...ws.map((w) => w.r[2])), Math.max(...ws.map((w) => w.r[3]))];
	let n = 0;
	for (let tries = 0; tries < 200 && n < 5; tries++) {
		const p: [number, number] = [U(r, 4, W - 4), U(r, 4, H - 4)];
		if (insideR(p[0], p[1], bx as Rect)) continue;
		if (ws.some((w) => Math.hypot(Math.max(w.r[0] - p[0], 0, p[0] - w.r[2]), Math.max(w.r[1] - p[1], 0, p[1] - w.r[3])) < 10)) continue;
		out.push({ place: 'margin', p });
		n++;
	}
	// Table data cells: words enclosed by rules on all four sides within 40 pt.
	const { h, v } = page.geo;
	const enclosed = (w: (typeof ws)[number]) => {
		const cx = (w.r[0] + w.r[2]) / 2;
		const cy = (w.r[1] + w.r[3]) / 2;
		const above = h.some((l) => l.at < w.r[1] + 0.5 && cy - l.at < 40 && l.a <= w.r[0] && l.b >= w.r[2]);
		const below = h.some((l) => l.at > w.r[3] - 0.5 && l.at - cy < 40 && l.a <= w.r[0] && l.b >= w.r[2]);
		const left = v.some((l) => l.at < w.r[0] + 0.5 && cx - l.at < 200 && l.a <= cy && l.b >= cy);
		const right = v.some((l) => l.at > w.r[2] - 0.5 && l.at - cx < 200 && l.a <= cy && l.b >= cy);
		return above && below && left && right;
	};
	const cellWords = ws.filter(enclosed);
	for (let i = 0; i < Math.min(10, cellWords.length); i++) {
		const w = cellWords[Math.floor(r() * cellWords.length)];
		out.push({ place: 'table-cell', p: [U(r, w.r[0], w.r[2]), U(r, w.r[1] + 1, w.r[3] - 1)] });
	}
	return out;
}

interface Like {
	k: number;
	real: boolean;
	proposals: number;
	correct: number;
	neutral: number;
	remaining: number;
	remainingSame: number;
	found: number;
	foundSame: number;
}

function readInk(file: string): InkFile | null {
	if (!fs.existsSync(file)) return null;
	return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')) as InkFile;
}

export async function evaluate(args: Args, out: string) {
	const files = loadSample(out);
	const inkDir = path.join(out, 'ink');
	const taps: Tap[] = [];
	const harms: Harm[] = [];
	const scoped: Scoped[] = [];
	const fills: FillTap[] = [];
	const fillFails: FillFail[] = [];
	const likes: Like[] = [];
	const fails: Fail[] = [];
	const prepMs: number[] = [];
	const tapMs: number[] = [];
	const collectMs: number[] = [];
	const excluded: Record<string, number> = {};
	// --prep '{"band":0}' --snap '{"cross":0}': variants while tuning on sample A.
	const popts = JSON.parse(args.get('prep') ?? '{}') as PrepareOptions;
	const sopts = JSON.parse(args.get('snap') ?? '{}') as SnapOptions;
	const limit = args.num('limit', Infinity);
	let nFiles = 0;
	const pagesSeen = { form: 0, nonform: 0, declined: 0 };
	for (const f of files) {
		if (nFiles >= limit) break;
		const rec = readInk(path.join(inkDir, `${f.sha256}.json.gz`));
		if (!rec || rec.error) continue;
		nFiles++;
		for (const pg of rec.pages) {
			if (pg.declined) {
				pagesSeen.declined++;
				continue;
			}
			collectMs.push(pg.collectMs);
			const t0 = performance.now();
			const page = prepareSnap(pg.ink, popts);
			prepMs.push(performance.now() - t0);
			const form = f.group === 'form';
			if (form && !pg.truths.length) continue;
			pagesSeen[form ? 'form' : 'nonform']++;
			const r = rng(seedOf(f.sha256, pg.i, 1));
			if (form) {
				const centreGood: number[] = [];
				const shapes = pg.truths.map((t) => shapeCue(pg.ink, t.rect));
				pg.truths.forEach((t, ti) => {
					for (const tp of tapsFor(page, t, r)) {
						// A sloppy or near tap that lands on another widget is a tap on that widget, not a miss of this one.
						if (tp.model !== 'centre' && !insideR(tp.p[0], tp.p[1], t.rect) && pg.truths.some((o) => o !== t && insideR(tp.p[0], tp.p[1], o.rect))) {
							excluded[tp.model] = (excluded[tp.model] ?? 0) + 1;
							continue;
						}
						const box = printedBox(pg, page, t.rect);
						const plain = fillPlain(t, tp.p, pg, box, pg.truths);
						const plainPos = textLike(t.type) ? plain === 'good' : plainTickPlaced(t.rect, box, tp.p);
						const fillOf = (z: SnapResult | null, scope: string, extra: Partial<FillTap> = {}) =>
							fills.push({ scope, model: tp.model, cls: textLike(t.type) ? 'text' : 'check', cue: t.cue, real: f.real, shape: shapes[ti], conf: z?.confidence ?? 0, tap: fillSnap(t, z, tp.p, 'tap', box), left: fillSnap(t, z, tp.p, 'left', box), plain, plainPos, old: '', ...extra });
						for (const [name, rules] of SCOPES) {
							if (!rules) continue;
							const z = snapAt(page, tp.p, { ...sopts, rules });
							scoped.push({ scope: name, model: tp.model, cls: textLike(t.type) ? 'text' : 'check', cue: t.cue, real: f.real, conf: z?.confidence ?? 0, outcome: classify(t, z, pg.truths, pg.neutral).outcome, shape: shapes[ti] });
							if (name === SCOPES[1][0] || name === SCOPES[2][0]) fillOf(z, name);
						}
						const t1 = performance.now();
						const s = snapAt(page, tp.p, sopts);
						tapMs.push(performance.now() - t1);
						const { outcome, detail } = classify(t, s, pg.truths, pg.neutral);
						fillOf(s, 'all', { old: outcome === 'bad' ? oldGroup(t, s!, detail) : outcome });
						const last = fills[fills.length - 1];
						if (f.real && t.cue && tp.model === 'sloppy' && (last.tap === 'bad' || last.tap === 'wrong') && fillFails.length < 20000)
							fillFails.push({ sha: f.sha256, page: pg.i + 1, fill: last.tap, cls: last.cls, rule: s?.rule ?? '-', truth: t.rect, tap: tp.p, snap: s!.rect, at: s!.kind === 'text' ? snapText(s!, tp.p, 'tap') : null, source: f.source });
						if (tp.model === 'centre' && outcome === 'good') centreGood.push(ti);
						const cls = textLike(t.type) ? 'text' : 'check';
						taps.push({ model: tp.model, cls, cue: t.cue, real: f.real, source: f.source, rule: s?.rule ?? '-', conf: s?.confidence ?? 0, outcome, detail, side: tp.side, why: s?.why });
						if ((outcome === 'bad' || outcome === 'wrong') && f.real)
							fails.push({ sha: f.sha256, page: pg.i + 1, model: tp.model, outcome, detail, rule: s?.rule ?? '-', conf: s?.confidence ?? 0, cls, truth: t.rect, tap: tp.p, snap: s?.rect ?? null, source: f.source });
					}
				});
				for (const k of [1, 2, 3]) {
					if (centreGood.length < k || pg.truths.length < k + 1) continue;
					const rk = rng(seedOf(f.sha256, pg.i, 10 + k));
					const pool = [...centreGood];
					const pick: number[] = [];
					while (pick.length < k) pick.push(pool.splice(Math.floor(rk() * pool.length), 1)[0]);
					const exampleSnaps = pick.map((ti) => {
						const t = pg.truths[ti];
						return snapAt(page, [(t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2], sopts)!;
					});
					const props = similarTo(page, exampleSnaps, { tol: args.num("like-tol", 0.35) });
					const rest = pg.truths.filter((_, i) => !pick.includes(i));
					const sc = scorePage(rest, props.map(asSugg), pg.neutral);
					const classes = new Set(pick.map((ti) => (textLike(pg.truths[ti].type) ? 'text' : 'check')));
					const same = rest.map((t) => classes.has(textLike(t.type) ? 'text' : 'check'));
					likes.push({
						k,
						real: f.real,
						proposals: sc.sugg.filter((x) => x.verdict !== 'neutral').length,
						correct: sc.sugg.filter((x) => x.verdict === 'correct').length,
						neutral: sc.sugg.filter((x) => x.verdict === 'neutral').length,
						remaining: rest.length,
						remainingSame: same.filter(Boolean).length,
						found: sc.truth.filter((x) => x.good).length,
						foundSame: sc.truth.filter((x, i) => x.good && same[i]).length
					});
				}
			}
			for (const h of harmTaps(page, pg, form, rng(seedOf(f.sha256, pg.i, 2)))) {
				const s = snapAt(page, h.p, sopts);
				harms.push({ place: h.place, real: f.real, rule: s?.rule ?? '-', conf: s?.confidence ?? 0, why: s?.why, scope: 'all' });
				for (const [name, rules] of SCOPES) {
					if (!rules) continue;
					const z = snapAt(page, h.p, { ...sopts, rules });
					harms.push({ place: h.place, real: f.real, rule: z?.rule ?? '-', conf: z?.confidence ?? 0, scope: name });
				}
			}
		}
	}
	// --cuts-from A/report.json: report this sample (B) also at the cutoffs chosen on the tuning sample.
	const fixed = args.get('cuts-from') ? (JSON.parse(fs.readFileSync(args.get('cuts-from')!, 'utf8')) as { scopes: Record<string, { cut: number } & Record<string, { cut?: number }>> }).scopes : null;
	const fixedFill = args.get('cuts-from') ? (JSON.parse(fs.readFileSync(path.join(path.dirname(args.get('cuts-from')!), 'fill-report.json'), 'utf8')) as FillJson) : null;
	// Old (rectangle-standard) cutoffs: the tuning sample's, from --cuts-from, else this folder's last report.
	const prevReport = path.join(out, 'report.json');
	const oldCuts = fixed ?? (fs.existsSync(prevReport) ? (JSON.parse(fs.readFileSync(prevReport, 'utf8')) as { scopes: Record<string, { cut: number }> }).scopes : null);
	const fr = fillReport(fills, d0(oldCuts), fixedFill);
	fs.writeFileSync(path.join(out, 'fill-report.md'), fr.md);
	fs.writeFileSync(path.join(out, 'fill-report.json'), JSON.stringify(fr.json, null, 1));
	writeFillFails(out, fillFails);
	const rep = buildReport({ fixed, scoped, excluded, taps, harms, likes, prepMs, tapMs, collectMs, pagesSeen, nFiles, files });
	fs.writeFileSync(path.join(out, 'report.md'), rep.md);
	if (args.flag('dump')) {
		fs.writeFileSync(path.join(out, 'taps.jsonl.gz'), zlib.gzipSync(taps.map((t) => JSON.stringify(t)).join('\n')));
		fs.writeFileSync(path.join(out, 'harms.jsonl.gz'), zlib.gzipSync(harms.map((t) => JSON.stringify(t)).join('\n')));
	}
	fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(rep.json, null, 1));
	// Failing taps (real-world forms) for looking at by eye, and the marks to draw for them.
	fs.writeFileSync(
		path.join(out, 'fails.tsv'),
		['sha256\tpage\tmodel\toutcome\tdetail\trule\tconf\tclass\tsource\ttruth\ttap\tsnap', ...fails.map((x) => [x.sha, x.page, x.model, x.outcome, x.detail, x.rule, x.conf, x.cls, x.source, x.truth.map((n) => n.toFixed(1)).join(','), x.tap.map((n) => n.toFixed(1)).join(','), x.snap?.map((n) => n.toFixed(1)).join(',') ?? ''].join('\t'))].join('\n') + '\n'
	);
	const marks: Record<string, Record<number, DrawMark[]>> = {};
	for (const x of fails) {
		const m = ((marks[x.sha] ??= {})[x.page - 1] ??= []);
		if (m.length > 120) continue;
		m.push({ r: x.truth, color: [0, 0.6, 0], width: 0.6 });
		m.push({ r: x.tap, color: x.outcome === 'wrong' ? [1, 0, 0] : [1, 0.55, 0], width: 0.3 });
		if (x.snap) m.push({ r: x.snap, color: x.outcome === 'wrong' ? [1, 0, 0] : [1, 0.55, 0], width: 0.8 });
	}
	fs.writeFileSync(path.join(out, 'marks.json'), JSON.stringify(marks));
	console.log(rep.md);
}

// ---------------------------------------------------------------------------
// Report.

const CUTS = [0, 0.3, 0.4, 0.5, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : '–');

function shares(ts: Tap[], cut = 0, strict = false) {
	const n = ts.length;
	let g = 0;
	let ns = 0;
	let b = 0;
	let w = 0;
	for (const t of ts) {
		const out = strict && t.detail === 'comb-cell' ? 'bad' : t.outcome;
		const o = t.conf < cut && out !== 'nosnap' ? 'nosnap' : out;
		if (o === 'good') g++;
		else if (o === 'nosnap') ns++;
		else if (o === 'bad') b++;
		else w++;
	}
	return { n, g, ns, b, w };
}

function bestCut(ts: Tap[], maxHarm: number) {
	let best: { cut: number; g: number; n: number; harm: number } | null = null;
	for (let k = 0; k <= 100; k++) {
		const c = k / 100;
		const s = shares(ts, c);
		const harm = (s.b + s.w) / (s.n || 1);
		if (harm <= maxHarm && (!best || s.g > best.g)) best = { cut: c, g: s.g, n: s.n, harm };
	}
	return best;
}

function buildReport(d: { fixed: Record<string, { cut: number } & Record<string, { cut?: number }>> | null; scoped: Scoped[]; excluded: Record<string, number>; taps: Tap[]; harms: Harm[]; likes: Like[]; prepMs: number[]; tapMs: number[]; collectMs: number[]; pagesSeen: Record<string, number>; nFiles: number; files: SampleFile[] }) {
	const L: string[] = [];
	const say = (s = '') => L.push(s);
	const json: Record<string, unknown> = {};
	const real = d.taps.filter((t) => t.real);
	say('# Tap to snap: measurement');
	say();
	say(`Files read: ${d.nFiles}; pages: ${d.pagesSeen.form} form pages with widgets, ${d.pagesSeen.nonform} non-form pages, ${d.pagesSeen.declined} declined (scans, too complex). Taps on widgets: ${d.taps.length} (${real.length} on real-world forms); left out because they land on another widget: ${JSON.stringify(d.excluded)}. GOOD counts a comb row snapped over one-box-per-character widgets as good (a comb field types one character per box); the strict count (match.ts alone) is given beside it.`);
	say();
	const row = (name: string, ts: Tap[]) => {
		const s = shares(ts);
		const st = shares(ts, 0, true);
		return `| ${name} | ${s.n} | ${pct(s.g, s.n)} | ${pct(s.ns, s.n)} | ${pct(s.g + s.ns, s.n)} | ${pct(s.b, s.n)} | ${pct(s.w, s.n)} | ${pct(s.b + s.w, s.n)} | ${pct(st.g, st.n)} / ${pct(st.b + st.w, st.n)} |`;
	};
	const head = (first: string) => {
		say(`| ${first} | taps | GOOD | NO-SNAP | GOOD or NO-SNAP | BAD-RECT | WRONG-TARGET | BAD + WRONG | strict GOOD / BAD + WRONG |`);
		say('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
	};
	const models: Tap['model'][] = ['centre', 'sloppy', 'near'];
	say('## Real-world forms, all confidences');
	say();
	head('tap model / class / cue');
	const headline: Record<string, unknown> = {};
	for (const m of models)
		for (const cls of ['text', 'check'] as const)
			for (const cue of [true, false]) {
				const ts = real.filter((t) => t.model === m && t.cls === cls && t.cue === cue);
				say(row(`${m} / ${cls} / ${cue ? 'cue' : 'no cue'}`, ts));
				headline[`${m}/${cls}/${cue ? "cue" : "nocue"}`] = { ...shares(ts), strict: shares(ts, 0, true) };
			}
	for (const m of models) {
		const ts = real.filter((t) => t.model === m && t.cue);
		say(row(`**${m} / all / cue**`, ts));
		headline[`${m}/all/cue`] = { ...shares(ts), strict: shares(ts, 0, true) };
	}
	say();
	json.headline = headline;

	say('Detail: BAD-RECT of which wrong class; WRONG-TARGET split (real-world, sloppy, cued):');
	say();
	const sl = real.filter((t) => t.model === 'sloppy' && t.cue);
	const det: Record<string, number> = {};
	for (const t of sl) if (t.outcome === 'bad' || t.outcome === 'wrong') det[`${t.outcome}:${t.detail}`] = (det[`${t.outcome}:${t.detail}`] ?? 0) + 1;
	say(Object.entries(det).map(([k, v]) => `${k} ${v} (${pct(v, sl.length)})`).join(', '));
	say();

	say('## By snap rule (real-world, sloppy taps, cued widgets; the rule that answered)');
	say();
	say('| rule | taps | GOOD | BAD-RECT | WRONG-TARGET | precision (GOOD of snaps) |');
	say('|---|---:|---:|---:|---:|---:|');
	const rules = [...new Set(sl.map((t) => t.rule))].sort();
	const byRule: Record<string, unknown> = {};
	for (const ru of rules) {
		const ts = sl.filter((t) => t.rule === ru);
		const s = shares(ts);
		say(`| ${ru} | ${s.n} | ${s.g} | ${s.b} | ${s.w} | ${ru === '-' ? '' : pct(s.g, s.g + s.b + s.w)} |`);
		byRule[ru] = s;
	}
	say();
	json.byRule = byRule;

	say('## By source (real-world, sloppy taps, cued widgets)');
	say();
	head('source');
	const sources = [...new Set(real.map((t) => t.source))].sort();
	for (const so of sources) say(row(so, sl.filter((t) => t.source === so)));
	say();

	say('## Near-miss taps by label side (real-world, cued)');
	say();
	head('side');
	for (const side of ['left', 'above', 'below', 'right']) say(row(side, real.filter((t) => t.model === 'near' && t.cue && t.side === side)));
	say();

	say('## Confidence cutoff (snaps below it become NO-SNAP); real-world, cued widgets');
	say();
	for (const m of models) {
		say(`### ${m}`);
		say();
		say('| cutoff | text GOOD | text NO-SNAP | text BAD+WRONG | check GOOD | check NO-SNAP | check BAD+WRONG | all GOOD | all BAD+WRONG |');
		say('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
		const tt = real.filter((t) => t.model === m && t.cue && t.cls === 'text');
		const tc = real.filter((t) => t.model === m && t.cue && t.cls === 'check');
		const ta = real.filter((t) => t.model === m && t.cue);
		for (const c of CUTS) {
			const a = shares(tt, c);
			const b = shares(tc, c);
			const z = shares(ta, c);
			say(`| ${c} | ${pct(a.g, a.n)} | ${pct(a.ns, a.n)} | ${pct(a.b + a.w, a.n)} | ${pct(b.g, b.n)} | ${pct(b.ns, b.n)} | ${pct(b.b + b.w, b.n)} | ${pct(z.g, z.n)} | ${pct(z.b + z.w, z.n)} |`);
		}
		say();
	}
	say('Best cutoff (most GOOD) with BAD + WRONG at most 5% / 3% / 2% of taps (real-world, cued):');
	say();
	say('| model / class | ≤ 5%: cutoff, GOOD | ≤ 3%: cutoff, GOOD | ≤ 2%: cutoff, GOOD |');
	say('|---|---:|---:|---:|');
	const cuts: Record<string, unknown> = {};
	for (const m of models)
		for (const cls of ['text', 'check', 'all'] as const) {
			const ts = real.filter((t) => t.model === m && t.cue && (cls === 'all' || t.cls === cls));
			const f = (x: ReturnType<typeof bestCut>) => (x ? `${x.cut}: ${pct(x.g, x.n)} (harm ${(100 * x.harm).toFixed(1)}%)` : 'none');
			const b5 = bestCut(ts, 0.05);
			const b3 = bestCut(ts, 0.03);
			const b2 = bestCut(ts, 0.02);
			say(`| ${m} / ${cls} | ${f(b5)} | ${f(b3)} | ${f(b2)} |`);
			cuts[`${m}/${cls}`] = { b5, b3, b2 };
		}
	say();
	json.cuts = cuts;

	// Harm.
	// Scopes.
	say('## Narrower scopes (only some rules may answer); real-world, sloppy taps');
	say();
	say('For each scope: its widgets (the class it is for) with a visible cue, at all confidences and at the cutoff with the most GOOD where BAD + WRONG ≤ 3%; at that cutoff also the widgets without a cue (BAD + WRONG), taps on widgets of the other class that snap (all wrong), and taps on places that are not blanks that snap.');
	say();
	if (d.fixed) say('This is a held-out sample: the cutoff is the one chosen on the tuning sample (its own best cutoff is in brackets).');
	say();
	say('| scope | widgets\' taps | all conf.: GOOD / NO-SNAP / BAD+WRONG | cutoff | GOOD / NO-SNAP / BAD+WRONG | no cue: BAD+WRONG | other class: snaps | not blanks: snaps (paragraph, margin, table cell, form away) | bar (GOOD ≥ 85%, BAD+WRONG ≤ 3%) |');
	say('|---|---:|---|---:|---|---:|---:|---|---|');
	const scopeJson: Record<string, unknown> = {};
	const allScoped: Scoped[] = [...d.taps.map((t) => ({ scope: 'all', model: t.model, cls: t.cls, cue: t.cue, real: t.real, conf: t.conf, outcome: t.outcome, shape: false })), ...d.scoped];
	for (const [name, , cls] of SCOPES) {
		const xs = allScoped.filter((t) => t.scope === name && t.real && t.model === 'sloppy');
		const mine = xs.filter((t) => (cls === 'all' || t.cls === cls) && t.cue) as unknown as Tap[];
		const nocue = xs.filter((t) => (cls === 'all' || t.cls === cls) && !t.cue) as unknown as Tap[];
		const other = xs.filter((t) => cls !== 'all' && t.cls !== cls) as unknown as Tap[];
		const a = shares(mine);
		const b3 = bestCut(mine, 0.03);
		const cut = d.fixed ? (d.fixed[name]?.cut ?? 1.01) : (b3?.cut ?? 1.01);
		const c = shares(mine, cut);
		const nc = shares(nocue, cut);
		const ot = shares(other, cut);
		const hs = d.harms.filter((h) => h.scope === name && h.real);
		const hp = (place: HarmPlace) => {
			const ps = hs.filter((h) => h.place === place);
			return pct(ps.filter((h) => h.rule !== '-' && h.conf >= cut).length, ps.length);
		};
		const pass = c.g / (c.n || 1) >= 0.85 && (c.b + c.w) / (c.n || 1) <= 0.03;
		say(`| ${name} | ${a.n} | ${pct(a.g, a.n)} / ${pct(a.ns, a.n)} / ${pct(a.b + a.w, a.n)} | ${cut > 1 ? 'none' : cut}${d.fixed ? ` (${b3 ? b3.cut : 'none'})` : ''} | ${pct(c.g, c.n)} / ${pct(c.ns, c.n)} / ${pct(c.b + c.w, c.n)} | ${pct(nc.b + nc.w, nc.n)} | ${cls === 'all' ? '–' : pct(ot.g + ot.b + ot.w, ot.n)} | ${hp('paragraph')}, ${hp('margin')}, ${hp('table-cell')}, ${hp('form-away-text')} / ${hp('form-away-empty')} | ${pass ? 'meets' : 'short'} |`);
		scopeJson[name] = { all: a, cut, atCut: c, nocue: nc, other: ot, pass };
	}
	say();
	// Drawn checkboxes: check-like widgets where the page draws a small box, ring or box glyph.
	{
		const xs = d.scoped.filter((t) => t.scope === SCOPES[2][0] && t.real && t.cls === 'check' && t.shape) as unknown as Tap[];
		say('Check-like widgets where the page draws a small box, ring or box glyph at the widget (found from the raw ink, not by the snap rules), drawn-checks scope:');
		say();
		say(`| tap model | taps | all conf.: GOOD / NO-SNAP / BAD+WRONG | cutoff${d.fixed ? ' (the checks scope\'s, from the tuning sample)' : ' (≤ 3%)'} | GOOD / NO-SNAP / BAD+WRONG | ambiguous snaps dropped (cutoff 0.6) |`);
		say('|---|---:|---|---:|---|---|');
		const drawn: Record<string, unknown> = {};
		for (const m of models) {
			const ts = xs.filter((t) => t.model === m);
			const a = shares(ts);
			const b3 = bestCut(ts, 0.03);
			// On the held-out sample, the cutoff of the "checks" scope chosen on the tuning sample.
			const cut = d.fixed ? (d.fixed[SCOPES[1][0]]?.cut ?? 1.01) : (b3?.cut ?? 1.01);
			const c = shares(ts, cut);
			const amb = shares(ts, 0.6);
			say(`| ${m} | ${a.n} | ${pct(a.g, a.n)} / ${pct(a.ns, a.n)} / ${pct(a.b + a.w, a.n)} | ${cut > 1 ? 'none' : cut}${d.fixed ? ` (${b3 ? b3.cut : 'none'})` : ''} | ${pct(c.g, c.n)} / ${pct(c.ns, c.n)} / ${pct(c.b + c.w, c.n)} | ${pct(amb.g, amb.n)} / ${pct(amb.ns, amb.n)} / ${pct(amb.b + amb.w, amb.n)} |`);
			drawn[m] = { all: a, cut, atCut: c, ambDropped: amb };
		}
		say();
		scopeJson.drawnWidgets = drawn;
	}
	json.scopes = scopeJson;

	say('## Taps on places that are not blanks');
	say();
	say('| place | taps | snaps (any confidence) | snaps ≥ 0.5 | snaps ≥ 0.7 | rules that answered |');
	say('|---|---:|---:|---:|---:|---|');
	const harm: Record<string, unknown> = {};
	for (const place of ['paragraph', 'margin', 'table-cell', 'form-away-text', 'form-away-empty'] as HarmPlace[]) {
		const hs = d.harms.filter((h) => h.place === place && h.real && h.scope === 'all');
		const sn = hs.filter((h) => h.rule !== '-');
		const by: Record<string, number> = {};
		for (const h of sn) by[h.rule] = (by[h.rule] ?? 0) + 1;
		say(`| ${place} | ${hs.length} | ${pct(sn.length, hs.length)} | ${pct(sn.filter((h) => h.conf >= 0.5).length, hs.length)} | ${pct(sn.filter((h) => h.conf >= 0.7).length, hs.length)} | ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(', ')} |`);
		harm[place] = { n: hs.length, any: sn.length, c50: sn.filter((h) => h.conf >= 0.5).length, c70: sn.filter((h) => h.conf >= 0.7).length, by };
	}
	say();
	json.harm = harm;

	// More like this.
	say('## More like this (real-world form pages)');
	say();
	say('| k confirmed | pages | proposals per page | precision | recall of remaining widgets | recall of remaining widgets of the examples\' class |');
	say('|---|---:|---:|---:|---:|---:|');
	const like: Record<string, unknown> = {};
	for (const k of [1, 2, 3]) {
		const ls = d.likes.filter((l) => l.k === k && l.real);
		const sum = (f: (l: Like) => number) => ls.reduce((s, l) => s + f(l), 0);
		say(`| ${k} | ${ls.length} | ${(sum((l) => l.proposals) / (ls.length || 1)).toFixed(1)} | ${pct(sum((l) => l.correct), sum((l) => l.proposals))} | ${pct(sum((l) => l.found), sum((l) => l.remaining))} | ${pct(sum((l) => l.foundSame), sum((l) => l.remainingSame))} |`);
		like[k] = { pages: ls.length, proposals: sum((l) => l.proposals), correct: sum((l) => l.correct), remaining: sum((l) => l.remaining), found: sum((l) => l.found), remainingSame: sum((l) => l.remainingSame), foundSame: sum((l) => l.foundSame) };
	}
	say();
	json.like = like;

	const q = (xs: number[], p: number) => {
		const s = [...xs].sort((a, b) => a - b);
		return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0;
	};
	const speed = {
		collect: { median: q(d.collectMs, 0.5), p95: q(d.collectMs, 0.95), max: q(d.collectMs, 1) },
		prepare: { median: q(d.prepMs, 0.5), p95: q(d.prepMs, 0.95), max: q(d.prepMs, 1) },
		tap: { median: q(d.tapMs, 0.5), p95: q(d.tapMs, 0.95), max: q(d.tapMs, 1) }
	};
	const f = (x: { median: number; p95: number; max: number }) => `median ${x.median.toFixed(2)} ms, p95 ${x.p95.toFixed(2)} ms, max ${x.max.toFixed(1)} ms`;
	say(`Speed (Node, one core): collect ink (MuPDF) ${f(speed.collect)}; prepare (once per page) ${f(speed.prepare)}; snap per tap ${f(speed.tap)}.`);
	json.speed = speed;
	return { md: L.join('\n') + '\n', json };
}
