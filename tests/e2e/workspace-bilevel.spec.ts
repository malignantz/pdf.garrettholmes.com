/**
 * "Make scanned pages black and white" in the export dialog (desktop and phone).
 * Corpus: tests/corpus/generate-bilevel.mjs (bilevel-mixed.pdf: p1 a typed letter that
 * converts, p2 with a red stamp, p3 with a pencil scribble, p4 born-digital).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { moreButton, openMore } from './export-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const OPTION = 'Make scanned pages black and white';
const HINT = 'Much smaller files for printed pages. They will look like a photocopy: sharp black and white, no grey. Pages with colour, photos or faint marks are left as they are.';

async function openExport(page: Page, file = 'bilevel-mixed.pdf', pages = 4): Promise<Locator> {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(page.getByRole('option')).toHaveCount(pages, { timeout: 30_000 });
	return reopen(page);
}

async function reopen(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

const exportButton = (d: Locator) => d.getByRole('button', { name: 'Export', exact: true });

/** [bits per component, filter] of each page's first picture, read in Node by MuPDF. */
function pictures(bytes: Uint8Array): ([number, string] | null)[] {
	const doc = new mupdf.PDFDocument(bytes.slice());
	try {
		const out: ([number, string] | null)[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			let found: [number, string] | null = null;
			const xo = doc.findPage(i).getInheritable('Resources').get('XObject');
			if (xo.isDictionary())
				xo.forEach((v) => {
					if (found || !v.isStream() || v.get('Subtype').asName() !== 'Image') return;
					const f = v.get('Filter');
					found = [v.get('BitsPerComponent').asNumber(), f.isName() ? f.asName() : String(f)];
				});
			out.push(found);
		}
		return out;
	} finally {
		doc.destroy();
	}
}

test('a scanned file: the switch, its preview, the export and what it says', async ({ page }, info) => {
	test.setTimeout(120_000);
	const dialog = await openExport(page);
	await openMore(dialog);
	const option = dialog.getByRole('switch', { name: OPTION });
	await expect(option).toBeVisible({ timeout: 30_000 });
	await expect(option).not.toBeChecked();
	await expect(dialog.getByText(HINT)).toBeVisible();
	await option.click();
	// The preview: one page before and after, at 100%.
	const preview = dialog.getByTestId('bilevel-preview');
	await expect(preview.getByRole('img', { name: 'Part of a scanned page as it is now' })).toBeVisible({ timeout: 30_000 });
	await expect(preview.getByRole('img', { name: 'The same part in black and white, like a photocopy' })).toBeVisible();
	await expect(preview.getByText('Before', { exact: true })).toBeVisible();
	await expect(preview.getByText('After (like a photocopy)')).toBeVisible();
	const shots = '/tmp/claude-1000/-home-garrett-code/e509adfd-95d4-5840-9e96-afefdb3adbb8/scratchpad/bilevel';
	if (process.env.BILEVEL_SHOTS) {
		await preview.scrollIntoViewIfNeeded();
		await page.screenshot({ path: `${shots}/export-dialog-${info.project.name}.png` });
	}
	// Folded, the button names it.
	await moreButton(dialog).click();
	await expect(moreButton(dialog)).toHaveAccessibleName(/Black and white on/);
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 4 pages, opens cleanly.')).toBeVisible({ timeout: 90_000 });
	await expect(done.getByText('1 page made black and white.')).toBeVisible();
	await expect(done.getByText('2 pages were left as they were because they have colour, photos or faint marks.')).toBeVisible();
	await expect(done.getByText('Black and white pages: passed.', { exact: true })).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const out = new Uint8Array(readFileSync((await download.path())!));
	const pics = pictures(out);
	expect(pics[0]).toEqual([1, 'CCITTFaxDecode']);
	expect(pics[1]?.[0]).toBe(8);
	expect(pics[2]?.[0]).toBe(8);
	expect(pics[3]).toBeNull();
	expect(out.length).toBeLessThan(readFileSync(corpus('bilevel-mixed.pdf')).length);
});

test('not offered for a file without scanned pages, nor for Save as pictures', async ({ page }) => {
	let dialog = await openExport(page, 'multi.pdf', 6);
	await openMore(dialog);
	await expect(dialog.getByRole('switch', { name: 'Add a watermark' })).toBeVisible();
	await page.waitForTimeout(1500);
	await expect(dialog.getByRole('switch', { name: OPTION })).toHaveCount(0);
	await dialog.getByRole('button', { name: 'Cancel' }).click();

	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Start over' }).click();
	dialog = await openExport(page);
	await openMore(dialog);
	await expect(dialog.getByRole('switch', { name: OPTION })).toBeVisible({ timeout: 30_000 });
	await dialog.getByRole('radio', { name: 'JPG pictures' }).click();
	await expect(dialog.getByRole('switch', { name: OPTION })).toHaveCount(0);
});

test('switched off for new files, kept for the same work', async ({ page }) => {
	test.setTimeout(90_000);
	let dialog = await openExport(page);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: OPTION }).click();
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	// The same work: still on.
	dialog = await reopen(page);
	await expect(dialog.getByRole('switch', { name: OPTION })).toBeChecked({ timeout: 30_000 });
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	// A new job: off.
	await page.getByRole('button', { name: 'More actions' }).click();
	await page.getByRole('menuitem', { name: 'Start over' }).click();
	await expect(page.getByRole('option')).toHaveCount(0);
	await page.locator('input[type=file]').first().setInputFiles([corpus('bilevel-scans.pdf')]);
	await expect(page.getByRole('option')).toHaveCount(6, { timeout: 30_000 });
	dialog = await reopen(page);
	await openMore(dialog);
	const option = dialog.getByRole('switch', { name: OPTION });
	await expect(option).toBeVisible({ timeout: 30_000 });
	await expect(option).not.toBeChecked();
	await expect(dialog.getByTestId('bilevel-preview')).toHaveCount(0);
});

test('desktop: with "Make scanned pages searchable" too, the page is read and then made black and white', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop only');
	test.setTimeout(240_000);
	// Only the letter page: OCR reads it from the original picture.
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('bilevel-mixed.pdf')]);
	await expect(page.getByRole('option')).toHaveCount(4, { timeout: 30_000 });
	const dialog = await reopen(page);
	await openMore(dialog);
	await dialog.getByRole('switch', { name: 'Make scanned pages searchable' }).click({ timeout: 30_000 });
	await dialog.getByRole('switch', { name: OPTION }).click({ timeout: 30_000 });
	await exportButton(dialog).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 4 pages, opens cleanly.')).toBeVisible({ timeout: 200_000 });
	await expect(done.getByText(/made searchable/)).toBeVisible();
	await expect(done.getByText('1 page made black and white.')).toBeVisible();
	await expect(done.getByText('The searchable text reads back on every page that got it.', { exact: true })).toBeVisible();
	await expect(done.getByText('Black and white pages: passed.', { exact: true })).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const out = new Uint8Array(readFileSync((await download.path())!));
	expect(pictures(out)[0]).toEqual([1, 'CCITTFaxDecode']);
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: out.slice(), verbosity: 0, useWasm: false });
	try {
		const tc = await (await (await task.promise).getPage(1)).getTextContent();
		const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
		for (const w of ['Dear', 'house', 'Smith']) expect(text).toContain(w);
	} finally {
		await task.destroy();
	}
});
