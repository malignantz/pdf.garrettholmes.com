/**
 * "Make scanned pages black and white" through the real engine (ExportOptions.bilevel;
 * engine/bilevel-stage.ts). Corpus: tests/corpus/generate-bilevel.mjs (bilevel-mixed.pdf:
 * p1 a typed letter that converts, p2 the letter with a red stamp, p3 with a pencil
 * scribble, p4 born-digital).
 */
import { describe, expect, it } from 'vitest';
import type * as MU from 'mupdf';
import type { ExportOptions, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createCoreEngine } from '../../src/lib/engine/core';
import { mupdf } from '../../src/lib/engine/mupdf';
import { pageTextOf } from '../../src/lib/engine/page-text';
import { corpus, engine, manifest, nodeAssets, pageTexts } from './helpers';
import { nodeOcr } from './ocr-node';

const T = 120_000;
const meta = manifest['bilevel-mixed.pdf'] as { eligible: number[]; converted: number[]; left: number[] };
const base: ExportOptions = { filename: 'bw.pdf', compress: true, stripMetadata: false, printCap: true };

const pagesOf = (src: Source, stamps: (i: number) => Stamp[] = () => []): PageRef[] =>
	src.pages.map((_, i) => ({ id: `p${i}`, sourceId: src.id, pageIndex: i, rotation: 0, stamps: stamps(i) }));

/** Each page's image XObjects: [width, height, bpc, filter, raw stream length]. */
async function images(bytes: Uint8Array, password?: string): Promise<[number, number, number, string, number][][]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	if (password) doc.authenticatePassword(password);
	try {
		const out: [number, number, number, string, number][][] = [];
		for (let p = 0; p < doc.countPages(); p++) {
			const list: [number, number, number, string, number][] = [];
			const xo = doc.findPage(p).getInheritable('Resources').get('XObject');
			if (xo.isDictionary())
				xo.forEach((v: MU.PDFObject) => {
					if (!v.isStream() || v.get('Subtype').asName() !== 'Image') return;
					const f = v.get('Filter');
					list.push([v.get('Width').asNumber(), v.get('Height').asNumber(), v.get('BitsPerComponent').asNumber(), f.isName() ? f.asName() : String(f), v.readRawStream().getLength()]);
				});
			out.push(list);
		}
		return out;
	} finally {
		doc.destroy();
	}
}

describe('black and white scans: engine', () => {
	it('offers the scanned pages and previews only a page that converts', { timeout: T }, async () => {
		const e = engine();
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		expect(await e.bilevelPages(src)).toEqual(meta.eligible);
		expect(await e.bilevelPages({ ...src, kind: 'image' })).toEqual([]);
		const p = await e.bilevelPreview(src, 0);
		expect(p).not.toBeNull();
		expect([p!.width, p!.height]).toEqual([300, 150]);
		for (const png of [p!.before, p!.after]) expect([...png.slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
		expect(await e.bilevelPreview(src, 1)).toBeNull(); // colour
		expect(await e.bilevelPreview(src, 2)).toBeNull(); // faint mark
		expect(await e.bilevelPreview(src, 3)).toBeNull(); // not a scan
	});

	it('converts the black-on-white page, leaves the others exactly as they were, and checks the final file', { timeout: T }, async () => {
		const e = engine();
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const pages = pagesOf(src);
		const plain = await e.exportPlan({ pages, options: base }, [src], []);
		const bw = await e.exportPlan({ pages, options: { ...base, bilevel: true } }, [src], []);
		expect(bw.bilevel).toEqual({ eligible: 3, converted: meta.converted.map((i) => i + 1), left: meta.left.map((i) => i + 1) });
		expect(bw.checks.every((c) => c.ok)).toBe(true);
		expect(bw.checks.find((c) => c.name === 'bilevel')?.detail).toMatch(/1 page made black and white.*two independent decoders/);
		expect(bw.bytes.length).toBeLessThan(plain.bytes.length * 0.7);
		const [a, b] = [await images(plain.bytes), await images(bw.bytes)];
		expect(b[0]).toHaveLength(1);
		expect(b[0][0].slice(0, 4)).toEqual([a[0][0][0], a[0][0][1], 1, 'CCITTFaxDecode']);
		expect(b[0][0][4]).toBeLessThan(a[0][0][4] / 5);
		// Left pages: the same picture stream as without the option.
		expect(b[1]).toEqual(a[1]);
		expect(b[2]).toEqual(a[2]);
		expect(b[3]).toEqual([]);
		// The born-digital page keeps its text.
		expect((await pageTexts(bw.bytes))[3]).toContain('Dear Sir');
	});

	it('works with a password, page numbers, a watermark, a crop and fit under a size', { timeout: T }, async () => {
		const e = engine();
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const pages = pagesOf(src);
		pages[0] = { ...pages[0], crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } };
		const res = await e.exportPlan(
			{
				pages,
				options: {
					...base,
					bilevel: true,
					password: 'pw-1234',
					numbering: { style: 'page-n-of-total', position: 'bottom-center', start: 1, skip: 0, size: 10 },
					watermark: { text: 'DRAFT', look: 'diagonal', strength: 'light', color: 'grey' },
					targetBytes: 150_000
				}
			},
			[src],
			[]
		);
		expect(res.checks.filter((c) => !c.ok)).toEqual([]);
		expect(res.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['bilevel', 'numbering', 'watermark', 'crop', 'encryption', 'target-size']));
		expect(res.bilevel?.converted).toEqual([1]);
		expect((await images(res.bytes, 'pw-1234'))[0][0][2]).toBe(1);
	});

	it('leaves a page with a redaction box as it was', { timeout: T }, async () => {
		const e = engine();
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const redact: Stamp = { id: 'r', kind: 'redact', box: { x: 0.6, y: 0.8, w: 0.2, h: 0.1 } };
		const res = await e.exportPlan({ pages: pagesOf(src, (i) => (i === 0 ? [redact] : [])), options: { ...base, bilevel: true } }, [src], []);
		expect(res.bilevel).toEqual({ eligible: 3, converted: [], left: [1, 2, 3] });
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.checks.some((c) => c.name === 'bilevel')).toBe(false);
	});

	it('builds again with the page left as it was when the final check fails', { timeout: T }, async () => {
		const notes: string[] = [];
		const e = createCoreEngine(nodeAssets(), { bilevelSpoil: (i) => i === 0, debug: (n) => notes.push(n) });
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const res = await e.exportPlan({ pages: pagesOf(src), options: { ...base, bilevel: true } }, [src], []);
		expect(res.bilevel).toEqual({ eligible: 3, converted: [], left: [1, 2, 3] });
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect((await images(res.bytes))[0][0][2]).toBe(8);
		expect(notes.some((n) => /bilevel: failed its check/.test(n))).toBe(true);
	});

	it('the same page used twice converts once and is checked on both', { timeout: T }, async () => {
		const e = engine();
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const p = pagesOf(src);
		const res = await e.exportPlan({ pages: [p[0], { ...p[0], id: 'again' }, p[1]], options: { ...base, bilevel: true } }, [src], []);
		expect(res.bilevel).toEqual({ eligible: 3, converted: [1, 2], left: [3] });
		expect(res.checks.every((c) => c.ok)).toBe(true);
	});

	it('with OCR: the text is read from the original picture and still lines up after the conversion', { timeout: 240_000 }, async () => {
		const e = createCoreEngine({ ...nodeAssets(), ocr: nodeOcr({ slots: 1 }) });
		const src = await e.openPdf(corpus('bilevel-mixed.pdf'), 'bilevel-mixed.pdf');
		const pages = pagesOf(src).slice(0, 1);
		const res = await e.exportPlan({ pages, options: { ...base, bilevel: true, ocr: true } }, [src], [], {});
		expect(res.ocr?.searchable).toEqual([1]);
		expect(res.bilevel?.converted).toEqual([1]);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect((await images(res.bytes))[0][0][2]).toBe(1);
		// Words sit where the letter was drawn: "Dear" near the top left, "Smith" on the last line.
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		try {
			const words = pageTextOf(doc, 0).words;
			const dear = words.find((w) => w.text === 'Dear');
			const smith = words.find((w) => /^Smith/.test(w.text));
			expect(dear && dear.box.x < 0.15 && dear.box.y < 0.2).toBe(true);
			expect(smith && smith.box.y > 0.6 && smith.box.y < 0.8).toBe(true);
		} finally {
			doc.destroy();
		}
	});
});
