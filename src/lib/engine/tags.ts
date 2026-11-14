/**
 * Accessibility tags (the logical structure tree) across an export.
 *
 * Where they were lost: the assemble step (assemble.ts) builds every export as a new
 * document. `qpdf --empty --pages` copies pages but not the catalog, and the in-place
 * path for forms reduces the catalog to pages, form, layers and page labels; either way
 * /StructTreeRoot, /MarkInfo, /Lang and /ViewerPreferences were gone, and with them every
 * /Alt, /ActualText, heading, table and the reading order. The pages kept their
 * /StructParents and their content kept its MCIDs, pointing at nothing.
 *
 * What happens now (`planTags` decides, `graftTags` writes, `verifyTags` proves):
 *
 * - Kept: the export's pages come from tagged sources, each source page at most once, in
 *   any order and rotation, with or without blank pages added (they have no content).
 *   One source, all its pages: the whole tree. Some pages removed: the tree pruned to the
 *   kept pages (below). Several tagged sources: each tree pruned to its pages, all under one
 *   new root in the order the files first appear; the second file's ParentTree keys move past
 *   the first's (its pages', annotations' and XObjects' /StructParent(s) change with them),
 *   RoleMaps and ClassMaps are joined, IDTrees joined and sorted, /Namespaces appended;
 *   /MarkInfo comes from the first file that has one, /Lang and /ViewerPreferences from the
 *   first file, and a later file whose /Lang differs puts its /Lang on its top elements.
 *   Each source's tree is copied as new objects into the assembled file, with every
 *   reference to a page, annotation or form XObject turned into the reference to its copy
 *   (found by walking each source page next to its output page: /Annots by position,
 *   /Resources /XObject by name, recursively). /StructParents numbers of the first source
 *   stay as they are; the ParentTree is rebuilt as one flat number tree keeping the entries
 *   whose owner (page, annotation, XObject) is in the export. Reordered pages keep the tree's
 *   order: it is the logical reading order of the document, which page order does not change.
 * - Pruned (pages removed): a struct element whose content (marked content, annotations)
 *   all lies on removed pages is dropped, with its descendants; one with no content at all
 *   stays where its parent stays. An element whose content lies partly on removed pages
 *   stays but loses /Alt, /ActualText, /E, /T and its table /Summary: those may describe
 *   what was removed (removing pages must not leave their text behind, as for the outline).
 *   /Ref entries to dropped elements go; /Pg to a removed page goes.
 * - Not kept (the export has no tags, exactly as before, and the result says why):
 *   anything blacked out (`redacted`: the tree and property lists can spell out what was
 *   removed; see redact.ts for marked-content properties); locked (flattened) forms of a
 *   tagged file (`flattened`: widgets become page content, the tree's form entries would
 *   point at nothing); pages from a file without tags other than blank pages, or trees that
 *   map a role or class two ways or share an ID (`merged`: pages outside the tree would be
 *   skipped by readers that follow it); a page used twice (`repeated`: two pages cannot
 *   share one set of MCIDs); a source whose tree is inconsistent (`damaged`: every problem
 *   kind in FATAL); more than MAX_ELEMENTS elements or MAX_OBJECTS objects (`large`); a tree
 *   this code does not copy exactly (`unsupported`: an annotation or XObject on a kept page
 *   without its copy, a value qpdf's JSON cannot write back such as an empty name, streams in
 *   the tree over MAX_STREAM_CHARS; embedded files of /AF entries and other streams are
 *   copied with their stored data); and an export whose own check of the tags fails
 *   (`check`; the export is then built again without them).
 *
 * Added content (stamps, page numbers, the OCR text layer) is drawn as `/Artifact` marked
 * content, after closing any marked-content sequence the page leaves open, so it never
 * joins a struct element's content and checkers do not see untagged content. Typed answers
 * are artifacts too, so screen readers do not read them (a known limit).
 *
 * The check (`verifyTags`, on the final file, with its password): the tree is read again
 * from the export (qpdf JSON) and turned into a canonical form (each element's role and
 * keys with references replaced by output page numbers, annotation positions and element
 * numbers, its kids as element numbers, (page, MCID) and (page, annotation) pairs), which
 * must equal the one expected from the source (computed from the source's own tree, not
 * from what was written); every page's, annotation's and XObject's MCIDs and OBJRs must
 * resolve through the ParentTree to the element that holds them, and the ParentTree must
 * name no element for content that element does not hold; every MCID the tree gives a page
 * must be in that page's content (or the XObject's); no element may point at a page that
 * is not in the file. Problems the source itself has are found by the same check at
 * `planTags` time: a source with any is `damaged` (no tags), so the export has none either.
 */

import type { PageRef, Source, TagsDropReason, VerifyCheck } from '../core/types';
import { markedContent } from './marked';
import { catalogHas, catalogText, isDict, isRef, objArg, objKey, type Dict } from './oc';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';

type Json = unknown;
interface Obj {
	value?: Json;
	stream?: { dict?: Json; data?: string };
}
type Objects = Record<string, Obj>;

export type { TagsDropReason };

/**
 * Most struct elements carried: a time budget. Measured in Node on the box (survey 2026-11-13),
 * keeping the tags adds about 0.6 to 2.4 ms per element to an export (the tree is read, copied
 * and checked as JSON, and every lossless pass dumps it again), so 25,000 elements cost up to
 * about a minute there, and more on a phone. Above it: no tags ('large').
 */
export const MAX_ELEMENTS = 25_000;
/** Most objects in a tagged source whose tree is read (every object is dumped as JSON once). */
export const MAX_OBJECTS = 500_000;
/** Most stream data in the tree carried (base64 characters: about 24 MB of data). */
const MAX_STREAM_CHARS = 32 * 1024 * 1024;
/** Text keys dropped from an element whose content lies partly on removed pages. */
const PRUNED_TEXT = ['/Alt', '/ActualText', '/E', '/T'];
/**
 * The empty name (`/`), which qpdf's JSON prints but cannot read back: a key with it as its
 * value is left out of the copy (and of the expected tree), an array entry becomes null. It
 * names nothing (seen as /Role and /Scope values of form and table attributes).
 */
const EMPTY_NAME = '/';
const TEXT_KEYS = ['/Alt', '/ActualText', '/E', '/T'];

// ------------------------------------------------------------------------------ dumps

interface Dump {
	header: Dict;
	objects: Objects;
	/** Page objects in order. */
	pages: string[];
	/** Content stream refs of each page, in order. */
	contents: string[][];
}

async function dumpAll(qpdf: Qpdf, bytes: Uint8Array, password?: string): Promise<Dump | null> {
	const pw = password !== undefined ? [`--password=${password}`] : [];
	const res = await qpdf.run({
		args: [...pw, '--json=2', '--json-key=qpdf', '--json-key=pages', '--json-stream-data=none', '/t.pdf', '/t.json'],
		inputs: { '/t.pdf': bytes },
		outputs: ['/t.json']
	});
	const file = res.files.get('/t.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	try {
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Objects]; pages?: { object: string; contents?: string[] }[] };
		const pages = parsed.pages ?? [];
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1], pages: pages.map((p) => p.object), contents: pages.map((p) => p.contents ?? []) };
	} catch {
		return null;
	}
}

/** Decoded data of the given streams; null for one qpdf could not decode. */
async function streamData(qpdf: Qpdf, bytes: Uint8Array, refs: string[], password?: string): Promise<Map<string, Uint8Array | null> | null> {
	const out = new Map<string, Uint8Array | null>();
	const pw = password !== undefined ? [`--password=${password}`] : [];
	const unique = [...new Set(refs)];
	for (let at = 0; at < unique.length; at += 4000) {
		const chunk = unique.slice(at, at + 4000);
		const res = await qpdf.run({
			args: [...pw, '--json=2', '--json-key=qpdf', ...chunk.map((r) => `--json-object=${objArg(r)}`), '--json-stream-data=inline', '--decode-level=generalized', '/t.pdf', '/t.json'],
			inputs: { '/t.pdf': bytes },
			outputs: ['/t.json']
		});
		const file = res.files.get('/t.json');
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
		let objects: Objects;
		try {
			objects = (JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Objects] }).qpdf[1];
		} catch {
			return null;
		}
		for (const r of chunk) {
			const s = objects[objKey(r)]?.stream;
			const dict = s?.dict;
			if (!s || typeof s.data !== 'string' || (isDict(dict) && dict['/Filter'] !== undefined && !emptyFilter(dict['/Filter']))) {
				out.set(r, null);
				continue;
			}
			out.set(r, base64(s.data));
		}
	}
	return out;
}

/** Stored (still encoded) data of the given streams, base64, as qpdf's JSON gives it. */
async function rawStreams(qpdf: Qpdf, bytes: Uint8Array, refs: string[]): Promise<Map<string, string> | null> {
	const res = await qpdf.run({
		args: ['--json=2', '--json-key=qpdf', ...refs.map((r) => `--json-object=${objArg(r)}`), '--json-stream-data=inline', '--decode-level=none', '/t.pdf', '/t.json'],
		inputs: { '/t.pdf': bytes },
		outputs: ['/t.json']
	});
	const file = res.files.get('/t.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) return null;
	try {
		const objects = (JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Objects] }).qpdf[1];
		const out = new Map<string, string>();
		for (const r of refs) {
			const d = objects[objKey(r)]?.stream?.data;
			if (typeof d === 'string') out.set(r, d);
		}
		return out;
	} catch {
		return null;
	}
}

function emptyFilter(f: Json): boolean {
	return Array.isArray(f) && f.length === 0;
}

function base64(s: string): Uint8Array {
	if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
	const bin = atob(s);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

// ------------------------------------------------------------------------------ model

type Kid =
	| { k: 'e'; i: number }
	/** Marked content: MCID on `page` (a page object), or inside the form XObject `stm` drawn on it. */
	| { k: 'm'; mcid: number; page: string | null; stm: string | null; raw: Json }
	/** An object reference (annotation or XObject). */
	| { k: 'o'; obj: string; page: string | null; raw: Json };

interface Elem {
	ref: string;
	dict: Dict;
	/** Parent element index, -1 for a child of the root. */
	parent: number;
	kids: Kid[];
	/** The /K value was an array (kept as written). */
	kArray: boolean;
}

export interface Problem {
	kind:
		| 'unreadable'
		| 'shared-element'
		| 'bad-kid'
		| 'unknown-page'
		| 'unplaced'
		| 'pt-missing'
		| 'pt-mismatch'
		| 'pt-extra'
		| 'mcid-shared'
		| 'mcid-missing'
		| 'objr-missing'
		| 'key-shared'
		| 'content-unreadable'
		| 'too-many';
	/** 0-based page index, when the problem belongs to a page. */
	page?: number;
	detail?: string;
}

export interface TagModel {
	objects: Objects;
	header: Dict;
	catalogRef: string;
	catalog: Dict;
	rootRef: string;
	root: Dict;
	pages: string[];
	pageIndex: Map<string, number>;
	contents: string[][];
	elems: Elem[];
	elemOf: Map<string, number>;
	/** ParentTree, flattened. */
	pt: Map<number, Json>;
	/** IDTree entries, in order. */
	ids: [Json, Json][];
	/** Owners of ParentTree keys: page, annotation or XObject. */
	owners: Map<number, { ref: string; kind: 'page' | 'annot' | 'xobj' }>;
	/** Annotation ref → [page index, position in /Annots]. */
	annotAt: Map<string, [number, number]>;
	/** XObjects reachable from each page's resources (ref → first page index). */
	xobjPage: Map<string, number>;
	problems: Problem[];
}

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
const isStream = (objects: Objects, ref: string) => objects[objKey(ref)]?.stream !== undefined;

function isAnnotDict(d: Dict): boolean {
	return d['/Type'] === '/Annot' || (d['/Subtype'] !== undefined && d['/Rect'] !== undefined && d['/S'] === undefined);
}

/** Effective /Resources of a page (inherited through /Parent). */
function pageResources(objects: Objects, page: Dict): Dict | null {
	let d: Dict | null = page;
	for (let depth = 0; d && depth < 64; depth++) {
		if (d['/Resources'] !== undefined) return dictAt(objects, d['/Resources']);
		d = dictAt(objects, d['/Parent']);
	}
	return null;
}

/** Number tree → map (first value wins on repeated keys). */
function numberTree(objects: Objects, node: Json, out: Map<number, Json>, seen: Set<string>, depth = 0): boolean {
	if (isRef(node)) {
		if (seen.has(node)) return false;
		seen.add(node);
	}
	const d = dictAt(objects, node);
	if (!d || depth > 64) return false;
	const nums = arrAt(objects, d['/Nums']);
	if (nums) {
		for (let k = 0; k + 1 < nums.length; k += 2) {
			const key = nums[k];
			if (typeof key === 'number' && Number.isInteger(key) && !out.has(key)) out.set(key, nums[k + 1]);
		}
	}
	const kids = arrAt(objects, d['/Kids']);
	if (kids) for (const kid of kids) if (!numberTree(objects, kid, out, seen, depth + 1)) return false;
	return true;
}

function nameTree(objects: Objects, node: Json, out: [Json, Json][], seen: Set<string>, depth = 0): boolean {
	if (isRef(node)) {
		if (seen.has(node)) return false;
		seen.add(node);
	}
	const d = dictAt(objects, node);
	if (!d || depth > 64) return false;
	const names = arrAt(objects, d['/Names']);
	if (names) for (let k = 0; k + 1 < names.length; k += 2) out.push([names[k], names[k + 1]]);
	const kids = arrAt(objects, d['/Kids']);
	if (kids) for (const kid of kids) if (!nameTree(objects, kid, out, seen, depth + 1)) return false;
	return true;
}

/** The structure tree of a dumped file, or null when the file has none. */
function readModel(dump: Dump): TagModel | null {
	const { objects } = dump;
	const trailer = objects.trailer?.value;
	const catalogRef = isDict(trailer) ? trailer['/Root'] : null;
	if (!isRef(catalogRef)) return null;
	const catalog = dictAt(objects, catalogRef);
	if (!catalog || catalog['/StructTreeRoot'] === undefined) return null;
	const problems: Problem[] = [];
	const rootVal = catalog['/StructTreeRoot'];
	const root = dictAt(objects, rootVal);
	const pageIndex = new Map(dump.pages.map((p, i) => [p, i]));
	const model: TagModel = {
		objects,
		header: dump.header,
		catalogRef,
		catalog,
		rootRef: isRef(rootVal) ? rootVal : '',
		root: root ?? {},
		pages: dump.pages,
		pageIndex,
		contents: dump.contents,
		elems: [],
		elemOf: new Map(),
		pt: new Map(),
		ids: [],
		owners: new Map(),
		annotAt: new Map(),
		xobjPage: new Map(),
		problems
	};
	if (!root || !isRef(rootVal)) {
		problems.push({ kind: 'unreadable', detail: 'StructTreeRoot is not an indirect dictionary' });
		return model;
	}

	// Elements, in document (preorder) order.
	const stack: { v: Json; parent: number; page: string | null }[] = [];
	const top = root['/K'];
	const pushKids = (k: Json, parent: number, page: string | null) => {
		const list = Array.isArray(k) ? k : k === undefined || k === null ? [] : [k];
		for (let j = list.length - 1; j >= 0; j--) stack.push({ v: list[j], parent, page });
	};
	pushKids(arrAt(objects, top) ?? top, -1, null);
	while (stack.length) {
		const { v, parent, page } = stack.pop()!;
		const at = (kid: Kid) => {
			if (parent < 0) problems.push({ kind: 'bad-kid', detail: 'content directly under the root' });
			else model.elems[parent].kids.push(kid);
		};
		if (typeof v === 'number') {
			if (Number.isInteger(v) && v >= 0) at({ k: 'm', mcid: v, page, stm: null, raw: v });
			else problems.push({ kind: 'bad-kid', detail: `MCID ${v}` });
			continue;
		}
		const d = dictAt(objects, v);
		if (!d) {
			if (v !== null) problems.push({ kind: 'bad-kid', detail: 'kid is not a dictionary' });
			continue;
		}
		const type = d['/Type'];
		if (type === '/MCR' || (d['/S'] === undefined && typeof d['/MCID'] === 'number')) {
			const mcid = d['/MCID'];
			const pg = isRef(d['/Pg']) ? d['/Pg'] : page;
			const stm = isRef(d['/Stm']) ? d['/Stm'] : null;
			if (typeof mcid === 'number' && Number.isInteger(mcid) && mcid >= 0) at({ k: 'm', mcid, page: pg, stm, raw: v });
			else problems.push({ kind: 'bad-kid', detail: 'MCR without an MCID' });
			continue;
		}
		if (type === '/OBJR' || (d['/S'] === undefined && d['/Obj'] !== undefined)) {
			const obj = d['/Obj'];
			if (isRef(obj)) at({ k: 'o', obj, page: isRef(d['/Pg']) ? d['/Pg'] : page, raw: v });
			else problems.push({ kind: 'bad-kid', detail: 'OBJR without an object' });
			continue;
		}
		if (d['/S'] === undefined || !isRef(v)) {
			problems.push({ kind: 'bad-kid', detail: d['/S'] === undefined ? 'element without /S' : 'element is not an indirect object' });
			continue;
		}
		if (model.elemOf.has(v)) {
			problems.push({ kind: 'shared-element', detail: `${v} is reached twice` });
			continue;
		}
		const index = model.elems.length;
		const pg = isRef(d['/Pg']) ? d['/Pg'] : page;
		if (isRef(d['/Pg']) && !pageIndex.has(d['/Pg'])) problems.push({ kind: 'unknown-page', detail: `${v} /Pg is not a page` });
		const kv = d['/K'];
		const k = arrAt(objects, kv) ?? kv;
		model.elems.push({ ref: v, dict: d, parent, kids: [], kArray: Array.isArray(k) });
		if (model.elems.length > MAX_ELEMENTS) {
			problems.push({ kind: 'too-many', detail: `more than ${MAX_ELEMENTS} elements` });
			return model;
		}
		model.elemOf.set(v, index);
		if (parent >= 0) model.elems[parent].kids.push({ k: 'e', i: index });
		pushKids(k, index, pg);
	}

	if (!numberTree(objects, root['/ParentTree'], model.pt, new Set()) && root['/ParentTree'] !== undefined) {
		problems.push({ kind: 'unreadable', detail: 'ParentTree' });
	}
	if (root['/IDTree'] !== undefined && !nameTree(objects, root['/IDTree'], model.ids, new Set())) problems.push({ kind: 'unreadable', detail: 'IDTree' });

	// Owners of ParentTree keys: pages, their annotations, XObjects their resources reach.
	const own = (key: Json, ref: string, kind: 'page' | 'annot' | 'xobj', page: number) => {
		if (typeof key !== 'number' || !Number.isInteger(key)) return;
		const prev = model.owners.get(key);
		if (prev && prev.ref !== ref) problems.push({ kind: 'key-shared', page, detail: `key ${key}` });
		else model.owners.set(key, { ref, kind });
	};
	const needXobjects = Object.values(objects).some((o) => {
		const d = o.stream?.dict;
		return isDict(d) && (d['/StructParents'] !== undefined || d['/StructParent'] !== undefined);
	});
	dump.pages.forEach((p, i) => {
		const pd = dictAt(objects, p);
		if (!pd) return;
		own(pd['/StructParents'], p, 'page', i);
		const annots = arrAt(objects, pd['/Annots']) ?? [];
		annots.forEach((a, j) => {
			if (!isRef(a)) return;
			if (!model.annotAt.has(a)) model.annotAt.set(a, [i, j]);
			const ad = dictAt(objects, a);
			if (ad) own(ad['/StructParent'], a, 'annot', i);
		});
		if (needXobjects) {
			const walk = (res: Dict | null, depth: number) => {
				const xo = res ? dictAt(objects, res['/XObject']) : null;
				if (!xo || depth > 12) return;
				for (const x of Object.values(xo)) {
					if (!isRef(x) || model.xobjPage.has(x)) continue;
					model.xobjPage.set(x, i);
					const xd = dictAt(objects, x);
					if (!xd) continue;
					own(xd['/StructParents'], x, 'xobj', i);
					own(xd['/StructParent'], x, 'xobj', i);
					if (xd['/Subtype'] === '/Form') walk(dictAt(objects, xd['/Resources']), depth + 1);
				}
			};
			walk(pageResources(objects, pd), 0);
		}
	});
	return model;
}

/** MCIDs used in each page's content (and in each form XObject the tree points into). */
interface ContentMcids {
	pages: (Set<number> | null)[];
	xobjects: Map<string, Set<number> | null>;
}

async function contentMcids(qpdf: Qpdf, bytes: Uint8Array, model: TagModel, password?: string): Promise<ContentMcids | null> {
	const pagesWithTags = new Set<number>();
	const stms = new Set<string>();
	for (const e of model.elems) {
		for (const kid of e.kids) {
			if (kid.k !== 'm') continue;
			if (kid.stm) stms.add(kid.stm);
			else if (kid.page && model.pageIndex.has(kid.page)) pagesWithTags.add(model.pageIndex.get(kid.page)!);
		}
	}
	const refs: string[] = [...stms];
	for (const i of pagesWithTags) refs.push(...model.contents[i]);
	const data = await streamData(qpdf, bytes, refs, password);
	if (!data) return null;
	const pages: (Set<number> | null)[] = model.pages.map(() => new Set<number>());
	const scan = (parts: (Uint8Array | null)[], resources: Dict | null): Set<number> | null => {
		if (parts.some((p) => p === null)) return null;
		const total = parts.reduce((n, p) => n + p!.length + 1, 0);
		const joined = new Uint8Array(total);
		let off = 0;
		for (const p of parts) {
			joined.set(p!, off);
			off += p!.length;
			joined[off++] = 10;
		}
		const mc = markedContent(joined);
		const set = new Set(mc.mcids);
		if (mc.named.length) {
			const props = resources ? dictAt(model.objects, resources['/Properties']) : null;
			for (const name of mc.named) {
				const pd = props ? dictAt(model.objects, props[`/${name}`]) : null;
				const m = pd?.['/MCID'];
				if (typeof m === 'number' && Number.isInteger(m)) set.add(m);
			}
		}
		return set;
	};
	for (const i of pagesWithTags) {
		const pd = dictAt(model.objects, model.pages[i]);
		pages[i] = scan(model.contents[i].map((r) => data.get(r) ?? null), pd ? pageResources(model.objects, pd) : null);
	}
	const xobjects = new Map<string, Set<number> | null>();
	for (const x of stms) {
		const xd = dictAt(model.objects, x);
		xobjects.set(x, scan([data.get(x) ?? null], xd ? dictAt(model.objects, xd['/Resources']) : null));
	}
	return { pages, xobjects };
}

/** Consistency of a tree with its ParentTree and content (problems appended to model.problems). */
function checkModel(model: TagModel, content: ContentMcids | null): void {
	const { objects, problems } = model;
	const pageOf = (ref: string | null) => (ref !== null ? model.pageIndex.get(ref) : undefined);
	/** Expected ParentTree entries: key → MCID → element ref (pages, XObjects); key → element (objects). */
	const claims = new Map<number, Map<number, string>>();
	const objClaims = new Map<number, string>();
	const keyOf = (ref: string, which: '/StructParents' | '/StructParent') => {
		const d = dictAt(objects, ref);
		const k = d?.[which];
		return typeof k === 'number' && Number.isInteger(k) ? k : null;
	};
	for (const e of model.elems) {
		for (const kid of e.kids) {
			if (kid.k === 'e') continue;
			if (kid.k === 'm') {
				let owner: string;
				let page: number | undefined;
				if (kid.stm) {
					owner = kid.stm;
					page = model.xobjPage.get(kid.stm) ?? pageOf(kid.page);
					if (!isStream(objects, kid.stm)) {
						problems.push({ kind: 'bad-kid', page, detail: 'MCR /Stm is not a stream' });
						continue;
					}
				} else {
					if (kid.page === null) {
						problems.push({ kind: 'unplaced', detail: `${e.ref} MCID ${kid.mcid} has no page` });
						continue;
					}
					page = pageOf(kid.page);
					if (page === undefined) {
						problems.push({ kind: 'unknown-page', detail: `${e.ref} MCID ${kid.mcid}` });
						continue;
					}
					owner = kid.page;
				}
				const key = keyOf(owner, '/StructParents');
				if (key === null) {
					problems.push({ kind: 'pt-missing', page, detail: `${owner} has no /StructParents` });
					continue;
				}
				let m = claims.get(key);
				if (!m) claims.set(key, (m = new Map()));
				if (m.has(kid.mcid)) {
					problems.push({ kind: 'mcid-shared', page, detail: `MCID ${kid.mcid}` });
					continue;
				}
				m.set(kid.mcid, e.ref);
				const found = kid.stm ? content?.xobjects.get(kid.stm) : page !== undefined ? content?.pages[page] : undefined;
				if (content && found === null) problems.push({ kind: 'content-unreadable', page });
				else if (content && found && !found.has(kid.mcid)) problems.push({ kind: 'mcid-missing', page, detail: `MCID ${kid.mcid}` });
			} else {
				const target = dictAt(objects, kid.obj);
				if (!target) {
					problems.push({ kind: 'objr-missing', detail: `${kid.obj} does not exist` });
					continue;
				}
				const isX = isStream(objects, kid.obj);
				const page = isX ? model.xobjPage.get(kid.obj) : model.annotAt.get(kid.obj)?.[0];
				if (page === undefined) {
					problems.push({ kind: 'objr-missing', detail: `${kid.obj} is not on a page` });
					continue;
				}
				const key = keyOf(kid.obj, '/StructParent');
				if (key === null) {
					problems.push({ kind: 'pt-missing', page, detail: `${kid.obj} has no /StructParent` });
					continue;
				}
				if (objClaims.has(key)) {
					problems.push({ kind: 'mcid-shared', page, detail: `object key ${key}` });
					continue;
				}
				objClaims.set(key, e.ref);
			}
		}
	}
	// Each claim against the ParentTree, and the ParentTree against the claims.
	for (const [key, owner] of model.owners) {
		const entry = model.pt.get(key);
		const page = owner.kind === 'page' ? model.pageIndex.get(owner.ref) : owner.kind === 'annot' ? model.annotAt.get(owner.ref)?.[0] : model.xobjPage.get(owner.ref);
		if (owner.kind === 'annot' || (owner.kind === 'xobj' && keyOf(owner.ref, '/StructParent') === key)) {
			const want = objClaims.get(key);
			if (want === undefined) {
				if (isRef(entry) && model.elemOf.has(entry)) problems.push({ kind: 'pt-extra', page, detail: `key ${key}` });
				continue;
			}
			if (entry !== want) problems.push({ kind: 'pt-mismatch', page, detail: `key ${key}` });
			continue;
		}
		const want = claims.get(key) ?? new Map<number, string>();
		const arr = arrAt(objects, entry);
		if (!arr) {
			if (want.size) problems.push({ kind: 'pt-missing', page, detail: `key ${key}` });
			continue;
		}
		for (const [mcid, ref] of want) if (arr[mcid] !== ref) problems.push({ kind: 'pt-mismatch', page, detail: `key ${key} MCID ${mcid}` });
		arr.forEach((v, mcid) => {
			if (isRef(v) && model.elemOf.has(v) && !want.has(mcid)) problems.push({ kind: 'pt-extra', page, detail: `key ${key} MCID ${mcid}` });
		});
	}
	for (const key of [...claims.keys(), ...objClaims.keys()]) {
		if (!model.owners.has(key)) problems.push({ kind: 'pt-missing', detail: `key ${key} has no owner` });
	}
}

// ------------------------------------------------------------------------------ planning

/** Facts about one source, read once per source (cached by its bytes). */
export interface SourceTags {
	model: TagModel;
	/** Problems that keep this source's tags out of every export. */
	fatal: Problem[];
	/** The tree holds streams this code does not carry (embedded files, lexicons). */
	streams: boolean;
	/** The source has a form (AcroForm in the catalog). */
	form: boolean;
	ms: number;
}

const cache = new WeakMap<Uint8Array, Promise<SourceTags | null>>();

/** The tags of a source (null: not tagged). The result is cached by `source.bytes`. */
export function sourceTags(qpdf: Qpdf, source: Source): Promise<SourceTags | null> {
	let p = cache.get(source.bytes);
	if (!p) {
		p = readSourceTags(qpdf, source.bytes).catch(() => null);
		cache.set(source.bytes, p);
	}
	return p;
}

/** Problem kinds that make a source's tags unusable. */
export const FATAL: ReadonlySet<Problem['kind']> = new Set([
	'unreadable',
	'shared-element',
	'bad-kid',
	'unknown-page',
	'unplaced',
	'pt-missing',
	'pt-mismatch',
	'pt-extra',
	'mcid-shared',
	'mcid-missing',
	'objr-missing',
	'key-shared',
	'content-unreadable',
	'too-many'
]);

/** What the catalog says (two cheap `--show-object` runs), cached by the source's bytes. */
interface CatalogFacts {
	tagged: boolean;
	form: boolean;
	/** The trailer's /Size: how many objects the file has, at most. */
	size: number;
}
const factsCache = new WeakMap<Uint8Array, Promise<CatalogFacts>>();
function catalogFacts(qpdf: Qpdf, bytes: Uint8Array): Promise<CatalogFacts> {
	let p = factsCache.get(bytes);
	if (!p) {
		p = (async () => {
			const cat = await catalogText(qpdf, bytes);
			const t = await qpdf.run({ args: ['--show-object=trailer', '/f.pdf'], inputs: { '/f.pdf': bytes } });
			const size = Number(/\/Size (\d+)/.exec(t.stdout)?.[1] ?? 0);
			return { tagged: catalogHas(cat, 'StructTreeRoot'), form: catalogHas(cat, 'AcroForm'), size };
		})().catch(() => ({ tagged: false, form: false, size: 0 }));
		factsCache.set(bytes, p);
	}
	return p;
}

async function readSourceTags(qpdf: Qpdf, bytes: Uint8Array): Promise<SourceTags | null> {
	const t0 = now();
	const facts = await catalogFacts(qpdf, bytes);
	if (!facts.tagged) return null;
	if (facts.size > MAX_OBJECTS) {
		// Reading every object of a file this large would take too much memory on a phone.
		const problem: Problem = { kind: 'too-many', detail: `${facts.size} objects` };
		return { model: emptyModel([problem]), fatal: [problem], streams: false, form: facts.form, ms: Math.round(now() - t0) };
	}
	const dump = await dumpAll(qpdf, bytes);
	if (!dump) return null;
	const model = readModel(dump);
	if (!model) return null;
	if (!model.problems.some((p) => FATAL.has(p.kind))) {
		const content = await contentMcids(qpdf, bytes, model);
		if (!content) model.problems.push({ kind: 'content-unreadable' });
		checkModel(model, content);
	}
	return {
		model,
		fatal: model.problems.filter((p) => FATAL.has(p.kind)),
		streams: treeStreams(model),
		form: facts.form,
		ms: Math.round(now() - t0)
	};
}

function emptyModel(problems: Problem[]): TagModel {
	return { objects: {}, header: {}, catalogRef: '', catalog: {}, rootRef: '', root: {}, pages: [], pageIndex: new Map(), contents: [], elems: [], elemOf: new Map(), pt: new Map(), ids: [], owners: new Map(), annotAt: new Map(), xobjPage: new Map(), problems };
}

/** Whether anything reachable from the tree (other than through /Pg, /Obj, /Stm) is a stream. */
function treeStreams(model: TagModel): boolean {
	const { objects } = model;
	const seen = new Set<string>();
	let found = false;
	const walk = (v: Json, depth: number): void => {
		if (found || depth > 40) return;
		if (isRef(v)) {
			if (seen.has(v) || model.elemOf.has(v)) return;
			seen.add(v);
			const o = objects[objKey(v)];
			if (!o) return;
			if (o.stream) {
				found = true;
				return;
			}
			const d = o.value;
			if (isDict(d) && (d['/Type'] === '/Page' || isAnnotDict(d))) return;
			walk(d, depth + 1);
			return;
		}
		if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
		else if (isDict(v)) for (const [k, x] of Object.entries(v)) if (k !== '/P' && k !== '/K' && k !== '/Pg' && k !== '/Obj' && k !== '/Stm' && k !== '/Ref') walk(x, depth + 1);
	};
	for (const e of model.elems) walk(e.dict, 0);
	for (const [k, v] of Object.entries(model.root)) if (k !== '/K' && k !== '/ParentTree' && k !== '/IDTree') walk(v, 0);
	return found;
}

export interface TagsPart {
	source: Source;
	tags: SourceTags;
}

export type TagsPlan =
	| { kind: 'none' }
	| { kind: 'drop'; reason: TagsDropReason }
	| {
			kind: 'keep';
			/** Tagged sources, in the order their first page appears. */
			parts: TagsPart[];
			/** For each output page: its part and source page index, or null (a blank page). */
			from: ({ part: number; page: number } | null)[];
			/** One source, every one of its pages in the export. */
			whole: boolean;
	  };

/**
 * Whether this export can keep its sources' tags. Cheap when no source is tagged (one
 * `--show-object` pair per source); a tagged source is read and checked once (cached).
 */
export async function planTags(
	qpdf: Qpdf,
	pages: PageRef[],
	byId: Map<string, Source>,
	used: Source[],
	opts: { redaction: boolean; flatten: boolean }
): Promise<TagsPlan> {
	// The cheap rules first: they need only the catalogs.
	const taggedSources: Source[] = [];
	let form = false;
	for (const s of used) {
		if (s.kind !== 'pdf') continue;
		const f = await catalogFacts(qpdf, s.bytes);
		if (!f.tagged) continue;
		taggedSources.push(s);
		form ||= f.form;
	}
	if (taggedSources.length === 0) return { kind: 'none' };
	if (opts.redaction) return { kind: 'drop', reason: 'redacted' };
	if (opts.flatten && form) return { kind: 'drop', reason: 'flattened' };
	const partOf = new Map(taggedSources.map((s, i) => [s, i]));
	// Pages of a file without tags would be outside the tree: screen readers that follow the
	// tags would skip them, so the whole export goes without (readers then read every page).
	if (used.some((s) => !partOf.has(s) && s.kind !== 'blank')) return { kind: 'drop', reason: 'merged' };
	const from: ({ part: number; page: number } | null)[] = [];
	const seen = taggedSources.map(() => new Set<number>());
	for (const ref of pages) {
		const part = partOf.get(byId.get(ref.sourceId)!);
		if (part === undefined) {
			from.push(null);
			continue;
		}
		if (seen[part].has(ref.pageIndex)) return { kind: 'drop', reason: 'repeated' };
		seen[part].add(ref.pageIndex);
		from.push({ part, page: ref.pageIndex });
	}
	const parts: TagsPart[] = [];
	for (const s of taggedSources) {
		const t = await sourceTags(qpdf, s);
		if (!t) return { kind: 'drop', reason: 'unsupported' };
		parts.push({ source: s, tags: t });
	}
	const fatal = parts.flatMap((p) => p.tags.fatal);
	if (fatal.length) return { kind: 'drop', reason: fatal.every((p) => p.kind === 'too-many') ? 'large' : 'damaged' };
	if (parts.length > 1 && mergeProblem(parts.map((p) => p.tags.model))) return { kind: 'drop', reason: 'merged' };
	return { kind: 'keep', parts, from, whole: parts.length === 1 && seen[0].size === parts[0].source.pages.length };
}

/** Root keys merged by their own rule (the rest must agree where several trees have them). */
const MERGED_ROOT_KEYS = new Set(['/Type', '/K', '/ParentTree', '/ParentTreeNextKey', '/IDTree', '/RoleMap', '/ClassMap', '/Namespaces']);

/** A value with every reference inlined (pages, annotations and elements as markers), for comparing trees' maps. */
function inline(model: TagModel, v: Json, depth = 0): Json {
	if (depth > 32) return '…';
	if (isRef(v)) {
		if (model.elemOf.has(v)) return 'element';
		if (model.pageIndex.has(v)) return 'page';
		const o = model.objects[objKey(v)];
		if (!o) return null;
		return o.stream ? 'stream' : inline(model, o.value, depth + 1);
	}
	if (Array.isArray(v)) return v.map((x) => inline(model, x, depth + 1));
	if (isDict(v)) {
		const out: Record<string, Json> = {};
		for (const k of Object.keys(v).sort()) out[k] = inline(model, v[k], depth + 1);
		return out;
	}
	return typeof v === 'string' ? textOf(v) : v;
}

/**
 * Why several trees cannot be put under one root, or null: a role or class mapped two
 * ways, an ID used in two files, another root key with two different values.
 */
function mergeProblem(models: TagModel[]): string | null {
	for (const key of ['/RoleMap', '/ClassMap']) {
		const seen = new Map<string, string>();
		for (const m of models) {
			const d = dictAt(m.objects, m.root[key]);
			if (!d) continue;
			for (const [k, v] of Object.entries(d)) {
				const c = JSON.stringify(inline(m, v));
				const prev = seen.get(k);
				if (prev !== undefined && prev !== c) return `${key} ${k} differs`;
				seen.set(k, c);
			}
		}
	}
	const ids = new Set<string>();
	for (const m of models) {
		for (const [k] of m.ids) {
			const t = typeof k === 'string' ? textOf(k) : String(k);
			if (ids.has(t)) return `ID ${t} is in two files`;
			ids.add(t);
		}
	}
	const other = new Map<string, string>();
	for (const m of models) {
		for (const [k, v] of Object.entries(m.root)) {
			if (MERGED_ROOT_KEYS.has(k)) continue;
			const c = JSON.stringify(inline(m, v));
			const prev = other.get(k);
			if (prev !== undefined && prev !== c) return `${k} differs`;
			other.set(k, c);
		}
	}
	return null;
}

/** The first ParentTree key after every key a tree uses. */
function nextKey(model: TagModel): number {
	let n = typeof model.root['/ParentTreeNextKey'] === 'number' ? (model.root['/ParentTreeNextKey'] as number) : 0;
	for (const k of model.pt.keys()) n = Math.max(n, k + 1);
	for (const k of model.owners.keys()) n = Math.max(n, k + 1);
	return n;
}

// ------------------------------------------------------------------------------ pruning

interface Keep {
	/** Elements kept, by source element index. */
	kept: boolean[];
	/** Elements whose content lies partly on removed pages (text keys dropped). */
	partial: boolean[];
	/** Kid kept (by element index, kid index). */
	kidKept: (e: number, k: number) => boolean;
}

/**
 * Which elements and kids survive, given which source objects are in the export
 * (`has`: a page, annotation or XObject of the source that has a copy in the output).
 */
function prune(model: TagModel, has: (ref: string) => boolean): Keep {
	const n = model.elems.length;
	const own = new Uint8Array(n); // bit 1: has content, bit 2: has kept content, bit 4: has dropped content
	const kidOk = model.elems.map((e) =>
		e.kids.map((kid) => {
			if (kid.k === 'e') return true;
			if (kid.k === 'm') return kid.stm ? has(kid.stm) && (kid.page === null || has(kid.page) || !model.pageIndex.has(kid.page)) : kid.page !== null && has(kid.page);
			return has(kid.obj);
		})
	);
	for (let i = n - 1; i >= 0; i--) {
		const e = model.elems[i];
		let f = 0;
		e.kids.forEach((kid, k) => {
			if (kid.k === 'e') f |= own[kid.i];
			else f |= 1 | (kidOk[i][k] ? 2 : 4);
		});
		own[i] = f;
	}
	const kept = new Array<boolean>(n).fill(false);
	const partial = new Array<boolean>(n).fill(false);
	for (let i = 0; i < n; i++) {
		const e = model.elems[i];
		const parentKept = e.parent < 0 || kept[e.parent];
		const f = own[i];
		kept[i] = parentKept && (f & 1 ? (f & 2) !== 0 : true);
		partial[i] = kept[i] && (f & 6) === 6;
	}
	return { kept, partial, kidKept: (e, k) => (model.elems[e].kids[k].k === 'e' ? kept[(model.elems[e].kids[k] as { i: number }).i] : kidOk[e][k]) };
}

// ------------------------------------------------------------------------------ graft

export interface GraftResult {
	bytes: Uint8Array;
	/** What the export's tree must look like (verifyTags). */
	expected: Expected;
	ms: number;
}

export interface Expected {
	canon: string[];
	elements: number;
	alt: number;
	actualText: number;
	/** Source problems of kinds tolerated in an export, mapped to output pages (none today: every kind is fatal). */
	tolerated: string[];
}

class GraftError extends Error {}

/** One source's share of the graft. */
interface PartGraft {
	model: TagModel;
	/** Source object → its copy in the output. */
	map: Map<string, string>;
	keep: Keep;
	newElem: (string | null)[];
	/** Added to every ParentTree key of this source. */
	off: number;
	/** /Lang put on this source's top-level elements (its catalog's, when it differs from the export's). */
	lang: Json;
	/** Output page number of each source page in the export. */
	pageOut: Map<number, number>;
	T: (v: Json, depth: number) => Json;
}

/**
 * Copies the sources' trees into `assembled` (pages already in place), under one root when
 * there are several. Null when the copy cannot be made exactly (the caller exports without tags).
 */
export async function graftTags(qpdf: Qpdf, assembled: Uint8Array, plan: Extract<TagsPlan, { kind: 'keep' }>, note: (s: string) => void = () => {}): Promise<GraftResult | null> {
	const t0 = now();
	const out = await dumpAll(qpdf, assembled);
	if (!out || out.pages.length !== plan.from.length) {
		note('tags: the assembled file could not be read');
		return null;
	}
	const oo = out.objects;
	let next = (typeof out.header.maxobjectid === 'number' ? out.header.maxobjectid : Math.max(...Object.keys(oo).map((k) => Number(/obj:(\d+)/.exec(k)?.[1] ?? 0)))) + 1;
	const fresh = () => `${next++} 0 R`;
	const updates: Record<string, Obj> = {};
	const streams: { part: number; src: string; dst: string; dict: Dict }[] = [];
	const lang0 = plan.parts[0].tags.model.catalog['/Lang'];
	const graft: PartGraft[] = [];
	let off = 0;

	try {
		for (const [pi, part] of plan.parts.entries()) {
			const src = part.tags.model;
			const so = src.objects;
			const map = new Map<string, string>();
			const pageOut = new Map<number, number>();
			const conflict = (a: string, b: string) => {
				const prev = map.get(a);
				if (prev !== undefined && prev !== b) throw new GraftError(`${a} has two copies`);
				map.set(a, b);
			};
			plan.from.forEach((f, i) => {
				if (!f || f.part !== pi) return;
				pageOut.set(f.page, i);
				const sref = src.pages[f.page];
				const oref = out.pages[i];
				conflict(sref, oref);
				const sd = dictAt(so, sref);
				const od = dictAt(oo, oref);
				if (!sd || !od) throw new GraftError(`page ${i + 1} unreadable`);
				const sa = arrAt(so, sd['/Annots']) ?? [];
				const oa = arrAt(oo, od['/Annots']) ?? [];
				if (sa.length !== oa.length) throw new GraftError(`page ${i + 1}: ${sa.length} annotations became ${oa.length}`);
				sa.forEach((a, j) => {
					if (isRef(a) && isRef(oa[j])) conflict(a, oa[j] as string);
				});
				if (src.xobjPage.size) {
					const walk = (sr: Dict | null, or: Dict | null, depth: number) => {
						const sx = sr ? dictAt(so, sr['/XObject']) : null;
						const ox = or ? dictAt(oo, or['/XObject']) : null;
						if (!sx || !ox || depth > 12) return;
						for (const [name, x] of Object.entries(sx)) {
							const y = ox[name];
							if (!isRef(x) || !isRef(y)) continue;
							if (map.has(x)) {
								if (map.get(x) !== y) throw new GraftError(`${x} has two copies`);
								continue;
							}
							map.set(x, y);
							const xd = dictAt(so, x);
							const yd = dictAt(oo, y);
							if (xd?.['/Subtype'] === '/Form') walk(dictAt(so, xd['/Resources']), yd ? dictAt(oo, yd['/Resources']) : null, depth + 1);
						}
					};
					walk(pageResources(so, sd), pageResources(oo, od), 0);
				}
			});
			const has = (ref: string) => map.has(ref);
			const keep = prune(src, has);
			// A kid on a page in the export must have its copy: otherwise the tree would lose content silently.
			for (let i = 0; i < src.elems.length; i++) {
				if (!keep.kept[i]) continue;
				for (const kid of src.elems[i].kids) {
					const obj = kid.k === 'o' ? kid.obj : kid.k === 'm' ? kid.stm : null;
					if (!obj || has(obj)) continue;
					const at = kid.k === 'm' || isStream(so, obj) ? src.xobjPage.get(obj) : src.annotAt.get(obj)?.[0];
					if (at !== undefined && has(src.pages[at])) throw new GraftError(`${obj} on a kept page has no copy`);
				}
			}
			const newElem = src.elems.map((_e, i) => (keep.kept[i] ? fresh() : null));
			const copied = new Map<string, string>();
			let budget = 4 * src.elems.length + 20_000;
			const T = (v: Json, depth: number): Json => {
				if (depth > 64) throw new GraftError('too deep');
				if (isRef(v)) {
					const ei = src.elemOf.get(v);
					if (ei !== undefined) return newElem[ei] ?? null;
					const m = map.get(v);
					if (m !== undefined) return m;
					const o = so[objKey(v)];
					if (!o) return null;
					if (o.stream) {
						const d = o.stream.dict;
						if (isDict(d) && (d['/Subtype'] === '/Form' || d['/Subtype'] === '/Image')) return null;
						// Another stream (an embedded file of an /AF entry, a pronunciation lexicon): copied
						// with its data as it is stored (filters and all).
						const done = copied.get(v);
						if (done) return done;
						if (--budget < 0) throw new GraftError('too many objects');
						const nr = fresh();
						copied.set(v, nr);
						const { ['/Length']: _len, ...rest } = isDict(d) ? d : {};
						streams.push({ part: pi, src: v, dst: nr, dict: T(rest, depth + 1) as Dict });
						return nr;
					}
					const d = o.value;
					if (isDict(d) && (d['/Type'] === '/Page' || d['/Type'] === '/Pages' || d['/Type'] === '/Catalog' || isAnnotDict(d))) return null;
					const done = copied.get(v);
					if (done) return done;
					if (--budget < 0) throw new GraftError('too many objects');
					const nr = fresh();
					copied.set(v, nr);
					updates[objKey(nr)] = { value: T(d, depth + 1) };
					return nr;
				}
				if (Array.isArray(v)) return v.map((x) => (x === EMPTY_NAME ? null : T(x, depth + 1)));
				if (isDict(v)) {
					const d: Dict = {};
					for (const [k, x] of Object.entries(v)) if (x !== EMPTY_NAME) d[k] = T(x, depth + 1);
					return d;
				}
				return v;
			};
			// The catalog /Lang may be an indirect string: compared and copied by value.
			const langP = val(so, src.catalog['/Lang']);
			const lang0v = val(plan.parts[0].tags.model.objects, lang0);
			const lang = pi > 0 && typeof langP === 'string' && textOf(langP) !== (typeof lang0v === 'string' ? textOf(lang0v) : '') ? langP : undefined;
			graft.push({ model: src, map, keep, newElem, off, lang, pageOut, T });
			off += nextKey(src);
		}

		// Elements.
		for (const g of graft) {
			const { model: src, keep, newElem, map, T } = g;
			const so = src.objects;
			const stripSummary = (a: Json): Json => {
				const one = (x: Json): Json => {
					const d = dictAt(so, x);
					if (!d || d['/Summary'] === undefined) return T(x, 1);
					const { ['/Summary']: _s, ...rest } = d;
					return T(rest, 1);
				};
				const arr = arrAt(so, a);
				return arr ? arr.map((x) => (typeof x === 'number' ? x : one(x))) : one(a);
			};
			for (let i = 0; i < src.elems.length; i++) {
				const nr = newElem[i];
				if (!nr) continue;
				const e = src.elems[i];
				const d: Dict = {};
				const parent = e.parent < 0 ? null : newElem[e.parent];
				for (const [k, v] of Object.entries(e.dict)) {
					if (k === '/K' || k === '/P') continue;
					if (keep.partial[i] && PRUNED_TEXT.includes(k)) continue;
					if (k === '/Pg') {
						const m = isRef(v) ? map.get(v) : undefined;
						if (m) d[k] = m;
						continue;
					}
					if (k === '/Ref') {
						const list = (arrAt(so, v) ?? [v]).map((x) => (isRef(x) && src.elemOf.has(x) ? newElem[src.elemOf.get(x)!] : null)).filter((x) => x !== null);
						if (list.length) d[k] = list;
						continue;
					}
					if (k === '/A' && keep.partial[i]) {
						d[k] = stripSummary(v);
						continue;
					}
					if (v !== EMPTY_NAME) d[k] = T(v, 1);
				}
				if (e.parent < 0 && g.lang !== undefined && d['/Lang'] === undefined) d['/Lang'] = g.lang;
				d['/P'] = parent ?? 'ROOT';
				const kids: Json[] = [];
				e.kids.forEach((kid, k) => {
					if (!keep.kidKept(i, k)) return;
					if (kid.k === 'e') kids.push(newElem[kid.i]);
					else if (kid.k === 'm' && typeof kid.raw === 'number') kids.push(kid.raw);
					else {
						const md = dictAt(so, kid.raw)!;
						const nd: Dict = {};
						for (const [mk, mv] of Object.entries(md)) {
							if (mk === '/Pg' || mk === '/Stm' || mk === '/Obj') {
								const m = isRef(mv) ? map.get(mv) : undefined;
								if (m) nd[mk] = m;
							} else nd[mk] = T(mv, 2);
						}
						kids.push(nd);
					}
				});
				if (kids.length === 1 && !e.kArray) d['/K'] = kids[0];
				else if (kids.length || e.dict['/K'] !== undefined) d['/K'] = kids;
				updates[objKey(nr)] = { value: d };
			}
			// Every ParentTree key of a later source moves up by its offset, on its pages,
			// annotations and XObjects (copies in the output, so nothing else shares them).
			if (g.off > 0) {
				for (const [, owner] of src.owners) {
					const o = g.map.get(owner.ref);
					if (!o || updates[objKey(o)]) continue;
					const ob = oo[objKey(o)];
					const bump = (d: Dict) => {
						const nd = { ...d };
						for (const k of ['/StructParents', '/StructParent']) if (typeof nd[k] === 'number') nd[k] = (nd[k] as number) + g.off;
						return nd;
					};
					if (ob?.stream && isDict(ob.stream.dict)) updates[objKey(o)] = { stream: { dict: bump(ob.stream.dict) } };
					else if (ob && isDict(ob.value)) updates[objKey(o)] = { value: bump(ob.value) };
				}
			}
		}

		// The root, its ParentTree and IDTree.
		const rootRef = fresh();
		for (const u of Object.values(updates)) if (isDict(u.value) && u.value['/P'] === 'ROOT') u.value['/P'] = rootRef;
		const one = graft.length === 1;
		const root: Dict = {};
		for (const g of graft) {
			for (const [k, v] of Object.entries(g.model.root)) {
				if (k === '/K' || k === '/ParentTree' || k === '/IDTree' || k === '/Type') continue;
				if (one) root[k] = g.T(v, 1);
				else if (k === '/RoleMap' || k === '/ClassMap') root[k] = { ...((isDict(root[k]) ? root[k] : {}) as Dict), ...(g.T(dictAt(g.model.objects, v) ?? {}, 1) as Dict) };
				else if (k === '/Namespaces') root[k] = [...((Array.isArray(root[k]) ? root[k] : []) as Json[]), ...(g.T(arrAt(g.model.objects, v) ?? [], 1) as Json[])];
				else if (k !== '/ParentTreeNextKey' && root[k] === undefined) root[k] = g.T(v, 1);
			}
		}
		if (!one) root['/ParentTreeNextKey'] = off;
		root['/Type'] = '/StructTreeRoot';
		const topKids = graft.flatMap((g) => g.model.elems.flatMap((e, i) => (e.parent < 0 && g.newElem[i] ? [g.newElem[i]] : [])));
		root['/K'] = one && topKids.length === 1 && !Array.isArray(val(graft[0].model.objects, graft[0].model.root['/K'])) ? topKids[0] : topKids;
		if (graft.some((g) => g.model.root['/ParentTree'] !== undefined)) {
			const nums: Json[] = [];
			for (const g of graft) {
				const so = g.model.objects;
				for (const key of [...g.model.pt.keys()].sort((a, b) => a - b)) {
					const owner = g.model.owners.get(key);
					if (!owner || !g.map.has(owner.ref)) continue;
					const entry = g.model.pt.get(key);
					const arr = arrAt(so, entry);
					const elem = (x: Json) => (isRef(x) && g.model.elemOf.has(x) ? (g.newElem[g.model.elemOf.get(x)!] ?? null) : null);
					if (arr && (owner.kind === 'page' || (owner.kind === 'xobj' && dictAt(so, owner.ref)?.['/StructParents'] === key))) nums.push(key + g.off, arr.map(elem));
					else if (elem(entry)) nums.push(key + g.off, elem(entry));
				}
			}
			const ptRef = fresh();
			updates[objKey(ptRef)] = { value: { '/Nums': nums } };
			root['/ParentTree'] = ptRef;
		}
		if (graft.some((g) => g.model.root['/IDTree'] !== undefined)) {
			const names: [Json, Json][] = [];
			for (const g of graft) {
				for (const [k, v] of g.model.ids) {
					const ne = isRef(v) && g.model.elemOf.has(v) ? g.newElem[g.model.elemOf.get(v)!] : null;
					if (ne) names.push([k, ne]);
				}
			}
			if (!one) names.sort((a, b) => cmp(textOf(String(a[0])), textOf(String(b[0]))));
			const idRef = fresh();
			updates[objKey(idRef)] = { value: { '/Names': names.flat() } };
			root['/IDTree'] = idRef;
		}
		updates[objKey(rootRef)] = { value: root };

		// The catalog.
		const trailer = oo.trailer?.value;
		const catRef = isDict(trailer) ? trailer['/Root'] : null;
		const cat = isRef(catRef) ? dictAt(oo, catRef) : null;
		if (!isRef(catRef) || !cat) throw new GraftError('the assembled catalog is unreadable');
		const nc: Dict = { ...cat, '/StructTreeRoot': rootRef };
		const mark = graft.find((g) => g.model.catalog['/MarkInfo'] !== undefined);
		if (mark) nc['/MarkInfo'] = mark.T(mark.model.catalog['/MarkInfo'], 1);
		for (const k of ['/Lang', '/ViewerPreferences']) if (graft[0].model.catalog[k] !== undefined) nc[k] = graft[0].T(graft[0].model.catalog[k], 1);
		updates[objKey(catRef)] = { value: nc };
	} catch (e) {
		note(`tags: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}

	let total = 0;
	for (const [pi, part] of plan.parts.entries()) {
		const mine = streams.filter((x) => x.part === pi);
		if (!mine.length) continue;
		const data = await rawStreams(qpdf, part.source.bytes, mine.map((x) => x.src));
		for (const x of mine) {
			const d = data?.get(x.src);
			if (d === undefined) {
				note('tags: a stream in the tree could not be read');
				return null;
			}
			total += d.length;
			updates[objKey(x.dst)] = { stream: { dict: x.dict, data: d } };
		}
	}
	if (total > MAX_STREAM_CHARS) {
		note('tags: the streams in the tree are too large');
		return null;
	}
	const json = new TextEncoder().encode(JSON.stringify({ qpdf: [out.header, updates] }));
	const res = await qpdf.run({
		args: ['/g.pdf', '--update-from-json=/g.json', '--object-streams=disable', '/g-out.pdf'],
		inputs: { '/g.pdf': assembled, '/g.json': json },
		outputs: ['/g-out.pdf']
	});
	const bytes = res.files.get('/g-out.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !bytes) {
		note(`tags: qpdf could not write the tree (${res.stderr.slice(0, 200)})`);
		return null;
	}
	return { bytes, expected: expectedOf(graft, off), ms: Math.round(now() - t0) };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------------------ canonical form

/**
 * Canonical form of trees, one string per element in document order: role, keys (refs
 * replaced: elements by number, pages by output page number, annotations by page and
 * position, other objects inlined), kids. `pageNo` maps the model's page index to the
 * output page number; `keep` applies a pruning (none for an export's own tree); `base` is
 * the number of the first element (elements of earlier trees under the same root).
 */
function canonCtx(model: TagModel, pageNo: (i: number) => number | undefined, keep: Keep | undefined, base: number) {
	const { objects } = model;
	const n = model.elems.length;
	const kept = keep?.kept ?? new Array<boolean>(n).fill(true);
	const number = new Map<string, number>();
	let c = base;
	for (let i = 0; i < n; i++) if (kept[i]) number.set(model.elems[i].ref, c++);
	const pageOf = (ref: string) => {
		const i = model.pageIndex.get(ref);
		return i === undefined ? undefined : pageNo(i);
	};
	const objId = (ref: string): string | null => {
		const a = model.annotAt.get(ref);
		if (a) {
			const p = pageNo(a[0]);
			return p === undefined ? null : `A${p}.${a[1]}`;
		}
		// An XObject can be drawn on several pages: named by kind only.
		if (model.xobjPage.has(ref)) return 'X';
		return null;
	};
	const cv = (v: Json, depth: number, seen: Set<string>): Json => {
		if (depth > 48) return '…';
		if (isRef(v)) {
			const e = number.get(v);
			if (e !== undefined) return `E${e}`;
			if (model.elemOf.has(v)) return null;
			const p = pageOf(v);
			if (p !== undefined) return `P${p}`;
			if (model.pageIndex.has(v)) return null;
			const o = objId(v);
			if (o) return o;
			if (seen.has(v)) return 'cycle';
			const ob = objects[objKey(v)];
			if (!ob) return null;
			if (ob.stream) {
				const sd = ob.stream.dict;
				if (!isDict(sd)) return 'stream';
				const { ['/Length']: _l, ...rest } = sd;
				return { stream: cv(rest, depth + 1, new Set([...seen, v])) };
			}
			const d = ob.value;
			if (isDict(d) && (d['/Type'] === '/Page' || d['/Type'] === '/Pages' || d['/Type'] === '/Catalog' || isAnnotDict(d))) return null;
			return cv(d, depth + 1, new Set([...seen, v]));
		}
		if (Array.isArray(v)) return v.map((x) => (x === EMPTY_NAME ? null : cv(x, depth + 1, seen)));
		if (isDict(v)) {
			const out: Record<string, Json> = {};
			for (const k of Object.keys(v).sort()) if (v[k] !== EMPTY_NAME) out[k] = cv(v[k], depth + 1, seen);
			return out;
		}
		return typeof v === 'string' ? textOf(v) : v;
	};
	const elems = (lang?: Json): string[] => {
		const lines: string[] = [];
		for (let i = 0; i < n; i++) {
			if (!kept[i]) continue;
			const e = model.elems[i];
			const keys: Record<string, Json> = {};
			const dict = e.parent < 0 && lang !== undefined && e.dict['/Lang'] === undefined ? { ...e.dict, '/Lang': lang } : e.dict;
			for (const k of Object.keys(dict).sort()) {
				if (k === '/K' || k === '/P' || k === '/Pg' || k === '/Type') continue;
				if (keep?.partial[i] && PRUNED_TEXT.includes(k)) continue;
				let v = dict[k];
				if (k === '/Ref') {
					const list = (arrAt(objects, v) ?? [v]).filter((x) => isRef(x) && number.has(x));
					if (!list.length) continue;
					v = list;
				}
				if (k === '/A' && keep?.partial[i]) {
					const strip = (x: Json): Json => {
						const d = dictAt(objects, x);
						if (!d || d['/Summary'] === undefined) return x;
						const { ['/Summary']: _s, ...rest } = d;
						return rest;
					};
					const arr = arrAt(objects, v);
					v = arr ? arr.map(strip) : strip(v);
				}
				if (v !== EMPTY_NAME) keys[k] = cv(v, 0, new Set());
			}
			const kids: string[] = [];
			e.kids.forEach((kid, k) => {
				if (keep && !keep.kidKept(i, k)) return;
				if (kid.k === 'e') kids.push(`e${number.get(model.elems[kid.i].ref)}`);
				else if (kid.k === 'm') {
					const p = kid.stm ? objId(kid.stm) : kid.page !== null ? (pageOf(kid.page) ?? null) : null;
					kids.push(`m${kid.stm ? '' : 'P'}${p}:${kid.mcid}`);
				} else kids.push(`o${objId(kid.obj)}`);
			});
			lines.push(JSON.stringify([cv(e.dict['/S'], 0, new Set()), e.parent < 0 ? -1 : number.get(model.elems[e.parent].ref), keys, kids]));
		}
		return lines;
	};
	const ids = () => model.ids.filter(([, v]) => isRef(v) && number.has(v)).map(([k, v]) => [cv(k, 0, new Set()), number.get(v as string)] as [Json, number | undefined]);
	return { cv, elems, ids, count: c - base };
}

function rootLine(rootKeys: Record<string, Json>, catKeys: Record<string, Json>, ids: [Json, number | undefined][]): string {
	const sorted: Record<string, Json> = {};
	for (const k of Object.keys(rootKeys).sort()) sorted[k] = rootKeys[k];
	return JSON.stringify(['root', sorted, catKeys, ids]);
}

/** The canonical form of a file's own tree (every element, its pages as they are). */
function canonical(model: TagModel): string[] {
	const ctx = canonCtx(model, (i) => i, undefined, 0);
	const rootKeys: Record<string, Json> = {};
	for (const k of Object.keys(model.root)) {
		if (k === '/K' || k === '/ParentTree' || k === '/IDTree' || k === '/Type') continue;
		rootKeys[k] = ctx.cv(model.root[k], 0, new Set());
	}
	const catKeys: Record<string, Json> = {};
	for (const k of ['/MarkInfo', '/Lang', '/ViewerPreferences']) if (model.catalog[k] !== undefined) catKeys[k] = ctx.cv(model.catalog[k], 0, new Set());
	return [...ctx.elems(), rootLine(rootKeys, catKeys, ctx.ids())];
}

/** What the export's tree must be: the sources' trees as pruned and merged by the graft, computed from the sources. */
function expectedOf(graft: PartGraft[], totalKeys: number): Expected {
	const lines: string[] = [];
	const rootKeys: Record<string, Json> = {};
	const ids: [Json, number | undefined][] = [];
	const one = graft.length === 1;
	let base = 0;
	const ctxs = graft.map((g) => {
		const ctx = canonCtx(g.model, (i) => g.pageOut.get(i), g.keep, base);
		base += ctx.count;
		return ctx;
	});
	graft.forEach((g, pi) => {
		const ctx = ctxs[pi];
		lines.push(...ctx.elems(g.lang));
		ids.push(...ctx.ids());
		for (const k of Object.keys(g.model.root)) {
			if (k === '/K' || k === '/ParentTree' || k === '/IDTree' || k === '/Type') continue;
			const v = ctx.cv(g.model.root[k], 0, new Set());
			if (one) rootKeys[k] = v;
			else if (k === '/RoleMap' || k === '/ClassMap') rootKeys[k] = sortKeys({ ...((rootKeys[k] as Record<string, Json>) ?? {}), ...((isDict(v) ? v : {}) as Record<string, Json>) });
			else if (k === '/Namespaces') rootKeys[k] = [...((rootKeys[k] as Json[]) ?? []), ...(Array.isArray(v) ? v : [])];
			else if (k !== '/ParentTreeNextKey' && rootKeys[k] === undefined) rootKeys[k] = v;
		}
	});
	if (!one) {
		rootKeys['/ParentTreeNextKey'] = totalKeys;
		ids.sort((a, b) => cmp(String(a[0]), String(b[0])));
	}
	const catKeys: Record<string, Json> = {};
	const mark = graft.findIndex((g) => g.model.catalog['/MarkInfo'] !== undefined);
	if (mark >= 0) catKeys['/MarkInfo'] = ctxs[mark].cv(graft[mark].model.catalog['/MarkInfo'], 0, new Set());
	for (const k of ['/Lang', '/ViewerPreferences']) if (graft[0].model.catalog[k] !== undefined) catKeys[k] = ctxs[0].cv(graft[0].model.catalog[k], 0, new Set());
	const canon = [...lines, rootLine(rootKeys, catKeys, ids)];
	return { canon, ...counts(canon), tolerated: [] };
}

function sortKeys(d: Record<string, Json>): Record<string, Json> {
	const out: Record<string, Json> = {};
	for (const k of Object.keys(d).sort()) out[k] = d[k];
	return out;
}

/**
 * A qpdf JSON string as text: "u:" strings are text already; "b:" (hex) strings are decoded
 * as a PDF text string (UTF-16BE or UTF-8 with a byte order mark, else PDFDocEncoding, read
 * as Latin-1). qpdf writes the same string as "u:" or "b:" depending on how it was stored, and
 * writing a "u:" string back can store it differently (a trailing NUL makes it "b:"), so
 * strings are compared as text. Names and refs pass through.
 */
export function textOf(v: string): string {
	if (v.startsWith('u:')) return v;
	if (!v.startsWith('b:')) return v;
	const hex = v.slice(2);
	const bytes = new Uint8Array(hex.length >> 1);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
	if (bytes[0] === 0xfe && bytes[1] === 0xff) return `u:${new TextDecoder('utf-16be').decode(bytes.subarray(2))}`;
	if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return `u:${new TextDecoder('utf-8').decode(bytes.subarray(3))}`;
	let t = '';
	for (const b of bytes) t += PDF_DOC[b] ?? String.fromCharCode(b);
	return `u:${t}`;
}

/** PDFDocEncoding where it differs from Latin-1 (PDF 32000-1 annex D.2). */
const PDF_DOC: Record<number, string> = {
	0x18: '\u02d8', 0x19: '\u02c7', 0x1a: '\u02c6', 0x1b: '\u02d9', 0x1c: '\u02dd', 0x1d: '\u02db', 0x1e: '\u02da', 0x1f: '\u02dc',
	0x80: '\u2022', 0x81: '\u2020', 0x82: '\u2021', 0x83: '\u2026', 0x84: '\u2014', 0x85: '\u2013', 0x86: '\u0192', 0x87: '\u2044',
	0x88: '\u2039', 0x89: '\u203a', 0x8a: '\u2212', 0x8b: '\u2030', 0x8c: '\u201e', 0x8d: '\u201c', 0x8e: '\u201d', 0x8f: '\u2018',
	0x90: '\u2019', 0x91: '\u201a', 0x92: '\u2122', 0x93: '\ufb01', 0x94: '\ufb02', 0x95: '\u0141', 0x96: '\u0152', 0x97: '\u0160',
	0x98: '\u0178', 0x99: '\u017d', 0x9a: '\u0131', 0x9b: '\u0142', 0x9c: '\u0153', 0x9d: '\u0161', 0x9e: '\u017e', 0xa0: '\u20ac'
};

function counts(lines: string[]): { elements: number; alt: number; actualText: number } {
	let alt = 0;
	let actualText = 0;
	for (const l of lines.slice(0, -1)) {
		const keys = (JSON.parse(l) as [Json, Json, Record<string, Json>])[2];
		if (keys['/Alt'] !== undefined) alt++;
		if (keys['/ActualText'] !== undefined) actualText++;
	}
	return { elements: lines.length - 1, alt, actualText };
}

/** The canonical tree of a whole file (for tests and the survey harness). */
export async function canonicalTree(qpdf: Qpdf, bytes: Uint8Array, password?: string): Promise<string[] | null> {
	const d = await dumpAll(qpdf, bytes, password);
	const m = d && readModel(d);
	return m ? canonical(m) : null;
}

// ------------------------------------------------------------------------------ verify

/** The final file's tags, against what the graft expected. */
export async function verifyTags(qpdf: Qpdf, bytes: Uint8Array, expected: Expected, password?: string): Promise<VerifyCheck> {
	const t0 = now();
	const fail = (detail: string): VerifyCheck => ({ name: 'tags', ok: false, detail });
	const dump = await dumpAll(qpdf, bytes, password);
	if (!dump) return fail('qpdf could not read the exported file’s objects.');
	const model = readModel(dump);
	if (!model) return fail('The exported file has no structure tree.');
	if (model.problems.length) return fail(`The tree could not be read: ${describe(model.problems)}.`);
	const content = await contentMcids(qpdf, bytes, model, password);
	if (!content) return fail('qpdf could not read the pages’ content.');
	checkModel(model, content);
	const problems = model.problems.filter((p) => !expected.tolerated.includes(`${p.kind}:${p.page}`));
	if (problems.length) return fail(`The tree does not match the content: ${describe(problems)}.`);
	const canon = canonical(model);
	if (canon.length !== expected.canon.length) return fail(`Expected ${expected.elements} structure elements, found ${canon.length - 1}.`);
	for (let i = 0; i < canon.length; i++) {
		if (canon[i] !== expected.canon[i]) {
			const a = canon[i];
			const b = expected.canon[i];
			let at = 0;
			while (at < a.length && a[at] === b[at]) at++;
			const from = Math.max(0, at - 60);
			return fail(`Structure element ${i + 1} differs from the original: …${a.slice(from, at + 100)} (expected …${b.slice(from, at + 100)}).`);
		}
	}
	const c = counts(canon);
	return {
		name: 'tags',
		ok: true,
		detail: `Accessibility tags kept: ${n(c.elements, 'structure element')}, ${n(c.alt, 'picture description')} (/Alt), ${n(c.actualText, 'replacement text')} (/ActualText), all tied to their page content (${Math.round(now() - t0)} ms).`
	};
}

const n = (k: number, word: string) => `${k} ${word}${k === 1 ? '' : 's'}`;

function describe(problems: Problem[]): string {
	const by = new Map<string, number>();
	for (const p of problems) by.set(p.kind, (by.get(p.kind) ?? 0) + 1);
	const first = problems[0];
	return `${[...by].map(([k, n]) => `${k} ×${n}`).join(', ')} (first: ${first.kind}${first.page !== undefined ? ` on page ${first.page + 1}` : ''}${first.detail ? `, ${first.detail}` : ''})`;
}

/** Text keys counted on elements (for tests and measurement). */
export const TAG_TEXT_KEYS = TEXT_KEYS;

/** For the survey harness and tests: the tree of a file read and checked as at planning time. */
export async function inspectTags(qpdf: Qpdf, bytes: Uint8Array): Promise<{ tagged: boolean; elements: number; problems: Problem[]; streams: boolean; ms: number } | null> {
	const t = await readSourceTags(qpdf, bytes).catch(() => null);
	if (!t) return { tagged: false, elements: 0, problems: [], streams: false, ms: 0 };
	return { tagged: true, elements: t.model.elems.length, problems: t.model.problems, streams: t.streams, ms: t.ms };
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
