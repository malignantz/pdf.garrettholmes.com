/**
 * OCR text-layer prototype, step 2: for each page in <out>/pages.json (select.ts),
 * cut it into its own PDF ("before"), OCR it as displayed (MuPDF 300 dpi grey →
 * tesseract.js fast), write the invisible layer (layer.ts) in two spacing variants and
 * check each "after" file:
 *  - pixels: MuPDF, PDF.js (@napi-rs/canvas) and poppler pdftoppm at 150 dpi, byte-equal to before;
 *  - text: MuPDF structured text, PDF.js getTextContent, pdftotext (raw and -layout)
 *    against the OCR word sequence (word sequence ratio, glued words, line breaks);
 *  - highlighter: src/lib/engine/page-text.ts pageTextOf boxes against the OCR boxes; MuPDF search;
 *  - size: growth as written by pdf-lib, and after qpdf --object-streams=generate --compress-streams=y (wasm).
 * Plus a signature probe on signed survey files (full rewrite vs incremental update).
 *
 *   node --experimental-transform-types --no-warnings --import ./tools/survey/register.mjs tools/ocr/layer/check.ts [--only N]
 *
 * Everything derived from survey files is written under /home/garrett/pdf-survey/out-ocr/layer/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import * as mupdf from 'mupdf';
import * as PL from '@cantoo/pdf-lib';
import { pageTextOf } from '../../../src/lib/engine/page-text';
import { Qpdf } from '../../../src/lib/engine/qpdf';
import { encode, renderGray } from '../lib/truth';
import { lineWorker, type OcrPage } from './ocr';
import { GlyphlessFont, addTextLayer, type Spaces, type Stretch } from './layer';
import type { Pick } from './select';

const OUT = '/home/garrett/pdf-survey/out-ocr/layer';
const DPI_OCR = 300;
const DPI_PX = 150;
/** Layer variants: spaces (gap | none) - stretch (tz | tc) - lines within this many degrees of level written level. */
export const VARIANTS = ['gap-tz-0.2', 'gap-tz-0', 'none-tz-0.2', 'gap-tc-0.2', 'gap-tcmax-0.2', 'gap-mix-0.2'] as const;
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');

const destroy = (o: unknown) => {
	try {
		(o as { destroy?: () => void })?.destroy?.();
	} catch {
		// gone
	}
};

// ------------------------------------------------------------------ engines

const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
const qpdf = new Qpdf({ location: wasmPath, compile: async () => WebAssembly.compile(fs.readFileSync(wasmPath)) });
async function qpdfPack(bytes: Uint8Array): Promise<number> {
	const r = await qpdf.run({ args: ['in.pdf', '--object-streams=generate', '--compress-streams=y', 'out.pdf'], inputs: { 'in.pdf': bytes }, outputs: ['out.pdf'] });
	const o = r.files.get('out.pdf');
	if (!o) throw new Error(`qpdf ${r.code} ${r.stderr}`);
	return o.length;
}

const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist');
const dirs = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const;
class FsBinaryDataFactory {
	async fetch({ kind, filename }: { kind: keyof typeof dirs; filename: string }): Promise<Uint8Array> {
		return new Uint8Array(fs.readFileSync(path.join(pdfjsDir, dirs[kind], filename)));
	}
}
let pdfjsP: Promise<typeof import('pdfjs-dist/legacy/build/pdf.mjs')> | null = null;
function pdfjs() {
	pdfjsP ??= (async () => {
		await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
		return import('pdfjs-dist/legacy/build/pdf.mjs');
	})();
	return pdfjsP;
}
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

async function pdfjsPage(bytes: Uint8Array): Promise<{ px: Uint8Array; text: string }> {
	const pj = await pdfjs();
	const task = pj.getDocument({ data: bytes.slice(), BinaryDataFactory: FsBinaryDataFactory, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 } as never);
	const doc = await task.promise;
	try {
		const page = await doc.getPage(1);
		const vp = page.getViewport({ scale: DPI_PX / 72 });
		const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
		const ctx = canvas.getContext('2d');
		await page.render({ canvasContext: ctx as never, canvas: canvas as never, viewport: vp }).promise;
		const px = new Uint8Array(ctx.getImageData(0, 0, canvas.width, canvas.height).data);
		const tc = await page.getTextContent();
		let text = '';
		for (const it of tc.items) if ('str' in it) text += it.str + (it.hasEOL ? '\n' : '');
		page.cleanup();
		return { px, text };
	} finally {
		await task.destroy();
	}
}

function mupdfPx(doc: mupdf.Document): Uint8Array {
	const page = doc.loadPage(0);
	try {
		const pix = page.toPixmap(mupdf.Matrix.scale(DPI_PX / 72, DPI_PX / 72), mupdf.ColorSpace.DeviceRGB, false, true);
		const px = pix.getPixels().slice();
		destroy(pix);
		return px;
	} finally {
		destroy(page);
	}
}

function popplerPx(file: string): Buffer {
	const prefix = file.replace(/\.pdf$/, '-pp');
	execFileSync('pdftoppm', ['-r', String(DPI_PX), '-f', '1', '-l', '1', '-singlefile', file, prefix], { stdio: 'ignore' });
	const b = fs.readFileSync(prefix + '.ppm');
	fs.unlinkSync(prefix + '.ppm');
	return b;
}

function pdftotext(file: string, layout: boolean): string {
	return execFileSync('pdftotext', [...(layout ? ['-layout'] : []), '-enc', 'UTF-8', '-f', '1', '-l', '1', file, '-'], { encoding: 'utf8' });
}

function diffCount(a: Uint8Array, b: Uint8Array): number {
	if (a.length !== b.length) return -1;
	let d = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
	return d;
}

// ------------------------------------------------------------------ text scoring

interface Tok {
	t: string;
	nl: boolean;
}
function tokens(text: string): Tok[] {
	const out: Tok[] = [];
	const re = /(\s*)(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(text))) out.push({ t: m[2], nl: m[1].includes('\n') || m[1].includes('\f') });
	return out;
}

/** Gold = OCR words in line order; scores an extraction against it. */
function textScore(gold: { t: string; lineEnd: boolean }[], text: string) {
	const ext = tokens(text);
	const a = gold.length;
	const b = ext.length;
	// LCS with backtrack (pages have at most a few thousand words).
	const dp = new Uint32Array((a + 1) * (b + 1));
	for (let i = a - 1; i >= 0; i--)
		for (let j = b - 1; j >= 0; j--)
			dp[i * (b + 1) + j] = gold[i].t === ext[j].t ? dp[(i + 1) * (b + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (b + 1) + j], dp[i * (b + 1) + j + 1]);
	const lcs = dp[0];
	const match: number[] = new Array(a).fill(-1);
	for (let i = 0, j = 0; i < a && j < b; ) {
		if (gold[i].t === ext[j].t) {
			match[i] = j;
			i++;
			j++;
		} else if (dp[(i + 1) * (b + 1) + j] >= dp[i * (b + 1) + j + 1]) i++;
		else j++;
	}
	let pairs = 0;
	let brOk = 0;
	let brN = 0;
	let spOk = 0;
	let spN = 0;
	for (let i = 0; i + 1 < a; i++) {
		if (match[i] < 0 || match[i + 1] !== match[i] + 1) continue;
		pairs++;
		if (gold[i].lineEnd) {
			brN++;
			if (ext[match[i + 1]].nl) brOk++;
		} else {
			spN++;
			if (!ext[match[i + 1]].nl) spOk++;
		}
	}
	const extSet = new Map<string, number>();
	for (const e of ext) extSet.set(e.t, (extSet.get(e.t) ?? 0) + 1);
	let glued = 0;
	for (let i = 0; i + 1 < a; i++) if (!gold[i].lineEnd && extSet.has(gold[i].t + gold[i + 1].t)) glued++;
	return {
		ratio: a + b ? (2 * lcs) / (a + b) : 1,
		extTokens: b,
		glued,
		lineBreaks: brN ? brOk / brN : 1,
		spacesKept: spN ? spOk / spN : 1,
		pairs
	};
}

// ------------------------------------------------------------------ boxes

type B = [number, number, number, number];
const area = (b: B) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inter = (a: B, b: B) => area([Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])]);
const iou = (a: B, b: B) => {
	const i = inter(a, b);
	return i / (area(a) + area(b) - i || 1);
};
function quadBox(q: number[]): B {
	const xs = [q[0], q[2], q[4], q[6]];
	const ys = [q[1], q[3], q[5], q[7]];
	return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function hlScore(doc: mupdf.Document, gold: { t: string; b: B; line: number }[]) {
	const page = doc.loadPage(0);
	const [x0, y0, x1, y1] = page.getBounds();
	const W = x1 - x0;
	const H = y1 - y0;
	destroy(page);
	const pt = pageTextOf(doc, 0);
	const words = pt.words.map((w) => ({ t: w.text, b: [w.box.x * W, w.box.y * H, (w.box.x + w.box.w) * W, (w.box.y + w.box.h) * H] as B }));
	const ious: number[] = [];
	const edges: number[] = [];
	const vEdges: number[] = [];
	let offered = 0;
	let split = 0;
	let miss = 0;
	let flood = 0;
	const inside = (b: B, x: number, y: number) => x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
	for (const g of gold) {
		const cx = (g.b[0] + g.b[2]) / 2;
		const cy = (g.b[1] + g.b[3]) / 2;
		if (words.filter((w) => inside(w.b, cx, cy)).length > 1) split++;
		const bw = words.find((w) => w.t === g.t && inside(w.b, cx, cy));
		if (!bw) continue;
		offered++;
		ious.push(iou(bw.b, g.b));
		edges.push(Math.abs(bw.b[0] - g.b[0]), Math.abs(bw.b[2] - g.b[2]));
		vEdges.push(Math.abs(bw.b[1] - g.b[1]), Math.abs(bw.b[3] - g.b[3]));
		if (g.b[0] < bw.b[0] - 1 || g.b[1] < bw.b[1] - 1 || g.b[2] > bw.b[2] + 1 || g.b[3] > bw.b[3] + 1) miss++;
		// Flood: the box reaches more than 15% of another line's word height into that word's ink.
		if (gold.some((o) => o.line !== g.line && Math.min(o.b[2], bw.b[2]) - Math.max(o.b[0], bw.b[0]) > 0 && Math.min(o.b[3], bw.b[3]) - Math.max(o.b[1], bw.b[1]) > 0.15 * (o.b[3] - o.b[1]))) flood++;
	}
	let merged = 0;
	for (const w of words) if (gold.filter((g) => inside(w.b, (g.b[0] + g.b[2]) / 2, (g.b[1] + g.b[3]) / 2)).length > 1) merged++;
	return { words: words.length, offered, split, merged, miss, flood, skipped: pt.skipped, ious, edges, vEdges };
}

function searchScore(doc: mupdf.Document, gold: { t: string; b: B }[]) {
	const count = new Map<string, number>();
	for (const g of gold) count.set(g.t.toLowerCase(), (count.get(g.t.toLowerCase()) ?? 0) + 1);
	const tries = gold.filter((g) => /^[A-Za-z]{4,}$/.test(g.t) && count.get(g.t.toLowerCase()) === 1).slice(0, 40);
	const page = doc.loadPage(0) as mupdf.PDFPage;
	let ok = 0;
	let found = 0;
	try {
		for (const g of tries) {
			const hits = page.search(g.t) as unknown as number[][][];
			if (hits.length) found++;
			if (hits.some((h) => h.some((q) => { const b = quadBox(Array.from(q)); const cx = (g.b[0] + g.b[2]) / 2; const cy = (g.b[1] + g.b[3]) / 2; return cx >= b[0] && cx <= b[2] && cy >= b[1] && cy <= b[3]; }))) ok++;
		}
	} finally {
		destroy(page);
	}
	return { tried: tries.length, found, rightPlace: ok };
}

// ------------------------------------------------------------------ per page

const q = (xs: number[], p: number) => {
	if (!xs.length) return NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(p * s.length))];
};
const r2 = (v: number) => Math.round(v * 100) / 100;

async function makeBefore(p: Pick & { rotateTo?: number; turn?: boolean }, file: string) {
	const src = await PL.PDFDocument.load(fs.readFileSync(p.path), { ignoreEncryption: true, updateMetadata: false });
	const out = await PL.PDFDocument.create({ updateMetadata: false });
	if (p.turn) {
		// A scan stored sideways and shown upright by /Rotate 90: the page drawn as a form
		// XObject turned 90° anticlockwise on a landscape page (also a non-trivial CTM).
		const [emb] = await out.embedPages([src.getPage(p.page)]);
		const pg = out.addPage([emb.height, emb.width]);
		pg.drawPage(emb, { x: emb.height, y: 0, rotate: PL.degrees(90) });
		pg.setRotation(PL.degrees(90));
	} else {
		const [pg] = await out.copyPages(src, [p.page]);
		out.addPage(pg);
		// Sideways: /Rotate 90 added to an upright page, so the text shows sideways.
		if (p.rotateTo !== undefined) pg.setRotation(PL.degrees(p.rotateTo));
	}
	fs.writeFileSync(file, await out.save({ useObjectStreams: false }));
}

type Ocr = Awaited<ReturnType<typeof lineWorker>>;

async function ocrOf(file: string, cache: string, w: Ocr): Promise<OcrPage> {
	if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
	const doc = mupdf.Document.openDocument(new Uint8Array(fs.readFileSync(file)), 'application/pdf');
	const img = renderGray(mupdf, doc, 0, DPI_OCR);
	destroy(doc);
	const r = await w.recognize(encode(mupdf, img, 'png'), img.w, img.h, DPI_OCR);
	fs.writeFileSync(cache, JSON.stringify(r));
	return r;
}

async function writeAfter(before: Uint8Array, ocr: OcrPage, spaces: Spaces, stretch: Stretch, snap: number, file: string) {
	const doc = await PL.PDFDocument.load(before, { updateMetadata: false });
	const font = new GlyphlessFont(doc);
	const st = addTextLayer(doc, 0, ocr, font, spaces, stretch, snap);
	font.finish();
	const bytes = await doc.save({ useObjectStreams: false });
	fs.writeFileSync(file, bytes);
	return { ...st, bytes: new Uint8Array(bytes) };
}

async function checkPage(id: string, p: Pick & { rotateTo?: number; turn?: boolean }, w: Ocr) {
	const dir = path.join(OUT, 'pages', id);
	fs.mkdirSync(dir, { recursive: true });
	const beforeF = path.join(dir, 'before.pdf');
	if (!fs.existsSync(beforeF)) await makeBefore(p, beforeF);
	const before = new Uint8Array(fs.readFileSync(beforeF));
	const ocr = await ocrOf(beforeF, path.join(dir, 'ocr.json'), w);
	const k = 72 / ocr.dpi;
	const gold: { t: string; b: B; lineEnd: boolean; line: number }[] = [];
	ocr.lines.forEach((l, li) => l.words.forEach((x, i) => gold.push({ t: x[0], b: [x[1] * k, x[2] * k, x[3] * k, x[4] * k], lineEnd: i === l.words.length - 1, line: li })));

	const bDoc = mupdf.Document.openDocument(before, 'application/pdf');
	const bMu = mupdfPx(bDoc);
	// Existing text on the page (partial pages): how much of it the OCR repeats.
	const existing = pageTextOf(bDoc, 0);
	const bp = bDoc.loadPage(0);
	const [bx0, by0, bx1, by1] = bp.getBounds();
	destroy(bp);
	const exB = existing.words.map((x) => [x.box.x * (bx1 - bx0), x.box.y * (by1 - by0), (x.box.x + x.box.w) * (bx1 - bx0), (x.box.y + x.box.h) * (by1 - by0)] as B);
	const dupOfExisting = exB.filter((e) => gold.some((g) => iou(e, g.b) > 0.3)).length;
	destroy(bDoc);
	const bPj = await pdfjsPage(before);
	const bPp = popplerPx(beforeF);
	const beforePacked = await qpdfPack(before);

	const res: Record<string, unknown> = {
		id,
		source: p.source,
		file: path.basename(p.path),
		page: p.page,
		kind: p.turn ? 'rotate90-upright' : p.rotateTo ? `rotate${p.rotateTo}-sideways` : p.kind,
		W: r2(bx1 - bx0),
		H: r2(by1 - by0),
		ocrMs: ocr.ms,
		ocrWords: gold.length,
		ocrLines: ocr.lines.length,
		nonAscii: gold.filter((g) => /[^\x20-\x7e]/.test(g.t)).length,
		nonAsciiChars: [...new Set(gold.flatMap((g) => [...g.t].filter((c) => /[^\x20-\x7e]/.test(c))))].join(''),
		linesOver3deg: ocr.lines.filter((l) => l.baseline && Math.abs(Math.atan2(l.baseline[3] - l.baseline[1], l.baseline[2] - l.baseline[0])) > (3 * Math.PI) / 180).length,
		existingWords: existing.words.length,
		dupOfExisting,
		beforeBytes: before.length,
		beforePacked
	};
	for (const sp of VARIANTS) {
		const [spaces, stretch, snap] = sp.split('-') as [Spaces, Stretch, string];
		const afterF = path.join(dir, `after-${sp}.pdf`);
		const st = await writeAfter(before, ocr, spaces, stretch, Number(snap), afterF);
		const aDoc = mupdf.Document.openDocument(st.bytes, 'application/pdf');
		const aPj = await pdfjsPage(st.bytes);
		const pg = aDoc.loadPage(0);
		const stext = pg.toStructuredText('preserve-whitespace');
		const muText = stext.asText();
		destroy(stext);
		destroy(pg);
		const hl = hlScore(aDoc, gold);
		const se = searchScore(aDoc, gold);
		const r = {
			px: { mupdf: diffCount(bMu, mupdfPx(aDoc)), pdfjs: diffCount(bPj.px, aPj.px), poppler: diffCount(bPp, popplerPx(afterF)) },
			text: {
				mupdf: textScore(gold, muText),
				pdfjs: textScore(gold, aPj.text),
				pdftotext: textScore(gold, pdftotext(afterF, false)),
				pdftotextLayout: textScore(gold, pdftotext(afterF, true))
			},
			hl: {
				words: hl.words,
				offered: hl.offered,
				split: hl.split,
				merged: hl.merged,
				miss1pt: hl.miss,
				flood: hl.flood,
				skipped: hl.skipped,
				iouP10: r2(q(hl.ious, 0.1)),
				iouP50: r2(q(hl.ious, 0.5)),
				edgeP50: r2(q(hl.edges, 0.5)),
				edgeP90: r2(q(hl.edges, 0.9)),
				vEdgeP50: r2(q(hl.vEdges, 0.5)),
				vEdgeP90: r2(q(hl.vEdges, 0.9)),
				all: { iou: hl.ious.map(r2), edge: hl.edges.map(r2), vEdge: hl.vEdges.map(r2) }
			},
			search: se,
			contentBytes: st.contentBytes,
			afterBytes: st.bytes.length,
			afterPacked: await qpdfPack(st.bytes)
		};
		destroy(aDoc);
		res[sp] = r;
		fs.writeFileSync(path.join(dir, `text-${sp}-mupdf.txt`), muText);
		fs.writeFileSync(path.join(dir, `text-${sp}-pdfjs.txt`), aPj.text);
	}
	return res;
}

// ------------------------------------------------------------------ signatures

async function signedProbe(file: string, w: Ocr) {
	const dir = path.join(OUT, 'signed', path.basename(file, '.pdf'));
	fs.mkdirSync(dir, { recursive: true });
	const orig = new Uint8Array(fs.readFileSync(file));
	const tmp = path.join(dir, 'page1.pdf');
	await makeBefore({ path: file, page: 0 } as Pick, tmp);
	const ocr = await ocrOf(tmp, path.join(dir, 'ocr.json'), w);
	const sig = (f: string) => {
		try {
			return execFileSync('pdfsig', [f], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
				.split('\n')
				.filter((l) => /Signature Validation|Total document|Signed Ranges|not signed/i.test(l))
				.map((l) => l.trim())
				.join('; ');
		} catch (e) {
			return `pdfsig failed: ${String((e as Error).message).slice(0, 80)}`;
		}
	};
	// The app's path: load, change, write the whole file anew.
	const full = await PL.PDFDocument.load(orig, { updateMetadata: false });
	const f1 = new GlyphlessFont(full);
	addTextLayer(full, 0, ocr, f1, 'gap');
	f1.finish();
	const fullF = path.join(dir, 'full-rewrite.pdf');
	fs.writeFileSync(fullF, await full.save({ useObjectStreams: false }));
	// Incremental update: original bytes kept, changes appended.
	const inc = await PL.PDFDocument.load(orig, { updateMetadata: false, forIncrementalUpdate: true } as never);
	const f2 = new GlyphlessFont(inc);
	addTextLayer(inc, 0, ocr, f2, 'gap');
	f2.finish();
	const incBytes = await (inc as unknown as { commit(): Promise<Uint8Array> }).commit();
	const incF = path.join(dir, 'incremental.pdf');
	fs.writeFileSync(incF, incBytes);
	const prefixKept = incBytes.length > orig.length && Buffer.from(incBytes.subarray(0, orig.length)).equals(Buffer.from(orig));
	return { file: path.basename(file), original: sig(file), fullRewrite: sig(fullF), incremental: sig(incF), incrementalKeepsOriginalBytes: prefixKept, incrementalGrowth: incBytes.length - orig.length };
}

// ------------------------------------------------------------------ main

const picks = JSON.parse(fs.readFileSync(path.join(OUT, 'pages.json'), 'utf8')) as (Pick & { rotateTo?: number; turn?: boolean })[];
// Two extra pages from the first archive scan: /Rotate 90 added to the upright page (text
// shows sideways), and the scan stored sideways with /Rotate 90 showing it upright.
const firstScan = picks.find((p) => p.kind === 'scan' && p.source === 'archive-org-scans') ?? picks.find((p) => p.kind === 'scan');
if (firstScan) picks.push({ ...firstScan, rotateTo: 90 }, { ...firstScan, turn: true });
const only = process.argv.includes('--only') ? Number(process.argv[process.argv.indexOf('--only') + 1]) : null;

const w = await lineWorker('fast');
const resultsF = path.join(OUT, 'results.jsonl');
const done = new Map<string, string>();
if (fs.existsSync(resultsF)) for (const l of fs.readFileSync(resultsF, 'utf8').split('\n').filter(Boolean)) done.set(JSON.parse(l).id, l);
try {
	for (let i = 0; i < picks.length; i++) {
		if (only !== null && i !== only) continue;
		const id = `p${String(i).padStart(2, '0')}`;
		if (done.has(id) && only === null) continue;
		const t0 = performance.now();
		try {
			const r = await checkPage(id, picks[i], w);
			done.set(id, JSON.stringify(r));
			console.log(id, r.kind, r.ocrWords, 'words', Math.round(performance.now() - t0), 'ms');
		} catch (e) {
			console.log(id, 'FAILED', String(e).slice(0, 200));
			done.set(id, JSON.stringify({ id, error: String(e).slice(0, 500) }));
		}
		fs.writeFileSync(resultsF, [...done.values()].join('\n') + '\n');
	}
	if (only === null) {
		// Signed survey files: the first signed one of qpdf-tests and of signed-pdfs (none has image-only pages).
		const local = new Set(fs.readFileSync('/home/garrett/pdf-survey/local-files.txt', 'utf8').split('\n').map((x) => x.trim()));
		const profiles = fs
			.readFileSync('/home/garrett/pdf-survey/out-baseline-2026-11-10/profiles.jsonl', 'utf8')
			.split('\n')
			.filter(Boolean)
			.map((l) => JSON.parse(l) as { path: string; source: string; status: string; encryption: string; form?: { signed?: boolean } });
		const signed = ['qpdf-tests', 'signed-pdfs']
			.map((src) => profiles.find((p) => p.source === src && p.status === 'ok' && p.encryption === 'none' && p.form?.signed && !local.has(p.path) && /signed/.test(path.basename(p.path)) === (src === 'qpdf-tests'))?.path)
			.filter((x): x is string => !!x);
		const out = [];
		for (const f of signed) out.push(await signedProbe(f, w));
		fs.writeFileSync(path.join(OUT, 'signed.json'), JSON.stringify(out, null, 1));
		console.log(out);
	}
} finally {
	await w.terminate();
}
