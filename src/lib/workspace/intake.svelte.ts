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
}

const MAX_IMAGE_PIXELS = 100_000_000;

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
		// Insert after the selection, if any; keep the batch together by anchoring
		// to the last inserted page, so concurrent edits do not split it.
		const s = store.state;
		let anchor: PageId | null = null;
		const anchored = s.selection.size > 0;
		if (anchored) {
			for (const p of s.pages) if (s.selection.has(p.id)) anchor = p.id;
		}
		const insertedAt = anchor ? s.pages.findIndex((p) => p.id === anchor) + 1 : s.pages.length;
		const added: PageId[] = [];

		for (let i = 0; i < files.length; i++) {
			const file = files[i];
			const jobId = jobIds[i];
			const name = file.name || 'pasted file';
			setStatus(jobId, 'opening');
			try {
				const source = await openFile(file, name, jobId);
				if (source) {
					const at = anchor ? store.state.pages.findIndex((p) => p.id === anchor) + 1 : undefined;
					const ids = store.addSource(source, at !== undefined && at > 0 ? at : undefined);
					if (ids.length) {
						if (added.length === 0) deps.onFirstPages?.(ids);
						added.push(...ids);
						if (anchor) anchor = ids[ids.length - 1];
					}
					for (const note of source.notes) deps.notify({ message: `${name}: ${note}` });
				}
			} catch (e) {
				deps.notify({ message: describeError(name, e), tone: 'error' });
			} finally {
				drop(jobId);
			}
		}
		if (added.length) deps.onBatchDone({ ids: added, insertedAt, anchored });
	}

	async function call<T>(p: Promise<T>): Promise<T> {
		try {
			return await p;
		} finally {
			engineCold = false;
		}
	}

	async function openFile(file: File, name: string, jobId: number): Promise<Source | null> {
		const bytes = new Uint8Array(await file.arrayBuffer());
		if (bytes.length === 0) throw new EngineError('unreadable', `${name} is empty.`);
		const kind = classifyFile(bytes.subarray(0, 1100), name, file.type);
		switch (kind.kind) {
			case 'unsupported':
				throw new EngineError('unsupported', kind.reason);
			case 'image':
				return call(engine.openImage(bytes, kind.mime, name));
			case 'convert': {
				const png = await toPng(file, name);
				return call(engine.openImage(png, 'image/png', pngName(name)));
			}
			case 'pdf':
				return openPdf(bytes, name, jobId);
		}
	}

	async function openPdf(bytes: Uint8Array, name: string, jobId: number): Promise<Source | null> {
		try {
			return await call(engine.openPdf(bytes, name));
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
				return await call(engine.openPdf(bytes, name, pw));
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
				: `Could not open ${name}. This browser cannot read that image format. Save it as PNG or JPEG first.`
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
