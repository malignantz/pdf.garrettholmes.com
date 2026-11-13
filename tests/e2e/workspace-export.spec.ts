/** Export dialog, phase 2 options: page numbers, size target, remembered options, small screens. */
import { readFileSync } from 'node:fs';
import * as mupdf from 'mupdf';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const tc = await (await doc.getPage(i)).getTextContent();
			out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join('').trim());
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

const exportButton = (d: Locator) => d.getByRole('button', { name: 'Export', exact: true });

test('page numbers: choose, preview, export, read back', async ({ page }) => {
	test.setTimeout(90_000);
	const dialog = await open(page, 'multi.pdf', 6);
	await dialog.getByRole('switch', { name: 'Number the pages' }).click();
	await expect(dialog.getByRole('radio', { name: 'Bottom center' })).toBeChecked();
	await expect(dialog.getByText('First: "Page 1 of 6" · Last: "Page 6 of 6"')).toBeVisible();
	await dialog.getByLabel('Skip first pages').fill('1');
	await expect(dialog.getByText('First: "Page 1 of 5" · Last: "Page 5 of 5". The first page gets no number.')).toBeVisible();
	await dialog.getByLabel('Skip first pages').fill('0');
	await dialog.getByRole('radio', { name: 'Top right' }).click();
	await dialog.getByLabel('Style').selectOption({ label: 'Page 1 of 12' });
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 6 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	await expect(done.getByText('Every numbered page carries its number.')).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const texts = await pageTexts(readFileSync((await download.path())!));
	expect(texts).toHaveLength(6);
	texts.forEach((t, i) => expect(t).toContain(`Page ${i + 1} of 6`));
});

test('bates: too few digits is explained and blocks the export', async ({ page }) => {
	const dialog = await open(page, 'multi.pdf', 6);
	await dialog.getByRole('switch', { name: 'Number the pages' }).click();
	await dialog.getByLabel('Style').selectOption({ label: 'Bates number' });
	await dialog.getByLabel('Prefix').fill('ACME-');
	await dialog.getByLabel('Digits').fill('2');
	await expect(dialog.getByRole('alert').filter({ hasText: 'Bates numbers must have between 3 and 10 digits.' })).toBeVisible();
	await expect(exportButton(dialog)).toBeDisabled();
	await dialog.getByLabel('Digits').fill('4');
	await expect(dialog.getByText('First: "ACME-0001" · Last: "ACME-0006"')).toBeVisible();
	await expect(exportButton(dialog)).toBeEnabled();
});

test('fit under a size: reached', async ({ page }) => {
	test.setTimeout(240_000);
	const dialog = await open(page, 'shrink-photos.pdf', 12);
	await dialog.getByRole('switch', { name: 'Fit under a size' }).click();
	await expect(dialog.getByRole('radio', { name: '10 MB' })).toBeChecked();
	const compress = dialog.getByRole('switch', { name: 'Optimize' });
	await expect(compress).toBeChecked();
	await expect(compress).toBeDisabled();
	await dialog.getByRole('radio', { name: 'Other' }).click();
	await dialog.getByLabel('Size in MB').fill('9999');
	await expect(dialog.getByText('Enter a size from 0.1 to 500 MB.')).toBeVisible();
	await expect(exportButton(dialog)).toBeDisabled();

	await dialog.getByLabel('Size in MB').fill('0.3');
	await exportButton(dialog).click();
	await expect(dialog.getByText('Fitting under 0.3 MB. Large scans can take a minute.')).toBeVisible();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 12 pages, opens cleanly.')).toBeVisible({ timeout: 150_000 });
	await expect(done.getByText(/^Fits under 0\.3 MB: \d+ KB\.$/)).toBeVisible();
	await expect(done.getByText(/^Photos and scans were reduced to about \d+ dpi\.$/)).toBeVisible();
	await expect(done.getByText('Every page still looks the same with the smaller pictures.')).toBeVisible();
	// The choice stays when the dialog is reopened.
	await done.getByRole('button', { name: 'Close', exact: true }).last().click();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(dialog.getByLabel('Size in MB')).toHaveValue('0.3');
});

test('fit under a size: out of reach offers the smallest file, without an error', async ({ page }) => {
	test.setTimeout(240_000);
	// Nothing in this file is safe to shrink, so 0.1 MB cannot be reached (it is about 380 KB).
	const dialog = await open(page, 'shrink-skips.pdf', 6);
	await dialog.getByRole('switch', { name: 'Fit under a size' }).click();
	await dialog.getByRole('radio', { name: 'Other' }).click();
	await dialog.getByLabel('Size in MB').fill('0.1');
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(/^Smallest possible is \d+ KB\. You asked for 0\.1 MB\.$/)).toBeVisible({ timeout: 150_000 });
	await expect(done.getByRole('alert')).toHaveCount(0);
	await expect(done.getByText('This is the smallest the file can get without damaging text.')).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	expect(readFileSync((await download.path())!).length).toBeGreaterThan(104_858);
});

test('options are remembered when the dialog is reopened; the password is not', async ({ page }) => {
	const dialog = await open(page, 'multi.pdf', 6);
	await dialog.getByRole('switch', { name: 'Remove metadata' }).click();
	await dialog.getByRole('switch', { name: 'Number the pages' }).click();
	await dialog.getByRole('radio', { name: 'Top left' }).click();
	await dialog.getByRole('radio', { name: 'Large' }).click();
	await dialog.getByRole('switch', { name: 'Add a password' }).click();
	await dialog.getByLabel('Password', { exact: true }).fill('abc');
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(dialog.getByRole('switch', { name: 'Remove metadata' })).toBeChecked();
	await expect(dialog.getByRole('switch', { name: 'Number the pages' })).toBeChecked();
	await expect(dialog.getByRole('radio', { name: 'Top left' })).toBeChecked();
	await expect(dialog.getByRole('radio', { name: 'Large' })).toBeChecked();
	await expect(dialog.getByRole('switch', { name: 'Add a password' })).not.toBeChecked();
});

test('everything stays reachable with all sections open', async ({ page }) => {
	const dialog = await open(page, 'multi.pdf', 6);
	await dialog.getByRole('switch', { name: 'Fit under a size' }).click();
	await dialog.getByRole('switch', { name: 'Number the pages' }).click();
	await dialog.getByLabel('Style').selectOption({ label: 'Bates number' });
	await dialog.getByRole('switch', { name: 'Add a password' }).click();
	const button = exportButton(dialog);
	await expect(button).toBeInViewport();
	// The body scrolls: the last control can be brought into view.
	await dialog.getByLabel('Confirm password').scrollIntoViewIfNeeded();
	await expect(dialog.getByLabel('Confirm password')).toBeInViewport();
	await expect(button).toBeInViewport();
});

test('compress (the default) repacks losslessly in the browser worker: smaller, predictor kept, nothing fetched from elsewhere', async ({ page }) => {
	test.setTimeout(90_000);
	const notes: string[] = [];
	page.on('console', (msg) => {
		if (msg.text().startsWith('[engine]')) notes.push(msg.text());
	});
	const dialog = await open(page, 'compress-predictor.pdf', 1);
	await expect(dialog.getByRole('switch', { name: 'Optimize' })).toBeChecked();
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 1 page, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = readFileSync((await download.path())!);
	// Before the fix qpdf dropped the image's PNG predictor: 71 KB in, 190 KB out.
	expect(bytes.length).toBeLessThan(readFileSync(corpus('compress-predictor.pdf')).length);
	expect(bytes.toString('latin1')).toMatch(/\/Predictor/);
	expect(await pageTexts(bytes)).toEqual(['predictor p1']);
	// libdeflate (vendored wasm) loaded and ran inside the module worker.
	await expect.poll(() => notes.join('\n')).toMatch(/pack: .*polished/);
	expect(notes.join('\n')).not.toMatch(/did not load/);
});

/** Every page rendered by MuPDF in Node (RGB, 1.5 px per point). */
function renders(bytes: Uint8Array): string[] {
	const doc = new mupdf.PDFDocument(bytes.slice());
	try {
		const out: string[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.scale(1.5, 1.5), mupdf.ColorSpace.DeviceRGB, false, true);
			out.push(Buffer.from(pix.getPixels()).toString('base64'));
			pix.destroy();
		}
		return out;
	} finally {
		doc.destroy();
	}
}

test('compress repacks JPEG images losslessly in the browser worker: smaller, pages identical, nothing fetched from elsewhere', async ({ page }) => {
	test.setTimeout(90_000);
	const notes: string[] = [];
	page.on('console', (msg) => {
		if (msg.text().startsWith('[engine]')) notes.push(msg.text());
	});
	const dialog = await open(page, 'jpeg-kinds.pdf', 11);
	await expect(dialog.getByRole('switch', { name: 'Optimize' })).toBeChecked();
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 11 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = new Uint8Array(readFileSync((await download.path())!));
	const input = new Uint8Array(readFileSync(corpus('jpeg-kinds.pdf')));
	expect(bytes.length).toBeLessThan(input.length * 0.9);
	expect(renders(bytes)).toEqual(renders(input));
	// The repack module (vendored wasm) loaded and ran inside the module worker.
	await expect.poll(() => notes.join('\n')).toMatch(/pack: JPEG 12 repacked/);
	expect(notes.join('\n')).not.toMatch(/did not load/);
});
