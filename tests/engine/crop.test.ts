/**
 * Crop (PageRef.crop) through exportPlan with the real engines. Independent checks: each
 * cropped page, rendered by MuPDF, equals the same part of the same page exported without
 * a crop; the raw boxes (pdf-lib) are inside the MediaBox and Trim/Bleed/ArtBox are cut
 * back; PDF.js reads page numbers, the watermark and redaction inside the visible part.
 */
import { describe, expect, it } from 'vitest';
import * as PdfLib from '@cantoo/pdf-lib';
import type { ExportOptions, PageRef, Rotation, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { applyCrops, croppedSize, verifyCrops } from '../../src/lib/engine/crop';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { defaultOptions, engine, loadPdfjs, manifest, nodeAssets, openCorpus, ref } from './helpers';
import { makeSource, render, type Raster } from './render-helpers';

const T = 180_000;
const C: StampBox = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };

function withCrop(r: PageRef, crop: StampBox | undefined): PageRef {
	return crop ? { ...r, crop } : r;
}

async function exportOk(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}) {
	const res = await engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, []);
	for (const c of res.checks) expect(c.ok, `${c.name}: ${c.detail}`).toBe(true);
	return res;
}

/** Share of pixels of `cropped` that differ from the part `c` of `full` (more than a pixel away). */
function differs(cropped: Raster, full: Raster, c: StampBox): number {
	let bad = 0;
	let n = 0;
	for (let y = 2; y < cropped.h - 2; y += 2) {
		for (let x = 2; x < cropped.w - 2; x += 2) {
			const fx = c.x + (x / cropped.w) * c.w;
			const fy = c.y + (y / cropped.h) * c.h;
			const a = cropped.at(x / cropped.w, y / cropped.h);
			n++;
			// Within a pixel of the same place (rounding of the two renders' grids).
			let near = false;
			for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) if (Math.abs(a[0] - full.at(fx + dx / full.w, fy + dy / full.h)[0]) <= 60) near = true;
			if (!near) bad++;
		}
	}
	return bad / n;
}

/** The cropped page's render equals the crop's part of the uncropped page's render (within anti-aliasing). */
function sameAsPart(cropped: Raster, full: Raster, c: StampBox, label: string) {
	expect(cropped.w / full.w, `${label} width`).toBeCloseTo(c.w, 1);
	expect(cropped.h / full.h, `${label} height`).toBeCloseTo(c.h, 1);
	const d = differs(cropped, full, c);
	expect(d, `${label}: pixels that differ`).toBeLessThan(0.02);
	// Control: a part 5% off differs clearly more, so the comparison can tell them apart.
	const off = differs(cropped, full, { ...c, x: c.x + 0.05, y: c.y - 0.05 });
	expect(off, `${label}: control`).toBeGreaterThan(Math.max(0.015, 3 * d));
}

describe('crop in exports', () => {
	it('every /Rotate × every app rotation: shows exactly the chosen part as displayed', async () => {
		const specs = [0, 90, 180, 270].map((rotate) => ({ w: 612, h: 792, rotate }));
		const src = await makeSource(specs);
		const plain: PageRef[] = [];
		for (let i = 0; i < 4; i++) for (const r of [0, 90, 180, 270] as Rotation[]) plain.push(ref(src, i, r));
		const full = await exportOk(plain, [src]);
		const res = await exportOk(plain.map((p) => withCrop(p, C)), [src]);
		expect(res.checks.find((c) => c.name === 'crop')?.ok).toBe(true);
		for (let k = 0; k < plain.length; k++) sameAsPart(await render(res.bytes, k, 0.5), await render(full.bytes, k, 0.5), C, `page ${k + 1}`);
	}, T);

	it('odd boxes: inherited non-zero-origin MediaBox and /Rotate, a CropBox past the MediaBox with UserUnit, indirect boxes', async () => {
		const src = await openCorpus('crop-odd.pdf');
		const meta = manifest['crop-odd.pdf'] as { visible: number[][]; userUnit: number[] };
		const crops: StampBox[] = [C, { x: 0.3, y: 0.05, w: 0.4, h: 0.9 }, { x: 0, y: 0.5, w: 1, h: 0.5 }];
		const plain = [0, 1, 2].map((i) => ref(src, i));
		const full = await exportOk(plain, [src]);
		const res = await exportOk(plain.map((p, i) => withCrop(p, crops[i])), [src]);
		for (let k = 0; k < 3; k++) {
			sameAsPart(await render(res.bytes, k, 0.5), await render(full.bytes, k, 0.5), crops[k], `page ${k + 1}`);
			const want = croppedSize({ width: src.pages[k].width, height: src.pages[k].height }, crops[k]);
			expect(want.width).toBeGreaterThan(0);
		}
		// Raw boxes: CropBox inside MediaBox; Trim, Bleed and Art boxes inside the crop.
		const doc = await PdfLib.PDFDocument.load(res.bytes, { updateMetadata: false });
		const page = doc.getPages()[0];
		const crop = page.getCropBox();
		const media = page.getMediaBox();
		expect(crop.x).toBeGreaterThanOrEqual(media.x);
		expect(crop.y).toBeGreaterThanOrEqual(media.y);
		expect(crop.x + crop.width).toBeLessThanOrEqual(media.x + media.width + 1e-6);
		expect(crop.y + crop.height).toBeLessThanOrEqual(media.y + media.height + 1e-6);
		expect(media).toEqual({ x: -100, y: -50, width: 612, height: 792 });
		for (const b of [page.getTrimBox(), page.getBleedBox(), page.getArtBox()]) {
			expect(b.x).toBeGreaterThanOrEqual(crop.x - 1e-6);
			expect(b.y).toBeGreaterThanOrEqual(crop.y - 1e-6);
			expect(b.x + b.width).toBeLessThanOrEqual(crop.x + crop.width + 1e-6);
			expect(b.y + b.height).toBeLessThanOrEqual(crop.y + crop.height + 1e-6);
		}
		// The ArtBox missed the crop: it is now the crop itself.
		expect(page.getArtBox()).toEqual(crop);
		// UserUnit stays; the page comes out at the planned size in points.
		expect(meta.userUnit[1]).toBe(2);
		expect((doc.getPages()[1].node.lookup(PdfLib.PDFName.of('UserUnit')) as PdfLib.PDFNumber).asNumber()).toBe(2);
	}, T);

	it('mixed page sizes get the same relative box; Optimize and a password', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 2000, h: 300 }, { w: 300, h: 300, userUnit: 3 }, { w: 400, h: 900, crop: [50, 60, 350, 800] }]);
		const plain = [0, 1, 2, 3].map((i) => ref(src, i));
		const full = await exportOk(plain, [src]);
		const res = await exportOk(plain.map((p) => withCrop(p, C)), [src], { compress: true, password: 'pw' });
		expect(res.checks.find((c) => c.name === 'crop')?.ok).toBe(true);
		for (let k = 0; k < 4; k++) sameAsPart(await render(res.bytes, k, 0.5, 'pw'), await render(full.bytes, k, 0.5), C, `page ${k + 1}`);
	}, T);

	it('page numbers, watermark, stamps and redaction are placed in the cropped page', async () => {
		const src = await makeSource([{ w: 612, h: 792 }]);
		// makeSource's black bar runs across 0.1–0.9 of the width at 0.54–0.6 of the height
		// (from the top). In the crop below that is y 0.6–0.73 of the visible part.
		const crop: StampBox = { x: 0.05, y: 0.3, w: 0.9, h: 0.45 };
		const box: StampBox = { x: 0.2, y: 0.1, w: 0.3, h: 0.2 };
		const stamps: Stamp[] = [
			{ id: 'r', kind: 'redact', box },
			{ id: 'm', kind: 'mark', mark: 'dot', box: { x: 0.8, y: 0.05, w: 0.1, h: 0.2 } }
		];
		const res = await exportOk([{ ...ref(src, 0, 0, stamps), crop }], [src], {
			numbering: { style: 'page-n-of-total', position: 'bottom-right', start: 1, skip: 0, size: 10 },
			watermark: { text: 'DRAFT', look: 'diagonal', strength: 'medium', color: 'grey' }
		});
		for (const name of ['crop', 'redaction', 'numbering', 'watermark', 'page-sizes']) expect(res.checks.find((c) => c.name === name)?.ok, name).toBe(true);
		const r = await render(res.bytes, 0, 1);
		expect(r.w).toBeCloseTo(612 * 0.9, -1);
		// The redaction box and the dot are black where the plan put them on the cropped page.
		expect(Math.max(...r.at(box.x + box.w / 2, box.y + box.h / 2))).toBeLessThanOrEqual(40);
		expect(Math.max(...r.at(0.85, 0.15))).toBeLessThanOrEqual(40);
		// The number sits inside the visible part, 0.5 in from its bottom-right corner (PDF.js).
		const lib = await loadPdfjs();
		const task = lib.getDocument({ data: res.bytes.slice(), verbosity: 0, useWasm: false });
		const doc = await task.promise;
		const page = await doc.getPage(1);
		const vp = page.getViewport({ scale: 1 });
		const items = (await page.getTextContent()).items.filter((i) => 'str' in i && i.str.includes('Page 1 of 1'));
		expect(items).toHaveLength(1);
		const [x, y] = vp.convertToViewportPoint((items[0] as { transform: number[] }).transform[4], (items[0] as { transform: number[] }).transform[5]) as number[];
		expect(vp.height - y).toBeCloseTo(36, 0);
		expect(x).toBeGreaterThan(0);
		expect(x).toBeLessThan(vp.width);
		await task.destroy();
	}, T);

	it('keeps accessibility tags; hides content outside, does not remove it', async () => {
		const src = await openCorpus('tags-basic.pdf');
		const pages = src.pages.map((_, i) => ref(src, i));
		const plain = await exportOk(pages, [src]);
		const res = await exportOk(pages.map((p) => ({ ...p, crop: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } })), [src]);
		expect(res.tags).toEqual({ kept: true });
		// Every page's content is byte for byte what the uncropped export has.
		const contents = async (bytes: Uint8Array) => {
			const doc = await PdfLib.PDFDocument.load(bytes, { updateMetadata: false });
			return doc.getPages().map((page) => {
				const c = page.node.lookup(PdfLib.PDFName.of('Contents'));
				const list = c instanceof PdfLib.PDFArray ? c.asArray() : [page.node.get(PdfLib.PDFName.of('Contents'))];
				return list.map((r) => Buffer.from(PdfLib.decodePDFRawStream(doc.context.lookup(r) as PdfLib.PDFRawStream).decode()).toString('latin1')).join('\n');
			});
		};
		const a = await contents(plain.bytes);
		expect(a.join('').length).toBeGreaterThan(100);
		expect(await contents(res.bytes)).toEqual(a);
	}, T);

	it('the check: a file without the crop or with another one fails; bad crops are refused', async () => {
		const src = await makeSource([{ w: 612, h: 792 }, { w: 612, h: 792 }]);
		const deps = { pdfjs: loadPdfjs } as unknown as EngineDeps;
		const qpdf = new Qpdf(nodeAssets().qpdf);
		const pages = [{ ...ref(src, 0), crop: C }, ref(src, 1)];
		const plain = await exportOk([ref(src, 0), ref(src, 1)], [src]);
		const { rects } = await applyCrops(qpdf, plain.bytes, pages);
		expect(rects[1]).toBeNull();
		expect((await verifyCrops(deps, plain.bytes, rects)).ok).toBe(false);
		const other = await exportOk([{ ...ref(src, 0), crop: { ...C, x: 0.11 } }, ref(src, 1)], [src]);
		expect((await verifyCrops(deps, other.bytes, rects)).ok).toBe(false);
		const right = await exportOk(pages, [src]);
		expect((await verifyCrops(deps, right.bytes, rects)).ok).toBe(true);
		for (const bad of [{ x: 0, y: 0, w: 0.01, h: 1 }, { x: 0.5, y: 0, w: 0.6, h: 1 }, { x: Number.NaN, y: 0, w: 1, h: 1 }]) {
			const e = await engine()
				.exportPlan({ pages: [{ ...ref(src, 0), crop: bad }], options: defaultOptions }, [src], [])
				.then(() => null, (x) => x as { code: string });
			expect(e?.code).toBe('internal');
		}
	}, T);
});
