/**
 * Child process for tools/ocr/wired/synth.ts: one survey file per job. For each of its
 * held-out pages (truth from the measurement's results/synth-hold.jsonl) and each
 * condition, the measurement's degraded scan is made again (same render, same seed, so
 * the same pixels), put alone on a page of the same size as a picture (a JPEG for scan
 * and phone, as a scanner would store it; grey Flate otherwise), and exported by the app's
 * engine with "Make scanned pages searchable" on. Scored against the true words:
 * OCR accuracy of the words written, the page outcome, pixel identity against the same
 * export without OCR, and the highlighter's boxes on the written layer against the true
 * ink. Survey files are read only; nothing is written into the repo.
 */
import fs from 'node:fs';
import * as mupdf from 'mupdf';
import * as PL from '@cantoo/pdf-lib';
import { serveJobs } from '../../survey/lib/pool';
import { apply, concat, type Mat } from '../lib/degrade';
import { degrade, hashSeed, type Degradation } from '../lib/synth';
import { encode, renderGray } from '../lib/truth';
import { norm, scorePage, signals, type Box, type OcrWord, type Score, type Signals, type TruthWord } from '../lib/score';
import { pageTextOf } from '../../../src/lib/engine/page-text';
import { renderAndCompare } from '../../../src/lib/engine/shrink';
import type { OcrTrace } from '../../../src/lib/engine/ocr/stage';
import type { OcrRead } from '../../../src/lib/engine/ocr/tess';
import { unturned, wiredEngine } from './common';

export interface WCond {
	dpi: number;
	deg: Degradation;
}

export interface WPage {
	/** Conditions to run on this page. */
	conds: WCond[];
	page: number;
	kind: string;
	W: number;
	H: number;
	truth: TruthWord[];
	ignore: Box[];
}

export interface WJob {
	sha256: string;
	path: string;
	source: string;
	pages: WPage[];
	/** Unused (conditions are per page). */
	conds: WCond[];
}

export interface HlScore {
	/** True words OCR wrote exactly (paired). */
	n: number;
	offered: number;
	right: number;
	miss: number;
	flood: number;
}

export interface WRow {
	sha256: string;
	source: string;
	page: number;
	kind: string;
	dpi: number;
	deg: Degradation;
	angle: number;
	/** 'searchable' | decline reason | 'not tried' | 'error'. */
	outcome: string;
	eligible: boolean;
	sig?: Signals;
	/** Words written (after the gate and the confidence filter). */
	s?: Score;
	/** All words OCR returned, for comparison with the measurement (which scored before the filter). */
	sAll?: Score;
	hl?: HlScore;
	pxSame?: boolean;
	checksOk?: boolean;
	ms: { render: number; orient: number; read: number; export: number };
	error?: string;
}

const K = 300 / 72;

/** Truth word ink corners (original page points) in the exported page (points). */
function hlScore(doc: mupdf.Document, truth: TruthWord[], M: Mat, written: OcrWord[], mOcr: Mat): HlScore {
	const out: HlScore = { n: 0, offered: 0, right: 0, miss: 0, flood: 0 };
	const page = doc.loadPage(0);
	const [x0, y0, x1, y1] = page.getBounds();
	page.destroy();
	const W = x1 - x0;
	const H = y1 - y0;
	const words = pageTextOf(doc, 0).words.map((w) => ({ t: norm(w.text), b: [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H] as Box }));
	// Exported page points → original page points.
	const det = M[0] * M[3] - M[1] * M[2];
	const inv: Mat = [M[3] / det, -M[1] / det, -M[2] / det, M[0] / det, (M[2] * M[5] - M[3] * M[4]) / det, (M[1] * M[4] - M[0] * M[5]) / det];
	// Which true words OCR wrote exactly: paired by scorePage's rule (same text, overlapping place).
	const exact = new Set<number>();
	{
		const invO: Mat = (() => {
			const d = mOcr[0] * mOcr[3] - mOcr[1] * mOcr[2];
			return [mOcr[3] / d, -mOcr[1] / d, -mOcr[2] / d, mOcr[0] / d, (mOcr[2] * mOcr[5] - mOcr[3] * mOcr[4]) / d, (mOcr[1] * mOcr[4] - mOcr[0] * mOcr[5]) / d];
		})();
		const centres = written.map((w) => ({ t: norm(w[0]), c: apply(invO, (w[1] + w[3]) / 2, (w[2] + w[4]) / 2) }));
		truth.forEach((t, i) => {
			const k = norm(t.t);
			if (k && centres.some((c) => c.t === k && c.c[0] >= t.ink[0] - 2 && c.c[0] <= t.ink[2] + 2 && c.c[1] >= t.ink[1] - 2 && c.c[1] <= t.ink[3] + 2)) exact.add(i);
		});
	}
	type Pt = [number, number];
	const clip = (poly: Pt[], r: Box): Pt[] => {
		const fs: ((p: Pt) => number)[] = [(p) => p[0] - r[0], (p) => r[2] - p[0], (p) => p[1] - r[1], (p) => r[3] - p[1]];
		let o = poly;
		for (const f of fs) {
			const inp = o;
			o = [];
			for (let i = 0; i < inp.length; i++) {
				const a = inp[i];
				const b = inp[(i + 1) % inp.length];
				const fa = f(a);
				const fb = f(b);
				if (fa >= 0) o.push(a);
				if (fa >= 0 !== fb >= 0) {
					const t = fa / (fa - fb);
					o.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
				}
			}
			if (!o.length) break;
		}
		return o;
	};
	truth.forEach((t, i) => {
		if (!exact.has(i)) return;
		out.n++;
		const ink = t.ink;
		const corners = [apply(M, ink[0], ink[1]), apply(M, ink[2], ink[1]), apply(M, ink[0], ink[3]), apply(M, ink[2], ink[3])];
		const cx = corners.reduce((s, c) => s + c[0], 0) / 4;
		const cy = corners.reduce((s, c) => s + c[1], 0) / 4;
		const k = norm(t.t);
		const bw = words.find((w) => w.t === k && cx >= w.b[0] && cx <= w.b[2] && cy >= w.b[1] && cy <= w.b[3]);
		if (!bw) return;
		out.offered++;
		const m = corners.some(([x, y]) => x < bw.b[0] - 1 || x > bw.b[2] + 1 || y < bw.b[1] - 1 || y > bw.b[3] + 1);
		// The box in the original page's frame, against the other lines' true ink there.
		const poly: Pt[] = [apply(inv, bw.b[0], bw.b[1]), apply(inv, bw.b[2], bw.b[1]), apply(inv, bw.b[2], bw.b[3]), apply(inv, bw.b[0], bw.b[3])];
		const f = truth.some((o) => {
			if (o.line === t.line) return false;
			const c = clip(poly, o.ink);
			if (c.length < 3) return false;
			const xs = c.map((q) => q[0]);
			const ys = c.map((q) => q[1]);
			return Math.max(...xs) - Math.min(...xs) > 1 && Math.max(...ys) - Math.min(...ys) > 0.15 * (o.ink[3] - o.ink[1]);
		});
		if (m) out.miss++;
		if (f) out.flood++;
		if (!m && !f) out.right++;
	});
	return out;
}

async function picturePdf(W: number, H: number, img: { w: number; h: number; px: Uint8Array }, bytes: Uint8Array, kind: 'png' | 'jpeg'): Promise<Uint8Array> {
	const doc = await PL.PDFDocument.create();
	const page = doc.addPage([W, H]);
	if (kind === 'jpeg') {
		const j = await doc.embedJpg(bytes);
		page.drawImage(j, { x: 0, y: 0, width: W, height: H });
	} else {
		const ref = doc.context.register(
			doc.context.flateStream(img.px, { Type: 'XObject', Subtype: 'Image', Width: img.w, Height: img.h, ColorSpace: 'DeviceGray', BitsPerComponent: 8 })
		);
		const name = page.node.newXObject('Scan', ref);
		const c = doc.context.register(doc.context.flateStream(`q ${W} 0 0 ${H} 0 0 cm ${name.asString()} Do Q`));
		page.node.set(PL.PDFName.of('Contents'), doc.context.obj([c]));
	}
	return doc.save({ useObjectStreams: false });
}

let traces: OcrTrace[] = [];
const eng = wiredEngine((t) => traces.push(t), 1);

serveJobs<WJob, WRow>(async (job, io) => {
	let src: mupdf.Document | null = null;
	try {
		src = mupdf.Document.openDocument(fs.readFileSync(job.path), 'application/pdf');
		for (const p of job.pages) {
			for (const c of p.conds) {
				const row: WRow = { sha256: job.sha256, source: job.source, page: p.page, kind: p.kind, dpi: c.dpi, deg: c.deg, angle: 0, outcome: 'error', eligible: false, ms: { render: 0, orient: 0, read: 0, export: 0 } };
				try {
					const g = renderGray(mupdf, src, p.page, c.dpi);
					const d = degrade(g, c.deg, c.dpi, hashSeed(`${job.sha256}:${p.page}:${c.deg}:${c.dpi}`));
					row.angle = Math.round((d.p.angle ?? 0) * 100) / 100;
					const bytes = encode(mupdf, d.img, d.kind, d.q);
					const pdf = await picturePdf(p.W, p.H, d.img, bytes, d.kind);
					const s = await eng.openPdf(pdf, 'scan.pdf');
					const ref = { id: 'a', sourceId: s.id, pageIndex: 0, rotation: 0 as const, stamps: [] };
					traces = [];
					const t0 = performance.now();
					const res = await eng.exportPlan({ pages: [ref], options: { filename: 'o.pdf', compress: false, stripMetadata: false, ocr: true } }, [s], [], {});
					row.ms.export = Math.round(performance.now() - t0);
					row.checksOk = res.checks.every((x) => x.ok);
					row.eligible = (res.ocr?.eligible ?? 0) > 0;
					const tr = traces[0];
					if (tr) {
						row.ms.render = Math.round(tr.ms.render);
						row.ms.orient = Math.round(tr.ms.orient);
						row.ms.read = Math.round(tr.ms.read);
					}
					// Page points (original) → OCR pixels of the 300 dpi render of our page.
					const mOcr = concat(concat([c.dpi / 72, 0, 0, c.dpi / 72, 0, 0], d.m), [(p.W / d.img.w) * K, 0, 0, (p.H / d.img.h) * K, 0, 0]);
					if (tr?.raw) {
						const all = unturned(tr.raw).words;
						row.sig = signals(all);
						row.sAll = scorePage(p.truth, all, mOcr, p.ignore).score;
					}
					if (!row.eligible) row.outcome = 'not tried';
					else if (res.ocr?.searchable.length) {
						row.outcome = 'searchable';
						const read = (tr!.outcome as { read: OcrRead }).read;
						const written = unturned(read).words;
						row.s = scorePage(p.truth, written, mOcr, p.ignore).score;
						// Pixels against the picture page as it went in.
						const a = new mupdf.PDFDocument(pdf);
						const b = new mupdf.PDFDocument(res.bytes);
						try {
							const px = renderAndCompare(mupdf, a, b, 0);
							row.pxSame = !!px && px.pageMean === 0 && px.blockMean === 0;
							row.hl = hlScore(b, p.truth, concat(mOcr, [1 / K, 0, 0, 1 / K, 0, 0]), written, mOcr);
						} finally {
							a.destroy();
							b.destroy();
						}
					} else row.outcome = tr && !tr.outcome.ok ? tr.outcome.why : 'declined';
				} catch (e) {
					row.error = e instanceof Error ? e.message : String(e);
				}
				io.result(row);
				io.progress(`${p.page} ${c.deg} ${c.dpi}`);
			}
		}
	} catch (e) {
		io.result({ sha256: job.sha256, source: job.source, page: -1, kind: '', dpi: 0, deg: 'clean', angle: 0, outcome: 'error', eligible: false, ms: { render: 0, orient: 0, read: 0, export: 0 }, error: String(e) });
	} finally {
		src?.destroy();
	}
});
