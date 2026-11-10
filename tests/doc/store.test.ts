import { describe, expect, it } from 'vitest';
import { newId, newPageRef } from '../../src/lib/doc/store';
import {
	checkInvariants,
	exportOptions,
	ids,
	makeAsset,
	makeSource,
	makeStore,
	names
} from './helpers';

function setup(a = 4, b = 0) {
	const ctx = makeStore();
	const A = makeSource('a', a);
	ctx.store.addSource(A);
	if (b) ctx.store.addSource(makeSource('b', b));
	return { ...ctx, A };
}

describe('addSource', () => {
	it('appends all pages with fresh ids and labels the step', () => {
		const { store } = setup(3);
		expect(names(store)).toEqual(['a0', 'a1', 'a2']);
		expect(store.undoLabel).toBe('Add a.pdf');
		expect(new Set(ids(store)).size).toBe(3);
		expect(store.state.sources.map((s) => s.id)).toEqual(['a']);
	});
	it('inserts at an index and clamps', () => {
		const { store } = setup(3);
		store.addSource(makeSource('b', 2), 1);
		expect(names(store)).toEqual(['a0', 'b0', 'b1', 'a1', 'a2']);
		store.addSource(makeSource('c', 1), 99);
		expect(names(store).at(-1)).toBe('c0');
		store.addSource(makeSource('d', 1), -5);
		expect(names(store)[0]).toBe('d0');
	});
	it('rejects a source that is already open', () => {
		const { store, A } = setup(1);
		expect(() => store.addSource(A)).toThrow();
	});
	it('is undoable and redoable', () => {
		const { store } = setup(2);
		store.undo();
		expect(store.pageCount).toBe(0);
		expect(store.state.sources).toEqual([]);
		store.redo();
		expect(store.pageCount).toBe(2);
	});
});

describe('movePages index semantics', () => {
	// before-move positions: toIndex = insertion slot in the ORIGINAL list
	const run = (move: string[], to: number) => {
		const { store } = setup(6);
		const p = ids(store);
		const changed = store.movePages(move.map((m) => p[Number(m)]), to);
		return { changed, order: names(store).map((n) => n.slice(1)).join('') };
	};
	it('moves one page forward and back', () => {
		expect(run(['1'], 4).order).toBe('023145');
		expect(run(['4'], 1).order).toBe('041235');
	});
	it('index = length moves to the end, 0 to the start', () => {
		expect(run(['0'], 6).order).toBe('123450');
		expect(run(['5'], 0).order).toBe('501234');
	});
	it('clamps out-of-range indices', () => {
		expect(run(['0'], 100).order).toBe('123450');
		expect(run(['5'], -3).order).toBe('501234');
	});
	it('moving a block onto itself is a no-op without a history step', () => {
		for (const to of [1, 2, 3, 4]) {
			const r = run(['1', '2', '3'], to);
			expect(r.changed).toBe(false);
			expect(r.order).toBe('012345');
		}
		const { store } = setup(6);
		const p = ids(store);
		const before = store.undoLabel;
		store.movePages([p[1], p[2]], 2);
		expect(store.undoLabel).toBe(before);
	});
	it('a block moved to just outside itself does change', () => {
		expect(run(['1', '2'], 4).order).toBe('031245');
		expect(run(['1', '2'], 0).order).toBe('120345');
	});
	it('keeps document order of the set regardless of the order passed', () => {
		const { store } = setup(6);
		const p = ids(store);
		store.movePages([p[4], p[1]], 6);
		expect(names(store).map((n) => n.slice(1)).join('')).toBe('023514');
	});
	it('gathers a non-contiguous set at the slot', () => {
		// slot 3 is before page 3; pages 0,2 precede it, so the block lands after page 1
		expect(run(['0', '2', '4'], 3).order).toBe('102435');
	});
	it('ignores unknown ids and returns false when nothing matches', () => {
		const { store } = setup(3);
		expect(store.movePages(['nope'], 0)).toBe(false);
		expect(() => store.movePages([], Number.NaN)).toThrow();
	});
	it('preserves identity of moved pages (same objects)', () => {
		const { store } = setup(3);
		const before = [...store.state.pages];
		store.movePages([before[0].id], 3);
		expect(store.state.pages).toContain(before[0]);
		expect(store.state.pages).toContain(before[1]);
	});
	it('labels', () => {
		const { store } = setup(3);
		store.movePages([ids(store)[0]], 3);
		expect(store.undoLabel).toBe('Move page');
		store.movePages(ids(store).slice(0, 2), 3);
		expect(store.undoLabel).toBe('Move 2 pages');
	});
});

describe('insertPages', () => {
	it('inserts before the page at the index', () => {
		const { store } = setup(3, 1);
		const ref = newPageRef('b', 0);
		store.insertPages([ref], 1);
		expect(names(store)).toEqual(['a0', 'b0', 'a1', 'a2', 'b0']);
		expect(store.state.pages[1].id).toBe(ref.id);
	});
	it('can re-insert a page of a source whose pages were all deleted', () => {
		const { store } = setup(2, 1);
		store.removePages(store.state.pages.filter((p) => p.sourceId === 'b').map((p) => p.id));
		expect(store.state.sources.map((s) => s.id)).toEqual(['a']);
		store.insertPages([newPageRef('b', 0)], 0);
		expect(store.state.sources.map((s) => s.id)).toEqual(['a', 'b']);
		checkInvariants(store);
	});
	it('validates', () => {
		const { store } = setup(2);
		expect(() => store.insertPages([newPageRef('zzz', 0)], 0)).toThrow();
		expect(() => store.insertPages([newPageRef('a', 5)], 0)).toThrow();
		const dup = { ...newPageRef('a', 0), id: store.state.pages[0].id };
		expect(() => store.insertPages([dup], 0)).toThrow();
		const r = newPageRef('a', 0);
		expect(() => store.insertPages([r, r], 0)).toThrow();
		expect(store.pageCount).toBe(2);
	});
	it('copies the refs it is given', () => {
		const { store } = setup(2);
		const r = newPageRef('a', 1);
		store.insertPages([r], 0);
		expect(store.state.pages[0]).not.toBe(r);
	});
});

describe('removePages', () => {
	it('removes, labels, and undoes', () => {
		const { store } = setup(4);
		const p = ids(store);
		expect(store.removePages([p[1], p[2], 'ghost'])).toBe(true);
		expect(names(store)).toEqual(['a0', 'a3']);
		expect(store.undoLabel).toBe('Delete 2 pages');
		store.undo();
		expect(names(store)).toEqual(['a0', 'a1', 'a2', 'a3']);
		expect(ids(store)).toEqual(p);
	});
	it('returns false for nothing to do', () => {
		const { store } = setup(2);
		expect(store.removePages(['x'])).toBe(false);
		expect(store.removePages([])).toBe(false);
	});
});

describe('rotatePages', () => {
	it('rotates modulo 360, both directions', () => {
		const { store } = setup(2);
		const [p0, p1] = ids(store);
		store.rotatePages([p0], 90);
		store.rotatePages([p0], 270);
		expect(store.state.pages[0].rotation).toBe(0);
		store.rotatePages([p1], -90);
		expect(store.state.pages[1].rotation).toBe(270);
		store.rotatePages([p1], 180);
		expect(store.state.pages[1].rotation).toBe(90);
	});
	it('only touches the given pages (identity preserved elsewhere)', () => {
		const { store } = setup(3);
		const before = [...store.state.pages];
		store.rotatePages([before[1].id], 90);
		expect(store.state.pages[0]).toBe(before[0]);
		expect(store.state.pages[1]).not.toBe(before[1]);
		expect(store.state.pages[2]).toBe(before[2]);
	});
	it('rejects non multiples of 90, ignores 360', () => {
		const { store } = setup(1);
		expect(() => store.rotatePages(ids(store), 45)).toThrow();
		expect(store.rotatePages(ids(store), 360)).toBe(false);
		expect(store.rotatePages(['x'], 90)).toBe(false);
	});
	it('label', () => {
		const { store } = setup(4);
		store.rotatePages(ids(store).slice(0, 3), 90);
		expect(store.undoLabel).toBe('Rotate 3 pages');
		store.rotatePages(ids(store).slice(0, 1), 90);
		expect(store.undoLabel).toBe('Rotate page');
	});
});

describe('duplicatePages', () => {
	it('puts each copy right after its original with new ids', () => {
		const { store } = setup(3);
		const p = ids(store);
		const created = store.duplicatePages([p[0], p[1]]);
		expect(names(store)).toEqual(['a0', 'a0', 'a1', 'a1', 'a2']);
		expect(ids(store)[0]).toBe(p[0]);
		expect(ids(store)[1]).toBe(created[0]);
		expect(ids(store)[2]).toBe(p[1]);
		expect(ids(store)[3]).toBe(created[1]);
		expect(new Set(ids(store)).size).toBe(5);
		expect(store.undoLabel).toBe('Duplicate 2 pages');
	});
	it('deep copies stamps with new ids', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		const sid = store.addStamp(p, { kind: 'mark', mark: 'check', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } });
		store.addStamp(p, { kind: 'text', text: 'hi', x: 0, y: 0, size: 0.02, color: 'black' });
		const [copy] = store.duplicatePages([p]);
		const [orig, dup] = store.state.pages;
		expect(dup.id).toBe(copy);
		expect(dup.stamps.length).toBe(2);
		expect(dup.stamps[0].id).not.toBe(sid);
		const stampIds = store.state.pages.flatMap((x) => x.stamps.map((s) => s.id));
		expect(new Set(stampIds).size).toBe(4);
		const a = orig.stamps[0] as { box: object };
		const b = dup.stamps[0] as { box: object };
		expect(b.box).toEqual(a.box);
		expect(b.box).not.toBe(a.box);
		store.updateStamp(copy, dup.stamps[0].id, { box: { x: 0.9, y: 0.9, w: 0.1, h: 0.1 } });
		expect((store.state.pages[0].stamps[0] as { box: { x: number } }).box.x).toBe(0.1);
	});
	it('returns [] for unknown ids', () => {
		const { store } = setup(1);
		expect(store.duplicatePages(['x'])).toEqual([]);
	});
});

describe('reverse and sort', () => {
	it('reverses all', () => {
		const { store } = setup(4);
		store.reversePages();
		expect(names(store)).toEqual(['a3', 'a2', 'a1', 'a0']);
		store.undo();
		expect(names(store)).toEqual(['a0', 'a1', 'a2', 'a3']);
	});
	it('reverses a subset in place within its slots', () => {
		const { store } = setup(5);
		const p = ids(store);
		store.reversePages([p[0], p[2], p[4]]);
		expect(names(store)).toEqual(['a4', 'a1', 'a2', 'a3', 'a0']);
	});
	it('no-ops for fewer than two pages', () => {
		const { store } = setup(1);
		expect(store.reversePages()).toBe(false);
	});
	it('sortBySource groups by source order, stable', () => {
		const { store } = setup(2, 2);
		const p = ids(store); // a0 a1 b0 b1
		store.movePages([p[0]], 4); // a1 b0 b1 a0
		store.movePages([p[2]], 0); // b0 a1 b1 a0
		expect(names(store)).toEqual(['b0', 'a1', 'b1', 'a0']);
		expect(store.sortBySource()).toBe(true);
		expect(names(store)).toEqual(['a1', 'a0', 'b0', 'b1']);
		expect(store.sortBySource()).toBe(false);
	});
});

describe('stamps and assets', () => {
	const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.1 };
	it('add / update / remove', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		const sid = store.addStamp(p, { kind: 'text', text: 'a', x: 0.1, y: 0.1, size: 0.02, color: 'red' });
		expect(store.undoLabel).toBe('Add stamp');
		expect(store.updateStamp(p, sid, { text: 'b', x: 0.5 })).toBe(true);
		const s = store.state.pages[0].stamps[0];
		expect(s).toMatchObject({ id: sid, kind: 'text', text: 'b', x: 0.5, color: 'red' });
		expect(store.updateStamp(p, sid, { text: 'b' })).toBe(false); // unchanged
		expect(store.updateStamp(p, sid, { box } as never)).toBe(false); // foreign key ignored
		expect(store.updateStamp(p, 'nope', { text: 'z' })).toBe(false);
		expect(store.removeStamp(p, sid)).toBe(true);
		expect(store.removeStamp(p, sid)).toBe(false);
		expect(store.state.pages[0].stamps).toEqual([]);
		store.undo();
		store.undo();
		expect((store.state.pages[0].stamps[0] as { text: string }).text).toBe('a');
	});
	it('only the stamped page changes identity', () => {
		const { store } = setup(3);
		const before = [...store.state.pages];
		store.addStamp(before[1].id, { kind: 'mark', mark: 'dot', box });
		expect(store.state.pages[0]).toBe(before[0]);
		expect(store.state.pages[2]).toBe(before[2]);
	});
	it('image stamps need an existing asset', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		expect(() => store.addStamp(p, { kind: 'image', assetId: 'sig', box })).toThrow();
		store.addAsset(makeAsset('sig'));
		store.addStamp(p, { kind: 'image', assetId: 'sig', box });
		expect(() => store.updateStamp(p, store.state.pages[0].stamps[0].id, { assetId: 'zzz' })).toThrow();
		expect(() => store.addStamp('ghost', { kind: 'mark', mark: 'dot', box })).toThrow();
	});
	it('duplicate asset ids are rejected', () => {
		const { store } = setup(1);
		store.addAsset(makeAsset('s'));
		expect(() => store.addAsset(makeAsset('s'))).toThrow();
	});
	it('removeAsset refuses when stamps use it, cascades on request, and is undoable', () => {
		const { store } = setup(2);
		const [p0, p1] = ids(store);
		store.addAsset(makeAsset('sig'));
		store.addStamp(p0, { kind: 'image', assetId: 'sig', box });
		store.addStamp(p1, { kind: 'image', assetId: 'sig', box });
		expect(store.assetUsage('sig')).toBe(2);
		expect(store.removeAsset('sig')).toBe(false);
		expect(store.state.assets.length).toBe(1);
		expect(store.removeAsset('sig', { cascade: true })).toBe(true);
		expect(store.state.assets).toEqual([]);
		expect(store.state.pages.every((p) => p.stamps.length === 0)).toBe(true);
		expect(store.undoLabel).toBe('Remove signature and 2 stamps');
		checkInvariants(store);
		store.undo();
		expect(store.assetUsage('sig')).toBe(2);
		checkInvariants(store);
	});
	it('removeAsset of an unused asset works without cascade', () => {
		const { store } = setup(1);
		store.addAsset(makeAsset('i', 'initials'));
		expect(store.removeAsset('i')).toBe(true);
		expect(store.removeAsset('i')).toBe(false);
	});
});

describe('clear and reset', () => {
	it('clear is undoable', () => {
		const { store } = setup(2, 1);
		store.addAsset(makeAsset('s'));
		const before = [...store.state.pages];
		expect(store.clear()).toBe(true);
		expect(store.pageCount).toBe(0);
		expect(store.state.sources).toEqual([]);
		expect(store.state.assets).toEqual([]);
		expect(store.clear()).toBe(false);
		store.undo();
		expect(store.state.pages).toEqual(before);
		expect(store.state.assets.length).toBe(1);
	});
	it('reset drops history and releases everything', () => {
		const { store, released } = setup(2, 1);
		store.reset();
		expect(store.canUndo).toBe(false);
		expect(store.pageCount).toBe(0);
		expect(released.sort()).toEqual(['a', 'b']);
	});
});

describe('selection', () => {
	it('select / toggle / clear', () => {
		const { store } = setup(4);
		const p = ids(store);
		store.select(p[1]);
		expect([...store.state.selection]).toEqual([p[1]]);
		store.toggle(p[2]);
		expect(store.state.selection.size).toBe(2);
		store.toggle(p[1]);
		expect([...store.state.selection]).toEqual([p[2]]);
		expect(store.state.anchor).toBe(p[1]);
		store.select('ghost');
		expect(store.state.selection.size).toBe(1);
		store.clearSelection();
		expect(store.state.selection.size).toBe(0);
		expect(store.state.anchor).toBeNull();
	});
	it('selectRange from the anchor, either direction, additive option', () => {
		const { store } = setup(6);
		const p = ids(store);
		store.select(p[1]);
		store.selectRange(p[3]);
		expect([...store.state.selection]).toEqual([p[1], p[2], p[3]]);
		store.selectRange(p[0]);
		expect([...store.state.selection]).toEqual([p[0], p[1]]);
		store.select(p[4]);
		store.selectRange(p[5], { additive: true });
		store.toggle(p[0]);
		store.selectRange(p[2], { additive: true });
		expect(new Set(store.state.selection)).toEqual(new Set([p[0], p[1], p[2], p[4], p[5]]));
	});
	it('selectRange without an anchor selects just the target', () => {
		const { store } = setup(3);
		store.selectRange(ids(store)[2]);
		expect(store.state.selection.size).toBe(1);
	});
	it('selectAll and setSelection', () => {
		const { store } = setup(3);
		store.selectAll();
		expect(store.state.selection.size).toBe(3);
		store.setSelection([ids(store)[0], 'ghost']);
		expect(store.state.selection.size).toBe(1);
	});
	it('selection is not an undo step and does not change dirty state', () => {
		const { store } = setup(2);
		store.markClean();
		store.selectAll();
		expect(store.undoLabel).toBe('Add a.pdf');
		expect(store.isDirty).toBe(false);
	});
	it('is pruned when pages are removed, and restored on undo', () => {
		const { store } = setup(4);
		const p = ids(store);
		store.setSelection([p[1], p[2]]);
		store.removePages([p[1]]);
		expect([...store.state.selection]).toEqual([p[2]]);
		store.undo();
		expect(new Set(store.state.selection)).toEqual(new Set([p[1], p[2]]));
		store.redo();
		expect([...store.state.selection]).toEqual([p[2]]);
	});
	it('anchor is dropped when its page is removed', () => {
		const { store } = setup(3);
		const p = ids(store);
		store.select(p[0]);
		store.removePages([p[0]]);
		expect(store.state.anchor).toBeNull();
	});
	it('undo of a selection-less command does not invent a selection', () => {
		const { store } = setup(3);
		store.rotatePages([ids(store)[0]], 90);
		store.select(ids(store)[2]);
		store.undo();
		expect(store.state.selection.size).toBe(0);
	});
	it('same selection keeps the Set identity', () => {
		const { store } = setup(3);
		store.select(ids(store)[0]);
		const s = store.state.selection;
		store.select(ids(store)[0]);
		expect(store.state.selection).toBe(s);
	});
});

describe('history', () => {
	it('labels for undo and redo and canUndo/canRedo', () => {
		const { store } = setup(3);
		expect(store.canRedo).toBe(false);
		store.rotatePages(ids(store), 90);
		expect(store.undoLabel).toBe('Rotate 3 pages');
		store.undo();
		expect(store.redoLabel).toBe('Rotate 3 pages');
		expect(store.undoLabel).toBe('Add a.pdf');
		expect(store.state.lastEvent).toEqual({ kind: 'undo', label: 'Rotate 3 pages' });
		store.redo();
		expect(store.state.lastEvent).toEqual({ kind: 'redo', label: 'Rotate 3 pages' });
		expect(store.canRedo).toBe(false);
	});
	it('a new command clears the redo stack', () => {
		const { store } = setup(3);
		store.rotatePages(ids(store), 90);
		store.undo();
		store.removePages([ids(store)[0]]);
		expect(store.canRedo).toBe(false);
		expect(store.redo()).toBe(false);
	});
	it('undo/redo at the ends return false', () => {
		const { store } = makeStore();
		expect(store.undo()).toBe(false);
		expect(store.redo()).toBe(false);
	});
	it('caps history', () => {
		const { store } = makeStore({ maxHistory: 5 });
		store.addSource(makeSource('a', 1));
		for (let i = 0; i < 20; i++) store.rotatePages(ids(store), 90);
		let n = 0;
		while (store.undo()) n++;
		expect(n).toBe(5);
	});
	it('default cap is 200', () => {
		const { store } = makeStore();
		store.addSource(makeSource('a', 1));
		for (let i = 0; i < 250; i++) store.rotatePages(ids(store), 90);
		let n = 0;
		while (store.undo()) n++;
		expect(n).toBe(200);
	});
	it('isDirty follows the document, undo back to clean', () => {
		const { store } = makeStore();
		expect(store.isDirty).toBe(false);
		store.addSource(makeSource('a', 2));
		expect(store.isDirty).toBe(true);
		store.markClean();
		expect(store.isDirty).toBe(false);
		store.rotatePages(ids(store), 90);
		expect(store.isDirty).toBe(true);
		store.undo();
		expect(store.isDirty).toBe(false);
		store.undo();
		expect(store.isDirty).toBe(true);
	});
});

describe('gestures and transactions', () => {
	const box = { x: 0.1, y: 0.1, w: 0.2, h: 0.2 };
	it('a gesture of many updates is one undo step', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		const sid = store.addStamp(p, { kind: 'mark', mark: 'dot', box });
		store.beginGesture('Move stamp');
		for (let i = 1; i <= 100; i++) store.updateStamp(p, sid, { box: { ...box, x: i / 200 } });
		expect(store.gestureActive).toBe(true);
		expect((store.state.pages[0].stamps[0] as { box: { x: number } }).box.x).toBe(0.5);
		store.commitGesture();
		expect(store.undoLabel).toBe('Move stamp');
		store.undo();
		expect(store.undoLabel).toBe('Add stamp');
		expect((store.state.pages[0].stamps[0] as { box: { x: number } }).box.x).toBe(0.1);
		store.redo();
		expect((store.state.pages[0].stamps[0] as { box: { x: number } }).box.x).toBe(0.5);
	});
	it('listeners see live gesture updates', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		const sid = store.addStamp(p, { kind: 'mark', mark: 'dot', box });
		let calls = 0;
		store.subscribe(() => calls++);
		store.beginGesture('Move');
		store.updateStamp(p, sid, { box: { ...box, x: 0.4 } });
		store.updateStamp(p, sid, { box: { ...box, x: 0.5 } });
		expect(calls).toBeGreaterThanOrEqual(2);
	});
	it('cancelGesture restores the start and records nothing', () => {
		const { store } = setup(1);
		const p = ids(store)[0];
		const sid = store.addStamp(p, { kind: 'mark', mark: 'dot', box });
		const before = store.state.pages[0];
		store.beginGesture('Move');
		store.updateStamp(p, sid, { box: { ...box, x: 0.9 } });
		store.cancelGesture();
		expect(store.state.pages[0]).toBe(before);
		expect(store.undoLabel).toBe('Add stamp');
		expect(store.gestureActive).toBe(false);
	});
	it('an empty gesture records nothing; undo/redo are blocked during one', () => {
		const { store } = setup(1);
		store.beginGesture('Nothing');
		expect(store.canUndo).toBe(false);
		expect(store.undo()).toBe(false);
		expect(() => store.beginGesture('again')).toThrow();
		store.commitGesture();
		expect(store.undoLabel).toBe('Add a.pdf');
	});
	it('transaction groups commands into one step, notifying once', () => {
		const { store } = setup(3);
		let calls = 0;
		store.subscribe(() => calls++);
		const out = store.transaction('Tidy up', () => {
			store.rotatePages(ids(store), 90);
			store.removePages([ids(store)[0]]);
			store.reversePages();
			return 42;
		});
		expect(out).toBe(42);
		expect(calls).toBe(1);
		expect(store.undoLabel).toBe('Tidy up');
		store.undo();
		expect(names(store)).toEqual(['a0', 'a1', 'a2']);
		expect(store.state.pages.every((p) => p.rotation === 0)).toBe(true);
		expect(store.undoLabel).toBe('Add a.pdf');
	});
	it('transaction rolls back on throw', () => {
		const { store } = setup(3);
		const before = store.state.pages;
		expect(() =>
			store.transaction('boom', () => {
				store.removePages([ids(store)[0]]);
				throw new Error('x');
			})
		).toThrow('x');
		expect(store.state.pages).toBe(before);
		expect(store.undoLabel).toBe('Add a.pdf');
		expect(store.gestureActive).toBe(false);
	});
	it('nested transactions merge into the outer step', () => {
		const { store } = setup(3);
		store.transaction('outer', () => {
			store.transaction('inner', () => store.rotatePages(ids(store), 90));
			store.removePages([ids(store)[0]]);
		});
		expect(store.undoLabel).toBe('outer');
		store.undo();
		expect(store.undoLabel).toBe('Add a.pdf');
	});
	it('a transaction that changes nothing records nothing', () => {
		const { store } = setup(1);
		store.transaction('noop', () => store.removePages(['ghost']));
		expect(store.undoLabel).toBe('Add a.pdf');
	});
});

describe('source garbage collection', () => {
	it('keeps an emptied source while history references it, then releases it', () => {
		const { store, released } = setup(1, 2);
		store.removePages(store.state.pages.filter((p) => p.sourceId === 'b').map((p) => p.id));
		expect(store.state.sources.map((s) => s.id)).toEqual(['a']);
		expect(released).toEqual([]); // undo can bring it back
		store.undo();
		expect(store.state.sources.map((s) => s.id)).toEqual(['a', 'b']);
		store.redo();
		expect(released).toEqual([]);
	});
	it('releases when the redo stack is discarded by a new command', () => {
		const { store, released } = setup(1);
		store.addSource(makeSource('b', 1));
		store.undo(); // b only in redo entry
		expect(released).toEqual([]);
		store.rotatePages(ids(store), 90); // drops redo
		expect(released).toEqual(['b']);
	});
	it('releases when the history cap evicts the last reference', () => {
		const { store, released } = makeStore({ maxHistory: 3 });
		store.addSource(makeSource('a', 1));
		store.addSource(makeSource('b', 1));
		store.removePages([store.state.pages[1].id]); // b emptied; entries: addA, addB, remove
		expect(released).toEqual([]);
		store.rotatePages(ids(store), 90); // evicts addA
		expect(released).toEqual([]);
		store.rotatePages(ids(store), 90); // evicts addB; remaining entries: remove, rot, rot
		// "remove" still references b in its before-doc
		expect(released).toEqual([]);
		store.rotatePages(ids(store), 90); // evicts remove -> b gone
		expect(released).toEqual(['b']);
	});
	it('a source that is still in the document is never released', () => {
		const { store, released } = makeStore({ maxHistory: 1 });
		store.addSource(makeSource('a', 2));
		for (let i = 0; i < 5; i++) store.rotatePages(ids(store), 90);
		expect(released).toEqual([]);
	});
	it('each source is released exactly once', () => {
		const { store, released } = makeStore({ maxHistory: 2 });
		store.addSource(makeSource('a', 1));
		store.removePages(ids(store));
		store.addSource(makeSource('b', 1));
		store.removePages(ids(store));
		for (let i = 0; i < 3; i++) {
			store.addSource(makeSource(`c${i}`, 1));
			store.removePages(ids(store));
		}
		const count = new Map<string, number>();
		for (const r of released) count.set(r, (count.get(r) ?? 0) + 1);
		expect([...count.values()].every((n) => n === 1)).toBe(true);
		expect(released).toContain('a');
		expect(released).toContain('b');
	});
	it('clear keeps sources for undo; later eviction releases', () => {
		const { store, released } = setup(2);
		store.clear();
		expect(released).toEqual([]);
		store.undo();
		expect(store.pageCount).toBe(2);
		store.clear();
		store.addSource(makeSource('z', 1)); // drops nothing (redo empty)
		expect(released).toEqual([]);
	});
	it('gesture rollback releases sources added inside it', () => {
		const { store, released } = setup(1);
		expect(() =>
			store.transaction('x', () => {
				store.addSource(makeSource('t', 1));
				throw new Error('no');
			})
		).toThrow();
		expect(released).toEqual(['t']);
	});
	it('a throwing callback does not break the store', () => {
		const { store } = makeStore({
			onSourceReleased: () => {
				throw new Error('renderer exploded');
			}
		});
		store.addSource(makeSource('a', 1));
		store.addSource(makeSource('b', 1));
		store.undo();
		store.rotatePages(ids(store), 90);
		expect(store.pageCount).toBe(1);
	});
	it('sourceOf and displayedSize still work for stale refs until release', () => {
		const { store } = setup(1);
		const ref = store.state.pages[0];
		expect(store.sourceOf(ref.id)?.id).toBe('a');
		store.removePages([ref.id]);
		expect(store.sourceOf(ref.id)).toBeUndefined();
		expect(store.displayedSize(ref)).toEqual({ width: 600, height: 800 });
	});
});

describe('derived helpers', () => {
	it('pageCount, totalOriginalBytes', () => {
		const { store } = setup(2, 3);
		expect(store.pageCount).toBe(5);
		expect(store.totalOriginalBytes).toBe(2000);
	});
	it('displayedSize swaps for 90/270', () => {
		const { store } = setup(2);
		const p = store.state.pages[1]; // width 601
		expect(store.displayedSize(p)).toEqual({ width: 601, height: 800 });
		store.rotatePages([p.id], 90);
		expect(store.displayedSize(store.state.pages[1])).toEqual({ width: 800, height: 601 });
		store.rotatePages([p.id], 180);
		expect(store.displayedSize(store.state.pages[1])).toEqual({ width: 800, height: 601 });
		store.rotatePages([p.id], 90);
		expect(store.displayedSize(store.state.pages[1])).toEqual({ width: 601, height: 800 });
		expect(store.displayedSize({ ...p, sourceId: 'ghost' })).toBeUndefined();
	});
	it('toExportPlan: all, given ids in document order, empty', () => {
		const { store } = setup(4);
		const p = ids(store);
		expect(store.toExportPlan(exportOptions).pages.length).toBe(4);
		const plan = store.toExportPlan(exportOptions, [p[3], p[1], 'ghost']);
		expect(plan.pages.map((x) => x.id)).toEqual([p[1], p[3]]);
		expect(plan.options).toEqual(exportOptions);
		expect(plan.options).not.toBe(exportOptions);
		store.selectAll();
		store.toggle(p[0]);
		expect(store.toExportPlan(exportOptions, store.state.selection).pages.length).toBe(3);
		expect(store.toExportPlan(exportOptions, []).pages).toEqual([]);
	});
	it('plan pages are a copy of the array', () => {
		const { store } = setup(2);
		const plan = store.toExportPlan(exportOptions);
		plan.pages.pop();
		expect(store.pageCount).toBe(2);
	});
});

describe('snapshots and subscription', () => {
	it('every change gives a new frozen snapshot; unchanged parts are shared', () => {
		const { store } = setup(2);
		const s1 = store.state;
		store.rotatePages([ids(store)[0]], 90);
		const s2 = store.state;
		expect(s2).not.toBe(s1);
		expect(s2.sources).toBe(s1.sources);
		expect(s2.assets).toBe(s1.assets);
		expect(s2.pages[1]).toBe(s1.pages[1]);
		expect(Object.isFrozen(s2)).toBe(true);
	});
	it('no-op commands do not notify or allocate', () => {
		const { store } = setup(2);
		let calls = 0;
		store.subscribe(() => calls++);
		const s = store.state;
		store.removePages(['ghost']);
		store.rotatePages(ids(store), 0);
		store.movePages(ids(store), 0);
		expect(calls).toBe(0);
		expect(store.state).toBe(s);
	});
	it('subscribe/unsubscribe', () => {
		const { store } = setup(2);
		const seen: number[] = [];
		const off = store.subscribe((s) => seen.push(s.pages.length));
		store.removePages([ids(store)[0]]);
		off();
		store.removePages([ids(store)[0]]);
		expect(seen).toEqual([1]);
	});
});

describe('ids', () => {
	it('are short and unique', () => {
		const s = new Set(Array.from({ length: 5000 }, () => newId()));
		expect(s.size).toBe(5000);
		expect([...s][0].length).toBeLessThanOrEqual(16);
	});
	it('store survives a generator that repeats ids', () => {
		let i = 0;
		const { store } = makeStore({ generateId: () => `x${Math.floor(i++ / 2)}` });
		store.addSource(makeSource('a', 4));
		expect(new Set(ids(store)).size).toBe(4);
	});
});

describe('history tokens', () => {
	it('identify the next undo and redo step, so a session can scope its history', () => {
		const { store } = setup(3);
		const [p0] = ids(store);
		const mark = store.undoToken;
		expect(mark).not.toBeNull();
		expect(store.redoToken).toBeNull();
		store.rotatePages([p0], 90);
		expect(store.undoToken).not.toBe(mark);
		store.undo();
		expect(store.undoToken).toBe(mark);
		expect(store.redoToken).not.toBeNull();
		const redoMark = store.redoToken;
		store.redo();
		expect(store.redoToken).toBeNull();
		store.undo();
		expect(store.redoToken).toBe(redoMark);
	});
});
