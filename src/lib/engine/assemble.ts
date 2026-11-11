/**
 * The assemble step: the plan's pages, in order and rotated, in a new file.
 *
 * Two ways, chosen per plan:
 *
 * - `qpdf --empty --pages …` (any plan): pages are copied into an empty document. qpdf
 *   copies form fields page by page: a field with widgets on several pages becomes one
 *   copy per page, and every copy carries the field's whole widget tree. On forms built
 *   around one root field (XFA-style government forms: thousands of widgets over a hundred
 *   pages) that is quadratic: a 136-page form needed more than 2 GB. Layers are carried
 *   through the copy (oc.ts).
 * - `qpdf <source> --pages . …` (one source with a form, each page used at most once):
 *   the source is edited in place, so its form keeps its single field tree. The catalog is
 *   first reduced to what the copy would give (pages, form, layers, page labels; no
 *   outline, structure tree, names, scripts or Info dictionary, so nothing of a deleted
 *   page survives through them), and an XFA form's XFA part is dropped as in the copy.
 *   The reduction is applied in the same qpdf run; it costs one JSON dump of three objects.
 */

import type { PageRef, Source } from '../core/types';
import { EngineError } from './errors';
import {
	carryOptionalContent,
	catalogHas,
	catalogText,
	dump,
	isDict,
	isRef,
	objArg,
	objKey,
	restoreOptionalContent,
	type CatalogText,
	type Dict,
	type JsonObject
} from './oc';
import type { Qpdf } from './qpdf';

/** Catalog keys a reduced catalog keeps (what `--empty --pages` produces, plus layers). */
const KEEP = ['/Type', '/Pages', '/AcroForm', '/OCProperties', '/PageLabels'];

export interface AssembleJob {
	pages: PageRef[];
	used: Source[];
	/** Source id → path of its bytes in qpdf's file system. */
	fileOf: Map<string, string>;
	/** Runs qpdf and returns the named output, or throws the export's error. */
	run: (run: { args: string[]; inputs: Record<string, Uint8Array>; outputs: string[] }, output: string) => Promise<Uint8Array>;
}

const OUT = '/out/assembled.pdf';

export async function assemble(qpdf: Qpdf, job: AssembleJob): Promise<Uint8Array> {
	const { pages, used, fileOf, run } = job;
	const cats = new Map<Source, CatalogText | null>();
	for (const s of used) cats.set(s, await catalogText(qpdf, s.bytes));

	const single = used.length === 1 ? used[0] : null;
	const unique = new Set(pages.map((p) => p.pageIndex)).size === pages.length;
	if (single && unique && catalogHas(cats.get(single)!, 'AcroForm')) {
		const update = await reducedCatalog(qpdf, single.bytes, cats.get(single)!);
		const sel = pages.map((p) => p.pageIndex + 1).join(',');
		return run(
			{
				args: ['/src/in.pdf', '--update-from-json=/src/catalog.json', '--pages', '.', sel, '--', ...rotateArgs(pages), OUT],
				inputs: { '/src/in.pdf': single.bytes, '/src/catalog.json': update },
				outputs: [OUT]
			},
			OUT
		);
	}

	const inputs: Record<string, Uint8Array> = {};
	let layers = false;
	for (const s of used) {
		// Layers (optional content) live in the catalog, which the copy does not take along.
		const carried = await carryOptionalContent(qpdf, s.bytes, cats.get(s));
		if (carried !== s.bytes) layers = true;
		inputs[fileOf.get(s.id)!] = carried;
	}
	const bytes = await run(
		{ args: ['--empty', '--pages', ...pageSelection(pages, fileOf), '--', ...rotateArgs(pages), OUT], inputs, outputs: [OUT] },
		OUT
	);
	return layers ? restoreOptionalContent(qpdf, bytes) : bytes;
}

/** qpdf JSON update: the catalog reduced to KEEP, no XFA in the form, no Info dictionary. */
async function reducedCatalog(qpdf: Qpdf, bytes: Uint8Array, cat: CatalogText): Promise<Uint8Array> {
	const formRef = /\/AcroForm (\d+ \d+ R)/.exec(cat.text)?.[1];
	const d = await dump(qpdf, bytes, ['trailer', objArg(cat.root), ...(formRef ? [objArg(formRef)] : [])], false);
	const catalog = d.objects[objKey(cat.root)]?.value;
	const trailer = d.objects.trailer?.value;
	if (!isDict(catalog) || !isDict(trailer)) throw new EngineError('internal', 'The file’s catalog could not be read.');
	const updates: Record<string, JsonObject> = {};
	const reduced: Dict = {};
	for (const k of KEEP) if (k in catalog) reduced[k] = catalog[k];
	const form = reduced['/AcroForm'];
	if (isDict(form) && '/XFA' in form) {
		const { ['/XFA']: _x, ...rest } = form;
		reduced['/AcroForm'] = rest;
	} else if (isRef(form)) {
		const value = d.objects[objKey(form)]?.value;
		if (isDict(value) && '/XFA' in value) {
			const { ['/XFA']: _x, ...rest } = value;
			updates[objKey(form)] = { value: rest };
		}
	}
	updates[objKey(cat.root)] = { value: reduced };
	if ('/Info' in trailer) {
		const { ['/Info']: _i, ...rest } = trailer;
		updates.trailer = { value: rest };
	}
	return new TextEncoder().encode(JSON.stringify({ qpdf: [d.header, updates] }));
}

/** `--pages` arguments, grouping consecutive pages from the same file. */
export function pageSelection(pages: PageRef[], fileOf: Map<string, string>): string[] {
	const args: string[] = [];
	let file = '';
	let nums: number[] = [];
	const flush = () => {
		if (nums.length) args.push(file, nums.join(','));
	};
	for (const ref of pages) {
		const f = fileOf.get(ref.sourceId)!;
		if (f !== file) {
			flush();
			file = f;
			nums = [];
		}
		nums.push(ref.pageIndex + 1);
	}
	flush();
	return args;
}

export function rotateArgs(pages: PageRef[]): string[] {
	const by = new Map<PageRef['rotation'], number[]>();
	pages.forEach((ref, i) => {
		if (ref.rotation === 0) return;
		const list = by.get(ref.rotation) ?? [];
		list.push(i + 1);
		by.set(ref.rotation, list);
	});
	return [...by.entries()].map(([angle, list]) => `--rotate=+${angle}:${list.join(',')}`);
}
