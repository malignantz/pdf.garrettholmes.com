/**
 * Child process for real scans (`ocr:scans`), one file per job.
 *
 * inventory: for the first `maxPages` pages, what the page is made of: picture cover, the
 *   pictures' resolution and bit depth, visible / invisible / hidden words, /Rotate.
 * ocr: renders the listed pages as displayed at 300 dpi (grey), runs tesseract.js and
 *   returns its words with the page's existing text layer (invisible or hidden words) as a
 *   reference. With `pngDir` the render is saved (inside the survey folder) for grading by eye.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { serveJobs } from '../survey/lib/pool';
import { encode, pageInfo, renderGray } from './lib/truth';
import { norm, type Box, type OcrWord, type TruthWord } from './lib/score';
import { tessWorker, type Model, type TessWorker } from './lib/tess';

export interface ScanJob {
	sha256: string;
	path: string;
	source: string;
	mode: 'inventory' | 'ocr';
	maxPages?: number;
	pages?: number[];
	models?: Model[];
	th?: number;
	dpi?: number;
	deskew?: boolean;
	pngDir?: string;
}

export interface PageInv {
	i: number;
	W: number;
	H: number;
	rotate: number;
	cover: number;
	images: number;
	/** Largest picture: pixels per inch, bits per component, pixels. */
	ppi: number;
	bits: number;
	mpx: number;
	visible: number;
	invisible: number;
	hidden: number;
	paths: number;
}

export interface ScanOcrPage {
	i: number;
	W: number;
	H: number;
	dpi: number;
	inv: PageInv;
	/** Existing text layer words (invisible or hidden), level ones only. */
	layer: TruthWord[];
	runs: { model: Model; th: number; deskew: boolean; rot: number; words: OcrWord[]; ms: number; conf: number; iw: number; ih: number }[];
	png?: string;
}

export interface ScanResult {
	sha256: string;
	source: string;
	pageCount: number;
	inv?: PageInv[];
	ocr?: ScanOcrPage[];
	signed?: boolean;
	error?: string;
}

function inventory(doc: mupdf.Document, i: number): { inv: PageInv; info: ReturnType<typeof pageInfo> } {
	const info = pageInfo(mupdf, doc, i);
	const big = [...info.images].sort((a, b) => (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]) - (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]))[0];
	const ws = info.words.filter((w) => norm(w.t));
	return {
		info,
		inv: {
			i,
			W: Math.round(info.W),
			H: Math.round(info.H),
			rotate: info.rotate,
			cover: Math.round(info.imageCover * 1000) / 1000,
			images: info.images.length,
			ppi: big?.ppi ?? 0,
			bits: big?.bits ?? 0,
			mpx: big ? Math.round((big.pw * big.ph) / 1e4) / 100 : 0,
			visible: ws.filter((w) => w.vis).length,
			invisible: ws.filter((w) => w.invisible).length,
			hidden: ws.filter((w) => !w.vis && !w.invisible).length,
			paths: info.paths
		}
	};
}

const workers = new Map<Model, TessWorker>();

serveJobs<ScanJob, ScanResult>(async (job, io) => {
	const res: ScanResult = { sha256: job.sha256, source: job.source, pageCount: 0 };
	let doc: mupdf.Document | null = null;
	try {
		doc = mupdf.Document.openDocument(fs.readFileSync(job.path), 'application/pdf');
		if (doc.needsPassword()) throw new Error('encrypted');
		res.pageCount = doc.countPages();
		try {
			const pdf = doc as mupdf.PDFDocument;
			const fields = pdf.getTrailer().get('Root').get('AcroForm').get('Fields');
			let signed = false;
			for (let k = 0; k < (fields?.length ?? 0); k++) if (String(fields.get(k).get('FT')) === '/Sig' && fields.get(k).get('V').isDictionary?.()) signed = true;
			res.signed = signed;
		} catch {
			res.signed = false;
		}
		if (job.mode === 'inventory') {
			res.inv = [];
			for (let i = 0; i < Math.min(res.pageCount, job.maxPages ?? 12); i++) {
				try {
					res.inv.push(inventory(doc, i).inv);
				} catch (e) {
					res.inv.push({ i, W: 0, H: 0, rotate: 0, cover: -1, images: 0, ppi: 0, bits: 0, mpx: 0, visible: 0, invisible: 0, hidden: 0, paths: 0 });
					void e;
				}
				io.progress(`inv ${i}`);
			}
		} else {
			res.ocr = [];
			const dpi = job.dpi ?? 300;
			for (const i of job.pages ?? []) {
				if (i >= res.pageCount) continue;
				const { inv, info } = inventory(doc, i);
				const layer: TruthWord[] = info.words
					.filter((w) => !w.vis && w.level && norm(w.t))
					.map((w) => ({ t: w.t, h: w.h as Box, ink: w.h as Box, size: Math.round(w.size * 10) / 10, line: w.line }));
				const g = renderGray(mupdf, doc, i, dpi);
				const png = encode(mupdf, g, 'png');
				let pngName: string | undefined;
				if (job.pngDir) {
					fs.mkdirSync(job.pngDir, { recursive: true });
					pngName = `${job.sha256.slice(0, 16)}-p${i + 1}.png`;
					fs.writeFileSync(path.join(job.pngDir, pngName), png);
				}
				const page: ScanOcrPage = { i, W: info.W, H: info.H, dpi, inv, layer, runs: [], png: pngName };
				for (const model of job.models ?? ['fast']) {
					let w = workers.get(model);
					if (!w) {
						w = await tessWorker(model);
						workers.set(model, w);
					}
					const o = await w.recognize(png, dpi, { thresholding_method: String(job.th ?? 0) }, { deskew: job.deskew ?? false, w: g.w, h: g.h });
					page.runs.push({ model, th: job.th ?? 0, deskew: job.deskew ?? false, rot: o.rot, words: o.words, ms: o.ms, conf: o.meanConf, iw: g.w, ih: g.h });
					io.progress(`ocr ${i} ${model}`);
				}
				res.ocr.push(page);
			}
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
	io.result(res);
});
