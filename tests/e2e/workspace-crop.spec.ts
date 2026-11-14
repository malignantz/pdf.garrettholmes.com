/**
 * Crop: the editor's Crop tool (drag a frame, its corners and edges; keyboard edges), apply
 * to this page / selected / all, the honest line, thumbnails and the editor show the
 * cropped page, undo, a crop never hides a mark, reset, saved work keeps it, and the
 * export's pages show exactly the chosen part (read back with PDF.js).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, pageBox, tapPage } from './editor-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const shots = process.env.CW_SHOTS;
const HONEST = 'Crop hides the edges. It does not remove what is there: use Redact to remove something for good.';
const options = (page: Page) => page.getByRole('option');

async function openFile(page: Page, file = 'multi.pdf', count = 6) {
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus(file)]);
	await expect(options(page)).toHaveCount(count, { timeout: 30_000 });
}

async function openEditorAt(page: Page, index: number, count = 6) {
	await options(page).nth(index).focus();
	await page.keyboard.press('Enter');
	await expect(page.getByRole('dialog', { name: new RegExp(`^Edit page ${index + 1} of ${count}`) })).toBeVisible();
	await page.waitForFunction(() => {
		const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-page] canvas');
		return !!c && c.width > 0 && getComputedStyle(c).visibility !== 'hidden';
	});
}

/** Drag from one point to another with the mouse (pointer events), in steps. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, release = true) {
	await page.mouse.move(from.x, from.y);
	await page.mouse.down();
	for (let i = 1; i <= 8; i++) await page.mouse.move(from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
	if (release) await page.mouse.up();
}

/** PDF.js's view box [x0 y0 x1 y1] of every page of an export. */
async function views(bytes: Uint8Array): Promise<number[][]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: number[][] = [];
		for (let i = 1; i <= doc.numPages; i++) out.push([...(await doc.getPage(i)).view]);
		return out;
	} finally {
		await task.destroy();
	}
}

async function exportAll(page: Page): Promise<Uint8Array> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Every cropped page shows the part you chose.')).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = readFileSync((await download.path())!);
	await done.getByRole('button', { name: 'Close', exact: true }).last().click();
	return bytes;
}

test('crop one page with the frame: honest line, cropped in the editor and the grid, exported exactly, undo', async ({ page }) => {
	test.setTimeout(120_000);
	await openFile(page);
	await openEditorAt(page, 0);
	const before = await pageBox(page);
	await chooseTool(page, 'Crop');
	await expect(page.getByTestId('crop-note')).toHaveText(HONEST);
	const frame = page.getByTestId('crop-frame');
	await expect(frame).toBeVisible();
	// Bottom-right corner in by a quarter, then the top edge down by a tenth (multi.pdf is 612 × 792).
	let b = await pageBox(page);
	const se = page.locator('[data-grip=se]');
	const s = (await se.boundingBox())!;
	await drag(page, { x: s.x + s.width / 2, y: s.y + s.height / 2 }, { x: s.x + s.width / 2 - 0.25 * b.width, y: s.y + s.height / 2 - 0.25 * b.height });
	const n = (await page.locator('[data-grip=n]').boundingBox())!;
	await drag(page, { x: n.x + n.width / 2, y: n.y + n.height / 2 }, { x: n.x + n.width / 2, y: n.y + n.height / 2 + 0.1 * b.height });
	b = await pageBox(page);
	const f = (await frame.boundingBox())!;
	expect((f.width / b.width) * 100).toBeCloseTo(75, -1);
	expect((f.height / b.height) * 100).toBeCloseTo(65, -1);
	await page.getByTestId('crop-bar').getByRole('button', { name: 'Crop', exact: true }).click();
	await expect(frame).toBeHidden();
	await expect(page.getByTestId('live')).toContainText('Cropped the page.');
	// The editor now shows the cropped page: its shape is 0.75·612 by 0.65·792.
	await expect.poll(async () => {
		const a = await pageBox(page);
		return Math.round((a.width / a.height) * 100) / 100;
	}).toBeCloseTo((0.75 * 612) / (0.65 * 792), 1);
	expect(before.width).toBeGreaterThan(0);
	// The whole page is drawn larger than the box and shifted, so exactly the part shows.
	const drawn = (await page.getByTestId('editor-page').locator('canvas').boundingBox())!;
	const shown = await pageBox(page);
	expect(drawn.width / shown.width).toBeCloseTo(1 / 0.75, 1);
	expect(drawn.height / shown.height).toBeCloseTo(1 / 0.65, 1);
	expect((shown.y - drawn.y) / drawn.height).toBeCloseTo(0.1, 1);
	await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
	await expect(options(page).nth(0)).toHaveAttribute('aria-label', /cropped/);
	await expect(options(page).nth(1)).not.toHaveAttribute('aria-label', /cropped/);

	const v = await views(await exportAll(page));
	expect(v[0][2] - v[0][0]).toBeCloseTo(0.75 * 612, -1);
	expect(v[0][3] - v[0][1]).toBeCloseTo(0.65 * 792, -1);
	// The top-left corner stays; the top edge moved down: the view starts at the page's left and ends 10% below its top.
	expect(v[0][0]).toBeCloseTo(0, 0);
	expect(v[0][3]).toBeCloseTo(0.9 * 792, -1);
	expect(v[1]).toEqual([0, 0, 612, 792]);

	// Undo in the grid brings the whole page back.
	await page.getByRole('button', { name: /^Undo/ }).first().click();
	await expect(options(page).nth(0)).not.toHaveAttribute('aria-label', /cropped/);
});

test('keyboard edges, all pages; a crop never hides a mark; reset; kept by saved work', async ({ page }, info) => {
	test.skip(info.project.name === 'phone', 'keyboard');
	test.setTimeout(150_000);
	await openFile(page);
	// A redaction box near the left edge of page 2.
	await openEditorAt(page, 1);
	await chooseTool(page, 'Redact');
	await tapPage(page, 0.2, 0.5);
	await page.keyboard.press('Escape');
	await chooseTool(page, 'Crop');
	const left = page.getByRole('slider', { name: 'Left edge' });
	await left.focus();
	for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight');
	await expect(left).toHaveAttribute('aria-valuenow', '30');
	const top = page.getByRole('slider', { name: 'Top edge' });
	await top.focus();
	await page.keyboard.press('ArrowDown');
	await page.keyboard.press('ArrowDown');
	await expect(top).toHaveAttribute('aria-valuenow', '2');
	const bar = page.getByTestId('crop-bar');
	await bar.getByRole('radio', { name: 'All pages (6)' }).click();
	await bar.getByRole('button', { name: 'Crop', exact: true }).click();
	await expect(page.getByTestId('editor-note')).toContainText('Cropped 5 pages. Not cropped: page 2, because the crop would hide a mark there.');
	await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
	for (const i of [0, 2, 3, 4, 5]) await expect(options(page).nth(i)).toHaveAttribute('aria-label', /cropped/);
	await expect(options(page).nth(1)).not.toHaveAttribute('aria-label', /cropped/);

	// Reset on page 3.
	await openEditorAt(page, 2);
	await chooseTool(page, 'Crop');
	await page.getByTestId('crop-bar').getByRole('button', { name: 'Reset crop' }).click();
	await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
	await expect(options(page).nth(2)).not.toHaveAttribute('aria-label', /cropped/);

	// Saved work keeps the crops.
	await expect(page.getByTestId('save-line')).toContainText('Saved on this device only.', { timeout: 10_000 });
	await page.waitForTimeout(2500);
	await page.reload();
	await page.getByRole('region', { name: 'Pick up where you left off?' }).getByRole('button', { name: 'Restore' }).click();
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	const labels = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
	expect(labels.map((l) => /cropped/.test(l))).toEqual([true, false, false, true, true, true]);
	const v = await views(await exportAll(page));
	expect(v[0][0]).toBeCloseTo(0.3 * 612, 0);
	expect(v[0][3]).toBeCloseTo(0.98 * 792, 0);
	expect(v[1]).toEqual([0, 0, 612, 792]);
});

test('crop selected pages from the grid', async ({ page }) => {
	test.setTimeout(120_000);
	await openFile(page);
	await options(page).nth(2).focus();
	await page.keyboard.press(' ');
	await page.keyboard.press('Shift+ArrowRight');
	await page.getByRole('button', { name: 'More for selected pages' }).first().click();
	await page.getByRole('menuitem', { name: 'Crop selected pages' }).click();
	await expect(page.getByTestId('crop-frame')).toBeVisible({ timeout: 15_000 });
	const bar = page.getByTestId('crop-bar');
	await expect(bar.getByRole('radio', { name: 'Selected (2)' })).toHaveAttribute('aria-checked', 'true');
	// A new frame drawn across the middle of the page.
	const b = await pageBox(page);
	await drag(page, { x: b.x + 0.1 * b.width, y: b.y + 0.2 * b.height }, { x: b.x + 0.9 * b.width, y: b.y + 0.7 * b.height });
	await bar.getByRole('button', { name: 'Crop', exact: true }).click();
	await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
	const labels = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
	expect(labels.map((l) => /cropped/.test(l))).toEqual([false, false, true, true, false, false]);
});

for (const [name, viewport] of [
	['desktop', { width: 1280, height: 900 }],
	['phone', { width: 360, height: 740 }]
] as const) {
	test(`crop shots ${name}`, async ({ browser, baseURL }, info) => {
		test.skip(!shots || info.project.name !== 'desktop-chrome', 'set CW_SHOTS (taken once, in the desktop project)');
		test.setTimeout(120_000);
		const ctx = await browser.newContext({ baseURL, viewport, deviceScaleFactor: 2, hasTouch: name === 'phone', isMobile: name === 'phone' });
		const page = await ctx.newPage();
		await openFile(page, 'crop-odd.pdf', 3);
		await openEditorAt(page, 2, 3);
		await chooseTool(page, 'Crop');
		const b = await pageBox(page);
		const se = (await page.locator('[data-grip=se]').boundingBox())!;
		// Mid-drag: the corner held, the frame following.
		await drag(page, { x: se.x + se.width / 2, y: se.y + se.height / 2 }, { x: se.x + se.width / 2 - 0.2 * b.width, y: se.y + se.height / 2 - 0.3 * b.height }, false);
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${shots}/crop-drag-${name}.png` });
		await page.mouse.up();
		await page.getByTestId('crop-bar').getByRole('button', { name: 'Crop', exact: true }).click();
		await page.waitForTimeout(600);
		await page.screenshot({ path: `${shots}/crop-result-editor-${name}.png` });
		await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
		await page.waitForTimeout(800);
		await page.screenshot({ path: `${shots}/crop-result-grid-${name}.png` });
		await ctx.close();
	});
}
