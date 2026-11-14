/** Crop in the store: marks move to the new visible part, a crop never hides a mark, undo, rotation, sizes. */
import { describe, expect, it } from 'vitest';
import type { Stamp, StampBox } from '../../src/lib/core/types';
import { reframeBox, reframeStamp, textExtent } from '../../src/lib/doc/crop';
import { makeAsset, makeSource, makeStore } from './helpers';

/** A 600 x 800 page (portrait). */
function setup(stamps: Stamp[] = [], pages = 1) {
	const { store } = makeStore();
	store.addSource(makeSource('a', pages));
	store.addAsset(makeAsset('sig'));
	const page = store.state.pages[0];
	for (const s of stamps) {
		const { id: _id, ...rest } = s;
		store.addStamp(page.id, { ...rest, id: s.id } as never);
	}
	return { store, id: page.id };
}
const pageOf = (store: ReturnType<typeof makeStore>['store'], id: string) => store.state.pages.find((p) => p.id === id)!;
const C: StampBox = { x: 0.1, y: 0.2, w: 0.5, h: 0.6 };
const close = (a: StampBox, b: StampBox) => ['x', 'y', 'w', 'h'].forEach((k) => expect(a[k as keyof StampBox]).toBeCloseTo(b[k as keyof StampBox], 9));

describe('crop in the store', () => {
	it('crops, moves marks into the visible part, sizes follow; undo and redo', () => {
		const red: Stamp = { id: 'r', kind: 'redact', box: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 } };
		const txt: Stamp = { id: 't', kind: 'text', text: 'Hi', x: 0.3, y: 0.5, size: 0.02, color: 'black' };
		const pen: Stamp = { id: 'p', kind: 'highlight', color: 'yellow', box: { x: 0.2, y: 0.4, w: 0.2, h: 0.1 }, pen: { width: 0.01, points: [{ x: 0.21, y: 0.41 }, { x: 0.39, y: 0.49 }] } };
		const { store, id } = setup([red, txt, pen]);
		expect(store.displayedSize(pageOf(store, id))).toEqual({ width: 600, height: 800 });
		expect(store.cropPages([id], C)).toEqual({ cropped: [id], blocked: [] });
		const p = pageOf(store, id);
		expect(p.crop).toEqual(C);
		expect(store.displayedSize(p)).toEqual({ width: 300, height: 480 });
		close((p.stamps[0] as { box: StampBox }).box, { x: (0.2 - 0.1) / 0.5, y: (0.3 - 0.2) / 0.6, w: 0.4, h: 0.1 / 0.6 });
		const t = p.stamps[1] as Extract<Stamp, { kind: 'text' }>;
		expect(t.x).toBeCloseTo(0.4, 9);
		expect(t.y).toBeCloseTo(0.5, 9);
		// Same size in points: a share of a shorter page.
		expect(t.size * 480).toBeCloseTo(0.02 * 800, 9);
		const h = p.stamps[2] as Extract<Stamp, { kind: 'highlight' }>;
		expect(h.pen!.width * 480).toBeCloseTo(0.01 * 800, 9);
		expect(h.pen!.points[0].x).toBeCloseTo((0.21 - 0.1) / 0.5, 9);
		expect(store.state.undoLabel).toBe('Crop page');
		// Re-crop from a cropped page: marks keep their place on the page.
		store.cropPages([id], { x: 0, y: 0, w: 0.8, h: 0.9 });
		close((pageOf(store, id).stamps[0] as { box: StampBox }).box, { x: 0.2 / 0.8, y: 0.3 / 0.9, w: 0.2 / 0.8, h: 0.1 / 0.9 });
		// Reset: back to the whole page, marks where they started.
		store.cropPages([id], null);
		expect(pageOf(store, id).crop).toBeUndefined();
		close((pageOf(store, id).stamps[0] as { box: StampBox }).box, red.box);
		expect(store.state.undoLabel).toBe('Reset crop');
		store.undo();
		expect(pageOf(store, id).crop).toEqual({ x: 0, y: 0, w: 0.8, h: 0.9 });
		store.undo();
		store.undo();
		expect(pageOf(store, id).crop).toBeUndefined();
		close((pageOf(store, id).stamps[0] as { box: StampBox }).box, red.box);
		store.redo();
		expect(pageOf(store, id).crop).toEqual(C);
	});

	it('never hides a mark: those pages are left as they were and listed', () => {
		const { store } = makeStore();
		store.addSource(makeSource('a', 3));
		const [a, b, c] = store.state.pages.map((p) => p.id);
		store.addStamp(b, { kind: 'redact', box: { x: 0.85, y: 0.1, w: 0.1, h: 0.05 } });
		store.addStamp(c, { kind: 'text', text: 'A long line of text here', x: 0.5, y: 0.5, size: 0.03, color: 'black' });
		expect(store.cropPages([a, b, c], C)).toEqual({ cropped: [a], blocked: [b, c] });
		expect(pageOf(store, b).crop).toBeUndefined();
		expect(store.state.undoLabel).toBe('Crop 3 pages');
		// Nothing to change: no step.
		const before = store.state.undoLabel;
		expect(store.cropPages([a], C)).toEqual({ cropped: [], blocked: [] });
		expect(store.state.undoLabel).toBe(before);
	});

	it('refuses bad crops; the whole page means no crop', () => {
		const { store, id } = setup();
		expect(() => store.cropPages([id], { x: 0, y: 0, w: 0.01, h: 1 })).toThrow();
		expect(() => store.cropPages([id], { x: 0.5, y: 0, w: 0.6, h: 1 })).toThrow();
		store.cropPages([id], { x: 0, y: 0, w: 1, h: 1 });
		expect(pageOf(store, id).crop).toBeUndefined();
	});

	it('turns with the page: marks and crop, four turns back to the start', () => {
		const red: Stamp = { id: 'r', kind: 'redact', box: { x: 0.2, y: 0.3, w: 0.2, h: 0.1 } };
		const txt: Stamp = { id: 't', kind: 'text', text: 'Hi', x: 0.3, y: 0.5, size: 0.02, color: 'black' };
		const { store, id } = setup([red, txt]);
		store.cropPages([id], C);
		const start = pageOf(store, id);
		store.rotatePages([id], 90);
		const one = pageOf(store, id);
		expect(one.crop).toEqual({ x: 1 - (C.y + C.h), y: C.x, w: C.h, h: C.w });
		// Shown size: 800 x 600 turned, cropped: 0.6·800 by 0.5·600.
		expect(store.displayedSize(one)!.width).toBeCloseTo(480, 9);
		expect(store.displayedSize(one)!.height).toBeCloseTo(300, 9);
		// The text keeps its size in points (a share of the turned, cropped page's height).
		const t1 = one.stamps[1] as Extract<Stamp, { kind: 'text' }>;
		const t0 = start.stamps[1] as Extract<Stamp, { kind: 'text' }>;
		expect(t1.size * 300).toBeCloseTo(t0.size * 480, 9);
		store.rotatePages([id], 270);
		const back = pageOf(store, id);
		close(back.crop!, C);
		close((back.stamps[0] as { box: StampBox }).box, (start.stamps[0] as { box: StampBox }).box);
	});

	it('duplicates and copies carry the crop', () => {
		const { store, id } = setup();
		store.cropPages([id], C);
		const [copy] = store.duplicatePages([id]);
		expect(pageOf(store, copy).crop).toEqual(C);
	});
});

describe('reframing', () => {
	it('boxes go there and back exactly; text reach estimate turns with the text', () => {
		const b = { x: 0.3, y: 0.4, w: 0.1, h: 0.2 };
		close(reframeBox(reframeBox(b, undefined, C), C, undefined), b);
		const t: Extract<Stamp, { kind: 'text' }> = { id: 't', kind: 'text', text: 'abcd', x: 0.5, y: 0.5, size: 0.1, color: 'black' };
		const e0 = textExtent(t, 1);
		expect(e0.w).toBeCloseTo(0.2, 9);
		const e90 = textExtent({ ...t, turn: 90 }, 1);
		expect(e90.h).toBeCloseTo(0.2, 9);
		expect(e90.x + e90.w).toBeCloseTo(0.5, 9);
		// A link to a blank that would leave the page is dropped; the stamp stays.
		const linked: Stamp = { id: 'm', kind: 'mark', mark: 'check', box: { x: 0.3, y: 0.3, w: 0.02, h: 0.02 }, blank: { kind: 'check', box: { x: 0.05, y: 0.3, w: 0.3, h: 0.02 } } };
		const moved = reframeStamp(linked, undefined, C, 0.75)!;
		expect(moved).not.toBeNull();
		expect('blank' in moved).toBe(false);
	});
});
