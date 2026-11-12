/**
 * The PDF engine, environment-neutral (Node for tests, a Web Worker in the app).
 * Environment specifics (where qpdf.wasm and the font come from, how PDF.js runs)
 * arrive as `EngineAssets`.
 *
 *   openPdf     qpdf --decrypt rewrite → PDF.js geometry
 *   openImage   pdf-lib one-page PDF → qpdf --check
 *   exportPlan  assemble (qpdf --pages, assemble.ts) → [forms] → [redact]
 *               → [stamps + numbering] → [shrink →] qpdf finalize → verify
 *
 * Stages in brackets run only when the plan asks for them. Each lives in its own
 * module (forms.ts, redact.ts, stamps.ts + numbering.ts, shrink.ts) and gets the
 * shared `EngineDeps`; this file only wires them together and enforces the rules
 * that span stages (redaction forces flatten and metadata removal, a target size
 * forces compression).
 */

import type {
	Asset,
	Engine,
	ExportPlan,
	ExportResult,
	FormValues,
	PageRef,
	PageSize,
	Rotation,
	Source,
	Stamp,
	VerifyCheck
} from '../core/types';
import type { EngineDeps } from './deps';
import { EngineError, isOutOfMemory } from './errors';
import { applyForms, detectForm, formsNeeded, listFormFields, verifyForms, type FormsContext } from './forms';
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
import { discardMupdf, isWasmFault, mupdf as loadMupdf, mupdfLoaded, type Mupdf } from './mupdf';
import { assemble } from './assemble';
import { hasGenerationConflict, listPages } from './intake';
import { numberingLabels, validateNumbering, verifyNumbering, type NumberingJob } from './numbering';
import { PdfjsOpenError, inspectWithPdfjs, type PdfjsLib } from './pdfjs';
import { QPDF_ERROR, QPDF_OK, QPDF_WARNINGS, Qpdf, type QpdfLoader, type QpdfResult } from './qpdf';
import { applyRedactions, verifyRedactions, type RedactJob } from './redact';
import { shrinkToTarget, type ShrinkReport } from './shrink';
import { applyStamps, type StampJob } from './stamps';
import { cleanupWithMupdf, cleanupWorthIt, estimateCleanup, sameStructure } from './cleanup';
import { libdeflate, libdeflateZlib } from './libdeflate';
import { dumpStreams, nativeDeflate, packStreams, type Deflater } from './pack';
import { TextDocs, pageTextOf } from './page-text';
import { NEED_BYTES } from './protocol';

export interface EngineAssets {
	qpdf: QpdfLoader;
	/** Bytes of src/lib/engine/fonts/NotoSans-Regular.ttf. */
	font: () => Promise<Uint8Array>;
	/** PDF.js, already configured to run in this environment (fake worker or nested worker). */
	pdfjs: () => Promise<PdfjsLib>;
	/** MuPDF loader; defaults to mupdf.ts (works in Node and, once configured, in the worker). */
	mupdf?: () => Promise<Mupdf>;
	/**
	 * Whether MuPDF's wasm is on this device already (the service worker's cache), so
	 * loading it costs no download. Absent (Node): treated as on the device.
	 */
	mupdfCached?: () => Promise<boolean>;
}

export interface EngineOptions {
	/** Largest single input accepted. Default 1 GiB. */
	maxInputBytes?: number;
	/** Largest total of sources referenced by one export. Default 1.5 GiB. */
	maxExportBytes?: number;
	newId?: () => string;
	/** Debug notes from stages that skip themselves silently ("avoid, don't fail"); never shown to the user. */
	debug?: (note: string) => void;
	/** Passes of lossless compression, all on by default (off only for measurements and tests). */
	lossless?: LosslessPasses;
}

export interface LosslessPasses {
	/** pack.ts stream pass. */
	pack?: boolean;
	/** qpdf --compression-level=9 for what qpdf compresses. */
	level9?: boolean;
	/** MuPDF cleanup (cleanup.ts) when its estimate says it is worth it ('always': on every file, for measuring). */
	cleanup?: boolean | 'always';
	/** libdeflate for the stream pass (fflate / the platform's zlib otherwise). */
	libdeflate?: boolean;
}

const SIZE_TOLERANCE = 0.5;
/** Files above this skip the lossless passes (memory); they still get object streams. */
const MAX_PASS_BYTES = 256 * 1024 * 1024;
/** Smallest ExportOptions.targetBytes accepted. */
const MIN_TARGET_BYTES = 20_000;
const STAMP_KINDS: readonly Stamp['kind'][] = ['image', 'text', 'mark', 'highlight', 'redact'];
const HIGHLIGHT_COLORS = ['yellow', 'green', 'pink'];
const MAX_PEN_POINTS = 2000;
const MAX_RECTS = 1000;
const MIN_PAGE = 3;
const MAX_PAGE = 14400;

export function createCoreEngine(assets: EngineAssets, options: EngineOptions = {}): Engine {
	const qpdf = new Qpdf(assets.qpdf);
	const font = new StampFont(assets.font);
	const maxInput = options.maxInputBytes ?? 1024 ** 3;
	const maxExport = options.maxExportBytes ?? 1.5 * 1024 ** 3;
	const newId = options.newId ?? (() => crypto.randomUUID());
	const debug = options.debug ?? (() => {});
	const passes: Required<LosslessPasses> = { pack: true, level9: true, cleanup: true, libdeflate: true, ...options.lossless };

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
	const deps: EngineDeps = { qpdf, mupdf: assets.mupdf ?? loadMupdf, pdfjs, pdfLib, font };
	/** Documents opened for Engine.pageText, by source id. */
	const textDocs = new TextDocs(2);

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

	/**
	 * Fallback for files qpdf rejects. This qpdf build does not run its own xref
	 * reconstruction (its recovery paths never trigger), so: pdf-lib re-reads the file
	 * object by object, ignoring the xref table, and writes a clean copy; qpdf must then
	 * accept that copy; and PDF.js, reading the original with its own recovery, must agree
	 * on the page count and every page size. Anything else is rejected.
	 */
	async function repair(bytes: Uint8Array): Promise<{ bytes: Uint8Array; notes: string[] } | null> {
		let original;
		try {
			original = await inspectWithPdfjs(await pdfjs(), bytes);
		} catch {
			return null;
		}
		if (original.numPages === 0) return null;
		let rebuilt: Uint8Array;
		try {
			const lib = await pdfLib();
			const doc = await lib.PDFDocument.load(bytes, {
				updateMetadata: false,
				throwOnInvalidObject: true,
				parseSpeed: lib.ParseSpeeds.Fastest
			});
			if (doc.isEncrypted) return null;
			rebuilt = await doc.save({
				useObjectStreams: false,
				addDefaultPage: false,
				updateFieldAppearances: false,
				objectsPerTick: Infinity
			});
		} catch {
			return null;
		}
		const res = await qpdf.run({
			args: ['--decrypt', '--object-streams=disable', '/r.pdf', '/out.pdf'],
			inputs: { '/r.pdf': rebuilt },
			outputs: ['/out.pdf']
		});
		const out = res.files.get('/out.pdf');
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !out) return null;
		let check;
		try {
			check = await inspectWithPdfjs(await pdfjs(), out);
		} catch {
			return null;
		}
		const same =
			check.numPages === original.numPages &&
			check.pages.every(
				(p, i) =>
					Math.abs(p.width - original.pages[i].width) <= SIZE_TOLERANCE &&
					Math.abs(p.height - original.pages[i].height) <= SIZE_TOLERANCE
			);
		if (!same) return null;
		return { bytes: out, notes: ['Repaired a damaged cross-reference table.', 'Check that the pages look right.'] };
	}

	const engine: Engine = {
		openPdf: (bytes, name, password) =>
			guard(async () => {
				if (bytes.length > maxInput) {
					throw new EngineError('too-large', 'This file is too large to open on this device.');
				}
				if (bytes.length === 0) throw new EngineError('unreadable', 'This file is empty.');
				const pw = password !== undefined && password !== '' ? [`--password=${password}`] : [];

				// No object streams in the opened copy: qpdf's --update-from-json (layers, the
				// in-place assemble, metadata removal) misses some objects that sit in object
				// streams, and preserving them can carry stale ones along (/Extends) that pdf-lib,
				// which ignores the xref, would read. Exports regenerate them when compressing.
				const res = await qpdf.run({
					args: [...pw, '--decrypt', '--object-streams=disable', '/in.pdf', '/out.pdf'],
					inputs: { '/in.pdf': bytes },
					outputs: ['/out.pdf']
				});
				let out = res.files.get('/out.pdf');
				let notes: string[];
				if (res.code === QPDF_ERROR || !out) {
					if (/invalid password/i.test(res.stderr)) {
						throw pw.length
							? new EngineError('password-wrong', 'That password did not open the file. Check it and try again.')
							: new EngineError('password-required', 'This file is protected with a password. Enter it to open the file.');
					}
					const repaired = await repair(bytes);
					if (!repaired) throw new EngineError('unreadable', unreadableMessage(res.stderr));
					out = repaired.bytes;
					notes = repaired.notes;
				} else if (res.code === QPDF_OK || res.code === QPDF_WARNINGS) {
					if (await hasGenerationConflict(qpdf, bytes, pw)) {
						throw new EngineError(
							'unreadable',
							'This file was saved inconsistently: PDF readers disagree about what some pages contain, so it cannot be edited reliably.'
						);
					}
					notes = res.code === QPDF_WARNINGS ? friendlyWarnings(res.stderr) : [];
				} else {
					throw new EngineError('internal', 'The PDF engine stopped unexpectedly while reading this file.');
				}

				const enc = await qpdf.run({ args: [...pw, '--is-encrypted', '/in.pdf'], inputs: { '/in.pdf': bytes } });
				const wasEncrypted = enc.code === QPDF_OK;
				const listed = await listPages(qpdf, out);
				if (listed && listed.fixedPages > 0) {
					out = listed.bytes;
					notes.push('Removed broken entries from the content of some pages.', 'Check that the pages look right.');
				}

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
				if (!listed || listed.pages !== info.numPages) {
					throw new EngineError('unreadable', 'This file’s page list is inconsistent, so it cannot be opened reliably.');
				}
				for (const p of info.pages) {
					if (!(p.width > 0 && p.height > 0 && Number.isFinite(p.width) && Number.isFinite(p.height))) {
						throw new EngineError('unreadable', 'This file has a page without a usable size.');
					}
				}
				if (wasEncrypted) {
					notes.push(
						pw.length
							? 'Opened with its password. Exports have no password unless you set one.'
							: 'This file was encrypted without an open password; the encryption and its restrictions were removed. Exports have no password unless you set one.'
					);
				}
				if (info.hasSignatures) {
					notes.push('This file has a digital signature. Exported pages will not carry a valid signature.');
				}
				if (info.hasXfa) {
					notes.push('This file contains an XFA form. Its pages may look different here than in Adobe Reader.');
				}
				const form = await detectForm(deps, out);
				notes.push(...form.notes);
				return {
					id: newId(),
					name,
					kind: 'pdf',
					bytes: out,
					pages: info.pages,
					originalSize: bytes.length,
					wasEncrypted,
					notes: [...new Set(notes)],
					...(form.hasForm ? { hasForm: true } : {})
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

		exportPlan: (plan, sources, assets) => guard(() => exportPlan(plan, sources, assets)),

		formFields: (source) => guard(async () => (source.hasForm === true ? listFormFields(deps, source) : [])),

		pageBlanks: (source, pageIndex) => guard(async () => (await import('./snap-tap')).pageBlanks(deps, source, pageIndex)),

		pageText: (source, pageIndex) =>
			guard(async () => {
				if (!source || source.kind !== 'pdf') return { words: [], skipped: 0 };
				if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= source.pages.length) {
					throw new EngineError('internal', 'That page is not in the file.');
				}
				const m = await deps.mupdf();
				// The client sends a source's bytes once; later calls name it by id (protocol.ts).
				const doc = textDocs.get(m, source.id, source.bytes instanceof Uint8Array ? source.bytes : undefined);
				if (!doc) throw new EngineError('internal', NEED_BYTES);
				if (pageIndex >= doc.countPages()) throw new EngineError('internal', 'That page is not in the file.');
				return pageTextOf(doc, pageIndex);
			})
	};

	async function exportPlan(plan: ExportPlan, sources: Source[], assetList: Asset[]): Promise<ExportResult> {
		const started = now();
		const { pages } = plan;
		if (pages.length === 0) throw new EngineError('unsupported', 'There are no pages to export.');
		const hasRedaction = pages.some((p) => p.stamps.some((s) => s.kind === 'redact'));
		const target = plan.options.targetBytes;
		// Rules that span stages: redaction strips metadata and flattens forms; a size target compresses.
		const options = {
			...plan.options,
			stripMetadata: plan.options.stripMetadata || hasRedaction,
			flattenForms: plan.options.flattenForms === true || hasRedaction,
			compress: plan.options.compress || target !== undefined
		};
		const password = options.password;
		if (password !== undefined) validatePassword(password);
		if (target !== undefined) validateTarget(target);
		if (options.numbering !== undefined) validateNumbering(options.numbering);

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
		const formValues = usedFormValues(plan.formValues, byId, fileOf);
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
		let numbering: NumberingJob | null = null;
		if (options.numbering !== undefined) {
			const labels = numberingLabels(options.numbering, pages.length);
			if (labels.every((l) => l === null)) {
				throw new EngineError('unsupported', 'Every page is set to be left without a number. Number fewer cover pages.');
			}
			const bad = await font.unsupportedChars(labels.filter((l) => l !== null).join(''));
			if (bad) throw new EngineError('unsupported', `The page numbers use characters the stamp font cannot draw: ${bad}`);
			numbering = { numbering: options.numbering, labels, expected };
		}

		const warnings: string[] = [];
		for (const s of used) {
			if (s.wasEncrypted && password === undefined) {
				warnings.push(`${s.name} had a password; the exported file has none.`);
			}
		}

		// (a) Assemble.
		let bytes = await assemble(qpdf, { pages, used, fileOf, run: (r, output) => runOrFail(r, output, warnings) });

		// (b) Forms: answers, appearances, flatten.
		const formsCtx: FormsContext = {
			pages: pages.map((ref) => ({ source: byId.get(ref.sourceId)!, pageIndex: ref.pageIndex, rotation: ref.rotation })),
			formValues,
			flatten: options.flattenForms,
			redactions: pages.map((ref) => ref.stamps.flatMap((s) => (s.kind === 'redact' ? [s.box] : [])))
		};
		const formsRan = formsNeeded(formsCtx);
		if (formsRan) bytes = await applyForms(deps, bytes, formsCtx, warnings);

		// (c) Redaction (verifies itself before returning).
		const redactJobs: RedactJob[] = [];
		const allowedText: string[][] = [];
		pages.forEach((ref, i) => {
			const boxes = ref.stamps.flatMap((s) => (s.kind === 'redact' ? [s.box] : []));
			if (boxes.length === 0) return;
			const overlays = ref.stamps.flatMap((s) => (s.kind === 'image' || s.kind === 'mark' || s.kind === 'highlight' ? [s.box] : []));
			redactJobs.push({ pageIndex: i, boxes, expected: expected[i], overlays });
			allowedText.push([
				...ref.stamps.flatMap((s) => (s.kind === 'text' ? normalizeStampText(s.text).split('\n').filter(Boolean) : [])),
				...(numbering?.labels[i] ? [numbering.labels[i]!] : [])
			]);
		});
		if (redactJobs.length) bytes = await applyRedactions(deps, bytes, redactJobs, warnings);

		// (d) Stamps and page numbers.
		const jobs: StampJob[] = [];
		pages.forEach((ref, i) => {
			const stamps = ref.stamps.filter(
				(s) => s.kind !== 'redact' && (s.kind !== 'text' || normalizeStampText(s.text).replace(/\n/g, '') !== '')
			);
			if (stamps.length) jobs.push({ pageIndex: i, stamps, expected: expected[i] });
		});
		if (jobs.length || numbering) {
			const [lib, fk] = await Promise.all([pdfLib(), font.fontkit()]);
			bytes = await applyStamps(
				{ lib, fontkit: fk, fontBytes: () => font.bytes() },
				bytes,
				jobs,
				assetList,
				numbering ?? undefined,
				warnings
			);
		}

		// (e) [Shrink →] finalize.
		let final: Uint8Array;
		let shrink: ShrinkReport | undefined;
		const stageChecks: VerifyCheck[] = [];
		const alt: Alternative = {};
		if (target !== undefined) {
			// Shrinking finalizes every step it tries: the MuPDF cleanup runs once, here,
			// and each step gets the stream pass only.
			const cleaned = await cleanupOnly(bytes);
			const finalize = (b: Uint8Array) => finalizeBytes(b, options, warnings, undefined, false);
			const r = await shrinkToTarget(deps, cleaned, target, finalize);
			final = r.bytes;
			shrink = r.shrink;
			stageChecks.push(...r.checks);
		} else {
			final = await finalizeBytes(bytes, options, warnings, alt);
		}

		// (f) Verify.
		const verifyAll = async (file: Uint8Array, w: string[]) => {
			const checks = await verify(file, expected, password, options.stripMetadata, used, w);
			if (formsRan) checks.push(...(await verifyForms(deps, file, formsCtx, password)));
			if (redactJobs.length) checks.push(...(await verifyRedactions(deps, file, redactJobs, allowedText, password, (shrink?.imagesChanged ?? 0) > 0)));
			if (numbering) checks.push(...(await verifyNumbering(deps, file, numbering.labels, password, numbering.numbering)));
			checks.push(...stageChecks);
			return checks;
		};
		let checks = await verifyAll(final, warnings);
		if (!checks.every((c) => c.ok) && alt.bytes) {
			// The compressed file failed a check: the same plan without compression may not.
			debug(`compress: packed file failed verification (${checks.filter((c) => !c.ok).map((c) => c.name).join(', ')}); trying the uncompressed result`);
			const w = [...warnings.filter((x) => !(alt.dropWarnings ?? []).includes(x)), ...(alt.warnings ?? [])];
			const again = await verifyAll(alt.bytes, w);
			if (again.every((c) => c.ok)) {
				final = alt.bytes;
				checks = again;
				warnings.length = 0;
				warnings.push(...w);
			}
		}
		if (!checks.every((c) => c.ok)) {
			throw new EngineError('verification-failed', 'The exported file did not pass its checks, so it was not saved.', checks);
		}
		const result: ExportResult = {
			bytes: final,
			pageCount: pages.length,
			checks,
			warnings: [...new Set(warnings)],
			elapsedMs: Math.round(now() - started)
		};
		if (shrink) result.shrink = shrink;
		return result;
	}

	/**
	 * Finalize: compression, metadata removal, AES-256.
	 *
	 * With `compress` (lossless): the stream pass (pack.ts) re-encodes each stream
	 * only where that is smaller and exact, then qpdf packs objects into object
	 * streams and compresses what is still uncompressed (level 9). The same plan
	 * finalized without compression is built too, and whichever is smaller is
	 * returned: a compressed export is never larger than the uncompressed one.
	 * Any trouble in the new passes falls back to that uncompressed file.
	 */
	async function finalizeBytes(
		bytes: Uint8Array,
		options: { compress: boolean; stripMetadata: boolean; password?: string },
		warnings: string[],
		alt?: Alternative,
		withCleanup = true
	): Promise<Uint8Array> {
		if (!options.compress) return finalizeRun(bytes, options, warnings);
		const plainWarnings: string[] = [];
		const plain = await finalizeRun(bytes, { ...options, compress: false }, plainWarnings).catch((e: unknown) => e);
		const packWarnings: string[] = [];
		let packed: Uint8Array | unknown;
		try {
			packed = await finalizeRun(await losslessPre(bytes, { cleanup: withCleanup, pack: true }), options, packWarnings);
		} catch (e) {
			if (isWasmFault(e)) throw e;
			packed = e;
		}
		if (packed instanceof Uint8Array && (!(plain instanceof Uint8Array) || packed.length <= plain.length)) {
			warnings.push(...packWarnings);
			if (alt && plain instanceof Uint8Array) {
				alt.bytes = plain;
				alt.warnings = plainWarnings;
				alt.dropWarnings = packWarnings;
			}
			return packed;
		}
		if (!(packed instanceof Uint8Array)) debug(`compress: packed finalize failed (${packed instanceof Error ? packed.message : String(packed)}); using the uncompressed result`);
		else debug(`compress: packed ${packed.length} > uncompressed ${(plain as Uint8Array).length}; using the uncompressed result`);
		if (!(plain instanceof Uint8Array)) throw plain;
		warnings.push(...plainWarnings);
		return plain;
	}

	/** The MuPDF cleanup alone (for the size-target path); `bytes` when it does not run or is rejected. */
	async function cleanupOnly(bytes: Uint8Array): Promise<Uint8Array> {
		if (!passes.cleanup) return bytes;
		try {
			return await losslessPre(bytes, { cleanup: true, pack: false });
		} catch (e) {
			if (isWasmFault(e)) throw e;
			debug(`cleanup: failed (${e instanceof Error ? e.message : String(e)}); skipped`);
			return bytes;
		}
	}

	/**
	 * The lossless passes before the compressed finalize: [MuPDF cleanup when worth it]
	 * → stream pass. Each one that errors, runs out of time or would change the
	 * file's structure is skipped (debug note only); `bytes` is the fallback.
	 */
	async function losslessPre(bytes: Uint8Array, which = { cleanup: true, pack: true }): Promise<Uint8Array> {
		const doCleanup = passes.cleanup !== false && which.cleanup;
		const doPack = passes.pack && which.pack;
		if (!doPack && !doCleanup) return bytes;
		if (bytes.length > MAX_PASS_BYTES) {
			// The passes hold the file about three times over (qpdf's dump, the streams, the
			// rewrite); this large, qpdf's object streams alone are safer for memory.
			debug(`lossless: ${bytes.length} bytes is over ${MAX_PASS_BYTES}; passes skipped`);
			return bytes;
		}
		const t0 = now();
		const mb = bytes.length / 1e6;
		let dump = await dumpStreams(qpdf, bytes);
		if (!dump) {
			debug('lossless: qpdf could not list the streams; passes skipped');
			return bytes;
		}
		let src = bytes;
		if (doCleanup) {
			const est = await estimateCleanup(dump);
			const cost = mupdfLoaded() ? 'loaded' : (await assets.mupdfCached?.().catch(() => false)) === false ? 'download' : 'cached';
			const run = passes.cleanup === 'always' || cleanupWorthIt(est, bytes.length, cost);
			debug(`cleanup: estimate ${Math.round(est.gain)} bytes (fonts ${est.fontBytes}, whole ${est.fullFontBytes}, duplicates ${est.dupBytes}, subset ${est.subset}), MuPDF ${cost}: ${run ? 'run' : 'skip'}`);
			if (run) {
				const c = await cleanupWithMupdf(deps, bytes, est.subset, debug);
				if (c && c.length < bytes.length) {
					const d2 = await dumpStreams(qpdf, c);
					const why = d2 ? sameStructure(dump, d2) : 'qpdf could not list the cleaned file';
					if (!why && d2) {
						debug(`cleanup: ${bytes.length} → ${c.length} bytes`);
						src = c;
						dump = d2;
					} else debug(`cleanup: result rejected (${why})`);
				} else if (c) debug(`cleanup: not smaller (${bytes.length} → ${c.length}); skipped`);
			}
		}
		if (!doPack) return src;
		let deflate: Deflater = nativeDeflate;
		let polish: Deflater | undefined;
		if (passes.libdeflate) {
			try {
				await libdeflateZlib(new Uint8Array(1), 6);
				deflate = libdeflate(6);
				polish = libdeflate(12);
			} catch (e) {
				debug(`pack: libdeflate did not load (${e instanceof Error ? e.message : String(e)}); platform zlib used`);
			}
		}
		const r = await packStreams(
			qpdf,
			src,
			{
				deflate,
				polish,
				// Budgets ("avoid, don't fail": what is left over stays as it is). The fast pass
				// (libdeflate 6) stops 6 s plus 0.1 s per MB after the passes began, on this device's
				// clock. Polishing (libdeflate 12, about 4 MB/s on a desktop, perhaps 1 MB/s on a
				// phone) takes the biggest streams first, up to 2 MB plus twice the file's size and
				// at most 12 MB of data, and stops after 4 s.
				deadline: t0 + 6_000 + 100 * mb,
				polishBytes: Math.min(12e6, 2e6 + 2 * bytes.length),
				polishMs: 4_000,
				note: debug
			},
			dump
		);
		const st = r.stats;
		debug(`pack: ${st.changed}/${st.streams} streams re-encoded (${st.predicted} predicted, ${st.polished} polished), ${st.saved} bytes saved, ${st.ms} ms`);
		return r.bytes;
	}

	/** One qpdf finalize run. `compress`: object streams, level 9 for uncompressed streams; existing Flate data is kept. */
	async function finalizeRun(
		bytes: Uint8Array,
		options: { compress: boolean; stripMetadata: boolean; password?: string },
		warnings: string[]
	): Promise<Uint8Array> {
		const finalArgs: string[] = ['/in/doc.pdf'];
		const finalInputs: Record<string, Uint8Array> = { '/in/doc.pdf': bytes };
		if (options.compress) {
			finalArgs.push('--object-streams=generate', '--compress-streams=y');
			if (passes.level9) finalArgs.push('--compression-level=9');
		}
		if (options.stripMetadata) {
			const update = await metadataRemoval(bytes);
			if (update) {
				finalInputs['/in/update.json'] = update;
				finalArgs.push('--update-from-json=/in/update.json');
			}
			finalArgs.push('--remove-info', '--remove-metadata');
		}
		if (options.password !== undefined) {
			const pw = options.password;
			finalArgs.push('--encrypt', `--user-password=${pw}`, `--owner-password=${pw}`, '--bits=256', '--');
		}
		finalArgs.push('/out/final.pdf');
		return runOrFail({ args: finalArgs, inputs: finalInputs, outputs: ['/out/final.pdf'] }, '/out/final.pdf', warnings);
	}

	async function runOrFail(
		run: { args: string[]; inputs: Record<string, Uint8Array>; outputs: string[] },
		output: string,
		warnings: string[]
	): Promise<Uint8Array> {
		const res = await qpdf.run(run);
		const file = res.files.get(output);
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) failBuild(res);
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
			if (isDict(dict) && dict['/Type'] === '/Metadata') {
				// The XMP packet itself is emptied, so no reference to it (a marked-content
				// property list can point straight at one) keeps the metadata alive.
				updates[key] = { stream: { dict: {}, data: '' } };
			} else if (isDict(value) && value['/Type'] === '/Metadata') {
				// A metadata dictionary that lost its stream (damaged file): nothing to keep.
				updates[key] = { value: {} };
			} else if (isDict(value) && hasMetadataKey(value)) {
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
		// Warnings (exit 3) still give the whole dump: they report damage qpdf read past, such
		// as a name with a stray "#", which the original already has.
		if ((res.code !== QPDF_OK && res.code !== QPDF_WARNINGS) || !file) {
			throw new EngineError('internal', 'The PDF engine could not inspect the file.');
		}
		const parsed = JSON.parse(new TextDecoder().decode(file)) as { qpdf: [Record<string, unknown>, Record<string, QpdfJsonObject>] };
		return { header: parsed.qpdf[0], objects: parsed.qpdf[1] };
	}

	async function verify(
		bytes: Uint8Array,
		expected: PageSize[],
		password: string | undefined,
		stripMetadata: boolean,
		sources: Source[],
		warnings: string[]
	): Promise<VerifyCheck[]> {
		const checks: VerifyCheck[] = [];
		const pw = password !== undefined ? [`--password=${password}`] : [];
		const lib = await pdfjs();

		// Structure and page count from qpdf.
		const res = await qpdf.run({ args: [...pw, '--check', '--show-npages', '/v.pdf'], inputs: { '/v.pdf': bytes } });
		let clean = res.code === QPDF_OK && /No syntax or stream encoding errors found/.test(res.stdout);
		let detail = clean
			? 'qpdf --check found no syntax or stream errors.'
			: `qpdf --check reported problems (exit ${res.code}): ${firstLines(res.stderr || res.stdout)}`;
		if (!clean) {
			// Damage the sources already have is copied, not made, by the export. Only the same
			// kinds of problems as in the sources are accepted, and only warnings: after a fatal
			// error qpdf stops checking, so the rest of the file would go unchecked.
			const found = checkProblems(`${res.stderr}\n${res.stdout}`);
			const known = { warnings: new Set<string>(), fatal: new Set<string>() };
			for (const s of sources) {
				const r = await qpdf.run({ args: ['--check', '/s.pdf'], inputs: { '/s.pdf': s.bytes } });
				const p = checkProblems(`${r.stderr}\n${r.stdout}`);
				p.warnings.forEach((w) => known.warnings.add(w));
				p.fatal.forEach((f) => known.fatal.add(f));
			}
			if (found.fatal.length && found.fatal.every((f) => known.fatal.has(f))) {
				throw new EngineError(
					'unreadable',
					'Part of this file (such as an image) is damaged and cannot be read, so the exported file could not be checked. Nothing was saved.'
				);
			}
			if (res.code === QPDF_WARNINGS && found.fatal.length === 0 && found.warnings.length && found.warnings.every((w) => known.warnings.has(w))) {
				clean = true;
				detail = `qpdf --check found only damage the original already has, copied unchanged: ${[...new Set(found.warnings)].slice(0, 3).join('; ')}.`;
				warnings.push('Some content of the original file is damaged; it was copied unchanged. Check that the pages look right.');
			}
		}
		checks.push({ name: 'structure', ok: clean, detail });
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

/** The second candidate of a compressed finalize, kept for a fallback when the chosen one fails verification. */
interface Alternative {
	bytes?: Uint8Array;
	warnings?: string[];
	/** Warnings that came with the chosen candidate only. */
	dropWarnings?: string[];
}

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
/** True when the dictionary, or a dictionary or array nested in it directly, has a metadata key. */
function hasMetadataKey(d: Record<string, unknown>, depth = 0): boolean {
	if (META_KEYS.some((k) => k in d)) return true;
	return depth < 32 && Object.values(d).some((v) => hasMetadataIn(v, depth + 1));
}
function hasMetadataIn(v: unknown, depth: number): boolean {
	if (Array.isArray(v)) return depth < 32 && v.some((x) => hasMetadataIn(x, depth + 1));
	return isDict(v) && hasMetadataKey(v, depth);
}
/** The dictionary without metadata keys, also in dictionaries and arrays nested in it directly. */
function withoutMetadata(d: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(d)) if (!META_KEYS.includes(k)) out[k] = stripNested(v);
	return out;
}
function stripNested(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(stripNested);
	return isDict(v) ? withoutMetadata(v) : v;
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
		if (!META_KEYS.some((k) => k in d) && hasMetadataKey(d)) left.push(`${key} nested /Metadata`);
		if (d['/Type'] === '/Metadata') left.push(`${key} XMP stream`);
	}
	return left;
}

export { pageSelection, rotateArgs } from './assemble';

function validateStamps(pageNo: number, stamps: Stamp[], assetIds: Set<string>) {
	const eps = 1e-6;
	const fin = (...n: number[]) => n.every((v) => typeof v === 'number' && Number.isFinite(v));
	const inUnit = (v: number) => v >= -eps && v <= 1 + eps;
	for (const s of stamps) {
		const bad = () => new EngineError('unsupported', `A stamp on page ${pageNo + 1} is outside the page. Move it onto the page and try again.`);
		if (!STAMP_KINDS.includes(s?.kind)) throw new EngineError('internal', `A stamp on page ${pageNo + 1} is of an unknown kind.`);
		if (s.kind === 'text') {
			if (typeof s.text !== 'string' || !fin(s.x, s.y, s.size)) throw bad();
			if (!inUnit(s.x) || !inUnit(s.y) || !(s.size > 0 && s.size <= 1)) throw bad();
			if (!['black', 'blue', 'red'].includes(s.color)) throw new EngineError('internal', 'Unknown text color.');
		} else {
			// image, mark, highlight, redact: a box inside the page with a positive size.
			const b = s.box;
			if (!b || !fin(b.x, b.y, b.w, b.h)) throw bad();
			if (!(b.w > 0 && b.h > 0) || !inUnit(b.x) || !inUnit(b.y) || b.x + b.w > 1 + eps || b.y + b.h > 1 + eps) throw bad();
			if (s.kind === 'image' && !assetIds.has(s.assetId)) {
				throw new EngineError('internal', `A stamp on page ${pageNo + 1} uses an image that is missing.`);
			}
			if (s.kind === 'mark' && !['check', 'cross', 'dot'].includes(s.mark)) throw new EngineError('internal', 'Unknown mark.');
			if (s.kind === 'highlight' && !HIGHLIGHT_COLORS.includes(s.color)) throw new EngineError('internal', 'Unknown highlight colour.');
			if (s.kind === 'highlight' && s.pen !== undefined) {
				// A pen stroke: 2+ points on the page and inside its box (the box is what
				// redaction checks treat as ours), and a positive width.
				const pen = s.pen;
				if (!pen || !Array.isArray(pen.points) || pen.points.length < 2 || pen.points.length > MAX_PEN_POINTS) throw bad();
				if (!fin(pen.width) || !(pen.width > 0 && pen.width <= 0.5)) throw bad();
				for (const p of pen.points) {
					if (!p || !fin(p.x, p.y) || !inUnit(p.x) || !inUnit(p.y)) throw bad();
					if (p.x < b.x - eps || p.x > b.x + b.w + eps || p.y < b.y - eps || p.y > b.y + b.h + eps) throw bad();
				}
			}
			if (s.kind === 'highlight' && s.rects !== undefined) {
				// A text highlight: 1+ rectangles on the page and inside its box (the box is
				// what redaction checks treat as ours); never together with a pen stroke.
				const rects = s.rects;
				if (s.pen !== undefined || !Array.isArray(rects) || rects.length < 1 || rects.length > MAX_RECTS) throw bad();
				for (const r of rects) {
					if (!r || !fin(r.x, r.y, r.w, r.h) || !(r.w > 0 && r.h > 0)) throw bad();
					if (r.x < b.x - eps || r.y < b.y - eps || r.x + r.w > b.x + b.w + eps || r.y + r.h > b.y + b.h + eps) throw bad();
				}
			}
		}
	}
}

function validateTarget(target: number) {
	if (typeof target !== 'number' || !Number.isInteger(target) || target < MIN_TARGET_BYTES) {
		throw new EngineError('unsupported', `Choose a target size of at least ${MIN_TARGET_BYTES / 1000} KB.`);
	}
}

/**
 * plan.formValues limited to the sources this plan uses. Every key must be an open
 * source and every value a FormValue; answers for open sources the plan does not
 * use are dropped.
 */
function usedFormValues(values: FormValues | undefined, open: Map<string, Source>, usedFiles: Map<string, string>): FormValues {
	const out: FormValues = {};
	if (values === undefined) return out;
	if (typeof values !== 'object' || values === null) throw new EngineError('internal', 'The form answers are malformed.');
	for (const [sourceId, fields] of Object.entries(values)) {
		if (!open.has(sourceId)) throw new EngineError('internal', 'Form answers refer to a file that is no longer open.');
		if (typeof fields !== 'object' || fields === null) throw new EngineError('internal', 'The form answers are malformed.');
		for (const v of Object.values(fields)) {
			const ok = typeof v === 'string' || typeof v === 'boolean' || (Array.isArray(v) && v.every((x) => typeof x === 'string'));
			if (!ok) throw new EngineError('internal', 'The form answers are malformed.');
		}
		if (usedFiles.has(sourceId) && Object.keys(fields).length > 0) out[sourceId] = fields;
	}
	return out;
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

/**
 * qpdf could not write an export. Damage in the source (data qpdf cannot decode or parse)
 * is the file's problem, said plainly; anything else is the engine's.
 */
function failBuild(res: QpdfResult): never {
	if (/bad_alloc|out of memory/i.test(res.stderr)) throw new EngineError('too-large', 'This file is too large to process on this device.');
	const damaged = /inflate|decod|jpeg|DCT|stream|parse|expected|invalid|damaged|unexpected/i.test(res.stderr);
	const err = damaged
		? new EngineError('unreadable', 'Part of this file is damaged and could not be copied, so nothing was saved.')
		: new EngineError('internal', 'The PDF engine could not build the file. Nothing was saved.');
	(err as { cause?: unknown }).cause = `qpdf exit ${res.code}: ${res.stderr}`;
	throw err;
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

/**
 * Problems in `qpdf --check` output, reduced to what went wrong (object numbers, offsets and
 * file names removed) so the same damage reads the same in a source and in its export.
 */
export function checkProblems(output: string): { warnings: string[]; fatal: string[] } {
	const warnings: string[] = [];
	const fatal: string[] = [];
	const what = (s: string) => {
		const i = s.lastIndexOf('): ');
		const msg = i >= 0 ? s.slice(i + 3) : s.replace(/^\/\S*:\s*/, '');
		return msg.replace(/\d+/g, '#').trim();
	};
	for (const raw of output.split('\n')) {
		const line = raw.trim();
		if (!line || /operation succeeded with warnings/i.test(line)) continue;
		const w = /^WARNING:\s*(.*)$/.exec(line);
		if (w) {
			warnings.push(what(w[1]));
			continue;
		}
		const f = /^(?:this\.program|qpdf):\s*(.*)$/.exec(line);
		if (f) fatal.push(what(f[1]));
	}
	return { warnings, fatal };
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
		if (e instanceof EngineError) {
			if (isWasmFault((e as { cause?: unknown }).cause)) discardMupdf();
			throw e;
		}
		if (isWasmFault(e)) {
			// A WebAssembly trap: MuPDF's instance is not trusted again (see mupdf.ts).
			discardMupdf();
			const err = new EngineError('unsupported', 'This file made the PDF engine fail, so nothing was saved. The file itself was not changed.');
			(err as { cause?: unknown }).cause = e;
			throw err;
		}
		if (isOutOfMemory(e)) throw new EngineError('too-large', 'This is too large to process on this device.');
		const err = new EngineError('internal', 'Something went wrong inside the PDF engine. Nothing was changed.');
		(err as { cause?: unknown }).cause = e;
		throw err;
	}
}

