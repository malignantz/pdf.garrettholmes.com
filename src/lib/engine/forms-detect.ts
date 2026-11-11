/**
 * Blank detection on flat (non-fillable) forms: a measured prototype, not wired into
 * the app. See the plan, "Stretch: make a flat form fillable", for the method and the
 * numbers (tools/forms-detect/ measures it against real AcroForm widgets).
 *
 * Two steps:
 *
 * 1. `collectInk(m, page)` runs MuPDF's interpreter over the page *contents* only
 *    (annotations and widgets are never drawn, so an existing form's fields cannot
 *    leak in) and records, in MuPDF page space (points, origin top-left of the
 *    displayed page, y down):
 *    - glyphs with their character, size and box; glyphs of symbol fonts (and
 *      geometric-shape characters) are drawn once into a tiny bitmap to see whether
 *      they are a hollow square or ring (☐ ❑ ○ and their Wingdings/ZapfDingbats forms);
 *    - axis-aligned lines: stroked segments (thickness = line width) and thin filled
 *      rectangles (thickness = the short side);
 *    - rectangles: stroked or filled boxes bigger than a line; small circles.
 * 2. `detectBlanks(ink)` is pure geometry over that record, deterministic, with no
 *    knowledge of any particular producer:
 *    - checkboxes: small empty squares closed by four lines, small circles, hollow
 *      box glyphs, and small empty table cells (a "Yes | No" column);
 *    - comb boxes: two or more small squares in a tight row become one text blank;
 *    - underscore runs in text ("Name ________");
 *    - ruled blanks: a horizontal line with free space above it. If walls stand on the
 *      line and a line closes it above, it is a table cell: the blank is either the
 *      whole empty cell, the empty band under the cell's text, or the space right of a
 *      one-line label. Otherwise it is an open rule: the line itself, labelled on the
 *      left, above or below. Text running over the line, wrapped paragraphs, shaded
 *      heading bars and the top edges of boxes are not blanks;
 *    - each suggestion gets a confidence from simple features, and a label from the
 *      nearest text (left, above, below; right of a checkbox).
 */

import type * as MU from 'mupdf';
import { applyMatrix, multiply, type Matrix } from './geometry';
import { disown, type Mupdf } from './mupdf';

/** [x0, y0, x1, y1] in MuPDF page space (points, y down). */
export type Rect = [number, number, number, number];

export interface InkGlyph {
	/** Character (U+FFFD when the font has no mapping). */
	ch: string;
	/** Font name as MuPDF reports it (subset prefix removed). */
	font: string;
	/** Font size in page space. */
	size: number;
	/** Advance box: baseline − 0.8 em to baseline + 0.2 em. */
	r: Rect;
	/** Baseline y. */
	base: number;
	/** Lightness of the fill colour, 0 black … 1 white. */
	light: number;
	/** Glyph is upright (no rotation beyond a few degrees). */
	upright: boolean;
	/** A hollow square or ring glyph, with its ink box. */
	shape?: { kind: 'box' | 'ring'; r: Rect };
}

export interface InkLine {
	/** 'h' horizontal (y0 = y1 = the line's centre), 'v' vertical (x0 = x1). */
	dir: 'h' | 'v';
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	/** Thickness in points. */
	w: number;
	light: number;
}

export interface InkBox {
	r: Rect;
	/** Stroked outline (else filled). */
	stroked: boolean;
	light: number;
}

export interface PageInk {
	width: number;
	height: number;
	glyphs: InkGlyph[];
	lines: InkLine[];
	boxes: InkBox[];
	circles: Rect[];
	/** Paths seen (for the "too complex" guard). */
	paths: number;
	/** Images drawn over at least a quarter of the page (a scan: nothing to detect). */
	bigImages: number;
}

export type BlankKind = 'text' | 'checkbox';
export type BlankSource = 'underscore' | 'rule' | 'cell' | 'cell-band' | 'cell-right' | 'cell-check' | 'square' | 'circle' | 'glyph' | 'comb' | 'lines';

export interface BlankSuggestion {
	kind: BlankKind;
	source: BlankSource;
	rect: Rect;
	/** 0 … 1. */
	confidence: number;
	/** Nearest text on the left or above (may be empty). */
	label: string;
}

// ---------------------------------------------------------------------------
// 1. Collecting ink.

/** Fonts whose characters are pictures, and code points of geometric shapes: worth drawing to see. */
const SYMBOL_FONT = /dingbat|wingding|webding|symbol|marlett|extra|awesome|icons?\b/i;
function maybeShape(font: string, unicode: number): boolean {
	if (SYMBOL_FONT.test(font)) return true;
	return unicode <= 0 || unicode === 0xfffd || (unicode >= 0x2500 && unicode <= 0x2bff) || (unicode >= 0xe000 && unicode <= 0xf8ff);
}

function lightness(cs: MU.ColorSpace | null | undefined, color: number[] | undefined): number {
	if (!color || !color.length) return 0;
	const n = cs?.getNumberOfComponents?.() ?? color.length;
	if (n === 1) return color[0];
	if (n === 3) return 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2];
	if (n === 4) return Math.max(0, 1 - Math.min(1, 0.3 * color[0] + 0.59 * color[1] + 0.11 * color[2] + color[3]));
	return 0;
}

const AXIS_EPS = 0.35;
/** Filled rectangles up to this short side are lines. */
const THIN = 2.6;
/** Stop recording after this many paths (a map or a chart, not a form). */
const MAX_PATHS = 60_000;

function scaleOf(m: Matrix): number {
	return Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]));
}

function destroy(o: unknown) {
	try {
		(o as { destroy?: () => void } | null)?.destroy?.();
	} catch {
		// already gone
	}
}

const SHAPE_PX = 32;

/**
 * Draws one glyph at 32 px per em and says whether it is a hollow square ('box') or
 * ring, returning its ink box in em units (x right, y down from the baseline).
 */
function glyphShape(m: Mupdf, font: MU.Font, gid: number, wmode: number): { kind: 'box' | 'ring'; em: Rect } | null {
	const text = new m.Text();
	const zero = new m.StrokeState({ lineCap: 'Butt', lineJoin: 'Miter', lineWidth: 0, miterLimit: 10 });
	let pix: MU.Pixmap | null = null;
	let dev: MU.Device | null = null;
	try {
		// Font space is y up; this matrix puts the baseline at y = 0, y down, 32 px per em.
		text.showGlyph(font, [SHAPE_PX, 0, 0, -SHAPE_PX, 0, 0], gid, 0, wmode);
		// MuPDF bounds a glyph by its font's box, so draw it and find the ink.
		const b = text.getBounds(zero, m.Matrix.identity);
		if (!(b[2] > b[0] && b[3] > b[1]) || b[2] - b[0] > 4 * SHAPE_PX || b[3] - b[1] > 4 * SHAPE_PX) return null;
		const bx = Math.floor(b[0]);
		const by = Math.floor(b[1]);
		pix = new m.Pixmap(m.ColorSpace.DeviceGray, [bx, by, Math.ceil(b[2]), Math.ceil(b[3])], false);
		pix.clear(255);
		dev = new m.DrawDevice(m.Matrix.identity, pix);
		dev.fillText(text, m.Matrix.identity, m.ColorSpace.DeviceGray, [0], 1);
		dev.close();
		const px = pix.getPixels();
		const stride = pix.getStride();
		const PW = pix.getWidth();
		const PH = pix.getHeight();
		let x0 = PW;
		let y0 = PH;
		let x1 = -1;
		let y1 = -1;
		for (let y = 0; y < PH; y++)
			for (let x = 0; x < PW; x++)
				if (px[y * stride + x] < 128) {
					if (x < x0) x0 = x;
					if (x > x1) x1 = x;
					if (y < y0) y0 = y;
					if (y > y1) y1 = y;
				}
		const W = x1 - x0 + 1;
		const H = y1 - y0 + 1;
		if (x1 < 0 || W < 0.5 * SHAPE_PX || H < 0.5 * SHAPE_PX || W > 1.6 * SHAPE_PX || H > 1.6 * SHAPE_PX) return null;
		if (W / H < 0.75 || W / H > 1.33) return null;
		let center = 0;
		let centerN = 0;
		let ring = 0;
		let ringN = 0;
		let corner = 0;
		let cornerN = 0;
		const bw = Math.max(1, Math.round(0.2 * W));
		const bh = Math.max(1, Math.round(0.2 * H));
		const cw = Math.max(1, Math.round(0.12 * W));
		const ch = Math.max(1, Math.round(0.12 * H));
		for (let y = 0; y < H; y++) {
			for (let x = 0; x < W; x++) {
				const dark = px[(y + y0) * stride + x + x0] < 128 ? 1 : 0;
				const inner = x >= W * 0.3 && x < W * 0.7 && y >= H * 0.3 && y < H * 0.7;
				const edge = x < bw || x >= W - bw || y < bh || y >= H - bh;
				if (inner) {
					center += dark;
					centerN++;
				} else if (edge) {
					ring += dark;
					ringN++;
				}
				if ((x < cw || x >= W - cw) && (y < ch || y >= H - ch)) {
					corner += dark;
					cornerN++;
				}
			}
		}
		if (center / centerN > 0.06 || ring / ringN < 0.2) return null;
		const em: Rect = [(bx + x0) / SHAPE_PX, (by + y0) / SHAPE_PX, (bx + x1 + 1) / SHAPE_PX, (by + y1 + 1) / SHAPE_PX];
		return { kind: corner / cornerN > 0.3 ? 'box' : 'ring', em };
	} catch {
		return null;
	} finally {
		destroy(dev);
		destroy(pix);
		destroy(zero);
		destroy(text);
	}
}

/** Records the page's own content (no annotations) as glyphs, lines, boxes and circles. */
export function collectInk(m: Mupdf, page: MU.Page): PageInk {
	const b = page.getBounds();
	const ink: PageInk = { width: b[2] - b[0], height: b[3] - b[1], glyphs: [], lines: [], boxes: [], circles: [], paths: 0, bigImages: 0 };
	const area = ink.width * ink.height;
	const ox = b[0];
	const oy = b[1];
	const pt = (ctm: Matrix, x: number, y: number): [number, number] => {
		const p = applyMatrix(ctm, x, y);
		return [p[0] - ox, p[1] - oy];
	};
	const shapes = new Map<string, { kind: 'box' | 'ring'; em: Rect } | null>();

	type Sub = { pts: [number, number][]; closed: boolean; curves: number };
	const subpaths = (path: MU.Path, ctm: Matrix): Sub[] => {
		const subs: Sub[] = [];
		let cur: Sub | null = null;
		const start = (p: [number, number], curves: number) => {
			cur = { pts: [p], closed: false, curves };
			subs.push(cur);
		};
		path.walk({
			moveTo(x, y) {
				start(pt(ctm, x, y), 0);
			},
			lineTo(x, y) {
				if (!cur) start(pt(ctm, x, y), 0);
				else cur.pts.push(pt(ctm, x, y));
			},
			curveTo(_x1, _y1, _x2, _y2, x3, y3) {
				if (!cur) start(pt(ctm, x3, y3), 1);
				else {
					cur.curves++;
					cur.pts.push(pt(ctm, x3, y3));
				}
			},
			closePath() {
				if (cur) {
					cur.closed = true;
					start(cur.pts[0], 0);
				}
			}
		});
		return subs.filter((s) => s.pts.length > 1);
	};

	const asRect = (s: Sub): Rect | null => {
		if (s.curves) return null;
		let pts = s.pts;
		const a = pts[0];
		const z = pts[pts.length - 1];
		const returns = Math.abs(a[0] - z[0]) < AXIS_EPS && Math.abs(a[1] - z[1]) < AXIS_EPS;
		if (returns && pts.length > 1) pts = pts.slice(0, -1);
		if (pts.length !== 4 || (!s.closed && !returns)) return null;
		for (let i = 0; i < 4; i++) {
			const p = pts[i];
			const q = pts[(i + 1) % 4];
			if (Math.abs(p[0] - q[0]) > AXIS_EPS && Math.abs(p[1] - q[1]) > AXIS_EPS) return null;
		}
		const xs = pts.map((p) => p[0]);
		const ys = pts.map((p) => p[1]);
		return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
	};

	const circle = (s: Sub): Rect | null => {
		if (s.curves < 4 || s.curves > 8) return null;
		const xs = s.pts.map((p) => p[0]);
		const ys = s.pts.map((p) => p[1]);
		const r: Rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
		const w = r[2] - r[0];
		const h = r[3] - r[1];
		if (w < 4 || w > 24 || Math.abs(w - h) > 0.15 * w) return null;
		return r;
	};

	const addLine = (x0: number, y0: number, x1: number, y1: number, w: number, light: number) => {
		if (Math.abs(y1 - y0) <= AXIS_EPS && Math.abs(x1 - x0) > AXIS_EPS) {
			const y = (y0 + y1) / 2;
			ink.lines.push({ dir: 'h', x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: y, y1: y, w, light });
		} else if (Math.abs(x1 - x0) <= AXIS_EPS && Math.abs(y1 - y0) > AXIS_EPS) {
			const x = (x0 + x1) / 2;
			ink.lines.push({ dir: 'v', x0: x, x1: x, y0: Math.min(y0, y1), y1: Math.max(y0, y1), w, light });
		}
	};

	const onFill = (path: MU.Path, ctm: Matrix, light: number) => {
		if (++ink.paths > MAX_PATHS) return;
		const subs = subpaths(path, ctm);
		const rects = subs.map(asRect);
		// Two nested rectangles in one fill (re re f*): a frame, i.e. a drawn box outline.
		const frameInner = new Set<number>();
		rects.forEach((r, i) => {
			if (!r) return;
			rects.forEach((q, j) => {
				if (!q || i === j || frameInner.has(i)) return;
				const d = [q[0] - r[0], q[1] - r[1], r[2] - q[2], r[3] - q[3]];
				if (d.every((x) => x >= 0.05 && x <= 4)) {
					frameInner.add(j);
					ink.boxes.push({ r, stroked: true, light });
					const t = Math.min(...d);
					addLine(r[0], r[1], r[2], r[1], t, light);
					addLine(r[0], r[3], r[2], r[3], t, light);
					addLine(r[0], r[1], r[0], r[3], t, light);
					addLine(r[2], r[1], r[2], r[3], t, light);
					frameInner.add(i + 100000);
				}
			});
		});
		rects.forEach((r, i) => {
			if (!r || frameInner.has(i) || frameInner.has(i + 100000)) return;
			const w = r[2] - r[0];
			const h = r[3] - r[1];
			if (w <= 0.05 && h <= 0.05) return;
			if (Math.min(w, h) <= THIN) {
				if (w >= h) addLine(r[0], (r[1] + r[3]) / 2, r[2], (r[1] + r[3]) / 2, Math.max(h, 0.1), light);
				else addLine((r[0] + r[2]) / 2, r[1], (r[0] + r[2]) / 2, r[3], Math.max(w, 0.1), light);
			} else if (w * h < area * 0.6) {
				ink.boxes.push({ r, stroked: false, light });
			}
			// Filled circles are bullets and dots, not answer rings: only stroked ones count.
		});
	};

	const onStroke = (path: MU.Path, stroke: MU.StrokeState, ctm: Matrix, light: number) => {
		if (++ink.paths > MAX_PATHS) return;
		const w = Math.max(0.1, (stroke.getLineWidth?.() ?? 1) * scaleOf(ctm));
		for (const s of subpaths(path, ctm)) {
			const r = asRect(s);
			if (r && r[2] - r[0] > THIN && r[3] - r[1] > THIN) ink.boxes.push({ r, stroked: true, light });
			const c = r ? null : circle(s);
			if (c) {
				ink.circles.push(c);
				continue;
			}
			if (s.curves) continue;
			const pts = s.closed ? [...s.pts, s.pts[0]] : s.pts;
			for (let i = 1; i < pts.length; i++) addLine(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], w, light);
		}
	};

	const onText = (text: MU.Text, ctm: Matrix, light: number) => {
		text.walk({
			showGlyph(font, trm, gid, unicode, wmode) {
				const adv = font.advanceGlyph(gid, wmode) || 0.5;
				const full = multiply(trm as Matrix, ctm);
				const size = scaleOf(full);
				if (size < 0.5) return;
				const upright = Math.abs(full[1]) < 0.05 * size && Math.abs(full[2]) < 0.05 * size && full[0] > 0;
				const p0 = pt(full, 0, -0.2);
				const p1 = pt(full, adv, 0.8);
				const o = pt(full, 0, 0);
				const r: Rect = [Math.min(p0[0], p1[0]), Math.min(p0[1], p1[1]), Math.max(p0[0], p1[0]), Math.max(p0[1], p1[1])];
				let name = font.getName();
				const plus = name.indexOf('+');
				if (plus === 6) name = name.slice(7);
				const ch = unicode > 0 ? String.fromCodePoint(unicode) : '�';
				const g: InkGlyph = { ch, font: name, size, r, base: o[1], light, upright };
				if (upright && maybeShape(name, unicode)) {
					const key = `${name}\u0000${gid}\u0000${wmode}`;
					let s = shapes.get(key);
					if (s === undefined) shapes.set(key, (s = glyphShape(m, font, gid, wmode)));
					// An unmapped glyph of a text font may be a letter (O, D): only a square counts there.
					const symbolic = SYMBOL_FONT.test(name) || (unicode >= 0x2500 && unicode <= 0x2bff);
					if (s && (s.kind === 'box' || symbolic)) g.shape = { kind: s.kind, r: [o[0] + s.em[0] * size, o[1] + s.em[1] * size, o[0] + s.em[2] * size, o[1] + s.em[3] * size] };
				}
				ink.glyphs.push(g);
			}
		});
	};

	const dev = new m.Device({
		fillPath(path, _eo, ctm, cs, color, alpha) {
			if (alpha < 0.2) return;
			onFill(path, ctm as Matrix, lightness(cs, color as number[]));
		},
		strokePath(path, stroke, ctm, cs, color, alpha) {
			if (alpha < 0.2) return;
			onStroke(path, stroke, ctm as Matrix, lightness(cs, color as number[]));
		},
		fillText(text, ctm, cs, color, alpha) {
			if (alpha < 0.2) return;
			onText(text, ctm as Matrix, lightness(cs, color as number[]));
		},
		strokeText(text, _s, ctm, cs, color) {
			onText(text, ctm as Matrix, lightness(cs, color as number[]));
		},
		fillShade(shade) {
			// See mupdf.ts: the wrapper must not free the borrowed shade.
			disown(shade);
		},
		fillImage(_image, ctm) {
			const c = ctm as Matrix;
			if (Math.abs(c[0] * c[3] - c[1] * c[2]) >= area * 0.25) ink.bigImages++;
		}
	});
	try {
		page.runPageContents(dev, m.Matrix.identity);
		dev.close();
	} finally {
		destroy(dev);
	}
	return ink;
}

// ---------------------------------------------------------------------------
// 2. Detection (pure).

export interface Word {
	text: string;
	r: Rect;
	size: number;
	base: number;
}

const UNDERSCORE = '_';

/** Groups upright, visible glyphs into words (underscores, spaces and box glyphs split words and are dropped). */
export function words(glyphs: InkGlyph[]): Word[] {
	const out: Word[] = [];
	let cur: Word | null = null;
	let lastX = 0;
	for (const g of glyphs) {
		const skip = !g.upright || g.light >= 0.9 || /\s/.test(g.ch) || g.ch === UNDERSCORE || g.shape;
		if (skip) {
			if (cur) out.push(cur);
			cur = null;
			continue;
		}
		const join =
			cur &&
			Math.abs(g.base - cur.base) < 0.25 * Math.max(g.size, cur.size) &&
			g.r[0] - lastX < 0.25 * g.size &&
			g.r[0] - lastX > -0.6 * g.size;
		if (join && cur) {
			cur.text += g.ch;
			cur.r = [Math.min(cur.r[0], g.r[0]), Math.min(cur.r[1], g.r[1]), Math.max(cur.r[2], g.r[2]), Math.max(cur.r[3], g.r[3])];
		} else {
			if (cur) out.push(cur);
			cur = { text: g.ch, r: [...g.r] as Rect, size: g.size, base: g.base };
		}
		lastX = g.r[2];
	}
	if (cur) out.push(cur);
	return out;
}

/** A horizontal or vertical line after joining collinear pieces. */
export interface Rule {
	/** Position across (y for 'h', x for 'v'). */
	at: number;
	/** Extent along. */
	a: number;
	b: number;
	w: number;
	/** Number of pieces joined (many short pieces: a dashed or dotted line). */
	pieces: number;
}

/** Lines dark enough to see on white, at most this thick, count as rules. */
const MAX_RULE_W = 3;
const MAX_RULE_LIGHT = 0.85;

type Seg = { at: number; a: number; b: number; w: number };

/** Joins collinear segments (same position within 0.75 pt) whose ends touch or nearly touch. */
export function joinSegs(xs: Seg[], gap = 1.5): Rule[] {
	const sorted = [...xs].sort((p, q) => p.at - q.at || p.a - q.a);
	const out: Rule[] = [];
	let i = 0;
	while (i < sorted.length) {
		let j = i + 1;
		while (j < sorted.length && sorted[j].at - sorted[j - 1].at <= 0.75) j++;
		const group = sorted.slice(i, j).sort((p, q) => p.a - q.a);
		let cur: Rule | null = null;
		let atSum = 0;
		for (const s of group) {
			if (cur && s.a <= cur.b + gap) {
				cur.b = Math.max(cur.b, s.b);
				cur.w = Math.max(cur.w, s.w);
				cur.pieces++;
				atSum += s.at;
			} else {
				if (cur) out.push({ ...cur, at: atSum / cur.pieces });
				cur = { at: s.at, a: s.a, b: s.b, w: s.w, pieces: 1 };
				atSum = s.at;
			}
		}
		if (cur) out.push({ ...cur, at: atSum / cur.pieces });
		i = j;
	}
	return out;
}

function segsOf(lines: InkLine[], dir: 'h' | 'v'): Seg[] {
	return lines
		.filter((l) => l.dir === dir && l.w <= MAX_RULE_W && l.light <= MAX_RULE_LIGHT)
		.map((l) => (dir === 'h' ? { at: l.y0, a: l.x0, b: l.x1, w: l.w } : { at: l.x0, a: l.y0, b: l.y1, w: l.w }));
}

/**
 * Edges that a filled box shows without any line: a white box on a shaded area (IRS
 * style answer boxes), and a tinted box with no text in it (a shaded answer field).
 */
function boxEdges(ink: PageInk, ws: Word[]): { h: Seg[]; v: Seg[] } {
	const h: Seg[] = [];
	const v: Seg[] = [];
	const shaded = ink.boxes.filter((b) => !b.stroked && b.light < 0.95);
	const add = (r: Rect) => {
		h.push({ at: r[1], a: r[0], b: r[2], w: 0.5 }, { at: r[3], a: r[0], b: r[2], w: 0.5 });
		v.push({ at: r[0], a: r[1], b: r[3], w: 0.5 }, { at: r[2], a: r[1], b: r[3], w: 0.5 });
	};
	const paper = ink.boxes.filter((b) => !b.stroked && b.light >= 0.9);
	for (const b of ink.boxes) {
		if (b.stroked) continue;
		// A dark box with a paper-coloured box just inside it: drawn as a frame.
		if (b.light < 0.6) {
			const inset = paper.find((p) => {
				const d = [p.r[0] - b.r[0], p.r[1] - b.r[1], b.r[2] - p.r[2], b.r[3] - p.r[3]];
				return d.every((x) => x >= 0.1 && x <= 3);
			});
			if (inset) {
				add(b.r);
				continue;
			}
		}
		const w = b.r[2] - b.r[0];
		const ht = b.r[3] - b.r[1];
		if (ht > 120 || w < 5) continue;
		if (b.light >= 0.95) {
			const on = shaded.some((s) => s !== b && s.r[0] <= b.r[0] + 0.5 && s.r[1] <= b.r[1] + 0.5 && s.r[2] >= b.r[2] - 0.5 && s.r[3] >= b.r[3] - 0.5);
			if (on) add(b.r);
		} else if (b.light >= 0.6 && ht >= 6 && !ws.some((x) => overlaps(x.r, b.r, 1))) {
			add(b.r);
		}
	}
	return { h, v };
}

export interface DetectOptions {
	/** Minimum length of a ruled blank, in points (default 24). */
	minRule?: number;
}

interface Ctx {
	ws: Word[];
	h: Rule[];
	v: Rule[];
	body: number;
	width: number;
	height: number;
	/** Filled boxes darker than paper with text in them: headings, not answer space. */
	bars: Rect[];
}

/** Suggestions for one page, sorted top to bottom, left to right. */
export function detectBlanks(ink: PageInk, opts: DetectOptions = {}): BlankSuggestion[] {
	if (ink.paths > MAX_PATHS || ink.bigImages > 0) return [];
	const ws = words(ink.glyphs);
	const body = median(ws.map((w) => w.size)) || 10;
	const extra = boxEdges(ink, ws);
	const hs = segsOf(ink.lines, 'h');
	const h = [...joinSegs([...hs, ...extra.h]), ...joinSegs(hs.filter((s) => s.b - s.a <= 6), 4).filter((r) => r.pieces >= 6)];
	const v = joinSegs([...segsOf(ink.lines, 'v'), ...extra.v]);
	const bars = ink.boxes.filter((b) => !b.stroked && b.light < 0.95 && ws.some((x) => overlaps(x.r, b.r, 1))).map((b) => b.r);
	const ctx: Ctx = { ws, h, v, body, width: ink.width, height: ink.height, bars };

	// Checkboxes first: their edges must not also become ruled text blanks.
	const squares = squareBoxes(ctx);
	const combs = combRows(squares, ctx);
	const singles = squares.filter((s) => !combs.some((c) => contains(c.rect, s.rect, 0.5)));
	const out: BlankSuggestion[] = [...dedupe([...singles, ...circleBoxes(ink, ctx), ...glyphBoxes(ink, ctx)]), ...combs];
	out.push(...underscoreBlanks(ink, ctx));
	out.push(...ruledBlanks(ctx, opts.minRule ?? 24, out));

	const zones = officeUse(ctx);
	return stacks(dedupe(out))
		.filter((s) => !zones.some((z) => contains(z, s.rect, 1)))
		.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0])
		.map((s) => ({ ...s, rect: s.rect.map(round) as Rect, confidence: round(Math.max(0, Math.min(1, s.confidence))) }));
}

// --- Checkboxes -----------------------------------------------------------

const CHECK_MIN = 5;
const CHECK_MAX = 18;

/** Small squares closed by four rules (joined lines, so grid cells drop out: their edges run on). */
function squareBoxes(ctx: Ctx): BlankSuggestion[] {
	const out: BlankSuggestion[] = [];
	const short = ctx.h.filter((r) => r.b - r.a >= CHECK_MIN && r.b - r.a <= CHECK_MAX);
	const vs = ctx.v.filter((r) => r.b - r.a >= CHECK_MIN - 1 && r.b - r.a <= CHECK_MAX + 3);
	for (const top of short) {
		const side = top.b - top.a;
		for (const bot of short) {
			if (bot.at <= top.at) continue;
			const d = bot.at - top.at;
			if (Math.abs(bot.a - top.a) > 1.2 || Math.abs(bot.b - top.b) > 1.2) continue;
			if (d < side * 0.75 || d > side * 1.33) continue;
			const wall = (x: number) => vs.some((r) => Math.abs(r.at - x) <= 1.2 && r.a <= top.at + 1.2 && r.b >= bot.at - 1.2);
			if (!wall(top.a) || !wall(top.b)) continue;
			const rect: Rect = [top.a, top.at, top.b, bot.at];
			if (inkInside(ctx, rect)) continue;
			out.push({ kind: 'checkbox', source: 'square', rect, confidence: 0.95, label: labelRight(rect, ctx.ws) || labelFor(rect, ctx.ws) });
		}
	}
	return out;
}

/** Two or more squares of one size in a tight row (gaps under a third of a side): one comb text blank. */
function combRows(squares: BlankSuggestion[], ctx: Ctx): BlankSuggestion[] {
	const sorted = [...squares].sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
	const used = new Set<BlankSuggestion>();
	const out: BlankSuggestion[] = [];
	for (const s of sorted) {
		if (used.has(s)) continue;
		const row = [s];
		let last = s;
		for (;;) {
			const side = last.rect[2] - last.rect[0];
			const next = sorted.find(
				(o) =>
					!used.has(o) &&
					!row.includes(o) &&
					Math.abs(o.rect[1] - last.rect[1]) < 1 &&
					Math.abs(o.rect[3] - last.rect[3]) < 1 &&
					o.rect[0] >= last.rect[2] - 0.5 &&
					o.rect[0] - last.rect[2] <= side / 3 &&
					Math.abs(o.rect[2] - o.rect[0] - side) < 1.5
			);
			if (!next) break;
			row.push(next);
			last = next;
		}
		if (row.length < 2) continue;
		for (const r of row) used.add(r);
		const rect: Rect = [row[0].rect[0], row[0].rect[1], last.rect[2], last.rect[3]];
		out.push({ kind: 'text', source: 'comb', rect, confidence: 0.6, label: labelFor(rect, ctx.ws) });
	}
	return out;
}

function circleBoxes(ink: PageInk, ctx: Ctx): BlankSuggestion[] {
	return ink.circles
		.filter((c) => c[2] - c[0] >= CHECK_MIN && c[2] - c[0] <= CHECK_MAX && !inkInside(ctx, c))
		.map((rect) => ({ kind: 'checkbox' as const, source: 'circle' as const, rect, confidence: 0.85, label: labelRight(rect, ctx.ws) || labelFor(rect, ctx.ws) }));
}

function glyphBoxes(ink: PageInk, ctx: Ctx): BlankSuggestion[] {
	const out: BlankSuggestion[] = [];
	for (const g of ink.glyphs) {
		if (!g.shape || g.light >= 0.9) continue;
		const rect = g.shape.r;
		const side = rect[2] - rect[0];
		if (side < 4 || side > 24) continue;
		out.push({ kind: 'checkbox', source: 'glyph', rect, confidence: 0.9, label: labelRight(rect, ctx.ws) || labelFor(rect, ctx.ws) });
	}
	return out;
}

/**
 * Any word whose box overlaps the inside of `r` (shrunk by 1 pt), except a hint: one
 * small letter or digit in a box ("d", "m", "y" in date boxes).
 */
function inkInside(ctx: Ctx, r: Rect): boolean {
	const i: Rect = [r[0] + 1, r[1] + 1, r[2] - 1, r[3] - 1];
	const side = Math.min(r[2] - r[0], r[3] - r[1]);
	return ctx.ws.some((w) => overlaps(w.r, i, 0.5) && !(w.text.length === 1 && w.size <= 0.6 * side));
}

// --- Underscores ----------------------------------------------------------

interface Run {
	x0: number;
	x1: number;
	base: number;
	size: number;
}

/** Three or more consecutive underscores on one baseline, joined across small gaps. */
export function underscoreRuns(glyphs: InkGlyph[]): Run[] {
	const runs: Run[] = [];
	let cur: (Run & { n: number }) | null = null;
	const flush = () => {
		if (cur && cur.n >= 3) runs.push({ x0: cur.x0, x1: cur.x1, base: cur.base, size: cur.size });
		cur = null;
	};
	for (const g of glyphs) {
		if (!g.upright || g.ch !== UNDERSCORE || g.light >= 0.9) {
			if (g.ch !== ' ') flush();
			continue;
		}
		if (cur && Math.abs(g.base - cur.base) < 0.2 * g.size && g.r[0] - cur.x1 < 0.6 * g.size && g.r[0] - cur.x1 > -0.3 * g.size) {
			cur.x1 = Math.max(cur.x1, g.r[2]);
			cur.n++;
		} else {
			flush();
			cur = { x0: g.r[0], x1: g.r[2], base: g.base, size: g.size, n: 1 };
		}
	}
	flush();
	return runs;
}

function underscoreBlanks(ink: PageInk, ctx: Ctx): BlankSuggestion[] {
	const out: BlankSuggestion[] = [];
	for (const run of underscoreRuns(ink.glyphs)) {
		const len = run.x1 - run.x0;
		if (len < 12) continue;
		const bottom = run.base + 0.12 * run.size;
		// Up to the nearest text or rule above, at most about one and a half lines.
		const top = Math.max(bottom - run.size * 1.6, ceilingAbove(ctx, run.x0, run.x1, bottom - 2) + 1);
		const rect: Rect = [run.x0, Math.min(top, bottom - run.size * 0.8), run.x1, bottom];
		const label = labelFor(rect, ctx.ws) || labelBelow(rect, ctx.ws);
		out.push({ kind: 'text', source: 'underscore', rect, confidence: (len > 4 * run.size ? 0.9 : 0.75) - (label ? 0 : 0.15), label });
	}
	return out;
}

// --- Ruled blanks (free space above a horizontal rule) --------------------

/**
 * For each horizontal rule, split by the vertical rules that stand on it: a piece with
 * walls on both sides and a rule above that spans it is a table cell, anything else
 * an open rule. See the module header for what counts as a blank in each.
 */
function ruledBlanks(ctx: Ctx, minRule: number, taken: BlankSuggestion[]): BlankSuggestion[] {
	const out: BlankSuggestion[] = [];
	const { body } = ctx;
	const lineH = body * 1.25;
	for (const r of ctx.h) {
		const len = r.b - r.a;
		if (len < 6) continue;
		const y = r.at;
		const near = ctx.v.filter((v) => v.at >= r.a - 1.5 && v.at <= r.b + 1.5);
		// Walls standing on this rule (going up), and walls hanging below it only.
		const up = near.filter((v) => v.a < y - 2 && v.b >= y - 1.5);
		const down = near.filter((v) => v.a >= y - 1.5 && v.a <= y + 3 && v.b > y + 2);
		const walls = [...new Set(up.map((v) => round(v.at)))].sort((a, b) => a - b);
		const cuts = [r.a, ...walls.filter((x) => x > r.a + 1 && x < r.b - 1), r.b];
		// Small empty cells side by side: one comb text blank, not a row of checkboxes.
		let run: { s: BlankSuggestion; cell: Rect }[] = [];
		const row: { s: BlankSuggestion; cell: Rect; drop: boolean }[] = [];
		const flush = () => {
			if (run.length === 1) out.push(run[0].s);
			else if (run.length > 1) {
				const a = run[0].cell;
				const z = run[run.length - 1].cell;
				const rect: Rect = [a[0] + 1, a[1] + 1, z[2] - 1, z[3] - 0.5];
				out.push({ kind: 'text', source: 'comb', rect, confidence: 0.55, label: labelFor(rect, ctx.ws) });
			}
			run = [];
		};
		for (let k = 0; k + 1 < cuts.length; k++) {
			const x0 = cuts[k];
			const x1 = cuts[k + 1];
			if (x1 - x0 < 6) continue;
			const wallAt = (x: number) => up.find((v) => Math.abs(v.at - x) <= 1.5);
			const lw = wallAt(x0);
			const rw = wallAt(x1);
			// Cell ceiling: the nearest rule above that spans this piece.
			let ceil = -Infinity;
			for (const o of ctx.h) if (o !== r && o.at < y - 0.5 && o.at > ceil && o.a <= x0 + 2 && o.b >= x1 - 2) ceil = o.at;
			const inCell = !!lw && !!rw && ceil > -Infinity && lw.a <= ceil + 2 && rw.a <= ceil + 2;
			if (inCell) {
				const s = cellBlank(ctx, [x0, ceil, x1, y], taken);
				if (s?.source === 'cell-check' && run.length && Math.abs(run[run.length - 1].cell[2] - x0) < 1.5 && Math.abs(run[run.length - 1].cell[1] - ceil) < 1.5) {
					run.push({ s, cell: [x0, ceil, x1, y] });
					continue;
				}
				flush();
				// A label cell next to an empty answer cell: the answer is the neighbour.
				const prev = row[row.length - 1];
				if (s?.source === 'cell' && prev?.s.source === 'cell-right' && Math.abs(prev.cell[2] - x0) < 1.5) prev.drop = true;
				if (s) row.push({ s, cell: [x0, ceil, x1, y], drop: false });
				if (s?.source === 'cell-check') run.push({ s, cell: [x0, ceil, x1, y] });
				else if (s) out.push(s);
				continue;
			}
			flush();
			// The top edge of a box (walls only hang down from it) is not a blank.
			const hanging = down.some((v) => Math.abs(v.at - x0) <= 1.5) && down.some((v) => Math.abs(v.at - x1) <= 1.5);
			if (hanging) continue;
			if (x1 - x0 < Math.max(minRule, body * 2)) continue;
			out.push(...openRule(ctx, r, x0, x1, lineH, taken));
		}
		flush();
		for (const c of row) if (c.drop) out.splice(out.indexOf(c.s), 1);
	}
	return out;
}

/** A blank in the table cell `c` ([x0, top rule, x1, bottom rule]), or null. */
function cellBlank(ctx: Ctx, c: Rect, taken: BlankSuggestion[]): BlankSuggestion | null {
	const { body } = ctx;
	const [x0, top, x1, y] = c;
	const w = x1 - x0;
	const h = y - top;
	if (h < 7 || w < 6) return null;
	if (ctx.bars.some((b) => contains(b, [x0 + 1, top + 1, x1 - 1, y - 1], 1.5))) return null; // shaded heading
	if (taken.some((t) => t.kind === 'checkbox' && overlaps(t.rect, c, 1))) return null;
	if (taken.some((t) => t.kind === 'text' && (contains(c, t.rect, 1) || (t.source === 'comb' && overlaps(t.rect, c, 1))))) return null;
	const inside = ctx.ws.filter((x) => {
		const cx = (x.r[0] + x.r[2]) / 2;
		const cy = (x.r[1] + x.r[3]) / 2;
		return cx > x0 && cx < x1 && cy > top && cy < y;
	});
	const inner: Rect = [x0 + 1, top + 1, x1 - 1, y - 0.5];
	if (!inside.length) {
		// An empty cell. Small and squarish: a checkbox in its middle.
		if (w <= 30 && h <= 20 && w <= 2.5 * h) {
			const s = Math.min(w, h) - 2;
			const cx = (x0 + x1) / 2;
			const cy = (top + y) / 2;
			const rect: Rect = [cx - s / 2, cy - s / 2, cx + s / 2, cy + s / 2];
			const head = labelAbove(c, ctx.ws);
			return { kind: 'checkbox', source: 'cell-check', rect, confidence: /^(yes|no|y|n|true|false)$/i.test(head) ? 0.85 : 0.55, label: head || labelFor(c, ctx.ws) };
		}
		if (w < Math.max(18, body * 1.8) || h > 400) return null;
		const label = labelLeft(inner, ctx.ws) || labelAbove(c, ctx.ws);
		// Measured on the tuning sample: one-line cells (up to 20 pt) are nearly always
		// blanks; taller ones are often spacers, stamps or office-use boxes.
		let conf = h <= 20 ? 0.9 : h <= 28 ? (label ? 0.8 : 0.5) : 0.45;
		if (w < 50) conf -= 0.1;
		if (!label) conf -= 0.05;
		return { kind: 'text', source: 'cell', rect: inner, confidence: conf, label };
	}
	const textBottom = Math.max(...inside.map((x) => x.r[3]));
	const lines = textLines(inside);
	// The empty band under the cell's text, across the whole cell.
	const band = y - textBottom;
	const first = lines[0];
	// Only an item number ("35.", "4a", "(b)"): a word label such as "Name:" is as often a table heading.
	const shortLabel = lines.length === 1 && /^\(?[0-9]{1,2}[a-z]?[.):]?$|^\(?[a-z][.)]$/i.test(first.text) && first.r[2] - x0 < 0.25 * w && first.r[0] - x0 < 0.15 * w && h < 3 * body * 1.25;
	if (shortLabel && x1 - first.r[2] >= Math.max(30, body * 3)) {
		// A number or a short word in the corner ("35."), the answer beside it.
		const rect: Rect = [first.r[2] + 2, top + 1, x1 - 1, y - 0.5];
		return { kind: 'text', source: 'cell-right', rect, confidence: 0.85, label: first.text };
	}
	if (band >= Math.max(10, body * 1.15) && w >= Math.max(18, body * 1.8)) {
		const rect: Rect = [x0 + 1, textBottom + 1, x1 - 1, y - 0.5];
		const label = lines.map((l) => l.text).join(' ').slice(0, 80);
		// A tall empty band under a sentence is usually padding; a band under a label that
		// ends in punctuation (":" or ")") is usually the answer.
		const ends = /[:)?]$/.test(label) ? 0.75 : 0.5;
		return { kind: 'text', source: 'cell-band', rect, confidence: band > 40 || band < 10 ? 0.3 : ends, label };
	}
	// Right of a one-line label that starts at the cell's left side.
	if (lines.length === 1 && first.r[0] - x0 < Math.max(10, 0.1 * w)) {
		const free = x1 - first.r[2];
		if (free < Math.max(36, 0.3 * w)) return null;
		if (/\.$/.test(first.text) && first.text.split(' ').length >= 3) return null; // a sentence, not a label
		const rect: Rect = [first.r[2] + 2, top + 1, x1 - 1, y - 0.5];
		return { kind: 'text', source: 'cell-right', rect, confidence: 0.4, label: first.text };
	}
	return null;
}

interface TextLine {
	text: string;
	r: Rect;
	base: number;
	size: number;
}

/** Words grouped into lines by baseline, top to bottom, each line's words left to right. */
function textLines(ws: Word[]): TextLine[] {
	const sorted = [...ws].sort((a, b) => a.base - b.base || a.r[0] - b.r[0]);
	const out: { ws: Word[]; base: number; size: number }[] = [];
	for (const w of sorted) {
		const l = out.find((o) => Math.abs(o.base - w.base) < 0.35 * Math.max(o.size, w.size));
		if (l) l.ws.push(w);
		else out.push({ ws: [w], base: w.base, size: w.size });
	}
	return out
		.sort((a, b) => a.base - b.base)
		.map((l) => {
			const s = l.ws.sort((a, b) => a.r[0] - b.r[0]);
			return {
				text: s.map((w) => w.text).join(' '),
				r: [Math.min(...s.map((w) => w.r[0])), Math.min(...s.map((w) => w.r[1])), Math.max(...s.map((w) => w.r[2])), Math.max(...s.map((w) => w.r[3]))] as Rect,
				base: l.base,
				size: l.size
			};
		});
}

/** Blanks on an open rule: the part of [x0, x1] with free space above it. */
function openRule(ctx: Ctx, r: Rule, x0: number, x1: number, lineH: number, taken: BlankSuggestion[]): BlankSuggestion[] {
	const { body } = ctx;
	const y = r.at;
	const stripTop = y - lineH;
	// Text standing on the line (its bottom within the strip).
	const onLine = ctx.ws.filter((w) => w.r[2] > x0 + 1 && w.r[0] < x1 - 1 && w.r[3] > stripTop + 2 && w.r[1] < y - 0.5 && w.r[3] < y + 0.6 * w.size);
	let a = x0;
	let label = '';
	let conf = 0.75;
	if (onLine.length) {
		// Only one shape is a blank: a one-line label at the very start of the line,
		// the rest of the line free ("Name: ________" drawn as one underline).
		const lines = textLines(onLine);
		if (lines.length !== 1) return [];
		const l = lines[0];
		if (l.r[0] - x0 > Math.max(6, body)) return [];
		const free = x1 - l.r[2];
		if (free < Math.max(36, 0.4 * (x1 - x0))) return [];
		if (wrapped(ctx, l)) return [];
		a = l.r[2] + 2;
		label = l.text;
		conf = /[:#]$/.test(l.text) ? 0.75 : 0.5;
	}
	if (ctx.bars.some((b) => b[0] <= a + 1 && b[2] >= x1 - 1 && b[1] <= y - 2 && b[3] >= y - 2)) return [];
	if (taken.some((t) => t.rect[0] >= a - 2 && t.rect[2] <= x1 + 2 && Math.abs(t.rect[3] - y) < 3)) return [];
	if (taken.some((t) => t.kind === 'text' && t.rect[0] < x1 && t.rect[2] > a && Math.abs(t.rect[3] - y) < 3)) return [];
	const above = ceilingAbove(ctx, a, x1, y - 1, r);
	const top = Math.max(above + 1, y - lineH * 1.6);
	if (y - top < body * 0.8) return [];
	const rect: Rect = [a, top, x1, y];
	const left = label || labelLeft(rect, ctx.ws);
	const lab = left || labelFor(rect, ctx.ws) || labelBelow(rect, ctx.ws);
	if (left && !label) conf += 0.1;
	if (!lab) conf -= 0.35;
	if (r.w > 1.6) conf -= 0.15;
	if (r.pieces >= 6) conf -= 0.05;
	if (x1 - x0 > ctx.width * 0.7 && !left) {
		// A page-wide line in the top or bottom margin: a header or footer rule.
		if (y < ctx.height * 0.12 || y > ctx.height * 0.88) return [];
		conf -= 0.2;
	}
	return [{ kind: 'text', source: 'rule', rect, confidence: conf, label: lab }];
}

/** The line above `l` (same left edge, one line up) runs further right: `l` ends a wrapped paragraph. */
function wrapped(ctx: Ctx, l: TextLine): boolean {
	return ctx.ws.some(
		(w) => w.base < l.base - 0.5 * l.size && w.base > l.base - 1.8 * l.size && w.r[2] > l.r[2] + 2 * l.size && w.r[0] < l.r[2] + 4 * l.size && w.r[2] > l.r[0]
	);
}

/** Bottom of the nearest word or horizontal rule above y overlapping [a, b] by more than 1 pt. */
function ceilingAbove(ctx: Ctx, a: number, b: number, y: number, except?: Rule): number {
	let best = -Infinity;
	for (const w of ctx.ws) if (w.r[3] <= y && w.r[3] > best && Math.min(b, w.r[2]) - Math.max(a, w.r[0]) > 1) best = w.r[3];
	for (const o of ctx.h) if (o !== except && o.at <= y && o.at > best && Math.min(b, o.b) - Math.max(a, o.a) > 1) best = o.at;
	return best;
}

// --- Labels ---------------------------------------------------------------

function overlaps(a: Rect, b: Rect, eps = 0): boolean {
	return a[0] < b[2] - eps && a[2] > b[0] + eps && a[1] < b[3] - eps && a[3] > b[1] + eps;
}

/** Words ending just left of the blank, on its bottom line. */
function labelLeft(r: Rect, ws: Word[]): string {
	let best: Word | null = null;
	for (const w of ws) {
		if (w.r[2] > r[0] + 1 || r[0] - w.r[2] > 3 * w.size) continue;
		if (w.base > r[3] + 0.5 * w.size || w.base < r[3] - 1.6 * w.size) continue;
		if (!best || w.r[2] > best.r[2]) best = w;
	}
	return best ? phrase(best, ws) : '';
}

/** Words starting just right of a checkbox, on its line. */
function labelRight(r: Rect, ws: Word[]): string {
	const cy = (r[1] + r[3]) / 2;
	let best: Word | null = null;
	for (const w of ws) {
		if (w.r[0] < r[2] - 1 || w.r[0] - r[2] > 2 * w.size) continue;
		if (Math.abs((w.r[1] + w.r[3]) / 2 - cy) > 0.6 * w.size) continue;
		if (!best || w.r[0] < best.r[0]) best = w;
	}
	if (!best) return '';
	const b = best;
	const line = ws.filter((o) => Math.abs(o.base - b.base) < 0.3 * b.size && o.r[0] >= b.r[0]).sort((p, q) => p.r[0] - q.r[0]);
	const pick = [line[0]];
	for (let i = 1; i < line.length && pick.length < 6; i++) {
		if (line[i].r[0] - pick[pick.length - 1].r[2] > b.size * 1.5) break;
		pick.push(line[i]);
	}
	return pick
		.map((p) => p.text)
		.join(' ')
		.trim();
}

/** Words just under a line (a caption such as "Signature"). */
function labelBelow(r: Rect, ws: Word[]): string {
	let best: Word | null = null;
	for (const w of ws) {
		if (w.r[1] < r[3] - 1 || w.r[1] - r[3] > 1.2 * w.size) continue;
		if (w.r[0] < r[0] - 2 || w.r[0] > r[2]) continue;
		if (!best || w.r[1] < best.r[1] || (w.r[1] === best.r[1] && w.r[0] < best.r[0])) best = w;
	}
	if (!best) return '';
	const b = best;
	const line = ws.filter((o) => Math.abs(o.base - b.base) < 0.3 * b.size && o.r[0] >= b.r[0] && o.r[0] < r[2]).sort((p, q) => p.r[0] - q.r[0]);
	return line
		.slice(0, 6)
		.map((p) => p.text)
		.join(' ')
		.trim();
}

/** The text closest above a cell, over its middle (a column heading). */
function labelAbove(c: Rect, ws: Word[]): string {
	const cx = (c[0] + c[2]) / 2;
	let best: Word | null = null;
	for (const w of ws) {
		if (w.r[3] > c[1] + 1 || c[1] - w.r[3] > 60) continue;
		if (w.r[0] > cx + 2 || w.r[2] < cx - 2) continue;
		if (!best || w.r[3] > best.r[3]) best = w;
	}
	return best ? best.text.replace(/[.:]+$/, '') : '';
}

/** The nearest words on the same line to the left, else the line above. */
export function labelFor(r: Rect, ws: Word[]): string {
	const left = labelLeft(r, ws);
	if (left) return left;
	let best: Word | null = null;
	let bestD = Infinity;
	for (const w of ws) {
		if (w.r[3] <= r[1] + 2 && w.r[2] > r[0] - 2 && w.r[0] < r[2]) {
			const d = r[1] - w.r[3];
			if (d < bestD && d < 2.5 * w.size) {
				bestD = d;
				best = w;
			}
		}
	}
	return best ? phrase(best, ws) : '';
}

/** The word plus up to five words before it on the same baseline. */
function phrase(w: Word, ws: Word[]): string {
	const line = ws.filter((o) => Math.abs(o.base - w.base) < 0.3 * w.size && o.r[2] <= w.r[2] + 0.5 && w.r[0] - o.r[2] < 200).sort((a, b) => a.r[0] - b.r[0]);
	const pick: Word[] = [w];
	for (let i = line.indexOf(w) - 1; i >= 0 && pick.length < 6; i--) {
		if (pick[0].r[0] - line[i].r[2] > w.size * 1.5) break;
		pick.unshift(line[i]);
	}
	return pick
		.map((p) => p.text)
		.join(' ')
		.replace(/[_.:\s]+$/, '')
		.trim();
}

/**
 * Areas headed "For Official Use Only", "For IRS Use Only", "Do not write in this
 * space": the box around the heading, from the heading down to where the walls on
 * either side of it end. Blanks there are for the office, not the person filling in.
 */
function officeUse(ctx: Ctx): Rect[] {
	const zones: Rect[] = [];
	for (const l of textLines(ctx.ws)) {
		if (!/\buse only\b|\boffice use\b|\bofficial use\b|\bdo not write\b|\binternal use\b/i.test(l.text)) continue;
		const walls = ctx.v.filter((v) => v.a <= l.r[1] + 2 && v.b >= l.r[3]);
		const left = walls.filter((v) => v.at <= l.r[0] + 1).sort((p, q) => q.at - p.at)[0];
		const right = walls.filter((v) => v.at >= l.r[2] - 1).sort((p, q) => p.at - q.at)[0];
		if (!left || !right) continue;
		zones.push([left.at, l.r[1] - 2, right.at, Math.min(left.b, right.b)]);
	}
	return zones;
}

/**
 * Three or more ruled lines stacked one under the other, alone on their rows and
 * unlabelled after the first ("Additional information" boxes): one multi-line blank.
 */
function stacks(xs: BlankSuggestion[]): BlankSuggestion[] {
	const ruled = (s: BlankSuggestion) => s.kind === 'text' && (s.source === 'cell' || s.source === 'rule' || s.source === 'cell-band');
	const alone = (s: BlankSuggestion) => !xs.some((o) => o !== s && o.rect[1] < s.rect[3] - 1 && o.rect[3] > s.rect[1] + 1 && (o.rect[2] <= s.rect[0] + 1 || o.rect[0] >= s.rect[2] - 1));
	const cand = xs.filter((s) => ruled(s) && alone(s)).sort((a, b) => a.rect[1] - b.rect[1]);
	const used = new Set<BlankSuggestion>();
	const merged: BlankSuggestion[] = [];
	for (const s of cand) {
		if (used.has(s)) continue;
		const run = [s];
		for (;;) {
			const last = run[run.length - 1];
			const h = last.rect[3] - last.rect[1];
			const next = cand.find(
				(o) =>
					!used.has(o) &&
					!run.includes(o) &&
					Math.abs(o.rect[0] - s.rect[0]) <= 2 &&
					Math.abs(o.rect[2] - s.rect[2]) <= 2 &&
					o.rect[1] >= last.rect[3] - 2 &&
					o.rect[1] - last.rect[3] <= Math.max(3, 0.5 * h) &&
					!o.label
			);
			if (!next) break;
			run.push(next);
		}
		if (run.length < 3) continue;
		for (const r of run) used.add(r);
		const z = run[run.length - 1];
		merged.push({ kind: 'text', source: 'lines', rect: [s.rect[0], s.rect[1], s.rect[2], z.rect[3]], confidence: 0.5, label: s.label });
	}
	return [...xs.filter((x) => !used.has(x)), ...merged];
}

// --- Helpers --------------------------------------------------------------

/** Drops a suggestion that mostly repeats a more confident one (IoU ≥ 0.5, or one inside the other). */
function dedupe(xs: BlankSuggestion[]): BlankSuggestion[] {
	const sorted = [...xs].sort((a, b) => b.confidence - a.confidence || a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
	const kept: BlankSuggestion[] = [];
	for (const s of sorted) {
		if (kept.some((k) => rectIou(k.rect, s.rect) >= 0.5 || (k.kind === s.kind && (contains(k.rect, s.rect, 1.5) || contains(s.rect, k.rect, 1.5))))) continue;
		kept.push(s);
	}
	return kept;
}

function contains(a: Rect, b: Rect, eps: number): boolean {
	return b[0] >= a[0] - eps && b[1] >= a[1] - eps && b[2] <= a[2] + eps && b[3] <= a[3] + eps;
}

function rectIou(a: Rect, b: Rect): number {
	const ox = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
	const oy = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
	const o = ox * oy;
	const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - o;
	return u > 0 ? o / u : 0;
}

function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)];
}

function round(x: number): number {
	return Math.round(x * 100) / 100;
}

// ---------------------------------------------------------------------------
// Convenience: one page of an open MuPDF document.

export function detectPage(m: Mupdf, doc: MU.Document, pageIndex: number, opts?: DetectOptions): BlankSuggestion[] {
	const page = doc.loadPage(pageIndex);
	try {
		return detectBlanks(collectInk(m, page), opts);
	} finally {
		destroy(page);
	}
}
