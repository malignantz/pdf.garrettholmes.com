/**
 * Turning a page's marks with it. A quarter turn clockwise of a page whose displayed
 * width / height is `aspect` maps the point (x, y) (fractions, origin top-left) to
 * (1 - y, x) and a box to the box of its four corners. Sizes given as a fraction of the
 * page height (text size, pen width) keep their real size: they are divided by `aspect`,
 * because the turned page is as tall as the old one was wide. Text, pictures and check
 * marks also get `turn` (see Stamp in core/types.ts). Pure; no store.
 */
import type { PenStroke, Rotation, Stamp, StampBox } from '../core/types';

function turnBox(b: StampBox): StampBox {
	return { x: 1 - (b.y + b.h), y: b.x, w: b.h, h: b.w };
}

function addTurn(t: Rotation | undefined): Rotation | undefined {
	const n = (((t ?? 0) + 90) % 360) as Rotation;
	return n === 0 ? undefined : n;
}

function withTurn<T extends Stamp>(s: T, turn: Rotation | undefined): T {
	const { turn: _old, ...rest } = s as T & { turn?: Rotation };
	return (turn === undefined ? rest : { ...rest, turn }) as T;
}

function turnPen(p: PenStroke, aspect: number): PenStroke {
	return { width: p.width / aspect, points: p.points.map((q) => ({ x: 1 - q.y, y: q.x })) };
}

/** One stamp after its page is turned a quarter clockwise. Links to blanks are dropped. */
export function turnStamp(s: Stamp, aspect: number): Stamp {
	switch (s.kind) {
		case 'redact':
			return { ...s, box: turnBox(s.box) };
		case 'highlight': {
			const h = { ...s, box: turnBox(s.box) };
			if (s.pen) h.pen = turnPen(s.pen, aspect);
			if (s.rects) h.rects = s.rects.map(turnBox);
			return h;
		}
		case 'image':
			return withTurn({ ...s, box: turnBox(s.box) }, addTurn(s.turn));
		case 'mark': {
			const { blank: _blank, ...rest } = s;
			// A cross and a dot look the same turned; only the box turns.
			const next = { ...rest, box: turnBox(s.box) };
			return s.mark === 'check' ? withTurn(next, addTurn(s.turn)) : next;
		}
		case 'text': {
			const { blank: _blank, ...rest } = s;
			return withTurn({ ...rest, x: 1 - s.y, y: s.x, size: s.size / aspect }, addTurn(s.turn));
		}
	}
}
