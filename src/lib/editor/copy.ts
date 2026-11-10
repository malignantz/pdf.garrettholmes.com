/** Pure helpers for "Copy to pages…". */

import type { Stamp } from '../core/types';
import type { NewStamp } from '../doc/store';
import { adaptBox } from './geometry';

/**
 * 0-based target page indices: all pages, or pages `from`..`to` (1-based,
 * inclusive, either order, clamped), always without the stamp's own page.
 */
export function copyTargets(count: number, current: number, mode: 'all' | 'range', from: number, to: number): number[] {
	let lo = 0;
	let hi = count - 1;
	if (mode === 'range') {
		if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
		const a = Math.round(Math.min(from, to)) - 1;
		const b = Math.round(Math.max(from, to)) - 1;
		lo = Math.max(0, a);
		hi = Math.min(count - 1, b);
	}
	const out: number[] = [];
	for (let i = lo; i <= hi; i++) if (i !== current) out.push(i);
	return out;
}

/**
 * The stamp as it should land on a page with another displayed aspect
 * (width / height): same place, same on-screen shape. Returns a stamp without id.
 */
export function stampForPage(s: Stamp, fromAspect: number, toAspect: number): NewStamp {
	if (s.kind === 'text') {
		const { id: _id, ...rest } = s;
		return { ...rest };
	}
	const { id: _id, ...rest } = s;
	return { ...rest, box: adaptBox(s.box, fromAspect, toAspect) } as NewStamp;
}
