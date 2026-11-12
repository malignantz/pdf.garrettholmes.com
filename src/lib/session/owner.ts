/**
 * Which tab owns the saved session. Only one tab may write it; a second tab works
 * normally but does not save.
 *
 * - Web Locks (`navigator.locks`): the first tab holds the lock "pdf-workspace-session"
 *   until it closes. Another tab queues for it and is told when it is free.
 * - Fallback (no Web Locks): a BroadcastChannel roll call; a tab that hears another
 *   one answer is not the owner. Two tabs that start in the same instant can both
 *   think they own it; the record's writer check (session.ts) then stops the second
 *   one before it overwrites anything.
 */

export interface Ownership {
	owner: boolean;
	/** When not the owner: resolves when the owning tab has gone (Web Locks only). */
	freed?: Promise<void>;
	/** Give up ownership (or a queued request). */
	release(): void;
}

const LOCK = 'pdf-workspace-session';
const CHANNEL = 'pdf-workspace-session';

export async function claimOwnership(): Promise<Ownership> {
	const locks = (navigator as Navigator & { locks?: LockManager }).locks;
	if (locks) {
		try {
			return await viaLocks(locks);
		} catch {
			// Fall through to the roll call.
		}
	}
	return viaChannel();
}

function viaLocks(locks: LockManager): Promise<Ownership> {
	return new Promise<Ownership>((resolve, reject) => {
		let releaseHeld: () => void = () => undefined;
		const held = new Promise<void>((r) => (releaseHeld = r));
		locks
			.request(LOCK, { ifAvailable: true }, (lock) => {
				if (!lock) {
					// Someone else has it: queue, and say when it is free.
					const abort = new AbortController();
					let releaseQueued: () => void = () => undefined;
					const freed = new Promise<void>((resolveFreed) => {
						locks
							.request(LOCK, { signal: abort.signal }, () => {
								resolveFreed();
								return new Promise<void>((r) => (releaseQueued = r));
							})
							.catch(() => undefined);
					});
					resolve({
						owner: false,
						freed,
						release: () => {
							abort.abort();
							releaseQueued();
						}
					});
					return;
				}
				resolve({ owner: true, release: () => releaseHeld() });
				return held;
			})
			.catch(reject);
	});
}

function viaChannel(): Promise<Ownership> {
	if (typeof BroadcastChannel === 'undefined') return Promise.resolve({ owner: true, release: () => undefined });
	return new Promise((resolve) => {
		const ch = new BroadcastChannel(CHANNEL);
		let other = false;
		ch.onmessage = (e) => {
			if (e.data === 'here') other = true;
		};
		ch.postMessage('who');
		setTimeout(() => {
			if (other) {
				ch.close();
				resolve({ owner: false, release: () => undefined });
				return;
			}
			ch.onmessage = (e) => {
				if (e.data === 'who') ch.postMessage('here');
			};
			resolve({ owner: true, release: () => ch.close() });
		}, 150);
	});
}
