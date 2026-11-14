/**
 * Accessibility tags kept in exports (engine/tags.ts): a tagged file exported whole, and with
 * a page removed, still has its structure tree and the dialog says nothing about it; merged
 * with another tagged file, one tree; with a file without tags, the export has none and the
 * dialog says why in one plain line.
 * Screenshots of that line at 360 px and desktop with TAGS_SHOTS=<dir>.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { nodeAssets } from '../engine/helpers';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const MERGED = 'Accessibility tags (used by screen readers) were not kept because pages from another file were added.';
const shots = process.env.TAGS_SHOTS;
const qpdf = new Qpdf(nodeAssets().qpdf);

/** The downloaded file's catalog and whole content, decompressed (qpdf --qdf). */
async function inspect(bytes: Uint8Array): Promise<string> {
	const res = await qpdf.run({ args: ['--qdf', '--object-streams=disable', '--decode-level=all', '/i.pdf', '/o.pdf'], inputs: { '/i.pdf': bytes }, outputs: ['/o.pdf'] });
	return Buffer.from(res.files.get('/o.pdf')!).toString('latin1');
}

async function open(page: Page, ...names: string[]) {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles(names.map(corpus));
}

async function exportAndDownload(page: Page) {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(/^Checked: \d+ pages?, opens cleanly\.$/)).toBeVisible({ timeout: 90_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	return { done, raw: await inspect(new Uint8Array(readFileSync((await download.path())!))) };
}

test.describe('desktop', () => {
	test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chrome', 'desktop flow'));

	test('a tagged file keeps its tags, whole and with a page removed, and the dialog says nothing about it', async ({ page }) => {
		test.setTimeout(180_000);
		await open(page, 'tags-basic.pdf');
		await expect(page.getByRole('option')).toHaveCount(3, { timeout: 30_000 });
		let { done, raw } = await exportAndDownload(page);
		expect(raw).toMatch(/\/StructTreeRoot \d+ 0 R/);
		expect(raw).toContain('(A grey test picture)');
		await expect(done.getByText(/Accessibility tags \(used/)).toHaveCount(0);
		// Under Details, one calm line.
		await done.getByText('Details').click();
		await expect(done.getByText(/Accessibility tags: passed\. Accessibility tags kept: 16 structure elements/)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(done).toBeHidden();

		// Page 1 removed: the tree is pruned to pages 2 and 3, and still there.
		await page.getByRole('option').first().hover();
		await page.getByRole('option').first().locator('[data-action="delete"]').click();
		await expect(page.getByRole('option')).toHaveCount(2);
		({ done, raw } = await exportAndDownload(page));
		expect(raw).toMatch(/\/StructTreeRoot \d+ 0 R/);
		expect(raw).toContain('(A grey test picture)');
		expect(raw).not.toContain('Introduction');
		await expect(done.getByText(/Accessibility tags \(used/)).toHaveCount(0);
	});

	test('merged with another tagged file: one tree; with a file without tags: none, and one plain line says why', async ({ page }) => {
		test.setTimeout(180_000);
		await open(page, 'tags-basic.pdf', 'tags-second.pdf');
		await expect(page.getByRole('option')).toHaveCount(5, { timeout: 30_000 });
		let { done, raw } = await exportAndDownload(page);
		expect(raw).toMatch(/\/StructTreeRoot \d+ 0 R/);
		expect(raw).toContain('(Second file, second page)');
		await expect(done.getByText(/Accessibility tags \(used/)).toHaveCount(0);
		await page.keyboard.press('Escape');
		await expect(done).toBeHidden();
		await page.locator('input[type=file]').first().setInputFiles([corpus('multi.pdf')]);
		await expect(page.getByRole('option')).toHaveCount(11, { timeout: 30_000 });
		({ done, raw } = await exportAndDownload(page));
		await expect(done.getByText(MERGED)).toBeVisible();
		expect(raw).not.toMatch(/\/StructTreeRoot/);
	});
});

for (const [name, viewport] of [
	['desktop', { width: 1000, height: 800 }],
	['phone', { width: 360, height: 640 }]
] as const) {
	test(`tags note shots ${name}`, async ({ browser, baseURL }, info) => {
		test.skip(!shots || info.project.name !== 'desktop-chrome', 'set TAGS_SHOTS (taken once, in the desktop project)');
		test.setTimeout(120_000);
		const ctx = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 1, hasTouch: name === 'phone' });
		const page = await ctx.newPage();
		await open(page, 'tags-basic.pdf', 'multi.pdf');
		await expect(page.getByRole('option')).toHaveCount(9, { timeout: 30_000 });
		await page.getByRole('button', { name: 'Export', exact: true }).click();
		await page.getByRole('dialog', { name: 'Export PDF' }).getByRole('button', { name: 'Export', exact: true }).click();
		const line = page.getByText(MERGED);
		await expect(line).toBeVisible({ timeout: 90_000 });
		await line.scrollIntoViewIfNeeded();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${shots}/tags-note-${name}.png` });
		await ctx.close();
	});
}
