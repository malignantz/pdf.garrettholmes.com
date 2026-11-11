/**
 * Child process for `forms:measure run` and `render`: one file per job.
 *
 * For each of the first `maxPages` pages: the true widgets (MuPDF's view of the
 * AcroForm) become the truth, the detector runs on the page contents only (MuPDF's
 * `runPageContents`, so widget appearances never reach it: the "flat" version is the
 * page as drawn without its annotations), and the page's ink is checked for a
 * visible cue at each widget. Nothing is written into the input file; PNGs (render)
 * go to the output folder only.
 */
import fs from 'node:fs';
import path from 'node:path';
import type * as MU from 'mupdf';
import { collectInk, detectBlanks, type BlankSuggestion, type PageInk } from '../../src/lib/engine/forms-detect';
import { serveJobs } from '../survey/lib/pool';
import { scorePage, type Rect, type Truth, type TruthType } from './match';

export interface MeasureJob {
	sha256: string;
	path: string;
	maxPages: number;
	/** Render these 0-based pages with truth and suggestions drawn on them. */
	render?: number[];
	pngDir?: string;
}

export interface PageRecord {
	i: number;
	w: number;
	h: number;
	ms: number;
	truths: Truth[];
	neutral: Rect[];
	suggs: BlankSuggestion[];
	/** Page has a big image (scan) or too many paths: the detector declines. */
	declined: boolean;
}

export interface FileRecord {
	sha256: string;
	path: string;
	pages: PageRecord[];
	pageCount: number;
	error?: string;
	encrypted?: boolean;
}

const HIDDEN = 2 | 32; // Hidden, NoView

function widgetType(w: MU.PDFWidget): TruthType | 'button' | null {
	const t = w.getFieldType();
	if (t === 'text') return 'text';
	if (t === 'checkbox') return 'checkbox';
	if (t === 'radiobutton') return 'radio';
	if (t === 'combobox' || t === 'listbox') return 'choice';
	if (t === 'signature') return 'signature';
	if (t === 'button') return 'button';
	return null;
}

/** Something drawn in the page content marks this widget's spot. */
export function hasCue(ink: PageInk, t: { type: TruthType; rect: Rect }): boolean {
	const r = t.rect;
	const w = r[2] - r[0];
	const h = r[3] - r[1];
	const g = Math.max(3, 0.3 * h);
	// Horizontal ink along the widget's top or bottom covering half its width (pieces add up).
	let cover = 0;
	for (const l of ink.lines) {
		if (l.light > 0.92) continue;
		if (l.dir === 'h') {
			const o = Math.min(l.x1, r[2]) - Math.max(l.x0, r[0]);
			if (o > 0 && l.y0 >= r[1] - g && l.y0 <= r[3] + g) cover += o;
		} else if (t.type === 'checkbox' || t.type === 'radio') {
			const o = Math.min(l.y1, r[3]) - Math.max(l.y0, r[1]);
			if (o >= 0.5 * h && l.x0 >= r[0] - g && l.x0 <= r[2] + g) return true;
		}
	}
	if (cover >= 0.5 * w) return true;
	for (const b of ink.boxes) {
		const ox = Math.min(b.r[2], r[2]) - Math.max(b.r[0], r[0]);
		const oy = Math.min(b.r[3], r[3]) - Math.max(b.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		const bArea = (b.r[2] - b.r[0]) * (b.r[3] - b.r[1]);
		// A box about the widget's size (not a page-wide background).
		if ((ox * oy) / (w * h) >= 0.5 && bArea <= 6 * w * h && (b.stroked || b.light < 0.97)) return true;
	}
	for (const c of ink.circles) {
		const ox = Math.min(c[2], r[2]) - Math.max(c[0], r[0]);
		const oy = Math.min(c[3], r[3]) - Math.max(c[1], r[1]);
		if (ox > 0 && oy > 0) return true;
	}
	for (const gl of ink.glyphs) {
		const ox = Math.min(gl.r[2], r[2]) - Math.max(gl.r[0], r[0]);
		const oy = Math.min(gl.r[3], r[3]) - Math.max(gl.r[1], r[1]);
		if (ox <= 0 || oy <= 0) continue;
		if (gl.ch === '_' || gl.shape) return true;
	}
	return false;
}

async function handle(job: MeasureJob, io: { progress(step: string): void; result(data: FileRecord): void }) {
	const m = (await import('mupdf')) as unknown as typeof MU;
	const rec: FileRecord = { sha256: job.sha256, path: job.path, pages: [], pageCount: 0 };
	let doc: MU.PDFDocument | null = null;
	try {
		io.progress('open');
		const bytes = fs.readFileSync(job.path);
		const d = m.Document.openDocument(bytes, 'application/pdf');
		if (d.needsPassword()) {
			rec.encrypted = true;
			io.result(rec);
			return;
		}
		doc = d as MU.PDFDocument;
		rec.pageCount = doc.countPages();
		const n = Math.min(rec.pageCount, job.maxPages);
		const want = job.render ? job.render.filter((i) => i < rec.pageCount) : [...Array(n).keys()];
		for (const i of want) {
			io.progress(`page ${i}`);
			const page = doc.loadPage(i);
			const [bx, by] = page.getBounds();
			const truths: Truth[] = [];
			const neutral: Rect[] = [];
			const widgets = page.getWidgets();
			const kept: { type: TruthType; rect: Rect }[] = [];
			for (const w of widgets) {
				const b = w.getBounds();
				const rect: Rect = [b[0] - bx, b[1] - by, b[2] - bx, b[3] - by];
				const type = widgetType(w);
				const hidden = (w.getFlags() & HIDDEN) !== 0;
				const tiny = rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1;
				const off = rect[2] < 0 || rect[3] < 0 || rect[0] > page.getBounds()[2] - bx || rect[1] > page.getBounds()[3] - by;
				if (!type || type === 'button' || hidden || tiny || off) {
					if (!tiny && !off) neutral.push(rect);
					continue;
				}
				kept.push({ type, rect });
			}
			const t0 = performance.now();
			const ink = collectInk(m as never, page);
			const suggs = detectBlanks(ink);
			const ms = performance.now() - t0;
			for (const k of kept) truths.push({ ...k, cue: hasCue(ink, k) });
			const declined = ink.bigImages > 0 || ink.paths > 60_000;
			const pr: PageRecord = { i, w: ink.width, h: ink.height, ms: Math.round(ms * 10) / 10, truths, neutral, suggs, declined };
			rec.pages.push(pr);
			if (job.render && job.pngDir) renderOverlay(m, doc, page, pr, path.join(job.pngDir, `${job.sha256.slice(0, 12)}-p${i + 1}.png`));
			(page as unknown as { destroy(): void }).destroy();
		}
	} catch (e) {
		rec.error = e instanceof Error ? e.message : String(e);
	}
	io.result(rec);
}

/**
 * Draws the page without its widgets, then the truth (green), correct suggestions
 * (blue), wrong ones (red: false positive, orange: bad rectangle or type), and misses
 * (magenta dashed look: thicker green), at 1.5× into a PNG.
 */
function renderOverlay(m: typeof MU, doc: MU.PDFDocument, page: MU.PDFPage, pr: PageRecord, file: string) {
	for (const w of page.getWidgets()) page.deleteAnnotation(w);
	const [bx, by] = page.getBounds();
	const score = scorePage(pr.truths, pr.suggs, pr.neutral);
	const box = (r: Rect, color: [number, number, number], width: number) => {
		const a = page.createAnnotation('Square');
		// setRect takes page space (MuPDF applies the inverse page transform itself).
		const q: Rect = [r[0] + bx, r[1] + by, r[2] + bx, r[3] + by];
		a.setRect(q);
		a.setColor(color);
		a.setBorderWidth(width);
		a.update();
	};
	pr.truths.forEach((t, ti) => box(t.rect, score.truth[ti].s >= 0 ? [0, 0.6, 0] : [1, 0, 1], score.truth[ti].s >= 0 ? 0.6 : 1.4));
	pr.suggs.forEach((s, si) => {
		const v = score.sugg[si].verdict;
		box(s.rect, v === 'correct' ? [0, 0.3, 1] : v === 'false-positive' || v === 'duplicate' ? [1, 0, 0] : v === 'neutral' ? [0.5, 0.5, 0.5] : [1, 0.55, 0], 0.8);
	});
	const pix = page.toPixmap(m.Matrix.scale(1.5, 1.5), m.ColorSpace.DeviceRGB, false, true);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, pix.asPNG());
}

serveJobs<MeasureJob, FileRecord>(handle);
