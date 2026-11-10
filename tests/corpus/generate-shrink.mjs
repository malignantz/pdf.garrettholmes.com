#!/usr/bin/env node
// @ts-nocheck -- plain Node script like generate.mjs (which tsconfig excludes)
/**
 * Corpus for the compress-to-target-size stage (src/lib/engine/shrink.ts).
 *
 * Called from generate.mjs (one line), or run on its own to (re)write only these files:
 *   node tests/corpus/generate-shrink.mjs
 * which merges their entries into the existing manifest.json.
 *
 * Images are drawn with pdf-lib's low-level API so every kind the stage must
 * handle or skip is present exactly as a real file would carry it. JPEGs are
 * encoded by MuPDF (deterministic). Every page carries a Helvetica label
 * "<label> p<N>" so tests can check that text survives byte-for-byte.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFHexString, PDFName, PDFRawStream, StandardFonts } from '@cantoo/pdf-lib';

const m = await import('mupdf');

// --- pixels --------------------------------------------------------------------------
function prng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Photo-like RGB: smooth gradients, soft discs, sensor-like noise. */
export function photoRgb(w, h, seed = 1) {
	const rnd = prng(seed);
	const px = new Uint8Array(w * h * 3);
	const discs = Array.from({ length: 6 }, () => [rnd() * w, rnd() * h, (0.08 + rnd() * 0.2) * w, [rnd() * 255, rnd() * 255, rnd() * 255]]);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let r = 40 + (180 * x) / w;
			let g = 60 + (150 * y) / h;
			let b = 160 - (100 * (x + y)) / (w + h);
			for (const [cx, cy, rad, c] of discs) {
				const d = Math.hypot(x - cx, y - cy) / rad;
				if (d < 1) {
					const k = (1 - d * d) * 0.8;
					r += (c[0] - r) * k;
					g += (c[1] - g) * k;
					b += (c[2] - b) * k;
				}
			}
			const n = (rnd() - 0.5) * 10;
			const o = (y * w + x) * 3;
			px[o] = clamp(r + n);
			px[o + 1] = clamp(g + n);
			px[o + 2] = clamp(b + n);
		}
	}
	return px;
}

/** A grey "scan": paper noise, dark text-like strokes, a grey photo block. */
export function scanGray(w, h, seed = 2) {
	const rnd = prng(seed);
	const px = new Uint8Array(w * h);
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			let v = 236 + (rnd() - 0.5) * 14;
			const line = Math.floor(y / 18);
			if (y % 18 < 9 && x > 40 && x < w - 40 && ((x * 7 + line * 13) % 23) < 15 && line % 6 !== 5) v = 40 + rnd() * 30;
			if (x > w * 0.55 && x < w * 0.9 && y > h * 0.6 && y < h * 0.85) v = 90 + 80 * Math.sin(x / 17) * Math.cos(y / 23) + (rnd() - 0.5) * 20;
			px[y * w + x] = clamp(v);
		}
	}
	return px;
}

/** Flat-colour line art (a screenshot or chart): few exact colours, hard edges, text-like runs. */
export function lineArtRgb(w, h) {
	const px = new Uint8Array(w * h * 3);
	const palette = [
		[255, 255, 255],
		[30, 30, 30],
		[0, 102, 204],
		[230, 230, 230],
		[200, 40, 40]
	];
	const rnd = prng(7);
	const words = Array.from({ length: 4096 }, () => 8 + Math.floor(rnd() * 40));
	for (let y = 0; y < h; y++) {
		const line = Math.floor(y / 14);
		for (let x = 0; x < w; x++) {
			let c = 0;
			if (y < 40) c = 2;
			else if (x < 120) c = 3;
			else if (y % 14 < 9) {
				// "Words": dark runs of varying length with gaps, glyph-like vertical strokes.
				let pos = 130;
				let k = line * 37;
				while (pos + words[k % 4096] < x) pos += words[k++ % 4096] + 6;
				if (x - pos < words[k % 4096] && x < w - 20 && (x + y * 3) % 5 !== 0) c = 1;
			}
			if (x > w - 160 && x < w - 40 && y > h - 160 && y < h - 40) c = 4;
			px.set(palette[c], (y * w + x) * 3);
		}
	}
	return px;
}

function clamp(v) {
	return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** JPEG bytes via MuPDF for 1 (grey), 3 (RGB) or 4 (CMYK) components. */
export function jpeg(px, w, h, n, quality) {
	const cs = n === 1 ? m.ColorSpace.DeviceGray : n === 3 ? m.ColorSpace.DeviceRGB : m.ColorSpace.DeviceCMYK;
	const pix = new m.Pixmap(cs, [0, 0, w, h], false);
	pix.getPixels().set(px);
	const out = pix.asJPEG(quality).slice();
	pix.destroy();
	return out;
}

// --- ICC: a minimal v2 matrix/TRC RGB profile (ProPhoto primaries, gamma 1.8) ----------
// Wide-gamut on purpose: the same numbers read as plain DeviceRGB look visibly different,
// so a re-encode that lost the profile would fail the render comparison.
export function wideGamutIcc() {
	const s15 = (v) => {
		const b = Buffer.alloc(4);
		b.writeInt32BE(Math.round(v * 65536));
		return b;
	};
	const xyz = (x, y, z) => Buffer.concat([Buffer.from('XYZ '), Buffer.alloc(4), s15(x), s15(y), s15(z)]);
	const curv = (gamma) => {
		const b = Buffer.alloc(14);
		b.write('curv', 0);
		b.writeUInt32BE(1, 8);
		b.writeUInt16BE(Math.round(gamma * 256), 12);
		return Buffer.concat([b, Buffer.alloc(2)]);
	};
	const desc = (() => {
		const text = 'Corpus wide RGB\0';
		const head = Buffer.alloc(12);
		head.write('desc', 0);
		head.writeUInt32BE(text.length, 8);
		return Buffer.concat([head, Buffer.from(text, 'latin1'), Buffer.alloc(4 + 4 + 2 + 1 + 67)]);
	})();
	const cprt = Buffer.concat([Buffer.from('text'), Buffer.alloc(4), Buffer.from('No copyright\0', 'latin1')]);
	const tags = [
		['desc', desc],
		['cprt', cprt],
		['wtpt', xyz(0.9642, 1.0, 0.8249)],
		['rXYZ', xyz(0.7977, 0.288, 0.0)],
		['gXYZ', xyz(0.1352, 0.7119, 0.0)],
		['bXYZ', xyz(0.0313, 0.0001, 0.8249)],
		['rTRC', curv(1.8)],
		['gTRC', curv(1.8)],
		['bTRC', curv(1.8)]
	];
	const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
	let offset = 128 + 4 + tags.length * 12;
	const table = Buffer.alloc(4 + tags.length * 12);
	table.writeUInt32BE(tags.length, 0);
	const bodies = [];
	tags.forEach(([sig, body], i) => {
		table.write(sig, 4 + i * 12, 'latin1');
		table.writeUInt32BE(offset, 8 + i * 12);
		table.writeUInt32BE(body.length, 12 + i * 12);
		const padded = pad4(body);
		bodies.push(padded);
		offset += padded.length;
	});
	const header = Buffer.alloc(128);
	header.writeUInt32BE(offset, 0);
	header.writeUInt32BE(0x02100000, 8);
	header.write('mntr', 12);
	header.write('RGB ', 16);
	header.write('XYZ ', 20);
	header.writeUInt16BE(2026, 24);
	header.writeUInt16BE(1, 26);
	header.writeUInt16BE(1, 28);
	header.write('acsp', 36);
	s15(0.9642).copy(header, 68);
	s15(1.0).copy(header, 72);
	s15(0.8249).copy(header, 76);
	return Buffer.concat([header, table, ...bodies]);
}

// --- PDF building ----------------------------------------------------------------------
class Builder {
	static async create(label) {
		const b = new Builder();
		b.label = label;
		b.doc = await PDFDocument.create({ updateMetadata: false });
		b.font = await b.doc.embedFont(StandardFonts.Helvetica);
		return b;
	}

	/** Registers an image XObject and returns its ref. */
	image(data, entries) {
		const ctx = this.doc.context;
		const dict = ctx.obj({ Type: 'XObject', Subtype: 'Image', ...entries });
		return ctx.register(PDFRawStream.of(dict, data));
	}

	flateImage(px, w, h, n, extra = {}) {
		return this.image(zlib.deflateSync(Buffer.from(px), { level: 9 }), {
			Width: w,
			Height: h,
			BitsPerComponent: 8,
			ColorSpace: n === 1 ? 'DeviceGray' : 'DeviceRGB',
			Filter: 'FlateDecode',
			...extra
		});
	}

	jpegImage(px, w, h, n, quality, extra = {}) {
		return this.image(jpeg(px, w, h, n, quality), {
			Width: w,
			Height: h,
			BitsPerComponent: 8,
			ColorSpace: n === 1 ? 'DeviceGray' : n === 3 ? 'DeviceRGB' : 'DeviceCMYK',
			Filter: 'DCTDecode',
			...extra
		});
	}

	/** Form XObject that draws `inner` (name → ref) with `content`. */
	form(content, xobjects, matrix, bbox) {
		const ctx = this.doc.context;
		const xo = {};
		for (const [k, v] of Object.entries(xobjects)) xo[k] = v;
		const data = Buffer.from(content, 'latin1');
		const dict = ctx.obj({
			Type: 'XObject',
			Subtype: 'Form',
			BBox: bbox,
			Matrix: matrix,
			Resources: { XObject: xo }
		});
		return ctx.register(PDFRawStream.of(dict, data));
	}

	/**
	 * A page. `draws`: [ref, [a b c d e f]] in points. The label is drawn last so
	 * text sits on top of the images.
	 */
	page(draws, size = [612, 792], rotate = 0) {
		const page = this.doc.addPage(size);
		if (rotate) page.setRotation({ type: 'degrees', angle: rotate });
		const n = this.doc.getPageCount();
		let ops = '';
		draws.forEach(([ref, mtx], i) => {
			page.node.setXObject(PDFName.of(`Im${i}`), ref);
			ops += `q ${mtx.join(' ')} cm /Im${i} Do Q\n`;
		});
		const content = this.doc.context.register(PDFRawStream.of(this.doc.context.obj({}), Buffer.from(ops, 'latin1')));
		page.node.addContentStream(content);
		page.drawText(`${this.label} p${n}`, { x: 36, y: size[1] - 30, size: 12, font: this.font });
		return page;
	}

	save() {
		return this.doc.save({ useObjectStreams: false, addDefaultPage: false });
	}
}

/** Content matrix that draws an image `wIn` × `hIn` inches at (x, y) points. */
const at = (wIn, hIn, x, y) => [wIn * 72, 0, 0, hIn * 72, x, y];

/** Images the stage should reduce (photo-like, plain 8-bit grey/RGB). */
async function shrinkPhotos() {
	const b = await Builder.create('photos');
	const jpg = b.jpegImage(photoRgb(360, 270, 11), 360, 270, 3, 92);
	// p1: RGB JPEG at 300 ppi (1.2 × 0.9 in).
	b.page([[jpg, at(1.2, 0.9, 72, 600)]]);
	// p2: Flate RGB photo at 300 ppi.
	b.page([[b.flateImage(photoRgb(300, 225, 12), 300, 225, 3), at(1, 0.75, 72, 600)]]);
	// p3: grey scan (JPEG) at 300 ppi.
	b.page([[b.jpegImage(scanGray(450, 600, 13), 450, 600, 1, 90), at(1.5, 2, 72, 400)]]);
	// p4: rotated page with a photo at 300 ppi.
	b.page([[b.jpegImage(photoRgb(300, 225, 14), 300, 225, 3, 92), at(1, 0.75, 100, 400)]], [612, 792], 90);
	// p5: one image drawn twice: small (0.5 in) and large (1.6 in wide) → 225 ppi at its largest.
	const twice = b.jpegImage(photoRgb(360, 270, 15), 360, 270, 3, 92);
	b.page([
		[twice, at(0.5, 0.375, 72, 650)],
		[twice, at(1.6, 1.2, 72, 400)]
	]);
	// p6–p8: the p1 image reused on three more pages.
	for (let i = 0; i < 3; i++) b.page([[jpg, at(1.2, 0.9, 72 + i * 40, 500)]]);
	// p9: an image only reachable through a Form XObject (scaled by the form's /Matrix) at 300 ppi.
	const inForm = b.jpegImage(photoRgb(300, 225, 16), 300, 225, 3, 92);
	const form = b.form('q 1 0 0 1 0 0 cm /F0 Do Q', { F0: inForm }, [72, 0, 0, 54, 0, 0], [0, 0, 1, 1]);
	b.page([[form, [1, 0, 0, 1, 72, 500]]]);
	// p10: ICC-profiled (wide gamut) RGB JPEG at 300 ppi.
	const icc = b.doc.context.register(PDFRawStream.of(b.doc.context.obj({ N: 3, Alternate: 'DeviceRGB' }), wideGamutIcc()));
	const iccArr = b.doc.context.obj(['ICCBased', icc]);
	b.page([[b.jpegImage(photoRgb(360, 270, 17), 360, 270, 3, 92, { ColorSpace: iccArr }), at(1.2, 0.9, 72, 500)]]);
	// p11: Flate photo with a soft mask (alpha gradient at half the resolution) at 300 ppi.
	const smaskPx = new Uint8Array(150 * 112);
	for (let y = 0; y < 112; y++) for (let x = 0; x < 150; x++) smaskPx[y * 150 + x] = clamp(40 + (x / 149) * 215);
	const smask = b.flateImage(smaskPx, 150, 112, 1);
	b.page([[b.flateImage(photoRgb(300, 225, 18), 300, 225, 3, { SMask: smask }), at(1, 0.75, 72, 500)]]);
	// p12: flat-colour line art (screenshot) saved as Flate, 300 ppi.
	b.page([[b.flateImage(lineArtRgb(900, 600), 900, 600, 3), at(3, 2, 72, 400)]]);
	return b.save();
}

/** Images the stage must leave byte-identical. */
async function shrinkSkips() {
	const b = await Builder.create('skips');
	// p1: 1-bit scan (Flate), 300 ppi.
	{
		const w = 600,
			h = 750;
		const row = Math.ceil(w / 8);
		const bits = new Uint8Array(row * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (y % 30 > 20 || (x * 5 + y) % 47 < 30) bits[y * row + (x >> 3)] |= 0x80 >> (x & 7);
		const ref = b.image(zlib.deflateSync(Buffer.from(bits)), {
			Width: w,
			Height: h,
			BitsPerComponent: 1,
			ColorSpace: 'DeviceGray',
			Filter: 'FlateDecode'
		});
		b.page([[ref, at(2, 2.5, 72, 300)]]);
	}
	// p2: CMYK JPEG at 300 ppi.
	{
		const w = 300,
			h = 225;
		const rgb = photoRgb(w, h, 21);
		const cmyk = new Uint8Array(w * h * 4);
		for (let i = 0; i < w * h; i++) {
			const r = rgb[i * 3] / 255,
				g = rgb[i * 3 + 1] / 255,
				bl = rgb[i * 3 + 2] / 255;
			const k = 1 - Math.max(r, g, bl);
			const d = 1 - k || 1;
			cmyk.set([clamp(((1 - r - k) / d) * 255), clamp(((1 - g - k) / d) * 255), clamp(((1 - bl - k) / d) * 255), clamp(k * 255)], i * 4);
		}
		b.page([[b.jpegImage(cmyk, w, h, 4, 90), at(1, 0.75, 72, 500)]]);
	}
	// p3: indexed (palette) logo, 300 ppi.
	{
		const w = 300,
			h = 150;
		const idx = new Uint8Array(w * h);
		for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) idx[y * w + x] = ((x >> 5) + (y >> 5)) % 4;
		const lookup = PDFHexString.of(Buffer.from([255, 255, 255, 0, 80, 160, 220, 40, 40, 20, 20, 20]).toString('hex'));
		const pal = b.doc.context.obj(['Indexed', 'DeviceRGB', 3, lookup]);
		const ref = b.image(zlib.deflateSync(Buffer.from(idx)), { Width: w, Height: h, BitsPerComponent: 8, ColorSpace: pal, Filter: 'FlateDecode' });
		b.page([[ref, at(1, 0.5, 72, 500)]]);
	}
	// p4: tiny icons (32×32 RGB photo-like), drawn small.
	{
		const icon = b.flateImage(photoRgb(32, 32, 22), 32, 32, 3);
		b.page([
			[icon, at(0.05, 0.05, 72, 600)],
			[icon, at(0.05, 0.05, 120, 600)]
		]);
	}
	// p5: colour-key mask, explicit stencil mask, and an image mask, all at 300 ppi.
	{
		const keyed = b.flateImage(photoRgb(300, 225, 23), 300, 225, 3, { Mask: [0, 10, 0, 10, 0, 10] });
		const stencilBits = new Uint8Array(38 * 225).fill(0x0f);
		const stencil = b.image(zlib.deflateSync(Buffer.from(stencilBits)), {
			Width: 300,
			Height: 225,
			ImageMask: true,
			BitsPerComponent: 1,
			Filter: 'FlateDecode'
		});
		const masked = b.jpegImage(photoRgb(300, 225, 24), 300, 225, 3, 92, { Mask: stencil });
		b.page([
			[keyed, at(1, 0.75, 72, 600)],
			[masked, at(1, 0.75, 72, 400)],
			[stencil, at(1, 0.75, 320, 400)]
		]);
	}
	// p6: 16-bit RGB and a /Decode-inverted grey image, 300 ppi.
	{
		const w = 240,
			h = 180;
		const px16 = new Uint8Array(w * h * 6);
		const base = photoRgb(w, h, 25);
		for (let i = 0; i < w * h * 3; i++) {
			px16[i * 2] = base[i];
			px16[i * 2 + 1] = base[i];
		}
		const deep = b.image(zlib.deflateSync(Buffer.from(px16)), { Width: w, Height: h, BitsPerComponent: 16, ColorSpace: 'DeviceRGB', Filter: 'FlateDecode' });
		const inverted = b.jpegImage(scanGray(w, h, 26), w, h, 1, 90, { Decode: [1, 0] });
		b.page([
			[deep, at(0.8, 0.6, 72, 600)],
			[inverted, at(0.8, 0.6, 72, 400)]
		]);
	}
	return b.save();
}

async function shrinkText() {
	const b = await Builder.create('text');
	for (let i = 0; i < 3; i++) {
		const page = b.doc.addPage([612, 792]);
		page.drawText(`text p${i + 1}`, { x: 36, y: 762, size: 12, font: b.font });
		for (let l = 0; l < 40; l++) page.drawText(`Line ${l}: plain text only, nothing to shrink here.`, { x: 36, y: 720 - l * 16, size: 10, font: b.font });
	}
	return b.save();
}

/** Writes the shrink corpus through `write(name, bytes, meta)`. */
export default async function generateShrinkCorpus(write) {
	write('shrink-photos.pdf', await shrinkPhotos(), {
		pages: 12,
		label: 'photos',
		note: 'p1 RGB JPEG 300ppi; p2 Flate RGB photo; p3 grey scan JPEG; p4 rotated; p5 one image at two sizes; p6-8 reuse p1 image; p9 image in a Form XObject; p10 ICC wide-gamut JPEG; p11 Flate photo with SMask; p12 flat line art (Flate)'
	});
	write('shrink-skips.pdf', await shrinkSkips(), {
		pages: 6,
		label: 'skips',
		note: 'p1 1-bit scan; p2 CMYK JPEG; p3 Indexed; p4 tiny icons; p5 colour-key /Mask, stencil /Mask, ImageMask; p6 16-bit and /Decode [1 0]'
	});
	write('shrink-text.pdf', await shrinkText(), { pages: 3, label: 'text' });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateShrinkCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
