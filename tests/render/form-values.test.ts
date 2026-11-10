/**
 * Renderer + RenderRequest.formValues: answers drawn by PDF.js annotation storage.
 *
 * Runs the real renderer in Node: the legacy PDF.js build with its in-thread
 * worker, @napi-rs/canvas standing in for OffscreenCanvas, and a stand-in
 * ImageBitmap that keeps the RGBA pixels. Corpus: tests/corpus/generate-forms.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FormField, FormValue, Renderer, Source, StampBox } from '../../src/lib/core/types';
import { createRenderer, type PdfJsHandle } from '../../src/lib/render/renderer';
import { fillableWidgets, storageEntries } from '../../src/lib/render/form-values';
import { engine, loadPdfjs, openCorpus, root } from '../engine/helpers';

const T = 60_000;
const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

// ---------------------------------------------------------------------------
// Browser stand-ins.

class FakeBitmap {
	constructor(
		readonly width: number,
		readonly height: number,
		public data: Uint8ClampedArray
	) {}
	close() {
		this.data = new Uint8ClampedArray(0);
	}
}

const saved = {
	OffscreenCanvas: (globalThis as Record<string, unknown>).OffscreenCanvas,
	createImageBitmap: (globalThis as Record<string, unknown>).createImageBitmap,
	fetch: globalThis.fetch
};
const offOrigin: string[] = [];

beforeAll(() => {
	const g = globalThis as Record<string, unknown>;
	// Returning another object from `new` means `instanceof OffscreenCanvas` is false,
	// so the renderer takes its createImageBitmap(canvas) path.
	g.OffscreenCanvas = function (w: number, h: number) {
		return createCanvas(w, h);
	};
	g.createImageBitmap = async (src: unknown) => {
		if (src instanceof FakeBitmap) return new FakeBitmap(src.width, src.height, src.data.slice());
		const c = src as ReturnType<typeof createCanvas>;
		const img = c.getContext('2d').getImageData(0, 0, c.width, c.height);
		return new FakeBitmap(c.width, c.height, new Uint8ClampedArray(img.data));
	};
	// Nothing may go to the network: every asset comes through the factory below.
	globalThis.fetch = (async (url: unknown) => {
		offOrigin.push(String(url));
		throw new Error(`fetch ${String(url)} in a renderer test`);
	}) as typeof fetch;
});

afterAll(() => {
	const g = globalThis as Record<string, unknown>;
	g.OffscreenCanvas = saved.OffscreenCanvas;
	g.createImageBitmap = saved.createImageBitmap;
	globalThis.fetch = saved.fetch;
});

// ---------------------------------------------------------------------------
// PDF.js for Node, with the same factory shape as pdfjs-loader.ts.

const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist');
const dirs = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const;
const assetLoads: { kind: string; filename: string }[] = [];

class FsBinaryDataFactory {
	async fetch({ kind, filename }: { kind: keyof typeof dirs; filename: string }): Promise<Uint8Array> {
		assetLoads.push({ kind, filename });
		return new Uint8Array(fs.readFileSync(path.join(pdfjsDir, dirs[kind], filename)));
	}
}

/** annotationMode of every page.render() call. */
const renderCalls: (number | undefined)[] = [];
let patched = false;

async function nodePdfJs(): Promise<PdfJsHandle> {
	const lib = (await loadPdfjs()) as unknown as PdfJsHandle['lib'];
	if (!patched) {
		patched = true;
		const task = lib.getDocument({ data: (await openCorpus('form.pdf')).bytes.slice(), verbosity: 0 });
		const proto = Object.getPrototypeOf(await (await task.promise).getPage(1));
		await task.destroy();
		const original = proto.render;
		proto.render = function (this: unknown, params: { annotationMode?: number }) {
			renderCalls.push(params.annotationMode);
			return original.call(this, params);
		};
	}
	return { lib, documentOptions: { BinaryDataFactory: FsBinaryDataFactory, useWorkerFetch: false, verbosity: 0 } };
}

const renderers: Renderer[] = [];
function renderer(concurrency = 4): Renderer {
	const r = createRenderer({ concurrency, cacheBytes: 256 * 1024 * 1024, pdfjs: nodePdfJs });
	renderers.push(r);
	return r;
}
afterAll(() => {
	for (const r of renderers) for (const id of ids) r.release(id);
});
const ids = new Set<string>();

// ---------------------------------------------------------------------------
// Pixels.

interface Shot {
	w: number;
	h: number;
	px: Uint8ClampedArray;
}

const W = 612;

async function shot(r: Renderer, source: Source, pageIndex: number, formValues?: Record<string, FormValue>): Promise<Shot> {
	ids.add(source.id);
	const bmp = (await r.render({ source, pageIndex, width: W, rotation: 0, formValues })) as unknown as FakeBitmap;
	const out = { w: bmp.width, h: bmp.height, px: bmp.data.slice() };
	bmp.close();
	return out;
}

interface PxBox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

const pxBox = (s: Shot, b: StampBox, grow = 0): PxBox => ({
	x0: Math.floor(b.x * s.w) - grow,
	y0: Math.floor(b.y * s.h) - grow,
	x1: Math.ceil((b.x + b.w) * s.w) + grow,
	y1: Math.ceil((b.y + b.h) * s.h) + grow
});
const inBox = (x: number, y: number, b: PxBox) => x >= b.x0 && x < b.x1 && y >= b.y0 && y < b.y1;

/** Pixels that differ, split by whether they are inside one of `boxes` (grown by 2 px). */
function diff(a: Shot, b: Shot, boxes: StampBox[]): { inside: number; outside: number } {
	expect([b.w, b.h]).toEqual([a.w, a.h]);
	const grown = boxes.map((x) => pxBox(a, x, 2));
	let inside = 0;
	let outside = 0;
	for (let y = 0; y < a.h; y++) {
		for (let x = 0; x < a.w; x++) {
			const o = (y * a.w + x) * 4;
			if (a.px[o] === b.px[o] && a.px[o + 1] === b.px[o + 1] && a.px[o + 2] === b.px[o + 2]) continue;
			if (grown.some((g) => inBox(x, y, g))) inside++;
			else outside++;
		}
	}
	return { inside, outside };
}

/** Dark pixels inside a box, 3 px in from its edges so the widget border does not count. */
function ink(s: Shot, b: StampBox): { count: number; maxX: number } {
	const p = pxBox(s, b, -3);
	let count = 0;
	let maxX = -1;
	for (let y = Math.max(0, p.y0); y < Math.min(s.h, p.y1); y++) {
		for (let x = Math.max(0, p.x0); x < Math.min(s.w, p.x1); x++) {
			const o = (y * s.w + x) * 4;
			if (s.px[o] + s.px[o + 1] + s.px[o + 2] < 300) {
				count++;
				maxX = Math.max(maxX, x);
			}
		}
	}
	return { count, maxX };
}

const same = (a: Shot, b: Shot) => expect(Buffer.compare(Buffer.from(a.px), Buffer.from(b.px))).toBe(0);

let kinds: Source;
let fields: Map<string, FormField>;
/** Widget boxes of a field on a page (radio: optionally only one option). */
const boxes = (name: string, page: number, option?: string): StampBox[] =>
	fields
		.get(name)!
		.widgets.filter((w) => w.pageIndex === page && (option === undefined || w.option === option))
		.map((w) => w.box);

beforeAll(async () => {
	kinds = await openCorpus('forms-kinds.pdf');
	fields = new Map((await engine().formFields(kinds)).map((f) => [f.name, f]));
}, T);

beforeEach(() => {
	renderCalls.length = 0;
});

// ---------------------------------------------------------------------------

describe('form-values: field names to annotation storage', () => {
	it('maps every fillable kind the engine lists, by PDF.js names, and nothing else', async () => {
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: kinds.bytes.slice(), verbosity: 0 });
		const doc = await task.promise;
		const pages = [];
		for (let i = 1; i <= doc.numPages; i++) pages.push(fillableWidgets(await (await doc.getPage(i)).getAnnotations()));
		await task.destroy();
		const names = new Set(pages.flat().map((w) => w.field));
		// Every editable engine field is fillable here; no read-only or unlisted one is.
		const editable = [...fields.values()].filter((f) => !f.readOnly).map((f) => f.name);
		for (const n of editable) expect(names.has(n), n).toBe(true);
		for (const n of ['ro', 'langs', 'pw', 'btn', 'sig', 'hidden', 'noview']) expect(names.has(n), n).toBe(false);
		// Radio options are the engine's options, page by page.
		for (const [page, list] of pages.entries()) {
			for (const w of list.filter((x) => x.kind === 'radio')) {
				expect(fields.get(w.field)!.widgets.some((fw) => fw.pageIndex === page && fw.option === w.option)).toBe(true);
			}
		}
		// Value shapes; answers equal to the file, or of the wrong type, give no entry.
		const all = pages.flat();
		const entry = (vals: Record<string, FormValue>) => storageEntries(all, vals).map(([, v]) => v.value);
		expect(entry({ name: 'X' })).toEqual(['X']);
		expect(entry({ name: 'Ada Lovelace', agree: true, color: 'green', country: ['ca'] })).toEqual([]);
		expect(entry({ name: true, agree: 'yes', color: ['red'], country: 'us' })).toEqual([]);
		expect(entry({ agree: false })).toEqual([false]);
		expect(entry({ color: 'red' })).toEqual([true, false]); // red on, green off, blue unchanged
		expect(entry({ country: ['us'] })).toEqual(['us']);
		expect(entry({ country: [] })).toEqual(['']);
		expect(entry({ ro: 'Changed', langs: ['French'] })).toEqual([]);
	}, T);
});

describe('Renderer with formValues', () => {
	it('no answers, or answers that change nothing shown, render exactly as before', async () => {
		const r = renderer();
		const base = await shot(r, kinds, 0);
		expect(renderCalls).toEqual([undefined]);
		const fresh = renderer();
		const cases: (Record<string, FormValue> | undefined)[] = [
			undefined,
			{},
			{ 'person.first': 'Grace' }, // a field on page 2 only
			{ ro: 'Changed', langs: ['French'], pw: 'secret', nosuch: 'x' }, // read-only, unlisted, unknown
			{ name: 'Ada Lovelace', agree: true, color: 'green', size: '' } // as stored
		];
		for (const values of cases) {
			same(await shot(fresh, kinds, 0, values), base);
		}
		// All of those shared one cache entry with plain annotation mode.
		expect(renderCalls).toEqual([undefined, undefined]);
	}, T);

	it('a text answer changes pixels inside its widget and nowhere else', async () => {
		const r = renderer();
		const base = await shot(r, kinds, 0);
		const filled = await shot(r, kinds, 0, { name: 'Grace Hopper' });
		const d = diff(base, filled, boxes('name', 0));
		expect(d.inside).toBeGreaterThan(50);
		expect(d.outside).toBe(0);
		// An empty field gets ink.
		const notes = await shot(r, kinds, 0, { notes: 'line one\nline two' });
		expect(ink(base, boxes('notes', 0)[0]).count).toBe(0);
		expect(ink(notes, boxes('notes', 0)[0]).count).toBeGreaterThan(30);
		expect(diff(base, notes, boxes('notes', 0)).outside).toBe(0);
	}, T);

	it('checkboxes: on and off', async () => {
		const r = renderer();
		const base = await shot(r, kinds, 0);
		const [agree] = boxes('agree', 0);
		const [optIn] = boxes('opt_in', 0);
		expect(ink(base, agree).count).toBeGreaterThan(5);
		expect(ink(base, optIn).count).toBe(0);
		const flipped = await shot(r, kinds, 0, { agree: false, opt_in: true });
		expect(ink(flipped, agree).count).toBe(0);
		expect(ink(flipped, optIn).count).toBeGreaterThan(5);
		expect(diff(base, flipped, [agree, optIn]).outside).toBe(0);
	}, T);

	it('radio: the chosen option is on, the others off, across pages', async () => {
		const r = renderer();
		const base = await shot(r, kinds, 0);
		const [red] = boxes('color', 0, 'red');
		const [green] = boxes('color', 0, 'green');
		const [blue] = boxes('color', 0, 'blue');
		const on = ink(base, green).count;
		const off = ink(base, red).count;
		expect(on).toBeGreaterThan(off + 10);
		const redShot = await shot(r, kinds, 0, { color: 'red' });
		expect(Math.abs(ink(redShot, red).count - on)).toBeLessThanOrEqual(6); // anti-aliasing differs a little per position
		expect(Math.abs(ink(redShot, green).count - off)).toBeLessThanOrEqual(6); // anti-aliasing differs a little per position
		// Blue (and everything else) untouched.
		expect(diff(base, redShot, [red, green]).outside).toBe(0);
		// 'size' has S and M on page 1, L on page 2.
		const base2 = await shot(r, kinds, 1);
		const [large] = boxes('size', 1, 'L');
		const big = await shot(r, kinds, 1, { size: 'L' });
		expect(ink(big, large).count).toBeGreaterThan(ink(base2, large).count + 10);
		expect(diff(base2, big, [large]).outside).toBe(0);
		renderCalls.length = 0;
		same(await shot(r, kinds, 0, { size: 'L' }), base); // S and M stay off: same entry as plain
		expect(renderCalls).toEqual([]);
	}, T);

	it('dropdown: shows the chosen option’s label', async () => {
		const r = renderer();
		const base = await shot(r, kinds, 1); // "Canada"
		const [box] = boxes('country', 1);
		const us = await shot(r, kinds, 1, { country: ['us'] }); // "United States"
		expect(diff(base, us, [box]).outside).toBe(0);
		expect(ink(us, box).maxX).toBeGreaterThan(ink(base, box).maxX + 10);
		const none = await shot(r, kinds, 1, { country: [] });
		expect(ink(none, box).count).toBe(0);
	}, T);

	it('a changed answer re-renders only the pages that show its field', async () => {
		const r = renderer();
		const v1 = { name: 'A', 'person.first': 'B' };
		await shot(r, kinds, 0, v1);
		await shot(r, kinds, 1, v1);
		expect(renderCalls.length).toBe(2);
		renderCalls.length = 0;
		// Page 2 field changed: page 1 is a cache hit.
		const v2 = { ...v1, 'person.first': 'C' };
		await shot(r, kinds, 0, v2);
		expect(renderCalls.length).toBe(0);
		await shot(r, kinds, 1, v2);
		expect(renderCalls.length).toBe(1);
		// Page 1 field changed: page 2 is a cache hit.
		renderCalls.length = 0;
		const v3 = { ...v2, name: 'D' };
		await shot(r, kinds, 1, v3);
		expect(renderCalls.length).toBe(0);
		await shot(r, kinds, 0, v3);
		expect(renderCalls.length).toBe(1);
		// Going back to earlier answers hits the cache.
		renderCalls.length = 0;
		await shot(r, kinds, 0, v1);
		expect(renderCalls.length).toBe(0);
		// release() drops the cached widgets and bitmaps.
		r.release(kinds.id);
		await shot(r, kinds, 0, v1);
		expect(renderCalls.length).toBe(1);
	}, T);

	it('concurrent renders with different answers do not bleed into each other', async () => {
		const answers: Record<string, FormValue>[] = [
			{ name: 'AAAA', agree: false },
			{ name: 'WWWWWWWWWW', color: 'blue' },
			{ notes: 'xyz', opt_in: true },
			{ name: 'Mm', zip: '80202' },
			{}
		];
		const want: Shot[] = [];
		for (const a of answers) want.push(await shot(renderer(1), kinds, 0, a));
		const r = renderer(4);
		const jobs = [...answers, ...answers, ...answers].map((a, i) => ({ i: i % answers.length, p: shot(r, kinds, 0, a) }));
		// Interleave with the other page too, which uses the same document storage.
		const other = shot(r, kinds, 1, { country: ['us'], 'person.last': 'Q' });
		for (const j of jobs) same(await j.p, want[j.i]);
		await other;
		// Each distinct answer set rendered once (later copies waited for the cache).
		expect(renderCalls.filter((m) => m !== undefined).length).toBeGreaterThanOrEqual(answers.length - 1);
	}, T);

	it('rotated page with an offset CropBox: answers land in the engine’s widget boxes', async () => {
		const geo = await openCorpus('forms-geometry.pdf');
		const gf = await engine().formFields(geo);
		const r = renderer();
		for (let page = 0; page < geo.pages.length; page++) {
			const here = gf.filter((f) => f.widgets.some((w) => w.pageIndex === page));
			const text = here.find((f) => f.kind === 'text')!;
			const check = here.find((f) => f.kind === 'checkbox')!;
			const base = await shot(r, geo, page);
			const filled = await shot(r, geo, page, { [text.name]: 'Hello', [check.name]: !check.value });
			const tb = text.widgets.find((w) => w.pageIndex === page)!.box;
			const cb = check.widgets.find((w) => w.pageIndex === page)!.box;
			expect(diff(base, filled, [tb]).inside, `page ${page} text`).toBeGreaterThan(20);
			expect(diff(base, filled, [cb]).inside, `page ${page} check`).toBeGreaterThan(5);
			expect(diff(base, filled, [tb, cb]).outside, `page ${page}`).toBe(0);
		}
	}, T);

	it('drawing answers loads only bundled PDF.js assets and never fetches', async () => {
		assetLoads.length = 0;
		const src = await openCorpus('form.pdf');
		await shot(renderer(), src, 0, { name: 'Ünïcödé façade 123' });
		expect(offOrigin).toEqual([]);
		// Every asset is one the browser loader bundles (pdfjs-loader.ts globs these folders).
		for (const a of assetLoads) {
			expect(fs.existsSync(path.join(pdfjsDir, dirs[a.kind as keyof typeof dirs], a.filename)), a.filename).toBe(true);
			if (a.kind === 'standardFontDataUrl') expect(a.filename).toMatch(/\.(pfb|ttf)$/);
		}
	}, T);
});
