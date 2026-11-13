/**
 * Export as pictures (JPG, PNG) and split into several files (one zip). The PDFs are
 * made here with pdf-lib; zips are unpacked with the system `unzip` and every file is
 * opened independently (PDF.js for PDFs, MuPDF for pictures). Desktop and phone.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as mupdf from 'mupdf';
import { PDFDocument, StandardFonts, rgb } from '@cantoo/pdf-lib';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, pageBox } from './editor-helpers';

const isPhone = (info: TestInfo) => info.project.name === 'phone';

/** Letter pages with "Page n" in big type, and a pale blue band so pictures are not blank. */
async function makePdf(pages: number): Promise<Buffer> {
	const doc = await PDFDocument.create({ updateMetadata: false });
	const font = await doc.embedFont(StandardFonts.Helvetica);
	for (let i = 0; i < pages; i++) {
		const p = doc.addPage([612, 792]);
		p.drawRectangle({ x: 0, y: 600, width: 612, height: 120, color: rgb(0.8, 0.88, 1) });
		p.drawText(`Page ${i + 1}`, { x: 72, y: 650, size: 36, font });
		// Under the editor's default redaction box (a tap in the middle of the page).
		p.drawText('SECRET NUMBER 4242', { x: 230, y: 392, size: 14, font, color: rgb(0.8, 0, 0) });
	}
	return Buffer.from(await doc.save());
}

async function openFile(page: Page, name: string, bytes: Buffer, count: number) {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([{ name, mimeType: 'application/pdf', buffer: bytes }]);
	await expect(page.getByRole('option')).toHaveCount(count, { timeout: 30_000 });
}

async function exportDialog(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: /^Export/ });
	await expect(dialog).toBeVisible();
	// The sheet slides in on phones: click once it has landed.
	await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
	return dialog;
}

async function download(page: Page, done: Locator): Promise<{ name: string; bytes: Buffer }> {
	const [d] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	return { name: d.suggestedFilename(), bytes: readFileSync((await d.path())!) };
}

/** Unpacks with the system unzip (which checks every CRC); returns name -> bytes in zip order. */
function unzip(bytes: Buffer): [string, Buffer][] {
	const dir = mkdtempSync(path.join(tmpdir(), 'e2e-zip-'));
	const file = path.join(dir, 'in.zip');
	writeFileSync(file, bytes);
	expect(execFileSync('unzip', ['-t', file], { encoding: 'utf8' })).toMatch(/No errors detected/);
	const list = execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).trim().split('\n');
	execFileSync('unzip', ['-q', file, '-d', path.join(dir, 'x')]);
	expect(readdirSync(path.join(dir, 'x')).sort()).toEqual([...list].sort());
	return list.map((n) => [n, readFileSync(path.join(dir, 'x', n))]);
}

/** Width and height from a JPEG's SOF marker (and that it is a baseline/progressive JPEG). */
function jpegSize(b: Buffer): { width: number; height: number } {
	expect(b.readUInt16BE(0)).toBe(0xffd8);
	let at = 2;
	while (at < b.length) {
		const marker = b.readUInt16BE(at);
		const len = b.readUInt16BE(at + 2);
		if (marker >= 0xffc0 && marker <= 0xffc2) return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
		at += 2 + len;
	}
	throw new Error('no SOF marker');
}

async function pdfPages(bytes: Uint8Array, password?: string): Promise<string[]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), password, verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: string[] = [];
		for (let i = 1; i <= doc.numPages; i++) {
			const tc = await (await doc.getPage(i)).getTextContent();
			out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
		}
		return out;
	} finally {
		await task.destroy();
	}
}

test('3 pages as JPG pictures: one zip of 3 JPEGs at 150 dpi, in page order', async ({ page }) => {
	test.setTimeout(120_000);
	await openFile(page, 'three.pdf', await makePdf(3), 3);
	const dialog = await exportDialog(page);
	await dialog.getByRole('radio', { name: 'JPG pictures' }).click();
	await expect(dialog.getByRole('radio', { name: 'Screen (150 dpi)' })).toBeChecked();
	// PDF-only options are gone; page numbers stay.
	await expect(dialog.getByRole('switch', { name: 'Optimize' })).toHaveCount(0);
	await expect(dialog.getByRole('switch', { name: 'Add a password' })).toHaveCount(0);
	await expect(dialog.getByRole('switch', { name: 'Split into several files' })).toHaveCount(0);
	await expect(dialog.getByRole('switch', { name: 'Number the pages' })).toBeVisible();
	await expect(dialog.getByLabel('File name')).toHaveValue('three-edited.zip');
	await expect(dialog.getByText('A zip of three-edited-001.jpg to three-edited-003.jpg, in page order.')).toBeVisible();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();

	const done = page.getByRole('dialog', { name: 'Your pictures are ready' });
	await expect(done.getByText(/^3 pictures in one zip, \d+ KB$/)).toBeVisible({ timeout: 60_000 });
	await expect(done.getByText('Checked: 3 pages, opens cleanly.')).toBeVisible();
	const file = await download(page, done);
	expect(file.name).toBe('three-edited.zip');
	const entries = unzip(file.bytes);
	expect(entries.map(([n]) => n)).toEqual(['three-edited-001.jpg', 'three-edited-002.jpg', 'three-edited-003.jpg']);
	for (const [, b] of entries) {
		expect(jpegSize(b)).toEqual({ width: 1275, height: 1650 });
		const pix = new mupdf.Image(b).toPixmap();
		expect([pix.getWidth(), pix.getHeight()]).toEqual([1275, 1650]);
		// White background in the corner, the blue band where it was drawn.
		const px = pix.getPixels();
		const n = pix.getNumberOfComponents();
		const at = (x: number, y: number) => Array.from(px.subarray((y * 1275 + x) * n, (y * 1275 + x) * n + 3));
		expect(at(5, 1640).every((v) => v > 245)).toBe(true);
		const band = at(1200, Math.round((792 - 660) * (150 / 72)));
		expect(band[2]).toBeGreaterThan(band[0] + 20);
		pix.destroy();
	}
});

test('a page with a redaction saved as PNG: the area is solid black, the text gone', async ({ page }, info) => {
	test.setTimeout(120_000);
	await openFile(page, 'secret.pdf', await makePdf(1), 1);
	// Redact the middle of the page (a tap makes a one-line box there).
	await page.getByRole('option').first().focus();
	await page.keyboard.press('Enter');
	const editor = page.getByRole('dialog', { name: /^Edit page 1 of 1/ });
	await expect(editor).toBeVisible();
	await page.waitForFunction(() => {
		const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-page] canvas');
		return !!c && c.width > 0 && getComputedStyle(c).visibility !== 'hidden';
	});
	await chooseTool(page, 'Redact');
	const b = await pageBox(page);
	if (isPhone(info)) await page.touchscreen.tap(b.x + 0.5 * b.width, b.y + 0.5 * b.height);
	else await page.mouse.click(b.x + 0.5 * b.width, b.y + 0.5 * b.height);
	const stamp = page.locator('[data-stamp]').first();
	await expect(stamp).toBeVisible();
	const s = (await stamp.boundingBox())!;
	const box = { x: (s.x - b.x) / b.width, y: (s.y - b.y) / b.height, w: s.width / b.width, h: s.height / b.height };
	await page.keyboard.press('Escape');
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();

	const dialog = await exportDialog(page);
	await dialog.getByRole('radio', { name: 'PNG pictures' }).click();
	await expect(dialog.getByText('1 area will be redacted. What is under it is removed from the file before the pictures are drawn.')).toBeVisible();
	await expect(dialog.getByLabel('File name')).toHaveValue('secret-edited.png');
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your picture is ready' });
	await expect(done.getByText(/^1 picture, \d+ KB$/)).toBeVisible({ timeout: 60_000 });
	// The picture is drawn from the verified, redacted PDF.
	await expect(done.getByText('Nothing can be read under the blacked-out areas.')).toBeVisible();
	const file = await download(page, done);
	expect(file.name).toBe('secret-edited.png');
	expect(file.bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
	const pix = new mupdf.Image(file.bytes).toPixmap();
	const W = pix.getWidth();
	const H = pix.getHeight();
	expect([W, H]).toEqual([1275, 1650]);
	const px = pix.getPixels();
	const n = pix.getNumberOfComponents();
	// Inside the box (a margin in from its edges for the stamp's outline): every pixel black.
	let worst = 0;
	let reds = 0;
	for (let y = Math.ceil((box.y + box.h * 0.2) * H); y < (box.y + box.h * 0.8) * H; y++) {
		for (let x = Math.ceil((box.x + box.w * 0.05) * W); x < (box.x + box.w * 0.95) * W; x++) {
			const i = (y * W + x) * n;
			worst = Math.max(worst, px[i], px[i + 1], px[i + 2]);
		}
	}
	for (let i = 0; i < px.length; i += n) if (px[i] > 150 && px[i + 1] < 80 && px[i + 2] < 80) reds++;
	pix.destroy();
	expect(worst).toBeLessThan(10);
	// The red secret text is nowhere in the picture.
	expect(reds).toBe(0);
});

test('split every 2 pages of 5: one zip of 3 PDFs with 2, 2 and 1 pages', async ({ page }) => {
	test.setTimeout(120_000);
	await openFile(page, 'five.pdf', await makePdf(5), 5);
	const dialog = await exportDialog(page);
	await expect(dialog.getByRole('radio', { name: 'PDF' })).toBeChecked();
	await dialog.getByRole('switch', { name: 'Split into several files' }).click();
	await dialog.getByLabel('How to split').selectOption({ label: 'Every N pages' });
	await dialog.getByLabel('Pages per file').fill('5');
	await expect(dialog.getByRole('alert').filter({ hasText: 'That makes one file. Choose fewer than 5 pages.' })).toBeVisible();
	await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeDisabled();
	await dialog.getByLabel('Pages per file').fill('2');
	await expect(dialog.getByText('Makes 3 files in one zip: pages 1–2, pages 3–4, page 5.')).toBeVisible();
	await expect(dialog.getByLabel('File name')).toHaveValue('five-edited.zip');
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();

	const done = page.getByRole('dialog', { name: 'Your files are ready' });
	await expect(done.getByText('Checked: 3 files, 5 pages in all, each opens cleanly.')).toBeVisible({ timeout: 90_000 });
	await expect(done.getByText(/^3 files in one zip, \d+ KB$/)).toBeVisible();
	const file = await download(page, done);
	expect(file.name).toBe('five-edited.zip');
	const entries = unzip(file.bytes);
	expect(entries.map(([n]) => n)).toEqual(['five-edited-part-01.pdf', 'five-edited-part-02.pdf', 'five-edited-part-03.pdf']);
	const texts = await Promise.all(entries.map(([, b]) => pdfPages(b)));
	expect(texts.map((t) => t.length)).toEqual([2, 2, 1]);
	expect(texts.flat().map((t) => t.match(/Page \d/)?.[0])).toEqual(['Page 1', 'Page 2', 'Page 3', 'Page 4', 'Page 5']);
	// Back to one PDF: the extension follows.
	await done.getByRole('button', { name: 'Close', exact: true }).last().click();
	const again = await exportDialog(page);
	await expect(again.getByRole('switch', { name: 'Split into several files' })).toBeChecked();
	await again.getByRole('switch', { name: 'Split into several files' }).click();
	await expect(again.getByLabel('File name')).toHaveValue('five-edited.pdf');
});

test('split with a password and page numbers: every file needs the password, numbers continue', async ({ page }) => {
	test.setTimeout(120_000);
	await openFile(page, 'five.pdf', await makePdf(5), 5);
	const dialog = await exportDialog(page);
	await dialog.getByRole('switch', { name: 'Split into several files' }).click();
	await dialog.getByLabel('How to split').selectOption({ label: 'At these pages' });
	await dialog.getByLabel('New file starts at pages').fill('3');
	await expect(dialog.getByText('Makes 2 files in one zip: pages 1–2, pages 3–5.')).toBeVisible();
	await dialog.getByRole('switch', { name: 'Number the pages' }).click();
	await expect(dialog.getByText('Numbers continue from one file to the next.')).toBeVisible();
	await dialog.getByRole('switch', { name: 'Add a password' }).click();
	await dialog.getByLabel('Password', { exact: true }).fill('split pw');
	await dialog.getByLabel('Confirm password').fill('split pw');
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();

	const done = page.getByRole('dialog', { name: 'Your files are ready' });
	await expect(done.getByText('Checked: 2 files, 5 pages in all, each opens cleanly.')).toBeVisible({ timeout: 90_000 });
	await expect(done.getByText('It opens only with your password.')).toBeVisible();
	const entries = unzip((await download(page, done)).bytes);
	expect(entries.map(([n]) => n)).toEqual(['five-edited-part-01.pdf', 'five-edited-part-02.pdf']);
	const labels: string[] = [];
	for (const [, b] of entries) {
		await expect(pdfPages(b)).rejects.toThrow(/password/i);
		for (const t of await pdfPages(b, 'split pw')) labels.push(t.match(/Page \d of \d/)?.[0] ?? '');
	}
	expect(labels).toEqual(['Page 1 of 5', 'Page 2 of 5', 'Page 3 of 5', 'Page 4 of 5', 'Page 5 of 5']);
});
