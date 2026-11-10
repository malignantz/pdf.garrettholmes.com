/**
 * Saved signatures and initials, kept in IndexedDB on this device only. Nothing
 * here ever leaves the browser. Every call fails soft: when storage is blocked
 * (private windows, disabled site data) the list is empty and saving reports false.
 */

export interface SavedInk {
	id: string;
	kind: 'signature' | 'initials';
	png: Uint8Array;
	width: number;
	height: number;
	created: number;
}

const DB = 'pdf-editor-saved-ink';
const STORE = 'saved-ink';

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
	if (dbPromise) return dbPromise;
	dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
		if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
		const req = indexedDB.open(DB, 1);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
		req.onblocked = () => reject(new Error('IndexedDB is blocked'));
	});
	dbPromise.catch(() => (dbPromise = null));
	return dbPromise;
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
	return open().then(
		(db) =>
			new Promise<T>((resolve, reject) => {
				const tx = db.transaction(STORE, mode);
				const req = fn(tx.objectStore(STORE));
				tx.oncomplete = () => resolve(req.result);
				tx.onerror = () => reject(tx.error);
				tx.onabort = () => reject(tx.error);
			})
	);
}

/** Saved items of one kind, newest first. Empty if storage is unavailable. */
export async function listSaved(kind: SavedInk['kind']): Promise<SavedInk[]> {
	try {
		const all = (await run('readonly', (s) => s.getAll())) as SavedInk[];
		return all.filter((x) => x.kind === kind && x.png instanceof Uint8Array).sort((a, b) => b.created - a.created);
	} catch {
		return [];
	}
}

export async function saveInk(item: SavedInk): Promise<boolean> {
	try {
		await run('readwrite', (s) => s.put(item));
		return true;
	} catch {
		return false;
	}
}

export async function deleteInk(id: string): Promise<boolean> {
	try {
		await run('readwrite', (s) => s.delete(id));
		return true;
	} catch {
		return false;
	}
}
