/**
 * Scoring OCR words against true words of a page.
 *
 * Words are compared after `norm`: NFKC, lower case, punctuation and symbols removed
 * (a word that is only punctuation drops out on both sides). True and OCR words are
 * paired one to one by position (greedy, largest overlap first; an OCR word pairs with
 * a true word when their boxes overlap and the centre of one lies inside the other).
 *
 * - recall exact: paired with the same text, over true words;
 *   recall ≤1 edit: paired with text at most one edit away.
 * - precision: OCR words paired exactly, over OCR words counted (an unpaired OCR word
 *   centred in an ignore zone, such as an embedded picture, is not counted); junk = 1 − precision.
 * - CER: edit distance of each true word to its paired OCR word (the whole word when
 *   unpaired), over true characters. Insertions away from true words show up as junk, not here.
 * - boxes, for pairs within one edit: `miss` when the true word's ink reaches more than
 *   1 pt outside the OCR box; `flood` when the OCR box covers another true word's ink by
 *   more than 1 pt along and more than 15% of that word's ink height across (the
 *   highlighter's flood rule, measured in the neighbour's own frame, so skew does not
 *   inflate it); `right` = neither.
 */
import { apply, type Mat } from './degrade';

export type Box = [number, number, number, number];

export interface TruthWord {
	/** Text as the PDF gives it. */
	t: string;
	/** Highlight box (page-text), pt, page as displayed, origin top-left. */
	h: Box;
	/** Ink box (union of glyph outline boxes), pt. */
	ink: Box;
	/** Font size, pt. */
	size: number;
	line: number;
}

/** OCR word: text, box in image pixels, confidence 0..100. */
export type OcrWord = [string, number, number, number, number, number];

export function norm(s: string): string {
	return s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '');
}

export function edit(a: string, b: string): number {
	if (a === b) return 0;
	if (!a.length) return b.length;
	if (!b.length) return a.length;
	let prev = new Array(b.length + 1);
	let cur = new Array(b.length + 1);
	for (let j = 0; j <= b.length; j++) prev[j] = j;
	for (let i = 1; i <= a.length; i++) {
		cur[0] = i;
		for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
		[prev, cur] = [cur, prev];
	}
	return prev[b.length];
}

export const SIZE_BUCKETS: [string, number, number][] = [
	['< 7 pt', 0, 7],
	['7–9.5 pt', 7, 9.5],
	['9.5–12.5 pt', 9.5, 12.5],
	['≥ 12.5 pt', 12.5, 1e9]
];

export interface Score {
	nT: number;
	nO: number;
	ex: number;
	e1: number;
	ch: number;
	ce: number;
	/** Pairs within one edit that were box-scored, and how they came out. */
	bm: number;
	right: number;
	miss: number;
	flood: number;
	/** Per size bucket: [true words, exact]. */
	sz: [number, number][];
}

export function emptyScore(): Score {
	return { nT: 0, nO: 0, ex: 0, e1: 0, ch: 0, ce: 0, bm: 0, right: 0, miss: 0, flood: 0, sz: SIZE_BUCKETS.map(() => [0, 0]) };
}

export function addScore(a: Score, b: Score): Score {
	return {
		nT: a.nT + b.nT,
		nO: a.nO + b.nO,
		ex: a.ex + b.ex,
		e1: a.e1 + b.e1,
		ch: a.ch + b.ch,
		ce: a.ce + b.ce,
		bm: a.bm + b.bm,
		right: a.right + b.right,
		miss: a.miss + b.miss,
		flood: a.flood + b.flood,
		sz: a.sz.map((v, i) => [v[0] + b.sz[i][0], v[1] + b.sz[i][1]])
	};
}

type Pt = [number, number];

function quad(m: Mat, b: Box): Pt[] {
	return [apply(m, b[0], b[1]), apply(m, b[2], b[1]), apply(m, b[2], b[3]), apply(m, b[0], b[3])];
}

function aabb(pts: Pt[]): Box {
	const xs = pts.map((p) => p[0]);
	const ys = pts.map((p) => p[1]);
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** Convex polygon clipped to an axis-aligned rectangle (Sutherland–Hodgman). */
function clip(poly: Pt[], r: Box): Pt[] {
	const edges: [(p: Pt) => number][] = [[(p) => p[0] - r[0]], [(p) => r[2] - p[0]], [(p) => p[1] - r[1]], [(p) => r[3] - p[1]]];
	let out = poly;
	for (const [f] of edges) {
		const inp = out;
		out = [];
		for (let i = 0; i < inp.length; i++) {
			const a = inp[i];
			const b = inp[(i + 1) % inp.length];
			const fa = f(a);
			const fb = f(b);
			if (fa >= 0) out.push(a);
			if ((fa >= 0) !== (fb >= 0)) {
				const t = fa / (fa - fb);
				out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
			}
		}
		if (!out.length) break;
	}
	return out;
}

function invert(m: Mat): Mat {
	const det = m[0] * m[3] - m[1] * m[2];
	const a = m[3] / det;
	const b = -m[1] / det;
	const c = -m[2] / det;
	const d = m[0] / det;
	return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

/**
 * Score one OCR run. `m` maps page points to image pixels; `ignore` are boxes in pt
 * (pictures, dropped true words) where unpaired OCR words are not counted.
 */
export function scorePage(truth: TruthWord[], ocr: OcrWord[], m: Mat, ignore: Box[] = [], minConf = -1, boxes = true): { score: Score; perWord: { e: number; size: number }[] } {
	const s = emptyScore();
	const inv = invert(m);
	const ppt = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
	const T = truth
		.map((t, i) => ({ i, t, n: norm(t.t), hq: quad(m, t.h), iq: quad(m, t.ink) }))
		.filter((x) => x.n.length > 0)
		.map((x) => ({ ...x, hb: aabb(x.hq), ib: aabb(x.iq) }));
	const O = ocr
		.filter((o) => o[5] >= minConf)
		.map((o) => ({ o, n: norm(o[0]), b: [o[1], o[2], o[3], o[4]] as Box }))
		.filter((x) => x.n.length > 0);
	// Candidate pairs (OCR words bucketed by rows of the image).
	const pairs: [number, number, number][] = [];
	const CELL = 64;
	const rowsO = new Map<number, number[]>();
	O.forEach((o, oi) => {
		for (let r = Math.floor(o.b[1] / CELL); r <= Math.floor(o.b[3] / CELL); r++) rowsO.set(r, [...(rowsO.get(r) ?? []), oi]);
	});
	const near = (b: Box, rows: Map<number, number[]>) => {
		const seen = new Set<number>();
		for (let r = Math.floor(b[1] / CELL); r <= Math.floor(b[3] / CELL); r++) for (const i of rows.get(r) ?? []) seen.add(i);
		return seen;
	};
	const rowsT = new Map<number, number[]>();
	T.forEach((t, ti) => {
		for (let r = Math.floor(t.ib[1] / CELL); r <= Math.floor(t.ib[3] / CELL); r++) rowsT.set(r, [...(rowsT.get(r) ?? []), ti]);
	});
	for (let ti = 0; ti < T.length; ti++) {
		const t = T[ti];
		const tb = t.hb;
		const tc: Pt = [(t.ib[0] + t.ib[2]) / 2, (t.ib[1] + t.ib[3]) / 2];
		for (const oi of near(tb, rowsO)) {
			const b = O[oi].b;
			const ow = Math.min(tb[2], b[2]) - Math.max(tb[0], b[0]);
			const oh = Math.min(tb[3], b[3]) - Math.max(tb[1], b[1]);
			if (ow <= 0 || oh <= 0) continue;
			const oc: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
			const inT = oc[0] >= tb[0] && oc[0] <= tb[2] && oc[1] >= tb[1] && oc[1] <= tb[3];
			const inO = tc[0] >= b[0] && tc[0] <= b[2] && tc[1] >= b[1] && tc[1] <= b[3];
			if (!inT && !inO) continue;
			const area = ow * oh;
			const minA = Math.min((tb[2] - tb[0]) * (tb[3] - tb[1]), (b[2] - b[0]) * (b[3] - b[1]));
			pairs.push([area / Math.max(1e-9, minA) + (t.n === O[oi].n ? 1 : 0), ti, oi]);
		}
	}
	pairs.sort((a, b) => b[0] - a[0]);
	const tPair = new Int32Array(T.length).fill(-1);
	const oPair = new Int32Array(O.length).fill(-1);
	for (const [, ti, oi] of pairs) {
		if (tPair[ti] >= 0 || oPair[oi] >= 0) continue;
		tPair[ti] = oi;
		oPair[oi] = ti;
	}
	const perWord: { e: number; size: number }[] = [];
	for (let ti = 0; ti < T.length; ti++) {
		const t = T[ti];
		const oi = tPair[ti];
		const e = oi >= 0 ? edit(t.n, O[oi].n) : t.n.length;
		s.nT++;
		s.ch += t.n.length;
		s.ce += Math.min(e, t.n.length);
		const bucket = SIZE_BUCKETS.findIndex(([, lo, hi]) => t.t.size >= lo && t.t.size < hi);
		if (bucket >= 0) s.sz[bucket][0]++;
		if (oi >= 0 && e === 0) {
			s.ex++;
			if (bucket >= 0) s.sz[bucket][1]++;
		}
		if (oi >= 0 && e <= 1) s.e1++;
		perWord.push({ e: oi >= 0 ? e : -1, size: t.t.size });
		if (oi >= 0 && e <= 1 && boxes) {
			const b = O[oi].b;
			s.bm++;
			// Miss: ink corners outside the OCR box, in pt.
			let out = 0;
			for (const p of t.iq) out = Math.max(out, b[0] - p[0], p[0] - b[2], b[1] - p[1], p[1] - b[3]);
			const miss = out / ppt > 1;
			// Flood: another word's ink under the OCR box, measured in page space.
			let flood = false;
			const ow = 1;
			for (const ui of near(b, rowsT)) {
				if (flood) break;
				if (ui === ti) continue;
				const u = T[ui];
				if (u.ib[2] < b[0] || u.ib[0] > b[2] || u.ib[3] < b[1] || u.ib[1] > b[3]) continue;
				const cl = clip(u.iq, b);
				if (cl.length < 3) continue;
				const back = aabb(cl.map((p) => apply(inv, p[0], p[1])));
				const inkH = u.t.ink[3] - u.t.ink[1];
				if (back[2] - back[0] > ow && back[3] - back[1] > Math.max(0.5, 0.15 * inkH)) flood = true;
			}
			if (miss) s.miss++;
			if (flood) s.flood++;
			if (!miss && !flood) s.right++;
		}
	}
	// Precision.
	const ign = ignore.map((b) => aabb(quad(m, b)));
	for (let oi = 0; oi < O.length; oi++) {
		if (oPair[oi] < 0) {
			const b = O[oi].b;
			const c: Pt = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
			if (ign.some((z) => c[0] >= z[0] && c[0] <= z[2] && c[1] >= z[1] && c[1] <= z[3])) continue;
		}
		s.nO++;
	}
	return { score: s, perWord };
}

/** Page-level signals for a decline gate, from the OCR output alone. */
export interface Signals {
	words: number;
	meanConf: number;
	/** Share of words with confidence below 60. */
	low60: number;
	/** Share of words with confidence below 30. */
	low30: number;
	/** Share of word tokens that are among the 100 most common English words. */
	stop: number;
	/** Share of words that look like words: letters only (an inner hyphen or apostrophe allowed), or plain numbers. */
	wordy: number;
	/** Median OCR word height, px (resolution signal). */
	medH: number;
}

const STOP = new Set(
	'the of and to a in is it you that he was for on are with as i his they be at one have this from or had by not word but what some we can out other were all there when up use your how said an each she which do their time if will way about many then them write would like so these her long make thing see him two has look more day could go come did number sound no most people my over know water than call first who may down side been now find any new work part take get place made live where after back little only round man year came show every good me give our under name very through just form sentence great think say help low line differ turn cause much mean before move right boy old too same tell does set three want air well also play small end put home read hand port large spell add even land here must big high such follow act why ask men change went light kind off need house picture try us again animal point mother world near build self earth father'.split(' ')
);

export function signals(ocr: OcrWord[]): Signals {
	const ws = ocr.filter((o) => norm(o[0]).length > 0);
	if (!ws.length) return { words: 0, meanConf: 0, low60: 1, low30: 1, stop: 0, wordy: 0, medH: 0 };
	const conf = ws.map((o) => o[5]);
	const hs = ws.map((o) => o[4] - o[2]).sort((a, b) => a - b);
	const toks = ws.map((o) => norm(o[0]));
	return {
		words: ws.length,
		meanConf: conf.reduce((a, b) => a + b, 0) / ws.length,
		low60: conf.filter((c) => c < 60).length / ws.length,
		low30: conf.filter((c) => c < 30).length / ws.length,
		stop: toks.filter((t) => STOP.has(t)).length / ws.length,
		wordy: ws.filter((o) => /^[\p{L}]+(['’-][\p{L}]+)*[.,;:!?)]*$|^[(]?[$€£]?\d[\d.,/:-]*%?[.,;:)]*$/u.test(o[0].replace(/^[("“‘']+|[)"”’']+$/g, ''))).length / ws.length,
		medH: hs[Math.floor(hs.length / 2)]
	};
}
