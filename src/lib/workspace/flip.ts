/**
 * FLIP animation for grid changes: record where the tiles near the viewport are,
 * apply the change, then slide each tile from its old place to its new one.
 * Tiles that were not on screen before simply appear. Honors reduced motion.
 */

const DURATION = 180;
const EASE = 'cubic-bezier(0.2, 0, 0, 1)';

export type Snapshot = Map<string, DOMRect>;

function reduced(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Positions of visible tiles (with a margin), keyed by data-id. */
export function snapshot(root: HTMLElement | undefined): Snapshot {
	const map: Snapshot = new Map();
	if (!root || reduced()) return map;
	const margin = innerHeight * 0.5;
	for (const el of root.querySelectorAll<HTMLElement>('[data-id]')) {
		const r = el.getBoundingClientRect();
		if (r.bottom < -margin || r.top > innerHeight + margin) continue;
		map.set(el.dataset.id!, r);
	}
	return map;
}

/** Animate from `before` to the current layout. `entering` ids fade and scale in. */
export function play(root: HTMLElement | undefined, before: Snapshot, entering: ReadonlySet<string> = new Set()) {
	if (!root || reduced()) return;
	for (const el of root.querySelectorAll<HTMLElement>('[data-id]')) {
		const id = el.dataset.id!;
		const now = el.getBoundingClientRect();
		if (now.bottom < 0 || now.top > innerHeight) continue;
		const was = before.get(id);
		if (was && !entering.has(id)) {
			const dx = was.left - now.left;
			const dy = was.top - now.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
			el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
				duration: DURATION,
				easing: EASE
			});
		} else if (entering.has(id) || before.size > 0) {
			el.animate(
				[
					{ opacity: 0, transform: 'scale(0.92)' },
					{ opacity: 1, transform: 'none' }
				],
				{ duration: DURATION, easing: EASE }
			);
		}
	}
}
