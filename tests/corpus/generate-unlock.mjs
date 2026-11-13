#!/usr/bin/env node
// @ts-nocheck -- plain Node script, like generate.mjs (which tsconfig excludes).
/**
 * Corpus for "Remove printing and copying limits" (core.ts openPdf, limits.ts):
 * files that open without a password but limit what may be done with them, files
 * that need a password and also have limits, and security handlers the app declines.
 * Everything is made here (pdf-lib pages, qpdf's own --encrypt, hand-written
 * dictionaries); nothing is copied from elsewhere.
 *
 *   unlock-rc4-40-print.pdf     R2 (RC4 40-bit), no open password, printing not allowed
 *   unlock-rc4-128-copy.pdf     R3 (RC4 128-bit), no open password, copying not allowed
 *   unlock-aes-128-edit.pdf     R4 (AES-128), no open password, editing and page assembly not allowed
 *   unlock-aes-256-all.pdf      R6 (AES-256), no open password, everything not allowed
 *   unlock-aes-256-open.pdf     R6, no open password, everything allowed
 *   unlock-aes-256-userpw.pdf   R6, open password "user", owner "owner", printing and copying not allowed
 *   unlock-aes-128-userpw.pdf   R4, open password "user", owner "owner", form filling not allowed
 *   unlock-filter-fopn.pdf      /Encrypt with a non-standard /Filter (FileOpen-style name)  → declined
 *   unlock-filter-pubsec.pdf    /Encrypt with /Filter /Adobe.PubSec (certificate security)  → declined
 *   unlock-pubsec-damaged.pdf   unlock-filter-pubsec.pdf with every xref offset off by 64  → declined (named in the bytes)
 *   unlock-standard-r9.pdf      /Encrypt /Standard with a revision that does not exist (R 9)  → declined
 *   unlock-damaged-xref.pdf     unlock-rc4-128-copy.pdf with every xref offset off by 64   → unreadable
 *
 * Called from generate.mjs (one line), or on its own: node tests/corpus/generate-unlock.mjs
 * (writes only these files and merges their manifest entries). qpdf draws random keys,
 * so the encrypted files differ from run to run; what they are does not.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
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
	if (code !== 0 && code !== 3) throw new Error(`qpdf ${args.join(' ')} failed (${code}): ${Buffer.from(err).toString()}`);
	return q.FS.readFile('/out.pdf');
}

/** Two Letter pages, each with a line of text the tests compare before and after. */
async function base(name) {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 1; i <= 2; i++) {
		const page = doc.addPage([612, 792]);
		page.drawText(`${name} p${i}`, { x: 40, y: 740, size: 18, font, color: rgb(0, 0, 0) });
		page.drawText(`The quick brown fox jumps over the lazy dog (${name}, page ${i}).`, { x: 40, y: 700, size: 12, font });
	}
	return doc.save({ useObjectStreams: false, addDefaultPage: false });
}

async function encrypt(name, opts) {
	const weak = opts.some((o) => o === '--bits=40' || o === '--use-aes=n') ? ['--allow-weak-crypto'] : [];
	return qpdf(['/in.pdf', ...weak, '--encrypt', ...opts, '--', '/out.pdf'], { '/in.pdf': await base(name) });
}

const latin = (s) => Buffer.from(s, 'latin1');

/**
 * A two-page file whose trailer names `encrypt` as its /Encrypt dictionary. Its content
 * is written in the clear: these files must be declined before anything is decrypted.
 */
function handlerFile(name, encrypt) {
	const content = (i) => `BT /F1 18 Tf 40 740 Td (${name} p${i}) Tj ET`;
	const objs = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 5 0 R >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
		`<< /Length ${content(1).length} >>\nstream\n${content(1)}\nendstream`,
		`<< /Length ${content(2).length} >>\nstream\n${content(2)}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
		encrypt
	];
	let out = '%PDF-1.6\n%\xe2\xe3\xcf\xd3\n';
	const offsets = [];
	objs.forEach((body, i) => {
		offsets.push(out.length);
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefAt = out.length;
	out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
	for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
	const id = '<00112233445566778899aabbccddeeff>';
	out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Encrypt ${objs.length} 0 R /ID [${id} ${id}] >>\nstartxref\n${xrefAt}\n%%EOF\n`;
	return latin(out);
}

/** Every xref offset moved by `by` bytes (the objects stay where they are). */
function shiftXref(bytes, by) {
	const s = Buffer.from(bytes).toString('latin1');
	const at = s.lastIndexOf('\nxref\n');
	if (at < 0) throw new Error('no classic xref table');
	const end = s.indexOf('trailer', at);
	const table = s.slice(at, end).replace(/^(\d{10}) (\d{5}) n/gm, (_m, o, g) => `${String(Number(o) + by).padStart(10, '0')} ${g} n`);
	return latin(s.slice(0, at) + table + s.slice(end));
}

const noLimits = { print: false, copy: false, edit: false, fill: false };

export default async function generateUnlockCorpus(write) {
	const meta = (name, extra) => ({ pages: 2, label: name.replace(/\.pdf$/, ''), ...extra });
	const files = [
		['unlock-rc4-40-print.pdf', ['--user-password=', '--owner-password=owner', '--bits=40', '--print=n'], { R: 2, password: null, limits: { ...noLimits, print: true } }],
		['unlock-rc4-128-copy.pdf', ['--user-password=', '--owner-password=owner', '--bits=128', '--use-aes=n', '--extract=n'], { R: 3, password: null, limits: { ...noLimits, copy: true } }],
		['unlock-aes-128-edit.pdf', ['--user-password=', '--owner-password=owner', '--bits=128', '--use-aes=y', '--modify-other=n', '--assemble=n'], { R: 4, password: null, limits: { ...noLimits, edit: true } }],
		['unlock-aes-256-all.pdf', ['--user-password=', '--owner-password=owner', '--bits=256', '--print=none', '--extract=n', '--modify=none'], { R: 6, password: null, limits: { print: true, copy: true, edit: true, fill: true } }],
		['unlock-aes-256-open.pdf', ['--user-password=', '--owner-password=owner', '--bits=256'], { R: 6, password: null, limits: noLimits }],
		['unlock-aes-256-userpw.pdf', ['--user-password=user', '--owner-password=owner', '--bits=256', '--print=none', '--extract=n'], { R: 6, password: 'user', ownerPassword: 'owner', limits: { ...noLimits, print: true, copy: true } }],
		['unlock-aes-128-userpw.pdf', ['--user-password=user', '--owner-password=owner', '--bits=128', '--use-aes=y', '--form=n'], { R: 4, password: 'user', ownerPassword: 'owner', limits: { ...noLimits, fill: true } }]
	];
	const made = new Map();
	for (const [name, opts, extra] of files) {
		const bytes = await encrypt(name.replace(/\.pdf$/, ''), opts);
		made.set(name, bytes);
		write(name, bytes, meta(name, extra));
	}
	write(
		'unlock-filter-fopn.pdf',
		handlerFile('unlock-filter-fopn', '<< /Filter /FOPN_foweb /V 1 /R 2 /Length 40 /P -4 /INFO (synthetic) >>'),
		meta('unlock-filter-fopn.pdf', { expect: 'declined', handler: 'FOPN_foweb' })
	);
	const pubsec = handlerFile(
		'unlock-filter-pubsec',
		'<< /Filter /Adobe.PubSec /SubFilter /adbe.pkcs7.s5 /V 4 /R 4 /Length 128 /CF << /DefaultCryptFilter << /CFM /AESV2 /AuthEvent /DocOpen /Recipients [<3082000a020100300506032b0e03>] >> >> /StmF /DefaultCryptFilter /StrF /DefaultCryptFilter >>'
	);
	made.set('unlock-filter-pubsec.pdf', pubsec);
	write('unlock-filter-pubsec.pdf', pubsec, meta('unlock-filter-pubsec.pdf', { expect: 'declined', handler: 'Adobe.PubSec' }));
	write('unlock-pubsec-damaged.pdf', shiftXref(made.get('unlock-filter-pubsec.pdf'), 64), meta('unlock-pubsec-damaged.pdf', { expect: 'declined', handler: 'Adobe.PubSec', note: 'every xref offset off by 64' }));
	const pad = `<${'00'.repeat(32)}>`;
	write(
		'unlock-standard-r9.pdf',
		handlerFile('unlock-standard-r9', `<< /Filter /Standard /V 9 /R 9 /Length 128 /P -4 /O ${pad} /U ${pad} >>`),
		meta('unlock-standard-r9.pdf', { expect: 'declined', handler: 'Standard R9 (no such revision)' })
	);
	write('unlock-damaged-xref.pdf', shiftXref(made.get('unlock-rc4-128-copy.pdf'), 64), { expect: 'unreadable', note: 'encrypted, every xref offset off by 64' });
}

// Standalone: write only these files and merge into manifest.json.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outDir = path.join(here, 'files');
	const manifestPath = path.join(outDir, 'manifest.json');
	const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
	await generateUnlockCorpus((name, bytes, meta) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		manifest[name] = meta;
		console.log(`${name}: ${(bytes.length / 1024).toFixed(1)} KiB`);
	});
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, '\t') + '\n');
}
