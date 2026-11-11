#!/usr/bin/env node
/**
 * Builds the engine test corpus in tests/corpus/files/. Run: node tests/corpus/generate.mjs
 *
 * Uses only pdf-lib and the qpdf WebAssembly build from node_modules (no system tools),
 * plus small built-in JPEG and PNG encoders. Output is deterministic except for the
 * encrypted files: qpdf draws random keys and salts for encryption.
 *
 * Every page carries a text label "<name> p<N>" in Helvetica so tests can check page
 * order by extracting text. manifest.json records what each file is meant to be.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
	PDFDocument,
	PDFName,
	PDFNumber,
	PDFArray,
	StandardFonts,
	rgb
} from '@cantoo/pdf-lib';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'files');
fs.mkdirSync(outDir, { recursive: true });

const createQpdf = require('@neslinesli93/qpdf-wasm');
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');

async function qpdf(args, inputs) {
	const err = [];
	const q = await createQpdf({
		locateFile: () => wasmPath,
		noInitialRun: true,
		preRun: [(m) => m.FS.init(() => null, () => {}, (c) => c !== null && err.push(c))]
	});
	for (const [p, d] of Object.entries(inputs)) q.FS.writeFile(p, d);
	const saved = process.exitCode;
	const code = q.callMain([...args]);
	process.exitCode = saved;
	let out = null;
	try {
		out = q.FS.readFile('/out.pdf');
	} catch {
		// none
	}
	if (code !== 0 && code !== 3) throw new Error(`qpdf ${args.join(' ')} failed (${code}): ${Buffer.from(err).toString()}`);
	return out;
}

const manifest = {};
function write(name, bytes, meta) {
	fs.writeFileSync(path.join(outDir, name), bytes);
	manifest[name] = meta;
}

async function newDoc() {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	return { doc, font };
}

function label(page, font, text) {
	const { width, height } = page.getSize();
	const size = Math.max(6, Math.min(18, width / 12, height / 6));
	const box = page.getCropBox();
	page.drawText(text, { x: box.x + 6, y: box.y + box.height - size - 4, size, font, color: rgb(0, 0, 0) });
	// Corner marker: a small filled square at the media box's top-left, to spot orientation.
	page.drawRectangle({ x: box.x, y: box.y + box.height - 4, width: 4, height: 4, color: rgb(1, 0, 0) });
}

async function save(doc, opts = {}) {
	return doc.save({ useObjectStreams: false, addDefaultPage: false, ...opts });
}

// --- multi.pdf: 6 Letter pages -------------------------------------------------------
async function multi(name = 'multi', count = 6) {
	const { doc, font } = await newDoc();
	for (let i = 1; i <= count; i++) label(doc.addPage([612, 792]), font, `${name} p${i}`);
	return save(doc);
}

// --- sizes.pdf -------------------------------------------------------------------------
const SIZES = [
	[612, 792],
	[595.28, 841.89],
	[612, 1008],
	[595.28, 419.53],
	[100, 60],
	[1224, 792]
];
async function sizes() {
	const { doc, font } = await newDoc();
	SIZES.forEach(([w, h], i) => label(doc.addPage([w, h]), font, `sizes p${i + 1}`));
	return save(doc);
}

// --- rotated.pdf -----------------------------------------------------------------------
const ROTATES = [0, 90, 180, 270, -90, 450];
async function rotated() {
	const { doc, font } = await newDoc();
	ROTATES.forEach((r, i) => {
		const p = doc.addPage([400, 600]);
		label(p, font, `rotated p${i + 1}`);
		p.node.set(PDFName.of('Rotate'), PDFNumber.of(r));
	});
	return save(doc);
}

// --- inherited.pdf: MediaBox, Rotate and Resources on the Pages node --------------------
async function inherited() {
	const { doc, font } = await newDoc();
	for (let i = 1; i <= 3; i++) label(doc.addPage([300, 500]), font, `inherited p${i}`);
	const pagesDict = doc.catalog.Pages();
	pagesDict.set(PDFName.of('MediaBox'), doc.context.obj([0, 0, 300, 500]));
	pagesDict.set(PDFName.of('Rotate'), PDFNumber.of(90));
	const first = doc.getPages()[0].node;
	pagesDict.set(PDFName.of('Resources'), first.get(PDFName.of('Resources')));
	doc.getPages().forEach((p, i) => {
		p.node.delete(PDFName.of('MediaBox'));
		p.node.delete(PDFName.of('Resources'));
		if (i === 2) p.node.set(PDFName.of('Rotate'), PDFNumber.of(0));
	});
	// All three pages draw with the same font resource name, so sharing works.
	return save(doc);
}

// --- cropbox.pdf -----------------------------------------------------------------------
const CROPS = [
	{ media: [0, 0, 612, 792], crop: [36, 72, 456, 672], rotate: 0 },
	{ media: [100, 200, 712, 992], crop: [150, 250, 500, 700], rotate: 0 },
	{ media: [0, 0, 612, 792], crop: [36, 72, 456, 672], rotate: 90 },
	{ media: [0, 0, 400, 400], crop: [-50, -50, 700, 900], rotate: 0 },
	{ media: [100, 200, 712, 992], crop: [150, 250, 500, 700], rotate: 270 },
	{ media: [0, 0, 612, 792], crop: [456, 672, 36, 72], rotate: 180 }
];
async function cropbox() {
	const { doc, font } = await newDoc();
	CROPS.forEach((c, i) => {
		const p = doc.addPage([612, 792]);
		p.node.set(PDFName.of('MediaBox'), doc.context.obj(c.media));
		p.node.set(PDFName.of('CropBox'), doc.context.obj(c.crop));
		if (c.rotate) p.node.set(PDFName.of('Rotate'), PDFNumber.of(c.rotate));
		label(p, font, `cropbox p${i + 1}`);
	});
	return save(doc);
}

// --- unbalanced.pdf: content that leaves graphics state changed ------------------------
async function unbalanced() {
	const { doc, font } = await newDoc();
	const contents = [
		'1 0 0 1 100 100 cm', // cm with no q at all
		'q q 0.5 0 0 0.5 0 0 cm', // two unclosed q
		'Q Q 1 0 0 1 50 -50 cm', // pops below zero, then cm
		'q (a \\) Q q string) Tj % comment Q q\n Q' // q/Q inside a string and a comment
	];
	contents.forEach((ops, i) => {
		const p = doc.addPage([400, 400]);
		label(p, font, `unbalanced p${i + 1}`);
		const extra = doc.context.register(doc.context.flateStream(ops));
		const arr = p.node.get(PDFName.of('Contents'));
		if (arr instanceof PDFArray) arr.push(extra);
		else p.node.set(PDFName.of('Contents'), doc.context.obj([arr, extra]));
	});
	return save(doc);
}

// --- userunit.pdf ---------------------------------------------------------------------
async function userunit() {
	const { doc, font } = await newDoc();
	const p = doc.addPage([300, 200]);
	label(p, font, 'userunit p1');
	p.node.set(PDFName.of('UserUnit'), PDFNumber.of(2));
	return save(doc);
}

// --- form.pdf: AcroForm ----------------------------------------------------------------
async function form() {
	const { doc, font } = await newDoc();
	const p1 = doc.addPage([612, 792]);
	const p2 = doc.addPage([612, 792]);
	label(p1, font, 'form p1');
	label(p2, font, 'form p2');
	const f = doc.getForm();
	const name = f.createTextField('name');
	name.setText('Ada Lovelace');
	name.addToPage(p1, { x: 72, y: 600, width: 300, height: 24, font });
	const agree = f.createCheckBox('agree');
	agree.addToPage(p1, { x: 72, y: 560, width: 18, height: 18 });
	agree.check();
	const notes = f.createTextField('notes');
	notes.addToPage(p2, { x: 72, y: 600, width: 300, height: 24, font });
	return save(doc);
}

// --- metadata.pdf ----------------------------------------------------------------------
async function metadata() {
	const { doc, font } = await newDoc();
	const p = doc.addPage([612, 792]);
	label(p, font, 'metadata p1');
	label(doc.addPage([612, 792]), font, 'metadata p2');
	doc.setTitle('Quarterly secrets');
	doc.setAuthor('Jane Doe');
	doc.setSubject('Private subject');
	doc.setKeywords(['alpha', 'beta']);
	doc.setCreator('Corpus generator');
	doc.setProducer('Corpus generator');
	const xmp = (who) =>
		`<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>${who}</dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
	const docXmp = doc.context.register(doc.context.stream(xmp('Jane Doe'), { Type: 'Metadata', Subtype: 'XML' }));
	doc.catalog.set(PDFName.of('Metadata'), docXmp);
	const pageXmp = doc.context.register(doc.context.stream(xmp('Page author'), { Type: 'Metadata', Subtype: 'XML' }));
	p.node.set(PDFName.of('Metadata'), pageXmp);
	p.node.set(PDFName.of('PieceInfo'), doc.context.obj({ Corpus: { Private: { Data: 'app data' } } }));
	return save(doc);
}

// --- damaged xref ----------------------------------------------------------------------
// Typical real-world damage: the xref table is garbled and startxref points nowhere.
async function damaged() {
	const bytes = await multi('damaged', 3);
	const text = Buffer.from(bytes).toString('latin1');
	const start = text.lastIndexOf('\nxref');
	const end = text.indexOf('trailer', start);
	const section = text.slice(start, end).replace(/\d/g, (d, i) => (i % 3 ? 'x' : d));
	const broken = text.slice(0, start) + section + text.slice(end);
	return Buffer.from(broken.replace(/startxref\s+\d+/, 'startxref\n12'), 'latin1');
}

/** Every /Length is 5 bytes too long, and all xref offsets are zero. */
async function damagedStreams() {
	const bytes = await multi('streams', 2);
	const text = Buffer.from(bytes).toString('latin1');
	const broken = text
		.replace(/\/Length (\d+)/g, (_m, n) => `/Length ${Number(n) + 5}`)
		.replace(/(\d{10}) (\d{5}) n/g, (_m, _o, g) => `0000000000 ${g} n`);
	return Buffer.from(broken, 'latin1');
}

// --- JPEG encoder (baseline, flat 8×8 blocks only) --------------------------------------
function encodeJpeg(width, height, pixel, orientation) {
	const bytes = [];
	const u16 = (v) => bytes.push((v >> 8) & 255, v & 255);
	const seg = (marker, body) => {
		bytes.push(0xff, marker);
		u16(body.length + 2);
		bytes.push(...body);
	};
	bytes.push(0xff, 0xd8);
	seg(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]);
	if (orientation) {
		// Exif\0\0 + little-endian TIFF with IFD0 holding Orientation (0x0112) and a Make tag.
		const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 2, 0];
		tiff.push(0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0);
		tiff.push(0x0f, 0x01, 2, 0, 4, 0, 0, 0, 0x41, 0x43, 0x4d, 0); // Make "ACM"
		tiff.push(0, 0, 0, 0);
		seg(0xe1, [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]);
	}
	seg(0xfe, [...Buffer.from('corpus comment')]);
	seg(0xdb, [0, ...new Array(64).fill(1)]);
	seg(0xc0, [8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
	const dcBits = [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
	const dcVals = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
	const acBits = [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
	const acVals = [0];
	seg(0xc4, [0x00, ...dcBits, ...dcVals]);
	seg(0xc4, [0x10, ...acBits, ...acVals]);
	seg(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]);
	const codes = (bits, vals) => {
		const map = new Map();
		let code = 0;
		let k = 0;
		for (let len = 1; len <= 16; len++) {
			for (let n = 0; n < bits[len - 1]; n++) map.set(vals[k++], [code++, len]);
			code <<= 1;
		}
		return map;
	};
	const dc = codes(dcBits, dcVals);
	const ac = codes(acBits, acVals);
	let acc = 0;
	let nbits = 0;
	const put = (value, len) => {
		for (let b = len - 1; b >= 0; b--) {
			acc = (acc << 1) | ((value >> b) & 1);
			nbits++;
			if (nbits === 8) {
				bytes.push(acc);
				if (acc === 0xff) bytes.push(0);
				acc = 0;
				nbits = 0;
			}
		}
	};
	const prev = [0, 0, 0];
	for (let by = 0; by < height / 8; by++) {
		for (let bx = 0; bx < width / 8; bx++) {
			const [r, g, b] = pixel(bx * 8, by * 8);
			const ycc = [
				0.299 * r + 0.587 * g + 0.114 * b,
				128 - 0.168736 * r - 0.331264 * g + 0.5 * b,
				128 + 0.5 * r - 0.418688 * g - 0.081312 * b
			];
			for (let c = 0; c < 3; c++) {
				const value = Math.round((ycc[c] - 128) * 8);
				const diff = value - prev[c];
				prev[c] = value;
				const mag = Math.abs(diff);
				const cat = mag === 0 ? 0 : Math.floor(Math.log2(mag)) + 1;
				const [code, len] = dc.get(cat);
				put(code, len);
				if (cat) put(diff < 0 ? diff + (1 << cat) - 1 : diff, cat);
				const [eob, eobLen] = ac.get(0);
				put(eob, eobLen);
			}
		}
	}
	if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
	bytes.push(0xff, 0xd9);
	return Buffer.from(bytes);
}

/** 400×240: white, red block at the top-left, blue bar along the bottom. */
function photoPixel(x, y) {
	if (x < 96 && y < 64) return [220, 20, 20];
	if (y >= 208) return [20, 40, 200];
	return [250, 250, 250];
}

// --- PNG encoder ---------------------------------------------------------------------
const CRC = new Uint32Array(256).map((_, n) => {
	let c = n;
	for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	return c >>> 0;
});
function crc32(buf) {
	let c = 0xffffffff;
	for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
	const len = Buffer.alloc(4);
	len.writeUInt32BE(data.length);
	const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(td));
	return Buffer.concat([len, td, crc]);
}
function encodePng(width, height, rgba) {
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8;
	ihdr[9] = 6;
	const raw = Buffer.alloc((width * 4 + 1) * height);
	for (let y = 0; y < height; y++) {
		raw[y * (width * 4 + 1)] = 0;
		for (let x = 0; x < width; x++) {
			const [r, g, b, a] = rgba(x, y);
			const o = y * (width * 4 + 1) + 1 + x * 4;
			raw[o] = r;
			raw[o + 1] = g;
			raw[o + 2] = b;
			raw[o + 3] = a;
		}
	}
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', ihdr),
		chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
		chunk('IEND', Buffer.alloc(0))
	]);
}

// --- deterministic garbage --------------------------------------------------------------
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

// --- build ---------------------------------------------------------------------------
const multiBytes = await multi();
write('multi.pdf', multiBytes, { pages: 6, label: 'multi', size: [612, 792] });
const sizesBytes = await sizes();
write('sizes.pdf', sizesBytes, { pages: 6, label: 'sizes', sizes: SIZES });
write('rotated.pdf', await rotated(), { pages: 6, label: 'rotated', rotate: ROTATES, mediaBox: [400, 600] });
write('inherited.pdf', await inherited(), { pages: 3, label: 'inherited', note: 'MediaBox/Rotate 90/Resources inherited; page 3 overrides Rotate 0' });
write('cropbox.pdf', await cropbox(), { pages: CROPS.length, label: 'cropbox', crops: CROPS });
write('unbalanced.pdf', await unbalanced(), { pages: 4, label: 'unbalanced' });
write('userunit.pdf', await userunit(), { pages: 1, label: 'userunit', userUnit: 2, mediaBox: [300, 200] });
write('form.pdf', await form(), { pages: 2, label: 'form', fields: ['name', 'agree', 'notes'] });
write('metadata.pdf', await metadata(), { pages: 2, label: 'metadata' });
write('damaged-xref.pdf', await damaged(), { pages: 3, label: 'damaged', expect: 'repaired with notes' });
write('damaged-streams.pdf', await damagedStreams(), { pages: 2, label: 'streams', expect: 'repaired with notes' });

const det = ['--deterministic-id'];
write('linearized.pdf', await qpdf([...det, '--linearize', '/in.pdf', '/out.pdf'], { '/in.pdf': multiBytes }), {
	pages: 6,
	label: 'multi'
});
write(
	'objstm.pdf',
	await qpdf([...det, '--object-streams=generate', '/in.pdf', '/out.pdf'], { '/in.pdf': sizesBytes }),
	{ pages: 6, label: 'sizes', sizes: SIZES }
);

const encBase = await multi('enc', 2);
const enc = async (opts) => {
	const weak = opts.includes('--allow-weak-crypto') ? ['--allow-weak-crypto'] : [];
	const rest = opts.filter((o) => o !== '--allow-weak-crypto');
	return qpdf(['/in.pdf', ...weak, '--encrypt', ...rest, '--', '/out.pdf'], { '/in.pdf': encBase });
};
write('enc-rc4-40.pdf', await enc(['--user-password=user', '--owner-password=owner', '--bits=40', '--allow-weak-crypto']), {
	pages: 2,
	label: 'enc',
	password: 'user'
});
write('enc-rc4-128.pdf', await enc(['--user-password=user', '--owner-password=owner', '--bits=128', '--use-aes=n', '--allow-weak-crypto']), {
	pages: 2,
	label: 'enc',
	password: 'user'
});
write('enc-aes-128.pdf', await enc(['--user-password=user', '--owner-password=owner', '--bits=128', '--use-aes=y']), {
	pages: 2,
	label: 'enc',
	password: 'user'
});
write('enc-aes-256.pdf', await enc(['--user-password=user', '--owner-password=owner', '--bits=256']), {
	pages: 2,
	label: 'enc',
	password: 'user',
	ownerPassword: 'owner'
});
write('enc-aes-256-owner-only.pdf', await enc(['--user-password=', '--owner-password=owner', '--bits=256', '--print=none']), {
	pages: 2,
	label: 'enc',
	password: null
});
write('enc-aes-256-unicode.pdf', await enc(['--user-password=pässwörd', '--owner-password=pässwörd', '--bits=256']), {
	pages: 2,
	label: 'enc',
	password: 'pässwörd'
});

write('truncated.pdf', multiBytes.slice(0, Math.floor(multiBytes.length * 0.6)), { expect: 'unreadable' });
const rnd = prng(42);
write('garbage.pdf', Buffer.from(Array.from({ length: 4096 }, () => Math.floor(rnd() * 256))), { expect: 'unreadable' });
write('header-garbage.pdf', Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.from(Array.from({ length: 2048 }, () => 32 + Math.floor(rnd() * 90)))]), {
	expect: 'unreadable'
});

write('photo-exif6.jpg', encodeJpeg(400, 240, photoPixel, 6), { pixels: [400, 240], orientation: 6 });
write('photo-plain.jpg', encodeJpeg(400, 240, photoPixel, 0), { pixels: [400, 240], orientation: 1 });
write(
	'alpha.png',
	encodePng(200, 100, (x, y) => [x % 256, y * 2, 128, Math.round((x / 199) * 255)]),
	{ pixels: [200, 100], alpha: true }
);
write(
	'signature.png',
	encodePng(240, 80, (x, y) => (Math.abs(y - 40 - 25 * Math.sin(x / 20)) < 3 ? [10, 20, 60, 255] : [0, 0, 0, 0])),
	{ pixels: [240, 80], alpha: true }
);

await (await import('./generate-shrink.mjs')).default(write);
await (await import('./generate-redact.mjs')).generateRedact({ write, outDir });
await (await import('./generate-forms.mjs')).default({ write, qpdf });
await (await import('./generate-stamps.mjs')).default(write);

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, '\t') + '\n');
const total = fs.readdirSync(outDir).reduce((n, f) => n + fs.statSync(path.join(outDir, f)).size, 0);
console.log(`Wrote ${Object.keys(manifest).length} files, ${(total / 1024).toFixed(1)} KiB, to ${outDir}`);
