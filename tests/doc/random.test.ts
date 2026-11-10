import { describe, expect, it } from 'vitest';
import type { PageRef } from '../../src/lib/core/types';
import { newPageRef, type DocStore } from '../../src/lib/doc/store';
import { checkInvariants, docOf, makeAsset, makeSource, makeStore } from './helpers';

function mulberry32(seed: number) {
	return () => {
		seed |= 0;
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function step(store: DocStore, rnd: () => number, ctr: { n: number }): void {
	const int = (n: number) => Math.floor(rnd() * n);
	const pages = store.state.pages;
	const pick = (): string[] => {
		const k = int(Math.min(4, pages.length + 1));
		return Array.from({ length: k }, () => pages[int(pages.length)]?.id).filter(Boolean);
	};
	const box = { x: rnd(), y: rnd(), w: 0.1, h: 0.1 };
	switch (int(17)) {
		case 0:
			store.addSource(makeSource(`s${ctr.n++}`, 1 + int(4)), rnd() < 0.5 ? int(pages.length + 2) : undefined);
			break;
		case 1: {
			const srcs = store.state.sources;
			if (srcs.length) {
				const s = srcs[int(srcs.length)];
				store.insertPages([newPageRef(s.id, int(s.pages.length))], int(pages.length + 2));
			}
			break;
		}
		case 2:
			store.removePages(pick());
			break;
		case 3:
		case 4:
			store.movePages(pick(), int(pages.length + 2) - 1);
			break;
		case 5:
			store.rotatePages(pick(), [90, 180, 270, -90][int(4)]);
			break;
		case 6:
			store.duplicatePages(pick());
			break;
		case 7:
			store.reversePages(rnd() < 0.5 ? undefined : pick());
			break;
		case 8:
			store.sortBySource();
			break;
		case 9:
			if (pages.length) store.addStamp(pages[int(pages.length)].id, { kind: 'mark', mark: 'check', box });
			break;
		case 10:
			if (pages.length) {
				const p = pages[int(pages.length)];
				if (store.state.assets.length)
					store.addStamp(p.id, { kind: 'image', assetId: store.state.assets[0].id, box });
				else store.addStamp(p.id, { kind: 'text', text: 'x', x: rnd(), y: rnd(), size: 0.02, color: 'blue' });
			}
			break;
		case 11: {
			const withStamp = pages.filter((p: PageRef) => p.stamps.length);
			if (withStamp.length) {
				const p = withStamp[int(withStamp.length)];
				const s = p.stamps[int(p.stamps.length)];
				if (s.kind === 'text') store.updateStamp(p.id, s.id, { x: rnd(), text: `t${int(9)}` });
				else store.updateStamp(p.id, s.id, { box });
			}
			break;
		}
		case 12: {
			const withStamp = pages.filter((p: PageRef) => p.stamps.length);
			if (withStamp.length) {
				const p = withStamp[int(withStamp.length)];
				store.removeStamp(p.id, p.stamps[int(p.stamps.length)].id);
			}
			break;
		}
		case 13:
			store.addAsset(makeAsset(`as${ctr.n++}`));
			break;
		case 14: {
			const a = store.state.assets;
			if (a.length) store.removeAsset(a[int(a.length)].id, { cascade: rnd() < 0.5 });
			break;
		}
		case 15:
			store.transaction('multi', () => {
				store.rotatePages(pick(), 90);
				store.removePages(pick());
				store.reversePages();
			});
			break;
		case 16:
			// selection churn must never affect the document
			if (rnd() < 0.5 && pages.length) store.setSelection(pick());
			else if (pages.length) store.selectRange(pages[int(pages.length)].id);
			if (rnd() < 0.03) store.clear();
			break;
	}
}

describe('randomized command sequences', () => {
	for (let seed = 1; seed <= 40; seed++) {
		it(`seed ${seed}: invariants hold, undo-all = start, redo-all = end`, () => {
			const rnd = mulberry32(seed * 7919);
			const { store } = makeStore({ maxHistory: 1000 });
			const ctr = { n: 0 };
			// a non-empty start so that "start" is interesting
			store.addSource(makeSource('base', 3));
			store.addAsset(makeAsset('baseAsset'));
			store.addStamp(store.state.pages[0].id, {
				kind: 'image',
				assetId: 'baseAsset',
				box: { x: 0, y: 0, w: 0.5, h: 0.5 }
			});
			const start = docOf(store);

			for (let i = 0; i < 120; i++) {
				step(store, rnd, ctr);
				checkInvariants(store);
			}
			const end = docOf(store);

			// undo everything: back to the empty workspace
			while (store.undo()) checkInvariants(store);
			expect(store.state.pages).toEqual([]);
			expect(store.state.sources).toEqual([]);
			expect(store.state.assets).toEqual([]);

			// redo everything: exactly the end state
			while (store.redo()) checkInvariants(store);
			expect(docOf(store)).toEqual(end);

			// undo all, redo only the 3 setup steps: exactly the start state
			while (store.undo());
			for (let i = 0; i < 3; i++) store.redo();
			expect(docOf(store)).toEqual(start);
		});
	}

	it('releases only sources that no snapshot in history uses', () => {
		for (let seed = 100; seed < 120; seed++) {
			const rnd = mulberry32(seed);
			const { store, released } = makeStore({ maxHistory: 8 });
			const ctr = { n: 0 };
			store.addSource(makeSource('base', 2));
			for (let i = 0; i < 150; i++) {
				step(store, rnd, ctr);
				// a released source must not be referenced by the document
				const live = new Set(store.state.sources.map((s) => s.id));
				for (const id of released) expect(live.has(id)).toBe(false);
				// everything undo/redo can reach must still resolve
				let u = 0;
				while (store.undo()) {
					u++;
					checkInvariants(store);
					for (const p of store.state.pages) expect(store.sourceOf(p.id)).toBeDefined();
				}
				while (u-- > 0) {
					store.redo();
					checkInvariants(store);
				}
			}
			expect(new Set(released).size).toBe(released.length);
		}
	});

	it('undo-all with a cap restores the oldest retained state', () => {
		const rnd = mulberry32(5);
		const { store } = makeStore({ maxHistory: 10 });
		const ctr = { n: 0 };
		store.addSource(makeSource('base', 4));
		for (let i = 0; i < 60; i++) step(store, rnd, ctr);
		const end = docOf(store);
		let n = 0;
		while (store.undo()) n++;
		expect(n).toBeLessThanOrEqual(10);
		while (store.redo()) n--;
		expect(n).toBe(0);
		expect(docOf(store)).toEqual(end);
	});
});
