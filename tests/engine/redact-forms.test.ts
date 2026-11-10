/**
 * Redaction together with typed form answers (ExportPlan.formValues).
 *
 * A redact stamp forces forms to be flattened first (the answers become page
 * content), then the box is applied. These tests look for the answer everywhere a
 * leak could hide: the expanded file bytes in several spellings, the text each
 * engine extracts, and leftovers of the form (/V, /DV, /AP, /XFA, widgets, fields).
 */
import { describe, expect, it } from 'vitest';
import type { PageRef, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { visibleBox, type Box } from '../../src/lib/engine/geometry';
import { widgetBox } from '../../src/lib/engine/forms';
import { corpus, defaultOptions, engine, manifest, nodeAssets, openCorpus, pageTexts, ref } from './helpers';

const T = 120_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

type UserRect = [number, number, number, number];
function frac([x0, y0, x1, y1]: UserRect, w = 612, h = 792): StampBox {
	return { x: x0 / w, y: (h - y1) / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}
let sid = 0;
const redact = (r: UserRect): Stamp => ({ id: `rf${sid++}`, kind: 'redact', box: frac(r) });

function run(pages: PageRef[], sources: Source[], formValues: Record<string, Record<string, string | boolean | string[]>>) {
	return engine().exportPlan({ pages, options: { ...defaultOptions }, formValues }, sources, []);
}

async function expanded(bytes: Uint8Array): Promise<Buffer> {
	const res = await qpdf.run({
		args: ['--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'],
		inputs: { '/i.pdf': bytes },
		outputs: ['/o.pdf']
	});
	const out = res.files.get('/o.pdf');
	if (!out) throw new Error(`qpdf failed: ${res.stderr}`);
	return Buffer.from(out);
}

/** The ways a string can be spelled in a PDF's bytes. */
function spellings(s: string): Buffer[] {
	const latin = Buffer.from(s, 'latin1');
	const be = Buffer.from(s, 'utf16le').swap16();
	const le = Buffer.from(s, 'utf16le');
	return [latin, Buffer.from(latin.toString('hex')), Buffer.from(latin.toString('hex').toUpperCase()), be, le, Buffer.from(be.toString('hex')), Buffer.from(be.toString('hex').toUpperCase())];
}
const findIn = (buf: Buffer, s: string) => spellings(s).some((sp) => buf.indexOf(sp) >= 0);

async function mupdfTexts(bytes: Uint8Array): Promise<string[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const out: string[] = [];
	for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).toStructuredText('preserve-whitespace').asText());
	return out;
}

async function pixmapBlack(bytes: Uint8Array, pageIndex: number, r: UserRect): Promise<number> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const scale = 2;
	const pix = doc.loadPage(pageIndex).toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
	const d = pix.getPixels();
	const stride = pix.getStride();
	const h = pix.getHeight();
	let n = 0;
	let k = 0;
	for (let y = Math.ceil((h / scale - r[3]) * scale) + 2; y < Math.floor((h / scale - r[1]) * scale) - 2; y++) {
		for (let x = Math.ceil(r[0] * scale) + 2; x < Math.floor(r[2] * scale) - 2; x++) {
			const o = y * stride + x * 3;
			n++;
			if (d[o] < 40 && d[o + 1] < 40 && d[o + 2] < 40) k++;
		}
	}
	return n ? k / n : 1;
}

/** Nothing of the form survives and none of the secrets is reachable. */
async function expectNoLeak(bytes: Uint8Array, secrets: string[], pages: number[] = []) {
	const raw = await expanded(bytes);
	for (const s of secrets) {
		expect(findIn(raw, s), `raw bytes contain ${s}`).toBe(false);
		for (const [i, t] of (await mupdfTexts(bytes)).entries()) if (pages.length === 0 || pages.includes(i)) expect(t, `mupdf p${i + 1} ${s}`).not.toContain(s);
		for (const [i, t] of (await pageTexts(bytes)).entries()) if (pages.length === 0 || pages.includes(i)) expect(t, `pdf.js p${i + 1} ${s}`).not.toContain(s);
	}
	const text = raw.toString('latin1');
	expect(text).not.toMatch(/\/AcroForm|\/XFA|\/Widget|\/FT\b|\/DV\b|\/AP\b|\/AS\b|\/Opt\b/);
	expect(text).not.toMatch(/\/V[ \/(<\[]/);
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	for (let i = 0; i < doc.countPages(); i++) expect(doc.loadPage(i).getWidgets()).toEqual([]);
}

async function kinds() {
	return openCorpus('forms-kinds.pdf');
}

describe('redaction with typed form answers', () => {
	it('a typed text answer under a box is unreachable; the original value and the form are gone too', async () => {
		const src = await kinds();
		const secret = 'ZEBRA-SECRET-7731';
		const res = await run([ref(src, 0, 0, [redact([70, 698, 276, 722])])], [src], { [src.id]: { name: secret } });
		expect(res.checks.filter((c) => !c.ok)).toEqual([]);
		await expectNoLeak(res.bytes, [secret, 'ZEBRA', 'Ada Lovelace', 'Lovelace']);
		expect(await pixmapBlack(res.bytes, 0, [72, 700, 272, 720])).toBe(1);
		// The page label outside the box is still there.
		expect((await pageTexts(res.bytes))[0]).toContain('kinds p1');
	}, T);

	it('two answers, one redacted: the other stays visible in the page text', async () => {
		const src = await kinds();
		const res = await run([ref(src, 0, 0, [redact([70, 698, 276, 722])])], [src], {
			[src.id]: { name: 'HIDDEN-ANSWER-1', zip: '80202' }
		});
		await expectNoLeak(res.bytes, ['HIDDEN-ANSWER-1']);
		const t = (await pageTexts(res.bytes))[0];
		expect(t).toContain('80202');
		expect((await mupdfTexts(res.bytes))[0]).toContain('80202');
	}, T);

	it('a dropdown answer (export value ca, label Canada) under a box, and its options, are gone', async () => {
		const src = await kinds();
		// country: combo on page 2 at (72, 620, 200x20). The listbox on that page stays and is flattened.
		const res = await run([ref(src, 1, 0, [redact([70, 618, 276, 642])])], [src], { [src.id]: { country: ['ca'], 'person.first': 'KEPT-FIRST-NAME' } });
		expect(res.checks.filter((c) => !c.ok)).toEqual([]);
		await expectNoLeak(res.bytes, ['Canada', 'United States']);
		expect(await pixmapBlack(res.bytes, 0, [72, 620, 272, 640])).toBe(1);
		expect((await pageTexts(res.bytes))[0]).toContain('KEPT-FIRST-NAME');
	}, T);

	it('a multiline answer under a box is gone line by line', async () => {
		const src = await kinds();
		const a = 'MULTI-SECRET-LINE-ONE';
		const b = 'MULTI-SECRET-LINE-TWO';
		const res = await run([ref(src, 0, 0, [redact([70, 598, 326, 684])])], [src], { [src.id]: { notes: `${a}\n${b}`, zip: '99999' } });
		await expectNoLeak(res.bytes, [a, b, 'MULTI-SECRET']);
		expect(await pixmapBlack(res.bytes, 0, [72, 600, 322, 680])).toBe(1);
		expect((await pageTexts(res.bytes))[0]).toContain('99999');
	}, T);

	it('a field with /DV (default value): neither /V nor /DV survives, typed or not', async () => {
		const src = await openCorpus('forms-dv.pdf');
		const meta = manifest['forms-dv.pdf'] as unknown as { rects: Record<string, UserRect> };
		const boxes = [redact([70, 598, 376, 628]), redact([70, 538, 376, 568])];
		expect(meta.rects.dvboth).toEqual([72, 600, 372, 624]);
		// Untouched: both /V and /DV are in the source.
		const none = await engine().exportPlan({ pages: [ref(src, 0, 0, boxes)], options: { ...defaultOptions } }, [src], []);
		await expectNoLeak(none.bytes, ['DEFAULT-SECRET-ONE', 'DEFAULT-SECRET-TWO', 'Current-Value-One']);
		// With a typed answer on the first field.
		const typed = await run([ref(src, 0, 0, [...boxes])], [src], { [src.id]: { dvboth: 'TYPED-OVER-DV', dvonly: 'TYPED-INTO-DVONLY' } });
		await expectNoLeak(typed.bytes, ['DEFAULT-SECRET-ONE', 'DEFAULT-SECRET-TWO', 'Current-Value-One', 'TYPED-OVER-DV', 'TYPED-INTO-DVONLY']);
		// Only one of the two boxed: the other keeps its flattened answer, but its /DV is gone as well.
		const one = await run([ref(src, 0, 0, [boxes[0]])], [src], { [src.id]: { dvboth: 'TYPED-OVER-DV', dvonly: 'SHOWN-ANSWER' } });
		await expectNoLeak(one.bytes, ['DEFAULT-SECRET-ONE', 'DEFAULT-SECRET-TWO', 'Current-Value-One', 'TYPED-OVER-DV']);
		expect((await pageTexts(one.bytes))[0]).toContain('SHOWN-ANSWER');
	}, T);

	it('one field with a widget on each page, one page boxed: gone under the box, kept on the other page', async () => {
		const src = await kinds();
		// "shared": a widget on page 1 and one on page 2 at (72, 320, 200x20); one answer for both.
		const secret = 'SHARED-ANSWER-55';
		const res = await run([ref(src, 0, 0, [redact([70, 318, 276, 342])]), ref(src, 1)], [src], { [src.id]: { shared: secret } });
		expect(res.checks.filter((c) => !c.ok)).toEqual([]);
		const mu = await mupdfTexts(res.bytes);
		const pj = await pageTexts(res.bytes);
		expect(mu[0]).not.toContain(secret);
		expect(pj[0]).not.toContain(secret);
		expect(pj[1]).toContain(secret);
		expect(mu[1]).toContain(secret);
		expect(await pixmapBlack(res.bytes, 0, [72, 320, 272, 340])).toBe(1);
		// The form itself is gone either way.
		const text = (await expanded(res.bytes)).toString('latin1');
		expect(text).not.toMatch(/\/AcroForm|\/Widget|\/FT\b|\/DV\b/);
	}, T);

	it('rotated pages and offset CropBoxes: the answer under the box is gone and the export still verifies', async () => {
		const src = await openCorpus('forms-geometry.pdf');
		const meta = manifest['forms-geometry.pdf'] as unknown as {
			pagesGeometry: { media: number[]; crop: number[] | null; rotate: number }[];
			rects: { text: number[]; check: number[] }[];
		};
		const pages: PageRef[] = [];
		const answers: Record<string, string> = {};
		const secrets: string[] = [];
		meta.pagesGeometry.forEach((g, i) => {
			for (const extra of [0, 90] as const) {
				const rotation = ((g.rotate + extra) % 360) as 0 | 90 | 180 | 270;
				const vb = visibleBox(g.media, g.crop);
				const wb = widgetBox({ x0: meta.rects[i].text[0], y0: meta.rects[i].text[1], x1: meta.rects[i].text[2], y1: meta.rects[i].text[3] } as Box, vb, rotation)!;
				const pad = 0.01;
				const box: StampBox = { x: Math.max(0, wb.x - pad), y: Math.max(0, wb.y - pad), w: wb.w + 2 * pad, h: wb.h + 2 * pad };
				pages.push(ref(src, i, extra, [{ id: `g${sid++}`, kind: 'redact', box }]));
			}
			answers[`t${i + 1}`] = `GEO-SECRET-${i + 1}`;
			secrets.push(`GEO-SECRET-${i + 1}`);
		});
		const res = await run(pages, [src], { [src.id]: answers });
		expect(res.checks.filter((c) => !c.ok)).toEqual([]);
		await expectNoLeak(res.bytes, secrets);
	}, T);
});
