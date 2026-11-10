/**
 * Toast queue. `toasts.show({ message, action })` from anywhere; the layout's
 * <ToastRegion> renders them. At most three are visible; the oldest drops off.
 */

export interface ToastAction {
	label: string;
	run: () => void;
}

export interface ToastInput {
	message: string;
	/** 'error' toasts are announced assertively and stay until dismissed. */
	tone?: 'info' | 'ok' | 'error';
	action?: ToastAction;
	/** ms before auto-dismiss; 0 keeps it until dismissed. Default 5s, 8s with an action. */
	timeout?: number;
}

export interface Toast extends Required<Omit<ToastInput, 'action'>> {
	id: number;
	action?: ToastAction;
}

const MAX = 3;
let nextId = 1;
const timers = new Map<number, { left: number; started: number; handle?: ReturnType<typeof setTimeout> }>();

function createToasts() {
	const list = $state<Toast[]>([]);

	function dismiss(id: number) {
		const t = timers.get(id);
		if (t?.handle) clearTimeout(t.handle);
		timers.delete(id);
		const i = list.findIndex((x) => x.id === id);
		if (i >= 0) list.splice(i, 1);
	}

	function arm(id: number) {
		const t = timers.get(id);
		if (!t || t.left <= 0) return;
		t.started = Date.now();
		t.handle = setTimeout(() => dismiss(id), t.left);
	}

	return {
		get list(): readonly Toast[] {
			return list;
		},
		show(input: ToastInput | string): number {
			const i = typeof input === 'string' ? { message: input } : input;
			const tone = i.tone ?? 'info';
			const timeout = i.timeout ?? (tone === 'error' ? 0 : i.action ? 8000 : 5000);
			const id = nextId++;
			list.push({ id, message: i.message, tone, timeout, action: i.action });
			while (list.length > MAX) dismiss(list[0].id);
			if (timeout > 0) {
				timers.set(id, { left: timeout, started: Date.now() });
				arm(id);
			}
			return id;
		},
		dismiss,
		/** Pause auto-dismiss while the pointer or focus is on the toast region. */
		pause() {
			for (const t of timers.values()) {
				if (t.handle) {
					clearTimeout(t.handle);
					t.handle = undefined;
					t.left -= Date.now() - t.started;
				}
			}
		},
		resume() {
			for (const id of timers.keys()) if (!timers.get(id)?.handle) arm(id);
		},
		clear() {
			for (const t of [...list]) dismiss(t.id);
		}
	};
}

export const toasts = createToasts();
