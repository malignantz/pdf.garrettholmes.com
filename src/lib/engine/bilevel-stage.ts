/**
 * "Make scanned pages black and white" in the engine (ExportOptions.bilevel). The rules and
 * the encoder are bilevel.ts (measured 2026-11-14, plan "Black and white scans"); this file
 * finds the pages, replaces their pictures in place and checks the result.
 *
 * Which pages (`scanPictureOf`): one picture covering at least 85% of the page at 200 ppi
 * or more (at most 36 MP), no visible text, paths or shadings drawn on top of it (an
 * invisible OCR layer is fine; anything drawn before a picture that covers at least 99.5%
 * of the page is hidden under it), no other picture, and the picture an 8-bit grey or RGB
 * image the engine can follow everywhere it is drawn (shrink.ts `findCandidates`: no masks,
 * /Decode, JPX/JBIG2/CCITT, annotation or pattern use), without a soft mask. The page is
 * walked on its content stream directly, never through a display list: mupdf.js wraps the
 * paths a display list hands to device callbacks and its finalizer then frees memory the
 * list owns (heap corruption, measured as traps on survey files).
 *
 * At export (`convertScans`, after the OCR layers and before crop, forms, redaction and
 * stamps): every page as above that has no redaction box, in a file that is not digitally
 * signed, whose picture is drawn only on such pages, is decoded and judged (bilevel.ts
 * `makeBilevel`: the qualify test, Otsu's threshold, "nothing vanished"); a picture that
 * passes becomes a 1-bit CCITT G4 image of the same pixel size, written back by qpdf
 * (--update-from-json: the page content and every other object byte for byte, so OCR text
 * stays where it was). Later stages leave 1-bit pictures alone (the print-size cap, fit
 * under a size, the JPEG repack and the stream pass only touch 8-bit or Flate images).
 *
 * The export check (`verifyBilevel`, VerifyCheck 'bilevel'), on the final bytes: each
 * converted page's picture is found again and decoded twice, by MuPDF and by bilevel.ts's
 * own G4 reader, and both must give exactly the intended bitmap (SHA-256). A page that fails
 * is built again with its picture left as it was (core.ts).
 *
 * Any doubt about a page leaves it as it was; the stage never fails an export.
 */

import type * as MU from 'mupdf';
import type { BilevelReport, ExportControl, ExportProgress, PageRef, Source, VerifyCheck } from '../core/types';
import type { EngineDeps } from './deps';
import { BILEVEL_RULES, bitsDigest, decodeG4, encodeG4, makeBilevel, rowBytesOf, type BilevelRules } from './bilevel';
import { EngineError } from './errors';
import { disown, isRetired, isWasmFault, rethrowFault, type Mupdf } from './mupdf';
import { imageCandidates } from './ocr/eligible';
import { isSigned, type QpdfObject } from './pack';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';
import { findCandidates, type Candidate } from './shrink';

export const BILEVEL_MIN_COVER = 0.85;
export const BILEVEL_MAX_PIXELS = 36_000_000;
/** A converted picture is used only when its G4 stream is at most this share of the stored one. */
export const BILEVEL_GAIN = 0.5;

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

/** What page `page` draws, in order (its content stream only: annotations stay on top unchanged). */
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
			// See mupdf.ts: the borrowed shade must not be freed by its wrapper.
			disown(shade);
			w.paths.push(seq++);
		}
	});
	try {
		page.runPageContents(dev, m.Matrix.identity);
	} finally {
		try {
			dev.close();
		} catch {
			// Closed.
		}
		dev.destroy();
	}
	return w;
}

/** Why a scanned page is not tried (for debugging and tests). */
export type PageRefusal = 'text' | 'drawing' | 'pictures' | 'bilevel already' | 'resolution' | 'too large' | 'picture' | 'unreadable';

export type ScanPicture = { ok: true; cand: Candidate; ppi: number } | { ok: false; why: PageRefusal };

/**
 * Whether page `index` of `doc` is a scanned page the conversion may try, and its picture;
 * null when the page is not a scanned page at all (no picture covering 85% of it).
 * `cands` is findCandidates(doc). Throws MuPDF traps only (other errors: 'unreadable').
 */
export function scanPictureOf(m: Mupdf, doc: MU.PDFDocument, index: number, cands: Candidate[]): ScanPicture | null {
	let walk: Walk | null;
	const page = doc.loadPage(index) as MU.PDFPage;
	try {
		try {
			const uu = page.getObject().get('UserUnit');
			if (uu && uu.isNumber() && uu.asNumber() !== 1) return null;
		} catch {
			// No UserUnit.
		}
		walk = walkPage(m, page);
	} catch (e) {
		rethrowFault(e);
		return { ok: false, why: 'unreadable' };
	} finally {
		page.destroy();
	}
	const pic = walk?.pics.filter((p) => p.cover >= BILEVEL_MIN_COVER).sort((a, b) => b.ppi - a.ppi)[0];
	if (!walk || !pic) return null;
	// Text or drawings count only when drawn on top of the picture, or beside it.
	const hidden = (seq: number) => seq < pic.seq && pic.cover >= 0.995;
	if (walk.text.some((t) => t.visible && !hidden(t.seq))) return { ok: false, why: 'text' };
	if (walk.paths.some((s) => !hidden(s))) return { ok: false, why: 'drawing' };
	if (pic.mask || pic.bpc === 1) return { ok: false, why: 'bilevel already' };
	if (walk.pics.length > 1) return { ok: false, why: 'pictures' };
	if (pic.w * pic.h > BILEVEL_MAX_PIXELS) return { ok: false, why: 'too large' };
	if (Math.round(pic.ppi) < BILEVEL_RULES.minPpi) return { ok: false, why: 'resolution' };
	const on = cands.filter((c) => c.pages.has(index) && c.width === pic.w && c.height === pic.h);
	if (on.length !== 1) return { ok: false, why: 'picture' };
	const cand = on[0];
	if (!doc.newIndirect(cand.num).get('SMask').isNull()) return { ok: false, why: 'picture' };
	return { ok: true, cand, ppi: Math.min(cand.width / cand.inW, cand.height / cand.inH) };
}

/**
 * Engine.bilevelPages: 0-based pages of a PDF source the conversion would try (the cheap
 * structural pass; the picture itself is judged at export). qpdf first, so files without a
 * big enough picture never load MuPDF.
 */
export async function bilevelPagesOf(qpdf: Qpdf, mupdf: () => Promise<Mupdf>, source: Source): Promise<number[]> {
	if (source.kind !== 'pdf') return [];
	const pre = await imageCandidates(qpdf, source.bytes, source.pages);
	if (!pre.length) return [];
	const m = await mupdf();
	const doc = new m.PDFDocument(source.bytes);
	try {
		const cands = findCandidates(doc);
		const out: number[] = [];
		for (const i of pre) {
			if (i >= doc.countPages()) continue;
			if (scanPictureOf(m, doc, i, cands)?.ok) out.push(i);
		}
		return out;
	} catch (e) {
		rethrowFault(e);
		return [];
	} finally {
		doc.destroy();
		m.emptyStore();
	}
}

/** Samples of a candidate picture as stored (8-bit grey or RGB), or null when they cannot be read cleanly. */
function samplesOf(m: Mupdf, doc: MU.PDFDocument, c: Candidate): Uint8Array | null {
	const complaints: string[] = [];
	m.setLog({ error: (x: string) => complaints.push(x), warning: (x: string) => complaints.push(x) });
	try {
		const buf = doc.newIndirect(c.num).readStream();
		try {
			const px = buf.asUint8Array();
			// A picture MuPDF reads with any complaint (damaged data it papers over) stays as it is.
			if (complaints.length || px.length !== c.width * c.height * c.n) return null;
			return px.slice();
		} finally {
			buf.destroy();
		}
	} finally {
		m.setLog(null);
		m.emptyStore();
	}
}

// --- the dialog's preview ---------------------------------------------------------------------

export interface BilevelPreview {
	width: number;
	height: number;
	/** PNG of the original crop and of the same crop in black and white, at 100%. */
	before: Uint8Array;
	after: Uint8Array;
}

/** Top-left of the cw × ch window with the most ink, avoiding solid black areas. */
function inkiest(bits: Uint8Array, w: number, h: number, cw: number, ch: number): [number, number] {
	const G = 16;
	const gw = Math.ceil(w / G);
	const gh = Math.ceil(h / G);
	const ink = new Float64Array(gw * gh);
	const rb = rowBytesOf(w);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!(bits[y * rb + (x >> 3)] & (0x80 >> (x & 7)))) ink[Math.floor(y / G) * gw + Math.floor(x / G)]++;
	const ww = Math.min(gw, Math.ceil(cw / G));
	const wh = Math.min(gh, Math.ceil(ch / G));
	let best = -1;
	let at: [number, number] = [0, 0];
	for (let gy = 0; gy + wh <= gh; gy++)
		for (let gx = 0; gx + ww <= gw; gx += 2) {
			let s = 0;
			for (let y = gy; y < gy + wh; y++) for (let x = gx; x < gx + ww; x++) s += ink[y * gw + x];
			const share = s / (ww * wh * G * G);
			const score = share > 0.35 ? s * 0.2 : s;
			if (score > best) {
				best = score;
				at = [gx * G, gy * G];
			}
		}
	return [Math.max(0, Math.min(w - cw, at[0])), Math.max(0, Math.min(h - ch, at[1]))];
}

/**
 * Engine.bilevelPreview: a 100% crop of a text area of page `index` before and after, or
 * null when the page would be left as it is (not a scanned page, or its picture fails the
 * qualify test or the "nothing vanished" check).
 */
export async function bilevelPreview(mupdf: () => Promise<Mupdf>, source: Source, index: number, size = { width: 260, height: 130 }): Promise<BilevelPreview | null> {
	if (source.kind !== 'pdf' || !Number.isInteger(index) || index < 0 || index >= source.pages.length) return null;
	const m = await mupdf();
	const doc = new m.PDFDocument(source.bytes);
	try {
		const cands = findCandidates(doc);
		const pic = scanPictureOf(m, doc, index, cands);
		if (!pic?.ok) return null;
		const c = pic.cand;
		const samples = samplesOf(m, doc, c);
		if (!samples) return null;
		const v = makeBilevel(samples, c.width, c.height, c.n, pic.ppi);
		if (!v.ok || !v.bits) return null;
		const cw = Math.min(size.width, c.width);
		const ch = Math.min(size.height, c.height);
		const [sx, sy] = inkiest(v.bits, c.width, c.height, cw, ch);
		const before = new m.Pixmap(c.n === 3 ? m.ColorSpace.DeviceRGB : m.ColorSpace.DeviceGray, [0, 0, cw, ch], false);
		const after = new m.Pixmap(m.ColorSpace.DeviceGray, [0, 0, cw, ch], false);
		try {
			const bp = before.getPixels();
			const bs = before.getStride();
			const apx = after.getPixels();
			const as = after.getStride();
			const rb = rowBytesOf(c.width);
			for (let y = 0; y < ch; y++) {
				const src = ((sy + y) * c.width + sx) * c.n;
				bp.set(samples.subarray(src, src + cw * c.n), y * bs);
				for (let x = 0; x < cw; x++) apx[y * as + x] = v.bits[(sy + y) * rb + ((sx + x) >> 3)] & (0x80 >> ((sx + x) & 7)) ? 255 : 0;
			}
			return { width: cw, height: ch, before: before.asPNG().slice(), after: after.asPNG().slice() };
		} finally {
			before.destroy();
			after.destroy();
		}
	} catch (e) {
		rethrowFault(e);
		return null;
	} finally {
		doc.destroy();
		m.emptyStore();
	}
}

// --- export -----------------------------------------------------------------------------------

/** What the check needs of each converted page (by 0-based output page). */
export interface Converted {
	width: number;
	height: number;
	/** bitsDigest of the intended bitmap. */
	digest: string;
}

export interface BilevelBuild {
	/** The file with the converted pictures (or the input, when none converted). */
	bytes: Uint8Array;
	report: BilevelReport;
	expected: Map<number, Converted>;
	/** The largest lost / gained region (inches) among converted pages, for the check's line. */
	worstRegion: number;
}

export interface BilevelOptions {
	/** 0-based output pages to leave as they are (a failed check of an earlier build). */
	exclude?: ReadonlySet<number>;
	control?: ExportControl;
	report?: (p: ExportProgress) => void;
	debug?: (note: string) => void;
	/** Measurement and test hooks. */
	rules?: Partial<BilevelRules>;
}

const cancelled = () => new EngineError('cancelled', 'Export cancelled. Nothing was saved.');

/**
 * Converts the scanned pages of the assembled file `bytes` (output page i is plan page i).
 * Returns the new file, which pages became black and white and which were left, and what
 * the check must find. Throws only EngineError 'cancelled' and MuPDF traps.
 */
export async function convertScans(deps: EngineDeps, bytes: Uint8Array, pages: readonly PageRef[], opts: BilevelOptions = {}): Promise<BilevelBuild> {
	const note = opts.debug ?? (() => {});
	const rules: BilevelRules = { ...BILEVEL_RULES, ...opts.rules };
	const t0 = performance.now();
	const empty = (eligible: number[]): BilevelBuild => ({
		bytes,
		report: { eligible: eligible.length, converted: [], left: eligible.map((i) => i + 1) },
		expected: new Map(),
		worstRegion: 0
	});
	const listing = await listObjects(deps.qpdf, bytes);
	const m = await deps.mupdf();
	let doc: MU.PDFDocument | null = null;
	try {
		doc = new m.PDFDocument(bytes);
		const cands = findCandidates(doc);
		const pics = new Map<number, ScanPicture>();
		for (let i = 0; i < pages.length && i < doc.countPages(); i++) {
			const p = scanPictureOf(m, doc, i, cands);
			if (p?.ok) pics.set(i, p);
		}
		const eligible = [...pics.keys()];
		if (!eligible.length) return empty([]);
		if (!listing || isSigned(listing.objects)) {
			note(listing ? 'bilevel: signed file, pages left as they are' : 'bilevel: qpdf could not list the objects; pages left as they are');
			return empty(eligible);
		}
		// A picture is tried only when every page it is drawn on is one of these pages,
		// with no redaction box and not excluded.
		const ok = (i: number) => pics.has(i) && !pages[i].stamps.some((s) => s.kind === 'redact') && !opts.exclude?.has(i);
		const byImage = new Map<number, { cand: Candidate; ppi: number; pages: number[] }>();
		for (const [i, p] of pics) {
			if (!p.ok) continue;
			const e = byImage.get(p.cand.num) ?? { cand: p.cand, ppi: p.ppi, pages: [] };
			e.pages.push(i);
			byImage.set(p.cand.num, e);
		}
		const jobs = [...byImage.values()].filter((e) => [...e.cand.pages].every(ok) && e.pages.length === e.cand.pages.size);
		const total = jobs.length;
		const enc = new Map<number, { data: Uint8Array; job: (typeof jobs)[number]; digest: string; region: number }>();
		for (const [k, job] of jobs.entries()) {
			if (opts.control?.signal?.aborted) throw cancelled();
			opts.report?.({ stage: 'bilevel', done: k, total });
			// A macrotask, so the worker sees a cancel message between pictures.
			await new Promise((r) => setTimeout(r, 0));
			const c = job.cand;
			const samples = samplesOf(m, doc, c);
			if (!samples) {
				note(`bilevel: picture ${c.num} could not be read cleanly; left as it is`);
				continue;
			}
			const v = makeBilevel(samples, c.width, c.height, c.n, job.ppi, rules);
			if (!v.ok || !v.bits) {
				note(`bilevel: picture ${c.num} left as it is (${v.reason})`);
				continue;
			}
			const data = encodeG4(v.bits, c.width, c.height);
			if (data.length > BILEVEL_GAIN * c.rawLength) {
				note(`bilevel: picture ${c.num} would not get much smaller (${data.length} of ${c.rawLength} bytes); left as it is`);
				continue;
			}
			const region = Math.max(v.check?.lost?.extent ?? 0, v.check?.gained?.extent ?? 0);
			enc.set(c.num, { data, job, digest: await bitsDigest(v.bits, c.width, c.height), region });
		}
		opts.report?.({ stage: 'bilevel', done: total, total });
		if (!enc.size) {
			note(`bilevel: 0 of ${eligible.length} scanned pages made black and white, ${Math.round(performance.now() - t0)} ms`);
			return empty(eligible);
		}
		const out = await writeBack(deps.qpdf, bytes, listing, enc);
		if (!out) {
			note('bilevel: qpdf could not write the pictures back; pages left as they are');
			return empty(eligible);
		}
		const expected = new Map<number, Converted>();
		let worstRegion = 0;
		for (const e of enc.values()) {
			worstRegion = Math.max(worstRegion, e.region);
			for (const i of e.job.pages) expected.set(i, { width: e.job.cand.width, height: e.job.cand.height, digest: e.digest });
		}
		const converted = [...expected.keys()].sort((a, b) => a - b);
		const left = eligible.filter((i) => !expected.has(i));
		note(`bilevel: ${converted.length} of ${eligible.length} scanned pages made black and white, ${Math.round(performance.now() - t0)} ms`);
		return { bytes: out, report: { eligible: eligible.length, converted: converted.map((i) => i + 1), left: left.map((i) => i + 1) }, expected, worstRegion };
	} catch (e) {
		if (e instanceof EngineError && e.code === 'cancelled') throw e;
		if (isWasmFault(e) || isRetired(m)) throw e;
		note(`bilevel: ${e instanceof Error ? e.message : String(e)}; pages left as they are`);
		return empty([]);
	} finally {
		if (!isRetired(m)) {
			try {
				doc?.destroy();
				m.emptyStore();
			} catch (e) {
				rethrowFault(e);
			}
		}
	}
}

// --- qpdf: listing and writing back ------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
interface Listing {
	header: Record<string, Json>;
	objects: Record<string, QpdfObject>;
}

async function listObjects(qpdf: Qpdf, bytes: Uint8Array): Promise<Listing | null> {
	const res = await qpdf.run({
		args: ['--json-output', '--json-stream-data=none', '/l.pdf', '/l.json'],
		inputs: { '/l.pdf': bytes },
		outputs: ['/l.json']
	});
	const file = res.files.get('/l.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, Json>, Record<string, QpdfObject>] };
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
	} catch {
		return null;
	}
}

async function writeBack(qpdf: Qpdf, bytes: Uint8Array, list: Listing, enc: Map<number, { data: Uint8Array; job: { cand: Candidate } }>): Promise<Uint8Array | null> {
	const keys = new Map<number, string>();
	for (const key of Object.keys(list.objects)) {
		const m = /^obj:(\d+) \d+ R$/.exec(key);
		if (m) keys.set(Number(m[1]), key);
	}
	const updates: Record<string, { stream: { dict: Record<string, Json>; datafile: string } }> = {};
	const inputs: Record<string, Uint8Array> = { '/p.pdf': bytes };
	let i = 0;
	for (const [num, e] of enc) {
		const key = keys.get(num);
		const old = key ? list.objects[key]?.stream?.dict : undefined;
		if (!key || !old) return null;
		const { width: w, height: h } = e.job.cand;
		const dict: Record<string, Json> = {
			...(old as Record<string, Json>),
			'/Width': w,
			'/Height': h,
			'/BitsPerComponent': 1,
			'/ColorSpace': '/DeviceGray',
			'/Filter': '/CCITTFaxDecode',
			'/DecodeParms': { '/K': -1, '/Columns': w, '/Rows': h }
		};
		for (const k of ['/DL', '/Length', '/Decode', '/Intent']) delete dict[k];
		const file = `/u/${i++}`;
		updates[key] = { stream: { dict, datafile: file } };
		inputs[file] = e.data;
	}
	inputs['/u.json'] = new TextEncoder().encode(JSON.stringify({ qpdf: [list.header, updates] }));
	const res = await qpdf.run({
		args: ['/p.pdf', '--update-from-json=/u.json', '--compress-streams=n', '--decode-level=none', '--object-streams=disable', '/q.pdf'],
		inputs,
		outputs: ['/q.pdf']
	});
	const out = res.files.get('/q.pdf');
	return (res.code === QPDF_OK || res.code === QPDF_WARNINGS) && out ? out : null;
}

// --- the export check -------------------------------------------------------------------------

/** 1-bit CCITT G4 image streams reachable from a page's resources (and its form XObjects'). */
function bilevelImagesOf(page: MU.PDFObject, w: number, h: number): MU.PDFObject[] {
	const out: MU.PDFObject[] = [];
	const seen = new Set<number>();
	const visit = (res: MU.PDFObject, depth: number) => {
		if (depth > 4 || !res.isDictionary()) return;
		const xo = res.get('XObject');
		if (!xo.isDictionary()) return;
		xo.forEach((v) => {
			if (v.isIndirect()) {
				const n = v.asIndirect();
				if (seen.has(n)) return;
				seen.add(n);
			}
			if (!v.isStream()) return;
			const sub = v.get('Subtype');
			if (sub.isName() && sub.asName() === 'Form') visit(v.get('Resources'), depth + 1);
			if (!sub.isName() || sub.asName() !== 'Image') return;
			const num = (k: string) => (v.get(k).isNumber() ? v.get(k).asNumber() : NaN);
			const f = v.get('Filter');
			const filter = f.isName() ? f.asName() : f.isArray() && f.length === 1 && f.get(0).isName() ? f.get(0).asName() : null;
			if (num('Width') === w && num('Height') === h && num('BitsPerComponent') === 1 && filter === 'CCITTFaxDecode') out.push(v);
		});
	};
	visit(page.getInheritable('Resources'), 0);
	return out;
}

/** Whether an image's dictionary means plain black on white with these G4 parameters. */
function plainG4(o: MU.PDFObject, w: number): boolean {
	if (!o.get('Decode').isNull() || !o.get('SMask').isNull() || !o.get('Mask').isNull()) return false;
	if (o.get('ImageMask').isBoolean() && o.get('ImageMask').asBoolean()) return false;
	const cs = o.get('ColorSpace');
	if (!cs.isName() || cs.asName() !== 'DeviceGray') return false;
	let p = o.get('DecodeParms');
	if (p.isArray()) p = p.length === 1 ? p.get(0) : p;
	if (!p.isDictionary()) return false;
	const num = (k: string, d: number) => (p.get(k).isNumber() ? p.get(k).asNumber() : p.get(k).isNull() ? d : NaN);
	const bool = (k: string) => p.get(k).isBoolean() && p.get(k).asBoolean();
	return num('K', 0) === -1 && num('Columns', 1728) === w && !bool('BlackIs1') && !bool('EncodedByteAlign');
}

/**
 * VerifyCheck 'bilevel' on the final file: every converted page's picture decodes, in MuPDF
 * and in bilevel.ts's own G4 reader, to exactly the intended bitmap. `failed`: 0-based output
 * pages that did not (core.ts builds those again left as they were).
 */
export async function verifyBilevel(
	m: Mupdf,
	file: Uint8Array,
	expected: ReadonlyMap<number, Converted>,
	password: string | undefined,
	worstRegion: number
): Promise<{ check: VerifyCheck; failed: number[] }> {
	const failed: number[] = [];
	let doc: MU.PDFDocument | null = null;
	try {
		doc = new m.PDFDocument(file);
		if (doc.needsPassword() && !(password !== undefined && doc.authenticatePassword(password))) throw new Error('could not open the file');
		for (const [i, e] of expected) {
			let good = false;
			if (i < doc.countPages()) {
				for (const img of bilevelImagesOf(doc.findPage(i), e.width, e.height)) {
					if (!plainG4(img, e.width)) continue;
					const decoded = img.readStream();
					const raw = img.readRawStream();
					try {
						const a = await bitsDigest(decoded.asUint8Array(), e.width, e.height);
						const ownBits = (() => {
							try {
								return decodeG4(raw.asUint8Array(), e.width, e.height);
							} catch {
								return null;
							}
						})();
						const b = ownBits ? await bitsDigest(ownBits, e.width, e.height) : '';
						if (decoded.getLength() >= rowBytesOf(e.width) * e.height && a === e.digest && b === e.digest) good = true;
					} finally {
						decoded.destroy();
						raw.destroy();
					}
					if (good) break;
				}
			}
			if (!good) failed.push(i);
			m.emptyStore();
		}
	} catch (e) {
		rethrowFault(e);
		for (const i of expected.keys()) if (!failed.includes(i)) failed.push(i);
	} finally {
		doc?.destroy();
		m.emptyStore();
	}
	const n = expected.size;
	const pages = n === 1 ? '1 page' : `${n} pages`;
	const ok = failed.length === 0;
	const detail = ok
		? `${pages} made black and white: each picture decodes to exactly the intended black and white bitmap in two independent decoders (MuPDF and the app's own CCITT G4 reader), and each passed the "nothing vanished" comparison with its original (largest faint area allowed to disappear: ${worstRegion.toFixed(2)} in; limit ${BILEVEL_RULES.minExtent} in).`
		: `Page${failed.length === 1 ? '' : 's'} ${failed.map((i) => i + 1).join(', ')}: the black and white picture did not decode exactly as intended.`;
	return { check: { name: 'bilevel', ok, detail }, failed };
}

