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
 * - Kept: the export's pages come from one tagged source, each source page at most once,
 *   in any order and rotation, with or without blank pages added (they have no content).
 *   All pages kept: the whole tree. Some pages removed: the tree pruned to the kept pages
 *   (below). The source's tree is copied as new objects into the assembled file, with every
 *   reference to a page, annotation or form XObject turned into the reference to its copy
 *   (found by walking each source page next to its output page: /Annots by position,
 *   /Resources /XObject by name, recursively). /StructParents numbers stay as they are, so
 *   pages, annotations and XObjects need no change; the ParentTree is rebuilt as one flat
 *   number tree keeping the entries whose owner (page, annotation, XObject) is in the
 *   export. RoleMap, ClassMap, the IDTree (kept elements only), /MarkInfo, /Lang and
 *   /ViewerPreferences come along. Reordered pages keep the tree's order: it is the logical
 *   reading order of the document, which page order does not change.
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
 *   point at nothing); pages from another file, tagged or not, other than blank pages
 *   (`merged`); a page used twice (`repeated`: two pages cannot share one set of MCIDs);
 *   a source whose tree is inconsistent (`damaged`); a tree this code does not carry
 *   (`unsupported`: streams in the tree other than form XObjects, more than MAX_ELEMENTS
 *   elements, content on pages it cannot place); and an export whose own check of the tags
 *   fails (`check`; the export is then built again without them).
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

/** Most struct elements carried (memory: the JSON of the tree is held a few times over). */
export const MAX_ELEMENTS = 400_000;
/** Text keys dropped from an element whose content lies partly on removed pages. */
const PRUNED_TEXT = ['/Alt', '/ActualText', '/E', '/T'];
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
		if (model.elems.length > MAX_ELEMENTS) {
			problems.push({ kind: 'too-many', detail: `more than ${MAX_ELEMENTS} elements` });
			return model;
		}
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

async function readSourceTags(qpdf: Qpdf, bytes: Uint8Array): Promise<SourceTags | null> {
	const t0 = now();
	const cat = await catalogText(qpdf, bytes);
	if (!catalogHas(cat, 'StructTreeRoot')) return null;
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
		form: catalogHas(cat, 'AcroForm'),
		ms: Math.round(now() - t0)
	};
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

export type TagsPlan =
	| { kind: 'none' }
	| { kind: 'drop'; reason: TagsDropReason }
	| {
			kind: 'keep';
			source: Source;
			tags: SourceTags;
			/** For each output page: the source page index, or null (a blank page). */
			from: (number | null)[];
			/** Every page of the source is in the export. */
			whole: boolean;
	  };

/**
 * Whether this export can keep its source's tags. Cheap when no source is tagged (one
 * `--show-object` pair per source); a tagged source is read and checked once (cached).
 */
export async function planTags(
	qpdf: Qpdf,
	pages: PageRef[],
	byId: Map<string, Source>,
	used: Source[],
	opts: { redaction: boolean; flatten: boolean }
): Promise<TagsPlan> {
	const tagged: { source: Source; tags: SourceTags }[] = [];
	for (const s of used) {
		if (s.kind !== 'pdf') continue;
		const t = await sourceTags(qpdf, s);
		if (t) tagged.push({ source: s, tags: t });
	}
	if (tagged.length === 0) return { kind: 'none' };
	if (opts.redaction) return { kind: 'drop', reason: 'redacted' };
	if (opts.flatten && tagged.some((t) => t.tags.form)) return { kind: 'drop', reason: 'flattened' };
	const main = tagged[0];
	if (used.some((s) => s !== main.source && s.kind !== 'blank')) return { kind: 'drop', reason: 'merged' };
	const from: (number | null)[] = [];
	const seen = new Set<number>();
	for (const ref of pages) {
		const s = byId.get(ref.sourceId);
		if (s !== main.source) {
			from.push(null);
			continue;
		}
		if (seen.has(ref.pageIndex)) return { kind: 'drop', reason: 'repeated' };
		seen.add(ref.pageIndex);
		from.push(ref.pageIndex);
	}
	if (main.tags.fatal.length) return { kind: 'drop', reason: 'damaged' };
	if (main.tags.streams) return { kind: 'drop', reason: 'unsupported' };
	return { kind: 'keep', source: main.source, tags: main.tags, from, whole: seen.size === main.source.pages.length };
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
	return { kept, partial, kidKept: (e, k) => model.elems[e].kids[k].k === 'e' ? kept[(model.elems[e].kids[k] as { i: number }).i] : kidOk[e][k] };
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

/**
 * Copies the source's tree into `assembled` (pages already in place). Null when the copy
 * cannot be made exactly (the caller exports without tags).
 */
export async function graftTags(qpdf: Qpdf, assembled: Uint8Array, plan: Extract<TagsPlan, { kind: 'keep' }>, note: (s: string) => void = () => {}): Promise<GraftResult | null> {
	const t0 = now();
	const src = plan.tags.model;
	const out = await dumpAll(qpdf, assembled);
	if (!out || out.pages.length !== plan.from.length) {
		note('tags: the assembled file could not be read');
		return null;
	}
	const so = src.objects;
	const oo = out.objects;

	// Source object → its copy in the output.
	const map = new Map<string, string>();
	const conflict = (a: string, b: string) => {
		const prev = map.get(a);
		if (prev !== undefined && prev !== b) throw new GraftError(`${a} has two copies`);
		map.set(a, b);
	};
	try {
		plan.from.forEach((p, i) => {
			if (p === null) return;
			const sref = src.pages[p];
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
	} catch (e) {
		note(`tags: ${e instanceof Error ? e.message : String(e)}`);
		return null;
	}
	const has = (ref: string) => map.has(ref);
	const keep = prune(src, has);
	// A kid on a page in the export must have its copy: otherwise the tree would lose content silently.
	for (let i = 0; i < src.elems.length; i++) {
		if (!keep.kept[i]) continue;
		const e = src.elems[i];
		for (const kid of e.kids) {
			if (kid.k === 'o' && !has(kid.obj)) {
				const at = isStream(so, kid.obj) ? src.xobjPage.get(kid.obj) : src.annotAt.get(kid.obj)?.[0];
				if (at !== undefined && has(src.pages[at])) {
					note(`tags: ${kid.obj} on a kept page has no copy`);
					return null;
				}
			}
			if (kid.k === 'm' && kid.stm && !has(kid.stm)) {
				const at = src.xobjPage.get(kid.stm);
				if (at !== undefined && has(src.pages[at])) {
					note(`tags: ${kid.stm} on a kept page has no copy`);
					return null;
				}
			}
		}
	}

	// New objects.
	let next = (typeof out.header.maxobjectid === 'number' ? out.header.maxobjectid : Math.max(...Object.keys(oo).map((k) => Number(/obj:(\d+)/.exec(k)?.[1] ?? 0)))) + 1;
	const fresh = () => `${next++} 0 R`;
	const updates: Record<string, Obj> = {};
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
				throw new GraftError('a stream in the tree');
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
		if (Array.isArray(v)) return v.map((x) => T(x, depth + 1));
		if (isDict(v)) {
			const d: Dict = {};
			for (const [k, x] of Object.entries(v)) d[k] = T(x, depth + 1);
			return d;
		}
		return v;
	};
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

	try {
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
				d[k] = T(v, 1);
			}
			d['/P'] = parent ?? 'ROOT';
			const kids: Json[] = [];
			e.kids.forEach((kid, k) => {
				if (!keep.kidKept(i, k)) return;
				if (kid.k === 'e') kids.push(newElem[kid.i]);
				else if (kid.k === 'm') {
					if (typeof kid.raw === 'number') kids.push(kid.raw);
					else {
						const md = dictAt(so, kid.raw)!;
						const nd: Dict = {};
						for (const [mk, mv] of Object.entries(md)) {
							if (mk === '/Pg' || mk === '/Stm') {
								const m = isRef(mv) ? map.get(mv) : undefined;
								if (m) nd[mk] = m;
							} else nd[mk] = T(mv, 2);
						}
						kids.push(nd);
					}
				} else {
					const od = dictAt(so, kid.raw)!;
					const nd: Dict = {};
					for (const [mk, mv] of Object.entries(od)) {
						if (mk === '/Pg' || mk === '/Obj') {
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

		// The root, its ParentTree and IDTree.
		const rootRef = fresh();
		for (const u of Object.values(updates)) if (isDict(u.value) && u.value['/P'] === 'ROOT') u.value['/P'] = rootRef;
		const root: Dict = {};
		for (const [k, v] of Object.entries(src.root)) {
			if (k === '/K' || k === '/ParentTree' || k === '/IDTree') continue;
			root[k] = T(v, 1);
		}
		root['/Type'] = '/StructTreeRoot';
		const topKids = src.elems.flatMap((e, i) => (e.parent < 0 && newElem[i] ? [newElem[i]] : []));
		root['/K'] = topKids.length === 1 && !Array.isArray(val(so, src.root['/K'])) ? topKids[0] : topKids;
		if (src.root['/ParentTree'] !== undefined) {
			const nums: Json[] = [];
			for (const key of [...src.pt.keys()].sort((a, b) => a - b)) {
				const owner = src.owners.get(key);
				if (!owner || !has(owner.ref)) continue;
				const entry = src.pt.get(key);
				const arr = arrAt(so, entry);
				if (arr && (owner.kind === 'page' || (owner.kind === 'xobj' && dictAt(so, owner.ref)?.['/StructParents'] === key))) {
					nums.push(key, arr.map((x) => (isRef(x) && src.elemOf.has(x) ? (newElem[src.elemOf.get(x)!] ?? null) : null)));
				} else if (isRef(entry) && src.elemOf.has(entry)) {
					const ne = newElem[src.elemOf.get(entry)!];
					if (ne) nums.push(key, ne);
				}
			}
			const ptRef = fresh();
			updates[objKey(ptRef)] = { value: { '/Nums': nums } };
			root['/ParentTree'] = ptRef;
		}
		if (src.root['/IDTree'] !== undefined) {
			const names: Json[] = [];
			for (const [k, v] of src.ids) {
				if (isRef(v) && src.elemOf.has(v) && newElem[src.elemOf.get(v)!]) names.push(k, newElem[src.elemOf.get(v)!]);
			}
			const idRef = fresh();
			updates[objKey(idRef)] = { value: { '/Names': names } };
			root['/IDTree'] = idRef;
		}
		updates[objKey(rootRef)] = { value: root };

		// The catalog.
		const trailer = oo.trailer?.value;
		const catRef = isDict(trailer) ? trailer['/Root'] : null;
		const cat = isRef(catRef) ? dictAt(oo, catRef) : null;
		if (!isRef(catRef) || !cat) throw new GraftError('the assembled catalog is unreadable');
		const nc: Dict = { ...cat, '/StructTreeRoot': rootRef };
		for (const k of ['/MarkInfo', '/Lang', '/ViewerPreferences']) if (src.catalog[k] !== undefined) nc[k] = T(src.catalog[k], 1);
		updates[objKey(catRef)] = { value: nc };
	} catch (e) {
		note(`tags: ${e instanceof Error ? e.message : String(e)}`);
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
	const pageOut = new Map<number, number>();
	plan.from.forEach((p, i) => {
		if (p !== null) pageOut.set(p, i);
	});
	const expected = expectedOf(src, keep, pageOut);
	return { bytes, expected, ms: Math.round(now() - t0) };
}

// ------------------------------------------------------------------------------ canonical form

/**
 * Canonical form of a tree, one string per element in document order: role, keys (refs
 * replaced: elements by number, pages by output page number, annotations by page and
 * position, other objects inlined), kids. `pageNo` maps the model's page index to the
 * output page number; `keepElem`/`kidKept`/`partial` apply a pruning (all true for an
 * export's own tree).
 */
function canonical(model: TagModel, pageNo: (i: number) => number | undefined, keep?: Keep): string[] {
	const { objects } = model;
	const n = model.elems.length;
	const kept = keep?.kept ?? new Array<boolean>(n).fill(true);
	const number = new Map<string, number>();
	let c = 0;
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
		const x = model.xobjPage.get(ref);
		if (x !== undefined) {
			const p = pageNo(x);
			return p === undefined ? null : `X${p}`;
		}
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
			if (ob.stream) return 'stream';
			const d = ob.value;
			if (isDict(d) && (d['/Type'] === '/Page' || d['/Type'] === '/Pages' || d['/Type'] === '/Catalog' || isAnnotDict(d))) return null;
			return cv(d, depth + 1, new Set([...seen, v]));
		}
		if (Array.isArray(v)) return v.map((x) => cv(x, depth + 1, seen));
		if (isDict(v)) {
			const out: Record<string, Json> = {};
			for (const k of Object.keys(v).sort()) out[k] = cv(v[k], depth + 1, seen);
			return out;
		}
		return v;
	};
	const lines: string[] = [];
	for (let i = 0; i < n; i++) {
		if (!kept[i]) continue;
		const e = model.elems[i];
		const keys: Record<string, Json> = {};
		for (const k of Object.keys(e.dict).sort()) {
			if (k === '/K' || k === '/P' || k === '/Pg' || k === '/Type') continue;
			if (keep?.partial[i] && PRUNED_TEXT.includes(k)) continue;
			let v = e.dict[k];
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
			keys[k] = cv(v, 0, new Set());
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
		lines.push(JSON.stringify([e.dict['/S'], e.parent < 0 ? -1 : number.get(model.elems[e.parent].ref), keys, kids]));
	}
	// The root's own keys (RoleMap, ClassMap, …) and the catalog's tag keys.
	const rootKeys: Record<string, Json> = {};
	for (const k of Object.keys(model.root).sort()) {
		if (k === '/K' || k === '/ParentTree' || k === '/IDTree' || k === '/Type') continue;
		rootKeys[k] = cv(model.root[k], 0, new Set());
	}
	const catKeys: Record<string, Json> = {};
	for (const k of ['/MarkInfo', '/Lang', '/ViewerPreferences']) if (model.catalog[k] !== undefined) catKeys[k] = cv(model.catalog[k], 0, new Set());
	const ids = model.ids.filter(([, v]) => isRef(v) && number.has(v)).map(([k, v]) => [k, number.get(v as string)]);
	lines.push(JSON.stringify(['root', rootKeys, catKeys, ids]));
	return lines;
}

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

function expectedOf(model: TagModel, keep: Keep, pageOut: Map<number, number>): Expected {
	const canon = canonical(model, (i) => pageOut.get(i), keep);
	return { canon, ...counts(canon), tolerated: [] };
}

/** The canonical tree of a whole file (for tests and the survey harness). */
export async function canonicalTree(qpdf: Qpdf, bytes: Uint8Array, password?: string): Promise<string[] | null> {
	const d = await dumpAll(qpdf, bytes, password);
	const m = d && readModel(d);
	return m ? canonical(m, (i) => i) : null;
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
	const canon = canonical(model, (i) => i);
	if (canon.length !== expected.canon.length) return fail(`Expected ${expected.elements} structure elements, found ${canon.length - 1}.`);
	for (let i = 0; i < canon.length; i++) {
		if (canon[i] !== expected.canon[i]) return fail(`Structure element ${i + 1} differs from the original: ${canon[i].slice(0, 160)} (expected ${expected.canon[i].slice(0, 160)}).`);
	}
	const c = counts(canon);
	return {
		name: 'tags',
		ok: true,
		detail: `Accessibility tags kept: ${c.elements} structure elements, ${c.alt} picture descriptions (/Alt), ${c.actualText} replacement texts (/ActualText), all tied to their page content (${Math.round(now() - t0)} ms).`
	};
}

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
