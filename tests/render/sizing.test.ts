import { describe, expect, it } from 'vitest';
import {
	MAX_PIXELS,
	MAX_SIDE,
	bitmapBytes,
	bucketWidth,
	computeRenderSize,
	isSwapped
} from '../../src/lib/render/sizing';

describe('bucketWidth', () => {
	it('rounds up to stable buckets', () => {
		expect(bucketWidth(1)).toBe(32);
		expect(bucketWidth(200)).toBe(224);
		expect(bucketWidth(512)).toBe(512);
		expect(bucketWidth(513)).toBe(576);
		expect(bucketWidth(1600)).toBe(1792);
	});
	it('small resizes share a bucket', () => {
		expect(bucketWidth(201)).toBe(bucketWidth(223));
	});
});

describe('computeRenderSize', () => {
	it('scales a letter page to the target width', () => {
		const s = computeRenderSize(612, 792, 0, 306);
		expect(s.scale).toBeCloseTo(0.5);
		expect(s.width).toBe(306);
		expect(s.height).toBe(396);
		expect(s.clamped).toBe(false);
	});
	it('swaps dimensions for 90 and 270 but keeps the scale', () => {
		const a = computeRenderSize(612, 792, 90, 306);
		expect(a.scale).toBeCloseTo(0.5);
		expect(a.width).toBe(396);
		expect(a.height).toBe(306);
		expect(isSwapped(270)).toBe(true);
		expect(isSwapped(180)).toBe(false);
	});
	it('clamps each side to 4096', () => {
		const s = computeRenderSize(100, 2000, 0, 5000);
		expect(s.clamped).toBe(true);
		expect(s.height).toBeLessThanOrEqual(MAX_SIDE);
		expect(s.width).toBeLessThanOrEqual(MAX_SIDE);
	});
	it('clamps total pixels to 16.7 MP', () => {
		const s = computeRenderSize(612, 792, 0, 6000);
		expect(s.width * s.height).toBeLessThanOrEqual(MAX_PIXELS);
		expect(s.clamped).toBe(true);
	});
	it('clamps for every rotation', () => {
		for (const r of [0, 90, 180, 270]) {
			const s = computeRenderSize(300, 5000, r, 4000);
			expect(s.width).toBeLessThanOrEqual(MAX_SIDE);
			expect(s.height).toBeLessThanOrEqual(MAX_SIDE);
			expect(s.width * s.height).toBeLessThanOrEqual(MAX_PIXELS);
		}
	});
	it('never returns a zero-size bitmap', () => {
		const s = computeRenderSize(612, 792, 0, 0);
		expect(s.width).toBeGreaterThanOrEqual(1);
		expect(s.height).toBeGreaterThanOrEqual(1);
	});
	it('estimates bitmap bytes as w*h*4', () => {
		expect(bitmapBytes(10, 20)).toBe(800);
	});
});
