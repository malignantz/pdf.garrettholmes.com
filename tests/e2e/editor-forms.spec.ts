/** Filling AcroForm fields in the page editor: controls over widgets, preview, undo, export. */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Locator, Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, openEditor, pageBox } from './editor-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));

type Values = Record<string, Record<string, unknown>>;

/** Form answers of the only open source. */
async function answers(page: Page): Promise<Record<string, unknown>> {
	const all = (await page.evaluate(
		() => (window as unknown as { __editor: { store: { state: { formValues: Values } } } }).__editor.store.state.formValues
	)) as Values;
	return Object.values(all)[0] ?? {};
}

interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/**
 * Dark pixels of a canvas inside a rectangle given in page (client) coordinates,
 * shrunk by `inset` px on every side. Copies the canvas first: a `bitmaprenderer`
 * canvas cannot be read directly.
 */
async function inkIn(canvas: Locator, rect: Rect, inset = 3, below = 300): Promise<number> {
	return canvas.evaluate(
		(el, { rect, inset, below }) => {
			const c = el as HTMLCanvasElement;
			const r = c.getBoundingClientRect();
			const sx = c.width / r.width;
			const sy = c.height / r.height;
			const copy = document.createElement('canvas');
			copy.width = c.width;
			copy.height = c.height;
			const g = copy.getContext('2d')!;
			g.drawImage(c, 0, 0);
			const x0 = Math.max(0, Math.round((rect.x + inset - r.left) * sx));
			const y0 = Math.max(0, Math.round((rect.y + inset - r.top) * sy));
			const x1 = Math.min(c.width, Math.round((rect.x + rect.width - inset - r.left) * sx));
			const y1 = Math.min(c.height, Math.round((rect.y + rect.height - inset - r.top) * sy));
			if (x1 <= x0 || y1 <= y0) return 0;
			const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
			let n = 0;
			for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] < below) n++;
			return n;
		},
		{ rect, inset, below }
	);
}

/**
 * Bounding box (client px) of the dark pixels of a canvas within `around` (client px).
 * Used to find the drawn border of a widget near its control.
 */
async function darkBox(canvas: Locator, around: Rect): Promise<Rect | null> {
	return canvas.evaluate((el, around) => {
		const c = el as HTMLCanvasElement;
		const r = c.getBoundingClientRect();
		const sx = c.width / r.width;
		const sy = c.height / r.height;
		const copy = document.createElement('canvas');
		copy.width = c.width;
		copy.height = c.height;
		const g = copy.getContext('2d')!;
		g.drawImage(c, 0, 0);
		const x0 = Math.max(0, Math.round((around.x - r.left) * sx));
		const y0 = Math.max(0, Math.round((around.y - r.top) * sy));
		const x1 = Math.min(c.width, Math.round((around.x + around.width - r.left) * sx));
		const y1 = Math.min(c.height, Math.round((around.y + around.height - r.top) * sy));
		const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data;
		const w = x1 - x0;
		let minX = Infinity;
		let minY = Infinity;
		let maxX = -Infinity;
		let maxY = -Infinity;
		for (let i = 0; i < d.length; i += 4) {
			if (d[i] + d[i + 1] + d[i + 2] >= 384) continue;
			const p = i / 4;
			const x = p % w;
			const y = (p - x) / w;
			minX = Math.min(minX, x);
			maxX = Math.max(maxX, x);
			minY = Math.min(minY, y);
			maxY = Math.max(maxY, y);
		}
		if (minX === Infinity) return null;
		return {
			x: r.left + (x0 + minX) / sx,
			y: r.top + (y0 + minY) / sy,
			width: (maxX - minX + 1) / sx,
			height: (maxY - minY + 1) / sy
		};
	}, around);
}

const editorCanvas = (page: Page) => page.locator('[data-testid=editor-page] canvas');
const slot = (page: Page, field: string) => page.locator(`[data-testid=form-layer] [data-field="${field}"]`).first();

async function box(l: Locator): Promise<Rect> {
	const b = await l.boundingBox();
	if (!b) throw new Error('no box');
	return b;
}

/** Wait until the page bitmap has been redrawn with ink inside the field. */
async function expectInk(page: Page, field: string, min = 20) {
	const rect = await box(slot(page, field));
	await expect.poll(() => inkIn(editorCanvas(page), rect), { timeout: 10_000 }).toBeGreaterThan(min);
}

/**
 * Field values read back with PDF.js in Node, from the widget annotations of every
 * page; null when the file has no fields. Checkboxes read true/false, radios the
 * chosen option (PDF.js `buttonValue`), others `fieldValue`.
 */
async function readFields(bytes: Uint8Array): Promise<Record<string, unknown> | null> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
	const doc = await task.promise;
	try {
		const out: Record<string, unknown> = {};
		for (let i = 1; i <= doc.numPages; i++) {
			const annots = (await (await doc.getPage(i)).getAnnotations()) as {
				subtype: string;
				fieldName?: string;
				fieldValue?: unknown;
				checkBox?: boolean;
				radioButton?: boolean;
				exportValue?: string;
				buttonValue?: string;
			}[];
			for (const a of annots) {
				if (a.subtype !== 'Widget' || !a.fieldName) continue;
				if (a.checkBox) out[a.fieldName] = a.fieldValue === a.exportValue;
				else if (a.radioButton) {
					if (a.fieldValue === a.buttonValue) out[a.fieldName] = a.buttonValue;
					else out[a.fieldName] ??= '';
				} else out[a.fieldName] ??= a.fieldValue;
			}
		}
		return Object.keys(out).length ? out : null;
	} finally {
		await task.destroy();
	}
}

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
	await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
	const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
	const task = lib.getDocument({ data: new Uint8Array(bytes), verbosity: 0, useWasm: false });
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

/** Export through the dialog and return the downloaded bytes. */
async function exportFile(page: Page, opts: { lock?: boolean } = {}) {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	const lock = dialog.getByRole('switch', { name: 'Lock form answers' });
	await expect(lock).toBeVisible();
	if ((await lock.isChecked()) !== !!opts.lock) await lock.click();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(/^Checked: \d+ pages?, opens cleanly\.$/)).toBeVisible({ timeout: 90_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = readFileSync((await download.path())!);
	await done.getByRole('button', { name: 'Close', exact: true }).last().click();
	await expect(done).toBeHidden();
	return bytes;
}

test.describe('form fields in the editor', () => {
	test('type, tick, choose a radio and a dropdown; the page shows the answers; undo and redo', async ({ page }) => {
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		const name = page.getByRole('textbox', { name: 'Full name' });
		await expect(name).toBeVisible();
		await expect(name).toHaveValue('Ada Lovelace');

		// The notes box is empty in the file: no ink in it until something is typed.
		const notes = page.getByRole('textbox', { name: 'notes' });
		expect(await inkIn(editorCanvas(page), await box(slot(page, 'notes')))).toBe(0);
		await notes.click();
		await page.keyboard.type('Line one');
		await expect(notes).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(notes).not.toBeFocused();
		await expectInk(page, 'notes');
		// Blurred, the control's own text is hidden (no ghosting over the bitmap).
		await expect(notes).toHaveCSS('color', 'rgba(0, 0, 0, 0)');

		await name.fill('Grace Hopper');
		await page.getByRole('checkbox', { name: 'opt_in' }).click();
		await page.getByRole('radio', { name: 'color: blue' }).click();
		await expect.poll(() => answers(page)).toEqual({ notes: 'Line one', name: 'Grace Hopper', opt_in: true, color: 'blue' });
		await expect(page.getByRole('radio', { name: 'color: green' })).not.toBeChecked();

		// Undo inside a focused field takes back the last step (this field's typing), and keeps the focus.
		await name.focus();
		await page.keyboard.press('End');
		await page.keyboard.type(' Jr');
		await expect.poll(() => answers(page)).toMatchObject({ name: 'Grace Hopper Jr' });
		await page.keyboard.press('ControlOrMeta+z');
		await expect(name).toHaveValue('Grace Hopper');
		await expect(name).toBeFocused();
		await expect.poll(() => answers(page)).toEqual({ notes: 'Line one', name: 'Grace Hopper', opt_in: true, color: 'blue' });
		await page.keyboard.press('ControlOrMeta+z');
		await expect.poll(() => answers(page)).toEqual({ notes: 'Line one', name: 'Grace Hopper', opt_in: true });
		await expect(page.getByRole('radio', { name: 'color: green' })).toBeChecked();
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await page.keyboard.press('ControlOrMeta+Shift+z');
		await expect(name).toHaveValue('Grace Hopper Jr');
		await expect(page.getByRole('radio', { name: 'color: blue' })).toBeChecked();

		// Page 2: the dropdown.
		await page.keyboard.press('Escape');
		await page.getByRole('button', { name: 'Next page' }).click();
		const country = page.getByRole('combobox', { name: 'country' });
		await expect(country).toHaveValue('ca');
		await country.selectOption({ label: 'United States' });
		await expect.poll(() => answers(page)).toMatchObject({ country: ['us'] });
		// The multi-select list and the field shared with page 1.
		await expect(slot(page, 'langs')).toHaveAttribute('title', 'This field is locked by the form');
		await expect(page.getByRole('textbox', { name: 'shared' })).toBeVisible();
	});

	test('tab goes through the fields in reading order', async ({ page }) => {
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		await page.getByRole('textbox', { name: 'Full name' }).focus();
		const order: string[] = [];
		for (let i = 0; i < 6; i++) {
			order.push(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? ''));
			await page.keyboard.press('Tab');
		}
		// "ro" is read-only: it has no control and is skipped. One stop per radio group.
		expect(order).toEqual(['Full name', 'notes', 'zip', 'code', 'agree', 'opt_in']);
	});

	test('read-only fields have no control', async ({ page }) => {
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		await expect(slot(page, 'ro')).toHaveAttribute('title', 'This field is locked by the form');
		await expect(page.getByRole('textbox', { name: 'ro' })).toHaveCount(0);
		await expect(slot(page, 'ro').locator('input, textarea, select')).toHaveCount(0);
	});

	test('an armed tool gets the tap, not the field; with no tool the field takes it', async ({ page }) => {
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		const name = page.getByRole('textbox', { name: 'Full name' });
		const b = await box(slot(page, 'name'));
		await chooseTool(page, 'Check');
		await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
		await expect(name).not.toBeFocused();
		await expect
			.poll(() => page.evaluate(() => (window as unknown as { __editor: { store: { state: { pages: { stamps: unknown[] }[] } } } }).__editor.store.state.pages[0].stamps.length))
			.toBe(1);
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await page.mouse.click(b.x + b.width * 0.8, b.y + b.height / 2);
		await expect(name).toBeFocused();
	});

	test('a finger tap focuses a field; inputs are at least 16 px so phones do not zoom', async ({ page }, info) => {
		test.skip(info.project.name !== 'phone', 'touch only');
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		const name = page.getByRole('textbox', { name: 'Full name' });
		await name.tap();
		await expect(name).toBeFocused();
		await page.keyboard.press('End');
		await page.keyboard.type('!');
		await expect.poll(() => answers(page)).toEqual({ name: 'Ada Lovelace!' });
		for (const l of await page.locator('[data-testid=form-layer] input, [data-testid=form-layer] textarea').all()) {
			const px = parseFloat(await l.evaluate((e) => getComputedStyle(e).fontSize));
			expect(px).toBeGreaterThanOrEqual(16);
		}
		await page.getByRole('checkbox', { name: 'opt_in' }).tap();
		await expect.poll(() => answers(page)).toMatchObject({ opt_in: true });
		// The editor still fits the narrowest phones.
		await page.setViewportSize({ width: 360, height: 640 });
		await expect(page.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
		const doc = await page.evaluate(() => document.documentElement.scrollWidth);
		expect(doc).toBeLessThanOrEqual(360);
	});

	for (const rotate of [0, 90] as const) {
		test(`controls sit on the drawn widgets of rotated and cropped pages (turned ${rotate})`, async ({ page }) => {
			test.setTimeout(60_000);
			for (let n = 1; n <= 4; n++) {
				await openEditor(page, `file=forms-geometry.pdf&page=${n}&rotate=${rotate}`);
				const field = slot(page, `t${n}`);
				await expect(field).toBeVisible();
				const s = await box(field);
				const pad = Math.max(s.width, s.height) * 0.3 + 8;
				// Find the drawn border near the control (the canvas may still be sharpening).
				await expect
					.poll(async () => {
						const d = await darkBox(editorCanvas(page), { x: s.x - pad, y: s.y - pad, width: s.width + 2 * pad, height: s.height + 2 * pad });
						if (!d) return 99;
						return Math.max(Math.abs(d.x - s.x), Math.abs(d.y - s.y), Math.abs(d.width - s.width), Math.abs(d.height - s.height));
					}, { timeout: 10_000 })
					.toBeLessThan(3);
				// Type into it: the page draws the answer inside the same box.
				const input = page.getByRole('textbox', { name: `t${n}` });
				await input.fill('Rotated');
				await input.blur();
				await expectInk(page, `t${n}`);
			}
		});
	}

	test('redacting a field that also shows on another page says so', async ({ page }) => {
		await openEditor(page, 'file=forms-kinds.pdf&page=1');
		const b = await box(slot(page, 'shared'));
		await chooseTool(page, 'Redact');
		await page.mouse.move(b.x - 4, b.y - 4);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width + 4, b.y + b.height + 4, { steps: 5 });
		await page.mouse.up();
		await expect(page.getByTestId('form-echo')).toHaveText(
			'This field also appears on page 2. Redact it there too if it should be hidden.'
		);
		// Undo the box: the note goes.
		await page.keyboard.press('Escape');
		await page.keyboard.press('ControlOrMeta+z');
		await expect(page.getByTestId('form-echo')).toHaveCount(0);
	});

	test('redacting a field on a page that has a copy says so', async ({ page }) => {
		await openEditor(page, 'file=form.pdf&page=1');
		await page.evaluate(() => {
			const s = (window as unknown as { __editor: { store: { state: { pages: { id: string }[] }; duplicatePages(ids: string[]): void } } }).__editor.store;
			s.duplicatePages([s.state.pages[0].id]);
		});
		const b = await box(slot(page, 'name'));
		await chooseTool(page, 'Redact');
		await page.mouse.move(b.x + 2, b.y + 2);
		await page.mouse.down();
		await page.mouse.move(b.x + b.width - 2, b.y + b.height - 2, { steps: 5 });
		await page.mouse.up();
		await expect(page.getByTestId('form-echo')).toContainText('This field also appears on page 2.');
	});
});

test.describe('form fields in the workspace', () => {
	test('fill, see it in the thumbnail, export kept and locked, read back', async ({ page }) => {
		test.setTimeout(180_000);
		await page.goto('/');
		await page.locator('input[type=file]').first().setInputFiles([corpus('forms-kinds.pdf')]);
		const tiles = page.getByRole('option');
		await expect(tiles).toHaveCount(2, { timeout: 30_000 });
		await expect(page.getByText('forms-kinds.pdf has a form you can fill in.', { exact: false })).toBeVisible();
		await expect(tiles.nth(0).getByTestId('form-chip')).toBeVisible();
		await expect(tiles.nth(1).getByTestId('form-chip')).toBeVisible();

		// The notes box of the first thumbnail is empty; after typing, its thumbnail shows ink.
		await tiles.nth(0).dblclick();
		const editor = page.getByRole('dialog', { name: /^Edit page 1 of 2/ });
		await expect(editor).toBeVisible();
		const sheet = await pageBox(page);
		const n = await box(slot(page, 'notes'));
		const frac = { x: (n.x - sheet.x) / sheet.width, y: (n.y - sheet.y) / sheet.height, w: n.width / sheet.width, h: n.height / sheet.height };
		await page.getByRole('textbox', { name: 'notes' }).fill('Thumbnail ink');
		await page.getByRole('textbox', { name: 'Full name' }).fill('Grace Hopper');
		await page.getByRole('checkbox', { name: 'opt_in' }).click();
		await page.getByRole('radio', { name: 'color: blue' }).click();
		await editor.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(editor).toBeHidden();

		const thumb = tiles.nth(0).locator('canvas');
		const t = await box(thumb);
		const rect = { x: t.x + frac.x * t.width, y: t.y + frac.y * t.height, width: frac.w * t.width, height: frac.h * t.height };
		await expect.poll(() => inkIn(thumb, rect, 2, 600), { timeout: 10_000 }).toBeGreaterThan(3);

		// Kept as a form: the answers are field values.
		const kept = await readFields(await exportFile(page));
		expect(kept).toMatchObject({ name: 'Grace Hopper', notes: 'Thumbnail ink', color: 'blue', opt_in: true, agree: true });

		// Locked: no fields left, the answers are page text.
		const locked = await exportFile(page, { lock: true });
		expect(await readFields(locked)).toBeNull();
		const text = (await pageTexts(locked)).join(' ');
		expect(text).toContain('Grace Hopper');
		expect(text).toContain('Thumbnail ink');
	});

	test('an answer the form cannot show is named in a readable export error', async ({ page }) => {
		test.setTimeout(120_000);
		await page.goto('/');
		await page.locator('input[type=file]').first().setInputFiles([corpus('forms-kinds.pdf')]);
		const tiles = page.getByRole('option');
		await expect(tiles).toHaveCount(2, { timeout: 30_000 });
		await tiles.nth(0).dblclick();
		await page.getByRole('textbox', { name: 'Full name' }).fill('Ada 日本');
		await page.getByRole('dialog', { name: /^Edit page/ }).getByRole('button', { name: 'Done', exact: true }).click();
		await page.getByRole('button', { name: 'Export', exact: true }).click();
		const dialog = page.getByRole('dialog', { name: 'Export PDF' });
		await dialog.getByRole('button', { name: 'Export', exact: true }).click();
		const stopped = page.getByRole('dialog', { name: 'Export stopped' });
		await expect(stopped.getByRole('alert')).toContainText(/“Full name” .*cannot show these characters: 日 本/, { timeout: 60_000 });
	});

	test('an XFA form says it cannot be filled', async ({ page }) => {
		await page.goto('/');
		await page.locator('input[type=file]').first().setInputFiles([corpus('forms-xfa.pdf')]);
		await expect(page.getByRole('option')).toHaveCount(1, { timeout: 30_000 });
		await expect(page.getByText('This is an XFA form. Its fields cannot be filled here.', { exact: false })).toBeVisible();
		await expect(page.getByTestId('form-chip')).toHaveCount(0);
	});
});

// Review screenshots of a filled form. Skipped unless EDITOR_SHOTS names an output folder.
test('form screenshots', async ({ page }, info) => {
	const dir = process.env.EDITOR_SHOTS;
	test.skip(!dir, 'set EDITOR_SHOTS to an output folder');
	const tag = info.project.name;
	await openEditor(page, 'file=forms-kinds.pdf&page=1');
	await page.getByRole('textbox', { name: 'Full name' }).fill('Grace Hopper');
	await page.getByRole('textbox', { name: 'notes' }).fill('Two lines\nof notes');
	await page.getByRole('textbox', { name: 'zip' }).fill('80202');
	await page.getByRole('checkbox', { name: 'opt_in' }).click();
	await page.getByRole('radio', { name: 'color: blue' }).click();
	await page.getByRole('textbox', { name: 'shared' }).click();
	await page.keyboard.type('Typing here');
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${dir}/${tag}-form-1-focused.png` });
	await page.keyboard.press('Escape');
	await page.waitForTimeout(800);
	await page.screenshot({ path: `${dir}/${tag}-form-2-filled.png` });
	await page.getByRole('button', { name: 'Next page' }).click();
	await page.waitForTimeout(1000);
	await page.screenshot({ path: `${dir}/${tag}-form-3-page2.png` });
	await openEditor(page, 'file=forms-geometry.pdf&page=1&rotate=90');
	await page.getByRole('textbox', { name: 't1' }).fill('Turned page');
	await page.getByRole('textbox', { name: 't1' }).blur();
	await page.waitForTimeout(1000);
	await page.screenshot({ path: `${dir}/${tag}-form-4-rotated.png` });
});
