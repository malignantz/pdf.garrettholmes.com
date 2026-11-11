/** Survey harness: greedy coverage sampler (tools/survey/lib/sampler.ts). */
import { describe, expect, it } from 'vitest';
import { sample, sizeCost, type SampleItem } from '../../tools/survey/lib/sampler';

function pile(): SampleItem[] {
	const items: SampleItem[] = [];
	// 200 plain files, then a few rare ones.
	for (let i = 0; i < 200; i++) items.push({ id: `plain${String(i).padStart(3, '0')}`, size: 1000 + i, features: ['form=none', 'enc=none', `size=${i % 2 ? 'small' : 'tiny'}`] });
	items.push({ id: 'rare-form-a', size: 5000, features: ['form=xfa', 'enc=none', 'size=small'] });
	items.push({ id: 'rare-form-b', size: 900_000_000, features: ['form=xfa', 'enc=none', 'size=small'] });
	items.push({ id: 'rare-form-c', size: 50_000_000, features: ['form=xfa', 'enc=aes', 'size=small'] });
	items.push({ id: 'rare-form-d', size: 60_000, features: ['form=xfa', 'enc=aes', 'size=small'] });
	items.push({ id: 'enc-only', size: 3000, features: ['form=none', 'enc=aes', 'size=tiny'] });
	return items;
}

describe('sample', () => {
	const opts = { target: 12, k: 2, maxBytes: 100 * 1024 * 1024, seed: 7 };

	it('covers every feature and pair at least k times when the pile allows', () => {
		const res = sample(pile(), opts);
		expect(res.ids).toHaveLength(12);
		for (const [f, [inPile, inSample]] of Object.entries(res.coverage)) {
			if (f === 'form=xfa' || f.startsWith('enc')) expect(inSample, f).toBeGreaterThanOrEqual(Math.min(2, inPile));
		}
		expect(res.pairsShort).toBe(0);
		// The xfa+aes pair occurs twice; both files are needed.
		expect(res.ids).toEqual(expect.arrayContaining(['rare-form-c', 'rare-form-d', 'enc-only']));
	});

	it('leaves out files above the size cap and says so', () => {
		const res = sample(pile(), opts);
		expect(res.ids).not.toContain('rare-form-b');
		expect(res.excludedTooLarge).toBe(1);
		expect(res.coverage['form=xfa'][0]).toBe(4);
	});

	it('prefers the smaller of two equally useful files', () => {
		const items: SampleItem[] = [
			{ id: 'big', size: 80_000_000, features: ['a=1'] },
			{ id: 'small', size: 10_000, features: ['a=1'] }
		];
		expect(sample(items, { ...opts, target: 1, k: 1 }).ids).toEqual(['small']);
		expect(sizeCost(10_000)).toBeLessThan(sizeCost(80_000_000));
	});

	it('is deterministic for a seed and independent of input order', () => {
		const a = sample(pile(), opts).ids;
		const b = sample([...pile()].reverse(), opts).ids;
		expect(b).toEqual(a);
		const other = sample(pile(), { ...opts, target: 40, seed: 8 }).ids;
		expect(new Set(other).size).toBe(40);
	});

	it('fills up to the target after coverage is met, without duplicates', () => {
		const res = sample(pile(), { ...opts, target: 100 });
		expect(res.ids).toHaveLength(100);
		expect(new Set(res.ids).size).toBe(100);
	});
});
