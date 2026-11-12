/**
 * Keep filled blanks editable: text and ticks snapped into the blanks of a flat form
 * (tests/corpus/files/forms-snap.pdf, 612 × 792 pt: the "First name" line at y 102 from
 * x 130 to 290, the "Yes" square 130-139 × 259-268) become form fields at export, the
 * export reopens here as a fillable form, moving a stamp drops its link, and a restored
 * session keeps the links. Desktop and phone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, pageBox } from './editor-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const options = (page: Page) => page.getByRole('option');
const W = 612;
const H = 792;
const isPhone = (info: TestInfo) => info.project.name === 'phone';
const KEEP = 'Keep filled blanks editable';

async function tapAt(page: Page, info: TestInfo, x: number, y: number) {
	const b = await pageBox(page);
	const px = b.x + (x / W) * b.width;
	const py = b.y + (y / H) * b.height;
	if (isPhone(info)) await page.touchscreen.tap(px, py);
	else await page.mouse.click(px, py);
}

async function openPage(page: Page, index: number, total: number): Promise<Locator> {
	await options(page).nth(index).focus();
	await page.keyboard.press('Enter');
	const editor = page.getByRole('dialog', { name: new RegExp(`^Edit page ${index + 1} of ${total}`) });
	await expect(editor).toBeVisible();
	await page.waitForFunction(() => {
		const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-page] canvas');
		return !!c && c.width > 0 && getComputedStyle(c).visibility !== 'hidden';
	});
	return editor;
}

/**
 * Text tapped 16 pt above the "First name" line, typed, and checked on screen to sit on
 * the line (snapped). Until the page's blanks have been read the text lands plainly at
 * the tap: then it is undone and tried again.
 */
async function snapName(page: Page, info: TestInfo, text: string) {
	const box = page.getByRole('textbox', { name: 'Text on the page' });
	for (let attempt = 0; ; attempt++) {
		await chooseTool(page, 'Text');
		await page.waitForTimeout(attempt === 0 ? 1500 : 1000);
		await tapAt(page, info, 200, 86);
		if (isPhone(info)) await page.waitForTimeout(400);
		await expect(box).toBeFocused();
		await page.keyboard.type(text);
		await page.keyboard.press('Escape');
		await expect(box).toHaveCount(0);
		const b = await pageBox(page);
		const el = (await page.locator('[data-stamp] .txt').last().boundingBox())!;
		const bottomPt = ((el.y + el.height - b.y) / b.height) * H;
		if (bottomPt > 98 && bottomPt < 103.5) return;
		expect(attempt, 'the text never snapped to the line').toBeLessThan(15);
		await page.keyboard.press('Control+z');
		await expect(page.locator('[data-stamp]')).toHaveCount(0);
	}
}

/** A Check tap 2 pt right of the "Yes" square: the tick takes the square. */
async function snapYes(page: Page, info: TestInfo) {
	await chooseTool(page, 'Check');
	await tapAt(page, info, 141, 264.5);
	await page.keyboard.press('Escape');
	const b = await pageBox(page);
	const el = (await page.locator('[data-stamp]').last().boundingBox())!;
	expect((el.width / b.width) * W).toBeCloseTo(9, 0);
	expect(((el.x - b.x) / b.width) * W).toBeCloseTo(130, 0);
}

async function exportDialog(page: Page): Promise<Locator> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	return dialog;
}

async function cancel(dialog: Locator) {
	// The sheet slides in on phones: click once it has landed.
	await dialog.page().waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
	await dialog.getByRole('button', { name: 'Cancel' }).click();
	await expect(dialog).toBeHidden();
}

async function runExport(page: Page, dialog: Locator): Promise<{ bytes: Uint8Array; done: Locator }> {
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(/^Checked: \d+ pages?, opens cleanly\.$/)).toBeVisible({ timeout: 90_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	return { bytes: new Uint8Array(readFileSync((await download.path())!)), done };
}

async function closeDone(done: Locator) {
	await done.getByRole('button', { name: /^(Done|Close)$/ }).first().click();
	await expect(done).toBeHidden();
}

/** Field values read back with PDF.js in Node (checkboxes as true/false). */
async function readFields(bytes: Uint8Array): Promise<Record<string, unknown>> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: Record<string, unknown> = {};
		for (let i = 1; i <= doc.numPages; i++) {
			const annots = (await (await doc.getPage(i)).getAnnotations()) as { subtype: string; fieldName?: string; fieldValue?: unknown; checkBox?: boolean; exportValue?: string }[];
			for (const a of annots) {
				if (a.subtype !== 'Widget' || !a.fieldName) continue;
				out[a.fieldName] = a.checkBox ? a.fieldValue === a.exportValue : a.fieldValue;
			}
		}
		return out;
	} finally {
		await task.destroy();
	}
}

test('snapped text and a tick become form fields; the export reopens as a form and refills', async ({ page }, info) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('forms-snap.pdf')]);
	await expect(options(page)).toHaveCount(2, { timeout: 30_000 });

	// Nothing snapped yet: the option is not offered.
	let dialog = await exportDialog(page);
	await expect(dialog.getByRole('switch', { name: KEEP })).toHaveCount(0);
	await cancel(dialog);

	const editor = await openPage(page, 0, 2);
	await snapName(page, info, 'Jane Émile');
	await snapYes(page, info);
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();

	dialog = await exportDialog(page);
	const keep = dialog.getByRole('switch', { name: KEEP });
	await expect(keep).toBeVisible();
	await expect(keep).not.toBeChecked();
	await expect(dialog.getByText('The 2 blanks you filled become form fields, so the next person can change them.')).toBeVisible();
	await keep.click();
	const first = await runExport(page, dialog);
	await expect(first.done.getByText('2 blanks are now form fields.', { exact: true })).toBeVisible();
	await expect(first.done.getByText('Every filled blank is a form field with your answer.')).toBeVisible();
	expect(await readFields(first.bytes)).toEqual({ blank_p1_1: 'Jane Émile', blank_p1_2: true });
	await closeDone(first.done);

	// Open the export on its own: its fields are filled through the form, not snapped.
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([{ name: 'filled.pdf', mimeType: 'application/pdf', buffer: Buffer.from(first.bytes) }]);
	await expect(options(page)).toHaveCount(2, { timeout: 30_000 });
	await expect(page.getByText('filled.pdf has a form you can fill in.', { exact: false })).toBeVisible();
	const again = await openPage(page, 0, 2);
	const name = page.getByRole('textbox', { name: 'blank_p1_1' });
	await expect(name).toHaveValue('Jane Émile');
	await expect(page.getByRole('checkbox', { name: 'blank_p1_2' })).toBeChecked();
	await name.fill('Janet Müller');
	await page.getByRole('checkbox', { name: 'blank_p1_2' }).click();
	await again.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(again).toBeHidden();
	dialog = await exportDialog(page);
	await expect(dialog.getByRole('switch', { name: KEEP })).toHaveCount(0);
	await expect(dialog.getByRole('switch', { name: 'Lock form answers' })).not.toBeChecked();
	const second = await runExport(page, dialog);
	await expect(second.done.getByText('Every form answer is in the file.')).toBeVisible();
	expect(await readFields(second.bytes)).toEqual({ blank_p1_1: 'Janet Müller', blank_p1_2: false });
});

test('a restored session keeps the links; moving a stamp drops its link', async ({ page }, info) => {
	test.setTimeout(240_000);
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('forms-snap.pdf')]);
	await expect(options(page)).toHaveCount(2, { timeout: 30_000 });
	let editor = await openPage(page, 0, 2);
	await snapName(page, info, 'Jane');
	await snapYes(page, info);
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();

	// Saved, reloaded, restored.
	await expect(page.getByTestId('save-line')).toContainText('Saved on this device only.');
	await page.waitForTimeout(1500);
	await page.reload();
	const card = page.getByRole('region', { name: 'Pick up where you left off?' });
	await card.getByRole('button', { name: 'Restore' }).click();
	await expect(options(page)).toHaveCount(2, { timeout: 30_000 });
	let dialog = await exportDialog(page);
	await expect(dialog.getByText('The 2 blanks you filled become form fields, so the next person can change them.')).toBeVisible();
	await cancel(dialog);

	// Nudge the text one step: it no longer counts as the answer for its blank.
	editor = await openPage(page, 0, 2);
	const text = page.locator('[data-stamp]').first();
	await text.focus();
	await page.keyboard.press('ArrowRight');
	await page.keyboard.press('Escape');
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();
	dialog = await exportDialog(page);
	await expect(dialog.getByText('The blank you filled becomes a form field, so the next person can change it.')).toBeVisible();
	const keep = dialog.getByRole('switch', { name: KEEP });
	if (!(await keep.isChecked())) await keep.click();
	const out = await runExport(page, dialog);
	await expect(out.done.getByText('1 blank is now a form field.', { exact: true })).toBeVisible();
	expect(await readFields(out.bytes)).toEqual({ blank_p1_1: true });
});
