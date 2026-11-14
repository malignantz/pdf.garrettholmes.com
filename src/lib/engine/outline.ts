/**
 * Title, document details and bookmarks across an export.
 *
 * Where they were lost: the assemble step (assemble.ts) builds every export as a new
 * document (`qpdf --empty --pages`), or for forms reduces the source's catalog to pages,
 * form, layers and page labels; either way the trailer's /Info (title, author, …), the
 * catalog's /Outlines (bookmarks), its named destinations (/Dests, /Names /Dests) and, for
 * files without tags, /Lang and /ViewerPreferences were gone. Links on the pages that go to
 * a named destination then did nothing.
 *
 * What happens now (`planOutline` decides, `graftOutline` writes, `verifyOutline` proves; wired
 * in core.ts right after the tags):
 *
 * - Document details (Info): kept when the export's pages come from one PDF (plus any blank
 *   pages or pictures, which have no details of their own) and "Remove hidden details" is off
 *   (redaction turns it on). Carried: /Title, /Author, /Subject, /Keywords, /Creator,
 *   /CreationDate, when they are text. Not carried: /Producer and /ModDate (the export is a new
 *   save, by another program), custom keys (they can hold anything), and the XMP packet: it
 *   repeats the details in XML and may claim PDF/A or PDF/UA conformance the export no longer
 *   proves; dropping it means Info and XMP can never disagree. Several PDFs merged: no details
 *   (a merged file is a new document; whose title would it be?).
 * - Bookmarks: the source's outline tree, pruned to the kept pages. A bookmark whose page is not
 *   in the export goes, and its kept children take its place (same order); a bookmark to a kept
 *   page goes to that page's (first) copy with the same view (/XYZ, /Fit, …, coordinates to six
 *   significant digits, see `six`). A web link (/A URI) belongs to no page and stays (lifted when
 *   its parent goes); a heading without destination stays when it keeps a child (or, whole file,
 *   when it never had any). The tree keeps the source's order when
 *   pages are reordered (a bookmark stays with its page). /Dest and /A GoTo, explicit or named
 *   (resolved through /Dests and the /Names /Dests name tree), become explicit destinations;
 *   every other action (JavaScript, Launch, GoToR, Named, …) goes with its bookmark (children
 *   lifted), as does a destination that resolves to no page of the file. Colour
 *   (/C) and style (/F) are kept; /SE (a structure element) is not. Several files: each file's
 *   pruned outline, one after the other, in the order the files first appear, with no extra
 *   level above them.
 * - Named destinations: carried for kept pages (both forms, keys as written), so links from
 *   other files to "file.pdf#name" keep working; every link annotation on a kept page that goes to
 *   a named destination on a kept page is rewritten to the explicit destination, so it works in
 *   every viewer whatever the name tree's string encoding. A name two merged files define
 *   differently is dropped from both.
 * - /Lang (when every PDF source has the same), /ViewerPreferences (one PDF source; page-number
 *   keys such as /PrintPageRange dropped), /PageMode /UseOutlines (one PDF source, bookmarks
 *   kept): set when the catalog does not have them yet (tags.ts sets /Lang and
 *   /ViewerPreferences of tagged files).
 * - Not kept, with the result saying why: anything blacked out (`redacted`: bookmark titles and
 *   destination names can repeat what was hidden; redaction already removes the details), a
 *   damaged outline in any source (`damaged`: an item reached twice, not a dictionary, deeper
 *   than MAX_DEPTH, a name tree that cannot be read), more than MAX_ITEMS bookmarks or a source
 *   over MAX_OBJECTS objects (`large`), the export's own check failing (`check`: built again
 *   without them). Never a failed export.
 *
 * The check (`verifyOutline`, on the final file, with its password): the outline is read back
 * strictly (First/Last/Next/Prev/Parent consistent, every item once, /Count equal to the visible
 * descendants with the open/closed sign, every destination an explicit one to a page of the
 * file) into one line per item (depth, title as text, page number and view or URI, open, colour,
 * style) and compared element by element with the lines computed from the source outline and
 * the pruning; the name tree (sorted, /Limits right) and /Dests likewise; each rewritten link must
 * be on its page going to its page; the Info entries must equal the source's, and the catalog
 * must have no XMP packet.
 */

import type { BookmarksDropReason, DocInfoDropReason, PageRef, Source, VerifyCheck } from '../core/types';
import { isDict, isRef, objArg, objKey, type Dict } from './oc';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';
import { textOf } from './tags';

type Json = unknown;
interface Obj {
	value?: Json;
	stream?: { dict?: Json; data?: string };
}
type Objects = Record<string, Obj>;

export type { BookmarksDropReason, DocInfoDropReason };

/** Most bookmarks carried (in the sources, before pruning). Above: no bookmarks ('large'). */
export const MAX_ITEMS = 20_000;
/** Most named destinations carried; above, the names are not carried (bookmarks and links still resolve). */
export const MAX_NAMES = 100_000;
/** Most objects in a source whose outline is read (every object is dumped as JSON once). */
export const MAX_OBJECTS = 500_000;
/** Deepest bookmark nesting read. */
export const MAX_DEPTH = 64;
/** Info entries carried, when they are text. */
export const INFO_KEYS = ['/Title', '/Author', '/Subject', '/Keywords', '/Creator', '/CreationDate'];
const VIEWER_BOOL = ['/HideToolbar', '/HideMenubar', '/HideWindowUI', '/FitWindow', '/CenterWindow', '/DisplayDocTitle', '/PickTrayByPDFSize'];
const VIEWER_NAME = ['/NonFullScreenPageMode', '/Direction', '/ViewArea', '/ViewClip', '/PrintArea', '/PrintClip', '/PrintScaling', '/Duplex'];
/** Destination view kinds and how many numbers (or nulls) follow each. */
const VIEW_ARGS: Record<string, number> = { '/XYZ': 3, '/Fit': 0, '/FitH': 1, '/FitV': 1, '/FitR': 4, '/FitB': 0, '/FitBH': 1, '/FitBV': 1 };
/** Name-tree leaves written with at most this many names (a two-level tree above it). */
const LEAF = 512;

// ------------------------------------------------------------------------------ JSON helpers

const val = (objects: Objects, v: Json): Json => {
	if (isRef(v)) {
		const o = objects[objKey(v)];
		if (!o) return null;
		return o.stream ? (o.stream.dict ?? null) : (o.value ?? null);
	}
	return v;
};
const dictAt = (objects: Objects, v: Json): Dict | null => {
	const d = val(objects, v);
	return isDict(d) ? d : null;
};
const arrAt = (objects: Objects, v: Json): Json[] | null => {
	const a = val(objects, v);
	return Array.isArray(a) ? a : null;
};
/** A qpdf JSON string (not a name or a reference). */
const isStr = (v: Json): v is string => typeof v === 'string' && (v.startsWith('u:') || v.startsWith('b:'));
const isName = (v: Json): v is string => typeof v === 'string' && v.startsWith('/');

/**
 * A number as qpdf printed it, when a JavaScript number would not write it back the same (more
 * digits than a double keeps); `jsonText` writes the token.
 */
class RawNumber {
	constructor(readonly token: string) {}
	valueOf() {
		return Number(this.token);
	}
}

/**
 * One object (or the trailer) in qpdf's own PDF syntax (`--show-object`), parsed into qpdf JSON
 * form: about 25 ms even on large files, where a `--json-object` dump reads every object (a
 * second on a 3 MB form). Strings become "b:" hex of their exact bytes; names are decoded (#xx),
 * as qpdf's JSON writes them. Null when qpdf cannot show it or the text does not parse.
 */
async function show(qpdf: Qpdf, bytes: Uint8Array, what: string, password?: string): Promise<Json | null> {
	const pw = password !== undefined ? [`--password=${password}`] : [];
	const res = await qpdf.run({ args: [...pw, `--show-object=${what === 'trailer' ? what : objArg(what)}`, '/s.pdf'], inputs: { '/s.pdf': bytes }, latin1Stdout: true });
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || res.stdoutLatin1 === undefined) return null;
	try {
		return parsePdfValue(res.stdoutLatin1);
	} catch {
		return null;
	}
}

/** The first value of qpdf's printed PDF syntax (a stream prints as its dictionary). */
export function parsePdfValue(text: string): Json {
	let i = 0;
	const ws = () => {
		while (i < text.length) {
			const c = text.charCodeAt(i);
			if (c === 0x25) {
				while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
			} else if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) i++;
			else break;
		}
	};
	const DELIM = /[\s()<>[\]{}/%]/;
	const bytesHex = (b: number[]) => `b:${b.map((x) => x.toString(16).padStart(2, '0')).join('')}`;
	const value = (depth: number): Json => {
		if (depth > 64) throw new Error('too deep');
		ws();
		const c = text[i];
		if (c === undefined) throw new Error('end of text');
		if (c === '<' && text[i + 1] === '<') {
			i += 2;
			const d: Dict = {};
			for (;;) {
				ws();
				if (text[i] === '>' && text[i + 1] === '>') {
					i += 2;
					return d;
				}
				const k = value(depth + 1);
				if (typeof k !== 'string' || !k.startsWith('/')) throw new Error('a key is not a name');
				d[k] = value(depth + 1);
			}
		}
		if (c === '[') {
			i++;
			const a: Json[] = [];
			for (;;) {
				ws();
				if (text[i] === ']') {
					i++;
					return a;
				}
				a.push(value(depth + 1));
			}
		}
		if (c === '<') {
			const end = text.indexOf('>', i);
			if (end < 0) throw new Error('open hex string');
			let h = text.slice(i + 1, end).replace(/\s+/g, '');
			if (!/^[0-9a-fA-F]*$/.test(h)) throw new Error('bad hex string');
			if (h.length % 2) h += '0';
			i = end + 1;
			return `b:${h.toLowerCase()}`;
		}
		if (c === '(') {
			i++;
			const out: number[] = [];
			let nest = 1;
			for (;;) {
				if (i >= text.length) throw new Error('open string');
				const ch = text.charCodeAt(i++);
				if (ch === 0x5c) {
					const e = text[i++];
					const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };
					if (e in map) out.push(map[e]);
					else if (e >= '0' && e <= '7') {
						let o = e;
						while (o.length < 3 && text[i] >= '0' && text[i] <= '7') o += text[i++];
						out.push(Number.parseInt(o, 8) & 255);
					} else if (e === '\r') {
						if (text[i] === '\n') i++;
					} else if (e !== '\n') out.push(e.charCodeAt(0) & 255);
				} else if (ch === 0x28) {
					nest++;
					out.push(ch);
				} else if (ch === 0x29) {
					if (--nest === 0) return bytesHex(out);
					out.push(ch);
				} else {
					if (ch > 255) throw new Error('a character outside a byte');
					out.push(ch);
				}
			}
		}
		if (c === '/') {
			let j = i + 1;
			while (j < text.length && !DELIM.test(text[j])) j++;
			const raw = text.slice(i + 1, j);
			i = j;
			return `/${raw.replace(/#([0-9a-fA-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))}`;
		}
		let j = i;
		while (j < text.length && !DELIM.test(text[j])) j++;
		const tok = text.slice(i, j);
		i = j;
		if (tok === 'true') return true;
		if (tok === 'false') return false;
		if (tok === 'null') return null;
		if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(tok)) {
			// "N G R": a reference.
			const m = /^\s+(\d+)\s+R(?=[\s()<>[\]{}/%]|$)/.exec(text.slice(i));
			if (/^\d+$/.test(tok) && m) {
				i += m[0].length;
				return `${tok} ${m[1]} R`;
			}
			const norm = tok.replace(/^\+/, '').replace(/^(-?)\./, '$10.').replace(/\.$/, '.0');
			const n = Number(norm);
			return String(n) === norm ? n : new RawNumber(norm);
		}
		throw new Error(`unexpected ${tok.slice(0, 20) || c}`);
	};
	return value(0);
}

/** The given objects (refs or 'trailer'), each by `show`; missing ones are left out. */
async function showObjects(qpdf: Qpdf, bytes: Uint8Array, refs: string[], password?: string): Promise<Objects> {
	const out: Objects = {};
	for (const r of new Set(refs)) {
		const v = await show(qpdf, bytes, r, password);
		if (v !== null) out[r === 'trailer' ? r : objKey(r)] = { value: v };
	}
	return out;
}

/** qpdf JSON text, writing numbers as plain decimals (qpdf reads 1e-7 as 0) and RawNumber tokens as they are. */
function jsonText(v: Json): string {
	if (v instanceof RawNumber) return v.token;
	if (typeof v === 'number') {
		if (!Number.isFinite(v)) return '0';
		const t = String(v);
		return /e/i.test(t) ? v.toFixed(Math.min(20, Math.max(0, 6 - Math.floor(Math.log10(Math.abs(v) || 1))))).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '') : t;
	}
	if (Array.isArray(v)) return `[${v.map(jsonText).join(',')}]`;
	if (isDict(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${jsonText(x)}`).join(',')}}`;
	return JSON.stringify(v);
}

interface FullDump {
	header: Dict;
	objects: Objects;
	pages: string[];
}

async function dumpAll(qpdf: Qpdf, bytes: Uint8Array, password?: string): Promise<FullDump | null> {
	const pw = password !== undefined ? [`--password=${password}`] : [];
	const res = await qpdf.run({
		args: [...pw, '--json=2', '--json-key=qpdf', '--json-key=pages', '--json-stream-data=none', '/o.pdf', '/o.json'],
		inputs: { '/o.pdf': bytes },
		outputs: ['/o.json']
	});
	const file = res.files.get('/o.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Objects]; pages?: { object: string }[] };
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1], pages: (parsed.pages ?? []).map((p) => p.object) };
	} catch {
		return null;
	}
}

/** The trailer, the catalog, the page list (and, with `full`, every object). */
async function catalogDump(qpdf: Qpdf, bytes: Uint8Array, full: boolean, password?: string): Promise<(FullDump & { catalogRef: string; catalog: Dict; trailer: Dict }) | null> {
	let d: FullDump | null;
	if (full) d = await dumpAll(qpdf, bytes, password);
	else {
		// Cheap: the page list (no object dump), the trailer, the catalog and Info shown one by one.
		const pw = password !== undefined ? [`--password=${password}`] : [];
		const res = await qpdf.run({ args: [...pw, '--json=2', '--json-key=pages', '/o.pdf', '/o.json'], inputs: { '/o.pdf': bytes }, outputs: ['/o.json'] });
		const file = res.files.get('/o.json');
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
		let pages: string[];
		try {
			pages = ((JSON.parse(new TextDecoder().decode(file)) as { pages?: { object: string }[] }).pages ?? []).map((p) => p.object);
		} catch {
			return null;
		}
		const objects = await showObjects(qpdf, bytes, ['trailer'], password);
		const t = objects.trailer?.value;
		const root = isDict(t) ? t['/Root'] : null;
		if (!isDict(t) || !isRef(root)) return null;
		Object.assign(objects, await showObjects(qpdf, bytes, [root, ...(isRef(t['/Info']) ? [t['/Info'] as string] : [])], password));
		const size = t['/Size'];
		d = { header: { jsonversion: 2, maxobjectid: typeof size === 'number' ? size - 1 : 0 }, objects, pages };
	}
	if (!d) return null;
	const trailer = d.objects.trailer?.value;
	const catalogRef = isDict(trailer) ? trailer['/Root'] : null;
	const catalog = isRef(catalogRef) ? dictAt(d.objects, catalogRef) : null;
	if (!isDict(trailer) || !isRef(catalogRef) || !catalog) return null;
	return { ...d, catalogRef, catalog, trailer };
}

// ------------------------------------------------------------------------------ strings

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/**
 * The bytes a qpdf JSON string stands for, as this module writes them: "b:" strings exactly;
 * "u:" ASCII strings as ASCII (qpdf shows a literal ASCII string, and also one stored as UTF-16
 * with a byte order mark, as "u:"; the literal is far more common); other "u:" strings as
 * UTF-16BE with a byte order mark (qpdf shows a PDFDocEncoding string with non-ASCII bytes as
 * "b:", so a non-ASCII "u:" string was stored with a byte order mark).
 */
export function stringBytes(s: string): Uint8Array {
	if (s.startsWith('b:')) {
		const h = s.slice(2);
		const out = new Uint8Array(h.length >> 1);
		for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 * i, 2 * i + 2), 16);
		return out;
	}
	const t = s.startsWith('u:') ? s.slice(2) : s;
	// eslint-disable-next-line no-control-regex
	if (/^[\x00-\x7f]*$/.test(t)) return new TextEncoder().encode(t);
	const out = new Uint8Array(2 + 2 * t.length);
	out[0] = 0xfe;
	out[1] = 0xff;
	for (let i = 0; i < t.length; i++) {
		const c = t.charCodeAt(i);
		out[2 + 2 * i] = c >> 8;
		out[3 + 2 * i] = c & 0xff;
	}
	return out;
}

function cmpBytes(a: Uint8Array, b: Uint8Array): number {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}

// ------------------------------------------------------------------------------ source model

type View = Json[];
/** A destination in a source: a page of it and a view; `bad`: unresolvable or not allowed. */
type SrcTarget = { page: number; view: View } | { uri: string } | null | 'bad';

interface Item {
	/** qpdf JSON string, written back as it is. */
	title: string;
	target: SrcTarget;
	open: boolean;
	c?: number[];
	f?: number;
	kids: Item[];
}

interface NamedDest {
	kind: 'tree' | 'dict';
	/** Tree: a qpdf JSON string; dict: a name. */
	key: string;
	page: number;
	view: View;
}

export interface SourceStats {
	/** Bookmarks in the source. */
	items: number;
	/** Bookmarks whose destination could not be resolved (a missing name, not a page), dropped. */
	unresolved: number;
	/** Bookmarks with an action other than GoTo and URI (JavaScript, Launch, …), dropped: by action. */
	actions: Record<string, number>;
	/** Views that were not well-formed and became /Fit (or were padded). */
	viewsFixed: number;
	/** Bookmarks that go to a named destination. */
	named: number;
	/**
	 * Bookmarks with both /Dest and /A (not allowed): /Dest is used, as MuPDF, PDFium and qpdf
	 * read it (PDF.js reads /A first).
	 */
	both: number;
	/** Named destinations in the source (both forms). */
	names: number;
	depth: number;
}

export interface SourceDoc {
	/** Carried Info entries (raw qpdf JSON strings), or null when none is text. */
	info: Dict | null;
	lang?: Json;
	viewer?: Dict;
	pageMode?: string;
	/** null: no bookmarks. */
	outline: { items: Item[] } | { problem: 'damaged' | 'large'; detail: string } | null;
	/** Named destinations to pages (null: none, or not carried: `namesProblem` says why). */
	dests: NamedDest[] | null;
	namesProblem?: string;
	/** Name lookups (text keys) for links: tree strings and dict names. */
	byText: { tree: Map<string, SrcTarget>; dict: Map<string, SrcTarget> } | null;
	/** The catalog has an XMP packet (not carried). */
	xmp: boolean;
	stats: SourceStats;
	ms: number;
}

class Damage extends Error {
	constructor(
		readonly kind: 'damaged' | 'large',
		message: string
	) {
		super(message);
	}
}

const cache = new WeakMap<Uint8Array, Promise<SourceDoc | null>>();

/** The document details, bookmarks and named destinations of a source (cached by its bytes). */
export function sourceDoc(qpdf: Qpdf, source: Source): Promise<SourceDoc | null> {
	let p = cache.get(source.bytes);
	if (!p) {
		p = readSourceDoc(qpdf, source.bytes, source.pages.length).catch(() => null);
		cache.set(source.bytes, p);
	}
	return p;
}

/**
 * A number with at most six significant digits: what a 32-bit float keeps. MuPDF's cleanup writes
 * reals as 32-bit floats, and a cleanup that writes a number the file did not have is turned down
 * (cleanup.ts sameStructure): a view coordinate such as 656.25747 would cost such files the
 * cleanup's saving. Six digits are 0.001 pt at 1000 pt: no visible change of the view.
 */
const six = (x: number) => (Number.isInteger(x) || x === 0 ? x : Number(x.toPrecision(6)));

function normView(rest: Json[], stats: SourceStats): View {
	const t = rest[0];
	const n = typeof t === 'string' ? VIEW_ARGS[t] : undefined;
	if (n === undefined) {
		stats.viewsFixed++;
		return ['/Fit'];
	}
	const ps = rest.slice(1, 1 + n).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : null));
	while (ps.length < n) ps.push(null);
	const rounded = ps.map((p) => (p === null ? null : six(p)));
	if (t === '/FitR' && ps.some((p) => p === null)) {
		stats.viewsFixed++;
		return ['/Fit'];
	}
	if (rest.length !== 1 + n || ps.some((p, i) => p !== rest[1 + i])) stats.viewsFixed++;
	return [t, ...rounded];
}

async function readSourceDoc(qpdf: Qpdf, bytes: Uint8Array, pageCount: number): Promise<SourceDoc | null> {
	const t0 = now();
	const stats: SourceStats = { items: 0, unresolved: 0, actions: {}, viewsFixed: 0, named: 0, both: 0, names: 0, depth: 0 };
	const small = await catalogDump(qpdf, bytes, false);
	if (!small) return null;
	const { catalog, trailer } = small;
	// Small indirect values (Info strings, /Lang, /ViewerPreferences, /Names) in one more run.
	const infoRef = trailer['/Info'];
	const info0 = dictAt(small.objects, infoRef);
	const want: string[] = [];
	for (const k of INFO_KEYS) if (info0 && isRef(info0[k])) want.push(info0[k] as string);
	for (const k of ['/Lang', '/ViewerPreferences', '/Names', '/PageMode']) if (isRef(catalog[k])) want.push(catalog[k] as string);
	const objs: Objects = { ...small.objects };
	if (want.length) {
		Object.assign(objs, await showObjects(qpdf, bytes, want));
	}

	let info: Dict | null = null;
	if (info0) {
		const d: Dict = {};
		for (const k of INFO_KEYS) {
			const v = val(objs, info0[k]);
			if (isStr(v) && textOf(v) !== 'u:') d[k] = v;
		}
		if (Object.keys(d).length) info = d;
	}
	const langV = val(objs, catalog['/Lang']);
	const lang = isStr(langV) && textOf(langV) !== 'u:' ? langV : undefined;
	let viewer: Dict | undefined;
	const vp = dictAt(objs, catalog['/ViewerPreferences']);
	if (vp) {
		const d: Dict = {};
		for (const k of VIEWER_BOOL) if (typeof vp[k] === 'boolean') d[k] = vp[k];
		for (const k of VIEWER_NAME) if (isName(vp[k])) d[k] = vp[k];
		if (Object.keys(d).length) viewer = d;
	}
	const pm = val(objs, catalog['/PageMode']);
	const pageMode = isName(pm) ? pm : undefined;
	const names = dictAt(objs, catalog['/Names']);
	const xmp = catalog['/Metadata'] !== undefined;

	const base = { info, lang, viewer, pageMode, xmp, stats };
	const needOutline = catalog['/Outlines'] !== undefined;
	const needNames = catalog['/Dests'] !== undefined || (names !== null && names['/Dests'] !== undefined);
	if (!needOutline && !needNames) return { ...base, outline: null, dests: null, byText: null, ms: Math.round(now() - t0) };
	const size = typeof trailer['/Size'] === 'number' ? (trailer['/Size'] as number) : 0;
	if (size > MAX_OBJECTS) {
		return {
			...base,
			outline: needOutline ? { problem: 'large', detail: `${size} objects` } : null,
			dests: null,
			namesProblem: needNames ? `${size} objects` : undefined,
			byText: null,
			ms: Math.round(now() - t0)
		};
	}
	const full = await dumpAll(qpdf, bytes);
	if (!full) return null;
	const o = full.objects;
	const pageIndex = new Map(full.pages.map((p, i) => [p, i]));
	if (full.pages.length !== pageCount) return { ...base, outline: needOutline ? { problem: 'damaged', detail: 'page list differs' } : null, dests: null, namesProblem: 'page list differs', byText: null, ms: Math.round(now() - t0) };

	const explicit = (v: Json, depth = 0): SrcTarget => {
		if (depth > 4) return 'bad';
		const a = arrAt(o, v);
		if (a) {
			const first = a[0];
			if (!isRef(first) || !pageIndex.has(first)) return 'bad';
			return { page: pageIndex.get(first)!, view: normView(a.slice(1).map((x) => val(o, x)), stats) };
		}
		const d = dictAt(o, v);
		if (d && d['/D'] !== undefined) return explicit(d['/D'], depth + 1);
		return 'bad';
	};

	// Named destinations: the catalog's /Dests dictionary (names) and the /Names /Dests tree (strings).
	const tree = new Map<string, SrcTarget>();
	const dict = new Map<string, SrcTarget>();
	const dests: NamedDest[] = [];
	let namesProblem: string | undefined;
	const dd = dictAt(o, catalog['/Dests']);
	if (catalog['/Dests'] !== undefined && !dd) namesProblem = '/Dests is not a dictionary';
	if (dd) {
		for (const [k, v] of Object.entries(dd)) {
			if (dict.has(k)) continue;
			const t = explicit(v);
			dict.set(k, t);
			stats.names++;
			if (t && t !== 'bad' && 'page' in t) dests.push({ kind: 'dict', key: k, page: t.page, view: t.view });
		}
	}
	const treeRoot = names ? (dictAt(o, catalog['/Names'])?.['/Dests'] ?? null) : null;
	if (treeRoot !== null && treeRoot !== undefined) {
		const seen = new Set<string>();
		const walk = (node: Json, depth: number): boolean => {
			if (isRef(node)) {
				if (seen.has(node)) return false;
				seen.add(node);
			}
			const d = dictAt(o, node);
			if (!d || depth > MAX_DEPTH) return false;
			const list = arrAt(o, d['/Names']);
			if (list) {
				for (let k = 0; k + 1 < list.length; k += 2) {
					const key = val(o, list[k]);
					if (!isStr(key)) continue;
					const text = textOf(key);
					if (tree.has(text)) continue;
					const t = explicit(list[k + 1]);
					tree.set(text, t);
					stats.names++;
					if (t && t !== 'bad' && 'page' in t) dests.push({ kind: 'tree', key, page: t.page, view: t.view });
				}
			}
			const kids = arrAt(o, d['/Kids']);
			if (kids) for (const kid of kids) if (!walk(kid, depth + 1)) return false;
			return true;
		};
		if (!walk(treeRoot, 0)) namesProblem = 'the name tree could not be read';
	}
	// An unreadable name tree: nothing that uses names can be resolved. Too many names: they are
	// still looked up (bookmarks, links), only not carried.
	const byText = namesProblem ? null : { tree, dict };
	if (!namesProblem && stats.names > MAX_NAMES) namesProblem = `${stats.names} names`;

	/** A /Dest value or a GoTo's /D: explicit, a name (dict) or a string (tree). */
	let namedUnreadable = false;
	const dest = (v0: Json): SrcTarget => {
		const v = val(o, v0);
		if (Array.isArray(v) || isDict(v)) return explicit(v);
		if (isName(v) || isStr(v)) {
			stats.named++;
			if (!byText) {
				namedUnreadable = true;
				return 'bad';
			}
			const t = isName(v) ? (byText.dict.get(v) ?? byText.tree.get(`u:${v.slice(1)}`)) : (byText.tree.get(textOf(v)) ?? byText.dict.get(`/${textOf(v).slice(2)}`));
			return t ?? 'bad';
		}
		return 'bad';
	};

	let outline: SourceDoc['outline'] = null;
	if (needOutline) {
		const root = dictAt(o, catalog['/Outlines']);
		try {
			if (!root) throw new Damage('damaged', '/Outlines is not a dictionary');
			const seen = new Set<string>();
			const level = (first: Json, depth: number): Item[] => {
				const out: Item[] = [];
				if (first === undefined || first === null) return out;
				if (depth > MAX_DEPTH) throw new Damage('damaged', `nested deeper than ${MAX_DEPTH}`);
				stats.depth = Math.max(stats.depth, depth + 1);
				let cur: Json = first;
				while (cur !== undefined && cur !== null) {
					if (!isRef(cur)) throw new Damage('damaged', 'an item is not an indirect object');
					if (seen.has(cur)) throw new Damage('damaged', `${cur} is reached twice`);
					seen.add(cur);
					if (++stats.items > MAX_ITEMS) throw new Damage('large', `more than ${MAX_ITEMS} bookmarks`);
					const d = dictAt(o, cur);
					if (!d) throw new Damage('damaged', `${cur} is not a dictionary`);
					out.push(parseItem(d, level(d['/First'], depth + 1)));
					cur = d['/Next'];
				}
				return out;
			};
			const parseItem = (d: Dict, kids: Item[]): Item => {
				const t = val(o, d['/Title']);
				const count = val(o, d['/Count']);
				const item: Item = { title: isStr(t) ? t : 'u:', target: null, open: typeof count === 'number' && count > 0, kids };
				const c = arrAt(o, d['/C'])?.map((x) => val(o, x));
				if (c && c.length === 3 && c.every((x) => typeof x === 'number' && x >= 0 && x <= 1)) item.c = (c as number[]).map(six);
				const f = val(o, d['/F']);
				if (typeof f === 'number' && Number.isInteger(f) && (f & 3) !== 0) item.f = f & 3;
				if (d['/Dest'] !== undefined) {
					if (d['/A'] !== undefined) stats.both++;
					item.target = dest(d['/Dest']);
				}
				else if (d['/A'] !== undefined) {
					const a = dictAt(o, d['/A']);
					const s = a ? val(o, a['/S']) : null;
					if (a && s === '/GoTo') item.target = dest(a['/D']);
					else if (a && s === '/URI') {
						const u = val(o, a['/URI']);
						item.target = isStr(u) ? { uri: u } : 'bad';
					} else {
						const name = typeof s === 'string' ? s : '?';
						stats.actions[name] = (stats.actions[name] ?? 0) + 1;
						item.target = 'bad';
						return item;
					}
				}
				if (item.target === 'bad') stats.unresolved++;
				return item;
			};
			const items = level(root['/First'], 0);
			if (namedUnreadable) throw new Damage('damaged', `named destinations: ${namesProblem}`);
			outline = items.length ? { items } : null;
		} catch (e) {
			if (!(e instanceof Damage)) throw e;
			outline = { problem: e.kind, detail: e.message };
		}
	}
	return { ...base, outline, dests: !namesProblem && dests.length ? dests : null, namesProblem, byText, ms: Math.round(now() - t0) };
}

// ------------------------------------------------------------------------------ planning

export interface OutlinePart {
	source: Source;
	doc: SourceDoc;
	/** Source page index → its first output page index. */
	out: Map<number, number>;
	/** Every page of the source is in the export. */
	whole: boolean;
}

export interface OutlinePlan {
	parts: OutlinePart[];
	/** Output page index → its source (id) and page index. */
	from: { sourceId: string; page: number }[];
	bookmarks: 'keep' | 'none' | { drop: BookmarksDropReason };
	info: Dict | null;
	/** ExportResult.docInfo when no graft runs or it succeeds (undefined: no source has details). */
	infoResult?: { kept: true } | { kept: false; reason: DocInfoDropReason };
	/** Carry named destinations and rewrite links that use them. */
	names: boolean;
	lang?: Json;
	viewer?: Dict;
	pageMode?: string;
}

/**
 * What this export keeps of its sources' details, bookmarks and names. Cheap for a source
 * without bookmarks or names (three `--json-object` runs); one with them is dumped once (cached).
 */
export async function planOutline(
	qpdf: Qpdf,
	pages: PageRef[],
	byId: Map<string, Source>,
	used: Source[],
	opts: { redaction: boolean; stripMetadata: boolean; noBookmarks?: boolean; noInfo?: boolean }
): Promise<OutlinePlan | null> {
	const pdfs = used.filter((s) => s.kind === 'pdf');
	if (!pdfs.length) return null;
	const parts: OutlinePart[] = [];
	for (const s of pdfs) {
		const doc = await sourceDoc(qpdf, s);
		if (!doc) continue;
		parts.push({ source: s, doc, out: new Map(), whole: false });
	}
	if (!parts.length) return null;
	const partOf = new Map(parts.map((p) => [p.source.id, p]));
	const from = pages.map((ref, i) => {
		const p = partOf.get(ref.sourceId);
		if (p && !p.out.has(ref.pageIndex)) p.out.set(ref.pageIndex, i);
		return { sourceId: ref.sourceId, page: ref.pageIndex };
	});
	for (const p of parts) p.whole = p.out.size === p.source.pages.length;

	const plan: OutlinePlan = { parts, from, bookmarks: 'none', info: null, names: false };
	if (parts.some((p) => p.doc.info)) {
		if (opts.stripMetadata) plan.infoResult = { kept: false, reason: opts.redaction ? 'redacted' : 'removed' };
		else if (pdfs.length > 1) plan.infoResult = { kept: false, reason: 'merged' };
		else if (opts.noInfo) plan.infoResult = { kept: false, reason: 'check' };
		else {
			plan.info = parts[0].doc.info;
			plan.infoResult = { kept: true };
		}
	}
	const withOutline = parts.filter((p) => p.doc.outline);
	if (withOutline.length) {
		const problems = withOutline.flatMap((p) => (p.doc.outline && 'problem' in p.doc.outline ? [p.doc.outline.problem] : []));
		const total = parts.reduce((n, p) => n + p.doc.stats.items, 0);
		if (opts.redaction) plan.bookmarks = { drop: 'redacted' };
		else if (opts.noBookmarks) plan.bookmarks = { drop: 'check' };
		else if (problems.length) plan.bookmarks = { drop: problems.every((k) => k === 'large') ? 'large' : 'damaged' };
		else if (total > MAX_ITEMS) plan.bookmarks = { drop: 'large' };
		else plan.bookmarks = 'keep';
	}
	plan.names = !opts.redaction && !opts.noBookmarks && parts.some((p) => p.doc.byText !== null && p.doc.stats.names > 0);
	const langs = parts.map((p) => (p.doc.lang === undefined ? null : textOf(p.doc.lang as string)));
	if (pdfs.length === parts.length && langs[0] !== null && langs.every((l) => l === langs[0])) plan.lang = parts[0].doc.lang;
	if (pdfs.length === 1) {
		plan.viewer = parts[0].doc.viewer;
		if (plan.bookmarks === 'keep' && parts[0].doc.pageMode === '/UseOutlines') plan.pageMode = '/UseOutlines';
	}
	return plan;
}

/** Whether `graftOutline` has anything to write. */
export function outlineWork(plan: OutlinePlan | null): boolean {
	return plan !== null && (plan.info !== null || plan.bookmarks === 'keep' || plan.names || plan.lang !== undefined || plan.viewer !== undefined);
}

// ------------------------------------------------------------------------------ graft

interface OutItem {
	title: string;
	/** Output page index and view, a URI, or none. */
	target: { out: number; view: View } | { uri: string } | null;
	open: boolean;
	c?: number[];
	f?: number;
	kids: OutItem[];
}

/**
 * The kept bookmarks of one source. Web links belong to no page and stay (measured: a file whose
 * outline is all web links would otherwise lose every bookmark when one page is removed); a heading
 * without destination stays when it keeps a child (or, whole file, when it never had any).
 */
function prune(items: Item[], part: OutlinePart): OutItem[] {
	const res: OutItem[] = [];
	for (const it of items) {
		const t = it.target;
		const kids = prune(it.kids, part);
		const keep = (target: OutItem['target']) => res.push({ title: it.title, target, open: it.open, ...(it.c ? { c: it.c } : {}), ...(it.f ? { f: it.f } : {}), kids });
		if (t === 'bad') res.push(...kids);
		else if (t && 'page' in t) {
			const o = part.out.get(t.page);
			if (o === undefined) res.push(...kids);
			else keep({ out: o, view: t.view });
		} else if (t && 'uri' in t) keep(t);
		else if (kids.length || (part.whole && it.kids.length === 0)) keep(null);
		else res.push(...kids);
	}
	return res;
}

export interface OutlineExpected {
	/** One line per bookmark, in order (null: the export has no outline). */
	items: string[] | null;
	/** Info entries as text (null: no Info dictionary). */
	info: Record<string, string> | null;
	/** Named destinations, one line each, sorted (null: none). */
	names: string[] | null;
	/** Rewritten links: output page index → their lines. */
	links: Map<number, string[]>;
	/** The catalog /Lang written here (as text); one tags.ts wrote is its check's. */
	lang?: string;
}

export interface OutlineGraft {
	bytes: Uint8Array;
	expected: OutlineExpected;
	/** Bookmarks written. */
	items: number;
	names: number;
	links: number;
	ms: number;
}

const round = (n: number) => Math.round(n * 1e4) / 1e4;
const viewCanon = (v: Json[]) => v.map((x) => (typeof x === 'number' ? round(x) : x));
const targetCanon = (t: OutItem['target']) => (t === null ? null : 'uri' in t ? ['U', textOf(t.uri)] : ['P', t.out + 1, ...viewCanon(t.view)]);
const itemLine = (depth: number, it: OutItem) => JSON.stringify([depth, textOf(it.title), targetCanon(it.target), it.kids.length ? it.open : null, it.c ? it.c.map(round) : null, it.f ?? null]);
const rectCanon = (r: Json[] | null) => (r ? r.map((x) => (typeof x === 'number' ? Math.round(x * 100) / 100 : null)) : null);

/**
 * Writes the plan's details, bookmarks and names into `assembled` (pages in place). Null when it
 * cannot be written (the caller exports without them).
 */
export async function graftOutline(qpdf: Qpdf, assembled: Uint8Array, plan: OutlinePlan, note: (s: string) => void = () => {}): Promise<OutlineGraft | null> {
	const t0 = now();
	const out = await catalogDump(qpdf, assembled, plan.names);
	if (!out || out.pages.length !== plan.from.length) {
		note('outline: the assembled file could not be read');
		return null;
	}
	const oo = out.objects;
	let next = (typeof out.header.maxobjectid === 'number' ? out.header.maxobjectid : 0) + 1;
	if (next <= 1) {
		note('outline: no object count in the assembled file');
		return null;
	}
	const fresh = () => `${next++} 0 R`;
	const updates: Record<string, Obj> = {};
	const cat: Dict = { ...out.catalog };
	const expected: OutlineExpected = { items: null, info: null, names: null, links: new Map() };

	// Bookmarks.
	let written = 0;
	if (plan.bookmarks === 'keep') {
		const items = plan.parts.flatMap((p) => (p.doc.outline && 'items' in p.doc.outline ? prune(p.doc.outline.items, p) : []));
		if (items.length) {
			const lines: string[] = [];
			const rootRef = fresh();
			/** Writes one level; returns its first and last refs and the visible descendants if open. */
			const level = (list: OutItem[], parent: string, depth: number): { first: string; last: string; visible: number } => {
				const refs = list.map(() => fresh());
				let visible = 0;
				list.forEach((it, i) => {
					lines.push(itemLine(depth, it));
					written++;
					const d: Dict = { '/Title': it.title, '/Parent': parent };
					if (i > 0) d['/Prev'] = refs[i - 1];
					if (i < list.length - 1) d['/Next'] = refs[i + 1];
					visible++;
					if (it.kids.length) {
						const sub = level(it.kids, refs[i], depth + 1);
						d['/First'] = sub.first;
						d['/Last'] = sub.last;
						d['/Count'] = it.open ? sub.visible : -sub.visible;
						if (it.open) visible += sub.visible;
					}
					const t = it.target;
					if (t && 'out' in t) d['/Dest'] = [out.pages[t.out], ...t.view];
					else if (t) d['/A'] = { '/S': '/URI', '/URI': t.uri };
					if (it.c) d['/C'] = it.c;
					if (it.f) d['/F'] = it.f;
					updates[objKey(refs[i])] = { value: d };
				});
				return { first: refs[0], last: refs[refs.length - 1], visible };
			};
			const top = level(items, rootRef, 0);
			updates[objKey(rootRef)] = { value: { '/Type': '/Outlines', '/First': top.first, '/Last': top.last, '/Count': top.visible } };
			cat['/Outlines'] = rootRef;
			expected.items = lines;
			if (plan.pageMode && cat['/PageMode'] === undefined) cat['/PageMode'] = plan.pageMode;
		}
	}
	if (cat['/Outlines'] !== undefined && expected.items === null) delete cat['/Outlines'];

	// Named destinations and the links that use them.
	let nameCount = 0;
	let linkCount = 0;
	if (plan.names) {
		type Entry = { kind: 'tree' | 'dict'; key: string; bytes: Uint8Array; out: number; view: View };
		const byKey = new Map<string, Entry | null>();
		for (const p of plan.parts) {
			for (const nd of p.doc.dests ?? []) {
				const o = p.out.get(nd.page);
				if (o === undefined) continue;
				const bytes = nd.kind === 'tree' ? stringBytes(nd.key) : new TextEncoder().encode(nd.key);
				const id = `${nd.kind}:${hex(bytes)}`;
				const e: Entry = { kind: nd.kind, key: nd.key, bytes, out: o, view: nd.view };
				if (!byKey.has(id)) byKey.set(id, e);
				else {
					// Two files define the same name: kept only when both go to the same place.
					const prev = byKey.get(id);
					if (prev && (prev.out !== o || JSON.stringify(viewCanon(prev.view)) !== JSON.stringify(viewCanon(nd.view)))) byKey.set(id, null);
				}
			}
		}
		const entries = [...byKey.values()].filter((e): e is Entry => e !== null);
		const treeEntries = entries.filter((e) => e.kind === 'tree').sort((a, b) => cmpBytes(a.bytes, b.bytes));
		const dictEntries = entries.filter((e) => e.kind === 'dict');
		const lines: string[] = [];
		const destOf = (e: Entry) => [out.pages[e.out], ...e.view];
		if (treeEntries.length) {
			const key = (e: Entry) => `b:${hex(e.bytes)}`;
			const treeRef = fresh();
			if (treeEntries.length <= LEAF) updates[objKey(treeRef)] = { value: { '/Names': treeEntries.flatMap((e) => [key(e), destOf(e)]) } };
			else {
				const kids: string[] = [];
				for (let at = 0; at < treeEntries.length; at += LEAF) {
					const chunk = treeEntries.slice(at, at + LEAF);
					const leaf = fresh();
					kids.push(leaf);
					updates[objKey(leaf)] = { value: { '/Limits': [key(chunk[0]), key(chunk[chunk.length - 1])], '/Names': chunk.flatMap((e) => [key(e), destOf(e)]) } };
				}
				updates[objKey(treeRef)] = { value: { '/Kids': kids } };
			}
			const names = dictAt(oo, cat['/Names']);
			cat['/Names'] = { ...(names ?? {}), '/Dests': treeRef };
			for (const e of treeEntries) lines.push(JSON.stringify(['tree', textOf(key(e)), e.out + 1, ...viewCanon(e.view)]));
		}
		if (dictEntries.length) {
			const ref = fresh();
			const d: Dict = {};
			for (const e of dictEntries) d[e.key] = destOf(e);
			updates[objKey(ref)] = { value: d };
			cat['/Dests'] = ref;
			for (const e of dictEntries) lines.push(JSON.stringify(['dict', e.key, e.out + 1, ...viewCanon(e.view)]));
		}
		nameCount = entries.length;
		if (lines.length) expected.names = lines.sort();

		// Links on kept pages that go to a name: rewritten to the explicit destination.
		const partOf = new Map(plan.parts.map((p) => [p.source.id, p]));
		const done = new Set<string>();
		plan.from.forEach((f, i) => {
			const part = partOf.get(f.sourceId);
			const look = part?.doc.byText;
			if (!part || !look) return;
			const pd = dictAt(oo, out.pages[i]);
			const annots = pd ? (arrAt(oo, pd['/Annots']) ?? []) : [];
			for (const a of annots) {
				if (!isRef(a)) continue;
				const ad = dictAt(oo, a);
				if (!ad || ad['/Subtype'] !== '/Link') continue;
				const resolve = (v0: Json): { out: number; view: View } | null => {
					const v = val(oo, v0);
					let t: SrcTarget | undefined;
					if (isName(v)) t = look.dict.get(v) ?? look.tree.get(`u:${v.slice(1)}`);
					else if (isStr(v)) t = look.tree.get(textOf(v)) ?? look.dict.get(`/${textOf(v).slice(2)}`);
					if (!t || t === 'bad' || !('page' in t)) return null;
					const o = part.out.get(t.page);
					return o === undefined ? null : { out: o, view: t.view };
				};
				let target: { out: number; view: View } | null = null;
				if (ad['/Dest'] !== undefined) {
					target = resolve(ad['/Dest']);
					if (target && !done.has(a)) updates[objKey(a)] = { value: { ...ad, '/Dest': [out.pages[target.out], ...target.view] } };
				} else if (ad['/A'] !== undefined) {
					const act = dictAt(oo, ad['/A']);
					if (!act || act['/S'] !== '/GoTo') continue;
					target = resolve(act['/D']);
					if (target && !done.has(a)) {
						const na = { ...act, '/D': [out.pages[target.out], ...target.view] };
						if (isRef(ad['/A'])) updates[objKey(ad['/A'] as string)] = { value: na };
						else updates[objKey(a)] = { value: { ...ad, '/A': na } };
					}
				}
				if (!target) continue;
				done.add(a);
				linkCount++;
				const list = expected.links.get(i) ?? [];
				list.push(JSON.stringify([rectCanon(arrAt(oo, ad['/Rect'])?.map((x) => val(oo, x)) ?? null), targetCanon(target)]));
				expected.links.set(i, list);
			}
		});
	}

	// Catalog keys tags.ts may have set already.
	if (plan.lang !== undefined && cat['/Lang'] === undefined) {
		cat['/Lang'] = plan.lang;
		expected.lang = textOf(plan.lang as string);
	}
	if (plan.viewer && cat['/ViewerPreferences'] === undefined) cat['/ViewerPreferences'] = plan.viewer;
	updates[objKey(out.catalogRef)] = { value: cat };

	// Document details: a new Info dictionary, no XMP packet in the catalog.
	if (plan.info) {
		const infoRef = fresh();
		updates[objKey(infoRef)] = { value: { ...plan.info } };
		updates.trailer = { value: { ...out.trailer, '/Info': infoRef } };
		expected.info = Object.fromEntries(Object.entries(plan.info).map(([k, v]) => [k, textOf(v as string)]));
		if (cat['/Metadata'] !== undefined) delete cat['/Metadata'];
	}

	const json = new TextEncoder().encode(jsonText({ qpdf: [{ jsonversion: 2 }, updates] }));
	const res = await qpdf.run({
		args: ['/g.pdf', '--update-from-json=/g.json', '--object-streams=disable', '/g-out.pdf'],
		inputs: { '/g.pdf': assembled, '/g.json': json },
		outputs: ['/g-out.pdf']
	});
	const bytes = res.files.get('/g-out.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !bytes) {
		note(`outline: qpdf could not write (${res.stderr.slice(0, 200)})`);
		return null;
	}
	return { bytes, expected, items: written, names: nameCount, links: linkCount, ms: Math.round(now() - t0) };
}

// ------------------------------------------------------------------------------ verify

/** What failed in `verifyOutline` (the caller rebuilds without that part). */
export interface OutlineFailure {
	bookmarks: boolean;
	info: boolean;
}

/** The outline of a file read strictly: one line per item, or what is wrong. */
function readOutline(o: Objects, catalog: Dict, pageNo: Map<string, number>): { lines: string[] } | { error: string } {
	const lines: string[] = [];
	if (catalog['/Outlines'] === undefined) return { lines };
	const rootRef = catalog['/Outlines'];
	const root = dictAt(o, rootRef);
	if (!isRef(rootRef) || !root) return { error: 'the outline root is not an indirect dictionary' };
	const seen = new Set<string>([rootRef]);
	let count = 0;
	const err = (s: string) => {
		throw new Damage('damaged', s);
	};
	const targetOf = (d: Dict): Json => {
		if (d['/Dest'] !== undefined) {
			const a = arrAt(o, d['/Dest']);
			if (!a || !isRef(a[0]) || !pageNo.has(a[0])) err('a bookmark does not go to a page of the file');
			const rest = a!.slice(1).map((x) => val(o, x));
			if (d['/A'] !== undefined) err('a bookmark has both /Dest and /A');
			return ['P', pageNo.get(a![0] as string)! + 1, ...viewCanon(rest)];
		}
		if (d['/A'] !== undefined) {
			const a = dictAt(o, d['/A']);
			if (!a || a['/S'] !== '/URI' || a['/Next'] !== undefined) err('a bookmark has an action other than a web link');
			const u = val(o, a!['/URI']);
			if (!isStr(u)) err('a web link without its address');
			return ['U', textOf(u as string)];
		}
		return null;
	};
	/** Reads the children of `parent`; returns the visible descendants when it is open. */
	const level = (parentRef: string, parent: Dict, depth: number): number => {
		let cur = parent['/First'];
		let prev: string | null = null;
		let visible = 0;
		if (depth > MAX_DEPTH) err('too deep');
		while (cur !== undefined && cur !== null) {
			if (!isRef(cur)) err('an item is not an indirect object');
			const ref = cur as string;
			if (seen.has(ref)) err(`${ref} is reached twice`);
			seen.add(ref);
			if (++count > MAX_ITEMS) err('too many bookmarks');
			const d = dictAt(o, ref);
			if (!d) err(`${ref} is not a dictionary`);
			if (d!['/Parent'] !== parentRef) err(`${ref} has the wrong /Parent`);
			if ((prev === null && d!['/Prev'] !== undefined) || (prev !== null && d!['/Prev'] !== prev)) err(`${ref} has the wrong /Prev`);
			const at = lines.length;
			lines.push('');
			const sub = d!['/First'] !== undefined ? level(ref, d!, depth + 1) : -1;
			const cnt = val(o, d!['/Count']);
			let open: boolean | null = null;
			if (sub >= 0) {
				if (typeof cnt !== 'number' || Math.abs(cnt) !== sub || cnt === 0) err(`${ref} /Count ${String(cnt)} for ${sub} visible descendants`);
				open = (cnt as number) > 0;
			} else if (cnt !== undefined && cnt !== 0) err(`${ref} has /Count without children`);
			if (d!['/SE'] !== undefined) err('a bookmark points at a structure element');
			const t = val(o, d!['/Title']);
			if (!isStr(t)) err(`${ref} has no title`);
			const c = arrAt(o, d!['/C'])?.map((x) => val(o, x));
			const f = val(o, d!['/F']);
			lines[at] = JSON.stringify([depth, textOf(t as string), targetOf(d!), open, c ? c.map((x) => (typeof x === 'number' ? round(x) : x)) : null, typeof f === 'number' ? f : null]);
			visible += 1 + (open ? sub : 0);
			prev = ref;
			cur = d!['/Next'];
		}
		if ((parent['/Last'] ?? null) !== prev) err(`/Last of ${parentRef} is not its last child`);
		return visible;
	};
	try {
		const visible = level(rootRef, root, 0);
		const rc = val(o, root['/Count']);
		if (rc !== undefined && rc !== visible) err(`the outline's /Count is ${String(rc)}, ${visible} are visible`);
	} catch (e) {
		if (e instanceof Damage) return { error: e.message };
		throw e;
	}
	return { lines };
}

function readNames(o: Objects, catalog: Dict, pageNo: Map<string, number>): { lines: string[] } | { error: string } {
	const lines: string[] = [];
	const dest = (v: Json): Json[] | null => {
		const a = arrAt(o, v);
		if (!a || !isRef(a[0]) || !pageNo.has(a[0])) return null;
		return [pageNo.get(a[0] as string)! + 1, ...viewCanon(a.slice(1).map((x) => val(o, x)))];
	};
	const names = dictAt(o, catalog['/Names']);
	if (names && names['/Dests'] !== undefined) {
		const seen = new Set<string>();
		let last: Uint8Array | null = null;
		const walk = (node: Json, depth: number, isRoot: boolean): string | null => {
			if (isRef(node)) {
				if (seen.has(node)) return 'a name-tree node is reached twice';
				seen.add(node);
			}
			const d = dictAt(o, node);
			if (!d || depth > 8) return 'a name-tree node is not a dictionary';
			if (isRoot && d['/Limits'] !== undefined) return 'the name-tree root has /Limits';
			const list = arrAt(o, d['/Names']);
			const kids = arrAt(o, d['/Kids']);
			const lim = arrAt(o, d['/Limits'])?.map((x) => val(o, x));
			let first: Uint8Array | null = null;
			let lastHere: Uint8Array | null = null;
			if (list) {
				if (list.length % 2) return 'a name-tree leaf has an odd number of entries';
				for (let k = 0; k < list.length; k += 2) {
					const key = val(o, list[k]);
					if (!isStr(key)) return 'a name-tree key is not a string';
					const b = stringBytes(key);
					if (last && cmpBytes(last, b) >= 0) return 'the name tree is not sorted';
					last = b;
					first ??= b;
					lastHere = b;
					const t = dest(list[k + 1]);
					if (!t) return `the name ${textOf(key)} does not go to a page of the file`;
					lines.push(JSON.stringify(['tree', textOf(key), ...t]));
				}
			}
			if (kids) {
				for (const kid of kids) {
					const before = lines.length;
					const e = walk(kid, depth + 1, false);
					if (e) return e;
					if (lines.length === before) return 'an empty name-tree node';
				}
			}
			if (!isRoot && list) {
				if (!lim || lim.length !== 2 || !isStr(lim[0]) || !isStr(lim[1])) return 'a name-tree leaf without /Limits';
				if (cmpBytes(stringBytes(lim[0] as string), first!) !== 0 || cmpBytes(stringBytes(lim[1] as string), lastHere!) !== 0) return 'name-tree /Limits do not match';
			}
			return null;
		};
		const e = walk(names['/Dests'], 0, true);
		if (e) return { error: e };
	}
	const dd = dictAt(o, catalog['/Dests']);
	if (catalog['/Dests'] !== undefined && !dd) return { error: '/Dests is not a dictionary' };
	if (dd) {
		for (const [k, v] of Object.entries(dd)) {
			const t = dest(v);
			if (!t) return { error: `the name ${k} does not go to a page of the file` };
			lines.push(JSON.stringify(['dict', k, ...t]));
		}
	}
	return { lines: lines.sort() };
}

function firstDiff(a: string[], b: string[]): string {
	for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) return `item ${i + 1}: ${(a[i] ?? 'nothing').slice(0, 160)} (expected ${(b[i] ?? 'nothing').slice(0, 160)})`;
	return '';
}

/** The final file's details, bookmarks, names and rewritten links, against what the graft wrote. */
export async function verifyOutline(qpdf: Qpdf, bytes: Uint8Array, expected: OutlineExpected, password?: string): Promise<{ check: VerifyCheck; failed: OutlineFailure }> {
	const t0 = now();
	const failed: OutlineFailure = { bookmarks: false, info: false };
	const problems: string[] = [];
	const nav = expected.items !== null || expected.names !== null || expected.links.size > 0;
	const d = await catalogDump(qpdf, bytes, nav, password);
	if (!d) {
		return { check: { name: 'outline', ok: false, detail: 'qpdf could not read the exported file’s objects.' }, failed: { bookmarks: nav, info: expected.info !== null } };
	}
	const o = d.objects;
	const pageNo = new Map(d.pages.map((p, i) => [p, i]));

	if (expected.info) {
		const info = dictAt(o, d.trailer['/Info']);
		const got: Record<string, string> = {};
		for (const [k, v] of Object.entries(info ?? {})) {
			const s = val(o, v);
			got[k] = isStr(s) ? textOf(s) : JSON.stringify(s);
		}
		const want = JSON.stringify(Object.entries(expected.info).sort());
		if (!info) problems.push('the document details are missing');
		else if (JSON.stringify(Object.entries(got).sort()) !== want) problems.push(`the document details differ: ${JSON.stringify(got).slice(0, 200)}`);
		else if (d.catalog['/Metadata'] !== undefined) problems.push('an XMP packet sits next to the document details');
		if (problems.length) failed.info = true;
	}
	const before = problems.length;
	if (nav) {
		const ol = readOutline(o, d.catalog, pageNo);
		if ('error' in ol) problems.push(`bookmarks: ${ol.error}`);
		else if (expected.items === null ? ol.lines.length > 0 : ol.lines.length !== expected.items.length || ol.lines.some((l, i) => l !== expected.items![i])) {
			problems.push(`bookmarks: ${ol.lines.length} found, ${expected.items?.length ?? 0} expected; ${firstDiff(ol.lines, expected.items ?? [])}`);
		}
		const nm = readNames(o, d.catalog, pageNo);
		if ('error' in nm) problems.push(`named destinations: ${nm.error}`);
		else if (JSON.stringify(nm.lines) !== JSON.stringify(expected.names ?? [])) problems.push(`named destinations: ${nm.lines.length} found, ${expected.names?.length ?? 0} expected; ${firstDiff(nm.lines, expected.names ?? [])}`);
		for (const [i, want] of expected.links) {
			const pd = dictAt(o, d.pages[i]);
			const have = new Map<string, number>();
			for (const a of pd ? (arrAt(o, pd['/Annots']) ?? []) : []) {
				const ad = dictAt(o, a);
				if (!ad || ad['/Subtype'] !== '/Link') continue;
				const dv = ad['/Dest'] !== undefined ? ad['/Dest'] : dictAt(o, ad['/A'])?.['/S'] === '/GoTo' ? dictAt(o, ad['/A'])!['/D'] : undefined;
				const arr = arrAt(o, dv);
				if (!arr || !isRef(arr[0]) || !pageNo.has(arr[0])) continue;
				const line = JSON.stringify([rectCanon(arrAt(o, ad['/Rect'])?.map((x) => val(o, x)) ?? null), ['P', pageNo.get(arr[0] as string)! + 1, ...viewCanon(arr.slice(1).map((x) => val(o, x)))]]);
				have.set(line, (have.get(line) ?? 0) + 1);
			}
			for (const w of want) {
				const n = have.get(w) ?? 0;
				if (n === 0) {
					problems.push(`a link on page ${i + 1} does not go where it should: ${w.slice(0, 160)}`);
					break;
				}
				have.set(w, n - 1);
			}
		}
		if (problems.length > before) failed.bookmarks = true;
	}
	if (expected.lang !== undefined) {
		const l = val(o, d.catalog['/Lang']);
		if (!isStr(l) || textOf(l) !== expected.lang) problems.push('the document language differs');
	}
	if (problems.length) {
		if (!failed.info && !failed.bookmarks) {
			failed.info = expected.info !== null;
			failed.bookmarks = nav;
		}
		return { check: { name: 'outline', ok: false, detail: problems.join('; ') }, failed };
	}
	const parts: string[] = [];
	if (expected.info) parts.push(`Document details kept (${Object.keys(expected.info).map((k) => k.slice(1)).join(', ')}), with no XMP packet to disagree with them`);
	if (expected.items) parts.push(`${n(expected.items.length, 'bookmark')} kept, each going to its page, the tree consistent`);
	if (expected.names) parts.push(`${n(expected.names.length, 'named destination')} kept`);
	const links = [...expected.links.values()].reduce((k, l) => k + l.length, 0);
	if (links) parts.push(`${n(links, 'link')} to named destinations go to their page`);
	if (!parts.length) parts.push('Document language and viewer settings kept');
	return { check: { name: 'outline', ok: true, detail: `${parts.join('; ')} (${Math.round(now() - t0)} ms).` }, failed };
}

const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

// ------------------------------------------------------------------------------ tools and tests

/** The bookmarks of a file as lines (as `verifyOutline` reads them), for tests and the survey harness. */
export async function outlineLines(qpdf: Qpdf, bytes: Uint8Array, password?: string): Promise<{ lines: string[]; names: string[] } | { error: string }> {
	const d = await catalogDump(qpdf, bytes, true, password);
	if (!d) return { error: 'unreadable' };
	const pageNo = new Map(d.pages.map((p, i) => [p, i]));
	const ol = readOutline(d.objects, d.catalog, pageNo);
	if ('error' in ol) return ol;
	const nm = readNames(d.objects, d.catalog, pageNo);
	if ('error' in nm) return nm;
	return { lines: ol.lines, names: nm.lines };
}

/** For the survey harness: what a source has, read as at planning time (not cached). */
export async function inspectOutline(qpdf: Qpdf, bytes: Uint8Array, pageCount: number): Promise<{ title: boolean; info: boolean; xmp: boolean; outline: 'none' | 'ok' | 'damaged' | 'large'; detail?: string; names: number; namesProblem?: string; stats: SourceStats; ms: number } | null> {
	const d = await readSourceDoc(qpdf, bytes, pageCount).catch(() => null);
	if (!d) return null;
	const ol = d.outline;
	return {
		title: d.info?.['/Title'] !== undefined,
		info: d.info !== null,
		xmp: d.xmp,
		outline: ol === null ? 'none' : 'problem' in ol ? ol.problem : 'ok',
		detail: ol && 'problem' in ol ? ol.detail : undefined,
		names: d.stats.names,
		namesProblem: d.namesProblem,
		stats: d.stats,
		ms: d.ms
	};
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
