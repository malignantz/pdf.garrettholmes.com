import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from '@cantoo/pdf-lib';
import { corpus, engine, manifest, openCorpus, pageTexts } from './helpers';
import type { EngineErrorShape, PageSize } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';

const T = 30_000;

function close(actual: PageSize[], expected: [number, number][]) {
	expect(actual).toHaveLength(expected.length);
	actual.forEach((p, i) => {
		expect(p.width, `page ${i + 1} width`).toBeCloseTo(expected[i][0], 2);
		expect(p.height, `page ${i + 1} height`).toBeCloseTo(expected[i][1], 2);
	});
}

async function rejects(p: Promise<unknown>): Promise<EngineErrorShape> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineErrorShape;
	}
	throw new Error('expected a rejection');
}

describe('openPdf: geometry as displayed', () => {
	it('reads plain multi-page files', async () => {
		const s = await openCorpus('multi.pdf');
		expect(s.kind).toBe('pdf');
		expect(s.wasEncrypted).toBe(false);
		expect(s.notes).toEqual([]);
		expect(s.originalSize).toBe(corpus('multi.pdf').length);
		close(s.pages, Array(6).fill([612, 792]));
		expect(await pageTexts(s.bytes)).toEqual([1, 2, 3, 4, 5, 6].map((n) => `multi p${n}`));
	}, T);

	it('reads mixed page sizes', async () => {
		close((await openCorpus('sizes.pdf')).pages, manifest['sizes.pdf'].sizes as [number, number][]);
	}, T);

	it('applies /Rotate, including -90 and 450', async () => {
		// Rotate 0, 90, 180, 270, -90, 450 on a 400×600 MediaBox.
		close((await openCorpus('rotated.pdf')).pages, [
			[400, 600],
			[600, 400],
			[400, 600],
			[600, 400],
			[600, 400],
			[600, 400]
		]);
	}, T);

	it('honours inherited MediaBox and Rotate', async () => {
		close((await openCorpus('inherited.pdf')).pages, [
			[500, 300],
			[500, 300],
			[300, 500]
		]);
	}, T);

	it('uses CropBox clipped to MediaBox, with offsets and rotation', async () => {
		close((await openCorpus('cropbox.pdf')).pages, [
			[420, 600],
			[350, 450],
			[600, 420],
			[400, 400],
			[450, 350],
			[420, 600]
		]);
	}, T);

	it('scales by UserUnit like PDF.js', async () => {
		close((await openCorpus('userunit.pdf')).pages, [[600, 400]]);
	}, T);

	it('reads linearized and object-stream files', async () => {
		close((await openCorpus('linearized.pdf')).pages, Array(6).fill([612, 792]));
		close((await openCorpus('objstm.pdf')).pages, manifest['objstm.pdf'].sizes as [number, number][]);
	}, T);

	it('keeps AcroForm fields', async () => {
		const s = await openCorpus('form.pdf');
		const doc = await PDFDocument.load(s.bytes);
		expect(
			doc
				.getForm()
				.getFields()
				.map((f) => f.getName())
				.sort()
		).toEqual(['agree', 'name', 'notes']);
	}, T);
});

describe('openPdf: damaged and invalid input', () => {
	it('repairs a damaged xref table and says so', async () => {
		const s = await openCorpus('damaged-xref.pdf');
		expect(s.pages).toHaveLength(3);
		expect(s.notes).toContain('Repaired a damaged cross-reference table.');
		expect(await pageTexts(s.bytes)).toEqual(['damaged p1', 'damaged p2', 'damaged p3']);
	}, T);

	it('repairs wrong stream lengths and zeroed offsets', async () => {
		const s = await openCorpus('damaged-streams.pdf');
		expect(s.notes).toContain('Repaired a damaged cross-reference table.');
		expect(await pageTexts(s.bytes)).toEqual(['streams p1', 'streams p2']);
	}, T);

	for (const name of ['truncated.pdf', 'garbage.pdf', 'header-garbage.pdf']) {
		it(`rejects ${name} as unreadable`, async () => {
			const e = await rejects(engine().openPdf(corpus(name), name));
			expect(e.code).toBe('unreadable');
			expect(e.message).toMatch(/\.$/);
		}, T);
	}

	it('rejects an empty file', async () => {
		expect((await rejects(engine().openPdf(new Uint8Array(), 'x.pdf'))).code).toBe('unreadable');
	});

	it('does not modify the caller’s bytes', async () => {
		const bytes = corpus('multi.pdf');
		const copy = bytes.slice();
		await engine().openPdf(bytes, 'multi.pdf');
		expect(bytes).toEqual(copy);
	}, T);
});

describe('openPdf: encryption', () => {
	const userPw = ['enc-rc4-40.pdf', 'enc-rc4-128.pdf', 'enc-aes-128.pdf', 'enc-aes-256.pdf'];
	for (const name of userPw) {
		it(`${name}: required, wrong, right`, async () => {
			expect((await rejects(engine().openPdf(corpus(name), name))).code).toBe('password-required');
			expect((await rejects(engine().openPdf(corpus(name), name, 'nope'))).code).toBe('password-wrong');
			const s = await engine().openPdf(corpus(name), name, 'user');
			expect(s.wasEncrypted).toBe(true);
			expect(s.pages).toHaveLength(2);
			expect(s.notes.join(' ')).toMatch(/password/);
			// The normalized copy is not encrypted.
			expect(await pageTexts(s.bytes)).toEqual(['enc p1', 'enc p2']);
		}, T);
	}

	it('opens with the owner password too', async () => {
		const s = await engine().openPdf(corpus('enc-aes-256.pdf'), 'x', 'owner');
		expect(s.pages).toHaveLength(2);
	}, T);

	it('opens owner-only files without asking', async () => {
		const s = await engine().openPdf(corpus('enc-aes-256-owner-only.pdf'), 'x');
		expect(s.wasEncrypted).toBe(true);
		expect(await pageTexts(s.bytes)).toEqual(['enc p1', 'enc p2']);
	}, T);

	it('handles non-ASCII passwords', async () => {
		expect((await rejects(engine().openPdf(corpus('enc-aes-256-unicode.pdf'), 'x', 'passwort'))).code).toBe(
			'password-wrong'
		);
		const s = await engine().openPdf(corpus('enc-aes-256-unicode.pdf'), 'x', 'pässwörd');
		expect(s.pages).toHaveLength(2);
	}, T);

	it('treats an empty password like none', async () => {
		expect((await rejects(engine().openPdf(corpus('enc-aes-256.pdf'), 'x', ''))).code).toBe('password-required');
	}, T);
});

describe('openImage and blankPage', () => {
	async function onlyImage(bytes: Uint8Array) {
		const doc = await PDFDocument.load(bytes);
		const page = doc.getPages()[0];
		const xobjects = page.node.Resources()!.lookup(PDFName.of('XObject')) as import('@cantoo/pdf-lib').PDFDict;
		const [, ref] = xobjects.entries()[0];
		const img = doc.context.lookup(ref) as PDFRawStream;
		const contents = page.node.Contents()!;
		const stream = (contents instanceof PDFRawStream ? contents : doc.context.lookup((contents as import('@cantoo/pdf-lib').PDFArray).get(0))) as PDFRawStream;
		const ops = new TextDecoder().decode(decodePDFRawStream(stream).decode());
		return { img, ops, doc };
	}

	it('JPEG with EXIF orientation 6 becomes an upright portrait page', async () => {
		const bytes = corpus('photo-exif6.jpg');
		const s = await engine().openImage(bytes, 'image/jpeg', 'photo.jpg');
		expect(s.kind).toBe('image');
		// 400×240 stored pixels, displayed 240×400; at most 1 pt per pixel.
		close(s.pages, [[240, 400]]);
		expect(s.notes.join(' ')).toMatch(/hidden photo details/);
		const { img, ops } = await onlyImage(s.bytes);
		expect(img.dict.get(PDFName.of('Width'))?.toString()).toBe('400');
		expect(img.dict.get(PDFName.of('Height'))?.toString()).toBe('240');
		expect(img.dict.get(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
		// Unit square → page: stored x runs down the page, stored y runs left to right.
		expect(ops.replace(/\s+/g, ' ')).toContain('0 -400 240 0 0 400 cm');
		const raw = Buffer.from(img.contents).toString('latin1');
		expect(raw).not.toContain('Exif');
		expect(raw).not.toContain('corpus comment');
		expect(raw.charCodeAt(0)).toBe(0xff);
	}, T);

	it('JPEG without orientation keeps its layout', async () => {
		const s = await engine().openImage(corpus('photo-plain.jpg'), 'image/jpeg', 'p.jpg');
		close(s.pages, [[400, 240]]);
		const { ops } = await onlyImage(s.bytes);
		expect(ops.replace(/\s+/g, ' ')).toContain('400 0 0 240 0 0 cm');
	}, T);

	it('PNG with alpha keeps its soft mask', async () => {
		const s = await engine().openImage(corpus('alpha.png'), 'image/png', 'a.png');
		close(s.pages, [[200, 100]]);
		const { img } = await onlyImage(s.bytes);
		expect(img.dict.get(PDFName.of('SMask'))).toBeDefined();
	}, T);

	it('rejects bytes that are not the stated image type', async () => {
		expect((await rejects(engine().openImage(corpus('alpha.png'), 'image/jpeg', 'x'))).code).toBe('unreadable');
		expect((await rejects(engine().openImage(corpus('photo-plain.jpg'), 'image/png', 'x'))).code).toBe('unreadable');
	});

	it('makes blank pages and refuses silly sizes', async () => {
		const s = await engine().blankPage({ width: 595.28, height: 841.89 });
		expect(s.kind).toBe('blank');
		close(s.pages, [[595.28, 841.89]]);
		const doc = await PDFDocument.load(s.bytes);
		expect(doc.getPageCount()).toBe(1);
		expect(doc.getPages()[0].getSize().width).toBeCloseTo(595.28, 2);
		for (const bad of [
			{ width: 0, height: 100 },
			{ width: 2, height: 100 },
			{ width: 20000, height: 100 },
			{ width: Number.NaN, height: 100 }
		]) {
			expect((await rejects(engine().blankPage(bad))).code).toBe('unsupported');
		}
	}, T);
});

describe('unsupportedChars', () => {
	it('accepts Latin, Greek, Cyrillic and common symbols', async () => {
		expect(await engine().unsupportedChars('Grüße, Ελλάδα, Привет — €5 “quoted” ½ №\nnext line')).toBe('');
	});
	it('reports characters the font lacks, once each, in order', async () => {
		expect(await engine().unsupportedChars('ok ✓ 中 ✓ 😀')).toBe('✓中😀');
	});
	it('rejects control characters and stray combining marks, accepts composable ones', async () => {
		expect(await engine().unsupportedChars('a\tb')).toBe('\t');
		expect(await engine().unsupportedChars('é')).toBe(''); // NFC → é
		expect(await engine().unsupportedChars('q́')).toBe('́'); // no precomposed form
	});
});
