/**
 * True redaction, end to end through exportPlan with the real engines.
 *
 * The corpus (tests/corpus/generate-redact.mjs) puts unique "SECRET-…" strings in
 * every place a redaction must reach and "KEEP-…" strings next to them. The boxes
 * of redact-basic.pdf p1 are listed in its manifest entry in PDF user space.
 */

import { describe, expect, it } from 'vitest';
import type { EngineErrorShape, ExportOptions, ExportResult, PageRef, Rotation, Source, Stamp, StampBox } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { mupdf } from '../../src/lib/engine/mupdf';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { applyRedactions, verifyRedactions, type RedactJob } from '../../src/lib/engine/redact';
import { defaultOptions, engine, loadPdfjs, manifest, nodeAssets, openCorpus, pageTexts, ref } from './helpers';
import { StampFont } from '../../src/lib/engine/font';
import type { EngineDeps } from '../../src/lib/engine/deps';
import { corpus, prng } from './helpers';
import type { Asset } from '../../src/lib/core/types';

const T = 120_000;
const qpdf = new Qpdf(nodeAssets().qpdf);

type UserRect = [number, number, number, number];
interface BasicMeta {
	boxes: Record<string, { rect: UserRect; hides: string[]; image?: UserRect }>;
	keep: string[];
	metadataSecrets: string[];
	pageSecrets: string[];
	inlineHex: string;
	p3: { secret: string; keep: string[] };
}
const basic = manifest['redact-basic.pdf'] as unknown as BasicMeta;

/** User-space rect on an unrotated 612×792 page with MediaBox at the origin → stamp fractions. */
function frac([x0, y0, x1, y1]: UserRect, w = 612, h = 792): StampBox {
	return { x: x0 / w, y: (h - y1) / h, w: (x1 - x0) / w, h: (y1 - y0) / h };
}
let sid = 0;
const redact = (box: StampBox): Stamp => ({ id: `r${sid++}`, kind: 'redact', box });
const allBasicBoxes = () => Object.values(basic.boxes).map((b) => redact(frac(b.rect)));

async function exportPages(pages: PageRef[], sources: Source[], options: Partial<ExportOptions> = {}) {
	return engine().exportPlan({ pages, options: { ...defaultOptions, ...options } }, sources, []);
}

/** Every object decompressed (qpdf --qdf), so raw searches see inside streams. */
async function expanded(bytes: Uint8Array, password?: string): Promise<Buffer> {
	const res = await qpdf.run({
		args: [...(password ? [`--password=${password}`, '--decrypt'] : []), '--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'],
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
	return [
		latin,
		Buffer.from(latin.toString('hex')),
		Buffer.from(latin.toString('hex').toUpperCase()),
		be,
		le,
		Buffer.from(be.toString('hex')),
		Buffer.from(be.toString('hex').toUpperCase())
	];
}
function findIn(buf: Buffer, s: string): boolean {
	return spellings(s).some((sp) => buf.indexOf(sp) >= 0);
}

async function mupdfTexts(bytes: Uint8Array, password?: string): Promise<string[]> {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	if (password) doc.authenticatePassword(password);
	const out: string[] = [];
	for (let i = 0; i < doc.countPages(); i++) out.push(doc.loadPage(i).toStructuredText('preserve-whitespace').asText());
	return out;
}

/** RGB render of one page with MuPDF at 1 px/pt (page space = displayed page). */
async function render(bytes: Uint8Array, pageIndex: number, scale = 1) {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const pix = doc.loadPage(pageIndex).toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
	const w = pix.getWidth();
	const h = pix.getHeight();
	const stride = pix.getStride();
	const data = pix.getPixels().slice();
	return {
		w,
		h,
		/** Share of black pixels in a displayed-fraction box, inset by 2 px. */
		black(b: StampBox) {
			let n = 0;
			let k = 0;
			for (let y = Math.ceil(b.y * h) + 2; y < Math.floor((b.y + b.h) * h) - 2; y++) {
				for (let x = Math.ceil(b.x * w) + 2; x < Math.floor((b.x + b.w) * w) - 2; x++) {
					const o = y * stride + x * 3;
					n++;
					if (data[o] < 40 && data[o + 1] < 40 && data[o + 2] < 40) k++;
				}
			}
			return n ? k / n : 1;
		}
	};
}

async function rejects(p: Promise<unknown>): Promise<EngineErrorShape> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineError;
	}
	throw new Error('expected a rejection');
}

function deps(): EngineDeps {
	const a = nodeAssets();
	return {
		qpdf,
		mupdf,
		pdfjs: loadPdfjs,
		pdfLib: () => import('@cantoo/pdf-lib'),
		font: new StampFont(a.font)
	};
}

// ---------------------------------------------------------------------------

describe('redaction: redact-basic.pdf', () => {
	it('removes every secret under the boxes from text, raw bytes and metadata, keeps the rest', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const res = await exportPages([ref(src, 0, 0, allBasicBoxes())], [src]);
		expect(res.checks.filter((c) => c.name === 'redaction').every((c) => c.ok)).toBe(true);
		expect(res.checks.find((c) => c.name === 'redaction')!.detail).toMatch(/8 areas redacted on 1 page/);

		const hidden = [...Object.values(basic.boxes).flatMap((b) => b.hides), ...basic.metadataSecrets, ...basic.pageSecrets];
		const [pdfjsText] = await pageTexts(res.bytes);
		const [muText] = await mupdfTexts(res.bytes);
		const raw = await expanded(res.bytes);
		for (const s of hidden) {
			expect(pdfjsText, s).not.toContain(s);
			expect(muText, s).not.toContain(s);
			expect(findIn(raw, s), s).toBe(false);
		}
		expect(raw.toString('latin1')).not.toMatch(/SECRET-/);
		// The inline image's data (MuPDF would re-write it as lower-case hex).
		expect(raw.toString('latin1')).not.toContain(basic.inlineHex);
		expect(raw.toString('latin1')).not.toContain(basic.inlineHex.toLowerCase());
		// No image object anywhere in the file (drawn or orphaned) keeps the picture under the image box.
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		let images = 0;
		for (let i = 1; i < doc.countObjects(); i++) {
			const o = doc.newIndirect(i);
			if (!o.isStream() || o.resolve().get('Subtype').toString() !== '/Image') continue;
			images++;
			const pix = doc.loadImage(o).toPixmap();
			const n = pix.getStride() / pix.getWidth();
			const px = pix.getPixels();
			const values = new Set<string>();
			// Columns 0..33 of the 64×32 picture lie under the image box (x 298..412 of 300..500).
			for (let y = 0; y < pix.getHeight(); y++) for (let x = 0; x < 34; x++) values.add(px.slice(y * pix.getStride() + x * n, y * pix.getStride() + x * n + n).join(','));
			expect(values.size).toBe(1);
		}
		expect(images).toBe(1);
		for (const k of basic.keep) {
			expect(pdfjsText).toContain(k);
			expect(muText).toContain(k);
		}
		// The field outside every box and the note survive.
		expect(raw.toString('latin1')).toContain('KEEP-FIELD');
		expect(raw.toString('latin1')).toContain('KEEP-NOTE');
	}, T);
});

// ---------------------------------------------------------------------------
// Helpers for geometry: where a user-space rect of a source page lands on the
// exported page (as displayed, fractions), from MuPDF's page transform plus the
// plan's extra clockwise rotation.

type Pt = [number, number];
async function sourceFrame(bytes: Uint8Array, pageIndex: number) {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const page = doc.loadPage(pageIndex);
	const b = page.getBounds();
	return { tf: page.getTransform() as number[], w: b[2] - b[0], h: b[3] - b[1] };
}
function displayedFrac(frame: { tf: number[]; w: number; h: number }, r: UserRect, rot: Rotation): StampBox {
	const { tf, w, h } = frame;
	const pts: Pt[] = [
		[r[0], r[1]],
		[r[2], r[1]],
		[r[0], r[3]],
		[r[2], r[3]]
	].map(([x, y]) => [tf[0] * x + tf[2] * y + tf[4], tf[1] * x + tf[3] * y + tf[5]] as Pt);
	const turned = pts.map(([x, y]): Pt => {
		if (rot === 90) return [h - y, x];
		if (rot === 180) return [w - x, h - y];
		if (rot === 270) return [y, w - x];
		return [x, y];
	});
	const W = rot % 180 ? h : w;
	const H = rot % 180 ? w : h;
	const xs = turned.map((p) => p[0]);
	const ys = turned.map((p) => p[1]);
	const x0 = Math.min(...xs);
	const y0 = Math.min(...ys);
	return { x: x0 / W, y: y0 / H, w: (Math.max(...xs) - x0) / W, h: (Math.max(...ys) - y0) / H };
}

/** Pixels of every image drawn on a page that fall under a displayed-fraction box: their stored values. */
async function storedImagePixelsUnder(bytes: Uint8Array, pageIndex: number, box: StampBox) {
	const m = await mupdf();
	const doc = new m.PDFDocument(bytes);
	const page = doc.loadPage(pageIndex);
	const b = page.getBounds();
	const W = b[2] - b[0];
	const H = b[3] - b[1];
	const target = [box.x * W, box.y * H, (box.x + box.w) * W, (box.y + box.h) * H];
	const found: { inside: Set<string>; outside: Set<string> }[] = [];
	const dev = new m.Device({
		fillImage(image, ctm) {
			const pix = image.toPixmap();
			const w = pix.getWidth();
			const h = pix.getHeight();
			const n = pix.getStride() / w;
			const px = pix.getPixels();
			const inside = new Set<string>();
			const outside = new Set<string>();
			for (let y = 0; y < h; y++) {
				for (let x = 0; x < w; x++) {
					const u = (x + 0.5) / w;
					const v = (y + 0.5) / h;
					const cx = ctm[0] * u + ctm[2] * v + ctm[4];
					const cy = ctm[1] * u + ctm[3] * v + ctm[5];
					const value = Array.from(px.slice(y * pix.getStride() + x * n, y * pix.getStride() + x * n + n)).join(',');
					// Pixels well inside the box, and pixels well outside it.
					const margin = 4;
					if (cx > target[0] + margin && cx < target[2] - margin && cy > target[1] + margin && cy < target[3] - margin) inside.add(value);
					else if (cx < target[0] - margin || cx > target[2] + margin || cy < target[1] - margin || cy > target[3] + margin) outside.add(value);
				}
			}
			found.push({ inside, outside });
		}
	});
	page.run(dev, m.Matrix.identity);
	dev.close();
	return found;
}

// ---------------------------------------------------------------------------

describe('redaction: whole page', () => {
	it('a box over the whole page leaves a black page with no text, pictures or annotations', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const all: StampBox = { x: 0, y: 0, w: 1, h: 1 };
		const res = await exportPages([ref(src, 0, 0, [redact(all)]), ref(src, 2, 90, [redact(all)])], [src]);
		expect(res.checks.find((c) => c.name === 'redaction')!.detail).toMatch(/2 areas redacted on 2 pages/);
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).not.toMatch(/SECRET-|KEEP-/);
		expect((await pageTexts(res.bytes)).join('')).toBe('');
		for (const i of [0, 1]) expect((await render(res.bytes, i)).black({ x: 0, y: 0, w: 1, h: 1 })).toBe(1);
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		expect(doc.loadPage(0).getObject().get('Annots').isNull()).toBe(true);
	}, T);
});

describe('redaction: shared content and duplicates', () => {
	it('leaves pages that share streams, forms and images with a redacted page intact', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const res = await exportPages([ref(src, 0, 0, allBasicBoxes()), ref(src, 1), ref(src, 2), ref(src, 0)], [src]);
		const pdfjs = await pageTexts(res.bytes);
		const mu = await mupdfTexts(res.bytes);
		const p1Secrets = ['SECRET-LINE-ONE', 'SECRET-FORM-TWO', 'SECRET-HEX-THREE', 'SECRET-OCR-SIX'];
		for (const s of p1Secrets) {
			expect(pdfjs[0]).not.toContain(s);
			expect(mu[0]).not.toContain(s);
			// p2 shares p1's content stream; p4 is the same source page without a box.
			for (const i of [1, 3]) {
				expect(pdfjs[i], `page ${i + 1} ${s}`).toContain(s);
				expect(mu[i], `page ${i + 1} ${s}`).toContain(s);
			}
		}
		expect(mu[3]).toContain('SECRET-ACTUAL-FOUR');
		for (const k of basic.keep) for (const i of [0, 1, 3]) expect(mu[i]).toContain(k);
		// p3 draws the same form and image.
		for (const s of [basic.p3.secret, ...basic.p3.keep, 'SECRET-FORM-TWO']) expect(mu[2]).toContain(s);
		const [img3] = await storedImagePixelsUnder(res.bytes, 2, frac([300, 200, 500, 300]));
		expect(img3.inside.size).toBeGreaterThan(10);
		// The unredacted copy still has its annotations and field.
		const raw = (await expanded(res.bytes)).toString('latin1');
		expect(raw).toContain('SECRET-ANNOT-SEVEN');
		expect(raw).toContain('SECRET-FIELD-NINE');
		expect(raw).toContain('SECRET-NAMED-ACTUAL');
		expect(raw).toContain(basic.inlineHex);
	}, T);
});

describe('redaction: fonts and forms', () => {
	it('removes text in an embedded subset font (Type 0) and keeps its neighbours', async () => {
		const meta = manifest['redact-cid.pdf'] as unknown as { secret: string; keep: string[]; box: UserRect };
		const src = await openCorpus('redact-cid.pdf');
		const res = await exportPages([ref(src, 0, 0, [redact(frac(meta.box))])], [src]);
		const [pdfjs] = await pageTexts(res.bytes);
		const [mu] = await mupdfTexts(res.bytes);
		for (const t of [pdfjs, mu]) {
			expect(t).not.toMatch(/SECRET|CID-|THIRTEEN/);
			for (const k of meta.keep) expect(t).toContain(k);
		}
	}, T);

	it('removes a form field under a box with its value; other fields stay (forms stage not merged yet)', async () => {
		// form.pdf: text field "name" = "Ada Lovelace" at (72, 600, 300×24), checkbox "agree" at (72, 560).
		const src = await openCorpus('form.pdf');
		const res = await exportPages([ref(src, 0, 0, [redact(frac([70, 598, 380, 626]))])], [src]);
		const raw = await expanded(res.bytes);
		expect(findIn(raw, 'Ada Lovelace')).toBe(false);
		expect(findIn(raw, 'agree')).toBe(true);
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		expect(doc.loadPage(0).getWidgets().map((w) => w.getName())).toEqual(['agree']);
	}, T);
});

describe('redaction: images', () => {
	it('blanks the stored pixels under the box, not only covers them', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const { image, inline } = basic.boxes;
		const res = await exportPages([ref(src, 0, 0, [redact(frac(image.rect)), redact(frac(inline.rect))])], [src]);
		const imgs = await storedImagePixelsUnder(res.bytes, 0, frac(image.rect));
		// The image (64×32 marker picture) is still drawn; under the box its data is one flat value.
		const partly = imgs.filter((i) => i.inside.size > 0);
		expect(partly).toHaveLength(1);
		expect(partly[0].inside.size).toBe(1);
		expect(partly[0].outside.size).toBeGreaterThan(10);
		const [value] = [...partly[0].inside];
		expect(value).not.toMatch(/^200,/); // the marker picture's red channel is always 200
		// The inline image under its own box is gone or blank.
		const inl = await storedImagePixelsUnder(res.bytes, 0, frac(inline.rect));
		for (const i of inl) if (i.inside.size) expect(i.inside.size).toBe(1);
		const r = await render(res.bytes, 0);
		expect(r.black(frac(image.rect))).toBe(1);
		expect(r.black(frac(inline.rect))).toBe(1);
		// Pixels of the right half are untouched.
		expect(r.black(frac([440, 390, 495, 470]))).toBe(0);
	}, T);
});

describe('redaction: geometry', () => {
	it('places boxes right on every rotation, offset CropBox and UserUnit, on many pages', async () => {
		const meta = manifest['redact-geom.pdf'] as unknown as { geom: { secret: string; keep: string; secretRect: UserRect; keepRect: UserRect }[] };
		const src = await openCorpus('redact-geom.pdf');
		const bytes = corpus('redact-geom.pdf');
		const pages: PageRef[] = [];
		const expectBoxes: { secret: StampBox; keep: StampBox; g: (typeof meta.geom)[number] }[] = [];
		for (const [i, g] of meta.geom.entries()) {
			const frame = await sourceFrame(bytes, i);
			for (const rot of [0, 90, 180, 270] as Rotation[]) {
				const secret = displayedFrac(frame, g.secretRect, rot);
				pages.push(ref(src, i, rot, [redact(secret)]));
				expectBoxes.push({ secret, keep: displayedFrac(frame, g.keepRect, rot), g });
			}
		}
		const res = await exportPages(pages, [src]);
		expect(res.checks.find((c) => c.name === 'redaction')!.detail).toMatch(/28 areas redacted on 28 pages/);
		const mu = await mupdfTexts(res.bytes);
		const pdfjs = await pageTexts(res.bytes);
		for (const [i, e] of expectBoxes.entries()) {
			expect(mu[i], `page ${i + 1}`).not.toContain(e.g.secret);
			expect(pdfjs[i], `page ${i + 1}`).not.toContain(e.g.secret);
			expect(mu[i], `page ${i + 1}`).toContain(e.g.keep);
			const r = await render(res.bytes, i, 2);
			expect(r.black(e.secret), `page ${i + 1} box`).toBe(1);
			expect(r.black(e.keep), `page ${i + 1} keep`).toBeLessThan(0.3);
		}
	}, T);

	it('removes a glyph that the box only grazes', async () => {
		const meta = manifest['redact-geom.pdf'] as unknown as { geom: { secretRect: UserRect }[] };
		const src = await openCorpus('redact-geom.pdf');
		const [x0, y0, x1, y1] = meta.geom[0].secretRect; // "SECRET-GEO-1" from x0 + 1 to x1 - 1, 12 pt Helvetica, page 400×600
		const sx = x0 + 1;
		const end = x1 - 1;
		// Left: covers only the first 1 pt of "S" (8 pt wide). Right: only the last 0.5 pt of "1".
		const left: UserRect = [sx - 3, y0 + 2, sx + 1, y1 - 2];
		const right: UserRect = [end - 0.5, y0 + 2, end + 3, y1 - 2];
		const res = await exportPages([ref(src, 0, 0, [redact(frac(left, 400, 600)), redact(frac(right, 400, 600))])], [src]);
		const [mu] = await mupdfTexts(res.bytes);
		const [pdfjs] = await pageTexts(res.bytes);
		expect(mu).toContain('ECRET-GEO-');
		expect(mu).not.toContain('SECRET-GEO-1');
		expect(mu).not.toMatch(/SECRET|ECRET-GEO-1/);
		expect(pdfjs).toContain('ECRET-GEO-');
		expect(pdfjs).not.toMatch(/SECRET|ECRET-GEO-1/);
		expect(mu).toContain('KEEP-GEO-1');
	}, T);
});

describe('redaction: hard constructs', () => {
	const hard = manifest['redact-hard.pdf'] as unknown as { box: UserRect; cases: string[] };
	const refused = new Set(['soft-mask']);
	for (const [i, name] of hard.cases.entries()) {
		it(`${name}: ${refused.has(name) ? 'refused cleanly' : 'removed and verified'}`, async () => {
			const src = await openCorpus('redact-hard.pdf');
			const run = exportPages([ref(src, i, 0, [redact(frac(hard.box))])], [src]);
			if (refused.has(name)) {
				const e = await rejects(run);
				expect(e.code).toBe('unsupported');
				expect(e.message).toMatch(/transparency mask/);
				return;
			}
			const res = await run;
			const raw = (await expanded(res.bytes)).toString('latin1');
			expect(raw).not.toMatch(/SECRET-/);
			expect(raw).toContain(`KEEP-HARD-${i + 1}`);
			const r = await render(res.bytes, 0, 2);
			expect(r.black(frac(hard.box))).toBe(1);
			for (const img of await storedImagePixelsUnder(res.bytes, 0, frac(hard.box))) {
				expect(img.inside.size, 'stored pixels under the box').toBeLessThanOrEqual(1);
			}
		}, T);
	}
});

describe('redaction: stamps over a box, encryption', () => {
	const sig: Asset = { id: 'sig', kind: 'signature', png: corpus('signature.png'), width: 240, height: 80 };
	it('allows our own text, signature and highlight over a box on the final file', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const b = frac(basic.boxes.texts.rect);
		const stamps: Stamp[] = [
			redact(b),
			{ id: 't', kind: 'text', text: 'WITHHELD', x: b.x + 0.01, y: b.y + 0.01, size: 0.02, color: 'red' },
			{ id: 'i', kind: 'image', assetId: 'sig', box: { x: b.x + 0.05, y: b.y + 0.05, w: 0.15, h: 0.05 } },
			{ id: 'h', kind: 'highlight', color: 'yellow', box: b }
		];
		const res = await engine().exportPlan(
			{ pages: [ref(src, 0, 0, stamps)], options: { ...defaultOptions, numbering: { style: 'page-n', position: 'top-left', start: 1, skip: 0, size: 10 } } },
			[src],
			[sig]
		).catch((e: EngineError) => {
			// Highlights and numbering are other streams; until they land the plan is refused before redaction.
			if (e.code === 'unsupported' && /Highlights|Page numbers/.test(e.message)) return null;
			throw e;
		});
		const plan = res ?? (await engine().exportPlan({ pages: [ref(src, 0, 0, stamps.filter((s) => s.kind !== 'highlight'))], options: defaultOptions }, [src], [sig]));
		expect(plan.checks.filter((c) => c.name === 'redaction').every((c) => c.ok)).toBe(true);
		const [text] = await pageTexts(plan.bytes);
		expect(text).toContain('WITHHELD');
		expect(text).not.toMatch(/SECRET-HEX|SECRET-ACTUAL|SECRET-UTF/);
	}, T);

	it('verifies an encrypted export, and the decrypted bytes hold no secret', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const pw = 'correct horse';
		const res = await exportPages([ref(src, 0, 0, allBasicBoxes())], [src], { password: pw, compress: true });
		expect(res.checks.find((c) => c.name === 'encryption')!.ok).toBe(true);
		const job: RedactJob = { pageIndex: 0, boxes: Object.values(basic.boxes).map((b) => frac(b.rect)), expected: { width: 612, height: 792 } };
		const again = await verifyRedactions(deps(), res.bytes, [job], [[]], pw);
		expect(again.every((c) => c.ok)).toBe(true);
		const raw = (await expanded(res.bytes, pw)).toString('latin1');
		expect(raw).toContain('KEEP-ALPHA');
		expect(raw).not.toMatch(/SECRET-/);
	}, T);
});

describe('redaction: the check catches what is left', () => {
	const job = (boxes: StampBox[]): RedactJob => ({ pageIndex: 0, boxes, expected: { width: 612, height: 792 } });

	it('fails on an unredacted file, for text, pictures, drawings and annotations', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const plain = await exportPages([ref(src, 0)], [src]);
		for (const [key, pattern] of [
			['line', /MuPDF still reads text|PDF\.js still reads text|not solid black/],
			['image', /picture data/],
			['lineart', /drawings/],
			['annots', /annotation/],
			['field', /form field/]
		] as const) {
			const checks = await verifyRedactions(deps(), plain.bytes, [job([frac(basic.boxes[key].rect)])], [[]]);
			expect(checks.every((c) => c.ok), key).toBe(false);
			expect(checks.map((c) => c.detail).join(' '), key).toMatch(pattern);
		}
	}, T);

	it('fails when a redacted file gets text drawn under its box afterwards', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const b = frac(basic.boxes.line.rect);
		const res = await exportPages([ref(src, 0, 0, [redact(b)])], [src]);
		// Sabotage: append white text under the box (invisible on the black? no: drawn on top).
		const m = await mupdf();
		const doc = new m.PDFDocument(res.bytes);
		const page = doc.loadPage(0);
		const font = doc.addSimpleFont(new m.Font('Helvetica'));
		const resDict = page.getObject().get('Resources');
		const fonts = resDict.get('Font').isNull() ? doc.newDictionary() : resDict.get('Font');
		fonts.put('Fsab', font);
		resDict.put('Font', fonts);
		const contents = page.getObject().get('Contents');
		const arr = doc.newArray();
		if (contents.isArray()) for (let i = 0; i < contents.length; i++) arr.push(contents.get(i));
		else arr.push(contents);
		arr.push(doc.addStream('q 3 Tr BT /Fsab 12 Tf 160 700 Td (LEAKED) Tj ET Q', doc.newDictionary()));
		page.getObject().put('Contents', arr);
		const sabotaged = doc.saveToBuffer('').asUint8Array().slice();
		const checks = await verifyRedactions(deps(), sabotaged, [job([b])], [[]]);
		expect(checks.every((c) => c.ok)).toBe(false);
		expect(checks.map((c) => c.detail).join(' ')).toMatch(/MuPDF still reads text/);
		expect(checks.map((c) => c.detail).join(' ')).toMatch(/PDF\.js still reads text/);
		// The same text is fine when the plan says our own stamp drew it.
		const allowed = await verifyRedactions(deps(), sabotaged, [job([b])], [['LEAKED']]);
		expect(allowed.every((c) => c.ok)).toBe(true);
	}, T);

	it('the stage refuses when MuPDF fails to remove anything', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const assembled = (await exportPages([ref(src, 0)], [src])).bytes;
		const m = await mupdf();
		const proto = m.PDFPage.prototype as unknown as { applyRedactions: (...a: unknown[]) => void };
		const real = proto.applyRedactions;
		proto.applyRedactions = function (black: unknown, image: unknown, lineArt: unknown) {
			// Sabotage: MuPDF rewrites the page but leaves the text.
			return real.call(this, black, image, lineArt, m.PDFPage.REDACT_TEXT_NONE);
		};
		try {
			const e = await rejects(applyRedactions(deps(), assembled, [job([frac(basic.boxes.line.rect)])]));
			expect(e.code).toBe('verification-failed');
			expect(e.checks!.some((c) => c.name === 'redaction' && !c.ok)).toBe(true);
		} finally {
			proto.applyRedactions = real;
		}
	}, T);

	it('refuses a page that is not the planned size', async () => {
		const src = await openCorpus('redact-basic.pdf');
		const assembled = (await exportPages([ref(src, 0)], [src])).bytes;
		const e = await rejects(applyRedactions(deps(), assembled, [{ pageIndex: 0, boxes: [{ x: 0.1, y: 0.1, w: 0.1, h: 0.1 }], expected: { width: 792, height: 612 } }]));
		expect(e.code).toBe('verification-failed');
		expect(e.checks![0].name).toBe('page-sizes');
	}, T);
});

describe('redaction: the whole corpus', () => {
	it('every corpus PDF with a box in the middle of page 1 exports verified or refuses cleanly', async () => {
		const box: StampBox = { x: 0.3, y: 0.4, w: 0.4, h: 0.2 };
		const outcomes: string[] = [];
		for (const [name, meta] of Object.entries(manifest)) {
			if (!name.endsWith('.pdf') || meta.expect === 'unreadable') continue;
			let src: Source;
			try {
				src = await openCorpus(name, typeof meta.password === 'string' ? meta.password : undefined);
			} catch {
				continue;
			}
			try {
				const res = await exportPages([ref(src, 0, 0, [redact(box)])], [src]);
				for (const c of res.checks) expect(c.ok, `${name}: ${c.name}: ${c.detail}`).toBe(true);
				expect(res.checks.some((c) => c.name === 'redaction')).toBe(true);
				outcomes.push(`${name}: ok`);
			} catch (e) {
				expect(e, `${name} threw a non-engine error`).toBeInstanceOf(EngineError);
				const err = e as EngineError;
				expect(['unsupported', 'verification-failed'], `${name}: ${err.code} ${err.message}`).toContain(err.code);
				outcomes.push(`${name}: refused (${err.code}: ${err.message})`);
			}
		}
		if (process.env.RDEBUG) console.log(outcomes.join("\n"));
		expect(outcomes.length).toBeGreaterThan(15);
		// Plain files must not be refused.
		for (const name of ['multi.pdf', 'sizes.pdf', 'rotated.pdf', 'cropbox.pdf', 'userunit.pdf', 'metadata.pdf', 'redact-basic.pdf']) {
			expect(outcomes, name).toContain(`${name}: ok`);
		}
	}, 300_000);
});

describe('redaction: random boxes (property)', () => {
	it('random boxes and rotations: verified or refused; nothing under a box; text away from boxes kept', async () => {
		const rand = prng(20261110);
		const files = ['redact-basic.pdf', 'redact-geom.pdf', 'multi.pdf', 'cropbox.pdf', 'rotated.pdf'];
		const m = await mupdf();
		let verified = 0;
		for (let run = 0; run < 24; run++) {
			const name = files[Math.floor(rand() * files.length)];
			const src = await openCorpus(name);
			const pageIndex = Math.floor(rand() * src.pages.length);
			const rot = ([0, 90, 180, 270] as Rotation[])[Math.floor(rand() * 4)];
			const boxes: StampBox[] = [];
			const count = 1 + Math.floor(rand() * 3);
			for (let k = 0; k < count; k++) {
				const w = 0.02 + rand() * 0.4;
				const h = 0.01 + rand() * 0.3;
				boxes.push({ x: rand() * (1 - w), y: rand() * (1 - h), w, h });
			}
			let res: ExportResult;
			try {
				res = await exportPages([ref(src, pageIndex, rot, boxes.map(redact))], [src]);
			} catch (e) {
				expect(e).toBeInstanceOf(EngineError);
				expect(['unsupported', 'verification-failed']).toContain((e as EngineError).code);
				continue;
			}
			verified++;
			// Independent re-check: no character of the output touches a box.
			const doc = new m.PDFDocument(res.bytes);
			const page = doc.loadPage(0);
			const pb = page.getBounds();
			const W = pb[2] - pb[0];
			const H = pb[3] - pb[1];
			const rects = boxes.map((b) => [b.x * W, b.y * H, (b.x + b.w) * W, (b.y + b.h) * H]);
			page.toStructuredText('preserve-whitespace').walk({
				onChar(c, _o, _f, _s, q) {
					if (!c.trim()) return;
					const xs = [q[0], q[2], q[4], q[6]];
					const ys = [q[1], q[3], q[5], q[7]];
					const hit = rects.some(
						(r) => Math.min(...xs) < r[2] - 0.01 && Math.max(...xs) > r[0] + 0.01 && Math.min(...ys) < r[3] - 0.01 && Math.max(...ys) > r[1] + 0.01
					);
					expect(hit, `run ${run} ${name} p${pageIndex + 1} rot ${rot}: '${c}' under a box`).toBe(false);
				}
			});
			// Words of the source page that stay 2 pt clear of every box survive.
			const sdoc = new m.PDFDocument(src.bytes);
			const spage = sdoc.loadPage(pageIndex);
			const frame = { tf: spage.getTransform() as number[], w: spage.getBounds()[2], h: spage.getBounds()[3] };
			const out = page.toStructuredText('preserve-whitespace').asText();
			// ActualText is dropped from every marked-content sequence of a redacted page (by design), so
			// words that exist only as ActualText are not expected to survive.
			const words = new Set(
				spage
					.toStructuredText('preserve-whitespace')
					.asText()
					.split(/\s+/)
					.filter((t) => t.length > 3 && !/ACTUAL|UTFSIXTEEN/.test(t))
			);
			const inv = (t: number[]) => {
				const d = t[0] * t[3] - t[1] * t[2];
				return [t[3] / d, -t[1] / d, -t[2] / d, t[0] / d, (t[2] * t[5] - t[3] * t[4]) / d, (t[1] * t[4] - t[0] * t[5]) / d];
			};
			const back = inv(frame.tf);
			for (const word of words) {
				const hits = spage.search(word, '');
				if (hits.length !== 1) continue;
				const clear = hits[0].every((q) => {
					const xs = [q[0], q[2], q[4], q[6]];
					const ys = [q[1], q[3], q[5], q[7]];
					// Quad (source page space) → user space → output fractions.
					const u0 = [back[0] * Math.min(...xs) + back[2] * Math.min(...ys) + back[4], back[1] * Math.min(...xs) + back[3] * Math.min(...ys) + back[5]];
					const u1 = [back[0] * Math.max(...xs) + back[2] * Math.max(...ys) + back[4], back[1] * Math.max(...xs) + back[3] * Math.max(...ys) + back[5]];
					const f = displayedFrac(frame, [Math.min(u0[0], u1[0]), Math.min(u0[1], u1[1]), Math.max(u0[0], u1[0]), Math.max(u0[1], u1[1])], rot);
					const r = [f.x * W - 2, f.y * H - 2, (f.x + f.w) * W + 2, (f.y + f.h) * H + 2];
					return !rects.some((b) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]);
				});
				if (clear) expect(out, `run ${run} ${name}: '${word}' should survive`).toContain(word);
			}
		}
		expect(verified).toBeGreaterThan(12);
	}, 300_000);
});
