/** "Reduce oversized pictures" (the print-size cap) in the export dialog: offered, used, declined. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));

async function open(page: Page, file: string, pages: number): Promise<Locator> {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(page.getByRole('option')).toHaveCount(pages, { timeout: 30_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

/** Size and decoded samples (hashed) of the first image of page 1. */
function firstImage(bytes: Uint8Array): { width: number; height: number; samples: string } {
	const doc = new mupdf.PDFDocument(bytes.slice());
	try {
		let found: mupdf.PDFObject | null = null;
		doc.findPage(0)
			.getInheritable('Resources')
			.get('XObject')
			.forEach((v) => {
				if (!found && v.get('Subtype').asName() === 'Image') found = v;
			});
		const img = found as unknown as mupdf.PDFObject;
		const buf = img.readStream();
		const data = buf.asUint8Array();
		let h = 0x811c9dc5;
		for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i], 0x01000193);
		const out = { width: img.get('Width').asNumber(), height: img.get('Height').asNumber(), samples: `${data.length}:${(h >>> 0).toString(16)}` };
		buf.destroy();
		return out;
	} finally {
		doc.destroy();
	}
}

async function exportAndDownload(page: Page, dialog: Locator): Promise<{ done: Locator; bytes: Uint8Array }> {
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 3 pages, opens cleanly.')).toBeVisible({ timeout: 90_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	return { done, bytes: new Uint8Array(readFileSync((await download.path())!)) };
}

const switchOf = (d: Locator) => d.getByRole('switch', { name: 'Reduce oversized pictures' });

test('an oversized photo is offered, reduced to 300 ppi and reported', async ({ page }) => {
	test.setTimeout(120_000);
	const dialog = await open(page, 'print-cap.pdf', 3);
	const cap = switchOf(dialog);
	await expect(cap).toBeVisible({ timeout: 20_000 });
	await expect(cap).toBeChecked();
	await expect(dialog.getByText('One picture holds more detail than a printer can use. It is brought down to 300 dpi; text stays sharp.')).toBeVisible();
	await expect(dialog.getByText('Text and drawings stay exactly as they are.')).toBeVisible();
	// Only with Compress.
	await dialog.getByRole('switch', { name: 'Compress' }).click();
	await expect(cap).toHaveCount(0);
	await dialog.getByRole('switch', { name: 'Compress' }).click();
	await expect(cap).toBeChecked();

	const { done, bytes } = await exportAndDownload(page, dialog);
	await expect(done.getByText(/^1 picture reduced to 300 dpi, about \d+ KB saved\.$/)).toBeVisible();
	await expect(done.getByText('Every page still looks the same with the smaller pictures.')).toBeVisible();
	const before = firstImage(new Uint8Array(readFileSync(corpus('print-cap.pdf'))));
	expect(before).toMatchObject({ width: 1000, height: 750 });
	expect(firstImage(bytes)).toMatchObject({ width: 600, height: 450 });
});

test('unticked, the photo keeps every pixel; the choice is remembered', async ({ page }) => {
	test.setTimeout(120_000);
	const dialog = await open(page, 'print-cap.pdf', 3);
	await switchOf(dialog).click();
	await expect(switchOf(dialog)).not.toBeChecked();
	await expect(dialog.getByText('Lossless: images and text stay exactly as they are.')).toBeVisible();
	const { done, bytes } = await exportAndDownload(page, dialog);
	await expect(done.getByText(/picture reduced/)).toHaveCount(0);
	expect(firstImage(bytes)).toEqual(firstImage(new Uint8Array(readFileSync(corpus('print-cap.pdf')))));
	await done.getByRole('button', { name: 'Close', exact: true }).last().click();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(switchOf(page.getByRole('dialog', { name: 'Export PDF' }))).not.toBeChecked({ timeout: 20_000 });
});

test('not offered when no picture is oversized', async ({ page }) => {
	const dialog = await open(page, 'shrink-photos.pdf', 12);
	// The question is answered quickly (qpdf alone here); give it time to show if it were going to.
	await page.waitForTimeout(1500);
	await expect(switchOf(dialog)).toHaveCount(0);
	await expect(dialog.getByRole('switch', { name: 'Compress' })).toBeChecked();
});
