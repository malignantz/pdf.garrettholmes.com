/**
 * Survey harness: the redact scenario's second look at a pixel doubt (tools/survey/lib/second-look.ts).
 * Survey false alarms it settles: a scan under the box, re-encoded losslessly by the
 * redaction, rendered differently by MuPDF at 40 dpi (reduced-size JPEG 2000 decoding); the
 * anti-aliased edge of a box on a very short page counted as a change outside it.
 */
import * as mupdf from 'mupdf';
import { describe, expect, it } from 'vitest';
import type { StampBox } from '../../src/lib/core/types';
import { SUSPECT_FRACTION, compare, openDoc, renderPage, renderScale } from '../../tools/survey/lib/raster';
import { SECOND_LOOK_FRACTION, imageScaleUnderBox, parsePpm, redactAllowance } from '../../tools/survey/lib/second-look';
import { defaultOptions, engine, ref } from '../engine/helpers';

const T = 120_000;

/** A JPEG of fine black-on-white strokes, like a scanned page of text. */
function scanJpeg(w: number, h: number): Uint8Array {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
	const px = pix.getPixels();
	const stride = pix.getStride();
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const ink = (y % 14 < 9 && (x * 7 + y * 3) % 11 < 3) || (y % 14 === 10 && x % 37 < 30);
			for (let k = 0; k < 3; k++) px[y * stride + x * 3 + k] = ink ? 20 : 245;
		}
	}
	const jpeg = pix.asJPEG(85);
	pix.destroy();
	return jpeg;
}

function render(bytes: Uint8Array, scale: number) {
	const doc = openDoc(mupdf, bytes);
	try {
		return renderPage(mupdf, doc, 0, scale);
	} finally {
		doc.destroy();
	}
}

describe('second look: an image re-encoded by the redaction', () => {
	it('renders the same at the image’s own resolution, and a real change still shows', async () => {
		const { PDFDocument, rgb, StandardFonts } = await import('@cantoo/pdf-lib');
		const doc = await PDFDocument.create();
		const page = doc.addPage([612, 792]);
		page.drawImage(await doc.embedJpg(scanJpeg(1700, 2200)), { x: 0, y: 0, width: 612, height: 792 });
		page.drawText('SECRET-OVER-SCAN', { x: 72, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica), color: rgb(1, 0, 0) });
		const src = await engine().openPdf(await doc.save(), 'scan.pdf');
		const box: StampBox = { x: 70 / 612, y: (792 - 716) / 792, w: 150 / 612, h: 20 / 792 };
		const res = await engine().exportPlan({ pages: [ref(src, 0, 0, [{ id: 'r', kind: 'redact', box }])], options: defaultOptions }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);

		const native = imageScaleUnderBox(src.bytes, box);
		expect(native).toBeCloseTo(1700 / 612, 1);
		const allowed = redactAllowance({ width: 612, height: 792 }, box);
		// The pixels outside the box are the same. (The survey's cases were JPEG 2000, which
		// MuPDF decodes at reduced size for small renders, so at 40 dpi they differed; that
		// format cannot be generated here, so only the settling side is tested.)
		const full = compare(render(src.bytes, native), render(res.bytes, native), [allowed]);
		expect(full.fraction).toBeLessThanOrEqual(SECOND_LOOK_FRACTION);

		// A real change outside the box (a white strip over the scan) is not settled.
		const changed = await PDFDocument.load(res.bytes);
		changed.getPage(0).drawRectangle({ x: 300, y: 300, width: 200, height: 8, color: rgb(1, 1, 1) });
		const other = compare(render(src.bytes, native), render(await changed.save(), native), [allowed]);
		expect(other.fraction).toBeGreaterThan(SUSPECT_FRACTION);
	}, T);

	it('finds no image under a box over plain text', async () => {
		const { PDFDocument, StandardFonts } = await import('@cantoo/pdf-lib');
		const doc = await PDFDocument.create();
		doc.addPage([612, 792]).drawText('plain', { x: 72, y: 700, size: 14, font: await doc.embedFont(StandardFonts.Helvetica) });
		expect(imageScaleUnderBox(await doc.save(), { x: 0.1, y: 0.1, w: 0.3, h: 0.05 })).toBe(0);
	});
});

describe('second look: the box edge on a short page', () => {
	it('allows 2 rendered pixels around the box, at least 0.01 of the page', () => {
		const box: StampBox = { x: 0.1, y: 0.3, w: 0.5, h: 0.4 };
		const short = redactAllowance({ width: 200, height: 50 }, box);
		const scale = renderScale(200, 50);
		expect((box.y - short.y0) * 50 * scale).toBeCloseTo(2, 5);
		expect((short.x1 - box.x - box.w) * 200 * scale).toBeGreaterThanOrEqual(2 - 1e-9);
		const letter = redactAllowance({ width: 612, height: 792 }, box);
		expect(box.x - letter.x0).toBeCloseTo(0.01, 9);
		expect(box.y - letter.y0).toBeCloseTo(0.01, 9);
	});
});

describe('parsePpm', () => {
	it('reads a binary PPM and refuses anything else', () => {
		const head = new TextEncoder().encode('P6\n2 1\n255\n');
		const ppm = new Uint8Array([...head, 1, 2, 3, 4, 5, 6]);
		expect(parsePpm(ppm)).toEqual({ w: 2, h: 1, px: new Uint8Array([1, 2, 3, 4, 5, 6]) });
		expect(parsePpm(ppm.subarray(0, ppm.length - 1))).toBeNull();
		expect(parsePpm(new TextEncoder().encode('P3\n2 1\n255\n1 2 3 4 5 6'))).toBeNull();
	});
});
