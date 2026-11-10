/**
 * Short unique ids. `crypto.randomUUID` when available (16 hex chars of it),
 * otherwise `getRandomValues`, otherwise Math.random plus a counter.
 */
let counter = 0;

export function newId(): string {
	const c = (globalThis as { crypto?: Crypto }).crypto;
	if (c?.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 16);
	if (c?.getRandomValues) {
		const b = c.getRandomValues(new Uint8Array(8));
		return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
	}
	counter = (counter + 1) % 0xffffff;
	return (
		Math.random().toString(16).slice(2, 12).padEnd(10, '0') + counter.toString(16).padStart(6, '0')
	);
}
