/**
 * Page renders from three independent renderers for "looks the same" checks: MuPDF,
 * PDF.js (legacy build, @napi-rs/canvas) and poppler's pdftoppm when it is installed.
 * Widgets and other annotations are drawn (PDF.js: annotationMode ENABLE, the default).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mupdf } from '../../src/lib/engine/mupdf';
import { loadPdfjs, root } from './helpers';

const require = createRequire(import.meta.url);
const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

export interface Rgb {
	w: number;
	h: number;
	/** RGB, row-major. */
	px: Uint8Array;
}

const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist');
const dirs = { cMapUrl: 'cmaps', standardFontDataUrl: 'standard_fonts', wasmUrl: 'wasm' } as const;
class FsBinaryDataFactory {
	async fetch({ kind, filename }: { kind: keyof typeof dirs; filename: string }): Promise<Uint8Array> {
		return new Uint8Array(fs.readFileSync(path.join(pdfjsDir, dirs[kind], filename)));
	}
}

export async function renderMupdf(bytes: Uint8Array, page: number, dpi: number, password?: string): Promise<Rgb> {
	const m = await mupdf();
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	try {
		if (password !== undefined) doc.authenticatePassword(password);
		const p = doc.loadPage(page);
		const pix = p.toPixmap(m.Matrix.scale(dpi / 72, dpi / 72), m.ColorSpace.DeviceRGB, false, true);
		const out = { w: pix.getWidth(), h: pix.getHeight(), px: new Uint8Array(pix.getPixels()) };
		pix.destroy();
		p.destroy();
		return out;
	} finally {
		doc.destroy();
	}
}

export async function renderPdfjs(bytes: Uint8Array, page: number, dpi: number, password?: string): Promise<Rgb> {
	const pj = await loadPdfjs();
	const task = pj.getDocument({ data: bytes.slice(), password, BinaryDataFactory: FsBinaryDataFactory, useWorkerFetch: false, isEvalSupported: false, verbosity: 0 } as never);
	const doc = await task.promise;
	try {
		const p = await doc.getPage(page + 1);
		const vp = p.getViewport({ scale: dpi / 72 });
		const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
		const ctx = canvas.getContext('2d');
		ctx.fillStyle = '#ffffff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		await p.render({ canvasContext: ctx as never, canvas: canvas as never, viewport: vp }).promise;
		const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
		const px = new Uint8Array((rgba.length / 4) * 3);
		for (let i = 0, o = 0; i < rgba.length; i += 4, o += 3) {
			px[o] = rgba[i];
			px[o + 1] = rgba[i + 1];
			px[o + 2] = rgba[i + 2];
		}
		p.cleanup();
		return { w: canvas.width, h: canvas.height, px };
	} finally {
		await task.destroy();
	}
}

let popplerOk: boolean | null = null;
export function hasPoppler(): boolean {
	if (popplerOk === null) {
		try {
			execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
			popplerOk = true;
		} catch {
			popplerOk = false;
		}
	}
	return popplerOk;
}

export function renderPoppler(bytes: Uint8Array, page: number, dpi: number, password?: string): Rgb {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-poppler-'));
	try {
		const file = path.join(dir, 'in.pdf');
		fs.writeFileSync(file, bytes);
		const args = ['-r', String(dpi), '-f', String(page + 1), '-l', String(page + 1), '-singlefile', ...(password !== undefined ? ['-upw', password] : []), file, path.join(dir, 'out')];
		execFileSync('pdftoppm', args, { stdio: 'ignore' });
		const d = fs.readFileSync(path.join(dir, 'out.ppm'));
		// P6 header: magic, width height, max, then one whitespace byte.
		let pos = 0;
		const fields: string[] = [];
		while (fields.length < 4) {
			while (d[pos] === 0x20 || d[pos] === 0x0a) pos++;
			let s = '';
			while (d[pos] !== 0x20 && d[pos] !== 0x0a) s += String.fromCharCode(d[pos++]);
			fields.push(s);
		}
		pos++;
		return { w: Number(fields[1]), h: Number(fields[2]), px: new Uint8Array(d.subarray(pos)) };
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Pixels where any channel differs by more than `level` (the survey harness's PIXEL_LEVEL is 48), and the largest difference. */
export function diffPixels(a: Rgb, b: Rgb, level = 48): { count: number; max: number } {
	if (a.w !== b.w || a.h !== b.h) return { count: Infinity, max: 255 };
	let count = 0;
	let max = 0;
	for (let i = 0; i < a.px.length; i += 3) {
		const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
		if (d > max) max = d;
		if (d > level) count++;
	}
	return { count, max };
}

/** Each renderer's difference between page `page` of `a` and of `b`. */
export async function compareThree(a: Uint8Array, b: Uint8Array, page: number, dpi = 144, password?: string) {
	const out: Record<string, { count: number; max: number }> = {
		mupdf: diffPixels(await renderMupdf(a, page, dpi, password), await renderMupdf(b, page, dpi, password)),
		pdfjs: diffPixels(await renderPdfjs(a, page, dpi, password), await renderPdfjs(b, page, dpi, password))
	};
	if (hasPoppler()) out.poppler = diffPixels(renderPoppler(a, page, dpi, password), renderPoppler(b, page, dpi, password));
	return out;
}
