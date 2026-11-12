/**
 * Child process for `hl-text measure` and `render`: one file per job.
 *
 * measure: for each of the first `maxPages` pages, collects the words the way the
 * engine does (Engine.pageText: readRawLines + layoutWords), timing it, then picks
 * seeded random word ranges and builds the highlight rectangles the editor would
 * store (src/lib/editor/text-select.ts, page shown unrotated). Truth is the rendered
 * ink of the selected words' glyphs alone (S) and of every other glyph on the page
 * (O): the page's display list is run through a device that keeps only text, finds
 * each glyph's word by its origin (the same origin structured text reports) and draws
 * the glyphs into two grey pixmaps at SCALE px/pt. Rectangles are scored against S
 * (ink more than 1 pt outside every rectangle = a miss) and O (other ink reaching
 * more than 15% of the line height into a rectangle = a flood).
 *
 * The same single-word ranges are also scored with boxes built from PDF.js text
 * content (each item's width split by character count, ascent/descent from PDF.js's
 * font style), the other candidate text source.
 *
 * render: draws a page region at 3 px/pt with S tinted red, the rectangles outlined
 * blue and PDF.js boxes green, for looking at failures. Nothing is written into the
 * input file.
 */
import fs from 'node:fs';
import path from 'node:path';
import type * as MU from 'mupdf';
import { mupdf } from '../../src/lib/engine/mupdf';
import { layoutWordsDetailed, readRawLines, MARGIN_EM, type RawLine } from '../../src/lib/engine/page-text';
import { selectionRects, shownLayout, type TextLayout } from '../../src/lib/editor/text-select';
import type { PageText, StampBox } from '../../src/lib/core/types';
import { serveJobs } from '../survey/lib/pool';

export const SCALE = 4;

export interface HlJob {
	sha256: string;
	path: string;
	maxPages: number;
	seed: number;
	rangesPerPage: number;
	/** Render: 0-based page → ranges ([a, b] word indices) to draw. */
	render?: Record<number, [number, number][]>;
	pngDir?: string;
}

export interface RangeResult {
	a: number;
	b: number;
	words: number;
	rects: number;
	/** Selected ink pixels (coverage > 1/2). 0: invisible text (OCR) or glyphs without ink. */
	ink: number;
	/** Largest distance of selected ink outside every rectangle, pt. */
	missPt: number;
	/** Selected ink pixels more than 1 pt outside every rectangle. */
	missPx: number;
	/** Deepest reach of other ink into a rectangle, as a share of the line height; and which way. */
	flood: number;
	floodDir: 'across' | 'along' | null;
	/** Line height (rectangle size across the line), pt. */
	lineH: number;
	/** Font size of the first word, pt. */
	em: number;
	/** Selected glyphs not found by origin (not drawn). */
	unmatched: number;
	/** Single words: the PDF.js box scored the same way (null: no PDF.js word matched). */
	pdfjs?: { missPt: number; missPx: number; flood: number; dx0: number; dx1: number } | null;
	/** Single words: horizontal ink extent vs the word's box without its margin (pt). */
	edge?: { dx0: number; dx1: number };
}

export interface PageResult {
	i: number;
	w: number;
	h: number;
	ms: number;
	/** Resident memory growth while collecting (kB; 0 when it did not grow). */
	rssKB: number;
	/** Wasm heap size after collecting (MB). */
	heapMB: number;
	words: number;
	skipped: number;
	chars: number;
	lines: number;
	invisibleWords: number;
	ranges: RangeResult[];
	error?: string;
}

export interface HlResult {
	sha256: string;
	pageCount: number;
	pages: PageResult[];
	error?: string;
	encrypted?: boolean;
}

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

function hashSeed(sha: string, seed: number, page: number) {
	return (parseInt(sha.slice(0, 8), 16) ^ (seed * 7919) ^ (page * 104729)) >>> 0;
}

const destroy = (o: unknown) => {
	try {
		(o as { destroy?: () => void })?.destroy?.();
	} catch {
		// gone
	}
};

type Mat = [number, number, number, number, number, number];
const apply = (m: Mat, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

/**
 * Words at every glyph origin (0.05 pt grid): text drawn twice (shadows, fake bold)
 * puts two words on one origin. [-2]: a character that is not offered; []: none.
 */
function originIndex(raw: RawLine[], wordChars: [number, number][][]) {
	const map = new Map<string, number[]>();
	const key = (x: number, y: number) => `${Math.round(x * 20)},${Math.round(y * 20)}`;
	for (const l of raw) for (const ch of l.chars) map.set(key(ch.origin[0], ch.origin[1]), [-2]);
	const seen = new Set<string>();
	wordChars.forEach((cs, wi) => {
		for (const [li, ci] of cs) {
			const ch = raw[li].chars[ci];
			const k = key(ch.origin[0], ch.origin[1]);
			if (!seen.has(k)) {
				seen.add(k);
				map.set(k, []);
			}
			map.get(k)!.push(wi);
		}
	});
	return (x: number, y: number): number[] => {
		const gx = Math.round(x * 20);
		const gy = Math.round(y * 20);
		for (let dx = -1; dx <= 1; dx++)
			for (let dy = -1; dy <= 1; dy++) {
				const v = map.get(`${gx + dx},${gy + dy}`);
				if (v !== undefined) return v;
			}
		return [];
	};
}

interface Region {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

interface Masks {
	region: Region;
	w: number;
	h: number;
	s: Uint8Array;
	o: Uint8Array;
	unmatched: number;
	/** Words whose glyphs were drawn as invisible text. */
	invisible: Set<number>;
}

/**
 * Selected ink (S) and other ink (O) of a page region, at SCALE px/pt: the display list
 * run through a device that draws only glyphs, sorted by word.
 */
function inkMasks(m: typeof MU, dl: MU.DisplayList, region: Region, selected: (w: number) => boolean, wordOf: (x: number, y: number) => number[]): Masks {
	const bbox = [Math.floor(region.x0 * SCALE), Math.floor(region.y0 * SCALE), Math.ceil(region.x1 * SCALE), Math.ceil(region.y1 * SCALE)] as [number, number, number, number];
	const gray = m.ColorSpace.DeviceGray;
	const pixS = new m.Pixmap(gray, bbox, false);
	const pixO = new m.Pixmap(gray, bbox, false);
	pixS.clear(255);
	pixO.clear(255);
	const devS = new m.DrawDevice(m.Matrix.scale(SCALE, SCALE), pixS);
	const devO = new m.DrawDevice(m.Matrix.scale(SCALE, SCALE), pixO);
	let unmatched = 0;
	const invisible = new Set<number>();
	const draw = (text: MU.Text, ctm: Mat, visible: boolean) => {
		const tS = new m.Text();
		const tO = new m.Text();
		let nS = 0;
		let nO = 0;
		text.walk({
			showGlyph(font, trm, glyph, unicode, wmode) {
				const [x, y] = apply(ctm, trm[4], trm[5]);
				const ws = wordOf(x, y);
				if (!visible) {
					for (const w of ws) if (w >= 0) invisible.add(w);
					return;
				}
				if (ws.some((w) => w >= 0 && selected(w))) {
					tS.showGlyph(font, trm, glyph, unicode, wmode);
					nS++;
				} else if (ws.length === 0) {
					// A glyph structured text did not list (MuPDF drops a glyph drawn again on
					// top of itself, as fake bold does): neither ours nor a neighbour's.
					if (unicode > 32) unmatched++;
				} else {
					tO.showGlyph(font, trm, glyph, unicode, wmode);
					nO++;
				}
			}
		});
		if (nS) devS.fillText(tS, ctm, gray, [0], 1);
		if (nO) devO.fillText(tO, ctm, gray, [0], 1);
		destroy(tS);
		destroy(tO);
	};
	const dev = new m.Device({
		fillText(text, ctm) {
			draw(text, ctm as Mat, true);
		},
		strokeText(text, _s, ctm) {
			draw(text, ctm as Mat, true);
		},
		ignoreText(text, ctm) {
			draw(text, ctm as Mat, false);
		},
		fillShade(shade) {
			// mupdf.js wraps a borrowed shade (see src/lib/engine/mupdf.ts disown).
			const ctor = (shade as unknown as { constructor?: { _finalizer?: FinalizationRegistry<unknown> } }).constructor;
			ctor?._finalizer?.unregister(shade as unknown as object);
		}
	});
	try {
		dl.run(dev, m.Matrix.identity);
	} finally {
		dev.close();
		devS.close();
		devO.close();
		destroy(dev);
		destroy(devS);
		destroy(devO);
	}
	const w = pixS.getWidth();
	const h = pixS.getHeight();
	const s = new Uint8Array(pixS.getPixels());
	const o = new Uint8Array(pixO.getPixels());
	destroy(pixS);
	destroy(pixO);
	return { region: { x0: bbox[0] / SCALE, y0: bbox[1] / SCALE, x1: bbox[2] / SCALE, y1: bbox[3] / SCALE }, w, h, s, o, unmatched, invisible };
}

interface PtRect {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	across: boolean;
}

/** Score rectangles (page points) against the masks. */
function score(mk: Masks, rects: PtRect[]) {
	let ink = 0;
	let missPx = 0;
	let missPt = 0;
	let flood = 0;
	let floodDir: 'across' | 'along' | null = null;
	const k = SCALE;
	for (let py = 0; py < mk.h; py++) {
		for (let px = 0; px < mk.w; px++) {
			const i = py * mk.w + px;
			const x = mk.region.x0 + (px + 0.5) / k;
			const y = mk.region.y0 + (py + 0.5) / k;
			if (mk.s[i] < 128) {
				ink++;
				let d = Infinity;
				for (const r of rects) {
					const dx = Math.max(r.x0 - x, 0, x - r.x1);
					const dy = Math.max(r.y0 - y, 0, y - r.y1);
					d = Math.min(d, Math.hypot(dx, dy));
				}
				if (d > missPt) missPt = d;
				if (d > 1) missPx++;
			}
			if (mk.o[i] < 128 && mk.s[i] >= 128) {
				for (const r of rects) {
					if (x < r.x0 || x > r.x1 || y < r.y0 || y > r.y1) continue;
					const lineH = r.across ? r.y1 - r.y0 : r.x1 - r.x0;
					const dAcross = r.across ? Math.min(y - r.y0, r.y1 - y) : Math.min(x - r.x0, r.x1 - x);
					const dAlong = r.across ? Math.min(x - r.x0, r.x1 - x) : Math.min(y - r.y0, r.y1 - y);
					const depth = Math.min(dAcross, dAlong) / lineH;
					if (depth > flood) {
						flood = depth;
						floodDir = dAcross <= dAlong ? 'across' : 'along';
					}
				}
			}
		}
	}
	return { ink, missPx, missPt, flood, floodDir };
}

// ---------------------------------------------------------------- PDF.js word boxes

interface PjWord {
	text: string;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
	em: number;
}

let pdfjsP: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
function pdfjs() {
	pdfjsP ??= (async () => {
		await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
		return import('pdfjs-dist/legacy/build/pdf.mjs');
	})();
	return pdfjsP;
}

/**
 * Words from PDF.js text content as a text layer places them: each item's run split
 * at spaces, positions by character count along the item's width, height from the
 * font's ascent and descent; plus the same margin along the line as ours.
 */
async function pdfjsWords(doc: Awaited<ReturnType<Awaited<ReturnType<typeof pdfjs>>['getDocument']>['promise']>, index: number): Promise<PjWord[]> {
	const page = await doc.getPage(index + 1);
	const vp = page.getViewport({ scale: 1 });
	const tc = await page.getTextContent();
	const out: PjWord[] = [];
	for (const it of tc.items) {
		if (!('str' in it) || !it.str) continue;
		const [a, b, c, d, e, f] = it.transform as number[];
		const em = Math.hypot(c, d) || Math.hypot(a, b);
		if (!(em > 0)) continue;
		const style = tc.styles[it.fontName] ?? { ascent: 0.8, descent: -0.2 };
		const asc = style.ascent ?? 0.8;
		const desc = style.descent ?? -0.2;
		const len = it.str.length;
		const ux = a / Math.hypot(a, b);
		const uy = b / Math.hypot(a, b);
		const nx = c / Math.hypot(c, d);
		const ny = d / Math.hypot(c, d);
		const re = /\S+/g;
		let mm: RegExpExecArray | null;
		while ((mm = re.exec(it.str))) {
			const s0 = (it.width * mm.index) / len - MARGIN_EM * em;
			const s1 = (it.width * (mm.index + mm[0].length)) / len + MARGIN_EM * em;
			const pts = [
				[s0, desc * em],
				[s1, desc * em],
				[s0, asc * em],
				[s1, asc * em]
			].map(([s, t]) => vp.convertToViewportPoint(e + s * ux + t * nx, f + s * uy + t * ny));
			const xs = pts.map((p) => p[0]);
			const ys = pts.map((p) => p[1]);
			out.push({ text: mm[0], x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), em });
		}
	}
	page.cleanup();
	return out;
}

// ---------------------------------------------------------------- the job

const toPt = (b: StampBox, W: number, H: number, across: boolean): PtRect => ({ x0: b.x * W, y0: b.y * H, x1: (b.x + b.w) * W, y1: (b.y + b.h) * H, across });

async function measure(job: HlJob, io: { progress(step: string): void; result(data: HlResult): void }) {
	const m = (await mupdf()) as unknown as typeof MU;
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	const res: HlResult = { sha256: job.sha256, pageCount: 0, pages: [] };
	let doc: MU.Document;
	try {
		doc = m.Document.openDocument(bytes, 'application/pdf');
	} catch (e) {
		res.error = String(e);
		io.result(res);
		return;
	}
	if (doc.needsPassword()) {
		res.encrypted = true;
		io.result(res);
		return;
	}
	res.pageCount = doc.countPages();
	const pj = await pdfjs();
	let pjDoc: Awaited<ReturnType<typeof pj.getDocument>['promise']> | null = null;
	const pjTask = pj.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 });
	try {
		pjDoc = await pjTask.promise;
	} catch {
		pjDoc = null;
	}
	const n = Math.min(job.maxPages, res.pageCount);
	for (let i = 0; i < n; i++) {
		io.progress(`page ${i + 1}`);
		const pr: PageResult = { i, w: 0, h: 0, ms: 0, rssKB: 0, heapMB: 0, words: 0, skipped: 0, chars: 0, lines: 0, invisibleWords: 0, ranges: [] };
		let page: MU.PDFPage | null = null;
		let dl: MU.DisplayList | null = null;
		try {
			page = doc.loadPage(i) as MU.PDFPage;
			const [x0, y0, x1, y1] = page.getBounds();
			const W = x1 - x0;
			const H = y1 - y0;
			pr.w = W;
			pr.h = H;
			// What Engine.pageText does (pageTextOf), timed.
			const rss0 = process.memoryUsage().rss;
			const t0 = performance.now();
			const raw = readRawLines(page);
			const lay = layoutWordsDetailed(raw, W, H);
			pr.ms = performance.now() - t0;
			pr.rssKB = Math.max(0, Math.round((process.memoryUsage().rss - rss0) / 1024));
			pr.heapMB = Math.round(((m as unknown as { libmupdf?: { HEAPU8?: Uint8Array } }).libmupdf?.HEAPU8?.length ?? 0) / 1048576);
			const text: PageText = { words: lay.words, skipped: lay.skipped };
			pr.words = text.words.length;
			pr.skipped = text.skipped;
			pr.chars = raw.reduce((k, l) => k + l.chars.length, 0);
			if (!text.words.length) {
				pr.lines = 0;
				res.pages.push(pr);
				continue;
			}
			const layout: TextLayout = shownLayout(text, 0, W / H);
			pr.lines = layout.lines.length;
			const wordOf = originIndex(raw, lay.chars);
			dl = page.toDisplayList(false);
			const pjw = pjDoc ? await pdfjsWords(pjDoc, i).catch(() => [] as PjWord[]) : [];
			const rnd = prng(hashSeed(job.sha256, job.seed, i));
			const N = text.words.length;
			const across = (wi: number) => layout.lines.find((l) => l.first <= wi && wi <= l.last)?.across ?? true;
			const ranges: [number, number][] = job.render?.[i] ?? [];
			if (!job.render) {
				for (let r = 0; r < job.rangesPerPage; r++) {
					const u = rnd();
					const len = u < 0.3 ? 1 : u < 0.7 ? 2 + Math.floor(rnd() * 5) : 7 + Math.floor(rnd() * 34);
					const a = Math.floor(rnd() * N);
					ranges.push([a, Math.min(N - 1, a + len - 1)]);
				}
			}
			const invisible = new Set<number>();
			for (const [a, b] of ranges) {
				const rects = selectionRects(layout, a, b);
				const ptRects = rects.map((r) => toPt(r, W, H, across(a)));
				// Region: the rectangles and the selected glyphs' ink boxes, plus room around.
				let rx0 = Infinity;
				let ry0 = Infinity;
				let rx1 = -Infinity;
				let ry1 = -Infinity;
				const grow = (x: number, y: number) => {
					rx0 = Math.min(rx0, x);
					ry0 = Math.min(ry0, y);
					rx1 = Math.max(rx1, x);
					ry1 = Math.max(ry1, y);
				};
				for (const r of ptRects) {
					grow(r.x0, r.y0);
					grow(r.x1, r.y1);
				}
				for (let wi = a; wi <= b; wi++)
					for (const [li, ci] of lay.chars[wi]) {
						const q = raw[li].chars[ci].ink ?? raw[li].chars[ci].quad;
						for (let k = 0; k < 8; k += 2) grow(q[k], q[k + 1]);
					}
				const pad = 8;
				const region = { x0: Math.max(0, rx0 - pad), y0: Math.max(0, ry0 - pad), x1: Math.min(W, rx1 + pad), y1: Math.min(H, ry1 + pad) };
				if (!(region.x1 > region.x0 && region.y1 > region.y0)) continue;
				const mk = inkMasks(m, dl, region, (w) => w >= a && w <= b, wordOf);
				for (const w of mk.invisible) invisible.add(w);
				const sc = score(mk, ptRects);
				const firstChar = raw[lay.chars[a][0][0]].chars[lay.chars[a][0][1]];
				const rr: RangeResult = {
					a,
					b,
					words: b - a + 1,
					rects: rects.length,
					ink: sc.ink,
					missPt: round(sc.missPt),
					missPx: sc.missPx,
					flood: round(sc.flood),
					floodDir: sc.floodDir,
					lineH: round(ptRects[0] ? (ptRects[0].across ? ptRects[0].y1 - ptRects[0].y0 : ptRects[0].x1 - ptRects[0].x0) : 0),
					em: round(firstChar.size),
					unmatched: mk.unmatched
				};
				if (a === b && sc.ink > 0) {
					// Ink extent along the line vs the word's box without its margin.
					const ink = inkBox(mk, mk.s);
					const r0 = ptRects[0];
					const m0 = MARGIN_EM * firstChar.size;
					if (ink && r0?.across) rr.edge = { dx0: round(ink.x0 - (r0.x0 + m0)), dx1: round(ink.x1 - (r0.x1 - m0)) };
					// The PDF.js word with the same text nearest to ours.
					const cx = (ptRects[0].x0 + ptRects[0].x1) / 2;
					const cy = (ptRects[0].y0 + ptRects[0].y1) / 2;
					let best: PjWord | null = null;
					let bd = Infinity;
					for (const p of pjw) {
						if (p.text !== text.words[a].text) continue;
						const d = Math.hypot((p.x0 + p.x1) / 2 - cx, (p.y0 + p.y1) / 2 - cy);
						if (d < bd) {
							bd = d;
							best = p;
						}
					}
					if (best && bd < 3 * firstChar.size) {
						const ps = score(mk, [{ ...best, across: true }]);
						rr.pdfjs = {
							missPt: round(ps.missPt),
							missPx: ps.missPx,
							flood: round(ps.flood),
							dx0: ink ? round(ink.x0 - (best.x0 + MARGIN_EM * best.em)) : 0,
							dx1: ink ? round(ink.x1 - (best.x1 - MARGIN_EM * best.em)) : 0
						};
					} else rr.pdfjs = null;
				}
				pr.ranges.push(rr);
				if (job.render && job.pngDir) renderRegion(m, page, region, ptRects, mk, job, i, a, b, pjw);
			}
			pr.invisibleWords = invisible.size;
		} catch (e) {
			pr.error = e instanceof Error ? e.message : String(e);
		} finally {
			destroy(dl);
			destroy(page);
		}
		res.pages.push(pr);
	}
	await pjTask.destroy().catch(() => undefined);
	destroy(doc);
	io.result(res);
}

const round = (v: number) => Math.round(v * 100) / 100;

function inkBox(mk: Masks, px: Uint8Array) {
	let x0 = Infinity;
	let y0 = Infinity;
	let x1 = -Infinity;
	let y1 = -Infinity;
	for (let y = 0; y < mk.h; y++)
		for (let x = 0; x < mk.w; x++)
			if (px[y * mk.w + x] < 128) {
				x0 = Math.min(x0, x);
				x1 = Math.max(x1, x + 1);
				y0 = Math.min(y0, y);
				y1 = Math.max(y1, y + 1);
			}
	if (x0 === Infinity) return null;
	return { x0: mk.region.x0 + x0 / SCALE, x1: mk.region.x0 + x1 / SCALE, y0: mk.region.y0 + y0 / SCALE, y1: mk.region.y0 + y1 / SCALE };
}

/** PNG of the region at SCALE: the page, selected ink tinted red, rectangles blue, PDF.js boxes of the selected words green. */
function renderRegion(m: typeof MU, page: MU.PDFPage, region: Region, rects: PtRect[], mk: Masks, job: HlJob, i: number, a: number, b: number, pjw: PjWord[]) {
	const pix = page.toPixmap(m.Matrix.scale(SCALE, SCALE), m.ColorSpace.DeviceRGB, false, false);
	const W = pix.getWidth();
	const H = pix.getHeight();
	const px = pix.getPixels();
	const set = (x: number, y: number, c: [number, number, number]) => {
		if (x < 0 || y < 0 || x >= W || y >= H) return;
		const o = (y * W + x) * 3;
		px[o] = c[0];
		px[o + 1] = c[1];
		px[o + 2] = c[2];
	};
	const ox = Math.round(mk.region.x0 * SCALE);
	const oy = Math.round(mk.region.y0 * SCALE);
	for (let y = 0; y < mk.h; y++)
		for (let x = 0; x < mk.w; x++) {
			if (mk.s[y * mk.w + x] < 128) set(ox + x, oy + y, [220, 30, 30]);
			else if (mk.o[y * mk.w + x] < 128) {
				// Other ink inside a rectangle (a flood): orange.
				const X = mk.region.x0 + (x + 0.5) / SCALE;
				const Y = mk.region.y0 + (y + 0.5) / SCALE;
				if (rects.some((r) => X >= r.x0 && X <= r.x1 && Y >= r.y0 && Y <= r.y1)) set(ox + x, oy + y, [255, 140, 0]);
			}
		}
	const outline = (r: { x0: number; y0: number; x1: number; y1: number }, c: [number, number, number]) => {
		const X0 = Math.round(r.x0 * SCALE);
		const X1 = Math.round(r.x1 * SCALE);
		const Y0 = Math.round(r.y0 * SCALE);
		const Y1 = Math.round(r.y1 * SCALE);
		for (let x = X0; x <= X1; x++) {
			set(x, Y0, c);
			set(x, Y1, c);
		}
		for (let y = Y0; y <= Y1; y++) {
			set(X0, y, c);
			set(X1, y, c);
		}
	};
	for (const r of rects) outline(r, [30, 80, 230]);
	if (a === b) for (const p of pjw) if (p.x1 > region.x0 && p.x0 < region.x1 && p.y1 > region.y0 && p.y0 < region.y1) outline(p, [20, 160, 60]);
	// Crop to the region (plus a little) by re-encoding a sub-pixmap.
	const cx0 = Math.max(0, Math.floor((region.x0 - 20) * SCALE));
	const cy0 = Math.max(0, Math.floor((region.y0 - 20) * SCALE));
	const cx1 = Math.min(W, Math.ceil((region.x1 + 20) * SCALE));
	const cy1 = Math.min(H, Math.ceil((region.y1 + 20) * SCALE));
	const sub = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, cx1 - cx0, cy1 - cy0], false);
	const sp = sub.getPixels();
	for (let y = cy0; y < cy1; y++) sp.set(px.subarray((y * W + cx0) * 3, (y * W + cx1) * 3), ((y - cy0) * (cx1 - cx0)) * 3);
	fs.mkdirSync(job.pngDir!, { recursive: true });
	fs.writeFileSync(path.join(job.pngDir!, `${job.sha256.slice(0, 12)}-p${i + 1}-${a}-${b}.png`), sub.asPNG());
	destroy(sub);
	destroy(pix);
}

serveJobs<HlJob, HlResult>(measure);
