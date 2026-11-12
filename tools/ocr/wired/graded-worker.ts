/**
 * Child process for tools/ocr/wired/graded.ts: one graded real scan (a survey page with
 * no text, graded by eye in the measurement, out-ocr/grade/grades.json) per job, exported
 * by the app's engine with "Make scanned pages searchable". The measurement graded 30
 * random OCR words a page (Otsu, no deskew); each of those is looked up in what the app
 * wrote at the same place: same text → it keeps its grade; other text → "changed" (a crop
 * is saved for grading by eye); nothing there → "gone" (dropped by the confidence filter
 * or not read). Survey files are read only; crops go to the survey folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { serveJobs } from '../../survey/lib/pool';
import { rng } from '../lib/degrade';
import { norm, type OcrWord } from '../lib/score';
import { renderAndCompare } from '../../../src/lib/engine/shrink';
import type { OcrTrace } from '../../../src/lib/engine/ocr/stage';
import type { OcrRead } from '../../../src/lib/engine/ocr/tess';
import { OUT, unturned, wiredEngine } from './common';

export interface GJob {
	key: string;
	path: string;
	page: number;
	group: string;
	/** The measurement's OCR words of this page (300 dpi, page as displayed). */
	old: OcrWord[];
	wrong: number[];
	unsure: number[];
}

export interface GRow {
	key: string;
	group: string;
	outcome: string;
	sig?: { meanConf: number; stop: number; words: number };
	orientation?: { angle: number | null; script: string | null };
	/** Picked words: kept their grade (right / wrong), changed text, gone. */
	right: number;
	wrong: number;
	changed: { n: number; old: string; now: string; oldWrong: boolean; crop: string }[];
	gone: { n: number; old: string; oldWrong: boolean }[];
	written: number;
	pxSame?: boolean;
	ms: { orient: number; read: number; export: number };
	error?: string;
}

let traces: OcrTrace[] = [];
const eng = wiredEngine((t) => traces.push(t), 1);
const crops = path.join(OUT, 'graded', 'crops');

serveJobs<GJob, GRow>(async (job, io) => {
	const row: GRow = { key: job.key, group: job.group, outcome: 'error', right: 0, wrong: 0, changed: [], gone: [], written: 0, ms: { orient: 0, read: 0, export: 0 } };
	try {
		const src = await eng.openPdf(new Uint8Array(fs.readFileSync(job.path)), path.basename(job.path));
		const ref = { id: 'a', sourceId: src.id, pageIndex: job.page, rotation: 0 as const, stamps: [] };
		traces = [];
		const t0 = performance.now();
		const res = await eng.exportPlan({ pages: [ref], options: { filename: 'o.pdf', compress: false, stripMetadata: false, ocr: true } }, [src], [], {});
		row.ms.export = Math.round(performance.now() - t0);
		const tr = traces[0];
		if (tr) {
			row.ms.orient = Math.round(tr.ms.orient);
			row.ms.read = Math.round(tr.ms.read);
			row.orientation = tr.orientation;
			const sig = tr.outcome.signals;
			if (sig) row.sig = { meanConf: Math.round(sig.meanConf * 10) / 10, stop: Math.round(sig.stop * 1000) / 1000, words: sig.words };
		}
		if (!res.ocr?.eligible) row.outcome = 'not tried';
		else if (!res.ocr.searchable.length) row.outcome = tr && !tr.outcome.ok ? tr.outcome.why : 'declined';
		else {
			row.outcome = 'searchable';
			const written = unturned((tr!.outcome as { read: OcrRead }).read).words;
			row.written = written.length;
			// The 30 words the measurement graded, picked exactly as tools/ocr/grade.ts picked them.
			const r = rng(parseInt(job.key.slice(0, 8), 16));
			const words = job.old.map((w, i) => ({ w, i })).filter(({ w }) => norm(w[0]).length > 0);
			const pick = [...words].sort(() => r() - 0.5).slice(0, 30);
			const doc = mupdf.Document.openDocument(fs.readFileSync(job.path), 'application/pdf');
			try {
				pick.forEach(({ w }, n) => {
					if (job.unsure.includes(n)) return;
					const oldWrong = job.wrong.includes(n);
					const cx = (w[1] + w[3]) / 2;
					const cy = (w[2] + w[4]) / 2;
					const hit = written.find((x) => cx >= x[1] && cx <= x[3] && cy >= x[2] && cy <= x[4]);
					if (!hit) {
						row.gone.push({ n, old: w[0], oldWrong });
						return;
					}
					if (hit[0] === w[0]) {
						if (oldWrong) row.wrong++;
						else row.right++;
						return;
					}
					// A crop of the scan around the word, for grading by eye.
					fs.mkdirSync(crops, { recursive: true });
					const name = `${job.key}-w${n}.png`;
					const page = doc.loadPage(job.page);
					const pad = (w[4] - w[2]) * 0.6;
					const k = 72 / 300;
					const x0 = Math.max(0, Math.min(w[1], hit[1]) - pad) * k;
					const y0 = Math.max(0, Math.min(w[2], hit[2]) - pad) * k;
					const x1 = (Math.max(w[3], hit[3]) + pad) * k;
					const y1 = (Math.max(w[4], hit[4]) + pad) * k;
					const s = 200 / 72;
					const pix = page.toPixmap(mupdf.Matrix.scale(s, s), mupdf.ColorSpace.DeviceGray, false, true);
					const W = pix.getWidth();
					const H = pix.getHeight();
					const cut = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, Math.ceil((x1 - x0) * s), Math.ceil((y1 - y0) * s)], false);
					const src2 = pix.getPixels();
					const dst = cut.getPixels();
					const cw = cut.getWidth();
					const ch = cut.getHeight();
					for (let y = 0; y < ch; y++)
						for (let x = 0; x < cw; x++) {
							const sx = Math.floor(x0 * s) + x;
							const sy = Math.floor(y0 * s) + y;
							dst[y * cut.getStride() + x] = sx < W && sy < H ? src2[sy * pix.getStride() + sx] : 255;
						}
					fs.writeFileSync(path.join(crops, name), cut.asPNG());
					cut.destroy();
					pix.destroy();
					page.destroy();
					row.changed.push({ n, old: w[0], now: hit[0], oldWrong, crop: name });
				});
			} finally {
				doc.destroy();
			}
			const plain = await eng.exportPlan({ pages: [ref], options: { filename: 'o.pdf', compress: false, stripMetadata: false } }, [src], [], {});
			const a = new mupdf.PDFDocument(plain.bytes);
			const b = new mupdf.PDFDocument(res.bytes);
			try {
				const px = renderAndCompare(mupdf, a, b, 0);
				row.pxSame = !!px && px.pageMean === 0 && px.blockMean === 0;
			} finally {
				a.destroy();
				b.destroy();
			}
		}
	} catch (e) {
		row.error = e instanceof Error ? e.message : String(e);
	}
	io.result(row);
});
