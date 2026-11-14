/**
 * Hard cases for "Make scanned pages black and white" (engine/bilevel.ts), made here: a
 * typed page is drawn with pdf-lib, rendered by MuPDF, given scanner traits (paper tone,
 * blur, noise, uneven light, JPEG) and put alone on a page, as a scanner would.
 * Each case says what it must come out as: 'accept' (converted and still reads cleanly)
 * or 'refuse' (left as it is). 'either' means both are acceptable as long as an accepted
 * result reads cleanly (judged in the visual review).
 *
 *   node … tools/bilevel/hard.ts OUTDIR      writes OUTDIR/<case>.pdf and OUTDIR/cases.json
 */
import fs from 'node:fs';
import path from 'node:path';
import { PDFDocument, PDFName, StandardFonts, rgb, type PDFFont, type PDFPage } from '@cantoo/pdf-lib';
import * as m from 'mupdf';

export type Expect = 'accept' | 'refuse' | 'either';
export interface HardCase {
	name: string;
	expect: Expect;
	note: string;
}

const PW = 612;
const PH = 396;

const LINES = [
	'NOTICE OF CHANGE. This letter confirms the terms we discussed on the telephone',
	'last week. The monthly amount will be $1,240.00 from the first of March, and the',
	'account number 4471-0082-19 stays the same. Please keep this notice with your',
	'records. If any of the figures below are wrong, call us at 303-555-0148 within',
	'thirty days. Reference 88-2041-B, page 1 of 1, dated 02/14/2026.'
];

function prng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s ^= s >>> 17;
		s ^= s << 5;
		return (s >>> 0) / 4294967296;
	};
}

function body(p: PDFPage, font: PDFFont, bold: PDFFont, opts: { size?: number; top?: number; grey?: number } = {}) {
	const size = opts.size ?? 11;
	const top = opts.top ?? PH - 50;
	const c = opts.grey ?? 0;
	p.drawText('Acme Property Services', { x: 50, y: top + 12, size: 14, font: bold, color: rgb(c, c, c) });
	LINES.forEach((t, i) => p.drawText(t, { x: 50, y: top - 14 - i * (size * 1.5), size, font, color: rgb(c, c, c) }));
}

const SCRIBBLE = 'M 0 20 C 10 -10 20 40 30 10 S 45 -5 55 20 C 60 30 70 0 80 15 S 100 30 110 5 L 120 25';

/** Draws the case's page; returns nothing (vector page, rendered afterwards). */
async function draw(name: string, doc: PDFDocument, p: PDFPage) {
	const font = await doc.embedFont(StandardFonts.Helvetica);
	const bold = await doc.embedFont(StandardFonts.HelveticaBold);
	const signLine = () => {
		p.drawLine({ start: { x: 50, y: 120 }, end: { x: 250, y: 120 }, thickness: 0.7 });
		p.drawText('Signature', { x: 50, y: 108, size: 8, font });
	};
	switch (name) {
		case 'small-print':
			body(p, font, bold);
			for (let i = 0; i < 8; i++)
				p.drawText('Terms: this notice is subject to the conditions printed on the back of the agreement; section 4(b) applies to late payments of 5% or more.', {
					x: 50,
					y: 170 - i * 6,
					size: 4.5,
					font
				});
			return;
		case 'light-grey-text':
			body(p, font, bold);
			p.drawText('COPY - received 02/16/2026 - file 88-2041', { x: 50, y: 140, size: 12, font, color: rgb(0.68, 0.68, 0.68) });
			p.drawText('Second line of light grey print that a threshold may wipe out', { x: 50, y: 122, size: 10, font, color: rgb(0.7, 0.7, 0.7) });
			return;
		case 'dark-grey-text':
			body(p, font, bold, { grey: 0.35 });
			return;
		case 'pencil-signature':
			body(p, font, bold);
			signLine();
			p.drawSvgPath(SCRIBBLE, { x: 70, y: 150, borderColor: rgb(0.58, 0.58, 0.6), borderWidth: 0.6, scale: 1.2 });
			return;
		case 'pencil-tick':
			body(p, font, bold);
			p.drawSvgPath('M 0 8 L 5 14 L 16 0', { x: 470, y: 160, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5, scale: 1 });
			return;
		case 'black-signature':
			body(p, font, bold);
			signLine();
			p.drawSvgPath(SCRIBBLE, { x: 70, y: 150, borderColor: rgb(0.05, 0.05, 0.08), borderWidth: 1.1, scale: 1.2 });
			return;
		case 'blue-pen':
			body(p, font, bold);
			signLine();
			p.drawSvgPath(SCRIBBLE, { x: 70, y: 150, borderColor: rgb(0.1, 0.15, 0.55), borderWidth: 1.1, scale: 1.2 });
			p.drawText('02/16/26', { x: 300, y: 125, size: 13, font, color: rgb(0.1, 0.15, 0.55) });
			return;
		case 'red-stamp':
			body(p, font, bold);
			p.drawEllipse({ x: 470, y: 120, xScale: 60, yScale: 40, borderColor: rgb(0.8, 0.15, 0.15), borderWidth: 3, opacity: 0, borderOpacity: 0.85 });
			p.drawText('PAID', { x: 440, y: 112, size: 22, font: bold, color: rgb(0.8, 0.15, 0.15), opacity: 0.85 });
			return;
		case 'faint-stamp':
			body(p, font, bold);
			p.drawRectangle({ x: 380, y: 90, width: 170, height: 60, borderColor: rgb(0.78, 0.78, 0.78), borderWidth: 2.5 });
			p.drawText('RECEIVED', { x: 395, y: 110, size: 24, font: bold, color: rgb(0.78, 0.78, 0.78) });
			return;
		case 'highlighter':
			body(p, font, bold);
			p.drawRectangle({ x: 48, y: PH - 50 - 14 - 1 * 16.5 - 3, width: 420, height: 13, color: rgb(1, 0.95, 0.2), opacity: 0.45 });
			return;
		case 'grey-highlighter':
			body(p, font, bold);
			p.drawRectangle({ x: 48, y: PH - 50 - 14 - 1 * 16.5 - 3, width: 420, height: 13, color: rgb(0.75, 0.75, 0.75), opacity: 0.6 });
			return;
		case 'shaded-form': {
			body(p, font, bold, { top: PH - 40 });
			const boxes: [number, number, number, number, number][] = [
				[50, 150, 250, 40, 0.85],
				[320, 150, 240, 40, 0.92],
				[50, 90, 510, 40, 0.88]
			];
			for (const [x, y, w, h, g] of boxes) {
				p.drawRectangle({ x, y, width: w, height: h, color: rgb(g, g, g), borderColor: rgb(0, 0, 0), borderWidth: 0.6 });
				p.drawText('FOR OFFICE USE ONLY', { x: x + 6, y: y + h - 12, size: 8, font });
			}
			return;
		}
		default:
			body(p, font, bold);
	}
}

interface Traits {
	ppi: number;
	paper: [number, number, number];
	ink: number;
	blur: number;
	noise: number;
	quality: number;
	/** Light falls from 1 to this at the far corner. */
	light: number;
	grey: boolean;
	photo: boolean;
}

const base: Traits = { ppi: 300, paper: [240, 239, 236], ink: 22, blur: 1, noise: 3, quality: 75, light: 1, grey: false, photo: false };

export const CASES: (HardCase & { traits?: Partial<Traits> })[] = [
	{ name: 'clean', expect: 'accept', note: 'typed page, ordinary scanner traits' },
	{ name: 'clean-200', expect: 'accept', note: 'the same at 200 ppi', traits: { ppi: 200 } },
	{ name: 'clean-grey', expect: 'accept', note: 'stored as a grey JPEG', traits: { grey: true } },
	{ name: 'yellowed-paper', expect: 'accept', note: 'beige paper (an old page), black ink', traits: { paper: [236, 222, 190] } },
	{ name: 'low-contrast', expect: 'either', note: 'faded copy: ink 90 on paper 215', traits: { paper: [215, 215, 213], ink: 90 } },
	{ name: 'noisy', expect: 'either', note: 'heavy noise and blur, JPEG 50', traits: { noise: 9, blur: 1.6, quality: 50 } },
	{ name: 'dark-grey-text', expect: 'accept', note: 'all text in dark grey (0.35): becomes black, reads the same' },
	{ name: 'black-signature', expect: 'accept', note: 'black pen signature on a line' },
	{ name: 'small-print', expect: 'either', note: '4.5 pt fine print block' },
	{ name: 'light-grey-text', expect: 'refuse', note: 'two lines printed in light grey (0.68–0.7)' },
	{ name: 'pencil-signature', expect: 'refuse', note: 'pencil signature (grey 0.58, thin)' },
	{ name: 'pencil-tick', expect: 'refuse', note: 'a small pencil tick mark' },
	{ name: 'faint-stamp', expect: 'refuse', note: 'a light grey RECEIVED stamp (0.78)' },
	{ name: 'blue-pen', expect: 'refuse', note: 'dark blue pen signature and date' },
	{ name: 'red-stamp', expect: 'refuse', note: 'red PAID stamp' },
	{ name: 'highlighter', expect: 'refuse', note: 'yellow highlighter over a line' },
	{ name: 'grey-highlighter', expect: 'refuse', note: 'grey highlighter (a grey band) over a line' },
	{ name: 'shaded-form', expect: 'refuse', note: 'form boxes shaded 0.85–0.92' },
	{ name: 'photo', expect: 'refuse', note: 'a colour photo on the page', traits: { photo: true } },
	{ name: 'photo-grey', expect: 'refuse', note: 'a photo on a grey scan', traits: { photo: true, grey: true } },
	{ name: 'uneven-light', expect: 'refuse', note: 'phone-style light falling to 0.6 at a corner', traits: { light: 0.6 } },
	{ name: 'mild-uneven-light', expect: 'either', note: 'light falling to 0.85 at a corner', traits: { light: 0.85 } }
];

function blurInPlace(px: Float32Array, w: number, h: number, n: number, sigma: number) {
	if (sigma <= 0) return;
	const r = Math.ceil(sigma * 2.5);
	const k = Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
	const s = k.reduce((a, b) => a + b, 0);
	for (let i = 0; i < k.length; i++) k[i] /= s;
	const tmp = new Float32Array(px.length);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			for (let c = 0; c < n; c++) {
				let v = 0;
				for (let i = -r; i <= r; i++) v += k[i + r] * px[(y * w + Math.min(w - 1, Math.max(0, x + i))) * n + c];
				tmp[(y * w + x) * n + c] = v;
			}
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++)
			for (let c = 0; c < n; c++) {
				let v = 0;
				for (let i = -r; i <= r; i++) v += k[i + r] * tmp[(Math.min(h - 1, Math.max(0, y + i)) * w + x) * n + c];
				px[(y * w + x) * n + c] = v;
			}
}

async function build(c: (typeof CASES)[number]): Promise<Uint8Array> {
	const t: Traits = { ...base, ...c.traits };
	const vec = await PDFDocument.create();
	const p = vec.addPage([PW, PH]);
	await draw(c.name.replace(/-200$|-grey$/, '').replace(/^clean.*/, 'clean'), vec, p);
	const vbytes = await vec.save();
	const md = m.Document.openDocument(vbytes, 'application/pdf');
	const pg = md.loadPage(0);
	const pix = pg.toPixmap(m.Matrix.scale(t.ppi / 72, t.ppi / 72), m.ColorSpace.DeviceRGB, false, true);
	const w = pix.getWidth();
	const h = pix.getHeight();
	const stride = pix.getStride();
	const src = pix.getPixels();
	const f = new Float32Array(w * h * 3);
	for (let y = 0; y < h; y++) for (let x = 0; x < w * 3; x++) f[y * w * 3 + x] = src[y * stride + x];
	pix.destroy();
	pg.destroy();
	md.destroy();
	// Photo patch (2 × 1.4 in) at the lower right.
	if (t.photo) {
		const rnd = prng(5);
		const pw = Math.round(2 * t.ppi);
		const ph = Math.round(1.4 * t.ppi);
		const ox = w - pw - Math.round(0.6 * t.ppi);
		const oy = h - ph - Math.round(0.4 * t.ppi);
		const discs = Array.from({ length: 6 }, () => [rnd() * pw, rnd() * ph, (0.08 + rnd() * 0.2) * pw, rnd() * 255, rnd() * 255, rnd() * 255]);
		for (let y = 0; y < ph; y++)
			for (let x = 0; x < pw; x++) {
				let r = 40 + (180 * x) / pw;
				let g = 60 + (150 * y) / ph;
				let b = 160 - (100 * (x + y)) / (pw + ph);
				for (const [cx, cy, rad, cr, cg, cb] of discs) {
					const d = Math.hypot(x - cx, y - cy) / rad;
					if (d < 1) {
						const k = (1 - d * d) * 0.8;
						r += (cr - r) * k;
						g += (cg - g) * k;
						b += (cb - b) * k;
					}
				}
				const o = ((oy + y) * w + ox + x) * 3;
				f[o] = r;
				f[o + 1] = g;
				f[o + 2] = b;
			}
	}
	// Ink and paper levels: white → paper colour, black → ink.
	for (let i = 0; i < w * h; i++)
		for (let k = 0; k < 3; k++) {
			const v = f[i * 3 + k] / 255;
			f[i * 3 + k] = t.ink + v * (t.paper[k] - t.ink);
		}
	blurInPlace(f, w, h, 3, t.blur);
	const rnd = prng(c.name.length * 7919 + 1);
	const n = t.grey ? 1 : 3;
	const out = new Uint8Array(w * h * n);
	for (let y = 0; y < h; y++)
		for (let x = 0; x < w; x++) {
			const light = 1 - (1 - t.light) * Math.min(1, Math.hypot(x / w, y / h) / Math.SQRT2) ** 1.5;
			const noise = (rnd() + rnd() + rnd() - 1.5) * 2 * t.noise;
			const i = y * w + x;
			if (n === 1) {
				const g = 0.299 * f[i * 3] + 0.587 * f[i * 3 + 1] + 0.114 * f[i * 3 + 2];
				out[i] = Math.max(0, Math.min(255, Math.round(g * light + noise)));
			} else for (let k = 0; k < 3; k++) out[i * 3 + k] = Math.max(0, Math.min(255, Math.round(f[i * 3 + k] * light + noise)));
		}
	const jp = new m.Pixmap(n === 1 ? m.ColorSpace.DeviceGray : m.ColorSpace.DeviceRGB, [0, 0, w, h], false);
	jp.getPixels().set(out);
	const jpeg = jp.asJPEG(t.quality).slice();
	jp.destroy();
	const doc = await PDFDocument.create();
	const page = doc.addPage([PW, PH]);
	const ref = doc.context.register(
		doc.context.stream(jpeg, { Type: 'XObject', Subtype: 'Image', Width: w, Height: h, ColorSpace: n === 1 ? 'DeviceGray' : 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' })
	);
	const name = page.node.newXObject('Scan', ref);
	const content = doc.context.register(doc.context.flateStream(`q ${PW} 0 0 ${PH} 0 0 cm ${name.asString()} Do Q`));
	page.node.set(PDFName.of('Contents'), content);
	return doc.save({ useObjectStreams: false });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
	const out = process.argv[2];
	if (!out) throw new Error('usage: hard.ts OUTDIR');
	fs.mkdirSync(out, { recursive: true });
	for (const c of CASES) {
		const bytes = await build(c);
		fs.writeFileSync(path.join(out, `${c.name}.pdf`), bytes);
		console.log(`${c.name}: ${(bytes.length / 1024).toFixed(0)} KB`);
	}
	fs.writeFileSync(path.join(out, 'cases.json'), JSON.stringify(CASES.map(({ name, expect, note }) => ({ name, expect, note })), null, 1));
}
