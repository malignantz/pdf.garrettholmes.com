import { describe, expect, it } from 'vitest';
import { corpus, defaultOptions, engine, openCorpus, pageTexts, ref } from './helpers';

describe('smoke', () => {
	it('opens and exports', async () => {
		const src = await openCorpus('multi.pdf');
		expect(src.pages).toHaveLength(6);
		const res = await engine()
			.exportPlan({ pages: [ref(src, 2), ref(src, 0, 90)], options: defaultOptions }, [src], [])
			.catch((e) => {
				console.log(e, e.cause);
				throw e;
			});
		console.log(res.checks, res.elapsedMs);
		expect(await pageTexts(res.bytes)).toEqual(['multi p3', 'multi p1']);
		void corpus;
	}, 30000);
});
