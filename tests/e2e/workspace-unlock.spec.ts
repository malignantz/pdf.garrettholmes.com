/**
 * "Remove printing and copying limits": a file that opens without a password but limits
 * what may be done says so at open and in the export dialog, and its export (one PDF,
 * or split) has no encryption. Screenshots at 360 px and desktop with UNLOCK_SHOTS=<dir>.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const FILE = 'unlock-aes-256-all.pdf';
const OPEN_NOTE = `${FILE}: This file had limits on printing, copying, editing and filling in forms. Your export will not have them.`;
const RESULT_LINE = 'Printing, copying, editing and form-filling limits removed.';
const shots = process.env.UNLOCK_SHOTS;

async function open(page: Page): Promise<void> {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(FILE)]);
	await expect(page.getByText(OPEN_NOTE)).toBeVisible({ timeout: 30_000 });
	await expect(page.getByRole('option')).toHaveCount(2);
}

async function exportDialog(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByTestId('limits-note')).toHaveText('A file you opened limited printing, copying, editing and filling in forms. This export will not.');
	return dialog;
}

test('a limited file says so at open, and its export has no limits', async ({ page }) => {
	test.setTimeout(120_000);
	await open(page);
	const dialog = await exportDialog(page);
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 2 pages, opens cleanly.')).toBeVisible({ timeout: 90_000 });
	await expect(done.getByText(RESULT_LINE)).toBeVisible();
	// The old "had a password" warning is not shown for a file that opened without one.
	await expect(done.getByText(/had a password/)).toHaveCount(0);
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = readFileSync((await download.path())!);
	expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
	expect(bytes.toString('latin1')).not.toMatch(/\/Encrypt\b/);
});

test('split export says the limits were removed too', async ({ page }) => {
	test.setTimeout(120_000);
	await open(page);
	const dialog = await exportDialog(page);
	await dialog.getByRole('switch', { name: 'Split into several files' }).click();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your files are ready' });
	await expect(done.getByText(RESULT_LINE)).toBeVisible({ timeout: 90_000 });
});

for (const [name, viewport] of [
	['desktop', { width: 1000, height: 800 }],
	['phone', { width: 360, height: 640 }]
] as const) {
	test(`unlock shots ${name}`, async ({ browser, baseURL }, info) => {
		test.skip(!shots || info.project.name !== 'desktop-chrome', 'set UNLOCK_SHOTS (taken once, in the desktop project)');
		test.setTimeout(120_000);
		const ctx = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 1, hasTouch: name === 'phone' });
		const page = await ctx.newPage();
		await page.goto('/');
		await expect(page.getByText('Unlock files that block printing or copying.', { exact: false })).toBeVisible();
		await page.screenshot({ path: `${shots}/start-${name}.png`, fullPage: true });
		await open(page);
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${shots}/open-note-${name}.png` });
		const dialog = await exportDialog(page);
		await dialog.getByTestId('limits-note').scrollIntoViewIfNeeded();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${shots}/export-form-${name}.png` });
		await dialog.getByRole('button', { name: 'Export', exact: true }).click();
		await expect(page.getByText(RESULT_LINE)).toBeVisible({ timeout: 90_000 });
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${shots}/export-result-${name}.png` });
		await ctx.close();
	});
}
