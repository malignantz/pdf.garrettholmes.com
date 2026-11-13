import { beforeEach, expect, test } from 'vitest';
import { holdBusy, isBusy, resetBusy, watchFilePickers } from '../../src/lib/ui/busy';

beforeEach(resetBusy);

test('a hold makes the page busy until every hold is released, once each', () => {
	expect(isBusy()).toBe(false);
	const a = holdBusy();
	const b = holdBusy();
	a();
	a();
	expect(isBusy()).toBe(true);
	b();
	expect(isBusy()).toBe(false);
});

test('the file picker is busy from the click until files or a cancel', () => {
	const listeners = new Map<string, (e: Event) => void>();
	watchFilePickers({ addEventListener: (type: string, fn: (e: Event) => void) => listeners.set(type, fn) } as never);
	const fire = (type: string, target: object) => listeners.get(type)!({ target } as never);
	const input = { tagName: 'INPUT', type: 'file' };

	fire('click', { tagName: 'BUTTON' });
	expect(isBusy()).toBe(false);
	fire('click', input);
	expect(isBusy()).toBe(true);
	fire('cancel', input);
	expect(isBusy()).toBe(false);
	fire('click', input);
	fire('change', input);
	expect(isBusy()).toBe(false);
});
