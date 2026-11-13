/** Rotating a page turns every mark with it: same content covered, same look, four turns = start. */
import { describe, expect, it } from 'vitest';
import type { PageRef, Stamp } from '../../src/lib/core/types';
import { makeAsset, makeSource, makeStore } from './helpers';

/** A 600 x 800 page (portrait). */
function setup(stamps: Stamp[]) {
	const { store } = makeStore();
	store.addSource(makeSource('a', 1));
	store.addAsset(makeAsset('sig'));
	const page = store.state.pages[0];
	for (const s of stamps) {
		const { id: _id, ...rest } = s;
		store.addStamp(page.id, { ...rest, id: s.id } as never);
	}
	return { store, id: page.id };
}

const stampsOf = (store: ReturnType<typeof makeStore>['store'], id: string) =>
	store.state.pages.find((p) => p.id === id)!.stamps;
const byId = (list: readonly Stamp[], id: string) => list.find((s) => s.id === id)!;

// Page 600 x 800 points; a point (fx, fy) is at (600 fx, 800 fy). Turned 90 clockwise the page is
// 800 x 600 and the point (fx, fy) is at (800 (1 - fy), 600 fx).
const ASPECT = 600 / 800;

const ALL: Stamp[] = [
	{ id: 'red', kind: 'redact', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.05 } },
	{ id: 'hl', kind: 'highlight', color: 'yellow', box: { x: 0.5, y: 0.6, w: 0.2, h: 0.1 } },
	{
		id: 'pen',
		kind: 'highlight',
		color: 'green',
		box: { x: 0.2, y: 0.3, w: 0.4, h: 0.2 },
		pen: { width: 0.01, points: [{ x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 }] }
	},
	{
		id: 'txt',
		kind: 'highlight',
		color: 'pink',
		box: { x: 0.1, y: 0.1, w: 0.5, h: 0.12 },
		rects: [{ x: 0.1, y: 0.1, w: 0.5, h: 0.05 }, { x: 0.1, y: 0.17, w: 0.3, h: 0.05 }]
	},
	{ id: 'img', kind: 'image', assetId: 'sig', box: { x: 0.3, y: 0.7, w: 0.25, h: 0.1 } },
	{ id: 'text', kind: 'text', text: 'Hello', x: 0.15, y: 0.4, size: 0.02, color: 'blue' },
	{ id: 'chk', kind: 'mark', mark: 'check', box: { x: 0.6, y: 0.1, w: 0.04, h: 0.03 } },
	{ id: 'crs', kind: 'mark', mark: 'cross', box: { x: 0.7, y: 0.8, w: 0.04, h: 0.03 } },
	{ id: 'dot', kind: 'mark', mark: 'dot', box: { x: 0.8, y: 0.9, w: 0.04, h: 0.03 } }
];

const close = (a: number, b: number) => expect(a).toBeCloseTo(b, 12);

describe('marks turn with their page', () => {
	it('a redaction, a highlight and its rectangles cover the same page content', () => {
		const { store, id } = setup(ALL);
		store.rotatePages([id], 90);
		const out = stampsOf(store, id);
		// Redaction corners: (0.1, 0.2) and (0.4, 0.25) -> (1 - y, x).
		const r = byId(out, 'red') as Extract<Stamp, { kind: 'redact' }>;
		close(r.box.x, 1 - 0.25);
		close(r.box.y, 0.1);
		close(r.box.w, 0.05);
		close(r.box.h, 0.3);
		const t = byId(out, 'txt') as Extract<Stamp, { kind: 'highlight' }>;
		close(t.rects![1].x, 1 - (0.17 + 0.05));
		close(t.rects![1].y, 0.1);
		close(t.rects![1].w, 0.05);
		close(t.rects![1].h, 0.3);
		expect(t.rects!.every((q) => q.x >= t.box.x - 1e-12 && q.y >= t.box.y - 1e-12 && q.x + q.w <= t.box.x + t.box.w + 1e-12 && q.y + q.h <= t.box.y + t.box.h + 1e-12)).toBe(true);
		// Same real size of the redaction: 0.3 * 600 pt wide before, now 0.3 of the 600 pt height.
		close(r.box.h * 600, 0.3 * 600);
		close(r.box.w * 800, 0.05 * 800);
	});

	it('a pen stroke keeps its real width and path', () => {
		const { store, id } = setup(ALL);
		store.rotatePages([id], 90);
		const pen = (byId(stampsOf(store, id), 'pen') as Extract<Stamp, { kind: 'highlight' }>).pen!;
		close(pen.width * 600, 0.01 * 800);
		close(pen.points[0].x, 1 - 0.3);
		close(pen.points[0].y, 0.2);
	});

	it('text keeps its corner, its real size and gets turned', () => {
		const { store, id } = setup(ALL);
		store.rotatePages([id], 90);
		const t = byId(stampsOf(store, id), 'text') as Extract<Stamp, { kind: 'text' }>;
		close(t.x, 1 - 0.4);
		close(t.y, 0.15);
		close(t.size * 600, 0.02 * 800);
		expect(t.turn).toBe(90);
		store.rotatePages([id], -90);
		expect((byId(stampsOf(store, id), 'text') as Extract<Stamp, { kind: 'text' }>).turn).toBeUndefined();
	});

	it('pictures and checks turn; crosses and dots only move', () => {
		const { store, id } = setup(ALL);
		store.rotatePages([id], 90);
		const out = stampsOf(store, id);
		expect((byId(out, 'img') as Extract<Stamp, { kind: 'image' }>).turn).toBe(90);
		expect((byId(out, 'chk') as Extract<Stamp, { kind: 'mark' }>).turn).toBe(90);
		expect((byId(out, 'crs') as Extract<Stamp, { kind: 'mark' }>).turn).toBeUndefined();
		expect((byId(out, 'dot') as Extract<Stamp, { kind: 'mark' }>).turn).toBeUndefined();
		const img = (byId(out, 'img') as Extract<Stamp, { kind: 'image' }>).box;
		// Real size is kept: 0.25 * 600 pt wide, 0.1 * 800 pt tall -> 80 x 150 on the turned page (800 x 600 pt).
		close(img.w * 800, 0.1 * 800);
		close(img.h * 600, 0.25 * 600);
	});

	it('180 and 270 in one step equal that many quarter turns', () => {
		const a = setup(ALL);
		const b = setup(ALL);
		a.store.rotatePages([a.id], 180);
		b.store.rotatePages([b.id], 90);
		b.store.rotatePages([b.id], 90);
		expect(stampsOf(a.store, a.id)).toEqual(stampsOf(b.store, b.id));
		a.store.rotatePages([a.id], 90);
		b.store.rotatePages([b.id], 90);
		expect(stampsOf(a.store, a.id)).toEqual(stampsOf(b.store, b.id));
		a.store.rotatePages([a.id], -90);
		b.store.rotatePages([b.id], 270);
		expect(stampsOf(a.store, a.id)).toEqual(stampsOf(b.store, b.id));
		void ASPECT;
	});

	it('four turns bring every mark back to where it started', () => {
		const { store, id } = setup(ALL);
		for (let i = 0; i < 4; i++) store.rotatePages([id], 90);
		const back = stampsOf(store, id);
		expect(store.state.pages[0].rotation).toBe(0);
		for (const s of ALL) {
			const t = byId(back, s.id) as Record<string, unknown>;
			expect(t.turn).toBeUndefined();
			const o = s as Record<string, unknown>;
			const num = (a: unknown, b: unknown) => {
				if (typeof a === 'number') close(a as number, b as number);
				else if (Array.isArray(a)) a.forEach((v, i) => num(v, (b as unknown[])[i]));
				else if (a && typeof a === 'object') for (const k of Object.keys(a)) num((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]);
				else expect(b).toEqual(a);
			};
			num(o, t);
		}
	});

	it('undo and redo restore the marks exactly', () => {
		const { store, id } = setup(ALL);
		const before = structuredClone(stampsOf(store, id));
		store.rotatePages([id], 90);
		const after = structuredClone(stampsOf(store, id));
		expect(after).not.toEqual(before);
		store.undo();
		expect(stampsOf(store, id)).toEqual(before);
		store.redo();
		expect(stampsOf(store, id)).toEqual(after);
	});

	it('a turned page keeps turned marks valid and links to blanks go', () => {
		const { store, id } = setup([
			{ id: 'b', kind: 'text', text: 'x', x: 0.2, y: 0.2, size: 0.02, color: 'black', blank: { kind: 'text', box: { x: 0.1, y: 0.2, w: 0.3, h: 0.03 } } }
		]);
		store.rotatePages([id], 90);
		const s = stampsOf(store, id)[0] as Extract<Stamp, { kind: 'text' }>;
		expect(s.blank).toBeUndefined();
		expect(s.turn).toBe(90);
		// A turned stamp cannot be linked to a blank afterwards either: a new stamp is refused outright.
		expect(() =>
			store.addStamp(id, { kind: 'text', text: 'y', x: 0.1, y: 0.1, size: 0.02, color: 'black', turn: 90, blank: { kind: 'text', box: { x: 0, y: 0, w: 0.1, h: 0.1 } } })
		).toThrow();
	});

	it('only the rotated pages turn', () => {
		const { store } = makeStore();
		store.addSource(makeSource('a', 2));
		const [p0, p1] = store.state.pages as PageRef[];
		store.addStamp(p0.id, { kind: 'redact', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } });
		store.addStamp(p1.id, { kind: 'redact', box: { x: 0.1, y: 0.1, w: 0.1, h: 0.1 } });
		store.rotatePages([p0.id], 90);
		expect(store.state.pages[1].stamps[0]).toMatchObject({ box: { x: 0.1, y: 0.1 } });
		expect(store.state.pages[0].stamps[0]).toMatchObject({ box: { x: 0.8 } });
	});
});
