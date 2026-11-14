/**
 * Child process for tools/bilevel/measure.ts: one PDF per job (the owner's notice, a hard
 * case from hard.ts, or a survey file; survey files and the notice are untrusted or private
 * data and are only read). Nothing is written next to the inputs.
 *
 * Per file:
 *  1. Open with the real engine (Engine.openPdf: qpdf repairs and normalises), then MuPDF.
 *  2. Each page (up to MAX_WALK): what it draws (MuPDF device). A "scanned page" has one
 *     picture covering at least 85% of it. Up to `maxPages` scanned pages, spread over the
 *     file, are tried: structural refusals first (visible text or drawings on top, other
 *     pictures, already 1-bit, masks, colour space, filter, /Decode, resolution, size), then
 *     the picture is decoded and engine/bilevel.ts decides (qualify test, threshold,
 *     "nothing vanished"), timed step by step.
 *  3. Converted pictures are encoded as CCITT G4 and as Flate (1 bit, PNG predictors;
 *     libdeflate level 12, as the export's stream pass would), and written back in place
 *     with qpdf (--update-from-json, every other object byte for byte).
 *  4. The written file is read back: MuPDF and PDF.js (wasm decoder and its JS fallback)
 *     must give exactly the intended bits; MuPDF renders of the old and new page at 75 dpi
 *     are compared as a cross-check of the picture-space check.
 *  5. Review images (original beside black/white at 100%, a text area and the worst cell)
 *     for converted pages and borderline refusals, into the scratchpad review folder.
 */
import fs from 'node:fs';
import path from 'node:path';
import type * as MU from 'mupdf';
import {
	BILEVEL_RULES,
	COARSE,
	analyse,
	binarize,
	encodeG4,
	flateRows,
	rowBytesOf,
	sameBits,
	vanished,
	type BilevelRules,
	type VanishReport
} from '../../src/lib/engine/bilevel';
import { libdeflateZlib } from '../../src/lib/engine/libdeflate';
import { disown, mupdf, type Mupdf } from '../../src/lib/engine/mupdf';
import type { QpdfObject } from '../../src/lib/engine/pack';
import { QPDF_OK, QPDF_WARNINGS } from '../../src/lib/engine/qpdf';
import { findCandidates, type Candidate } from '../../src/lib/engine/shrink';
import { engine, loadPdfjs, qpdf } from '../survey/lib/engine';
import { repoRoot } from '../survey/lib/paths';
import { serveJobs } from '../survey/lib/pool';
import { synthScan, type SynthTraits } from './synth';

export interface BlJob {
	id: string;
	path: string;
	kind: 'notice' | 'hard' | 'survey' | 'synth';
	source: string;
	half: 'tune' | 'held' | 'notice' | 'hard';
	/** synth: the born-digital page (0-based) made into a scan, and the seed of its scanner traits. */
	page?: number;
	seed?: number;
	expect?: string;
	maxPages: number;
	reviewDir: string;
	/** Rule overrides (tuning runs). */
	rules?: Partial<BilevelRules>;
	/** Make review images for every converted page (else: the first MAX_REVIEW_PER_FILE). */
	reviewAll?: boolean;
	/** Make review images for every refused page that could be binarized too. */
	reviewRefused?: boolean;
}

export type Structural =
	| 'visible text'
	| 'drawing on top'
	| 'other pictures'
	| 'already 1-bit'
	| 'mask'
	| 'colour space'
	| 'filter'
	| 'decode'
	| 'nested or inline'
	| 'shared picture'
	| 'low resolution'
	| 'too large'
	| 'unreadable';

export interface PageRow {
	page: number;
	status: 'converted' | 'refused';
	/** Structural reason, or bilevel.ts's Refusal, or 'no gain'. */
	reason?: string;
	invisibleText: boolean;
	w: number;
	h: number;
	n?: number;
	ppi: number;
	filter?: string;
	/** Stored stream size of the original picture. */
	before?: number;
	g4?: number;
	flate?: number;
	flateNone?: number;
	stats?: { threshold: number; paper: number; ink: number; inkShare: number; colourBlocks: number; greyBlocks: number; orphanShare: number };
	check?: CheckRow;
	rendered?: { lossFine: number; gainFine: number; lossCoarse: number; gainCoarse: number };
	ms?: { decode: number; analyse: number; binarize: number; check: number; g4: number; flate: number };
	verify?: { mupdf: boolean; pdfjs: boolean; pdfjsFallback: boolean };
	/** synth: the check run against the clean render (the page before scanner traits). */
	oracle?: CheckRow;
	review?: string;
}

export interface CheckRow {
	ok: boolean;
	lossFine: number;
	gainFine: number;
	lossCoarse: number;
	gainCoarse: number;
	/** Largest lost / gained region: extent (inch) and mean (0–255). */
	lostExtent: number;
	lostMean: number;
	gainedExtent: number;
	gainedMean: number;
	lostAt?: [number, number];
	gainedAt?: [number, number];
}

export interface BlResult {
	id: string;
	path: string;
	kind: BlJob['kind'];
	source: string;
	half: BlJob['half'];
	expect?: string;
	size: number;
	/** The engine's normalised bytes, before and after. */
	srcSize?: number;
	outSize?: number;
	open: 'ok' | 'error';
	message?: string;
	pageCount?: number;
	scanPages?: number;
	rows: PageRow[];
	/** synth: the scanner traits used. */
	traits?: SynthTraits;
	ms: number;
}


const MAX_WALK = 80;
const MAX_REVIEW_PER_FILE = 3;
const MIN_COVER = 0.85;
const MAX_IMAGE_PIXELS = 36_000_000;
/** A converted picture is kept only when G4 is at most this share of the stored stream. */
const GAIN = 0.5;
const PDFJS_WASM = path.join(repoRoot, 'node_modules/pdfjs-dist/wasm/');

type Mat = [number, number, number, number, number, number];
const ap = (m: Mat, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

interface Drawn {
	cover: number;
	ppi: number;
	w: number;
	h: number;
	bpc: number;
	mask: boolean;
	seq: number;
}
interface Walk {
	pics: Drawn[];
	text: { visible: boolean; seq: number }[];
	paths: number[];
}

function walkPage(m: Mupdf, page: MU.PDFPage): Walk | null {
	const [x0, y0, x1, y1] = page.getBounds();
	const W = x1 - x0;
	const H = y1 - y0;
	if (!(W > 0 && H > 0)) return null;
	let seq = 0;
	const w: Walk = { pics: [], text: [], paths: [] };
	const onImage = (img: MU.Image, ctm: Mat, mask: boolean) => {
		const pts = [ap(ctm, 0, 0), ap(ctm, 1, 0), ap(ctm, 0, 1), ap(ctm, 1, 1)];
		const xs = pts.map((p) => p[0] - x0);
		const ys = pts.map((p) => p[1] - y0);
		const bw = Math.max(0, Math.min(W, Math.max(...xs)) - Math.max(0, Math.min(...xs)));
		const bh = Math.max(0, Math.min(H, Math.max(...ys)) - Math.max(0, Math.min(...ys)));
		const pw = img.getWidth();
		const ph = img.getHeight();
		const a = Math.hypot(ctm[0], ctm[1]) / 72;
		const b = Math.hypot(ctm[2], ctm[3]) / 72;
		w.pics.push({ cover: (bw * bh) / (W * H), ppi: Math.min(pw / Math.max(1e-6, a), ph / Math.max(1e-6, b)), w: pw, h: ph, bpc: img.getBitsPerComponent(), mask, seq: seq++ });
	};
	const dl = page.toDisplayList(false);
	const dev = new m.Device({
		fillText: () => void w.text.push({ visible: true, seq: seq++ }),
		strokeText: () => void w.text.push({ visible: true, seq: seq++ }),
		clipText: () => void w.text.push({ visible: true, seq: seq++ }),
		clipStrokeText: () => void w.text.push({ visible: true, seq: seq++ }),
		ignoreText: () => void w.text.push({ visible: false, seq: seq++ }),
		fillPath: () => void w.paths.push(seq++),
		strokePath: () => void w.paths.push(seq++),
		fillImage: (img, ctm) => onImage(img, ctm as Mat, false),
		fillImageMask: (img, ctm) => onImage(img, ctm as Mat, true),
		clipImageMask: (img, ctm) => onImage(img, ctm as Mat, true),
		fillShade(shade) {
			disown(shade);
			w.paths.push(seq++);
		}
	});
	try {
		dl.run(dev, m.Matrix.identity);
	} finally {
		try {
			dev.close();
		} catch {
			// Closed.
		}
		dev.destroy();
		dl.destroy();
	}
	return w;
}

/** Why a page's covering picture is not a candidate, from the page's image XObjects. */
function whyNotCandidate(page: MU.PDFObject, w: number, h: number): Structural {
	const res = page.getInheritable('Resources');
	const xo = res.isDictionary() ? res.get('XObject') : null;
	let found: MU.PDFObject | null = null;
	xo?.forEach((v) => {
		if (found || !v.isStream()) return;
		const sub = v.get('Subtype');
		if (!sub.isName() || sub.asName() !== 'Image') return;
		const iw = v.get('Width');
		const ih = v.get('Height');
		if (iw.isNumber() && ih.isNumber() && iw.asNumber() === w && ih.asNumber() === h) found = v;
	});
	if (!found) return 'nested or inline';
	const o = found as MU.PDFObject;
	if (!o.get('SMask').isNull() || !o.get('Mask').isNull() || (o.get('ImageMask').isBoolean() && o.get('ImageMask').asBoolean())) return 'mask';
	const bpc = o.get('BitsPerComponent');
	if (bpc.isNumber() && bpc.asNumber() === 1) return 'already 1-bit';
	const f = o.get('Filter');
	const names: string[] = [];
	if (f.isName()) names.push(f.asName());
	else if (f.isArray()) f.forEach((x) => x.isName() && names.push(x.asName()));
	if (names.some((x) => /JPX|JBIG2|CCITT|Crypt/.test(x))) return 'filter';
	if (!o.get('Decode').isNull()) return 'decode';
	if (bpc.isNumber() && bpc.asNumber() !== 8) return 'filter';
	return 'colour space';
}

/** What the first filter of a stream is called (for the report). */
function filterOf(o: MU.PDFObject): string {
	const f = o.get('Filter');
	if (f.isName()) return f.asName();
	if (f.isArray() && f.length > 0 && f.get(0).isName()) return f.get(0).asName();
	return 'none';
}

const now = () => performance.now();

interface Converted {
	row: PageRow;
	cand: Candidate;
	bits: Uint8Array;
	g4: Uint8Array;
	samples: Uint8Array;
	n: 1 | 3;
	paper: number;
	ink: number;
	at: [number, number][];
}

/** Where the review should look: the largest lost and gained regions (centred), else the largest fine loss. */
function spots(c: VanishReport | null): [number, number][] {
	if (!c) return [];
	const out = [c.lost, c.gained].filter((r) => !!r).map((r) => r!.at);
	return out.length ? out : [c.at];
}

serveJobs<BlJob, BlResult>(async (job, io) => {
	const t0 = Date.now();
	let bytes: Uint8Array = new Uint8Array(fs.readFileSync(job.path));
	const r: BlResult = { id: job.id, path: job.path, kind: job.kind, source: job.source, half: job.half, expect: job.expect, size: bytes.length, open: 'error', rows: [], ms: 0 };
	let clean: Uint8Array | null = null;
	if (job.kind === 'synth') {
		io.progress('synth');
		try {
			const s = await synthScan(await mupdf(), bytes, job.page ?? 0, job.seed ?? 1);
			if (!s) {
				r.message = 'page not usable for a synthetic scan';
				r.ms = Date.now() - t0;
				io.result(r);
				return;
			}
			bytes = s.pdf;
			clean = s.clean;
			r.traits = s.traits;
			r.size = bytes.length;
		} catch (e) {
			r.message = `synth: ${e instanceof Error ? e.message.slice(0, 160) : String(e)}`;
			r.ms = Date.now() - t0;
			io.result(r);
			return;
		}
	}
	const rules: BilevelRules = { ...BILEVEL_RULES, ...job.rules };
	io.progress('open');
	let src: Uint8Array;
	try {
		src = (await engine().openPdf(bytes, 'input.pdf')).bytes;
		r.open = 'ok';
		r.srcSize = src.length;
	} catch (e) {
		r.message = e instanceof Error ? e.message.slice(0, 200) : String(e);
		r.ms = Date.now() - t0;
		io.result(r);
		return;
	}
	const m = await mupdf();
	m.setLog({ error: () => {}, warning: () => {} });
	const doc = new m.PDFDocument(src);
	const converted: Converted[] = [];
	try {
		const count = doc.countPages();
		r.pageCount = count;
		// Scanned pages among the first MAX_WALK.
		const scans: { p: number; walk: Walk; pic: Drawn }[] = [];
		for (let p = 0; p < Math.min(count, MAX_WALK); p++) {
			const page = doc.loadPage(p) as MU.PDFPage;
			try {
				const walk = walkPage(m, page);
				const pic = walk?.pics.filter((x) => x.cover >= MIN_COVER).sort((a, b) => b.ppi - a.ppi)[0];
				if (walk && pic) scans.push({ p, walk, pic });
			} catch {
				// Unreadable page: not counted.
			} finally {
				page.destroy();
			}
		}
		r.scanPages = scans.length;
		const k = Math.min(job.maxPages, scans.length);
		const pick = k === scans.length ? scans : Array.from({ length: k }, (_, i) => scans[Math.round((i * (scans.length - 1)) / Math.max(1, k - 1))]);
		io.progress('candidates');
		const cands = findCandidates(doc);
		for (const { p, walk, pic } of pick) {
			io.progress(`page ${p}`);
			const invisibleText = walk.text.some((t) => !t.visible);
			const row: PageRow = { page: p, status: 'refused', invisibleText, w: pic.w, h: pic.h, ppi: Math.round(pic.ppi) };
			r.rows.push(row);
			const refuse = (why: string) => void (row.reason = why);
			// Text or drawings count only when drawn on top of the picture, or beside it.
			const hidden = (seq: number) => seq < pic.seq && pic.cover >= 0.995;
			if (walk.text.some((t) => t.visible && !hidden(t.seq))) {
				refuse('visible text');
				continue;
			}
			if (walk.paths.some((s) => !hidden(s))) {
				refuse('drawing on top');
				continue;
			}
			if (pic.mask || pic.bpc === 1) {
				refuse('already 1-bit');
				continue;
			}
			if (walk.pics.length > 1) {
				refuse('other pictures');
				continue;
			}
			if (pic.w * pic.h > MAX_IMAGE_PIXELS) {
				refuse('too large');
				continue;
			}
			if (Math.round(pic.ppi) < rules.minPpi) {
				refuse('low resolution');
				continue;
			}
			const onPage = cands.filter((c) => c.pages.has(p) && c.width === pic.w && c.height === pic.h);
			if (onPage.length !== 1) {
				refuse(whyNotCandidate(doc.findPage(p), pic.w, pic.h));
				continue;
			}
			const cand = onPage[0];
			const obj = doc.newIndirect(cand.num);
			row.filter = filterOf(obj);
			row.before = cand.rawLength;
			row.n = cand.n;
			if (!obj.get('SMask').isNull()) {
				refuse('mask');
				continue;
			}
			if (cand.pages.size > 1) {
				refuse('shared picture');
				continue;
			}
			// Decode.
			let t = now();
			const buf = obj.readStream();
			const samples = buf.asUint8Array().slice();
			buf.destroy();
			m.emptyStore();
			const decodeMs = now() - t;
			if (samples.length !== cand.width * cand.height * cand.n) {
				refuse('unreadable');
				continue;
			}
			t = now();
			const a = analyse(samples, cand.width, cand.height, cand.n, pic.ppi, rules);
			const analyseMs = now() - t;
			row.stats = { threshold: a.threshold, paper: a.paper, ink: a.ink, inkShare: +a.inkShare.toFixed(4), colourBlocks: a.colourBlocks, greyBlocks: a.greyBlocks, orphanShare: +a.orphanShare.toFixed(5) };
			// Binarize and check every page whose levels could be found, refused or not, so the
			// report can show how the check behaves on refused pages too.
			const levelsOk = a.reason !== 'contrast' && a.reason !== 'resolution';
			let bits: Uint8Array | null = null;
			let check: VanishReport | null = null;
			let binMs = 0;
			let checkMs = 0;
			if (levelsOk) {
				t = now();
				bits = binarize(a.grey, cand.width, cand.height, a.threshold);
				binMs = now() - t;
				t = now();
				check = vanished(a.grey, bits, cand.width, cand.height, pic.ppi, a.paper, a.ink, rules);
				checkMs = now() - t;
				row.check = checkRow(check);
			}
			row.ms = { decode: Math.round(decodeMs), analyse: Math.round(analyseMs), binarize: Math.round(binMs), check: Math.round(checkMs), g4: 0, flate: 0 };
			if (!a.ok) {
				refuse(a.reason!);
			} else if (!check!.ok) {
				refuse('vanished');
			}
			// Sizes for every page that could be binarized (refused ones too: what it would have saved).
			if (bits) {
				t = now();
				const g4 = encodeG4(bits, cand.width, cand.height);
				row.ms.g4 = Math.round(now() - t);
				t = now();
				const fl = await libdeflateZlib(flateRows(bits, cand.width, cand.height), 12);
				row.ms.flate = Math.round(now() - t);
				const fn = await libdeflateZlib(bits, 12);
				row.g4 = g4.length;
				row.flate = fl.length;
				row.flateNone = fn.length;
				if (!row.reason && g4.length > GAIN * cand.rawLength) refuse('no gain');
				if (clean && clean.length === cand.width * cand.height) row.oracle = checkRow(vanished(clean, bits, cand.width, cand.height, pic.ppi, 255, 0, rules));
				if (!row.reason) {
					row.status = 'converted';
					converted.push({ row, cand, bits, g4, samples, n: cand.n, paper: a.paper, ink: a.ink, at: spots(check) });
				} else if (job.reviewRefused || (borderline(row, rules) && reviewBudget(job, r))) {
					row.review = review(m, job, p, samples, cand.n, bits, cand.width, cand.height, spots(check), 'refused');
				}
			}
		}
		if (converted.length) {
			io.progress('write');
			const out = await writeBack(src, converted);
			if (!out) {
				for (const c of converted) c.row.verify = { mupdf: false, pdfjs: false, pdfjsFallback: false };
			} else {
				r.outSize = out.length;
				io.progress('verify');
				await verify(m, doc, out, converted);
			}
			let reviewed = 0;
			for (const c of converted) {
				if (!job.reviewAll && reviewed >= MAX_REVIEW_PER_FILE) break;
				c.row.review = review(m, job, c.row.page, c.samples, c.n, c.bits, c.cand.width, c.cand.height, c.at, 'ok');
				reviewed++;
			}
		}
	} catch (e) {
		r.message = e instanceof Error ? e.message.slice(0, 200) : String(e);
	} finally {
		doc.destroy();
		m.emptyStore();
	}
	r.ms = Date.now() - t0;
	io.result(r);
});

function checkRow(c: VanishReport): CheckRow {
	return {
		ok: c.ok,
		...round({ lossFine: c.lossFine, gainFine: c.gainFine, lossCoarse: c.lossCoarse, gainCoarse: c.gainCoarse }),
		lostExtent: +(c.lost?.extent ?? 0).toFixed(3),
		lostMean: Math.round(c.lost?.mean ?? 0),
		gainedExtent: +(c.gained?.extent ?? 0).toFixed(3),
		gainedMean: Math.round(c.gained?.mean ?? 0),
		lostAt: c.lost?.at,
		gainedAt: c.gained?.at
	};
}

function round<T extends Record<string, number | boolean>>(o: T): T {
	const out: Record<string, number | boolean> = {};
	for (const [k, v] of Object.entries(o)) out[k] = typeof v === 'number' ? Math.round(v * 10) / 10 : v;
	return out as T;
}

/** Refused for a measured reason close to its limit (worth a look). */
function borderline(row: PageRow, rules: BilevelRules): boolean {
	const s = row.stats;
	const c = row.check;
	if (!s || !c) return false;
	if (row.reason === 'vanished') return true;
	if (row.reason === 'colour') return s.colourBlocks <= rules.maxColourBlocks * 4;
	if (row.reason === 'grey') return s.greyBlocks <= rules.maxGreyBlocks * 3 && s.orphanShare <= rules.maxOrphanShare * 3;
	return false;
}

let borderlineReviews = 0;
function reviewBudget(job: BlJob, _r: BlResult): boolean {
	return job.kind !== 'survey' || borderlineReviews++ < 4;
}

// --- writing back and reading back ---------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

async function writeBack(bytes: Uint8Array, conv: Converted[]): Promise<Uint8Array | null> {
	const q = qpdf();
	const res = await q.run({ args: ['--json-output', '--json-stream-data=none', '/l.pdf', '/l.json'], inputs: { '/l.pdf': bytes }, outputs: ['/l.json'] });
	const file = res.files.get('/l.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, Json>, Record<string, QpdfObject>] };
	const [header, objects] = parsed.qpdf;
	const updates: Record<string, unknown> = {};
	const inputs: Record<string, Uint8Array> = { '/p.pdf': bytes };
	conv.forEach((c, i) => {
		const key = Object.keys(objects).find((k) => new RegExp(`^obj:${c.cand.num} \\d+ R$`).test(k));
		const old = key ? objects[key]?.stream?.dict : undefined;
		if (!key || !old) throw new Error(`object ${c.cand.num} not found`);
		const dict: Record<string, Json> = {
			...(old as Record<string, Json>),
			'/Width': c.cand.width,
			'/Height': c.cand.height,
			'/BitsPerComponent': 1,
			'/ColorSpace': '/DeviceGray',
			'/Filter': '/CCITTFaxDecode',
			'/DecodeParms': { '/K': -1, '/Columns': c.cand.width, '/Rows': c.cand.height }
		};
		for (const k of ['/DL', '/Length', '/Decode']) delete dict[k];
		updates[key] = { stream: { dict, datafile: `/u/${i}` } };
		inputs[`/u/${i}`] = c.g4;
	});
	inputs['/u.json'] = new TextEncoder().encode(JSON.stringify({ qpdf: [header, updates] }));
	const w = await q.run({
		args: ['/p.pdf', '--update-from-json=/u.json', '--compress-streams=n', '--decode-level=none', '--object-streams=disable', '/q.pdf'],
		inputs,
		outputs: ['/q.pdf']
	});
	const out = w.files.get('/q.pdf');
	return (w.code === QPDF_OK || w.code === QPDF_WARNINGS) && out ? out : null;
}

async function verify(m: Mupdf, orig: MU.PDFDocument, out: Uint8Array, conv: Converted[]) {
	const nd = new m.PDFDocument(out);
	try {
		for (const c of conv) {
			const w = c.cand.width;
			const h = c.cand.height;
			const buf = nd.newIndirect(c.cand.num).readStream();
			const dec = buf.asUint8Array();
			const mu = dec.length === rowBytesOf(w) * h && sameBits(dec, c.bits, w, h);
			buf.destroy();
			c.row.verify = { mupdf: mu, pdfjs: false, pdfjsFallback: false };
			c.row.rendered = renderedCheck(m, orig, nd, c.row.page, c.paper, c.ink);
			m.emptyStore();
		}
	} finally {
		nd.destroy();
	}
	for (const wasm of [true, false]) {
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: out.slice(), isOffscreenCanvasSupported: false, wasmUrl: PDFJS_WASM, useWasm: wasm, verbosity: 0, useSystemFonts: false, disableFontFace: true } as never);
		try {
			const d = await task.promise;
			for (const c of conv) {
				const page = await d.getPage(c.row.page + 1);
				const ops = await page.getOperatorList();
				let ok = false;
				for (let i = 0; i < ops.fnArray.length; i++) {
					if (ops.fnArray[i] !== lib.OPS.paintImageXObject) continue;
					const id = ops.argsArray[i][0] as string;
					const img = (await new Promise((res) => page.objs.get(id, res))) as { width: number; height: number; kind: number; data?: Uint8Array } | null;
					ok = !!img?.data && img.kind === 1 && img.width === c.cand.width && img.height === c.cand.height && sameBits(img.data, c.bits, c.cand.width, c.cand.height);
				}
				if (wasm) c.row.verify!.pdfjs = ok;
				else c.row.verify!.pdfjsFallback = ok;
				page.cleanup();
			}
		} catch {
			// Stays false.
		} finally {
			await task.destroy();
		}
	}
}

/** MuPDF renders of the page before and after at 75 dpi (grey), compared as bilevel.vanished does. */
function renderedCheck(m: Mupdf, a: MU.PDFDocument, b: MU.PDFDocument, p: number, paper: number, ink: number) {
	const pa = a.loadPage(p);
	const pb = b.loadPage(p);
	try {
		const mtx = m.Matrix.scale(75 / 72, 75 / 72);
		const xa = pa.toPixmap(mtx, m.ColorSpace.DeviceGray, false, true);
		const xb = pb.toPixmap(mtx, m.ColorSpace.DeviceGray, false, true);
		const w = xa.getWidth();
		const h = xa.getHeight();
		const sa = xa.getStride();
		const sb = xb.getStride();
		const A = xa.getPixels();
		const B = xb.getPixels();
		const c = Math.max(1, paper - ink);
		const d = new Float64Array(w * h);
		let lossFine = 0;
		let gainFine = 0;
		for (let y = 0; y < h; y++)
			for (let x = 0; x < w; x++) {
				const o = Math.max(0, Math.min(255, ((A[y * sa + x] - ink) * 255) / c));
				const v = B[y * sb + x] - o;
				d[y * w + x] = v;
				lossFine = Math.max(lossFine, v);
				gainFine = Math.max(gainFine, -v);
			}
		let lossCoarse = 0;
		let gainCoarse = 0;
		for (let y = 0; y + COARSE <= h; y++)
			for (let x = 0; x + COARSE <= w; x++) {
				let s = 0;
				for (let yy = y; yy < y + COARSE; yy++) for (let xx = x; xx < x + COARSE; xx++) s += d[yy * w + xx];
				s /= COARSE * COARSE;
				lossCoarse = Math.max(lossCoarse, s);
				gainCoarse = Math.max(gainCoarse, -s);
			}
		xa.destroy();
		xb.destroy();
		return round({ lossFine, gainFine, lossCoarse, gainCoarse });
	} finally {
		pa.destroy();
		pb.destroy();
	}
}

// --- review images ---------------------------------------------------------------------------

const CROP_W = 500;
const CROP_H = 300;

/** Top-left of the CROP_W × CROP_H window with the most ink (coarse search). */
function inkiest(bits: Uint8Array, w: number, h: number): [number, number] {
	const G = 16;
	const gw = Math.ceil(w / G);
	const gh = Math.ceil(h / G);
	const ink = new Float64Array(gw * gh);
	const rb = rowBytesOf(w);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!(bits[y * rb + (x >> 3)] & (0x80 >> (x & 7)))) ink[Math.floor(y / G) * gw + Math.floor(x / G)]++;
	const ww = Math.min(gw, Math.ceil(CROP_W / G));
	const wh = Math.min(gh, Math.ceil(CROP_H / G));
	let best = -1;
	let at: [number, number] = [0, 0];
	for (let gy = 0; gy + wh <= gh; gy += 2)
		for (let gx = 0; gx + ww <= gw; gx += 2) {
			let s = 0;
			for (let y = gy; y < gy + wh; y++) for (let x = gx; x < gx + ww; x++) s += ink[y * gw + x];
			// Prefer text-like ink (not a solid black block): penalise windows over 35% ink.
			const share = s / (ww * wh * G * G);
			const score = share > 0.35 ? s * 0.2 : s;
			if (score > best) {
				best = score;
				at = [gx * G, gy * G];
			}
		}
	return at;
}

function review(m: Mupdf, job: BlJob, page: number, samples: Uint8Array, n: 1 | 3, bits: Uint8Array, w: number, h: number, worst: [number, number][], tag: string): string {
	const cw = Math.min(CROP_W, w);
	const ch = Math.min(CROP_H, h);
	const clampAt = ([x, y]: [number, number]): [number, number] => [Math.max(0, Math.min(w - cw, Math.round(x))), Math.max(0, Math.min(h - ch, Math.round(y)))];
	// A text area, then each spot the check looked at hardest (a region's corner, so not centred exactly).
	const at = [clampAt(inkiest(bits, w, h)), ...worst.slice(0, 2).map((p) => clampAt([p[0] - cw / 3, p[1] - ch / 3]))];
	const gap = 8;
	const W = cw * 2 + gap;
	const H = ch * at.length + gap * (at.length - 1);
	const pix = new m.Pixmap(m.ColorSpace.DeviceRGB, [0, 0, W, H], false);
	const px = pix.getPixels();
	const stride = pix.getStride();
	px.fill(200);
	const rb = rowBytesOf(w);
	const put = (ox: number, oy: number, [sx, sy]: [number, number]) => {
		for (let y = 0; y < ch; y++)
			for (let x = 0; x < cw; x++) {
				const i = (sy + y) * w + sx + x;
				const d = (oy + y) * stride + (ox + x) * 3;
				if (n === 3) {
					px[d] = samples[i * 3];
					px[d + 1] = samples[i * 3 + 1];
					px[d + 2] = samples[i * 3 + 2];
				} else px[d] = px[d + 1] = px[d + 2] = samples[i];
				const v = bits[(sy + y) * rb + ((sx + x) >> 3)] & (0x80 >> ((sx + x) & 7)) ? 255 : 0;
				const e = (oy + y) * stride + (ox + cw + gap + x) * 3;
				px[e] = px[e + 1] = px[e + 2] = v;
			}
	};
	at.forEach((p, i) => put(0, i * (ch + gap), p));
	const name = `${tag}-${job.half}-${job.id.replace(/[^\w.-]+/g, '_').slice(0, 40)}-p${page + 1}.png`;
	fs.mkdirSync(job.reviewDir, { recursive: true });
	const file = path.join(job.reviewDir, name);
	fs.writeFileSync(file, pix.asPNG());
	pix.destroy();
	return file;
}
