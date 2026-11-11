/**
 * Optional content (layers) across the assemble step.
 *
 * `qpdf --empty --pages` copies pages and everything they reference, but not the
 * document catalog, so a source's /OCProperties is lost. Without it every viewer shows
 * every layer, including the ones the file hides by default (/D /OFF, /BaseState /OFF):
 * the export would show content the original did not.
 *
 * Fix: before assembling, every page of a source with /OCProperties gets a private key
 * pointing at that /OCProperties (`carryOptionalContent`). qpdf copies it with the page,
 * through the same per-source object map as the page's own layer references, so the copy
 * names exactly the copied layer objects. After assembling, `restoreOptionalContent`
 * merges the carried dictionaries into the new catalog and removes the private keys.
 *
 * Cost: two `--show-object` runs per source (cheap even on huge files); the JSON dumps and
 * rewrites run only for sources that have layers.
 */

import { EngineError } from './errors';
import { QPDF_OK, QPDF_WARNINGS, type Qpdf } from './qpdf';

/** Private page key; never left in an exported file. */
export const OC_CARRIER = '/PdfgOptionalContent';

type Json = unknown;
export type Dict = Record<string, Json>;
export interface JsonObject {
	value?: Json;
	stream?: { dict?: Json };
}
interface Dump {
	header: Dict;
	objects: Record<string, JsonObject>;
	pages: string[];
}

export const isDict = (v: Json): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
export const isRef = (v: Json): v is string => typeof v === 'string' && /^\d+ \d+ R$/.test(v);
export const objKey = (ref: string) => `obj:${ref}`;
export const objArg = (ref: string) => ref.replace(/^(\d+) (\d+) R$/, '$1,$2');

async function show(qpdf: Qpdf, bytes: Uint8Array, what: string): Promise<string | null> {
	const res = await qpdf.run({ args: [`--show-object=${what}`, '/oc.pdf'], inputs: { '/oc.pdf': bytes } });
	return res.code === QPDF_OK || res.code === QPDF_WARNINGS ? res.stdout : null;
}

export interface CatalogText {
	/** "N G R" of the catalog. */
	root: string;
	/** The catalog dictionary as qpdf prints it (PDF syntax; direct values inline). */
	text: string;
}

/** The catalog of `bytes` in qpdf's text form: two cheap `--show-object` runs, even on huge files. */
export async function catalogText(qpdf: Qpdf, bytes: Uint8Array): Promise<CatalogText | null> {
	const trailer = await show(qpdf, bytes, 'trailer');
	const root = trailer && /\/Root (\d+) (\d+) R/.exec(trailer);
	if (!root) return null;
	const text = await show(qpdf, bytes, `${root[1]},${root[2]}`);
	return text === null ? null : { root: `${root[1]} ${root[2]} R`, text };
}

/** The catalog names `key` (a top-level key: printed as "/Key " followed by a value). */
export function catalogHas(cat: CatalogText | null, key: string): boolean {
	return cat !== null && new RegExp(`/${key}[\\s<\\[\\d(]`).test(cat.text);
}

export async function dump(qpdf: Qpdf, bytes: Uint8Array, objects: string[], withPages: boolean): Promise<Dump> {
	const res = await qpdf.run({
		args: [
			'--json=2',
			'--json-key=qpdf',
			...(withPages ? ['--json-key=pages'] : []),
			...objects.map((o) => `--json-object=${o}`),
			'--json-stream-data=none',
			'/oc.pdf',
			'/oc.json'
		],
		inputs: { '/oc.pdf': bytes },
		outputs: ['/oc.json']
	});
	const file = res.files.get('/oc.json');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) {
		throw new EngineError('internal', 'The layers of this file could not be read.');
	}
	const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Dict, Record<string, JsonObject>]; pages?: { object: string }[] };
	return { header: parsed.qpdf[0], objects: parsed.qpdf[1], pages: (parsed.pages ?? []).map((p) => p.object) };
}

export async function update(qpdf: Qpdf, bytes: Uint8Array, header: Dict, objects: Record<string, JsonObject>): Promise<Uint8Array> {
	const json = new TextEncoder().encode(JSON.stringify({ qpdf: [header, objects] }));
	const res = await qpdf.run({
		args: ['/oc.pdf', '--update-from-json=/oc-update.json', '/oc-out.pdf'],
		inputs: { '/oc.pdf': bytes, '/oc-update.json': json },
		outputs: ['/oc-out.pdf']
	});
	const out = res.files.get('/oc-out.pdf');
	if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !out) {
		throw new EngineError('internal', 'The layers of this file could not be carried over.');
	}
	return out;
}

/** Page dictionaries and the catalog of `bytes` (pages in order). */
async function pagesAndRoot(qpdf: Qpdf, bytes: Uint8Array) {
	const first = await dump(qpdf, bytes, ['trailer'], true);
	const trailer = first.objects.trailer?.value;
	const root = isDict(trailer) ? trailer['/Root'] : null;
	if (!isRef(root)) throw new EngineError('internal', 'The layers of this file could not be read.');
	const second = await dump(qpdf, bytes, [objArg(root), ...first.pages.map(objArg)], false);
	const value = (ref: string): Dict => {
		const v = second.objects[objKey(ref)]?.value;
		if (!isDict(v)) throw new EngineError('internal', 'The layers of this file could not be read.');
		return v;
	};
	return {
		header: second.header,
		root,
		catalog: value(root),
		pages: first.pages.map((ref) => ({ ref, dict: value(ref) })),
		objects: second.objects
	};
}

/**
 * `bytes` with every page pointing at the catalog's /OCProperties under OC_CARRIER, or
 * `bytes` itself when the file has no layers.
 */
export async function carryOptionalContent(qpdf: Qpdf, bytes: Uint8Array, cat?: CatalogText | null): Promise<Uint8Array> {
	if (!catalogHas(cat === undefined ? await catalogText(qpdf, bytes) : cat, 'OCProperties')) return bytes;
	const { header, catalog, pages } = await pagesAndRoot(qpdf, bytes);
	const oc = catalog['/OCProperties'];
	const updates: Record<string, JsonObject> = {};
	let ocRef: string;
	if (isRef(oc)) {
		ocRef = oc;
	} else if (isDict(oc)) {
		// A direct dictionary: give it an object of its own so every page can point at it.
		const max = Number(header.maxobjectid);
		if (!Number.isInteger(max)) throw new EngineError('internal', 'The layers of this file could not be read.');
		ocRef = `${max + 1} 0 R`;
		updates[objKey(ocRef)] = { value: oc };
	} else {
		return bytes;
	}
	for (const { ref, dict } of pages) updates[objKey(ref)] = { value: { ...dict, [OC_CARRIER]: ocRef } };
	return update(qpdf, bytes, header, updates);
}

const arr = (v: Json): Json[] => (Array.isArray(v) ? v : []);
const refs = (v: Json): string[] => arr(v).filter(isRef);

/**
 * Merges the /OCProperties carried by the pages of an assembled file into its catalog and
 * removes the carrier keys. `bytes` is returned unchanged when no page carries one.
 * With several sources, layers that a source hides by default stay hidden: its /BaseState
 * /OFF is spelled out as /OFF entries, since one merged default configuration must serve all.
 */
export async function restoreOptionalContent(qpdf: Qpdf, bytes: Uint8Array): Promise<Uint8Array> {
	const { header, root, catalog, pages, objects } = await pagesAndRoot(qpdf, bytes);
	const carried = [...new Set(pages.flatMap(({ dict }) => (isRef(dict[OC_CARRIER]) ? [dict[OC_CARRIER] as string] : [])))];
	if (carried.length === 0) return bytes;

	let props: Dict[];
	const known = carried.filter((r) => objects[objKey(r)]);
	if (known.length === carried.length) {
		props = carried.map((r) => objects[objKey(r)].value).filter(isDict);
	} else {
		const more = await dump(qpdf, bytes, carried.map(objArg), false);
		props = carried.map((r) => more.objects[objKey(r)]?.value).filter(isDict);
	}
	if (props.length !== carried.length) throw new EngineError('internal', 'The layers of this file could not be carried over.');
	if (props.length > 1) {
		// Resolve indirect /D dictionaries so they can be merged.
		const dRefs = props.map((p) => p['/D']).filter(isRef);
		if (dRefs.length) {
			const more = await dump(qpdf, bytes, dRefs.map(objArg), false);
			props = props.map((p) => (isRef(p['/D']) ? { ...p, '/D': more.objects[objKey(p['/D'] as string)]?.value ?? {} } : p));
		}
	}

	let merged: Dict;
	if (props.length === 1) {
		merged = props[0];
	} else {
		const ocgs = new Set<string>();
		const on = new Set<string>();
		const off = new Set<string>();
		const locked = new Set<string>();
		const order: Json[] = [];
		const rb: Json[] = [];
		const as: Json[] = [];
		for (const p of props) {
			const d = isDict(p['/D']) ? (p['/D'] as Dict) : {};
			const own = refs(p['/OCGs']);
			own.forEach((r) => ocgs.add(r));
			const ownOn = new Set(refs(d['/ON']));
			ownOn.forEach((r) => on.add(r));
			refs(d['/OFF']).forEach((r) => off.add(r));
			if (d['/BaseState'] === '/OFF') own.filter((r) => !ownOn.has(r)).forEach((r) => off.add(r));
			refs(d['/Locked']).forEach((r) => locked.add(r));
			order.push(...arr(d['/Order']));
			rb.push(...arr(d['/RBGroups']));
			as.push(...arr(d['/AS']));
		}
		const first = isDict(props[0]['/D']) ? (props[0]['/D'] as Dict) : {};
		const d: Dict = { ...first, '/BaseState': '/ON', '/ON': [...on].filter((r) => !off.has(r)), '/OFF': [...off] };
		const setOrDrop = (k: string, v: Json[]) => {
			if (v.length) d[k] = v;
			else delete d[k];
		};
		setOrDrop('/Order', order);
		setOrDrop('/RBGroups', rb);
		setOrDrop('/AS', as);
		setOrDrop('/Locked', [...locked]);
		merged = { '/OCGs': [...ocgs], '/D': d };
	}

	const updates: Record<string, JsonObject> = { [objKey(root)]: { value: { ...catalog, '/OCProperties': merged } } };
	for (const { ref, dict } of pages) {
		if (!(OC_CARRIER in dict)) continue;
		const rest = { ...dict };
		delete rest[OC_CARRIER];
		updates[objKey(ref)] = { value: rest };
	}
	return update(qpdf, bytes, header, updates);
}
