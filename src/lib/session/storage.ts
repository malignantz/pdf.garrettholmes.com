/**
 * Where a saved session lives: IndexedDB on this device, database
 * "pdf-workspace-session", two object stores:
 *  - `session`: one record under the key "current" (format.ts), a few KB;
 *  - `blobs`:   `{ hash, size, blob }`, one per source file and asset, keyed by the
 *    SHA-256 of the bytes, so a file is written once and never again on a save.
 * Nothing here touches the network. `memoryStorage` is the same contract in memory
 * for unit tests.
 */

export class StorageFullError extends Error {
	constructor(message = 'Not enough room on this device') {
		super(message);
		this.name = 'StorageFullError';
	}
}

/** What a guarded record write found. */
export type PutResult = 'ok' | 'conflict' | 'missing-blob';

export interface SessionStorage {
	/** The stored record, untyped (format.ts parses it), or undefined. */
	getRecord(): Promise<unknown>;
	/**
	 * Write the record in one transaction, only if `allow(current)` says so and every
	 * hash in `needs` is stored. Otherwise nothing is written.
	 */
	putRecord(record: unknown, allow: (current: unknown) => boolean, needs: readonly string[]): Promise<PutResult>;
	deleteRecord(): Promise<void>;
	hasBlob(hash: string): Promise<boolean>;
	/** Throws StorageFullError when the browser refuses for lack of room. */
	putBlob(hash: string, bytes: Uint8Array): Promise<void>;
	getBlob(hash: string): Promise<Uint8Array | null>;
	blobKeys(): Promise<string[]>;
	deleteBlobs(hashes: readonly string[]): Promise<void>;
	/** Delete the record and every blob. */
	clear(): Promise<void>;
}

const DB = 'pdf-workspace-session';
const RECORDS = 'session';
const BLOBS = 'blobs';
const KEY = 'current';

function isQuota(e: unknown): boolean {
	const name = (e as { name?: string } | null)?.name;
	return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED';
}

function req<T>(r: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error);
	});
}

function done(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(isQuota(tx.error) ? new StorageFullError() : tx.error);
		tx.onabort = () => reject(isQuota(tx.error) ? new StorageFullError() : (tx.error ?? new Error('aborted')));
	});
}

/** Open the database. Rejects when storage is unavailable (blocked, private mode quirks, no IndexedDB). */
export function openIdbStorage(): Promise<SessionStorage> {
	return new Promise<IDBDatabase>((resolve, reject) => {
		let r: IDBOpenDBRequest;
		try {
			if (typeof indexedDB === 'undefined' || !indexedDB) return reject(new Error('IndexedDB is not available'));
			r = indexedDB.open(DB, 1);
		} catch (e) {
			return reject(e);
		}
		r.onupgradeneeded = () => {
			const db = r.result;
			if (!db.objectStoreNames.contains(RECORDS)) db.createObjectStore(RECORDS);
			if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'hash' });
		};
		r.onsuccess = () => resolve(r.result);
		r.onerror = () => reject(r.error ?? new Error('IndexedDB did not open'));
		r.onblocked = () => reject(new Error('IndexedDB is blocked'));
	}).then((db) => {
		// Another tab of a newer build asking to upgrade: let it.
		db.onversionchange = () => db.close();
		return idb(db);
	});
}

function idb(db: IDBDatabase): SessionStorage {
	const tx = (stores: string | string[], mode: IDBTransactionMode) => db.transaction(stores, mode);
	return {
		async getRecord() {
			return req(tx(RECORDS, 'readonly').objectStore(RECORDS).get(KEY));
		},
		async putRecord(record, allow, needs) {
			const t = tx([RECORDS, BLOBS], 'readwrite');
			const finished = done(t);
			let result: PutResult = 'ok';
			try {
				const current = await req(t.objectStore(RECORDS).get(KEY));
				if (!allow(current)) result = 'conflict';
				else {
					const blobs = t.objectStore(BLOBS);
					const counts = await Promise.all(needs.map((h) => req(blobs.count(h))));
					if (counts.some((c) => c === 0)) result = 'missing-blob';
					else t.objectStore(RECORDS).put(record, KEY);
				}
				if (result !== 'ok') t.abort();
			} catch (e) {
				try {
					t.abort();
				} catch {
					// Already finished.
				}
				await finished.catch(() => undefined);
				throw isQuota(e) ? new StorageFullError() : e;
			}
			if (result !== 'ok') {
				await finished.catch(() => undefined);
				return result;
			}
			await finished;
			return 'ok';
		},
		async deleteRecord() {
			const t = tx(RECORDS, 'readwrite');
			t.objectStore(RECORDS).delete(KEY);
			await done(t);
		},
		async hasBlob(hash) {
			return (await req(tx(BLOBS, 'readonly').objectStore(BLOBS).count(hash))) > 0;
		},
		async putBlob(hash, bytes) {
			const t = tx(BLOBS, 'readwrite');
			try {
				t.objectStore(BLOBS).put({ hash, size: bytes.length, blob: new Blob([bytes as BlobPart]) });
			} catch (e) {
				throw isQuota(e) ? new StorageFullError() : e;
			}
			await done(t);
		},
		async getBlob(hash) {
			const row = (await req(tx(BLOBS, 'readonly').objectStore(BLOBS).get(hash))) as { blob?: Blob } | undefined;
			if (!row?.blob) return null;
			return new Uint8Array(await row.blob.arrayBuffer());
		},
		async blobKeys() {
			return (await req(tx(BLOBS, 'readonly').objectStore(BLOBS).getAllKeys())).map(String);
		},
		async deleteBlobs(hashes) {
			if (!hashes.length) return;
			const t = tx(BLOBS, 'readwrite');
			const s = t.objectStore(BLOBS);
			for (const h of hashes) s.delete(h);
			await done(t);
		},
		async clear() {
			const t = tx([RECORDS, BLOBS], 'readwrite');
			t.objectStore(RECORDS).clear();
			t.objectStore(BLOBS).clear();
			await done(t);
		}
	};
}

/** In-memory storage with the same contract (tests). `failWrites` simulates a full device. */
export function memoryStorage(opts: { quotaBytes?: number } = {}) {
	let record: unknown = undefined;
	const blobs = new Map<string, Uint8Array>();
	const used = () => [...blobs.values()].reduce((n, b) => n + b.length, 0);
	const store: SessionStorage & { blobs: Map<string, Uint8Array>; raw: () => unknown; setRaw: (v: unknown) => void } = {
		blobs,
		raw: () => record,
		setRaw: (v) => (record = structuredClone(v)),
		async getRecord() {
			return record === undefined ? undefined : structuredClone(record);
		},
		async putRecord(rec, allow, needs) {
			if (!allow(record === undefined ? undefined : structuredClone(record))) return 'conflict';
			if (needs.some((h) => !blobs.has(h))) return 'missing-blob';
			record = structuredClone(rec);
			return 'ok';
		},
		async deleteRecord() {
			record = undefined;
		},
		async hasBlob(hash) {
			return blobs.has(hash);
		},
		async putBlob(hash, bytes) {
			if (opts.quotaBytes !== undefined && used() + bytes.length > opts.quotaBytes) throw new StorageFullError();
			blobs.set(hash, bytes.slice());
		},
		async getBlob(hash) {
			return blobs.get(hash)?.slice() ?? null;
		},
		async blobKeys() {
			return [...blobs.keys()];
		},
		async deleteBlobs(hashes) {
			for (const h of hashes) blobs.delete(h);
		},
		async clear() {
			record = undefined;
			blobs.clear();
		}
	};
	return store;
}
