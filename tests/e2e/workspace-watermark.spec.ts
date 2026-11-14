/** Export dialog: watermark (choose, preview, honest line, export, read back, remembered, refused characters). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { openMore } from './export-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const shots = process.env.CW_SHOTS;
const exportButton = (d: Locator) => d.getByRole('button', { name: 'Export', exact: true });

/** Text items of every page with their direction on screen (degrees, counter-clockwise). */
async function pageItems(bytes: Uint8Array): Promise<{ str: string; deg: number }[][]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: { str: string; deg: number }[][] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const page = await doc.getPage(i);
			const vp = page.getViewport({ scale: 1 });
			const tc = await page.getTextContent();
			out.push(
				tc.items.flatMap((it) => {
					if (!('str' in it) || !it.str.trim()) return [];
					const [a, b, , , e, f] = it.transform as number[];
					const [x0, y0] = vp.convertToViewportPoint(e, f) as number[];
					const [x1, y1] = vp.convertToViewportPoint(e + a, f + b) as number[];
					return [{ str: it.str, deg: (Math.atan2(-(y1 - y0), x1 - x0) * 180) / Math.PI }];
				})
			);
		}
		return out;
	} finally {
		await task.destroy();
	}
}

async function open(page: Page, file: string, pages: number): Promise<Locator> {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(page.getByRole('option')).toHaveCount(pages, { timeout: 30_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test('watermark: choose, preview, export, every page carries it', async ({ page }) => {
	test.setTimeout(90_000);
	const dialog = await open(page, 'multi.pdf', 6);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: 'Add a watermark' }).click();
	const section = dialog.getByTestId('watermark-section');
	await expect(section.getByRole('radio', { name: 'Draft' })).toBeChecked();
	await expect(section.getByRole('radio', { name: 'Diagonal' })).toBeChecked();
	await expect(section.getByRole('radio', { name: 'Light' })).toBeChecked();
	await expect(section.getByRole('radio', { name: 'Grey' })).toBeChecked();
	await section.getByRole('radio', { name: 'Confidential' }).click();
	await section.getByRole('radio', { name: 'Medium' }).click();
	await expect(section.getByRole('figure', { name: /Preview: "CONFIDENTIAL" diagonally/ })).toBeVisible();
	await expect(section.getByText('A watermark is a visible mark, not protection: anyone with a PDF editor can remove it.')).toBeVisible();
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 6 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	await expect(done.getByText('Every page carries the watermark.')).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const pages = await pageItems(readFileSync((await download.path())!));
	expect(pages).toHaveLength(6);
	for (const items of pages) {
		const hit = items.find((i) => i.str.replace(/\s/g, '') === 'CONFIDENTIAL');
		expect(hit, items.map((i) => i.str).join('|')).toBeTruthy();
		// Diagonal on an upright Letter page: about 52° up from level.
		expect(hit!.deg).toBeGreaterThan(30);
		expect(hit!.deg).toBeLessThan(60);
	}
});

test('watermark: typed text, straight; characters the font cannot draw block the export; remembered', async ({ page }) => {
	test.setTimeout(90_000);
	const dialog = await open(page, 'multi.pdf', 6);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: 'Add a watermark' }).click();
	const section = dialog.getByTestId('watermark-section');
	await section.getByRole('radio', { name: 'Other' }).click();
	await expect(section.getByRole('alert').filter({ hasText: 'Type the watermark text.' })).toBeVisible();
	await expect(exportButton(dialog)).toBeDisabled();
	await section.getByLabel('Watermark text').fill('秘密 copy');
	await expect(section.getByRole('alert').filter({ hasText: 'The watermark has characters that cannot be printed: 秘 密. Remove them.' })).toBeVisible();
	await expect(exportButton(dialog)).toBeDisabled();
	await section.getByLabel('Watermark text').fill('Copy for Ana Núñez');
	await section.getByRole('radio', { name: 'Straight' }).click();
	await section.getByRole('radio', { name: 'Red' }).click();
	await expect(section.getByRole('figure', { name: /Preview: "Copy for Ana Núñez" straight/ })).toBeVisible();
	await expect(exportButton(dialog)).toBeEnabled();
	// Remembered when the dialog is opened again.
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(dialog.getByRole('switch', { name: 'Add a watermark' })).toBeChecked();
	await expect(section.getByLabel('Watermark text')).toHaveValue('Copy for Ana Núñez');
	await expect(section.getByRole('radio', { name: 'Straight' })).toBeChecked();
	await expect(section.getByRole('radio', { name: 'Red' })).toBeChecked();
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Every page carries the watermark.')).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	for (const items of await pageItems(readFileSync((await download.path())!))) {
		const hit = items.find((i) => i.str.replace(/\s/g, '') === 'CopyforAnaNúñez');
		expect(hit, items.map((i) => i.str).join('|')).toBeTruthy();
		expect(Math.abs(hit!.deg)).toBeLessThan(1);
	}
});

const pagesOf = (page: Page) => page.getByRole('option');

async function startOver(page: Page) {
	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Start over' }).click();
	await expect(pagesOf(page)).toHaveCount(0);
}

async function reopen(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

test('watermark: switched off for new files; kept for the same work and after Undo; its text stays chosen', async ({ page }) => {
	const dialog = await open(page, 'multi.pdf', 6);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: 'Add a watermark' }).click();
	const section = dialog.getByTestId('watermark-section');
	await section.getByRole('radio', { name: 'Other' }).click();
	await section.getByLabel('Watermark text').fill('For Ana');
	await section.getByRole('radio', { name: 'Red' }).click();
	await dialog.getByRole('button', { name: 'Cancel' }).click();

	// Start over, then Undo: the same work, so the watermark is still on.
	await startOver(page);
	await page.getByRole('button', { name: 'Undo', exact: true }).click();
	await expect(pagesOf(page)).toHaveCount(6);
	let again = await reopen(page);
	await expect(again.getByRole('switch', { name: 'Add a watermark' })).toBeChecked();
	await again.getByRole('button', { name: 'Cancel' }).click();

	// Start over with a different file: a new job, the switch is off.
	await startOver(page);
	await page.locator('input[type=file]').first().setInputFiles([corpus('rotated.pdf')]);
	await expect(pagesOf(page)).toHaveCount(6, { timeout: 30_000 });
	again = await reopen(page);
	await openMore(again);
	const wm = again.getByRole('switch', { name: 'Add a watermark' });
	await expect(wm).not.toBeChecked();
	await expect(again.getByTestId('watermark-section')).toHaveCount(0);
	// How it looks is remembered.
	await wm.click();
	await expect(again.getByTestId('watermark-section').getByLabel('Watermark text')).toHaveValue('For Ana');
	await expect(again.getByTestId('watermark-section').getByRole('radio', { name: 'Red' })).toBeChecked();
});

test('watermark: restoring saved work brings it back as it was', async ({ page }) => {
	test.setTimeout(90_000);
	const dialog = await open(page, 'multi.pdf', 6);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: 'Add a watermark' }).click();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	// Wait until the saved record holds the switch.
	await expect
		.poll(
			() =>
				page.evaluate(
					() =>
						new Promise<boolean>((resolve) => {
							const r = indexedDB.open('pdf-workspace-session');
							r.onerror = () => resolve(false);
							r.onsuccess = () => {
								const db = r.result;
								if (!db.objectStoreNames.contains('session')) return resolve(false);
								const get = db.transaction('session').objectStore('session').get('current');
								get.onsuccess = () => {
									db.close();
									resolve(!!(get.result as { exportForm?: { watermark?: boolean } } | undefined)?.exportForm?.watermark);
								};
								get.onerror = () => resolve(false);
							};
						})
				),
			{ timeout: 15_000 }
		)
		.toBe(true);
	await page.waitForTimeout(700);
	await page.reload();
	const card = page.getByRole('region', { name: 'Pick up where you left off?' });
	await card.getByRole('button', { name: 'Restore' }).click();
	await expect(pagesOf(page)).toHaveCount(6, { timeout: 30_000 });
	const again = await reopen(page);
	// Folded by nobody, opened because something inside is on.
	await expect(again.getByRole('switch', { name: 'Add a watermark' })).toBeChecked();
});

for (const [name, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['phone', { width: 360, height: 740 }]
] as const) {
	test(`watermark shots ${name}`, async ({ browser, baseURL }, info) => {
		test.skip(!shots || info.project.name !== 'desktop-chrome', 'set CW_SHOTS (taken once, in the desktop project)');
		test.setTimeout(90_000);
		const ctx = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 2, hasTouch: name === 'phone', isMobile: name === 'phone' });
		const page = await ctx.newPage();
		const dialog = await open(page, 'multi.pdf', 6);
		await openMore(dialog);
		await dialog.getByRole('switch', { name: 'Add a watermark' }).click();
		await dialog.getByTestId('watermark-section').getByRole('radio', { name: 'Confidential' }).click();
		const fig = dialog.getByRole('figure');
		await fig.scrollIntoViewIfNeeded();
		await page.waitForTimeout(400);
		await page.screenshot({ path: `${shots}/watermark-${name}.png` });
		await ctx.close();
	});
}
