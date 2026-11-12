/**
 * File intake: turns dropped, picked or pasted files into sources in the store,
 * one file at a time in the order given. Never throws: every failure becomes a
 * plain error toast naming the file, and the rest of the batch carries on.
 */

import type { PageId, Source } from '../core/types';
import type { DocStore } from '../doc/store';
import type { EngineClient } from '../engine/client';
import { EngineError } from '../engine/errors';
import { classifyFile, pngName } from './logic';

export interface IntakeJob {
	id: number;
	name: string;
	status: 'waiting' | 'opening' | 'password';
}

export interface PasswordAsk {
	name: string;
	/** Set after a wrong password. */
	error?: string;
}

export interface IntakeDeps {
	store: DocStore;
	engine: EngineClient;
	/** Resolve with the password, or null to skip the file. */
	askPassword: (ask: PasswordAsk) => Promise<string | null>;
	notify: (msg: { message: string; tone?: 'info' | 'ok' | 'error' }) => void;
	/** A batch finished; `ids` are the new pages in order. */
	onBatchDone: (result: { ids: PageId[]; insertedAt: number; anchored: boolean }) => void;
	/** The first page of a batch exists (scroll it into view early). */
	onFirstPages?: (ids: PageId[]) => void;
	/**
	 * A file opened, before its pages are added. `original` is the file as given;
	 * `needsPassword` says the user had to type a password to open it (the password
	 * itself is never passed on).
	 */
	onOpened?: (source: Source, info: { original: Uint8Array; needsPassword: boolean }) => void;
}

const MAX_IMAGE_PIXELS = 100_000_000;
/** The "this PDF has a form" note is shown once per visit. */
let formNoteShown = false;

export function createIntake(deps: IntakeDeps) {
	const { store, engine } = deps;
	let nextId = 1;
	const jobs = $state<IntakeJob[]>([]);
	/** True until the first engine call settles: the worker and qpdf are loading. */
	let engineCold = $state(true);
	let running = false;
	const batches: { files: File[]; jobIds: number[] }[] = [];

	function add(files: File[]) {
		if (files.length === 0) return;
		const jobIds = files.map((f) => {
			const id = nextId++;
			jobs.push({ id, name: f.name || 'pasted file', status: 'waiting' });
			return id;
		});
		batches.push({ files, jobIds });
		if (!running) void run();
	}

	function setStatus(id: number, status: IntakeJob['status']) {
		const j = jobs.find((x) => x.id === id);
		if (j) j.status = status;
	}

	function drop(id: number) {
		const i = jobs.findIndex((x) => x.id === id);
		if (i >= 0) jobs.splice(i, 1);
	}

	async function run() {
		running = true;
		try {
			while (batches.length) {
				const batch = batches.shift()!;
				await runBatch(batch.files, batch.jobIds);
			}
		} finally {
			running = false;
		}
	}

	async function runBatch(files: File[], jobIds: number[]) {
		// Open every file first (in order, one at a time), then add them all in one
		// undo step, so "Undo" takes back the whole drop.
		const s0 = store.state;
		let anchor: PageId | null = null;
		for (const p of s0.pages) if (s0.selection.has(p.id)) anchor = p.id;
		const opened: { source: Source; name: string }[] = [];

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const jobId = jobIds[i];
			const name = file.name || 'pasted file';
			setStatus(jobId, 'opening');
			try {
				const source = await openFile(file, name, jobId);
				if (source && source.pages.length) opened.push({ source, name });
			} catch (e) {
				deps.notify({ message: describeError(name, e), tone: 'error' });
			} finally {
				drop(jobId);
			}
		}
		if (!opened.length) return;

		// Insert after the selection as it was when the drop started, if that page still exists.
		const pages = store.state.pages;
		const anchorAt = anchor ? pages.findIndex((p) => p.id === anchor) + 1 : 0;
		const anchored = anchorAt > 0;
		const insertedAt = anchored ? anchorAt : pages.length;
		const label = opened.length === 1 ? `Add ${opened[0].source.name}` : `Add ${opened.length} files`;
		const added: PageId[] = [];
		store.transaction(label, () => {
			for (const { source } of opened) added.push(...store.addSource(source, insertedAt + added.length));
		});
		for (const { source, name } of opened) {
			for (const note of source.notes) deps.notify({ message: `${name}: ${note}` });
		}
		const form = opened.find((o) => o.source.hasForm);
		if (form && !formNoteShown) {
			formNoteShown = true;
			deps.notify({ message: `${form.name} has a form you can fill in. Open a page marked “Form” to fill it.` });
		}
		deps.onFirstPages?.(added);
		deps.onBatchDone({ ids: added, insertedAt, anchored });
	}

	async function call<T>(p: Promise<T>): Promise<T> {
		try {
			return await p;
		} finally {
			engineCold = false;
		}
	}

	function reportOpened(source: Source, original: Uint8Array, needsPassword: boolean): Source {
		if (source.pages.length) {
			try {
				deps.onOpened?.(source, { original, needsPassword });
			} catch (e) {
				console.warn('onOpened failed', e);
			}
		}
		return source;
	}

	async function openFile(file: File, name: string, jobId: number): Promise<Source | null> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.length === 0) throw new EngineError('unreadable', `${name} is empty.`);
		const kind = classifyFile(bytes.subarray(0, 1100), name, file.type);
		switch (kind.kind) {
			case 'unsupported':
				throw new EngineError('unsupported', kind.reason);
			case 'image':
				return reportOpened(await call(engine.openImage(bytes, kind.mime, name)), bytes, false);
			case 'convert': {
				const png = await toPng(file, name);
				return reportOpened(await call(engine.openImage(png, 'image/png', pngName(name))), png, false);
			}
			case 'pdf':
				return openPdf(bytes, name, jobId);
		}
	}

	async function openPdf(bytes: Uint8Array, name: string, jobId: number): Promise<Source | null> {
		try {
			return reportOpened(await call(engine.openPdf(bytes, name)), bytes, false);
		} catch (e) {
			if (!(e instanceof EngineError) || e.code !== 'password-required') throw e;
		}
		let error: string | undefined;
		for (;;) {
			setStatus(jobId, 'password');
			const pw = await deps.askPassword({ name, error });
			if (pw === null) return null;
			setStatus(jobId, 'opening');
			try {
				return reportOpened(await call(engine.openPdf(bytes, name, pw)), bytes, true);
			} catch (e) {
				if (e instanceof EngineError && (e.code === 'password-wrong' || e.code === 'password-required')) {
					error = 'That password did not open the file. Check it and try again.';
					continue;
				}
				throw e;
			}
		}
	}

	return {
		get jobs(): readonly IntakeJob[] {
			return jobs;
		},
		get engineCold() {
			return engineCold;
		},
		get busy() {
			return jobs.length > 0;
		},
		add
	};
}

export type Intake = ReturnType<typeof createIntake>;

function describeError(name: string, e: unknown): string {
	if (e instanceof EngineError) {
		// Messages that already name the file stand alone.
		if (e.message.includes(name)) return e.message;
		return `Could not open ${name}. ${e.message}`;
	}
	return `Could not open ${name}. Something went wrong while reading it; nothing was added.`;
}

/** Decode an image the browser understands (WebP, GIF, BMP, HEIC on Safari...) and re-encode as PNG. */
async function toPng(file: File, name: string): Promise<Uint8Array> {
	let bmp: ImageBitmap;
	try {
		bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
	} catch {
		const heic = /\.(heic|heif)$/i.test(name) || /hei[cf]/i.test(file.type);
		throw new EngineError(
			'unsupported',
			heic
				? `Could not open ${name}. This browser cannot read HEIC photos. Save it as JPEG first, or open it in Safari.`
				: `Could not open ${name}. The image may be damaged, or this browser cannot read its format. Save it as PNG or JPEG and try again.`
		);
	}
	try {
		if (bmp.width * bmp.height > MAX_IMAGE_PIXELS) {
			throw new EngineError('too-large', `Could not open ${name}. The image is too large to convert on this device.`);
		}
		let blob: Blob | null;
		if (typeof OffscreenCanvas !== 'undefined') {
			const c = new OffscreenCanvas(bmp.width, bmp.height);
			c.getContext('2d')!.drawImage(bmp, 0, 0);
			blob = await c.convertToBlob({ type: 'image/png' });
		} else {
			const c = document.createElement('canvas');
			c.width = bmp.width;
			c.height = bmp.height;
			c.getContext('2d')!.drawImage(bmp, 0, 0);
			blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
		}
		if (!blob) throw new EngineError('internal', `Could not convert ${name} to PNG.`);
		return new Uint8Array(await blob.arrayBuffer());
	} finally {
		bmp.close();
	}
}
