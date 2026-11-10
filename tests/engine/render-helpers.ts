import { PDFDocument, PDFName, StandardFonts, rgb } from '@cantoo/pdf-lib';
import { mupdf } from '../../src/lib/engine/mupdf';
import { engine } from './helpers';
import type { Source } from '../../src/lib/core/types';

export interface PageSpec {
	w: number;
	h: number;
	rotate?: number;
	/** [x0, y0, x1, y1] */
	crop?: [number, number, number, number];
	userUnit?: number;
}

/** A source with black text and a black bar on every page (page k says "page k+1"). */
export async function makeSource(specs: PageSpec[], name = 'gen.pdf'): Promise<Source> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.HelveticaBold);
	specs.forEach((s, k) => {
		const page = doc.addPage([s.w, s.h]);
		const x0 = s.crop ? s.crop[0] : 0;
		const y0 = s.crop ? s.crop[1] : 0;
		const cw = s.crop ? s.crop[2] - s.crop[0] : s.w;
		const ch = s.crop ? s.crop[3] - s.crop[1] : s.h;
		page.drawText(`page ${k + 1}`, { x: x0 + cw * 0.2, y: y0 + ch * 0.55, size: Math.min(cw, ch) * 0.12, font, color: rgb(0, 0, 0) });
		page.drawRectangle({ x: x0 + cw * 0.1, y: y0 + ch * 0.4, width: cw * 0.8, height: ch * 0.06, color: rgb(0, 0, 0) });
		if (s.crop) page.setCropBox(s.crop[0], s.crop[1], cw, ch);
		if (s.rotate) page.node.set(PDFName.of('Rotate'), doc.context.obj(s.rotate));
		if (s.userUnit) page.node.set(PDFName.of('UserUnit'), doc.context.obj(s.userUnit));
	});
	return engine().openPdf(await doc.save(), name);
}

export interface Raster {
	w: number;
	h: number;
	/** RGB, row-major. */
	px: Uint8ClampedArray;
	at(fx: number, fy: number): [number, number, number];
}

/** Renders page `i` as displayed (MuPDF) at 1 pixel per point (UserUnit ignored by MuPDF bounds, so fractions are used). */
export async function render(bytes: Uint8Array, i: number, scale = 1, password?: string): Promise<Raster> {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	try {
		if (password !== undefined) doc.authenticatePassword(password);
		const page = doc.loadPage(i);
		const pix = page.toPixmap(m.Matrix.scale(scale, scale), m.ColorSpace.DeviceRGB, false, true);
		const w = pix.getWidth();
		const h = pix.getHeight();
		const px = new Uint8ClampedArray(pix.getPixels());
		pix.destroy();
		return {
			w,
			h,
			px,
			at: (fx, fy) => {
				const x = Math.min(w - 1, Math.max(0, Math.floor(fx * w)));
				const y = Math.min(h - 1, Math.max(0, Math.floor(fy * h)));
				const o = (y * w + x) * 3;
				return [px[o], px[o + 1], px[o + 2]];
			}
		};
	} finally {
		doc.destroy();
	}
}
