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
	/** False when fonts must not be subset (form fields, widgets, free text). */
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

/** What the cleanup could save, from a qpdf dump alone. */
export async function estimateCleanup(dump: StreamDump): Promise<CleanupEstimate> {
	const { objects, data } = dump;
	let fontBytes = 0;
	let fullFontBytes = 0;
	const fontFiles = new Set<string>();
	for (const o of Object.values(objects)) {
		const d = dictOf(o);
		if (!d || d['/Type'] !== '/FontDescriptor') continue;
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
	// Duplicates: same length first (cheap), then same bytes and dictionary.
	const byLength = new Map<number, string[]>();
	for (const [key, d] of data) {
		if (d.length < 1024) continue;
		const list = byLength.get(d.length);
		if (list) list.push(key);
		else byLength.set(d.length, [key]);
	}
	let dupBytes = 0;
	for (const [len, keys] of byLength) {
		if (keys.length < 2) continue;
		const seen = new Set<string>();
		for (const key of keys) {
			const id = `${await digest(data.get(key)!)}|${JSON.stringify(objects[key].stream?.dict ?? null)}`;
			if (seen.has(id)) dupBytes += len;
			else seen.add(id);
		}
	}
	const subset = !needsFormFonts(objects);
	// Calibrated on the research sample (2026-11-11): whole embedded fonts shrink to
	// about a third; subset-tagged ones rarely shrink (they already are subsets).
	const gain = dupBytes + (subset ? 0.6 * fullFontBytes + 0.05 * (fontBytes - fullFontBytes) : 0);
	return { fontBytes, fullFontBytes, dupBytes, subset, gain };
}

/**
 * Whether the expected saving pays for loading MuPDF: `loaded` (in memory: free),
 * `cached` (on the device: about a second to compile on a phone), `download`
 * (about 3.6 MB over the network the first time).
 */
export function cleanupWorthIt(est: CleanupEstimate, size: number, cost: 'loaded' | 'cached' | 'download'): boolean {
	const [abs, rel] = cost === 'loaded' ? [8_000, 0.005] : cost === 'cached' ? [32_000, 0.01] : [200_000, 0.03];
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
		if (subset) doc.subsetFonts();
		const buf = doc.saveToBuffer('garbage=4');
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

/** Null when `after` keeps the structure of `before`, else what differs. */
export function sameStructure(before: StreamDump, after: StreamDump): string | null {
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
