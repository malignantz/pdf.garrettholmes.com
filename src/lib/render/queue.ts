/**
 * Render scheduler: limited concurrency, most-recent-request-first, abortable.
 * Framework-free; knows nothing about PDF.js.
 */

export function abortError(message = 'Render aborted'): DOMException {
	return new DOMException(message, 'AbortError');
}

export type Task<T> = (signal: AbortSignal) => Promise<T>;

interface Pending {
	run: () => void;
	reject: (reason: unknown) => void;
	cleanup: () => void;
}

export class RenderQueue {
	#concurrency: number;
	#running = 0;
	/** Stack: the last element is the newest request and runs first. */
	#pending: Pending[] = [];

	constructor(concurrency: number) {
		this.#concurrency = Math.max(1, concurrency);
	}

	get running(): number {
		return this.#running;
	}
	get pending(): number {
		return this.#pending.length;
	}

	/**
	 * Queue a task. If `signal` aborts before the task starts it never runs and the
	 * promise rejects with AbortError. If it aborts while running, the task gets a
	 * signal that fires too and must stop; the promise rejects with AbortError
	 * whatever the task throws.
	 */
	add<T>(task: Task<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) return Promise.reject(abortError());
		return new Promise<T>((resolve, reject) => {
			const ac = new AbortController();
			const onAbort = () => {
				const i = this.#pending.indexOf(entry);
				if (i >= 0) {
					this.#pending.splice(i, 1);
					entry.cleanup();
					reject(abortError());
				} else {
					ac.abort();
				}
			};
			const entry: Pending = {
				run: () => {
					this.#running++;
					Promise.resolve()
						.then(() => task(ac.signal))
						.then(
							(v) => {
								entry.cleanup();
								if (signal?.aborted) reject(abortError());
								else resolve(v);
							},
							(e) => {
								entry.cleanup();
								reject(signal?.aborted ? abortError() : e);
							}
						)
						.finally(() => {
							this.#running--;
							this.#pump();
						});
				},
				reject,
				cleanup: () => signal?.removeEventListener('abort', onAbort)
			};
			signal?.addEventListener('abort', onAbort);
			this.#pending.push(entry);
			this.#pump();
		});
	}

	/** Reject everything not yet started. */
	clearPending(): void {
		const list = this.#pending.splice(0);
		for (const p of list) {
			p.cleanup();
			p.reject(abortError());
		}
	}

	#pump(): void {
		while (this.#running < this.#concurrency && this.#pending.length) {
			this.#pending.pop()!.run();
		}
	}
}
