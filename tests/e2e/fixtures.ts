import { test as base, expect } from '@playwright/test';

/**
 * Shared e2e fixture. Every test gets a `guard` that records, for the whole
 * browser context:
 *  - requests to any origin other than the site (and aborts them),
 *  - console errors,
 *  - Content-Security-Policy violations (via the securitypolicyviolation event).
 * By default a test fails if any of these happened; call `guard.allowConsoleErrors()`
 * in a test that provokes errors on purpose.
 */
export interface Guard {
	external: string[];
	consoleErrors: string[];
	cspViolations: () => Promise<string[]>;
	allowConsoleErrors: () => void;
}

export const test = base.extend<{ guard: Guard }>({
	guard: [
		async ({ context, page, baseURL }, use) => {
			const origin = new URL(baseURL!).origin;
			const external: string[] = [];
			const consoleErrors: string[] = [];
			let checkConsole = true;

			await context.route('**/*', (route) => {
				const url = route.request().url();
				if (url.startsWith('data:') || url.startsWith('blob:') || new URL(url).origin === origin) {
					return route.continue();
				}
				external.push(url);
				return route.abort('blockedbyclient');
			});

			await context.addInitScript(() => {
				const w = window as unknown as { __csp: string[] };
				w.__csp = [];
				document.addEventListener('securitypolicyviolation', (e) => {
					w.__csp.push(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
				});
			});

			page.on('console', (msg) => {
				if (msg.type() === 'error') consoleErrors.push(msg.text());
			});
			page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

			const guard: Guard = {
				external,
				consoleErrors,
				cspViolations: () =>
					page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []).catch(() => []),
				allowConsoleErrors: () => {
					checkConsole = false;
				}
			};

			await use(guard);

			expect(external, 'requests left the origin').toEqual([]);
			if (checkConsole) {
				expect(consoleErrors, 'console errors').toEqual([]);
				expect(await guard.cspViolations(), 'CSP violations').toEqual([]);
			}
		},
		{ auto: true }
	]
});

export { expect };
