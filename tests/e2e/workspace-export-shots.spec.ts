/** Screenshots of the export dialog. Only runs with EXPORT_SHOTS=<directory>. */
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from '@playwright/test';
import { openMore } from './export-helpers';

const dir = process.env.EXPORT_SHOTS;
const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));

async function openDialog(page: Page, file: string, pages: number) {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(page.getByRole('option')).toHaveCount(pages, { timeout: 30_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

for (const [name, viewport] of [
	['desktop', { width: 1000, height: 800 }],
	['phone', { width: 360, height: 640 }]
] as const) {
	test(`shots ${name}`, async ({ browser, baseURL }) => {
		test.skip(!dir, 'set EXPORT_SHOTS');
		test.setTimeout(120_000);
		const ctx = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 1, hasTouch: name === 'phone' });
		const page = await ctx.newPage();
		let dialog = await openDialog(page, 'multi.pdf', 6);
		await openMore(dialog);
		await dialog.getByRole('switch', { name: 'Number the pages' }).click();
		await expect(dialog.getByText(/^First: /)).toBeVisible();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${dir}/numbering-${name}.png` });

		await page.reload();
		dialog = await openDialog(page, 'shrink-photos.pdf', 12);
		await openMore(dialog);
		await dialog.getByRole('switch', { name: 'Fit under a size' }).click();
		await dialog.getByRole('radio', { name: 'Other' }).click();
		await dialog.getByLabel('Size in MB').fill('0.3');
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${dir}/fit-size-${name}.png` });
		await dialog.getByRole('button', { name: 'Export', exact: true }).click();
		const done = page.getByRole('dialog', { name: 'Your file is ready' });
		await expect(done.getByText(/^Fits under/)).toBeVisible({ timeout: 120_000 });
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${dir}/result-reached-${name}.png` });

		dialog = await openDialog(page, 'shrink-skips.pdf', 6);
		await openMore(dialog);
		await dialog.getByRole('switch', { name: 'Fit under a size' }).click();
		await dialog.getByRole('radio', { name: 'Other' }).click();
		await dialog.getByLabel('Size in MB').fill('0.1');
		await dialog.getByRole('button', { name: 'Export', exact: true }).click();
		await expect(page.getByText(/^Smallest possible/)).toBeVisible({ timeout: 120_000 });
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${dir}/result-unreached-${name}.png` });
		await ctx.close();
	});
}
