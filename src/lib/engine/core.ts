/**
 * The PDF engine, environment-neutral (Node for tests, a Web Worker in the app).
 * Environment specifics (where qpdf.wasm and the font come from, how PDF.js runs)
 * arrive as `EngineAssets`.
 *
 *   openPdf     qpdf --decrypt rewrite → PDF.js geometry
 *   openImage   pdf-lib one-page PDF → qpdf --check
 *   exportPlan  qpdf --empty --pages (+ --rotate) → pdf-lib stamps (only if any)
 *               → qpdf finalize (compress / metadata / AES-256) → verify
 */

import type {
	Asset,
	Engine,
	ExportPlan,
	ExportResult,
	PageRef,
	PageSize,
	Rotation,
	Source,
	Stamp,
	VerifyCheck
} from '../core/types';
import { EngineError, isOutOfMemory } from './errors';
import { StampFont } from './font';
import { normalizeStampText, rotateSize } from './geometry';
import {
	imagePageSize,
	orientationMatrix,
	orientedPixels,
	parseJpeg,
	parsePng,
	stripJpegMetadata,
	type Orientation
} from './images';
import { PdfjsOpenError, inspectWithPdfjs, type PdfjsLib } from './pdfjs';
import { QPDF_ERROR, QPDF_OK, QPDF_WARNINGS, Qpdf, type QpdfLoader, type QpdfResult } from './qpdf';
import { applyStamps, type StampJob } from './stamps';

export interface EngineAssets {
	qpdf: QpdfLoader;
	/** Bytes of src/lib/engine/fonts/NotoSans-Regular.ttf. */
	font: () => Promise<Uint8Array>;
	/** PDF.js, already configured to run in this environment (fake worker or nested worker). */
	pdfjs: () => Promise<PdfjsLib>;
}

export interface EngineOptions {
	/** Largest single input accepted. Default 1 GiB. */
	maxInputBytes?: number;
	/** Largest total of sources referenced by one export. Default 1.5 GiB. */
	maxExportBytes?: number;
	newId?: () => string;
}

const SIZE_TOLERANCE = 0.5;
const MIN_PAGE = 3;
const MAX_PAGE = 14400;

export function createCoreEngine(assets: EngineAssets, options: EngineOptions = {}): Engine {
	const qpdf = new Qpdf(assets.qpdf);
	const font = new StampFont(assets.font);
	const maxInput = options.maxInputBytes ?? 1024 ** 3;
	const maxExport = options.maxExportBytes ?? 1.5 * 1024 ** 3;
	const newId = options.newId ?? (() => crypto.randomUUID());

	let pdfjsP: Promise<PdfjsLib> | null = null;
	const pdfjs = () => {
		pdfjsP ??= assets.pdfjs().catch((e) => {
			pdfjsP = null;
			throw e;
		});
		return pdfjsP;
	};
	let pdfLibP: Promise<typeof import('@cantoo/pdf-lib')> | null = null;
	const pdfLib = () => {
		pdfLibP ??= import('@cantoo/pdf-lib').catch((e) => {
			pdfLibP = null;
			throw e;
		});
		return pdfLibP;
	};

	async function checkStructure(bytes: Uint8Array, what: string) {
		const res = await qpdf.run({ args: ['--check', '/c.pdf'], inputs: { '/c.pdf': bytes } });
		if (res.code !== QPDF_OK) {
			throw new EngineError('internal', `The ${what} could not be built cleanly.`);
		}
	}

	async function onePagePdf(
		build: (lib: typeof import('@cantoo/pdf-lib'), doc: import('@cantoo/pdf-lib').PDFDocument) => Promise<void>
	) {
		const lib = await pdfLib();
		const doc = await lib.PDFDocument.create({ updateMetadata: false });
		await build(lib, doc);
		return doc.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
	}

	const engine: Engine = {
		openPdf: (bytes, name, password) =>
			guard(async () => {
				if (bytes.length > maxInput) {
					throw new EngineError('too-large', 'This file is too large to open on this device.');
				}
				if (bytes.length === 0) throw new EngineError('unreadable', 'This file is empty.');
				const pw = password !== undefined && password !== '' ? [`--password=${password}`] : [];

				const res = await qpdf.run({
					args: [...pw, '--decrypt', '/in.pdf', '/out.pdf'],
					inputs: { '/in.pdf': bytes },
					outputs: ['/out.pdf']
				});
				const out = res.files.get('/out.pdf');
				if (res.code === QPDF_ERROR || !out) {
					if (/invalid password/i.test(res.stderr)) {
						throw pw.length
							? new EngineError('password-wrong', 'That password did not open the file. Check it and try again.')
							: new EngineError('password-required', 'This file is protected with a password. Enter it to open the file.');
					}
					throw new EngineError('unreadable', unreadableMessage(res.stderr));
				}
				if (res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) {
					throw new EngineError('internal', 'The PDF engine stopped unexpectedly while reading this file.');
				}
				const notes = res.code === QPDF_WARNINGS ? friendlyWarnings(res.stderr) : [];

				const [enc, npages] = await Promise.all([
					qpdf.run({ args: [...pw, '--is-encrypted', '/in.pdf'], inputs: { '/in.pdf': bytes } }),
					qpdf.run({ args: ['--show-npages', '/n.pdf'], inputs: { '/n.pdf': out } })
				]);
				const wasEncrypted = enc.code === QPDF_OK;

				let info;
				try {
					info = await inspectWithPdfjs(await pdfjs(), out);
				} catch (e) {
					if (e instanceof PdfjsOpenError) {
						throw new EngineError('unreadable', 'This file is too damaged to open reliably.');
					}
					throw e;
				}
				if (info.numPages === 0) throw new EngineError('unreadable', 'This PDF has no pages.');
				const qpdfPages = Number.parseInt(npages.stdout.trim(), 10);
				if (npages.code !== QPDF_OK || qpdfPages !== info.numPages) {
					throw new EngineError('unreadable', 'This file’s page list is inconsistent, so it cannot be opened reliably.');
				}
				for (const p of info.pages) {
					if (!(p.width > 0 && p.height > 0 && Number.isFinite(p.width) && Number.isFinite(p.height))) {
						throw new EngineError('unreadable', 'This file has a page without a usable size.');
					}
				}
				if (wasEncrypted) notes.push('Opened with its password. Exports have no password unless you set one.');
				if (info.hasSignatures) {
					notes.push('This file has a digital signature. Exported pages will not carry a valid signature.');
				}
				if (info.hasXfa) {
					notes.push('This file contains an XFA form. Its pages may look different here than in Adobe Reader.');
				}
				return {
					id: newId(),
					name,
					kind: 'pdf',
					bytes: out,
					pages: info.pages,
					originalSize: bytes.length,
					wasEncrypted,
					notes
				};
			}),

		openImage: (bytes, mime, name) =>
			guard(async () => {
				if (bytes.length > maxInput) throw new EngineError('too-large', 'This image is too large to open on this device.');
				const notes: string[] = [];
				let size: PageSize;
				let pdf: Uint8Array;
				if (mime === 'image/jpeg') {
					const info = parseJpeg(bytes);
					const clean = stripJpegMetadata(bytes);
					if (clean.length !== bytes.length) notes.push('Removed hidden photo details (such as camera and location).');
					const shown = orientedPixels(info.width, info.height, info.orientation);
					size = imagePageSize(shown.width, shown.height);
					pdf = await onePagePdf(async (lib, doc) => {
						const img = await doc.embedJpg(clean);
						drawFullPage(lib, doc, img.ref, size, info.orientation);
					});
				} else if (mime === 'image/png') {
					const info = parsePng(bytes);
					size = imagePageSize(info.width, info.height);
					pdf = await onePagePdf(async (lib, doc) => {
						const img = await doc.embedPng(bytes);
						drawFullPage(lib, doc, img.ref, size, 1);
					});
				} else {
					throw new EngineError('unsupported', 'Only JPEG and PNG images can be added directly.');
				}
				await checkStructure(pdf, 'page for this image');
				return {
					id: newId(),
					name,
					kind: 'image',
					bytes: pdf,
					pages: [size],
					originalSize: bytes.length,
					wasEncrypted: false,
					notes
				};
			}),

		blankPage: (size) =>
			guard(async () => {
				const ok = (n: number) => Number.isFinite(n) && n >= MIN_PAGE && n <= MAX_PAGE;
				if (!ok(size.width) || !ok(size.height)) {
					throw new EngineError('unsupported', `Page sides must be between ${MIN_PAGE} and ${MAX_PAGE} points.`);
				}
				const pdf = await onePagePdf(async (_lib, doc) => {
					doc.addPage([size.width, size.height]);
				});
				await checkStructure(pdf, 'blank page');
				return {
					id: newId(),
					name: 'Blank page',
					kind: 'blank',
					bytes: pdf,
					pages: [{ width: size.width, height: size.height }],
					originalSize: 0,
					wasEncrypted: false,
					notes: []
				};
			}),

		unsupportedChars: (text) => guard(() => font.unsupportedChars(text)),

		exportPlan: (plan, sources, assets) => guard(() => exportPlan(plan, sources, assets))
	};

	async function exportPlan(plan: ExportPlan, sources: Source[], assetList: Asset[]): Promise<ExportResult> {
		const started = now();
		const { pages, options } = plan;
		if (pages.length === 0) throw new EngineError('unsupported', 'There are no pages to export.');
		const password = options.password;
		if (password !== undefined) validatePassword(password);

		// Validate the plan and work out what every output page must look like.
		const byId = new Map(sources.map((s) => [s.id, s]));
		const assetIds = new Set(assetList.map((a) => a.id));
		const used: Source[] = [];
		const fileOf = new Map<string, string>();
		const expected: PageSize[] = [];
		for (const [i, ref] of pages.entries()) {
			const src = byId.get(ref.sourceId);
			if (!src) throw new EngineError('internal', `Page ${i + 1} refers to a file that is no longer open.`);
			if (!Number.isInteger(ref.pageIndex) || ref.pageIndex < 0 || ref.pageIndex >= src.pages.length) {
				throw new EngineError('internal', `Page ${i + 1} refers to a page that does not exist in ${src.name}.`);
			}
			if (![0, 90, 180, 270].includes(ref.rotation)) {
				throw new EngineError('internal', `Page ${i + 1} has an invalid rotation.`);
			}
			if (!fileOf.has(src.id)) {
				fileOf.set(src.id, `/src/${used.length}.pdf`);
				used.push(src);
			}
			expected.push(rotateSize(src.pages[ref.pageIndex], ref.rotation));
			validateStamps(i, ref.stamps, assetIds);
		}
		const total = used.reduce((n, s) => n + s.bytes.length, 0);
		if (total > maxExport) throw new EngineError('too-large', 'These files are too large to combine on this device.');
		for (const [i, ref] of pages.entries()) {
			for (const s of ref.stamps) {
				if (s.kind !== 'text') continue;
				const bad = await font.unsupportedChars(s.text);
				if (bad) {
					throw new EngineError('unsupported', `Text on page ${i + 1} uses characters the stamp font cannot draw: ${bad}`);
				}
			}
		}

		const warnings: string[] = [];
		for (const s of used) {
			if (s.wasEncrypted && password === undefined) {
				warnings.push(`${s.name} had a password; the exported file has none.`);
			}
		}

		// (a) Assemble.
		const inputs: Record<string, Uint8Array> = {};
		for (const s of used) inputs[fileOf.get(s.id)!] = s.bytes;
		const assembled = await runOrFail(
			{
				args: ['--empty', '--pages', ...pageSelection(pages, fileOf), '--', ...rotateArgs(pages), '/out/assembled.pdf'],
				inputs,
				outputs: ['/out/assembled.pdf']
			},
			'/out/assembled.pdf',
			warnings
		);

		// (b) Stamps.
		let stamped = assembled;
		const jobs: StampJob[] = [];
		pages.forEach((ref, i) => {
			const stamps = ref.stamps.filter((s) => s.kind !== 'text' || normalizeStampText(s.text).replace(/\n/g, '') !== '');
			if (stamps.length) jobs.push({ pageIndex: i, stamps, expected: expected[i] });
		});
		if (jobs.length) {
			const [lib, fk] = await Promise.all([pdfLib(), font.fontkit()]);
			stamped = await applyStamps({ lib, fontkit: fk, fontBytes: () => font.bytes() }, assembled, jobs, assetList);
		}

		// (c) Finalize.
		const finalArgs: string[] = ['/in/doc.pdf'];
		const finalInputs: Record<string, Uint8Array> = { '/in/doc.pdf': stamped };
		if (options.compress) {
			finalArgs.push('--object-streams=generate', '--compress-streams=y', '--recompress-flate', '--compression-level=9');
		}
		if (options.stripMetadata) {
			const update = await metadataRemoval(stamped);
			if (update) {
				finalInputs['/in/update.json'] = update;
				finalArgs.push('--update-from-json=/in/update.json');
			}
			finalArgs.push('--remove-info', '--remove-metadata');
		}
		if (password !== undefined) {
			finalArgs.push('--encrypt', `--user-password=${password}`, `--owner-password=${password}`, '--bits=256', '--');
		}
		finalArgs.push('/out/final.pdf');
		const final = await runOrFail({ args: finalArgs, inputs: finalInputs, outputs: ['/out/final.pdf'] }, '/out/final.pdf', warnings);

		// (d) Verify.
		const checks = await verify(final, expected, password, options.stripMetadata);
		if (!checks.every((c) => c.ok)) {
			throw new EngineError('verification-failed', 'The exported file did not pass its checks, so it was not saved.', checks);
		}
		return {
			bytes: final,
			pageCount: pages.length,
			checks,
			warnings: [...new Set(warnings)],
			elapsedMs: Math.round(now() - started)
		};
	}

	async function runOrFail(
		run: { args: string[]; inputs: Record<string, Uint8Array>; outputs: string[] },
		output: string,
		warnings: string[]
	): Promise<Uint8Array> {
		const res = await qpdf.run(run);
		const file = res.files.get(output);
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) {
			const err = new EngineError('internal', 'The PDF engine could not build the file. Nothing was saved.');
			(err as { cause?: unknown }).cause = `qpdf exit ${res.code}: ${res.stderr}`;
			throw err;
		}
		if (res.code === QPDF_WARNINGS) warnings.push(...friendlyWarnings(res.stderr));
		return file;
	}

	/** qpdf JSON update that drops /Metadata and /PieceInfo everywhere and the trailer /Info. */
	async function metadataRemoval(bytes: Uint8Array): Promise<Uint8Array | null> {
		const json = await dumpObjects(bytes);
		const updates: Record<string, unknown> = {};
		for (const [key, obj] of Object.entries(json.objects)) {
			if (key === 'trailer') {
				const v = obj.value;
				if (isDict(v) && '/Info' in v) {
					const { ['/Info']: _drop, ...rest } = v;
					updates[key] = { value: rest };
				}
				continue;
			}
			const value = obj.value;
			const dict = obj.stream?.dict;
			if (isDict(value) && hasMetadataKey(value)) {
				updates[key] = { value: withoutMetadata(value) };
			} else if (isDict(dict) && hasMetadataKey(dict) && dict['/Type'] !== '/XRef' && dict['/Type'] !== '/ObjStm') {
				updates[key] = { stream: { dict: withoutMetadata(dict) } };
			}
		}
		if (Object.keys(updates).length === 0) return null;
		return new TextEncoder().encode(JSON.stringify({ qpdf: [json.header, updates] }));
	}

	async function dumpObjects(bytes: Uint8Array, password?: string): Promise<QpdfJson> {
		const pw = password !== undefined ? [`--password=${password}`] : [];
		const res = await qpdf.run({
			args: [...pw, '--json-output', '--json-stream-data=none', '/j.pdf', '/j.json'],
			inputs: { '/j.pdf': bytes },
			outputs: ['/j.json']
		});
		const file = res.files.get('/j.json');
		if (res.code !== QPDF_OK || !file) throw new EngineError('internal', 'The PDF engine could not inspect the file.');
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, unknown>, Record<string, QpdfJsonObject>] };
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
	}

	async function verify(
		bytes: Uint8Array,
		expected: PageSize[],
		password: string | undefined,
		stripMetadata: boolean
	): Promise<VerifyCheck[]> {
		const checks: VerifyCheck[] = [];
		const pw = password !== undefined ? [`--password=${password}`] : [];
		const lib = await pdfjs();

		// Structure and page count from qpdf.
		const res = await qpdf.run({ args: [...pw, '--check', '--show-npages', '/v.pdf'], inputs: { '/v.pdf': bytes } });
		const clean = res.code === QPDF_OK && /No syntax or stream encoding errors found/.test(res.stdout);
		checks.push({
			name: 'structure',
			ok: clean,
			detail: clean
				? 'qpdf --check found no syntax or stream errors.'
				: `qpdf --check reported problems (exit ${res.code}): ${firstLines(res.stderr || res.stdout)}`
		});
		const lines = res.stdout.trim().split('\n');
		const qpdfPages = Number.parseInt(lines[lines.length - 1] ?? '', 10);

		// Independent re-open with PDF.js.
		let info: Awaited<ReturnType<typeof inspectWithPdfjs>> | null = null;
		let reopenError = '';
		try {
			info = await inspectWithPdfjs(lib, bytes, password);
		} catch (e) {
			reopenError = e instanceof Error ? e.message : String(e);
		}
		checks.push({
			name: 'reopen',
			ok: info !== null,
			detail: info ? `PDF.js opened the file and all ${info.numPages} pages.` : `PDF.js could not open the file: ${reopenError}`
		});

		const countOk = qpdfPages === expected.length && info?.numPages === expected.length;
		checks.push({
			name: 'page-count',
			ok: countOk,
			detail: countOk
				? `${expected.length} pages, as planned.`
				: `Expected ${expected.length} pages; qpdf counted ${Number.isNaN(qpdfPages) ? 'none' : qpdfPages}, PDF.js counted ${info?.numPages ?? 'none'}.`
		});

		const mismatches: string[] = [];
		if (info) {
			expected.forEach((e, i) => {
				const got = info!.pages[i];
				if (!got || Math.abs(got.width - e.width) > SIZE_TOLERANCE || Math.abs(got.height - e.height) > SIZE_TOLERANCE) {
					mismatches.push(
						`page ${i + 1}: expected ${fmt(e.width)}×${fmt(e.height)}, got ${got ? `${fmt(got.width)}×${fmt(got.height)}` : 'nothing'}`
					);
				}
			});
		}
		checks.push({
			name: 'page-sizes',
			ok: info !== null && mismatches.length === 0,
			detail: !info
				? 'Not checked: the file did not re-open.'
				: mismatches.length === 0
					? `Every page is the planned size (within ${SIZE_TOLERANCE} pt).`
					: `Sizes differ: ${mismatches.slice(0, 5).join('; ')}${mismatches.length > 5 ? '; …' : ''}`
		});

		// Encryption.
		if (password !== undefined) {
			const aes256 = /^R = 6$/m.test(res.stdout) && /file encryption method: AESv3/.test(res.stdout);
			let locked = false;
			try {
				await inspectWithPdfjs(lib, bytes);
			} catch (e) {
				locked = e instanceof PdfjsOpenError && e.kind === 'password-required';
			}
			const ok = aes256 && locked && info !== null;
			checks.push({
				name: 'encryption',
				ok,
				detail: ok
					? 'AES-256: the file opens only with the password.'
					: `Encryption problem: ${!aes256 ? 'not AES-256. ' : ''}${!locked ? 'opens without the password. ' : ''}${info ? '' : 'does not open with the password.'}`.trim()
			});
		} else {
			const enc = await qpdf.run({ args: ['--is-encrypted', '/v.pdf'], inputs: { '/v.pdf': bytes } });
			const ok = enc.code === QPDF_ERROR && !/invalid password/i.test(enc.stderr);
			checks.push({
				name: 'encryption',
				ok,
				detail: ok ? 'No password, as planned.' : 'The file is encrypted although no password was set.'
			});
		}

		if (stripMetadata) {
			let left: string[] = [];
			try {
				left = metadataLeft(await dumpObjects(bytes, password));
			} catch {
				left = ['could not inspect objects'];
			}
			checks.push({
				name: 'structure',
				ok: left.length === 0,
				detail: left.length === 0 ? 'Metadata removed: no Info dictionary and no XMP streams remain.' : `Metadata still present: ${left.slice(0, 5).join(', ')}`
			});
		}
		return checks;
	}

	return engine;
}

// ---------------------------------------------------------------------------

interface QpdfJsonObject {
	value?: unknown;
	stream?: { dict?: unknown };
}
interface QpdfJson {
	header: Record<string, unknown>;
	objects: Record<string, QpdfJsonObject>;
}

function isDict(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}
const META_KEYS = ['/Metadata', '/PieceInfo'];
function hasMetadataKey(d: Record<string, unknown>) {
	return META_KEYS.some((k) => k in d);
}
function withoutMetadata(d: Record<string, unknown>) {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(d)) if (!META_KEYS.includes(k)) out[k] = v;
	return out;
}

/** Everything that still looks like document metadata in a qpdf JSON dump. */
export function metadataLeft(json: QpdfJson): string[] {
	const left: string[] = [];
	for (const [key, obj] of Object.entries(json.objects)) {
		const d = isDict(obj.value) ? obj.value : isDict(obj.stream?.dict) ? obj.stream!.dict : null;
		if (!d) continue;
		const isTrailer = key === 'trailer' || d['/Type'] === '/XRef';
		if (isTrailer && '/Info' in d) left.push(`${key} /Info`);
		for (const k of META_KEYS) if (k in d) left.push(`${key} ${k}`);
		if (d['/Type'] === '/Metadata') left.push(`${key} XMP stream`);
	}
	return left;
}

/** `--pages` arguments, grouping consecutive pages from the same file. */
export function pageSelection(pages: PageRef[], fileOf: Map<string, string>): string[] {
	const args: string[] = [];
	let file = '';
	let nums: number[] = [];
	const flush = () => {
		if (nums.length) args.push(file, nums.join(','));
	};
	for (const ref of pages) {
		const f = fileOf.get(ref.sourceId)!;
		if (f !== file) {
			flush();
			file = f;
			nums = [];
		}
		nums.push(ref.pageIndex + 1);
	}
	flush();
	return args;
}

export function rotateArgs(pages: PageRef[]): string[] {
	const by = new Map<Rotation, number[]>();
	pages.forEach((ref, i) => {
		if (ref.rotation === 0) return;
		const list = by.get(ref.rotation) ?? [];
		list.push(i + 1);
		by.set(ref.rotation, list);
	});
	return [...by.entries()].map(([angle, list]) => `--rotate=+${angle}:${list.join(',')}`);
}

function validateStamps(pageNo: number, stamps: Stamp[], assetIds: Set<string>) {
	const eps = 1e-6;
	const fin = (...n: number[]) => n.every((v) => typeof v === 'number' && Number.isFinite(v));
	const inUnit = (v: number) => v >= -eps && v <= 1 + eps;
	for (const s of stamps) {
		const bad = () => new EngineError('unsupported', `A stamp on page ${pageNo + 1} is outside the page. Move it onto the page and try again.`);
		if (s.kind === 'text') {
			if (typeof s.text !== 'string' || !fin(s.x, s.y, s.size)) throw bad();
			if (!inUnit(s.x) || !inUnit(s.y) || !(s.size > 0 && s.size <= 1)) throw bad();
			if (!['black', 'blue', 'red'].includes(s.color)) throw new EngineError('internal', 'Unknown text color.');
		} else {
			const b = s.box;
			if (!b || !fin(b.x, b.y, b.w, b.h)) throw bad();
			if (!(b.w > 0 && b.h > 0) || !inUnit(b.x) || !inUnit(b.y) || b.x + b.w > 1 + eps || b.y + b.h > 1 + eps) throw bad();
			if (s.kind === 'image' && !assetIds.has(s.assetId)) {
				throw new EngineError('internal', `A stamp on page ${pageNo + 1} uses an image that is missing.`);
			}
			if (s.kind === 'mark' && !['check', 'cross', 'dot'].includes(s.mark)) throw new EngineError('internal', 'Unknown mark.');
		}
	}
}

function validatePassword(pw: string) {
	if (pw.length === 0) throw new EngineError('unsupported', 'Choose a password with at least one character.');
	if (/[\p{C}]/u.test(pw)) throw new EngineError('unsupported', 'The password contains invisible characters. Use letters, digits and symbols.');
	if (new TextEncoder().encode(pw).length > 127) {
		throw new EngineError('unsupported', 'The password is too long. Use at most 127 bytes (about 100 characters).');
	}
	if (pw !== pw.normalize('NFKC')) {
		throw new EngineError('unsupported', 'The password contains characters that some PDF readers treat differently. Use other characters.');
	}
}

function drawFullPage(
	lib: typeof import('@cantoo/pdf-lib'),
	doc: import('@cantoo/pdf-lib').PDFDocument,
	imageRef: import('@cantoo/pdf-lib').PDFRef,
	size: PageSize,
	orientation: Orientation
) {
	const page = doc.addPage([size.width, size.height]);
	const name = page.node.newXObject('Im', imageRef);
	const m = orientationMatrix(orientation, size.width, size.height);
	page.pushOperators(
		lib.pushGraphicsState(),
		lib.concatTransformationMatrix(m[0], m[1], m[2], m[3], m[4], m[5]),
		lib.drawObject(name),
		lib.popGraphicsState()
	);
}

function unreadableMessage(stderr: string): string {
	if (/can't find PDF header|not a PDF/i.test(stderr) && /startxref|unable to find|xref/i.test(stderr)) {
		return 'This file is not a PDF, or it is too damaged to open.';
	}
	return 'This file is damaged and could not be repaired reliably.';
}

/** qpdf warnings → short plain-language notes. */
export function friendlyWarnings(stderr: string): string[] {
	const notes = new Set<string>();
	for (const raw of stderr.split('\n')) {
		const line = raw.trim();
		if (!line || /operation succeeded with warnings/i.test(line)) continue;
		if (/reconstruct|xref|cross-reference|startxref|file is damaged|trailer/i.test(line)) {
			notes.add('Repaired a damaged cross-reference table.');
		} else if (/stream|decod|filter|inflate|flate|lzw/i.test(line)) {
			notes.add('Some content in this file was damaged and may not display completely.');
		} else if (/header/i.test(line)) {
			notes.add('Ignored extra data before the start of the PDF.');
		} else if (/WARNING/i.test(line)) {
			notes.add('Fixed minor problems in the file’s structure.');
		}
	}
	if (notes.size) notes.add('Check that the pages look right.');
	return [...notes];
}

function firstLines(s: string) {
	return s.split('\n').filter(Boolean).slice(0, 3).join(' / ').slice(0, 300);
}

function fmt(n: number) {
	return String(Math.round(n * 100) / 100);
}

function now() {
	return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (e) {
		if (e instanceof EngineError) throw e;
		if (isOutOfMemory(e)) throw new EngineError('too-large', 'This is too large to process on this device.');
		const err = new EngineError('internal', 'Something went wrong inside the PDF engine. Nothing was changed.');
		(err as { cause?: unknown }).cause = e;
		throw err;
	}
}

