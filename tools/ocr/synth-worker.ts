/**
 * Child process for `ocr:measure synth`: one born-digital file per job. Picks pages
 * whose own text is good truth (English, level, visible, no OCR layer, not mostly a
 * picture), renders each at the job's resolutions with MuPDF, degrades it like a scan,
 * runs tesseract.js on it and returns the true words and the OCR words. Scoring is done
 * later by `report`, from these results. Images may be written to `pngDir` (inside the
 * survey folder) for the browser benchmark. Nothing is written into the input file.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { serveJobs } from '../survey/lib/pool';
import { concat, resize, type Gray, type Mat } from './lib/degrade';
import { decodeGray, degrade, hashSeed, pageKind, rejectPage, truthOf, type Degradation } from './lib/synth';
import { encode, pageInfo, renderGray } from './lib/truth';
import type { Box, OcrWord, TruthWord } from './lib/score';
import { tessWorker, type Model, type TessWorker } from './lib/tess';

export interface Cond {
	dpi: number;
	deg: Degradation;
	/** OCR the image enlarged to 300 dpi (bilinear) instead of as it is. */
	up?: boolean;
	/** Tesseract thresholding_method: 0 Otsu (default), 1 Leptonica tiled Otsu, 2 Sauvola. */
	th?: number;
	/** Let Tesseract find and undo skew (tesseract.js rotateAuto); boxes are turned back. Default true. */
	deskew?: boolean;
	models: Model[];
}

export interface SynthJob {
	sha256: string;
	path: string;
	source: string;
	set: 'dev' | 'hold';
	/** Candidate pages (0-based) in the order to try. */
	pages: number[];
	want: number;
	conds: Cond[];
	pngDir?: string;
}

export interface Run {
	dpi: number;
	deg: Degradation;
	up: boolean;
	th: number;
	deskew: boolean;
	/** Deskew angle applied, degrees. */
	rot: number;
	model: Model;
	/** Page points → OCR image pixels. */
	m: Mat;
	/** Degradation parameters (angle, blur, ...). */
	p: Record<string, number>;
	/** Image as fed to OCR: pixels, bytes. */
	iw: number;
	ih: number;
	bytes: number;
	words: OcrWord[];
	ms: number;
	conf: number;
}

export interface SynthPage {
	sha256: string;
	source: string;
	set: 'dev' | 'hold';
	page: number;
	kind: string;
	W: number;
	H: number;
	truth: TruthWord[];
	ignore: Box[];
	medSize: number;
	runs: Run[];
	error?: string;
}

export interface SynthResult {
	sha256: string;
	pages: SynthPage[];
	tried: number;
	rejected: Record<string, number>;
	error?: string;
}

const workers = new Map<Model, TessWorker>();
async function worker(model: Model): Promise<TessWorker> {
	let w = workers.get(model);
	if (!w) {
		w = await tessWorker(model);
		workers.set(model, w);
	}
	return w;
}

serveJobs<SynthJob, SynthResult>(async (job, io) => {
	const res: SynthResult = { sha256: job.sha256, pages: [], tried: 0, rejected: {} };
	let doc: mupdf.Document | null = null;
	try {
		doc = mupdf.Document.openDocument(fs.readFileSync(job.path), 'application/pdf');
		if (doc.needsPassword()) throw new Error('encrypted');
		const n = doc.countPages();
		for (const pi of job.pages) {
			if (res.pages.length >= job.want) break;
			if (pi >= n) continue;
			res.tried++;
			const info = pageInfo(mupdf, doc, pi);
			const why = rejectPage(info);
			if (why) {
				res.rejected[why] = (res.rejected[why] ?? 0) + 1;
				continue;
			}
			const renders = new Map<number, Gray>();
			const render = (dpi: number) => {
				let g = renders.get(dpi);
				if (!g) {
					g = renderGray(mupdf, doc!, pi, dpi);
					renders.set(dpi, g);
				}
				return g;
			};
			const { truth, ignore } = truthOf(info, render(300), 300);
			if (truth.length < 40) {
				res.rejected['few visible words'] = (res.rejected['few visible words'] ?? 0) + 1;
				continue;
			}
			const sizes = truth.map((t) => t.size).sort((a, b) => a - b);
			const sp: SynthPage = {
				sha256: job.sha256,
				source: job.source,
				set: job.set,
				page: pi,
				kind: pageKind(job.source, info, truth),
				W: info.W,
				H: info.H,
				truth,
				ignore,
				medSize: sizes[Math.floor(sizes.length / 2)],
				runs: []
			};
			for (const c of job.conds) {
				const src = render(c.dpi);
				const seed = hashSeed(`${job.sha256}:${pi}:${c.deg}:${c.dpi}`);
				const d = degrade(src, c.deg, c.dpi, seed);
				let img = d.img;
				let m: Mat = concat([c.dpi / 72, 0, 0, c.dpi / 72, 0, 0], d.m);
				let dpi = c.dpi;
				let bytes = encode(mupdf, img, d.kind, d.q);
				if (c.up && c.dpi < 300) {
					// Decode what a scan would hold (the JPEG) before enlarging it.
					const decoded = d.kind === 'jpeg' ? decodeGray(bytes) : img;
					const r = resize(decoded, 300 / c.dpi);
					img = r.img;
					m = concat(m, r.m);
					dpi = 300;
					bytes = encode(mupdf, img, 'png');
				}
				if (job.pngDir && !c.th) {
					fs.mkdirSync(job.pngDir, { recursive: true });
					const ext = c.up || d.kind === 'png' ? 'png' : 'jpg';
					fs.writeFileSync(path.join(job.pngDir, `${job.sha256.slice(0, 16)}-p${pi + 1}-${c.deg}-${c.dpi}${c.up ? 'up' : ''}.${ext}`), bytes);
				}
				for (const model of c.models) {
					const w = await worker(model);
					const deskew = c.deskew ?? true;
					const o = await w.recognize(bytes, dpi, { thresholding_method: String(c.th ?? 0) }, { deskew, w: img.w, h: img.h });
					sp.runs.push({ dpi: c.dpi, deg: c.deg, up: !!c.up, th: c.th ?? 0, deskew, rot: Math.round((o.rot * 180 / Math.PI) * 100) / 100, model, m: m.map((v) => Math.round(v * 1e6) / 1e6) as Mat, p: Object.fromEntries(Object.entries(d.p).map(([k, v]) => [k, Math.round(v * 100) / 100])), iw: img.w, ih: img.h, bytes: bytes.length, words: o.words, ms: o.ms, conf: o.meanConf });
					io.progress(`${pi} ${c.deg} ${c.dpi} ${model}`);
				}
			}
			res.pages.push(sp);
		}
	} catch (e) {
		res.error = e instanceof Error ? e.message : String(e);
	} finally {
		try {
			doc?.destroy();
		} catch {
			// gone
		}
	}
	// Summary line: what was tried and turned down (pages were sent one by one above).
	io.result({ ...res, pages: [] });
});

