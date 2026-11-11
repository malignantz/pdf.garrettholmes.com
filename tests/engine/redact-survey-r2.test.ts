/**
 * Redaction fixes from the second survey round (2026-11-11), each with a generated file
 * that has the trait of the real one:
 * - a very large map page ran out of memory: refused up front by a size guard;
 */

import { describe, expect, it } from 'vitest';
import type { Source, Stamp, StampBox } from '../../src/lib/core/types';
import { EngineError } from '../../src/lib/engine/errors';
import { MAX_REDACT_CONTENT_BYTES } from '../../src/lib/engine/redact';
import { densePage } from '../corpus/generate-redact.mjs';
import { defaultOptions, engine, pageTexts, ref } from './helpers';

const T = 180_000;

/** A user-space rect [x0 y0 x1 y1] grown by `pad` pt, as a fraction of a 612×792 page. */
function frac([x0, y0, x1, y1]: number[], w = 612, h = 792, pad = 1): StampBox {
	return { x: (x0 - pad) / w, y: (h - y1 - pad) / h, w: (x1 - x0 + 2 * pad) / w, h: (y1 - y0 + 2 * pad) / h };
}
let sid = 0;
const redact = (box: StampBox): Stamp => ({ id: `r${sid++}`, kind: 'redact', box });

async function exportRedacted(src: Source, boxes: StampBox[], pageIndex = 0) {
	const pages = src.pages.map((_, i) => ref(src, i, 0, i === pageIndex ? boxes.map(redact) : []));
	return engine().exportPlan({ pages, options: defaultOptions }, [src], []);
}

async function refusal(p: Promise<unknown>): Promise<EngineError> {
	try {
		await p;
	} catch (e) {
		expect(e).toBeInstanceOf(EngineError);
		return e as EngineError;
	}
	throw new Error('expected a refusal');
}

describe('redaction: page size guard (survey: a 79 MB USGS map page ran out of memory)', () => {
	it('refuses a page with more drawing instructions than the limit, quickly and plainly', async () => {
		const mb = MAX_REDACT_CONTENT_BYTES / 1024 / 1024;
		for (const inForm of [false, true]) {
			const { bytes, line } = densePage(mb + 1, { inForm });
			const src = await engine().openPdf(bytes, 'dense.pdf');
			const t0 = Date.now();
			const err = await refusal(exportRedacted(src, [frac(line)]));
			expect(err.code).toBe('too-large');
			expect(err.message).toMatch(/^Page 1 is too detailed to redact on this device/);
			// Refused before the heavy work (which takes about a minute at this size).
			expect(Date.now() - t0).toBeLessThan(20_000);
		}
	}, T);

	it('still redacts a dense page under the limit', async () => {
		const { bytes, line } = densePage(2);
		const src = await engine().openPdf(bytes, 'dense.pdf');
		const res = await exportRedacted(src, [frac(line)]);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect((await pageTexts(res.bytes))[0]).not.toContain('SECRET-DENSE-LINE');
	}, T);
});
