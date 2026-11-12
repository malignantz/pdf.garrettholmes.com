/**
 * Child process for `forms:snap ink` and `render`: one file per job.
 *
 * ink: for each of the first `maxPages` pages, the true widgets (see
 * ../forms-detect/cue.ts) and the page's ink (`collectInk`: page contents only, so
 * widget appearances never reach it) are written to `<inkDir>/<sha256>.json.gz`.
 * The snap measurement then runs on that cache without MuPDF.
 *
 * render: draws pages without their widgets, with the truth (green), the tap points
 * (dots) and the snapped rectangles (blue good, orange bad rectangle, red wrong
 * target) at 1.5× into PNGs. Nothing is written into the input file.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type * as MU from 'mupdf';
import { collectInk, type PageInk } from '../../src/lib/engine/forms-detect';
import { serveJobs } from '../survey/lib/pool';
import { hasCue, pageWidgets } from '../forms-detect/cue';
import type { Rect, Truth } from '../forms-detect/match';

export interface DrawMark {
	/** A rectangle (4 numbers) or a tap point (2 numbers). */
	r: number[];
	color: [number, number, number];
	width: number;
}

export interface SnapJob {
	sha256: string;
	path: string;
	maxPages: number;
	inkDir?: string;
	/** Render: 0-based page → marks to draw. */
	render?: Record<number, DrawMark[]>;
	pngDir?: string;
}

export interface InkPage {
	i: number;
	w: number;
	h: number;
	/** Time to collect the ink (MuPDF), ms. */
	collectMs: number;
	truths: Truth[];
	neutral: Rect[];
	declined: boolean;
	ink: PageInk;
}

export interface InkFile {
	sha256: string;
	pageCount: number;
	pages: InkPage[];
	error?: string;
	encrypted?: boolean;
}

/** Summary line for the parent (the pages themselves go to the cache file). */
export interface InkSummary {
	sha256: string;
	pages: number;
	widgets: number;
	error?: string;
}

const r2 = (x: number) => Math.round(x * 100) / 100;

/** Smaller cache: fonts are not needed after collection, numbers to 0.01 pt. */
function compact(ink: PageInk): PageInk {
	return {
		...ink,
		glyphs: ink.glyphs.map((g) => ({ ...g, font: '', size: r2(g.size), base: r2(g.base), r: g.r.map(r2) as Rect, light: r2(g.light), ...(g.shape ? { shape: { kind: g.shape.kind, r: g.shape.r.map(r2) as Rect } } : {}) })),
		lines: ink.lines.map((l) => ({ ...l, x0: r2(l.x0), y0: r2(l.y0), x1: r2(l.x1), y1: r2(l.y1), w: r2(l.w), light: r2(l.light) })),
		boxes: ink.boxes.map((b) => ({ ...b, r: b.r.map(r2) as Rect, light: r2(b.light) })),
		circles: ink.circles.map((c) => c.map(r2) as Rect)
	};
}

async function handle(job: SnapJob, io: { progress(step: string): void; result(data: InkSummary): void }) {
	const m = (await import('mupdf')) as unknown as typeof MU;
	const rec: InkFile = { sha256: job.sha256, pageCount: 0, pages: [] };
	let doc: MU.PDFDocument | null = null;
	try {
		io.progress('open');
		const d = m.Document.openDocument(fs.readFileSync(job.path), 'application/pdf');
		if (d.needsPassword()) {
			rec.encrypted = true;
			rec.error = 'password';
		} else {
			doc = d as MU.PDFDocument;
			rec.pageCount = doc.countPages();
			if (job.render) {
				for (const [k, marks] of Object.entries(job.render)) {
					const i = Number(k);
					if (i >= rec.pageCount) continue;
					io.progress(`render ${i}`);
					renderMarks(m, doc.loadPage(i), marks, path.join(job.pngDir!, `${job.sha256.slice(0, 12)}-p${i + 1}.png`));
				}
				io.result({ sha256: job.sha256, pages: 0, widgets: 0 });
				return;
			}
			const n = Math.min(rec.pageCount, job.maxPages);
			for (let i = 0; i < n; i++) {
				io.progress(`page ${i}`);
				const page = doc.loadPage(i);
				const { kept, neutral } = pageWidgets(page);
				const t0 = performance.now();
				const ink = collectInk(m as never, page);
				const collectMs = Math.round((performance.now() - t0) * 10) / 10;
				const truths: Truth[] = kept.map((k) => ({ ...k, cue: hasCue(ink, k) }));
				const declined = ink.bigImages > 0 || ink.paths > 60_000;
				rec.pages.push({ i, w: ink.width, h: ink.height, collectMs, truths, neutral, declined, ink: declined ? { ...ink, glyphs: [], lines: [], boxes: [], circles: [] } : compact(ink) });
				(page as unknown as { destroy(): void }).destroy();
			}
		}
	} catch (e) {
		rec.error = e instanceof Error ? e.message : String(e);
	}
	if (job.inkDir) fs.writeFileSync(path.join(job.inkDir, `${job.sha256}.json.gz`), zlib.gzipSync(JSON.stringify(rec)));
	io.result({ sha256: job.sha256, pages: rec.pages.length, widgets: rec.pages.reduce((s, p) => s + p.truths.length, 0), error: rec.error });
}

function renderMarks(m: typeof MU, page: MU.PDFPage, marks: DrawMark[], file: string) {
	for (const w of page.getWidgets()) page.deleteAnnotation(w);
	const [bx, by] = page.getBounds();
	for (const mk of marks) {
		const r = mk.r.length === 2 ? [mk.r[0] - 1.2, mk.r[1] - 1.2, mk.r[0] + 1.2, mk.r[1] + 1.2] : mk.r;
		const a = page.createAnnotation(mk.r.length === 2 ? 'Circle' : 'Square');
		a.setRect([r[0] + bx, r[1] + by, r[2] + bx, r[3] + by]);
		a.setColor(mk.color);
		if (mk.r.length === 2) a.setInteriorColor(mk.color);
		a.setBorderWidth(mk.width);
		a.update();
	}
	const pix = page.toPixmap(m.Matrix.scale(1.5, 1.5), m.ColorSpace.DeviceRGB, false, true);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, pix.asPNG());
}

serveJobs<SnapJob, InkSummary>(handle);
