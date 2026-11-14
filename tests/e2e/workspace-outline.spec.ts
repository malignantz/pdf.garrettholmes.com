/**
 * Title and bookmarks kept in exports (engine/outline.ts): a file with bookmarks and a title
 * exported whole, and with a page removed, keeps them and the dialog says so only under
 * Details; a file whose bookmarks are damaged exports without them, and one plain line says so.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { Qpdf } from '../../src/lib/engine/qpdf';
import { outlineLines } from '../../src/lib/engine/outline';
import { nodeAssets } from '../engine/helpers';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const DAMAGED = 'Bookmarks could not be kept: they are damaged in the original file.';
const qpdf = new Qpdf(nodeAssets().qpdf);

/** Bookmark titles of the downloaded file, and its Info dictionary (qpdf). */
async function inspect(bytes: Uint8Array): Promise<{ titles: string[]; info: string }> {
	const lines = await outlineLines(qpdf, bytes);
	if ('error' in lines) throw new Error(lines.error);
	const t = await qpdf.run({ args: ['--show-object=trailer', '/i.pdf'], inputs: { '/i.pdf': bytes } });
	const info = /\/Info (\d+) (\d+) R/.exec(t.stdout);
	const shown = info ? (await qpdf.run({ args: [`--show-object=${info[1]},${info[2]}`, '/i.pdf'], inputs: { '/i.pdf': bytes } })).stdout : '';
	return { titles: lines.lines.map((l) => (JSON.parse(l) as [number, string])[1].replace(/^u:/, '')), info: shown };
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
	return { done, file: await inspect(new Uint8Array(readFileSync((await download.path())!))) };
}

test.describe('desktop', () => {
	test.beforeEach(({}, info) => test.skip(info.project.name !== 'desktop-chrome', 'desktop flow'));

	test('a file keeps its title and bookmarks, whole and with a page removed; the dialog says so under Details only', async ({ page }) => {
		test.setTimeout(180_000);
		await open(page, 'outline-basic.pdf');
		await expect(page.getByRole('option')).toHaveCount(4, { timeout: 30_000 });
		let { done, file } = await exportAndDownload(page);
		expect(file.titles).toEqual(['Chapter 1', 'Section 1.1', 'Section 1.2', 'Chapitre 2 — Été', 'Inside the script item', 'Web page', 'Appendix', 'Last page', '“Quoted” — PDFDoc', 'Empty heading', 'Short view']);
		expect(file.info).toMatch(/\/Title \(Quarterly Report /);
		await expect(done.getByText(/^Bookmarks /)).toHaveCount(0);
		await expect(done.getByText('Title and bookmarks kept.')).toHaveCount(0);
		await done.getByText('Details', { exact: true }).click();
		await expect(done.getByText(/Title and bookmarks: passed\. Document details kept \(Title, Author, Subject, Keywords, Creator, CreationDate\).*11 bookmarks kept/)).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(done).toBeHidden();

		// Page 3 removed: its bookmarks go, and the web link under them.
		await page.getByRole('option').nth(2).hover();
		await page.getByRole('option').nth(2).locator('[data-action="delete"]').click();
		await expect(page.getByRole('option')).toHaveCount(3);
		({ done, file } = await exportAndDownload(page));
		expect(file.titles).toEqual(['Chapter 1', 'Section 1.1', 'Section 1.2', 'Appendix', 'Last page', '“Quoted” — PDFDoc', 'Short view']);
		await expect(done.getByText(/^Bookmarks /)).toHaveCount(0);
	});

	test('damaged bookmarks: exported without them, and one plain line says so', async ({ page }) => {
		test.setTimeout(120_000);
		await open(page, 'outline-cyclic.pdf');
		await expect(page.getByRole('option')).toHaveCount(2, { timeout: 30_000 });
		const { done, file } = await exportAndDownload(page);
		await expect(done.getByText(DAMAGED)).toBeVisible();
		expect(file.titles).toEqual([]);
		expect(file.info).toContain('(Cyclic outline)');
	});
});
