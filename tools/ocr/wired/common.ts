/**
 * Shared bits of the re-measurement of "Make scanned pages searchable" through the app's
 * own code path (createCoreEngine → exportPlan with ExportOptions.ocr, Node OCR backend
 * tests/engine/ocr-node.ts). Output: /home/garrett/pdf-survey/out-ocr-build/ (never the repo).
 */
import type * as MU from 'mupdf';
import { createCoreEngine, type EngineOptions } from '../../../src/lib/engine/core';
import { pageTextOf, type LayoutOptions } from '../../../src/lib/engine/page-text';
import type { OcrTrace } from '../../../src/lib/engine/ocr/stage';
import type { OcrRead } from '../../../src/lib/engine/ocr/tess';
import { nodeAssets } from '../../../tests/engine/helpers';
import { nodeOcr } from '../../../tests/engine/ocr-node';
import type { OcrWord } from '../lib/score';

export const OUT = '/home/garrett/pdf-survey/out-ocr-build';

export type B = [number, number, number, number];

/** An app engine with the Node OCR backend; every page's trace goes to `onTrace`. */
export function wiredEngine(onTrace: (t: OcrTrace) => void, slots = 1, extra: EngineOptions = {}) {
	return createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots }) }, { ocrTrace: onTrace, ...extra });
}

/** OCR words of a read, boxes turned back from Tesseract's deskew (axis-aligned), in image pixels. */
export function unturned(read: OcrRead): { words: OcrWord[]; line: number[] } {
	const a = read.rotate;
	const cx = read.width / 2;
	const cy = read.height / 2;
	const c = Math.cos(-a);
	const s = Math.sin(-a);
	const back = (x: number, y: number) => [c * (x - cx) - s * (y - cy) + cx, s * (x - cx) + c * (y - cy) + cy];
	const words: OcrWord[] = [];
	const line: number[] = [];
	read.lines.forEach((l, li) =>
		l.words.forEach((w) => {
			if (!a) {
				words.push(w);
			} else {
				const pts = [back(w[1], w[2]), back(w[3], w[2]), back(w[1], w[4]), back(w[3], w[4])];
				const xs = pts.map((q) => q[0]);
				const ys = pts.map((q) => q[1]);
				words.push([w[0], Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), w[5]]);
			}
			line.push(li);
		})
	);
	return { words, line };
}

/**
 * The highlighter on page `p` against gold word boxes (points), as tools/ocr/layer/check.ts
 * `hlScore` counts it: offered = a highlighter word with the same text holds the gold box
 * centre; miss = gold more than 1 pt outside it; flood = it reaches more than 15% of a word
 * height into a gold word of another line.
 */
export function hlScore(doc: MU.Document, p: number, gold: { t: string; b: B; line: number }[], opts: LayoutOptions = {}) {
	const page = doc.loadPage(p);
	const [x0, y0, x1, y1] = page.getBounds();
	page.destroy();
	const W = x1 - x0;
	const H = y1 - y0;
	const pt = pageTextOf(doc, p, opts);
	const words = pt.words.map((w) => ({ t: w.text, b: [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H] as B }));
	let offered = 0;
	let miss = 0;
	let flood = 0;
	let right = 0;
	const inside = (b: B, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
	for (const g of gold) {
		const cx = (g.b[0] + g.b[2]) / 2;
		const cy = (g.b[1] + g.b[3]) / 2;
		const bw = words.find((w) => w.t === g.t && inside(w.b, cx, cy));
		if (!bw) continue;
		offered++;
		const m = g.b[0] < bw.b[0] - 1 || g.b[1] < bw.b[1] - 1 || g.b[2] > bw.b[2] + 1 || g.b[3] > bw.b[3] + 1;
		const f = gold.some((o) => o.line !== g.line && Math.min(o.b[2], bw.b[2]) - Math.max(o.b[0], bw.b[0]) > 0 && Math.min(o.b[3], bw.b[3]) - Math.max(o.b[1], bw.b[1]) > 0.15 * (o.b[3] - o.b[1]));
		if (m) miss++;
		if (f) flood++;
		if (!m && !f) right++;
	}
	return { gold: gold.length, offered, miss, flood, right };
}

export const pct = (a: number, b: number, d = 1) => (b ? `${((100 * a) / b).toFixed(d)}%` : '–');
export const quant = (v: number[], q: number) => {
	if (!v.length) return 0;
	const s = [...v].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

type Pt = [number, number];

/** Convex polygon clipped to an axis-aligned rectangle (Sutherland–Hodgman). */
function clip(poly: Pt[], r: B): Pt[] {
	const fs: ((p: Pt) => number)[] = [(p) => p[0] - r[0], (p) => r[2] - p[0], (p) => p[1] - r[1], (p) => r[3] - p[1]];
	let out = poly;
	for (const f of fs) {
		const inp = out;
		out = [];
		for (let i = 0; i < inp.length; i++) {
			const a = inp[i];
			const b = inp[(i + 1) % inp.length];
			const fa = f(a);
			const fb = f(b);
			if (fa >= 0) out.push(a);
			if (fa >= 0 !== fb >= 0) {
				const t = fa / (fa - fb);
				out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
			}
		}
		if (!out.length) break;
	}
	return out;
}

/**
 * The highlighter on page `p` against the words OCR read (`read`, pixels at `dpi`), each
 * word measured in its own frame (Tesseract's deskewed image, where its box is tight),
 * as tools/ocr/lib/score.ts scores boxes "so skew does not inflate it": miss = a corner of
 * the word's ink more than 1 pt outside its highlight box; flood = the box reaches into
 * a word of another line by more than 1 pt along and 15% of that word's height across.
 */
export function hlScoreTurned(doc: MU.Document, p: number, read: OcrRead, dpi = 300, opts: LayoutOptions = {}) {
	const page = doc.loadPage(p);
	const [x0, y0, x1, y1] = page.getBounds();
	page.destroy();
	const W = x1 - x0;
	const H = y1 - y0;
	const k = 72 / dpi;
	const a = read.rotate;
	const cx = (read.width / 2) * k;
	const cy = (read.height / 2) * k;
	// Page points ↔ the deskewed frame (points).
	const toD = (x: number, y: number): Pt => [Math.cos(a) * (x - cx) - Math.sin(a) * (y - cy) + cx, Math.sin(a) * (x - cx) + Math.cos(a) * (y - cy) + cy];
	const toP = (x: number, y: number): Pt => [Math.cos(-a) * (x - cx) - Math.sin(-a) * (y - cy) + cx, Math.sin(-a) * (x - cx) + Math.cos(-a) * (y - cy) + cy];
	const gold = read.lines.flatMap((l, li) => l.words.map((w) => ({ t: w[0], d: [w[1] * k, w[2] * k, w[3] * k, w[4] * k] as B, line: li })));
	const pt = pageTextOf(doc, p, opts);
	const words = pt.words.map((w) => ({ t: w.text, b: [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H] as B }));
	let offered = 0;
	let miss = 0;
	let flood = 0;
	let right = 0;
	for (const g of gold) {
		const [gx, gy] = toP((g.d[0] + g.d[2]) / 2, (g.d[1] + g.d[3]) / 2);
		const bw = words.find((w) => w.t === g.t && gx >= w.b[0] && gx <= w.b[2] && gy >= w.b[1] && gy <= w.b[3]);
		if (!bw) continue;
		offered++;
		const corners = [toP(g.d[0], g.d[1]), toP(g.d[2], g.d[1]), toP(g.d[0], g.d[3]), toP(g.d[2], g.d[3])];
		const m = corners.some(([x, y]) => x < bw.b[0] - 1 || x > bw.b[2] + 1 || y < bw.b[1] - 1 || y > bw.b[3] + 1);
		const poly: Pt[] = [toD(bw.b[0], bw.b[1]), toD(bw.b[2], bw.b[1]), toD(bw.b[2], bw.b[3]), toD(bw.b[0], bw.b[3])];
		const f = gold.some((o) => {
			if (o.line === g.line) return false;
			const c = clip(poly, o.d);
			if (c.length < 3) return false;
			const xs = c.map((q) => q[0]);
			const ys = c.map((q) => q[1]);
			return Math.max(...xs) - Math.min(...xs) > 1 && Math.max(...ys) - Math.min(...ys) > 0.15 * (o.d[3] - o.d[1]);
		});
		if (m) miss++;
		if (f) flood++;
		if (!m && !f) right++;
	}
	return { gold: gold.length, offered, miss, flood, right };
}
