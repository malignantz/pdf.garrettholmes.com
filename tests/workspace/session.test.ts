import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, PageRef, Source, Stamp } from '../../src/lib/core/types';
import { createDocStore, type DocStore } from '../../src/lib/doc/store';
import { EngineError } from '../../src/lib/engine/errors';
import {
	EXPIRY_MS,
	SCHEMA,
	SessionFormatError,
	buildRecord,
	cleanExportForm,
	describeSummary,
	parseRecord,
	savedAgo,
	type SavedExportForm
} from '../../src/lib/session/format';
import { BROKEN_MESSAGE, createSession, sha256Hex } from '../../src/lib/session/session';
import { memoryStorage } from '../../src/lib/session/storage';
import { DEFAULT_FORM } from '../../src/lib/workspace/logic';

// ---------------------------------------------------------------- fixtures

const enc = new TextEncoder();
const pdfBytes = (tag: string, n = 64) => {
	const b = new Uint8Array(n);
	b.set(enc.encode(`%PDF-1.7 ${tag}`));
	return b;
};

function source(id: string, pages: number, extra: Partial<Source> = {}): Source {
	return {
		id,
		name: `${id}.pdf`,
		kind: 'pdf',
		bytes: pdfBytes(id),
		pages: Array.from({ length: pages }, (_, i) => ({ width: 612 + i, height: 792 })),
		originalSize: 1000 + pages,
		wasEncrypted: false,
		notes: [],
		...extra
	};
}

const asset = (id: string): Asset => ({ id, kind: 'signature', png: pdfBytes(`png-${id}`, 40), width: 120, height: 40 });

/** One stamp of every kind and shape the workspace can make. */
const everyStamp = (): Stamp[] => [
	{ id: 's-img', kind: 'image', assetId: 'sig', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } },
	{ id: 's-text', kind: 'text', text: 'Jane Doe, 9 Nov — “ok”', x: 0.12, y: 0.8, size: 0.014, color: 'blue' },
	{ id: 's-check', kind: 'mark', mark: 'check', box: { x: 0.8, y: 0.1, w: 0.03, h: 0.03 } },
	{ id: 's-cross', kind: 'mark', mark: 'cross', box: { x: 0.7, y: 0.1, w: 0.03, h: 0.03 } },
	{ id: 's-dot', kind: 'mark', mark: 'dot', box: { x: 0.6, y: 0.1, w: 0.02, h: 0.02 } },
	{ id: 's-hl-box', kind: 'highlight', color: 'yellow', box: { x: 0.1, y: 0.4, w: 0.5, h: 0.03 } },
	{
		id: 's-hl-pen',
		kind: 'highlight',
		color: 'green',
		box: { x: 0.1, y: 0.5, w: 0.4, h: 0.04 },
		pen: { width: 0.02, points: [{ x: 0.11, y: 0.52 }, { x: 0.3, y: 0.51 }, { x: 0.49, y: 0.53 }] }
	},
	{
		id: 's-hl-text',
		kind: 'highlight',
		color: 'pink',
		box: { x: 0.1, y: 0.6, w: 0.6, h: 0.05 },
		rects: [
			{ x: 0.1, y: 0.6, w: 0.6, h: 0.02 },
			{ x: 0.1, y: 0.63, w: 0.3, h: 0.02 }
		]
	},
	{ id: 's-redact', kind: 'redact', box: { x: 0.2, y: 0.7, w: 0.2, h: 0.03 } }
];

function fakeEngine(password = 'secret') {
	const calls: { name: string; pw?: string }[] = [];
	return {
		calls,
		async openPdf(bytes: Uint8Array, name: string, pw?: string): Promise<Source> {
			calls.push({ name, pw });
			if (pw !== password) throw new EngineError(pw === undefined ? 'password-required' : 'password-wrong', 'needs a password');
			return { ...source('fresh', 2), name, bytes: pdfBytes(`decrypted-${bytes.length}`), wasEncrypted: true };
		}
	};
}

interface Rig {
	store: DocStore;
	storage: ReturnType<typeof memoryStorage>;
	session: ReturnType<typeof createSession>;
	clock: { t: number };
	form: { value: SavedExportForm };
	prefs: { on: boolean };
	notes: string[];
	engine: ReturnType<typeof fakeEngine>;
}

function rig(opts: { storage?: ReturnType<typeof memoryStorage>; owner?: boolean; t?: number; keep?: boolean; writer?: string; maxFileBytes?: number } = {}): Rig {
	const store = createDocStore();
	const storage = opts.storage ?? memoryStorage();
	const clock = { t: opts.t ?? Date.UTC(2026, 10, 12, 12) };
	const form = { value: { ...DEFAULT_FORM } as SavedExportForm };
	const prefs = { on: opts.keep ?? true };
	const notes: string[] = [];
	const engine = fakeEngine();
	const session = createSession({
		store,
		engine,
		openStorage: async () => storage,
		claim: async () => ({ owner: opts.owner ?? true, release: () => undefined }),
		prefs: { get: () => prefs.on, set: (v) => (prefs.on = v) },
		exportForm: { get: () => form.value, set: (f) => (form.value = f) },
		app: 'test',
		now: () => clock.t,
		notify: (m) => notes.push(m),
		debounceMs: 50,
		maxWaitMs: 200,
		emptyGraceMs: 1000,
		writerId: opts.writer,
		maxFileBytes: opts.maxFileBytes,
		// Same digest as sha256Hex (checked below), but settles on the fake clock.
		hash: async (b) => createHash('sha256').update(b).digest('hex')
	});
	return { store, storage, session, clock, form, prefs, notes, engine };
}

/** Let debounced saves and their async writes finish. */
async function settle(ms = 300) {
	await vi.advanceTimersByTimeAsync(ms);
	await vi.advanceTimersByTimeAsync(0);
}

function snapshotDoc(store: DocStore) {
	const s = store.state;
	return JSON.parse(
		JSON.stringify({
			sources: s.sources.map((x) => ({ ...x, bytes: Array.from(x.bytes) })),
			pages: s.pages,
			assets: s.assets.map((a) => ({ ...a, png: Array.from(a.png) })),
			formValues: s.formValues
		})
	);
}

/** Two files, reordered, rotated, duplicated, a blank page, every stamp kind, form answers. */
function buildWork(r: Rig) {
	const a = source('a', 3, { hasForm: true, notes: ['Repaired a damaged cross-reference table.'] });
	const b = source('b', 2);
	const blank: Source = { ...source('blank', 1), kind: 'blank', name: 'Blank page' };
	r.session.noteOpened(a, { original: pdfBytes('orig-a'), needsPassword: false });
	r.session.noteOpened(b, { original: pdfBytes('orig-b'), needsPassword: false });
	r.store.addSource(a);
	r.store.addSource(b);
	r.store.addSource(blank, 1);
	r.store.addAsset(asset('sig'));
	const ids = r.store.state.pages.map((p) => p.id);
	r.store.movePages([ids[ids.length - 1]], 0);
	r.store.rotatePages([ids[2]], 90);
	r.store.rotatePages([ids[3]], -90);
	r.store.duplicatePages([ids[2]]);
	for (const st of everyStamp()) r.store.addStamp(ids[0], st);
	r.store.setFormValue('a', 'name', 'Jane');
	r.store.setFormValue('a', 'agree', true);
	r.store.setFormValue('a', 'colours', ['red', 'blue']);
	r.form.value = { ...r.form.value, compress: false, number: true, style: 'bates', prefix: 'ACME-', digits: '7' };
	r.session.touch();
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
});
afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------- format

describe('sha256Hex', () => {
	it('is the SHA-256 of the bytes', async () => {
		const b = pdfBytes('x', 1000);
		expect(await sha256Hex(b)).toBe(createHash('sha256').update(b).digest('hex'));
	});
});

describe('format', () => {
	const base = () => {
		const sources = [source('a', 2)];
		const pages: PageRef[] = [
			{ id: 'p1', sourceId: 'a', pageIndex: 1, rotation: 270, stamps: everyStamp() },
			{ id: 'p2', sourceId: 'a', pageIndex: 0, rotation: 0, stamps: [] }
		];
		return buildRecord({
			writer: 'w',
			rev: 'r1',
			savedAt: 5,
			app: 'v1',
			clean: false,
			sources,
			blobs: new Map([['a', { hash: 'a'.repeat(64), size: 64, stored: 'normalized' as const, needsPassword: false }]]),
			pages,
			assets: [asset('sig')],
			assetBlobs: new Map([['sig', { hash: 'b'.repeat(64), size: 40 }]]),
			formValues: { a: { t: 'x', c: false, l: ['1', '2'] } },
			exportForm: { ...DEFAULT_FORM, password: 'hunter2', filename: 'x.pdf' } as unknown as SavedExportForm
		});
	};

	it('round-trips every stamp kind, pages, assets, answers and options exactly', () => {
		const rec = base();
		const back = parseRecord(structuredClone(rec));
		expect(back).toEqual(rec);
		expect(back.pages[0].stamps).toEqual(everyStamp());
		expect(back.schema).toBe(SCHEMA);
	});

	it('never keeps an export password or file name', () => {
		const rec = base();
		expect(JSON.stringify(rec)).not.toContain('hunter2');
		expect('password' in rec.exportForm).toBe(false);
		expect('filename' in rec.exportForm).toBe(false);
		expect(cleanExportForm({ ...DEFAULT_FORM, password: 'x' } as never)).toEqual(DEFAULT_FORM);
	});

	it('refuses other schema versions, older and newer', () => {
		for (const schema of [0, SCHEMA + 1, 99]) {
			const raw = { ...base(), schema };
			expect(() => parseRecord(raw)).toThrow(SessionFormatError);
			try {
				parseRecord(raw);
			} catch (e) {
				expect((e as SessionFormatError).reason).toBe('version');
			}
		}
	});

	it('refuses damaged records', () => {
		const bad: ((r: Record<string, unknown>) => void)[] = [
			(r) => ((r.pages as PageRef[])[0].rotation = 45 as never),
			(r) => ((r.pages as PageRef[])[0].pageIndex = 7),
			(r) => ((r.pages as PageRef[])[0].sourceId = 'zz'),
			(r) => (((r.pages as PageRef[])[0].stamps[1] as { color: string }).color = 'green'),
			(r) => (((r.pages as PageRef[])[0].stamps[0] as { assetId: string }).assetId = 'nope'),
			(r) => (((r.pages as PageRef[])[0].stamps[0] as { kind: string }).kind = 'sticker'),
			(r) => ((r.sources as { hash: string }[])[0].hash = 'xyz'),
			(r) => ((r.sources as { wasEncrypted: boolean }[])[0].wasEncrypted = true),
			(r) => (r.formValues = { other: { a: 'b' } }),
			(r) => (r.pages = []),
			(r) => delete r.writer
		];
		for (const f of bad) {
			const raw = structuredClone(base()) as unknown as Record<string, unknown>;
			f(raw);
			expect(() => parseRecord(raw)).toThrow(SessionFormatError);
		}
		expect(() => parseRecord('nonsense')).toThrow(SessionFormatError);
		expect(() => parseRecord(null)).toThrow(SessionFormatError);
	});

	it('describes the offer in plain words', () => {
		const t = 1_000_000_000;
		expect(describeSummary({ files: 3, pages: 12, savedAt: t - 2 * 3600_000 }, t)).toBe('3 files, 12 pages, saved 2 hours ago');
		expect(describeSummary({ files: 1, pages: 1, savedAt: t }, t)).toBe('1 file, 1 page, saved just now');
		expect(describeSummary({ files: 0, pages: 2, savedAt: t - 60_000 }, t)).toBe('2 pages, saved 1 minute ago');
		expect(savedAgo(t - 30 * 3600_000, t)).toBe('saved yesterday');
		expect(savedAgo(t - 3 * 86400_000, t)).toBe('saved 3 days ago');
	});
});

// ---------------------------------------------------------------- controller

describe('session', () => {
	it('saves after changes and restores the identical document', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		expect(r.session.state).toBe('saved');
		expect(r.session.safeToLeave).toBe(true);
		const before = snapshotDoc(r.store);
		const rec = parseRecord(r.storage.raw());
		expect(rec.sources.map((s) => s.id)).toEqual(['a', 'b', 'blank']);
		expect(rec.exportForm.prefix).toBe('ACME-');
		// Each file stored once, by hash, and nothing else.
		const expected = new Set([
			await sha256Hex(pdfBytes('a')),
			await sha256Hex(pdfBytes('b')),
			await sha256Hex(pdfBytes('blank')),
			await sha256Hex(asset('sig').png)
		]);
		expect(new Set(r.storage.blobs.keys())).toEqual(expected);

		// Next visit.
		const r2 = rig({ storage: r.storage, t: r.clock.t + 3600_000 });
		await r2.session.init();
		expect(r2.session.offer).toEqual({ files: 2, pages: 7, savedAt: r.clock.t });
		expect(r2.store.state.pages).toHaveLength(0);
		const res = await r2.session.restore(async () => null);
		expect(res).toEqual({ ok: true, skipped: 0 });
		expect(snapshotDoc(r2.store)).toEqual(before);
		expect(r2.form.value.prefix).toBe('ACME-');
		expect(r2.form.value.compress).toBe(false);
		expect(r2.store.state.canUndo).toBe(false);
		expect(r2.session.offer).toBeNull();
		// The same export plan as the unbroken session.
		const opts = { filename: 'x.pdf', compress: false, stripMetadata: false };
		expect(JSON.parse(JSON.stringify(r2.store.toExportPlan(opts)))).toEqual(JSON.parse(JSON.stringify(r.store.toExportPlan(opts))));
	});

	it('a save writes only the record: file bytes are written once', async () => {
		const r = rig();
		await r.session.init();
		r.session.noteOpened(source('a', 2), { original: pdfBytes('x'), needsPassword: false });
		r.store.addSource(source('a', 2));
		await settle();
		const spy = vi.spyOn(r.storage, 'putBlob');
		for (let i = 0; i < 5; i++) {
			r.store.rotatePages([r.store.state.pages[0].id], 90);
			await settle();
		}
		expect(spy).not.toHaveBeenCalled();
		expect(parseRecord(r.storage.raw()).pages[0].rotation).toBe(90);
	});

	it('does not save undo history, selection or the export password', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		r.store.selectAll();
		r.form.value = { ...r.form.value, ...({ password: 'pässwörd' } as object) } as SavedExportForm;
		r.session.touch();
		await settle();
		const text = JSON.stringify(r.storage.raw());
		expect(text).not.toContain('pässwörd');
		expect(text).not.toMatch(/undo|selection/i);
	});

	it('restore refuses a blob whose hash does not match and deletes the saved work', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		const h = parseRecord(r.storage.raw()).sources[0].hash;
		const bytes = r.storage.blobs.get(h)!;
		bytes[20] ^= 0xff;
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		expect(r2.session.offer).not.toBeNull();
		expect(await r2.session.restore(async () => null)).toEqual({ ok: false, reason: 'broken' });
		expect(r2.store.state.pages).toHaveLength(0);
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);
	});

	it('restore refuses a missing blob', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		r.storage.blobs.delete(parseRecord(r.storage.raw()).assets[0].hash);
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		expect(await r2.session.restore(async () => null)).toEqual({ ok: false, reason: 'broken' });
		expect(r2.store.state.pages).toHaveLength(0);
		expect(r.storage.raw()).toBeUndefined();
	});

	it('a record of another schema version is deleted at load and the user is told', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		r.storage.setRaw({ ...(r.storage.raw() as object), schema: SCHEMA + 1 });
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		await settle(10);
		expect(r2.session.offer).toBeNull();
		expect(r2.notes).toEqual([BROKEN_MESSAGE]);
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);
	});

	it('expires 7 days after the last change (fake clock)', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		const saved = r.clock.t;
		const early = rig({ storage: r.storage, t: saved + EXPIRY_MS - 1000 });
		await early.session.init();
		expect(early.session.offer).not.toBeNull();
		const late = rig({ storage: r.storage, t: saved + EXPIRY_MS + 1 });
		await late.session.init();
		await settle(10);
		expect(late.session.offer).toBeNull();
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);
	});

	it('no room: the work stays open, nothing is saved, the line says so, leaving warns', async () => {
		const r = rig({ storage: memoryStorage({ quotaBytes: 100 }) });
		await r.session.init();
		buildWork(r);
		await settle();
		expect(r.session.state).toBe('full');
		expect(r.session.line).toBe('This work is not being saved. There is not enough room on this device.');
		expect(r.session.safeToLeave).toBe(false);
		expect(r.storage.raw()).toBeUndefined();
		expect(r.store.state.pages.length).toBe(7);
	});

	it('a file over the size limit is not kept', async () => {
		const r = rig({ maxFileBytes: 10 });
		await r.session.init();
		r.store.addSource(source('a', 1));
		await settle();
		expect(r.session.state).toBe('too-large');
		expect(r.storage.raw()).toBeUndefined();
	});

	it('storage that will not open: state unavailable, never throws', async () => {
		const store = createDocStore();
		const session = createSession({
			store,
			engine: fakeEngine(),
			openStorage: async () => {
				throw new DOMException('blocked', 'SecurityError');
			},
			claim: async () => ({ owner: true, release: () => undefined }),
			prefs: { get: () => true, set: () => undefined },
			exportForm: { get: () => ({ ...DEFAULT_FORM }), set: () => undefined },
			app: 't'
		});
		await session.init();
		store.addSource(source('a', 1));
		await settle(3000);
		expect(session.state).toBe('unavailable');
		expect(session.safeToLeave).toBe(false);
	});

	it('the off switch deletes what is stored and stops saving; on again saves', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		await r.session.setKeep(false);
		expect(r.prefs.on).toBe(false);
		expect(r.session.state).toBe('off');
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);
		r.store.rotatePages([r.store.state.pages[0].id], 90);
		await settle();
		expect(r.storage.raw()).toBeUndefined();
		// Remembered: the next visit does not save or offer anything.
		const r2 = rig({ storage: r.storage, keep: false });
		await r2.session.init();
		expect(r2.session.state).toBe('off');
		expect(r2.session.offer).toBeNull();
		// On again: this tab's open work is stored again.
		await r.session.setKeep(true);
		await settle();
		expect(r.session.state).toBe('saved');
		expect(parseRecord(r.storage.raw()).pages).toHaveLength(7);
	});

	it('Forget my work deletes everything now and the forgotten work is not saved again', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		await r.session.forget();
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);
		expect(r.session.state).toBe('forgotten');
		r.store.rotatePages([r.store.state.pages[0].id], 90);
		await settle();
		expect(r.storage.raw()).toBeUndefined();
		// Start over and open something new: that is saved.
		r.store.clear();
		await settle();
		r.store.addSource(source('n', 1));
		await settle();
		expect(r.session.state).toBe('saved');
		expect(parseRecord(r.storage.raw()).sources.map((s) => s.id)).toEqual(['n']);
		// Undo back to the forgotten work: not saved.
		r.store.undo();
		r.store.undo();
		await settle();
		expect(r.session.state).toBe('forgotten');
		expect(parseRecord(r.storage.raw()).sources.map((s) => s.id)).toEqual(['n']);
	});

	it('sweeps orphaned blobs, and blobs of files no longer used', async () => {
		const storage = memoryStorage();
		await storage.putBlob('f'.repeat(64), pdfBytes('stray'));
		const r = rig({ storage });
		await r.session.init();
		await settle(10);
		expect(storage.blobs.size).toBe(0);
		r.store.addSource(source('a', 1));
		r.store.addSource(source('b', 1));
		await settle();
		expect(storage.blobs.size).toBe(2);
		r.store.removePages([r.store.state.pages[1].id]);
		await settle();
		// Still reachable by undo: kept.
		expect(storage.blobs.size).toBe(2);
		r.session.sourceReleased('b');
		r.store.rotatePages([r.store.state.pages[0].id], 90);
		await settle();
		expect([...storage.blobs.keys()]).toEqual([await sha256Hex(pdfBytes('a'))]);
	});

	it('new work replaces the offer once it is first saved; until then the offer stays', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		expect(r2.session.offer).not.toBeNull();
		r2.session.noteOpened(source('z', 1), { original: pdfBytes('z'), needsPassword: false });
		// Opened but not added yet: the offer and the old record are untouched.
		await settle(10);
		expect(parseRecord(r.storage.raw()).sources).toHaveLength(3);
		r2.store.addSource(source('z', 1));
		await settle();
		expect(r2.session.offer).toBeNull();
		expect(parseRecord(r.storage.raw()).sources.map((s) => s.id)).toEqual(['z']);
		expect(r.storage.blobs.size).toBe(1);
	});

	it('Discard deletes the saved work; Start over deletes it after the undo window', async () => {
		const r = rig();
		await r.session.init();
		buildWork(r);
		await settle();
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		await r2.session.discard();
		expect(r2.session.offer).toBeNull();
		expect(r.storage.raw()).toBeUndefined();
		expect(r.storage.blobs.size).toBe(0);

		const r3 = rig();
		await r3.session.init();
		r3.store.addSource(source('a', 2));
		await settle();
		r3.store.clear();
		await settle(500);
		expect(r3.storage.raw()).not.toBeUndefined();
		r3.store.undo();
		await settle(2000);
		expect(r3.storage.raw()).not.toBeUndefined();
		r3.store.clear();
		await settle(1500);
		expect(r3.storage.raw()).toBeUndefined();
	});

	it('a second tab does not save, and a stale writer never overwrites another tab', async () => {
		const storage = memoryStorage();
		const a = rig({ storage, writer: 'A' });
		await a.session.init();
		const b = rig({ storage, owner: false, writer: 'B' });
		await b.session.init();
		expect(b.session.state).toBe('other-tab');
		b.store.addSource(source('b', 1));
		await settle();
		expect(storage.raw()).toBeUndefined();
		a.store.addSource(source('a', 1));
		await settle();
		expect(parseRecord(storage.raw()).writer).toBe('A');

		// Fallback race: a tab that wrongly thinks it owns the session is stopped by the writer check.
		const c = rig({ storage, writer: 'C' });
		await c.session.init(); // sees A's record as the offer
		a.store.rotatePages([a.store.state.pages[0].id], 90);
		await settle();
		c.store.addSource(source('c', 1));
		await settle();
		expect(c.session.state).toBe('other-tab');
		expect(parseRecord(storage.raw()).writer).toBe('A');
		expect(parseRecord(storage.raw()).pages[0].rotation).toBe(90);
	});

	it('password-protected files: stored as given, password asked again, skipping keeps a consistent session', async () => {
		const r = rig();
		await r.session.init();
		const original = pdfBytes('ENCRYPTED-ORIGINAL', 80);
		const prot: Source = { ...source('p', 2), wasEncrypted: true, bytes: pdfBytes('DECRYPTED-SECRET') };
		r.session.noteOpened(prot, { original, needsPassword: true });
		r.store.addSource(prot);
		r.store.addSource(source('a', 1));
		r.store.addAsset(asset('sig'));
		r.store.addStamp(r.store.state.pages[0].id, { kind: 'image', assetId: 'sig', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } });
		r.store.setFormValue('p', 'f', 'x');
		await settle();
		const rec = parseRecord(r.storage.raw());
		const p = rec.sources.find((s) => s.id === 'p')!;
		expect(p.stored).toBe('original');
		expect(p.needsPassword).toBe(true);
		expect(p.hash).toBe(await sha256Hex(original));
		// The decrypted bytes are stored nowhere.
		for (const b of r.storage.blobs.values()) expect(new TextDecoder().decode(b)).not.toContain('DECRYPTED-SECRET');

		// Restore: wrong, then right.
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		const asks: (string | undefined)[] = [];
		const answers = ['nope', 'secret'];
		const res = await r2.session.restore(async (a) => {
			asks.push(a.error);
			return answers.shift()!;
		});
		expect(res).toEqual({ ok: true, skipped: 0 });
		expect(asks).toEqual([undefined, 'That password did not open the file. Check it and try again.']);
		expect(r2.store.state.pages.map((x) => x.sourceId)).toEqual(['p', 'p', 'a']);
		expect(r2.store.state.sources[0].id).toBe('p');
		expect(r2.store.state.formValues).toEqual({ p: { f: 'x' } });

		// Restore again, skipping the protected file: its pages, answers and stamps go; the rest is whole.
		const r3 = rig({ storage: r.storage });
		await r3.session.init();
		const res3 = await r3.session.restore(async () => null);
		expect(res3).toEqual({ ok: true, skipped: 1 });
		expect(r3.store.state.pages.map((x) => x.sourceId)).toEqual(['a']);
		expect(r3.store.state.formValues).toEqual({});
		expect(r3.store.state.assets).toEqual([]);
		await settle();
		const after = parseRecord(r.storage.raw());
		expect(after.sources.map((s) => s.id)).toEqual(['a']);
	});

	it('skipping the only file restores nothing and keeps the offer', async () => {
		const r = rig();
		await r.session.init();
		const prot: Source = { ...source('p', 2), wasEncrypted: true };
		r.session.noteOpened(prot, { original: pdfBytes('ENC'), needsPassword: true });
		r.store.addSource(prot);
		await settle();
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		expect(await r2.session.restore(async () => null)).toEqual({ ok: false, reason: 'skipped' });
		expect(r2.session.offer).not.toBeNull();
		expect(r.storage.raw()).not.toBeUndefined();
	});

	it('a reopened protected file with different pages is refused', async () => {
		const r = rig();
		await r.session.init();
		const prot: Source = { ...source('p', 3), wasEncrypted: true };
		r.session.noteOpened(prot, { original: pdfBytes('ENC'), needsPassword: true });
		r.store.addSource(prot);
		await settle();
		const r2 = rig({ storage: r.storage });
		await r2.session.init();
		// fakeEngine reopens with 2 pages: does not match the 3 saved.
		expect(await r2.session.restore(async () => 'secret')).toEqual({ ok: false, reason: 'broken' });
		expect(r2.store.state.pages).toHaveLength(0);
	});
});
