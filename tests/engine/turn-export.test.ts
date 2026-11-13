/**
 * Marks turn with their page, end to end: stamps placed on an upright page are carried
 * through DocStore.rotatePages and exported. A redaction still removes the same text;
 * visible marks land where the turned page shows them.
 */
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { Asset, Rotation, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { createDocStore } from '../../src/lib/doc/store';
import { mupdf } from '../../src/lib/engine/mupdf';
import { defaultOptions, engine, manifest, openCorpus, pageTexts } from './helpers';
import { makeSource, render, type Raster } from './render-helpers';

const T = 120_000;
type UserRect = [number, number, number, number];

function solidPng(w: number, h: number, rows: (x: number, y: number) => [number, number, number]): Uint8Array {
	const crcTable = new Uint32Array(256).map((_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2;
	const raw = Buffer.alloc((w * 3 + 1) * h);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) raw.set(rows(x, y), y * (w * 3 + 1) + 1 + x * 3);
	return new Uint8Array(
		Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
	);
}

/** Left half red, right half blue: a picture that shows which way it is turned. */
const flag: Asset = { id: 'flag', kind: 'image', png: solidPng(40, 20, (x) => (x < 20 ? [255, 0, 0] : [0, 0, 255])), width: 40, height: 20 };

/** Page 0 of `source` turned `quarters` times, with `stamps` placed first; returns the plan page. */
type NoId<T> = T extends unknown ? Omit<T, 'id'> : never;

function turned(source: Source, stamps: NoId<Stamp>[], deg: number, assets: Asset[] = []) {
	const store = createDocStore();
	store.addSource(source);
	for (const a of assets) store.addAsset(a);
	const [page] = store.state.pages;
	stamps.forEach((s, i) => store.addStamp(page.id, { ...s, id: `s${i}` } as Stamp));
	if (deg) store.rotatePages([page.id], deg);
	return store.toExportPlan(defaultOptions, [page.id]);
}

async function mupdfText(bytes: Uint8Array): Promise<string> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	try {
		return doc.loadPage(0).toStructuredText('preserve-whitespace').asText();
	} finally {
		doc.destroy();
	}
}

function frac([x0, y0, x1, y1]: UserRect, w = 612, h = 792): StampBox {
	return { x: x0 / w, y: (h - y1) / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}

describe('a redaction placed before a rotation still removes what it covered', () => {
	interface BasicMeta {
		boxes: Record<string, { rect: UserRect; hides: string[] }>;
		keep: string[];
		metadataSecrets: string[];
		pageSecrets: string[];
	}
	const basic = manifest['redact-basic.pdf'] as unknown as BasicMeta;
	for (const deg of [90, 180, 270, 360]) {
		it(`turned ${deg}°: the secrets are gone from the text, the rest stays`, async () => {
			const src = await openCorpus('redact-basic.pdf');
			const stamps = Object.values(basic.boxes).map((b) => ({ kind: 'redact' as const, box: frac(b.rect) }));
			const plan = turned(src, stamps, deg);
			const res = await engine().exportPlan(plan, [src], []);
			expect(res.checks.find((c) => c.name === 'redaction')!.ok).toBe(true);
			const [pdfjsText] = await pageTexts(res.bytes);
			const muText = await mupdfText(res.bytes);
			for (const s of [...Object.values(basic.boxes).flatMap((b) => b.hides), ...basic.pageSecrets]) {
				expect(pdfjsText, s).not.toContain(s);
				expect(muText, s).not.toContain(s);
			}
			for (const k of basic.keep) {
				expect(pdfjsText, k).toContain(k);
				expect(muText, k).toContain(k);
			}
		}, T);
	}
});

/** A raster turned a quarter clockwise (the page as the viewer sees it after "Rotate right"). */
function turnedRaster(r: Raster, quarters: number): Raster {
	let cur = r;
	for (let q = 0; q < quarters; q++) {
		const w = cur.h;
		const h = cur.w;
		const px = new Uint8ClampedArray(w * h * 3);
		for (let y = 0; y < cur.h; y++)
			for (let x = 0; x < cur.w; x++) {
				const nx = cur.h - 1 - y;
				const ny = x;
				const o = (y * cur.w + x) * 3;
				px.set(cur.px.subarray(o, o + 3), (ny * w + nx) * 3);
			}
		const src = cur;
		cur = { w, h, px, at: src.at };
	}
	return cur;
}

describe('visible marks turn with the page', () => {
	const MARKS: NoId<Stamp>[] = [
		{ kind: 'highlight', color: 'yellow', box: { x: 0.12, y: 0.1, w: 0.4, h: 0.06 } },
		{ kind: 'highlight', color: 'pink', box: { x: 0.2, y: 0.22, w: 0.3, h: 0.1 }, pen: { width: 0.012, points: [{ x: 0.2, y: 0.22 }, { x: 0.5, y: 0.32 }] } },
		{ kind: 'image', assetId: 'flag', box: { x: 0.55, y: 0.1, w: 0.3, h: 0.08 } },
		{ kind: 'text', text: 'Turned text', x: 0.1, y: 0.7, size: 0.05, color: 'blue' },
		{ kind: 'mark', mark: 'check', box: { x: 0.6, y: 0.8, w: 0.12, h: 0.09 } },
		{ kind: 'mark', mark: 'cross', box: { x: 0.8, y: 0.85, w: 0.1, h: 0.075 } }
	];

	for (const quarters of [1, 2, 3]) {
		it(`the export of a page turned ${quarters * 90}° equals the upright export turned`, async () => {
			const src = await makeSource([{ w: 300, h: 400 }]);
			const upright = await engine().exportPlan(turned(src, MARKS, 0, [flag]), [src], [flag]);
			const rotated = await engine().exportPlan(turned(src, MARKS, quarters * 90, [flag]), [src], [flag]);
			const a = turnedRaster(await render(upright.bytes, 0, 2), quarters);
			const b = await render(rotated.bytes, 0, 2);
			expect([b.w, b.h]).toEqual([a.w, a.h]);
			// Anti-aliasing differs by a pixel at the edges; count pixels that differ clearly.
			let bad = 0;
			let ink = 0;
			for (let i = 0; i < a.px.length; i += 3) {
				const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
				if (a.px[i] < 250 || a.px[i + 1] < 250 || a.px[i + 2] < 250) ink++;
				if (d > 90) bad++;
			}
			expect(ink).toBeGreaterThan(5000);
			expect(bad / ink).toBeLessThan(0.02);
		}, T);
	}

	it('the picture is turned the right way (red half on the left becomes the top at 90°)', async () => {
		const src = await makeSource([{ w: 300, h: 400 }]);
		const plan = turned(src, [{ kind: 'image', assetId: 'flag', box: { x: 0.2, y: 0.1, w: 0.4, h: 0.1 } }], 90, [flag]);
		const res = await engine().exportPlan(plan, [src], [flag]);
		const r = await render(res.bytes, 0, 2);
		// Upright: box x 0.2-0.6, y 0.1-0.2 of 300 x 400; turned 90 cw on a 400 x 300 page: x 0.8-0.9, y 0.2-0.6.
		const [top] = [r.at(0.85, 0.25)];
		const [bottom] = [r.at(0.85, 0.55)];
		expect(top[0]).toBeGreaterThan(200);
		expect(top[2]).toBeLessThan(60);
		expect(bottom[2]).toBeGreaterThan(200);
		expect(bottom[0]).toBeLessThan(60);
	}, T);

	it('rotation 0 is untouched: a mark stays at its fraction', async () => {
		const src = await makeSource([{ w: 300, h: 400 }]);
		const plan = turned(src, [{ kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.1, w: 0.3, h: 0.1 } }], 0);
		const res = await engine().exportPlan(plan, [src], []);
		const r = await render(res.bytes, 0, 1);
		expect(r.at(0.25, 0.15)[2]).toBeLessThan(120);
		expect(r.at(0.7, 0.15)).toEqual([255, 255, 255]);
	}, T);
});
void ({} as Rotation);
