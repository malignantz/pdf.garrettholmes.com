/**
 * Child process for `forms:snap fields` (fields.ts): one real form per job.
 *
 * The form is made flat in memory (MuPDF: every widget deleted, /AcroForm dropped,
 * saved decrypted; the input file is only read), opened with the product engine, and
 * its first pages are snapped on through the wired code (Engine.pageBlanks,
 * editor/snap.ts textAt / tickAt): one seeded sloppy tap per true widget (the taps of
 * evaluate.ts), text typed into text snaps (a seeded answer that fits the blank) and
 * ticks into drawn checkboxes, each stamp linked to its blank as the editor links it.
 * The pages are then exported twice through Engine.exportPlan, compressed (the app's
 * default): with "Keep filled blanks editable" and without. Independent checks on the
 * two files: PDF.js reads every new field back (name, value or state), and the pages
 * with fields are rendered from both by MuPDF, PDF.js (@napi-rs/canvas) and poppler
 * (pdftoppm) and compared pixel for pixel.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import type * as MU from 'mupdf';
import type { PageRef, Stamp } from '../../src/lib/core/types';
import type { TapData } from '../../src/lib/engine/snap-tap';
import { lineTop, textAt, tickAt } from '../../src/lib/editor/snap';
import { textLike } from '../forms-detect/match';
import { serveJobs } from '../survey/lib/pool';
import { debugNotes, engine, loadPdfjs } from '../survey/lib/engine';
import { readInk, rng, seedOf, tapsFor } from './evaluate';

const require = createRequire(import.meta.url);

export interface FieldsJob {
	sha256: string;
	path: string;
	inkFile: string;
	/** Keep the two exports here (for the poppler/qpdf sanity check). */
	keepDir?: string;
	maxPages: number;
	/** Export without compression (default: compressed, as the app does). */
	plainFinalize?: boolean;
}

export interface RenderDiff {
	page: number;
	mupdf: number;
	pdfjs: number;
	poppler: number | null;
}

export interface FieldsResult {
	sha256: string;
	error?: string;
	pages: number;
	taps: number;
	/** Linked stamps placed (text, ticks). */
	text: number;
	ticks: number;
	/** Of the text stamps, how many were typed with a character outside WinAnsi (expected to stay plain). */
	nonWinAnsi: number;
	fields?: number;
	plain?: number;
	reasons?: Record<string, number>;
	notVerified?: string[];
	ordinaryMs?: number;
	fieldsMs?: number;
	/** The ordinary export failed (both failed: not this feature's doing). */
	ordinaryError?: string;
	fieldsError?: string;
	checksOk?: boolean;
	blankCheck?: string;
	/** PDF.js read-back of the new fields: found with the right value, and problems. */
	readBack?: { found: number; problems: string[] };
	renders?: RenderDiff[];
}

const TEXTS = [
	'Jane',
	'Ana',
	'42',
	'N/A',
	'Yes',
	'Zoë',
	'Müller',
	'Lisbon',
	"O'Brien",
	'12 Oak St',
	'555-0199',
	'2026-11-12',
	'José Núñez',
	'Émile Dubois',
	'São Paulo',
	'Straße 7',
	'€ 1.250,00',
	'Smith & Co.',
	'(303) 555-0101',
	'jane@example.org',
	'Renée Côté-Lefèvre',
	'1600 Pennsylvania Ave NW',
	'Washington, DC 20500',
	'Licence no. 48-2213-77'
];
/** In the stamp font, not in WinAnsi: such text must stay a plain stamp. */
const NON_WINANSI = 'Łukasz Żółć';

const destroy = (x: { destroy?: () => void } | null | undefined) => {
	try {
		x?.destroy?.();
	} catch {
		// gone
	}
};

/** The form as a flat page: widgets deleted, /AcroForm dropped, decrypted. */
async function flatten(bytes: Uint8Array): Promise<Uint8Array> {
	const m = (await import('mupdf')) as unknown as typeof MU;
	const doc = new m.PDFDocument(bytes);
	try {
		if (doc.needsPassword() && !doc.authenticatePassword('')) throw new Error('needs a password');
		for (let i = 0; i < doc.countPages(); i++) {
			const page = doc.loadPage(i);
			for (const w of page.getWidgets()) page.deleteAnnotation(w);
			destroy(page);
		}
		doc.getTrailer().get('Root').delete('AcroForm');
		return doc.saveToBuffer('decrypt,garbage').asUint8Array().slice();
	} finally {
		destroy(doc);
	}
}

function pick(r: () => number, room: number, size: number): string {
	// About 0.55 em per character in Noto Sans.
	const fit = TEXTS.filter((t) => t.length * 0.55 * size <= room);
	const pool = fit.length ? fit : TEXTS.slice(0, 3);
	return pool[Math.floor(r() * pool.length)];
}

async function renderAll(bytes: Uint8Array, page: number, dpi: number) {
	const m = (await import('mupdf')) as unknown as typeof MU;
	const doc = m.Document.openDocument(bytes.slice(), 'application/pdf');
	let mu: { w: number; h: number; px: Uint8Array };
	try {
		const p = doc.loadPage(page);
		const pix = p.toPixmap(m.Matrix.scale(dpi / 72, dpi / 72), m.ColorSpace.DeviceRGB, false, true);
		mu = { w: pix.getWidth(), h: pix.getHeight(), px: new Uint8Array(pix.getPixels()) };
		destroy(pix);
		destroy(p);
	} finally {
		destroy(doc);
	}
	const pj = await loadPdfjs();
	const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');
	const task = pj.getDocument({ data: bytes.slice(), useWorkerFetch: false, isEvalSupported: false, verbosity: 0, standardFontDataUrl: path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + '/' });
	let js: { w: number; h: number; px: Uint8Array };
	try {
		const d = await task.promise;
		const p = await d.getPage(page + 1);
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
		js = { w: canvas.width, h: canvas.height, px };
		p.cleanup();
	} finally {
		await task.destroy();
	}
	let pop: { w: number; h: number; px: Uint8Array } | null = null;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fill-fields-'));
	try {
		const f = path.join(dir, 'in.pdf');
		fs.writeFileSync(f, bytes);
		execFileSync('pdftoppm', ['-r', String(dpi), '-f', String(page + 1), '-l', String(page + 1), '-singlefile', f, path.join(dir, 'out')], { stdio: 'ignore', timeout: 60_000 });
		const d = fs.readFileSync(path.join(dir, 'out.ppm'));
		let pos = 0;
		const fields: string[] = [];
		while (fields.length < 4) {
			while (d[pos] === 0x20 || d[pos] === 0x0a) pos++;
			let s = '';
			while (d[pos] !== 0x20 && d[pos] !== 0x0a) s += String.fromCharCode(d[pos++]);
			fields.push(s);
		}
		pos++;
		pop = { w: Number(fields[1]), h: Number(fields[2]), px: new Uint8Array(d.subarray(pos)) };
	} catch {
		pop = null;
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	return { mu, js, pop };
}

function diff(a: { w: number; h: number; px: Uint8Array }, b: { w: number; h: number; px: Uint8Array }): number {
	if (a.w !== b.w || a.h !== b.h) return Infinity;
	let n = 0;
	for (let i = 0; i < a.px.length; i += 3) {
		const d = Math.max(Math.abs(a.px[i] - b.px[i]), Math.abs(a.px[i + 1] - b.px[i + 1]), Math.abs(a.px[i + 2] - b.px[i + 2]));
		if (d > 48) n++;
	}
	return n;
}

async function readBack(bytes: Uint8Array, want: Map<string, string | boolean>): Promise<{ found: number; problems: string[] }> {
	const pj = await loadPdfjs();
	const task = pj.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	const problems: string[] = [];
	const got = new Map<string, string | boolean>();
	try {
		const d = await task.promise;
		for (let i = 1; i <= d.numPages; i++) {
			const annots = (await (await d.getPage(i)).getAnnotations()) as { subtype: string; fieldName?: string; fieldValue?: unknown; checkBox?: boolean; exportValue?: string }[];
			for (const a of annots) {
				if (a.subtype !== 'Widget' || !a.fieldName?.startsWith('blank_')) continue;
				if (got.has(a.fieldName)) problems.push(`${a.fieldName} twice`);
				got.set(a.fieldName, a.checkBox ? a.fieldValue === a.exportValue : String(a.fieldValue));
			}
		}
	} finally {
		await task.destroy();
	}
	let found = 0;
	for (const [k, v] of got) {
		if (!want.has(k)) problems.push(`${k} unexpected`);
		else if (want.get(k) !== v) problems.push(`${k} reads ${JSON.stringify(v)}`);
		else found++;
	}
	return { found, problems };
}

serveJobs<FieldsJob, FieldsResult>(async (job, io) => {
	const res: FieldsResult = { sha256: job.sha256, pages: 0, taps: 0, text: 0, ticks: 0, nonWinAnsi: 0 };
	try {
		const ink = readInk(job.inkFile);
		if (!ink || ink.error) throw new Error(`no ink: ${ink?.error ?? 'missing'}`);
		io.progress('flatten');
		const flat = await flatten(new Uint8Array(fs.readFileSync(job.path)));
		io.progress('open');
		const e = engine();
		const source = await e.openPdf(flat, `${job.sha256.slice(0, 12)}.pdf`);
		const count = Math.min(source.pages.length, job.maxPages);
		const refs: PageRef[] = [];
		let n = 0;
		for (let i = 0; i < count; i++) {
			const stamps: Stamp[] = [];
			const pg = ink.pages.find((p) => p.i === i);
			if (pg && pg.truths.length && !pg.declined) {
				io.progress(`blanks ${i + 1}`);
				const b = await e.pageBlanks(source, i);
				if (!b.declined && b.data) {
					const data = b.data as TapData;
					const W = b.width;
					const H = b.height;
					const r = rng(seedOf(job.sha256, i, 7));
					for (const t of pg.truths) {
						const tap = tapsFor(data.snap, t, r).find((x) => x.model === 'sloppy');
						if (!tap) continue;
						res.taps++;
						const frac = (q: readonly number[]) => ({ x: q[0] / W, y: q[1] / H, w: (q[2] - q[0]) / W, h: (q[3] - q[1]) / H });
						if (textLike(t.type)) {
							const at = textAt(data, tap.p);
							if (!at) continue;
							const tall = at.snap.rect[3] - at.snap.rect[1] >= 26.4;
							let text = r() < 0.03 ? NON_WINANSI : pick(r, at.snap.rect[2] - at.x - 2, at.size);
							if (tall && r() < 0.3) text = `${text}\nsecond line`;
							if (text.startsWith(NON_WINANSI)) res.nonWinAnsi++;
							res.text++;
							stamps.push({ id: `t${n++}`, kind: 'text', text, color: r() < 0.2 ? 'blue' : 'black', x: at.x / W, y: lineTop(at) / H, size: at.size / H, blank: { kind: 'text', box: frac(at.snap.rect) } });
						} else {
							const at = tickAt(data, tap.p);
							if (!at) continue;
							res.ticks++;
							stamps.push({ id: `c${n++}`, kind: 'mark', mark: 'check', box: frac(at.box), blank: { kind: 'check', box: frac(at.snap.rect) } });
						}
					}
				}
			}
			refs.push({ id: `p${i}`, sourceId: source.id, pageIndex: i, rotation: 0, stamps });
		}
		res.pages = count;
		const plan = (blankFields: boolean) => ({ pages: refs, options: { filename: 'x.pdf', compress: !job.plainFinalize, stripMetadata: false, blankFields } });
		io.progress('export ordinary');
		let ordinary: Uint8Array | null = null;
		try {
			const t0 = performance.now();
			const o = await e.exportPlan(plan(false), [source], []);
			res.ordinaryMs = Math.round(performance.now() - t0);
			ordinary = o.bytes;
		} catch (err) {
			res.ordinaryError = String((err as { message?: string })?.message ?? err);
		}
		io.progress('export fields');
		debugNotes.length = 0;
		let withFields: Uint8Array | null = null;
		try {
			const t0 = performance.now();
			const w = await e.exportPlan(plan(true), [source], []);
			res.fieldsMs = Math.round(performance.now() - t0);
			withFields = w.bytes;
			res.fields = w.blankFields?.fields ?? 0;
			res.plain = w.blankFields?.plain ?? 0;
			res.checksOk = w.checks.every((c) => c.ok);
			res.blankCheck = w.checks.find((c) => c.name === 'blank-fields')?.detail;
		} catch (err) {
			res.fieldsError = String((err as { message?: string })?.message ?? err);
		}
		const reasons: Record<string, number> = {};
		const notVerified: string[] = [];
		for (const d of debugNotes) {
			const m = /^blank-fields: plain (\S+)/.exec(d);
			if (m) reasons[m[1]] = (reasons[m[1]] ?? 0) + 1;
			const v = /^blank-fields: not verified: (.*)$/.exec(d);
			if (v) notVerified.push(v[1]);
		}
		res.reasons = reasons;
		res.notVerified = notVerified;
		if (withFields && ordinary) {
			io.progress('read back');
			// Expected values: the linked stamps that became fields, named in page order.
			const m = (await import('mupdf')) as unknown as typeof MU;
			const doc = new m.PDFDocument(withFields.slice());
			const want = new Map<string, string | boolean>();
			const pagesWithFields: number[] = [];
			try {
				for (let i = 0; i < doc.countPages(); i++) {
					const page = doc.loadPage(i);
					let any = false;
					for (const w of page.getWidgets()) {
						const name = w.getName();
						if (!name.startsWith('blank_')) continue;
						any = true;
						want.set(name, w.getFieldType() === 'checkbox' ? w.getValue() === 'Yes' : w.getValue());
					}
					if (any) pagesWithFields.push(i);
					destroy(page);
				}
			} finally {
				destroy(doc);
			}
			// Text values must be what was typed (MuPDF), and PDF.js must agree.
			const typed = new Set(refs.flatMap((r) => r.stamps.flatMap((s) => (s.kind === 'text' ? [s.text] : []))));
			const rb = await readBack(withFields, want);
			for (const [k, v] of want) if (typeof v === 'string' && !typed.has(v)) rb.problems.push(`${k} value not typed: ${JSON.stringify(v)}`);
			if (want.size !== res.fields) rb.problems.push(`${want.size} fields in the file, ${res.fields} reported`);
			res.readBack = rb;
			io.progress('renders');
			res.renders = [];
			for (const p of pagesWithFields) {
				const a = await renderAll(ordinary, p, 100);
				const b = await renderAll(withFields, p, 100);
				res.renders.push({ page: p, mupdf: diff(a.mu, b.mu), pdfjs: diff(a.js, b.js), poppler: a.pop && b.pop ? diff(a.pop, b.pop) : null });
			}
			if (job.keepDir) {
				fs.mkdirSync(job.keepDir, { recursive: true });
				fs.writeFileSync(path.join(job.keepDir, `${job.sha256.slice(0, 12)}-fields.pdf`), withFields);
				fs.writeFileSync(path.join(job.keepDir, `${job.sha256.slice(0, 12)}-plain.pdf`), ordinary);
			}
		}
	} catch (err) {
		res.error = String((err as { message?: string })?.message ?? err);
	}
	io.result(res);
});
