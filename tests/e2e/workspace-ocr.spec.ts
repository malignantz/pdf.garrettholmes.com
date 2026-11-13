/**
 * "Make scanned pages searchable" in the export dialog (desktop only). The fixture
 * blocks every request to another origin and fails the test if one is attempted, so
 * these tests also prove the OCR engine and its data come from the site itself.
 * Corpus: tests/corpus/generate-ocr.mjs (p1 and p8 readable scans, p2 sideways, p3
 * made-up words, p4–p7 not scans or too coarse).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const OPTION = 'Make scanned pages searchable';

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const tc = await (await doc.getPage(i)).getTextContent();
			out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim());
		}
		return out;
	} finally {
		await task.destroy();
	}
}

/** Every page rendered by MuPDF in Node (grey, 1 px per point). */
function renders(bytes: Uint8Array): string[] {
	const doc = new mupdf.PDFDocument(bytes.slice());
	try {
		const out: string[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			const pix = doc.loadPage(i).toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceGray, false, true);
			out.push(Buffer.from(pix.getPixels()).toString('base64'));
			pix.destroy();
		}
		return out;
	} finally {
		doc.destroy();
	}
}

async function openExport(page: Page, file = 'ocr-scans.pdf', pages = 8): Promise<Locator> {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(page.getByRole('option')).toHaveCount(pages, { timeout: 30_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

const exportButton = (d: Locator) => d.getByRole('button', { name: 'Export', exact: true });

test('desktop: scanned pages become searchable; unreadable ones stay exactly as they were; everything from this site', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop only');
	test.setTimeout(180_000);
	const ocrFiles: string[] = [];
	page.context().on('request', (r) => {
		if (/tesseract-core|traineddata|\/worker\.min-/.test(r.url())) ocrFiles.push(new URL(r.url()).pathname);
	});
	const dialog = await openExport(page);
	const option = dialog.getByRole('switch', { name: OPTION });
	await expect(option).toBeVisible({ timeout: 30_000 });
	await expect(option).not.toBeChecked();
	await expect(dialog.getByText('Reads typed English on scanned pages so you can search and copy the text. The pages look the same.')).toBeVisible();
	// Nothing of the OCR engine is loaded until the option is used.
	expect(ocrFiles).toEqual([]);
	await option.click();
	await exportButton(dialog).click();
	await expect(page.getByText(/^Reading page \d+ of 4$/)).toBeVisible({ timeout: 60_000 });
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 8 pages, opens cleanly.')).toBeVisible({ timeout: 150_000 });
	await expect(done.getByText('2 pages made searchable. 2 pages were left as they were because the text could not be read well enough.')).toBeVisible();
	await expect(done.getByText('The searchable text reads back on every page that got it.')).toBeVisible();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const out = new Uint8Array(readFileSync((await download.path())!));
	const texts = await pageTexts(out);
	for (const w of ['Dear', 'house', 'offer.', 'builder.', 'Smith']) {
		expect(texts[0]).toContain(w);
		expect(texts[7]).toContain(w);
	}
	// Declined (sideways, made-up words) and untried pages: no new text, same pixels.
	const before = renders(new Uint8Array(readFileSync(corpus('ocr-scans.pdf'))));
	const after = renders(out);
	expect(texts.slice(1, 4)).toEqual(['', '', '']);
	for (let i = 0; i < 8; i++) expect(after[i] === before[i], `page ${i + 1} pixels`).toBe(true);
	// The engine and data came from this site (other origins are blocked by the fixture), one core of each kind.
	expect(ocrFiles.some((p) => /^\/_app\/immutable\/workers\/assets\/eng\.traineddata-/.test(p))).toBe(true);
	expect(ocrFiles.some((p) => /^\/_app\/immutable\/workers\/assets\/osd\.traineddata-/.test(p))).toBe(true);
	expect(ocrFiles.filter((p) => /tesseract-core-[\w-]*lstm\.wasm-/.test(p)).length).toBeGreaterThan(0);
});

test('phone: the option is not offered', async ({ page }, info) => {
	test.skip(info.project.name !== 'phone', 'phone only');
	test.setTimeout(60_000);
	const dialog = await openExport(page);
	await expect(dialog.getByRole('switch', { name: 'Add a password' })).toBeVisible();
	// Give the engine time to answer, had it been asked.
	await page.waitForTimeout(1500);
	await expect(dialog.getByRole('switch', { name: OPTION })).toHaveCount(0);
	await expect(dialog.getByText(/scanned pages/)).toHaveCount(0);
});

test('desktop: a file without scanned pages does not show the option', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop only');
	const dialog = await openExport(page, 'multi.pdf', 6);
	await expect(dialog.getByRole('switch', { name: 'Add a password' })).toBeVisible();
	await page.waitForTimeout(1500);
	await expect(dialog.getByRole('switch', { name: OPTION })).toHaveCount(0);
});

test('desktop: cancel while reading leaves nothing made, and the next export works', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop only');
	test.setTimeout(180_000);
	const dialog = await openExport(page);
	await dialog.getByRole('switch', { name: OPTION }).click();
	await exportButton(dialog).click();
	await expect(page.getByText(/^Reading page \d+ of 4$/)).toBeVisible({ timeout: 60_000 });
	await page.getByRole('button', { name: 'Cancel', exact: true }).click();
	const form = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(form.getByText('Export cancelled. Nothing was saved.')).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(0);
	// The option stays as chosen; turn it off and export normally.
	await expect(form.getByRole('switch', { name: OPTION })).toBeChecked();
	await form.getByRole('switch', { name: OPTION }).click();
	await exportButton(form).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 8 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	await expect(done.getByText(/made searchable/)).toHaveCount(0);
});

test('desktop: after one use the OCR engine works offline', async ({ page, context }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop only');
	test.setTimeout(240_000);
	await page.goto('/');
	await page.waitForFunction(async () => {
		const reg = await navigator.serviceWorker.ready;
		return !!reg.active && !!navigator.serviceWorker.controller;
	});
	let dialog = await openExport(page);
	await dialog.getByRole('switch', { name: OPTION }).click();
	await exportButton(dialog).click();
	let done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('2 pages made searchable.', { exact: false })).toBeVisible({ timeout: 150_000 });
	await context.setOffline(true);
	await page.reload();
	await page.locator('input[type=file]').first().setInputFiles([corpus('ocr-scans.pdf')]);
	await expect(page.getByRole('option')).toHaveCount(8, { timeout: 30_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	dialog = page.getByRole('dialog', { name: 'Export PDF' });
	const option = dialog.getByRole('switch', { name: OPTION });
	await expect(option).toBeVisible({ timeout: 30_000 });
	if (!(await option.isChecked())) await option.click();
	await exportButton(dialog).click();
	done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('2 pages made searchable.', { exact: false })).toBeVisible({ timeout: 150_000 });
	await context.setOffline(false);
});
