/**
 * "Pick up where you left off": saves the open work on this device and offers it
 * back on the next visit. Framework-free; `session.svelte.ts` is the Svelte view.
 *
 * - Each source's bytes are stored once, keyed by SHA-256, when the file is opened
 *   (`noteOpened`), or on the first save for sources made another way (blank pages).
 *   Normal files: the engine's normalized bytes, so a restore needs no engine work.
 *   Password-protected files: the file exactly as given, still encrypted; the
 *   password is asked again on restore and is never stored.
 * - A save writes only the small record (format.ts), debounced after changes, in
 *   one transaction that first checks this tab is still the record's writer.
 * - Restore is never automatic, all-or-nothing and verified (schema, every blob
 *   present with its hash, the state parses and DocStore accepts it).
 * - Anything that fails (no storage, no room, a second tab, the switch off) leaves
 *   the app working as before, with `state` saying why nothing is saved.
 */
import type { Engine, Source, SourceId } from '../core/types';
import type { DocState, DocStore } from '../doc/store';
import { EngineError } from '../engine/errors';
import {
	SessionFormatError,
	buildRecord,
	isExpired,
	parseRecord,
	summarize,
	type SavedExportForm,
	type SavedSource,
	type SessionRecord,
	type SessionSummary
} from './format';
import type { Ownership } from './owner';
import { StorageFullError, type SessionStorage } from './storage';

export type SaveState =
	/** Working out whether this tab may save. */
	| 'starting'
	/** This tab saves; everything is stored (or there is nothing to store). */
	| 'saved'
	/** "Keep my work on this device" is off. */
	| 'off'
	/** Another tab owns the saved session. */
	| 'other-tab'
	/** No usable storage (blocked, private mode, no IndexedDB or no crypto). */
	| 'unavailable'
	/** Not enough room on this device. */
	| 'full'
	/** A file is too large to keep. */
	| 'too-large'
	/** The user chose "Forget my work" for what is open. */
	| 'forgotten'
	/** A write failed for another reason. */
	| 'failed';

export interface PasswordAsk {
	name: string;
	error?: string;
}

export type RestoreResult =
	| { ok: true; skipped: number }
	/** Every file was skipped at its password: nothing restored, the offer stays. */
	| { ok: false; reason: 'skipped' }
	/** The saved work failed a check and was deleted. */
	| { ok: false; reason: 'broken' }
	/** Nothing to restore (gone, another tab, or the workspace is not empty). */
	| { ok: false; reason: 'unavailable' };

export interface SessionDeps {
	store: DocStore;
	engine: Pick<Engine, 'openPdf'>;
	openStorage: () => Promise<SessionStorage>;
	claim: () => Promise<Ownership>;
	/** The remembered switch. */
	prefs: { get(): boolean; set(on: boolean): void };
	/** The export dialog's options (never the password). */
	exportForm: { get(): SavedExportForm; set(form: SavedExportForm): void };
	app: string;
	now?: () => number;
	hash?: (bytes: Uint8Array) => Promise<string>;
	/** navigator.storage.estimate, when there is one. */
	estimate?: () => Promise<{ quota?: number; usage?: number } | undefined>;
	/** Tell other tabs (and hear them): 'forgot', 'off', 'on'. */
	channel?: { post(msg: string): void; listen(fn: (msg: string) => void): void };
	notify?: (message: string, tone?: 'info' | 'error') => void;
	debounceMs?: number;
	maxWaitMs?: number;
	/** How long an emptied workspace waits before the saved session is deleted (Start over's undo window). */
	emptyGraceMs?: number;
	/** Files larger than this are not kept. */
	maxFileBytes?: number;
	writerId?: string;
	/** Called with how long each save and restore took (ms). */
	onMeasure?: (what: 'save' | 'restore', ms: number) => void;
}

/** Plain-language lines the UI shows. */
export const STATUS_LINE: Record<SaveState, string> = {
	starting: 'Saved on this device only.',
	saved: 'Saved on this device only.',
	off: 'This work is not being saved. Keeping work on this device is off.',
	'other-tab': 'This work is not being saved. The app is open in another tab.',
	unavailable: 'This work is not being saved. This browser does not allow it here.',
	full: 'This work is not being saved. There is not enough room on this device.',
	'too-large': 'This work is not being saved. A file is too large to keep.',
	forgotten: 'This work is not being saved. You removed it from this device.',
	failed: 'This work is not being saved. Storing it on this device failed.'
};

export const BROKEN_MESSAGE = 'Your saved work could not be opened, so it was deleted.';

export const MAX_FILE_BYTES = 1024 * 1024 * 1024;

interface Blob_ {
	hash?: string;
	size: number;
	status: 'none' | 'writing' | 'stored' | 'failed';
	writing?: Promise<boolean>;
	failure?: 'full' | 'too-large' | 'failed';
	epoch: number;
}

interface KnownSource extends Blob_ {
	stored: SavedSource['stored'];
	needsPassword: boolean;
	/** Protected files only: the file as given, kept in memory while it is open. */
	original?: Uint8Array;
}

interface Sig {
	pages: DocState['pages'];
	sources: DocState['sources'];
	assets: DocState['assets'];
	formValues: DocState['formValues'];
	dirty: boolean;
	form: string;
}

function randomId(): string {
	const c = globalThis.crypto;
	if (c?.randomUUID) return c.randomUUID();
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const subtle = globalThis.crypto?.subtle;
	if (!subtle) throw new Error('SHA-256 is not available here');
	const d = new Uint8Array(await subtle.digest('SHA-256', bytes as BufferSource));
	let s = '';
	for (const b of d) s += b.toString(16).padStart(2, '0');
	return s;
}

export function createSession(deps: SessionDeps) {
	const { store } = deps;
	const now = deps.now ?? (() => Date.now());
	const hash = deps.hash ?? sha256Hex;
	const debounceMs = deps.debounceMs ?? 400;
	const maxWaitMs = deps.maxWaitMs ?? 2000;
	const emptyGraceMs = deps.emptyGraceMs ?? 9000;
	const maxFileBytes = deps.maxFileBytes ?? MAX_FILE_BYTES;
	const writer = deps.writerId ?? randomId();

	let state: SaveState = 'starting';
	let offer: (SessionSummary & { writer: string; rev: string }) | null = null;
	let restoring = false;
	let storage: SessionStorage | null = null;
	let ownership: Ownership | null = null;
	/** A record this tab may overwrite: the one it found at load (the offer). */
	let replaceable: { writer: string; rev: string } | null = null;
	/** This tab has written the current record. */
	let hasWritten = false;
	/** Bumped when stored data is wiped; writes from before do not count. */
	let epoch = 0;
	const known = new Map<SourceId, KnownSource>();
	const assetBlobs = new Map<string, Blob_>();
	/** Sources the user chose to forget; work using them is not saved again in this tab. */
	const forgotten = new Set<SourceId>();
	let lastSaved: Sig | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	let firstPending = 0;
	let emptyTimer: ReturnType<typeof setTimeout> | null = null;
	let chain: Promise<void> = Promise.resolve();
	let saving = false;
	let started: Promise<void> | null = null;
	const listeners = new Set<() => void>();

	function emit() {
		for (const l of [...listeners]) l();
	}

	function setState(s: SaveState) {
		if (state === s) return;
		state = s;
		emit();
	}

	function sigOf(st: DocState): Sig {
		return {
			pages: st.pages,
			sources: st.sources,
			assets: st.assets,
			formValues: st.formValues,
			dirty: st.isDirty,
			form: JSON.stringify(deps.exportForm.get())
		};
	}

	function sameSig(a: Sig | null, b: Sig): boolean {
		return (
			!!a &&
			a.pages === b.pages &&
			a.sources === b.sources &&
			a.assets === b.assets &&
			a.formValues === b.formValues &&
			a.dirty === b.dirty &&
			a.form === b.form
		);
	}

	const usesForgotten = (st: DocState) => forgotten.size > 0 && st.sources.some((s) => forgotten.has(s.id));

	function canWrite(): boolean {
		return !!storage && (state === 'saved' || state === 'full' || state === 'too-large' || state === 'failed' || state === 'forgotten');
	}

	// ------------------------------------------------------------ scheduling

	function schedule() {
		if (!canWrite()) return;
		const t = now();
		if (!timer) firstPending = t;
		if (timer) clearTimeout(timer);
		const wait = Math.max(0, Math.min(debounceMs, firstPending + maxWaitMs - t));
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, wait);
		emit();
	}

	function onStoreChange() {
		const st = store.state;
		if (st.pages.length > 0 && emptyTimer) {
			clearTimeout(emptyTimer);
			emptyTimer = null;
		}
		if (forgotten.size) {
			if (state === 'saved' && usesForgotten(st)) setState('forgotten');
			else if (state === 'forgotten' && !usesForgotten(st)) setState('saved');
		}
		if (!sameSig(lastSaved, sigOf(st))) schedule();
	}

	store.subscribe(onStoreChange);

	/** Save now if anything changed (waits for a save already running). */
	function flush(): Promise<void> {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		chain = chain.then(save, save);
		return chain;
	}

	// ------------------------------------------------------------ blobs

	async function writeBlob(b: Blob_, bytes: Uint8Array): Promise<boolean> {
		if (b.status === 'stored' && b.epoch === epoch) return true;
		if (b.status === 'writing' && b.writing && b.epoch === epoch) return b.writing;
		// No room or too large: not tried again until stored data is wiped.
		if (b.status === 'failed' && b.epoch === epoch && (b.failure === 'full' || b.failure === 'too-large')) return false;
		const s = storage;
		if (!s) return false;
		const myEpoch = epoch;
		b.epoch = myEpoch;
		b.status = 'writing';
		b.writing = (async () => {
			try {
				if (bytes.length > maxFileBytes) {
					b.failure = 'too-large';
					return false;
				}
				b.hash ??= await hash(bytes);
				if (await s.hasBlob(b.hash)) return true;
				if (bytes.length > 4 * 1024 * 1024 && deps.estimate) {
					const est = await deps.estimate().catch(() => undefined);
					if (est?.quota !== undefined && est.usage !== undefined && est.quota - est.usage < bytes.length * 1.2 + 16 * 1024 * 1024) {
						b.failure = 'full';
						return false;
					}
				}
				await s.putBlob(b.hash, bytes);
				if (epoch !== myEpoch) {
					// Wiped while writing (Forget, switch off): do not leave it behind.
					await s.deleteBlobs([b.hash]).catch(() => undefined);
					return false;
				}
				return true;
			} catch (e) {
				b.failure = e instanceof StorageFullError ? 'full' : 'failed';
				return false;
			}
		})();
		const ok = await b.writing;
		if (b.epoch === myEpoch) {
			b.status = ok ? 'stored' : 'failed';
			b.writing = undefined;
			if (ok) b.failure = undefined;
		}
		return ok && epoch === myEpoch;
	}

	function knownFor(source: Source): KnownSource | null {
		let k = known.get(source.id);
		if (!k) {
			// Made another way (a blank page) or opened while this tab did not save:
			// normal files can be stored from what is open; protected ones cannot.
			if (source.wasEncrypted) return null;
			k = { stored: 'normalized', needsPassword: false, size: source.bytes.length, status: 'none', epoch };
			known.set(source.id, k);
		}
		return k;
	}

	function bytesOf(source: Source, k: KnownSource): Uint8Array | null {
		return k.stored === 'original' ? (k.original ?? null) : source.bytes;
	}

	// ------------------------------------------------------------ save

	async function save(): Promise<void> {
		if (!canWrite() || restoring) return;
		if (store.gestureActive) {
			schedule();
			return;
		}
		const st = store.state;
		const sig = sigOf(st);
		if (st.pages.length === 0) {
			lastSaved = sig;
			if (hasWritten && !emptyTimer) emptyTimer = setTimeout(() => void dropEmpty(), emptyGraceMs);
			emit();
			return;
		}
		if (usesForgotten(st)) return;
		if (sameSig(lastSaved, sig)) {
			if (state !== 'saved') setState('saved');
			return;
		}
		saving = true;
		emit();
		const t0 = performance.now();
		const startEpoch = epoch;
		try {
			const blobs = new Map<string, { hash: string; size: number; stored: SavedSource['stored']; needsPassword: boolean }>();
			let failure: SaveState | null = null;
			for (const source of st.sources) {
				const k = knownFor(source);
				const bytes = k && bytesOf(source, k);
				if (!k || !bytes) {
					failure = 'failed';
					break;
				}
				if (!(await writeBlob(k, bytes))) {
					failure = k.failure ?? 'failed';
					break;
				}
				blobs.set(source.id, { hash: k.hash!, size: bytes.length, stored: k.stored, needsPassword: k.needsPassword });
			}
			const assetMap = new Map<string, { hash: string; size: number }>();
			if (!failure) {
				for (const a of st.assets) {
					let b = assetBlobs.get(a.id);
					if (!b) assetBlobs.set(a.id, (b = { size: a.png.length, status: 'none', epoch }));
					if (!(await writeBlob(b, a.png))) {
						failure = b.failure ?? 'failed';
						break;
					}
					assetMap.set(a.id, { hash: b.hash!, size: a.png.length });
				}
			}
			// Wiped while this save ran (Forget, switch off): drop it quietly.
			if (!canWrite() || epoch !== startEpoch) return;
			if (failure) {
				setState(failure);
				return;
			}
			const rec = buildRecord({
				writer,
				rev: randomId(),
				savedAt: now(),
				app: deps.app,
				clean: !st.isDirty,
				sources: st.sources,
				blobs,
				pages: st.pages,
				assets: st.assets,
				assetBlobs: assetMap,
				formValues: st.formValues,
				exportForm: deps.exportForm.get()
			});
			const needs = [...new Set([...blobs.values(), ...assetMap.values()].map((b) => b.hash))];
			let seen: unknown = undefined;
			const res = await storage!.putRecord(
				rec,
				(cur) => {
					seen = cur;
					if (epoch !== startEpoch) return false;
					if (cur === undefined) return !hasWritten;
					const c = cur as { writer?: unknown; rev?: unknown };
					return c.writer === writer || (replaceable !== null && c.writer === replaceable.writer && c.rev === replaceable.rev);
				},
				needs
			);
			if (epoch !== startEpoch) return;
			if (res === 'conflict') {
				// Someone else wrote or deleted it: stop, never overwrite their work.
				setState(seen === undefined ? 'forgotten' : 'other-tab');
				return;
			}
			if (res === 'missing-blob') {
				for (const k of known.values()) k.status = 'none';
				for (const b of assetBlobs.values()) b.status = 'none';
				setState('failed');
				return;
			}
			const replaced = offer !== null || replaceable !== null;
			hasWritten = true;
			replaceable = null;
			offer = null;
			lastSaved = sig;
			setState('saved');
			deps.onMeasure?.('save', performance.now() - t0);
			if (replaced || needsSweep(needs)) void sweep(needs);
		} catch (e) {
			if (e instanceof StorageFullError) setState('full');
			else setState('failed');
		} finally {
			saving = false;
			emit();
			if (canWrite() && !sameSig(lastSaved, sigOf(store.state)) && store.state.pages.length) schedule();
		}
	}

	let lastNeeds = '';
	function needsSweep(needs: string[]): boolean {
		const key = [...needs].sort().join(',');
		const changed = key !== lastNeeds;
		lastNeeds = key;
		return changed;
	}

	/** Delete blobs that neither `keep`, the offered record nor any open source uses. */
	async function sweep(keep: readonly string[] = []): Promise<void> {
		const s = storage;
		if (!s) return;
		try {
			const live = new Set(keep);
			for (const k of known.values()) if (k.hash) live.add(k.hash);
			for (const b of assetBlobs.values()) if (b.hash) live.add(b.hash);
			const raw = await s.getRecord();
			if (raw !== undefined) {
				try {
					const rec = parseRecord(raw);
					for (const x of rec.sources) live.add(x.hash);
					for (const x of rec.assets) live.add(x.hash);
				} catch {
					// Unreadable records are deleted elsewhere; keep nothing for them.
				}
			}
			// Blobs being written right now are not in a record yet.
			for (const k of known.values()) if (k.status === 'writing' && k.hash) live.add(k.hash);
			const dead = (await s.blobKeys()).filter((h) => !live.has(h));
			if (dead.length) await s.deleteBlobs(dead);
		} catch {
			// Sweeping is housekeeping; try again next time.
		}
	}

	async function dropEmpty(): Promise<void> {
		emptyTimer = null;
		if (store.state.pages.length > 0 || !storage || !hasWritten) return;
		try {
			await storage.deleteRecord();
		} catch {
			// Left for the 7-day expiry.
		}
		hasWritten = false;
		lastNeeds = '';
		await sweep();
		emit();
	}

	// ------------------------------------------------------------ start

	async function becomeOwner(): Promise<void> {
		try {
			if (!globalThis.crypto?.subtle && !deps.hash) throw new Error('no crypto');
			storage = await deps.openStorage();
		} catch {
			storage = null;
			setState('unavailable');
			return;
		}
		let raw: unknown;
		try {
			raw = await storage.getRecord();
		} catch {
			storage = null;
			setState('unavailable');
			return;
		}
		if (raw !== undefined) {
			try {
				const rec = parseRecord(raw);
				if (isExpired(rec.savedAt, now())) {
					await storage.deleteRecord();
				} else {
					offer = { ...summarize(rec), writer: rec.writer, rev: rec.rev };
					replaceable = { writer: rec.writer, rev: rec.rev };
				}
			} catch (e) {
				await storage.deleteRecord().catch(() => undefined);
				if (e instanceof SessionFormatError) deps.notify?.(BROKEN_MESSAGE, 'error');
			}
		}
		setState('saved');
		// Orphans from earlier visits, after the first paint.
		setTimeout(() => void sweep(), 0);
		if (store.state.pages.length) schedule();
	}

	function init(): Promise<void> {
		started ??= (async () => {
			deps.channel?.listen(onMessage);
			if (!deps.prefs.get()) {
				setState('off');
				// Make sure nothing is left from before the switch was turned off.
				try {
					await (await deps.openStorage()).clear();
				} catch {
					// Nothing stored, or no storage at all.
				}
				return;
			}
			await claimAndStart();
		})();
		return started;
	}

	async function claimAndStart(): Promise<void> {
		try {
			ownership = await deps.claim();
		} catch {
			ownership = { owner: true, release: () => undefined };
		}
		if (!ownership.owner) {
			setState('other-tab');
			ownership.freed?.then(() => {
				// The other tab closed. Take over only with an empty workspace, so this
				// tab's unsaved work never silently replaces what that tab saved.
				if (state === 'other-tab' && store.state.pages.length === 0 && deps.prefs.get()) {
					setState('starting');
					void becomeOwner();
				} else ownership?.release();
			});
			return;
		}
		await becomeOwner();
	}

	function wipeLocal() {
		epoch++;
		for (const k of known.values()) k.status = 'none';
		for (const b of assetBlobs.values()) b.status = 'none';
		hasWritten = false;
		lastSaved = null;
		lastNeeds = '';
		replaceable = null;
		if (offer) offer = null;
	}

	function onMessage(msg: string) {
		if (msg === 'forgot') {
			wipeLocal();
			for (const s of store.state.sources) forgotten.add(s.id);
			if (canWrite() && store.state.pages.length) setState('forgotten');
			emit();
		} else if (msg === 'off') {
			wipeLocal();
			if (timer) clearTimeout(timer);
			timer = null;
			setState('off');
		} else if (msg === 'on' && state === 'off') {
			setState('starting');
			void claimAndStart();
		}
	}

	// ------------------------------------------------------------ user actions

	/** Intake opened a file (before it is added to the store). Its bytes are stored now. */
	function noteOpened(source: Source, info: { original: Uint8Array; needsPassword: boolean }) {
		const k: KnownSource = source.wasEncrypted
			? { stored: 'original', needsPassword: info.needsPassword, original: info.original, size: info.original.length, status: 'none', epoch }
			: { stored: 'normalized', needsPassword: false, size: source.bytes.length, status: 'none', epoch };
		known.set(source.id, k);
		void (started ?? Promise.resolve()).then(() => {
			const bytes = bytesOf(source, k);
			if (canWrite() && bytes && known.get(source.id) === k) void writeBlob(k, bytes);
		});
	}

	function sourceReleased(id: SourceId) {
		known.delete(id);
		lastNeeds = '';
		forgotten.delete(id);
	}

	function assetReleased(ids: Iterable<string>) {
		const live = new Set(ids);
		for (const id of [...assetBlobs.keys()]) if (!live.has(id)) assetBlobs.delete(id);
	}

	async function readVerified(s: SessionStorage, h: string, size: number): Promise<Uint8Array> {
		const bytes = await s.getBlob(h);
		if (!bytes || bytes.length !== size) throw new SessionFormatError('damaged', 'a stored file is missing');
		if ((await hash(bytes)) !== h) throw new SessionFormatError('damaged', 'a stored file does not match its hash');
		return bytes;
	}

	const sameSize = (a: { width: number; height: number }, b: { width: number; height: number }) =>
		Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5;

	async function reopen(saved: SavedSource, bytes: Uint8Array, ask: (a: PasswordAsk) => Promise<string | null>): Promise<Source | null> {
		let error: string | undefined;
		let source: Source;
		for (;;) {
			let pw: string | undefined;
			if (saved.needsPassword) {
				const answer = await ask({ name: saved.name, error });
				if (answer === null) return null;
				pw = answer;
			}
			try {
				source = await deps.engine.openPdf(bytes, saved.name, pw);
				break;
			} catch (e) {
				if (saved.needsPassword && e instanceof EngineError && (e.code === 'password-wrong' || e.code === 'password-required')) {
					error = 'That password did not open the file. Check it and try again.';
					continue;
				}
				throw e;
			}
		}
		if (source.pages.length !== saved.pages.length || !source.pages.every((p, i) => sameSize(p, saved.pages[i])))
			throw new SessionFormatError('damaged', 'a reopened file has different pages');
		return {
			...source,
			id: saved.id,
			name: saved.name,
			kind: saved.kind,
			originalSize: saved.originalSize,
			wasEncrypted: saved.wasEncrypted,
			notes: [...saved.notes],
			...(saved.hasForm !== undefined ? { hasForm: saved.hasForm } : {})
		};
	}

	/**
	 * Restore the offered session. Password-protected files ask for their password
	 * through `ask` (null skips that file and its pages).
	 */
	async function restore(ask: (a: PasswordAsk) => Promise<string | null>): Promise<RestoreResult> {
		const s = storage;
		if (!s || !offer || restoring || state === 'other-tab') return { ok: false, reason: 'unavailable' };
		restoring = true;
		emit();
		const t0 = performance.now();
		try {
			let rec: SessionRecord;
			const raw = await s.getRecord();
			if (raw === undefined) {
				offer = null;
				return { ok: false, reason: 'unavailable' };
			}
			rec = parseRecord(raw);
			if (rec.writer !== offer.writer || rec.rev !== offer.rev) {
				// Written by another tab since the offer was made.
				offer = null;
				setState('other-tab');
				return { ok: false, reason: 'unavailable' };
			}
			// Every stored file must be there and match its hash before anything is asked.
			const bytes = new Map<string, Uint8Array>();
			for (const x of [...rec.sources, ...rec.assets]) if (!bytes.has(x.hash)) bytes.set(x.hash, await readVerified(s, x.hash, x.size));

			const sources: Source[] = [];
			const restoredKnown = new Map<SourceId, KnownSource>();
			let skipped = 0;
			for (const x of rec.sources) {
				const b = bytes.get(x.hash)!;
				let source: Source | null;
				if (x.stored === 'normalized') {
					source = {
						id: x.id,
						name: x.name,
						kind: x.kind,
						bytes: b,
						pages: x.pages.map((p) => ({ ...p })),
						originalSize: x.originalSize,
						wasEncrypted: x.wasEncrypted,
						notes: [...x.notes],
						...(x.hasForm !== undefined ? { hasForm: x.hasForm } : {})
					};
				} else {
					source = await reopen(x, b, ask);
				}
				if (!source) {
					skipped++;
					continue;
				}
				sources.push(source);
				restoredKnown.set(x.id, {
					stored: x.stored,
					needsPassword: x.needsPassword,
					original: x.stored === 'original' ? b : undefined,
					hash: x.hash,
					size: x.size,
					status: 'stored',
					epoch
				});
			}
			if (!sources.length) return { ok: false, reason: 'skipped' };
			if (store.state.pages.length > 0 || (state as SaveState) === 'other-tab' || !storage) return { ok: false, reason: 'unavailable' };

			const kept = new Set(sources.map((x) => x.id));
			const pages = rec.pages.filter((p) => kept.has(p.sourceId));
			const usedAssets = new Set(pages.flatMap((p) => p.stamps.flatMap((st) => (st.kind === 'image' ? [st.assetId] : []))));
			const assets = rec.assets
				.filter((a) => skipped === 0 || usedAssets.has(a.id))
				.map((a) => ({ id: a.id, kind: a.kind, width: a.width, height: a.height, png: bytes.get(a.hash)! }));
			const formValues = Object.fromEntries(Object.entries(rec.formValues).filter(([id]) => kept.has(id)));
			store.restore({ sources, pages, assets, formValues }, { clean: rec.clean && skipped === 0 });
			deps.exportForm.set(rec.exportForm);

			for (const [id, k] of restoredKnown) known.set(id, k);
			for (const a of rec.assets) assetBlobs.set(a.id, { hash: a.hash, size: a.size, status: 'stored', epoch });
			offer = null;
			// The record is still the one found at load; the first save takes it over.
			replaceable = { writer: rec.writer, rev: rec.rev };
			hasWritten = true;
			lastSaved = skipped ? null : sigOf(store.state);
			setState('saved');
			deps.onMeasure?.('restore', performance.now() - t0);
			if (skipped) schedule();
			return { ok: true, skipped };
		} catch (e) {
			console.warn('Saved work could not be restored:', e);
			offer = null;
			try {
				await s.deleteRecord();
			} catch {
				// Expires on its own.
			}
			await sweep();
			return { ok: false, reason: 'broken' };
		} finally {
			restoring = false;
			emit();
		}
	}

	/** Delete the offered session (the card's Discard). */
	async function discard(): Promise<void> {
		const s = storage;
		offer = null;
		replaceable = null;
		emit();
		if (!s) return;
		try {
			await s.deleteRecord();
		} catch {
			// Expires on its own.
		}
		hasWritten = false;
		await sweep();
	}

	async function clearEverything(): Promise<boolean> {
		try {
			const s = storage ?? (await deps.openStorage());
			await s.clear();
			return true;
		} catch {
			return false;
		}
	}

	/** "Forget my work": delete the saved session and every stored file now. */
	async function forget(): Promise<boolean> {
		wipeLocal();
		for (const s of store.state.sources) forgotten.add(s.id);
		if (timer) clearTimeout(timer);
		timer = null;
		const ok = await clearEverything();
		deps.channel?.post('forgot');
		if (canWrite() && store.state.pages.length) setState('forgotten');
		emit();
		return ok;
	}

	/** The remembered switch. Off deletes what is stored. */
	async function setKeep(on: boolean): Promise<void> {
		deps.prefs.set(on);
		if (!on) {
			wipeLocal();
			if (timer) clearTimeout(timer);
			timer = null;
			setState('off');
			await clearEverything();
			deps.channel?.post('off');
			return;
		}
		deps.channel?.post('on');
		if (state !== 'off') return;
		setState('starting');
		if (ownership?.owner && storage) {
			setState('saved');
			schedule();
			return;
		}
		await claimAndStart();
	}

	/** The page is going away: save what is pending, finish a Start over. */
	function pageHide() {
		if (timer) void flush();
		if (emptyTimer) {
			clearTimeout(emptyTimer);
			void dropEmpty();
		}
	}

	return {
		init,
		noteOpened,
		sourceReleased,
		assetReleased,
		restore,
		discard,
		forget,
		setKeep,
		flush,
		pageHide,
		/** Export options changed. */
		touch: () => onStoreChange(),
		sweep,
		subscribe(fn: () => void) {
			listeners.add(fn);
			return () => void listeners.delete(fn);
		},
		get state(): SaveState {
			return state;
		},
		get line(): string {
			return STATUS_LINE[state];
		},
		/** True when this tab saves (or would, once something changes). */
		get saving(): boolean {
			return state === 'saved' || state === 'starting';
		},
		get offer(): SessionSummary | null {
			return offer && { files: offer.files, pages: offer.pages, savedAt: offer.savedAt };
		},
		get restoring() {
			return restoring;
		},
		get keep() {
			return deps.prefs.get();
		},
		/** Leaving now loses nothing: the open work is stored as it is. */
		get safeToLeave(): boolean {
			const st = store.state;
			if (st.pages.length === 0) return true;
			return state === 'saved' && !timer && !saving && sameSig(lastSaved, sigOf(st));
		}
	};
}

export type Session = ReturnType<typeof createSession>;
