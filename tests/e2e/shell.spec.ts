import { gzipSync } from 'node:zlib';
import { test, expect } from './fixtures';

const MINIMAL_PDF = Buffer.from(
	'%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n'
);

test('home loads under the CSP with no errors and the empty state visible', async ({ page }) => {
	const res = await page.goto('/');
	expect(res?.status()).toBe(200);

	const csp = res!.headers()['content-security-policy'];
	expect(csp).toContain("default-src 'self'");
	expect(csp).toContain("connect-src 'self'");
	expect(csp).toContain("frame-ancestors 'none'");
	const scriptSrc = csp.split(';').find((d) => d.trim().startsWith('script-src'))!;
	expect(scriptSrc).not.toContain('unsafe-inline');
	expect(res!.headers()['referrer-policy']).toBe('no-referrer');
	expect(res!.headers()['x-content-type-options']).toBe('nosniff');
	expect(res!.headers()['cross-origin-opener-policy']).toBe('same-origin');

	await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
	await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
	await expect(page.getByText('Files stay on this device. This page cannot send them anywhere.')).toBeVisible();
	await expect(page.getByRole('link', { name: 'How that is enforced' })).toHaveAttribute('href', '/privacy');
	// The app hydrated (a client-side component is interactive).
	await expect(page.locator('input[type=file]')).toHaveAttribute('accept', /application\/pdf/);
});

test('the CSP really blocks other origins', async ({ page, guard }) => {
	guard.allowConsoleErrors();
	await page.goto('/');
	const outcome = await page.evaluate(async () => {
		try {
			await fetch('https://example.com/');
			return 'sent';
		} catch {
			return 'blocked';
		}
	});
	expect(outcome).toBe('blocked');
	expect((await guard.cspViolations()).join()).toContain('connect-src');
	// The blocked fetch never reached the network.
	expect(guard.external).toEqual([]);
});

test('choose files is reachable by keyboard and opens the picker', async ({ page }) => {
	await page.goto('/');
	const button = page.getByRole('button', { name: 'Choose files' });
	// Wait for hydration and the service worker's first install to settle.
	await button.waitFor();
	await page.waitForLoadState('networkidle');
	for (let i = 0; i < 12; i++) {
		await page.keyboard.press('Tab');
		if (await button.evaluate((el) => el === document.activeElement)) break;
	}
	await expect(button).toBeFocused();
	await expect(button).toHaveCSS('outline-style', 'solid');

	// Enter must activate the hidden file input with user activation (which is
	// what lets the browser open its picker). We assert on that rather than on
	// Playwright's filechooser event, which Chromium's mobile emulation drops
	// intermittently even when the input was clicked with activation.
	const input = page.locator('input[type=file]');
	await input.evaluate((el) => {
		el.addEventListener('click', () => el.setAttribute('data-activated', String(navigator.userActivation.isActive)), {
			once: true
		});
	});
	await page.keyboard.press('Enter');
	await expect(input).toHaveAttribute('data-activated', 'true');
	await expect(input).toHaveAttribute('multiple', '');

	await input.setInputFiles({ name: 'one.pdf', mimeType: 'application/pdf', buffer: MINIMAL_PDF });
	await expect(page.getByText('1 file chosen.', { exact: false })).toBeVisible();
});

test('dropping files on the desk hands them to the page', async ({ page }) => {
	await page.goto('/');
	const dt = await page.evaluateHandle(() => {
		const d = new DataTransfer();
		d.items.add(new File(['%PDF-1.4'], 'a.pdf', { type: 'application/pdf' }));
		d.items.add(new File(['x'], 'b.png', { type: 'image/png' }));
		return d;
	});
	await page.dispatchEvent('main', 'dragenter', { dataTransfer: dt });
	await expect(page.getByRole('heading', { name: 'Drop to add them' })).toBeVisible();
	await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
	await expect(page.getByText('2 files chosen.', { exact: false })).toBeVisible();
});

test('privacy page renders and links to the source', async ({ page }) => {
	await page.goto('/privacy');
	await expect(page.getByRole('heading', { level: 1, name: 'Your files stay on this device' })).toBeVisible();
	await expect(page.getByRole('heading', { name: 'Check it yourself' })).toBeVisible();
	await expect(page.getByRole('link', { name: /github\.com\/malignantz\/pdf\.garrettholmes\.com/ })).toHaveAttribute(
		'href',
		'https://github.com/malignantz/pdf.garrettholmes.com'
	);
	// The top-bar shield link leads here too.
	await page.goto('/');
	await page.getByRole('link', { name: /Stays on this device/ }).click();
	await expect(page).toHaveURL(/\/privacy$/);
});

test('manifest, icons and service worker are served', async ({ request }) => {
	const res = await request.get('/manifest.webmanifest');
	expect(res.ok()).toBe(true);
	expect(res.headers()['content-type']).toContain('manifest+json');
	const manifest = await res.json();
	expect(manifest.name).toBe('PDF Workspace');
	expect(manifest.display).toBe('standalone');
	expect(manifest.icons.some((i: { purpose: string }) => i.purpose === 'maskable')).toBe(true);
	for (const icon of manifest.icons) {
		expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
	}
	for (const path of ['/favicon.svg', '/apple-touch-icon.png']) {
		expect((await request.get(path)).ok(), path).toBe(true);
	}

	const sw = await request.get('/service-worker.js');
	expect(sw.ok()).toBe(true);
	expect(sw.headers()['content-type']).toContain('javascript');
	expect(sw.headers()['cache-control']).toBe('no-cache');

	const immutable = (await sw.text()).match(/_app\/immutable\/[^`"']+\.js/)?.[0];
	expect(immutable).toBeTruthy();
	expect((await request.get(`/${immutable}`)).headers()['cache-control']).toContain('immutable');
});

test('works offline after the first load', async ({ page, context }) => {
	await page.goto('/');
	await page.waitForFunction(async () => {
		const reg = await navigator.serviceWorker.ready;
		return !!reg.active && !!navigator.serviceWorker.controller;
	});

	await context.setOffline(true);
	await page.reload();
	await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();

	await page.goto('/privacy');
	await expect(page.getByRole('heading', { level: 1, name: 'Your files stay on this device' })).toBeVisible();
	await context.setOffline(false);
});

test('entry JavaScript for / stays under 150 KB gzip', async ({ page, request }) => {
	const scripts = new Set<string>();
	page.on('response', (r) => {
		const url = new URL(r.url());
		if (url.pathname.endsWith('.js') && url.pathname !== '/service-worker.js') scripts.add(url.pathname);
	});
	await page.goto('/');
	await page.waitForLoadState('networkidle');
	expect(scripts.size).toBeGreaterThan(0);

	let total = 0;
	for (const path of scripts) {
		total += gzipSync(await (await request.get(path)).body(), { level: 9 }).length;
	}
	console.log(`entry JS for /: ${scripts.size} files, ${(total / 1024).toFixed(1)} KB gzip`);
	expect(total).toBeLessThan(150 * 1024);
});
