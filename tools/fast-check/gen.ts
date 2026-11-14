/**
 * Generated large files for the final-check measurement (tools/fast-check/measure.ts).
 *
 *   scan-260    260 letter pages, each its own 1275 × 1650 grey-noise JPEG (about 70 MB):
 *               the slow worst case of the progress measurement (plan, "Progress and time left").
 *   photo-260   260 pages, each a 1600 × 1200 photo-like colour JPEG drawn small.
 *   text-1000   1000 pages of 45 lines of 10 pt text.
 *   streams     16 pages, each with big image streams of every kind the pipeline meets:
 *               DCT, Flate (8-bit grey and RGB), a JPX, CCITT and JBIG2 header-only stream
 *               (qpdf cannot decode those three, so only their structure is checked).
 *
 * Files are written outside the repo (default /home/garrett/pdf-survey/out-fast-check/gen).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, StandardFonts, rgb, PDFArray, PDFDict } from '@cantoo/pdf-lib';
import { zlibSync } from 'fflate';

function rng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		return s >>> 24;
	};
}

export function noiseJpeg(w: number, h: number, seed: number, quality = 50): Uint8Array {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
	const px = pix.getPixels();
	const r = rng(seed);
	for (let i = 0; i < px.length; i++) px[i] = 200 + (r() % 56);
	const out = pix.asJPEG(quality).slice();
	pix.destroy();
	return out;
}

export function photoJpeg(w: number, h: number, seed: number): Uint8Array {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [0, 0, w, h], false);
	const px = pix.getPixels();
	const r = rng(seed);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 3;
			const n = r() % 6;
			px[i] = ((x * 255) / w + n) & 255;
			px[i + 1] = ((y * 255) / h + n) & 255;
			px[i + 2] = (((x + y) * 128) / (w + h) + 60 + n) & 255;
		}
	}
	const out = pix.asJPEG(75).slice();
	pix.destroy();
	return out;
}

async function scans(pages: number, w: number, h: number, kind: 'noise' | 'photo'): Promise<Uint8Array> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	// A different picture on every page, as a scanner makes (Optimize merges identical ones).
	for (let p = 0; p < pages; p++) {
		const img = await doc.embedJpg(kind === 'noise' ? noiseJpeg(w, h, 1000 + p) : photoJpeg(w, h, 2000 + p));
		const page = doc.addPage([612, 792]);
		if (kind === 'noise') page.drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
		else page.drawImage(img, { x: 156, y: 296, width: 300, height: 225 });
	}
	return doc.save({ useObjectStreams: false });
}

async function text(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const r = rng(7);
	const words = ['the', 'quick', 'report', 'section', 'paragraph', 'invoice', 'total', 'court', 'order', 'hereby', 'notice', 'payment', 'agreement'];
	for (let p = 0; p < pages; p++) {
		const page = doc.addPage([612, 792]);
		for (let l = 0; l < 45; l++) {
			let line = `${p + 1}.${l + 1}`;
			while (line.length < 95) line += ' ' + words[r() % words.length];
			page.drawText(line, { x: 40, y: 750 - l * 16, size: 10, font, color: rgb(0, 0, 0) });
		}
	}
	return doc.save({ useObjectStreams: true });
}

/** A raw image XObject with the given filter and data, drawn over part of the page. */
function rawImage(doc: PDFDocument, dict: Record<string, unknown>, data: Uint8Array) {
	const d = doc.context.obj(dict as never) as PDFDict;
	const s = PDFRawStream.of(d, data);
	return doc.context.register(s);
}

async function streams(pages: number): Promise<Uint8Array> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const jpeg = noiseJpeg(1600, 1600, 99, 80);
	const grey = new Uint8Array(1500 * 1500);
	const rgbPix = new Uint8Array(900 * 900 * 3);
	const r = rng(5);
	for (let i = 0; i < grey.length; i++) grey[i] = r();
	for (let i = 0; i < rgbPix.length; i++) rgbPix[i] = (i % 3 === 0 ? r() : i & 255) & 255;
	const greyZ = zlibSync(grey, { level: 6 });
	const rgbZ = zlibSync(rgbPix, { level: 6 });
	// Streams qpdf cannot decode: their bytes are only structure-checked. Filler data of a
	// realistic size (they are never drawn by the measurement, only checked).
	const filler = (n: number) => {
		const b = new Uint8Array(n);
		for (let i = 0; i < n; i++) b[i] = r();
		return b;
	};
	for (let p = 0; p < pages; p++) {
		const page = doc.addPage([612, 792]);
		const refs = {
			Im0: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 1600, Height: 1600, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'DCTDecode', Length: jpeg.length }, jpeg),
			Im1: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 1500, Height: 1500, ColorSpace: 'DeviceGray', BitsPerComponent: 8, Filter: 'FlateDecode', Length: greyZ.length }, greyZ),
			Im2: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 900, Height: 900, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode', Length: rgbZ.length }, rgbZ),
			Im3: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 1000, Height: 1000, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'JPXDecode' }, filler(300_000)),
			Im4: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 2550, Height: 3300, ImageMask: true, Filter: 'CCITTFaxDecode', DecodeParms: { K: -1, Columns: 2550, Rows: 3300 } }, filler(120_000)),
			Im5: rawImage(doc, { Type: 'XObject', Subtype: 'Image', Width: 2550, Height: 3300, ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'JBIG2Decode' }, filler(80_000))
		};
		const xo = doc.context.obj({}) as PDFDict;
		for (const [k, v] of Object.entries(refs)) xo.set(PDFName.of(k), v);
		const res = page.node.Resources() ?? (doc.context.obj({}) as PDFDict);
		res.set(PDFName.of('XObject'), xo);
		page.node.set(PDFName.of('Resources'), res);
		// Only the decodable pictures are drawn (a viewer would fail on the filler streams).
		const content = 'q 300 0 0 300 20 400 cm /Im0 Do Q q 250 0 0 250 330 400 cm /Im1 Do Q q 250 0 0 250 20 100 cm /Im2 Do Q';
		const cs = doc.context.flateStream(content);
		page.node.set(PDFName.of('Contents'), doc.context.register(cs));
		void PDFNumber;
		void PDFArray;
	}
	return doc.save({ useObjectStreams: false });
}

export const GENERATED = {
	'scan-260': () => scans(260, 1275, 1650, 'noise'),
	'scan-30': () => scans(30, 1275, 1650, 'noise'),
	'photo-260': () => scans(260, 1600, 1200, 'photo'),
	'text-1000': () => text(1000),
	streams: () => streams(16)
} as const;

export async function generate(dir: string, names = Object.keys(GENERATED) as (keyof typeof GENERATED)[]): Promise<Record<string, string>> {
	fs.mkdirSync(dir, { recursive: true });
	const out: Record<string, string> = {};
	for (const n of names) {
		const file = path.join(dir, `${n}.pdf`);
		if (!fs.existsSync(file)) {
			const t = performance.now();
			fs.writeFileSync(file, await GENERATED[n]());
			console.log(`generated ${n}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t)} ms`);
		}
		out[n] = file;
	}
	return out;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
	await generate(process.argv[2] ?? '/home/garrett/pdf-survey/out-fast-check/gen');
}
