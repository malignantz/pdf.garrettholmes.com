/**
 * When the export's own check of its bookmarks or details fails, core.ts builds the same plan
 * again without what failed ("avoid, don't fail"), and the result says so. The check is made
 * to fail once here (the real one runs on the second build).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fail: { next: { bookmarks: boolean; info: boolean } | null } = { next: null };
vi.mock('../../src/lib/engine/outline', async (orig) => {
	const real = await orig<typeof import('../../src/lib/engine/outline')>();
	return {
		...real,
		verifyOutline: async (...args: Parameters<typeof real.verifyOutline>) => {
			if (fail.next) {
				const failed = fail.next;
				fail.next = null;
				return { check: { name: 'outline', ok: false, detail: 'made to fail' }, failed };
			}
			return real.verifyOutline(...args);
		}
	};
});

const { defaultOptions, engine, loadPdfjs, openCorpus, ref } = await import('./helpers');

const T = 60_000;

async function facts(bytes: Uint8Array) {
	const lib = await loadPdfjs();
	const task = lib.getDocument({ data: bytes.slice(), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		return { outline: ((await doc.getOutline()) ?? []).map((o: { title: string }) => o.title), title: (await doc.getMetadata()).info as Record<string, unknown> };
	} finally {
		await task.destroy();
	}
}

describe('outline: a failed check builds the export again without what failed', () => {
	beforeEach(() => {
		fail.next = null;
	});

	it('bookmarks failed: exported without bookmarks (and names), title kept, and the result says why', async () => {
		const src = await openCorpus('outline-named.pdf');
		fail.next = { bookmarks: true, info: false };
		const res = await engine().exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: defaultOptions }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.bookmarks).toEqual({ kept: false, reason: 'check' });
		expect(res.docInfo).toEqual({ kept: true });
		const f = await facts(res.bytes);
		expect(f.outline).toEqual([]);
		expect(f.title.Title).toBe('Named destinations');
		expect(Buffer.from(res.bytes).toString('latin1')).not.toMatch(/\/Dests/);
	}, T);

	it('details failed: exported without them, bookmarks kept', async () => {
		const src = await openCorpus('outline-basic.pdf');
		fail.next = { bookmarks: false, info: true };
		const res = await engine().exportPlan({ pages: src.pages.map((_, i) => ref(src, i)), options: defaultOptions }, [src], []);
		expect(res.checks.every((c) => c.ok)).toBe(true);
		expect(res.docInfo).toEqual({ kept: false, reason: 'check' });
		expect(res.bookmarks).toEqual({ kept: true, items: 11 });
		const f = await facts(res.bytes);
		expect(f.outline).toHaveLength(5);
		expect(f.title.Title).toBeUndefined();
	}, T);
});
