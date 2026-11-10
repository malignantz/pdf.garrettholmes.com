import { describe, expect, it, vi } from 'vitest';
import { ByteLru } from '../../src/lib/render/lru';

describe('ByteLru', () => {
	it('evicts least recently used first and calls onEvict', () => {
		const evicted: string[] = [];
		const c = new ByteLru<string>({ maxBytes: 100, onEvict: (_v, k) => evicted.push(k) });
		c.set('a', 'A', 40);
		c.set('b', 'B', 40);
		c.get('a'); // a is now newest
		c.set('c', 'C', 40);
		expect(evicted).toEqual(['b']);
		expect(c.bytes).toBe(80);
		expect(c.has('a') && c.has('c') && !c.has('b')).toBe(true);
	});

	it('evicts several entries to fit a large one', () => {
		const evicted: string[] = [];
		const c = new ByteLru<number>({ maxBytes: 100, onEvict: (_v, k) => evicted.push(k) });
		c.set('a', 1, 30);
		c.set('b', 2, 30);
		c.set('c', 3, 30);
		c.set('d', 4, 80);
		expect(evicted).toEqual(['a', 'b', 'c']);
		expect(c.bytes).toBe(80);
	});

	it('replacing a key evicts the old value and fixes the byte count', () => {
		const onEvict = vi.fn();
		const c = new ByteLru<string>({ maxBytes: 100, onEvict });
		c.set('a', 'old', 50);
		c.set('a', 'new', 20);
		expect(onEvict).toHaveBeenCalledWith('old', 'a');
		expect(c.bytes).toBe(20);
		expect(c.get('a')).toBe('new');
	});

	it('rejects (and evicts) a value bigger than the whole budget', () => {
		const onEvict = vi.fn();
		const c = new ByteLru<string>({ maxBytes: 10, onEvict });
		c.set('big', 'x', 11);
		expect(onEvict).toHaveBeenCalledWith('x', 'big');
		expect(c.size).toBe(0);
		expect(c.bytes).toBe(0);
	});

	it('deletePrefix and clear close everything they remove', () => {
		const onEvict = vi.fn();
		const c = new ByteLru<number>({ maxBytes: 1000, onEvict });
		c.set('s1:0', 1, 10);
		c.set('s1:1', 2, 10);
		c.set('s2:0', 3, 10);
		expect(c.deletePrefix('s1:')).toBe(2);
		expect(onEvict).toHaveBeenCalledTimes(2);
		expect(c.bytes).toBe(10);
		c.clear();
		expect(onEvict).toHaveBeenCalledTimes(3);
		expect(c.size).toBe(0);
	});

	it('shrinking the budget trims', () => {
		const c = new ByteLru<number>({ maxBytes: 100 });
		c.set('a', 1, 50);
		c.set('b', 2, 50);
		c.setMaxBytes(60);
		expect(c.has('a')).toBe(false);
		expect(c.has('b')).toBe(true);
	});
});
