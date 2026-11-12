/**
 * MuPDF cleanup for compressed exports: merge identical objects (fonts and images
 * embedded more than once, typical of merged files), drop unused objects, and cut
 * embedded fonts down to the glyphs the pages use. It runs before the stream pass
 * (pack.ts) and only when a cheap look at the file with qpdf alone (`estimateCleanup`)
 * says it is worth loading MuPDF (about 3.6 MB Brotli the first time).
 *
 * Rules:
 * - Fonts are not subset when the file has form fields, a widget, or a free-text
 *   annotation: someone typing into a field later (here or in another reader)
 *   draws with the form's fonts (/DR, /DA), and a subset would lack letters.
 *   Merging and garbage collection still run.
 * - The result must keep the same pages (count, boxes, rotation, annotations,
 *   resource names), the same document catalog entries (outline, names, tags,
 *   page labels, layers, attachments, metadata, form) and the outline items;
 *   otherwise the input is used unchanged (`sameStructure`).
 * - Any error or a result that is not smaller is a silent skip ("avoid, don't fail").
 * - Signed files: as for every export, the signature does not stay valid (intake
 *   says so); the signature fields and values are kept like any other object.
 */

import type { EngineDeps } from './deps';
import { isRetired, rethrowFault } from './mupdf';
import { resolve, type QpdfObject, type StreamDump } from './pack';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Dict = Record<string, Json>;

export interface CleanupEstimate {
	/** Raw bytes of embedded font programs (FontFile, FontFile2, FontFile3). */
	fontBytes: number;
	/** The part of fontBytes in fonts embedded whole (no "ABCDEF+" subset tag). */
	fullFontBytes: number;
	/** Bytes in streams that repeat another stream byte for byte (same dictionary too). */
	dupBytes: number;
	/** False when fonts must not be subset (form fields, widgets, free text, Type 1 fonts). */
	subset: boolean;
	/** Expected saving in bytes. */
	gain: number;
}

const isDict = (v: Json | undefined): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

function keyOf(ref: Json | undefined): string | null {
	return typeof ref === 'string' && /^\d+ \d+ R$/.test(ref) ? `obj:${ref}` : null;
}

function dictOf(o: QpdfObject | undefined): Dict | null {
	if (!o) return null;
	if (o.stream) return o.stream.dict;
	return isDict(o.value) ? o.value : null;
}

/** True when the file has form fields or annotations whose later editing uses the form's fonts. */
export function needsFormFonts(objects: Record<string, QpdfObject>): boolean {
	const trailer = dictOf(objects.trailer);
	const root = resolve(objects, trailer?.['/Root']);
	if (isDict(root)) {
		const form = resolve(objects, root['/AcroForm']);
		if (isDict(form)) {
			const fields = resolve(objects, form['/Fields']);
			if (Array.isArray(fields) && fields.length > 0) return true;
		}
	}
	for (const o of Object.values(objects)) {
		const d = dictOf(o);
		if (!d) continue;
		const sub = d['/Subtype'];
		if (sub === '/Widget' || sub === '/FreeText') return true;
		if (d['/FT'] !== undefined && (d['/T'] !== undefined || d['/Kids'] !== undefined)) return true;
	}
	return false;
}

async function digest(d: Uint8Array): Promise<string> {
	const h = new Uint8Array(await crypto.subtle.digest('SHA-256', d as Uint8Array<ArrayBuffer>));
	let s = '';
	for (const b of h) s += b.toString(16).padStart(2, '0');
	return s;
}

const REFS = /"(\d+ \d+ R)"/g;

/**
 * Bytes MuPDF's merging could save: streams with the same data and dictionary, and
 * other objects that are equal once the objects they point to are merged (a few
 * rounds, like MuPDF's own repeated pass). Pages are never merged.
 */
async function duplicateBytes(dump: StreamDump): Promise<number> {
	const { objects, data } = dump;
	const canon = new Map<string, string>();
	const ref = (key: string) => key.slice(4); // "obj:12 0 R" → "12 0 R"
	const hashes = new Map<string, string>();
	// Stream data: same length first (cheap), then a digest.
	const byLength = new Map<number, string[]>();
	for (const [key, d] of data) {
		const list = byLength.get(d.length);
		if (list) list.push(key);
		else byLength.set(d.length, [key]);
	}
	for (const [, keys] of byLength) {
		if (keys.length < 2) continue;
		for (const key of keys) hashes.set(key, await digest(data.get(key)!));
	}
	let total = 0;
	for (let round = 0; round < 4; round++) {
		const groups = new Map<string, string>();
		let merged = 0;
		for (const [key, o] of Object.entries(objects)) {
			if (key === 'trailer' || canon.has(key)) continue;
			const d = dictOf(o);
			if (d && (d['/Type'] === '/Page' || d['/Type'] === '/Pages')) continue;
			const text = JSON.stringify(o.stream ? o.stream.dict : (o.value ?? null)).replace(REFS, (_, r: string) => `"${canon.get(`obj:${r}`) ?? r}"`);
			let sig: string;
			let size: number;
			if (o.stream) {
				const raw = data.get(key);
				if (!raw) continue;
				const h = hashes.get(key);
				if (!h) continue; // a unique length: no twin
				sig = `s${h}|${text}`;
				size = raw.length + text.length;
			} else {
				if (text.length < 24) continue;
				sig = `o${text}`;
				size = text.length;
			}
			const first = groups.get(sig);
			if (first === undefined) groups.set(sig, key);
			else {
				canon.set(key, ref(first));
				total += size;
				merged++;
			}
		}
		if (merged === 0) break;
	}
	return total;
}

/** What the cleanup could save, from a qpdf dump alone. */
export async function estimateCleanup(dump: StreamDump): Promise<CleanupEstimate> {
	const { objects, data } = dump;
	let fontBytes = 0;
	let fullFontBytes = 0;
	let type1 = false;
	const fontFiles = new Set<string>();
	for (const o of Object.values(objects)) {
		const d = dictOf(o);
		if (!d || d['/Type'] !== '/FontDescriptor') continue;
		if (d['/FontFile'] !== undefined) type1 = true;
		const name = typeof d['/FontName'] === 'string' ? d['/FontName'] : '';
		for (const k of ['/FontFile', '/FontFile2', '/FontFile3']) {
			const key = keyOf(d[k]);
			if (!key || fontFiles.has(key)) continue;
			fontFiles.add(key);
			const n = data.get(key)?.length ?? 0;
			fontBytes += n;
			if (!/^\/[A-Z]{6}\+/.test(name)) fullFontBytes += n;
		}
	}
	const dupBytes = await duplicateBytes(dump);
	// Not with Type 1 fonts (FontFile): on a survey paper MuPDF's Type 1 subsets drew
	// differently in PDF.js and poppler (up to 194/255 at glyph edges), though not in
	// MuPDF. TrueType and CFF subsets were identical in all three on every measured file.
	const subset = !needsFormFonts(objects) && !type1;
	// Fitted on the research sample (112 survey files, 2026-11-11; MuPDF run on all):
	// saving ≈ 1.4 × duplicates (merging also frees what only the copies used)
	// + 0.7 × whole fonts + 0.33 × subset-tagged fonts (often subsets of many pages).
	const gain = 1.4 * dupBytes + (subset ? 0.7 * fullFontBytes + 0.33 * (fontBytes - fullFontBytes) : 0);
	return { fontBytes, fullFontBytes, dupBytes, subset, gain };
}

/**
 * Whether the expected saving pays for loading MuPDF: `loaded` (in memory: free),
 * `cached` (on the device: about a second to compile on a phone), `download`
 * (about 3.6 MB over the network the first time).
 */
export function cleanupWorthIt(est: CleanupEstimate, size: number, cost: 'loaded' | 'cached' | 'download'): boolean {
	// On the research sample these let MuPDF run on 77, 51 and 24 of 112 files and keep
	// 99%, 93% and 82% of what running it on every file saves.
	const [abs, rel] = cost === 'loaded' ? [8_000, 0.005] : cost === 'cached' ? [32_000, 0.01] : [100_000, 0.02];
	return est.gain >= abs && est.gain >= rel * size;
}

/**
 * Merges duplicates, drops unused objects and (when `subset`) subsets fonts with
 * MuPDF. Returns the new file, or null to keep `bytes` (any error: silent skip).
 * Streams are written as they are (no recompression): the stream pass does that.
 */
export async function cleanupWithMupdf(deps: EngineDeps, bytes: Uint8Array, subset: boolean, note: (s: string) => void): Promise<Uint8Array | null> {
	let m;
	try {
		m = await deps.mupdf();
	} catch (e) {
		note(`cleanup: MuPDF did not load (${e instanceof Error ? e.message : String(e)})`);
		return null;
	}
	let doc: InstanceType<typeof m.PDFDocument> | null = null;
	try {
		doc = new m.PDFDocument(bytes);
		if (doc.needsPassword() || doc.wasRepaired()) {
			note('cleanup: MuPDF needed a password or had to repair the file; skipped');
			return null;
		}
		if (subset) {
			// A font MuPDF cannot read cleanly is not subset (it may be damaged): any warning
			// while subsetting, and the fonts are left whole.
			const problems: string[] = [];
			// Notes that are not about reading a font or a page: MuPDF skipping one font on
			// its own, and fonts that are not embedded (nothing to subset).
			const harmless = /Skipping subsetting|^non-embedded font/;
			const keep = (s: string) => {
				if (!harmless.test(s)) problems.push(s);
			};
			m.setLog({ error: keep, warning: keep });
			try {
				doc.subsetFonts();
			} finally {
				m.setLog(null);
			}
			if (problems.length) {
				note(`cleanup: MuPDF reported "${problems[0]}" while subsetting; fonts left whole`);
				doc.destroy();
				doc = new m.PDFDocument(bytes);
			}
		}
		// garbage=4: drop unused objects, renumber, merge equal objects and equal streams.
		// compress-fonts: new (subset) font programs are written compressed; nothing else is
		// recompressed here (the stream pass does that).
		const buf = doc.saveToBuffer('garbage=4,compress-fonts');
		const out = buf.asUint8Array().slice();
		buf.destroy();
		return out;
	} catch (e) {
		rethrowFault(e);
		note(`cleanup: MuPDF failed (${e instanceof Error ? e.message : String(e)}); skipped`);
		return null;
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

// --- structure check ---------------------------------------------------------------------

interface PageFacts {
	box: string;
	annots: number;
	resources: string;
}

const INHERITED = ['/MediaBox', '/CropBox', '/Rotate', '/Resources'];
const RES_KINDS = ['/Font', '/XObject', '/ExtGState', '/Pattern', '/Shading', '/ColorSpace', '/Properties'];

function pagesOf(objects: Record<string, QpdfObject>): PageFacts[] | null {
	const root = resolve(objects, dictOf(objects.trailer)?.['/Root']);
	if (!isDict(root)) return null;
	const out: PageFacts[] = [];
	const seen = new Set<string>();
	const walk = (ref: Json | undefined, inherited: Dict, depth: number): boolean => {
		const key = keyOf(ref);
		const node = key ? dictOf(objects[key]) : isDict(ref ?? null) ? (ref as Dict) : null;
		if (!node || depth > 64 || (key && seen.has(key))) return false;
		if (key) seen.add(key);
		const inh: Dict = { ...inherited };
		for (const k of INHERITED) if (node[k] !== undefined) inh[k] = node[k];
		const kids = resolve(objects, node['/Kids']);
		if (node['/Type'] === '/Pages' || Array.isArray(kids)) {
			if (!Array.isArray(kids)) return false;
			return kids.every((k) => walk(k, inh, depth + 1));
		}
		const v = (k: string) => JSON.stringify(resolve(objects, inh[k]) ?? null);
		const annots = resolve(objects, node['/Annots']);
		const res = resolve(objects, inh['/Resources']);
		const names = isDict(res)
			? RES_KINDS.map((k) => {
					const r = resolve(objects, res[k]);
					return `${k}:${isDict(r) ? Object.keys(r).sort().join(',') : ''}`;
				}).join(' ')
			: '';
		out.push({
			box: `${v('/MediaBox')} ${v('/CropBox')} ${v('/Rotate')} ${JSON.stringify(resolve(objects, node['/UserUnit']) ?? null)}`,
			annots: Array.isArray(annots) ? annots.length : 0,
			resources: names
		});
		return true;
	};
	return walk(root['/Pages'], {}, 0) ? out : null;
}

function outlineCount(objects: Record<string, QpdfObject>): number {
	const root = resolve(objects, dictOf(objects.trailer)?.['/Root']);
	const outlines = isDict(root) ? resolve(objects, root['/Outlines']) : null;
	let n = 0;
	const seen = new Set<string>();
	const walk = (ref: Json | undefined, depth: number) => {
		let cur = ref;
		while (n < 100_000 && depth < 64) {
			const key = keyOf(cur);
			if (!key || seen.has(key)) return;
			seen.add(key);
			const d = dictOf(objects[key]);
			if (!d) return;
			n++;
			walk(d['/First'], depth + 1);
			cur = d['/Next'];
		}
	};
	if (isDict(outlines)) walk(outlines['/First'], 0);
	return n;
}

/** Every non-integer number in the objects (stream dictionaries included). */
function realsOf(d: StreamDump): Set<number> {
	const out = new Set<number>();
	const walk = (v: Json | undefined, depth: number) => {
		if (typeof v === 'number') {
			if (!Number.isInteger(v)) out.add(v);
		} else if (Array.isArray(v)) {
			if (depth < 64) for (const x of v) walk(x, depth + 1);
		} else if (isDict(v ?? null) && depth < 64) for (const x of Object.values(v as Dict)) walk(x, depth + 1);
	};
	for (const o of Object.values(d.objects)) walk(o.stream ? o.stream.dict : o.value, 0);
	return out;
}

/**
 * Objects whose identity matters, not just their content (a layer is the object a
 * page's /OC points to; two layers can be equal and still be two layers), reached
 * from the trailer, by kind. MuPDF's merging joins equal objects, so a count that
 * goes down means two of them became one.
 */
function identityCounts(objects: Record<string, QpdfObject>): Record<string, number> {
	const counts: Record<string, number> = {};
	const seen = new Set<string>();
	const stack: string[] = [];
	const push = (v: Json | undefined, depth: number) => {
		if (typeof v === 'string') {
			const key = keyOf(v);
			if (key && !seen.has(key) && objects[key]) {
				seen.add(key);
				stack.push(key);
			}
		} else if (Array.isArray(v)) {
			if (depth < 64) for (const x of v) push(x, depth + 1);
		} else if (isDict(v ?? null) && depth < 64) for (const x of Object.values(v as Dict)) push(x, depth + 1);
	};
	push(dictOf(objects.trailer) as Json, 0);
	while (stack.length) {
		const key = stack.pop()!;
		const o = objects[key];
		const d = dictOf(o);
		if (d) {
			const kind = identityKind(d);
			if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
		}
		push(o.stream ? o.stream.dict : o.value, 0);
	}
	return counts;
}

function identityKind(d: Dict): string | null {
	const t = d['/Type'];
	if (t === '/OCG' || t === '/OCMD' || t === '/Sig' || t === '/Bead' || t === '/Thread' || t === '/Filespec' || t === '/StructElem' || t === '/MCR' || t === '/OBJR') return t;
	if (t === '/Annot' || (d['/Subtype'] !== undefined && d['/Rect'] !== undefined)) return 'annotation';
	if (d['/FT'] !== undefined || (d['/T'] !== undefined && (d['/Kids'] !== undefined || d['/Parent'] !== undefined))) return 'field';
	if (d['/S'] !== undefined && d['/P'] !== undefined && (d['/K'] !== undefined || d['/Pg'] !== undefined)) return 'structure';
	if (d['/Title'] !== undefined && d['/Parent'] !== undefined) return 'outline item';
	return null;
}

/**
 * Null when `after` keeps the structure of `before`, else what differs. MuPDF keeps
 * real numbers as 32-bit floats, so a value with more than about seven digits
 * (747.82195) is written rounded (747.82199): a result with any number the input
 * does not have is not used.
 */
export function sameStructure(before: StreamDump, after: StreamDump): string | null {
	const reals = realsOf(before);
	for (const r of realsOf(after)) if (!reals.has(r)) return `number ${r} is new (rounded?)`;
	const ia = identityCounts(before.objects);
	const ib = identityCounts(after.objects);
	for (const k of new Set([...Object.keys(ia), ...Object.keys(ib)])) {
		if ((ia[k] ?? 0) !== (ib[k] ?? 0)) return `${k} objects ${ia[k] ?? 0} → ${ib[k] ?? 0}`;
	}
	const a = pagesOf(before.objects);
	const b = pagesOf(after.objects);
	if (!a || !b) return 'page tree unreadable';
	if (a.length !== b.length) return `page count ${a.length} → ${b.length}`;
	for (let i = 0; i < a.length; i++) {
		if (a[i].box !== b[i].box) return `page ${i + 1} geometry`;
		if (a[i].annots !== b[i].annots) return `page ${i + 1} annotations`;
		if (a[i].resources !== b[i].resources) return `page ${i + 1} resources`;
	}
	const catalog = (d: StreamDump) => {
		const root = resolve(d.objects, dictOf(d.objects.trailer)?.['/Root']);
		return isDict(root) ? Object.keys(root).sort().join(',') : '';
	};
	if (catalog(before) !== catalog(after)) return `catalog ${catalog(before)} → ${catalog(after)}`;
	const info = (d: StreamDump) => dictOf(d.objects.trailer)?.['/Info'] !== undefined;
	if (info(before) !== info(after)) return 'document info';
	if (outlineCount(before.objects) !== outlineCount(after.objects)) return 'outline';
	return null;
}
