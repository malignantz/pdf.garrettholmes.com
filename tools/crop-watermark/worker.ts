/**
 * Child process for `tools/crop-watermark/measure.ts`: one survey file per job.
 *
 *  - base: the app's default export (Optimize and the print-size cap on), all pages.
 *  - cw: the same with a watermark ("CONFIDENTIAL", diagonal, light, grey) and a crop of
 *    10% off every edge on every page. Verified by the engine (its 'crop' and 'watermark'
 *    checks among all the others) or refused; the refusal's code and message are kept.
 *  - Independent checks of a cw export, with MuPDF (another reader than the engine's
 *    PDF.js checks): every page (first 60) is 80% × 80% of the base export's page as
 *    displayed (within 0.6 pt); the watermark's letters are in the page's text (MuPDF
 *    structured text, first 60 pages); renders of the first 3 pages (40 dpi) equal the
 *    middle 80% × 80% of the base export's renders (each pixel within 60 of a pixel at
 *    most one away; the light watermark changes a pixel by less than that): at most 3% of
 *    pixels differ, and less than a third as many as against the part 5% off.
 */
import fs from 'node:fs';
import type { ExportOptions, PageRef, Source, StampBox } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { debugNotes, engine } from '../survey/lib/engine';
import { serveJobs } from '../survey/lib/pool';
import { openDoc, renderPage, renderScale, type Raster } from '../survey/lib/raster';

export interface CwJob {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: 'tune' | 'held';
}

export interface CwStep {
	status: 'ok' | 'error';
	code?: string;
	message?: string;
	ms?: number;
	bytes?: number;
	checks?: string[];
	tags?: string;
	warnings?: number;
}

export interface CwResult {
	sha256: string;
	path: string;
	source: string;
	producer: string;
	half: CwJob['half'];
	pages?: number;
	/** First page as displayed, in points. */
	firstPage?: { width: number; height: number };
	size?: number;
	open: 'ok' | 'error';
	openMessage?: string;
	base?: CwStep;
	cw?: CwStep;
	/** Independent checks of the cw export: 'same' or what differs. */
	sizes?: string;
	text?: string;
	pixels?: string;
	ms: number;
}

export const CROP: StampBox = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
const WM = { text: 'CONFIDENTIAL', look: 'diagonal', strength: 'light', color: 'grey' } as const;
const opts: ExportOptions = { filename: 'out.pdf', compress: true, stripMetadata: false, printCap: true };
const CHECK_PAGES = 60;
const PIXEL_PAGES = 3;

async function run(src: Source, pages: PageRef[], options: ExportOptions): Promise<{ r: CwStep; bytes?: Uint8Array }> {
	debugNotes.length = 0;
	const t0 = Date.now();
	try {
		const res = await engine().exportPlan({ pages, options }, [src], []);
		return {
			r: { status: 'ok', ms: Date.now() - t0, bytes: res.bytes.length, checks: res.checks.map((c) => c.name), tags: res.tags ? (res.tags.kept ? 'kept' : res.tags.reason) : undefined, warnings: res.warnings.length },
			bytes: res.bytes
		};
	} catch (e) {
		const checks = e instanceof EngineError ? (e as { checks?: { name: string; ok: boolean; detail: string }[] }).checks : undefined;
		const failed = checks?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join(' | ');
		return { r: { status: 'error', code: e instanceof EngineError ? e.code : 'exception', message: `${e instanceof Error ? e.message : String(e)}${failed ? ` [${failed}]` : ''}`.slice(0, 400), ms: Date.now() - t0 } };
	}
}

/** Share of pixels of `a` (the cropped render) more than 60 away from every pixel near the same place in `b`'s middle part. */
function partDiff(a: Raster, b: Raster, shift = 0): number {
	let bad = 0;
	let n = 0;
	const at = (r: Raster, x: number, y: number) => {
		const xi = Math.min(r.w - 1, Math.max(0, Math.floor(x)));
		const yi = Math.min(r.h - 1, Math.max(0, Math.floor(y)));
		const o = (yi * r.w + xi) * 3;
		return (r.px[o] + r.px[o + 1] + r.px[o + 2]) / 3;
	};
	for (let y = 1; y < a.h - 1; y++) {
		for (let x = 1; x < a.w - 1; x++) {
			const v = at(a, x, y);
			const bx = (CROP.x + shift + ((x + 0.5) / a.w) * CROP.w) * b.w;
			const by = (CROP.y - shift + ((y + 0.5) / a.h) * CROP.h) * b.h;
			let near = false;
			for (let dy = -1; dy <= 1 && !near; dy++) for (let dx = -1; dx <= 1 && !near; dx++) if (Math.abs(v - at(b, bx + dx, by + dy)) <= 60) near = true;
			n++;
			if (!near) bad++;
		}
	}
	return n ? bad / n : 0;
}

async function independent(base: Uint8Array, cw: Uint8Array, r: CwResult) {
	const m = await mupdf();
	const a = openDoc(m, base);
	const b = openDoc(m, cw);
	try {
		const n = Math.min(a.countPages(), CHECK_PAGES);
		const sizeBad: number[] = [];
		const textBad: number[] = [];
		for (let i = 0; i < n; i++) {
			const pa = a.loadPage(i);
			const pb = b.loadPage(i);
			try {
				const [ax0, ay0, ax1, ay1] = pa.getBounds();
				const [bx0, by0, bx1, by1] = pb.getBounds();
				if (Math.abs(bx1 - bx0 - 0.8 * (ax1 - ax0)) > 0.6 || Math.abs(by1 - by0 - 0.8 * (ay1 - ay0)) > 0.6) sizeBad.push(i + 1);
				const st = pb.toStructuredText('preserve-whitespace');
				try {
					if (!st.asText().replace(/\s+/g, '').includes(WM.text)) textBad.push(i + 1);
				} finally {
					st.destroy();
				}
			} finally {
				pa.destroy();
				pb.destroy();
			}
		}
		r.sizes = sizeBad.length ? `wrong size on pages ${sizeBad.slice(0, 5).join(', ')}` : 'same';
		r.text = textBad.length ? `watermark not read on pages ${textBad.slice(0, 5).join(', ')}` : 'same';
		const pix: string[] = [];
		for (let i = 0; i < Math.min(a.countPages(), PIXEL_PAGES); i++) {
			const pa = a.loadPage(i);
			const [x0, y0, x1, y1] = pa.getBounds();
			pa.destroy();
			const scale = renderScale(x1 - x0, y1 - y0);
			const full = renderPage(m, a, i, scale);
			const part = renderPage(m, b, i, scale);
			const d = partDiff(part, full);
			// Glyph edges land on other pixels in a cropped render (its origin is not on the
			// pixel grid), so dense small text differs a little. The part must match clearly
			// better than the part 5% off (the control), and differ in at most 3% of pixels.
			const control = d > 0.005 ? partDiff(part, full, 0.05) : 1;
			if (d > 0.03 || d * 3 > control) pix.push(`page ${i + 1}: ${(100 * d).toFixed(1)}% differ (control ${(100 * control).toFixed(1)}%)`);
		}
		r.pixels = pix.length ? pix.join('; ') : 'same';
	} finally {
		a.destroy();
		b.destroy();
	}
}

serveJobs<CwJob, CwResult>(async (job, io) => {
	const t0 = Date.now();
	const r: CwResult = { sha256: job.sha256, path: job.path, source: job.source, producer: job.producer, half: job.half, open: 'error', ms: 0 };
	const done = () => {
		r.ms = Date.now() - t0;
		io.result(r);
	};
	const bytes = new Uint8Array(fs.readFileSync(job.path));
	io.progress('open');
	let src: Source;
	try {
		src = await engine().openPdf(bytes, 'survey.pdf');
		r.open = 'ok';
		r.pages = src.pages.length;
		r.firstPage = { width: Math.round(src.pages[0].width), height: Math.round(src.pages[0].height) };
		r.size = bytes.length;
	} catch (e) {
		r.openMessage = (e instanceof Error ? e.message : String(e)).slice(0, 200);
		return done();
	}
	const plain: PageRef[] = src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: [] }));
	io.progress('base');
	const base = await run(src, plain, opts);
	r.base = base.r;
	io.progress('cw');
	const cw = await run(
		src,
		plain.map((p) => ({ ...p, crop: CROP })),
		{ ...opts, watermark: { ...WM } }
	);
	r.cw = cw.r;
	if (base.bytes && cw.bytes) {
		io.progress('independent');
		try {
			await independent(base.bytes, cw.bytes, r);
		} catch (e) {
			r.pixels = `check failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 160)}`;
		}
	}
	done();
});
