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
import { collectInk, detectBlanks, type BlankSuggestion } from '../../src/lib/engine/forms-detect';
import { serveJobs } from '../survey/lib/pool';
import { hasCue, pageWidgets } from './cue';
import { scorePage, type Rect, type Truth } from './match';

export { hasCue };

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
			const truths: Truth[] = [];
			const { kept, neutral } = pageWidgets(page);
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
