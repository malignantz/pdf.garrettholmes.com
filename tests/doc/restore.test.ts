import { describe, expect, it } from 'vitest';
import type { PageRef } from '../../src/lib/core/types';
import { checkInvariants, makeAsset, makeSource, makeStore } from './helpers';

const page = (id: string, sourceId: string, pageIndex: number, extra: Partial<PageRef> = {}): PageRef => ({
	id,
	sourceId,
	pageIndex,
	rotation: 0,
	stamps: [],
	...extra
});

describe('restore', () => {
	it('replaces the document, clears history and keeps exact pages, stamps and answers', () => {
		const { store, released } = makeStore();
		store.addSource(makeSource('old', 2));
		store.rotatePages([store.state.pages[0].id], 90);
		const a = makeSource('a', 3);
		const pages = [
			page('p2', 'a', 2, { rotation: 270, stamps: [{ id: 's1', kind: 'image', assetId: 'sig', box: { x: 0.1, y: 0.1, w: 0.2, h: 0.1 } }] }),
			page('p0', 'a', 0),
			page('p0b', 'a', 0, { stamps: [{ id: 's2', kind: 'text', text: 'hi', x: 0.1, y: 0.2, size: 0.02, color: 'red' }] })
		];
		store.restore({ sources: [a], pages, assets: [makeAsset('sig')], formValues: { a: { f: 'x', c: true } } });
		expect(released).toEqual(['old']);
		expect(store.state.pages).toEqual(pages);
		expect(store.state.formValues).toEqual({ a: { f: 'x', c: true } });
		expect(store.canUndo).toBe(false);
		expect(store.canRedo).toBe(false);
		expect(store.isDirty).toBe(true);
		checkInvariants(store);
		// Works like any document afterwards.
		store.rotatePages(['p0'], 90);
		expect(store.undo()).toBe(true);
		expect(store.undo()).toBe(false);
	});

	it('clean: a document saved after its export is not dirty', () => {
		const { store } = makeStore();
		store.restore({ sources: [makeSource('a', 1)], pages: [page('p', 'a', 0)], assets: [], formValues: {} }, { clean: true });
		expect(store.isDirty).toBe(false);
	});

	it('refuses inconsistent documents and leaves the store unchanged', () => {
		const { store } = makeStore();
		store.addSource(makeSource('keep', 1));
		const before = store.state;
		const a = makeSource('a', 2);
		const bad = [
			{ sources: [a], pages: [page('p', 'a', 5)], assets: [], formValues: {} },
			{ sources: [a], pages: [page('p', 'zz', 0)], assets: [], formValues: {} },
			{ sources: [a], pages: [page('p', 'a', 0), page('p', 'a', 1)], assets: [], formValues: {} },
			{ sources: [a, a], pages: [page('p', 'a', 0)], assets: [], formValues: {} },
			{ sources: [a, makeSource('b', 1)], pages: [page('p', 'a', 0)], assets: [], formValues: {} },
			{ sources: [a], pages: [page('p', 'a', 0, { rotation: 45 as never })], assets: [], formValues: {} },
			{ sources: [a], pages: [page('p', 'a', 0, { stamps: [{ id: 's', kind: 'image', assetId: 'none', box: { x: 0, y: 0, w: 0.1, h: 0.1 } }] })], assets: [], formValues: {} },
			{ sources: [a], pages: [page('p', 'a', 0)], assets: [], formValues: { b: { x: 'y' } } },
			{ sources: [a], pages: [page('p', 'a', 0)], assets: [], formValues: { a: { x: 3 as never } } },
			{
				sources: [a],
				pages: [page('p', 'a', 0, { stamps: [{ id: 's', kind: 'highlight', color: 'yellow', box: { x: 0, y: 0, w: 0.1, h: 0.1 }, rects: [{ x: 0.5, y: 0.5, w: 0.1, h: 0.1 }] }] })],
				assets: [],
				formValues: {}
			}
		];
		for (const snap of bad) {
			expect(() => store.restore(snap)).toThrow();
			expect(store.state).toBe(before);
		}
	});
});
