import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from '@cantoo/pdf-lib';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));

// sizes.pdf pages, in order (points). multi.pdf pages are all 612 x 792.
const S = [
	[612, 792],
	[595.28, 841.89],
	[612, 1008],
	[595.28, 419.53],
	[100, 60],
	[1224, 792]
];
const M = [612, 792];

const isDesktop = (name: string) => name === 'desktop-chrome';

async function addFiles(page: Page, ...names: string[]) {
	await page.locator('input[type=file]').first().setInputFiles(names.map(corpus));
}

const options = (page: Page) => page.getByRole('option');

async function labels(page: Page): Promise<string[]> {
	return options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** "Page 3, multi.pdf page 2" -> "m2"; sizes.pdf -> "s"; rotation suffix "@90". */
async function order(page: Page): Promise<string[]> {
	return (await labels(page)).map((l) => {
		const m = /, (\w+)\.\w+(?: page (\d+))?(?:, rotated (\d+)°)?/.exec(l);
		if (!m) return l;
		return `${m[1][0]}${m[2] ?? 1}${m[3] ? `@${m[3]}` : ''}`;
	});
}

async function waitForPages(page: Page, n: number) {
	await expect(options(page)).toHaveCount(n, { timeout: 30_000 });
}

/** Export through the dialog and return the downloaded bytes. */
async function exportAndDownload(page: Page, setup?: () => Promise<void>, opener?: () => Promise<void>) {
	if (opener) await opener();
	else await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog');
	await expect(dialog).toBeVisible();
	if (setup) await setup();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	await expect(dialog.getByText(/^Checked: \d+ pages?, opens cleanly\.$/)).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([
		page.waitForEvent('download'),
		dialog.getByRole('button', { name: 'Download' }).click()
	]);
	const path = await download.path();
	return { bytes: readFileSync(path!), filename: download.suggestedFilename() };
}

async function shape(bytes: Uint8Array, password?: string) {
	const doc = await PDFDocument.load(bytes, password ? { password } : undefined);
	return doc.getPages().map((p) => {
		const { width, height } = p.getMediaBox();
		return { size: [Math.round(width * 100) / 100, Math.round(height * 100) / 100], rotate: p.getRotation().angle };
	});
}

async function mouseDrag(page: Page, from: number, to: number, side: 'before' | 'after' = 'before') {
	const a = (await options(page).nth(from).boundingBox())!;
	const b = (await options(page).nth(to).boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 8, { steps: 3 });
	const tx = side === 'before' ? b.x + b.width * 0.2 : b.x + b.width * 0.8;
	await page.mouse.move(tx, b.y + b.height / 2, { steps: 10 });
	await expect(page.locator('.indicator')).toBeVisible();
	await page.mouse.up();
}

test.describe('desktop', () => {
	test.beforeEach(({}, info) => test.skip(!isDesktop(info.project.name), 'desktop flow'));

	test('open two files, reorder by drag and keyboard, rotate, delete, undo, export', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf', 'sizes.pdf');
		await waitForPages(page, 12);
		await expect(page.getByText('Added 12 pages')).toBeVisible();
		expect(await order(page)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4', 's5', 's6']);

		// Drag sizes p2 to the very start.
		await mouseDrag(page, 7, 0, 'before');
		await expect.poll(() => order(page)).toEqual(['s2', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's3', 's4', 's5', 's6']);

		// Escape cancels a drag.
		const a = (await options(page).nth(3).boundingBox())!;
		await page.mouse.move(a.x + 20, a.y + 20);
		await page.mouse.down();
		await page.mouse.move(a.x + 300, a.y + 40, { steps: 6 });
		await page.keyboard.press('Escape');
		await page.mouse.up();
		expect((await order(page))[3]).toBe('m3');

		// Keyboard: select s5 and move it two places left with Alt+Left.
		await options(page).nth(10).click();
		await page.keyboard.press('Alt+ArrowLeft');
		await page.keyboard.press('Alt+ArrowLeft');
		await expect.poll(() => order(page)).toEqual(['s2', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's5', 's3', 's4', 's6']);
		await expect(options(page).nth(8)).toBeFocused();

		// Rotate the selected page with R.
		await page.keyboard.press('r');
		await expect(options(page).nth(8)).toHaveAttribute('aria-label', /rotated 90°/);

		// Delete m6 from its hover button, then undo from the toast.
		await options(page).nth(6).hover();
		await options(page).nth(6).locator('[data-action="delete"]').click();
		await waitForPages(page, 11);
		await page.getByRole('button', { name: 'Undo', exact: true }).click();
		await waitForPages(page, 12);
		expect((await order(page))[6]).toBe('m6');

		// Delete m1 with the keyboard; undo with Ctrl+Z, redo with Ctrl+Shift+Z.
		await options(page).nth(1).click();
		await page.keyboard.press('Delete');
		await waitForPages(page, 11);
		await page.keyboard.press('Control+z');
		await waitForPages(page, 12);
		await page.keyboard.press('Control+Shift+z');
		await waitForPages(page, 11);
		const expected = ['s2', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's5@90', 's3', 's4', 's6'];
		expect(await order(page)).toEqual(expected);

		// Undo shows its label in the tooltip / name.
		await expect(page.getByRole('button', { name: /^Undo: Delete page/ })).toBeVisible();

		const { bytes, filename } = await exportAndDownload(page);
		expect(filename).toBe('sizes-merged.pdf');
		const pages = await shape(bytes);
		expect(pages).toEqual([
			{ size: S[1], rotate: 0 },
			...[1, 2, 3, 4, 5].map(() => ({ size: M, rotate: 0 })),
			{ size: S[0], rotate: 0 },
			{ size: S[4], rotate: 90 },
			{ size: S[2], rotate: 0 },
			{ size: S[3], rotate: 0 },
			{ size: S[5], rotate: 0 }
		]);
	});

	test('password-protected intake: wrong password, retry, skip', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'enc-aes-256.pdf', 'enc-aes-128.pdf');
		const dialog = page.getByRole('dialog', { name: 'This file has a password' });
		await expect(dialog).toBeVisible({ timeout: 30_000 });
		await expect(dialog).toContainText('enc-aes-256.pdf');
		await expect(page.getByText('Waiting for the password for')).toBeVisible();
		await dialog.getByLabel('Password', { exact: true }).fill('wrong');
		await dialog.getByRole('button', { name: 'Open' }).click();
		await expect(dialog.getByText('That password did not open the file. Check it and try again.')).toBeVisible();
		await expect(dialog.getByLabel('Password', { exact: true })).toBeFocused();
		await dialog.getByLabel('Password', { exact: true }).fill('user');
		await dialog.getByRole('button', { name: 'Open' }).click();

		// The second file asks too; skip it.
		await expect(dialog).toContainText('enc-aes-128.pdf');
		await dialog.getByRole('button', { name: 'Skip this file' }).click();
		await expect(dialog).toBeHidden();
		await expect(options(page).first()).toBeVisible();
		const n = await options(page).count();
		expect(n).toBeGreaterThan(0);
		expect((await labels(page)).every((l) => l.includes('enc-aes-256.pdf'))).toBe(true);
	});

	test('image intake: JPEG, PNG, WebP converted, and a clear error for other files', async ({ page }) => {
		await page.goto('/');
		const webp = await page.evaluate(async () => {
			const c = document.createElement('canvas');
			c.width = 40;
			c.height = 30;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = '#c33';
			ctx.fillRect(0, 0, 40, 30);
			const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/webp'));
			return [...new Uint8Array(await blob.arrayBuffer())];
		});
		const file = (name: string, mimeType: string) => ({ name, mimeType, buffer: readFileSync(corpus(name)) });
		await page.locator('input[type=file]').first().setInputFiles([
			file('photo-plain.jpg', 'image/jpeg'),
			file('alpha.png', 'image/png'),
			{ name: 'sticker.webp', mimeType: 'image/webp', buffer: Buffer.from(webp) },
			{ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') }
		]);
		await waitForPages(page, 3);
		await expect(page.getByText('notes.txt is not a PDF or an image. Only PDFs and images can be added.')).toBeVisible();
		expect(await labels(page)).toEqual(['Page 1, photo-plain.jpg', 'Page 2, alpha.png', 'Page 3, sticker.png']);

		const { bytes } = await exportAndDownload(page);
		expect((await shape(bytes)).length).toBe(3);
	});

	test('export with a password', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf');
		await waitForPages(page, 6);
		const { bytes, filename } = await exportAndDownload(page, async () => {
			const dialog = page.getByRole('dialog');
			await expect(dialog.getByLabel('File name')).toHaveValue('multi-edited.pdf');
			await dialog.getByRole('switch', { name: 'Add a password' }).click();
			await dialog.getByLabel('Password', { exact: true }).fill('s3cret');
			await dialog.getByLabel('Confirm password').fill('s3cre');
			await dialog.getByLabel('Confirm password').blur();
			await expect(dialog.getByText('The two passwords do not match.')).toBeVisible();
			// Engine rules are relayed inline.
			await dialog.getByLabel('Password', { exact: true }).fill('ﬁle');
			await expect(dialog.getByText(/treat differently/)).toBeVisible();
			await dialog.getByLabel('Password', { exact: true }).fill('s3cret');
			await dialog.getByLabel('Confirm password').fill('s3cret');
			await expect(dialog.getByText('The two passwords do not match.')).toBeHidden();
		});
		expect(filename).toBe('multi-edited.pdf');
		await expect(PDFDocument.load(bytes)).rejects.toThrow();
		expect((await shape(bytes, 's3cret')).length).toBe(6);
	});

	test('extract selected pages', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'sizes.pdf');
		await waitForPages(page, 6);
		await options(page).nth(1).click();
		await options(page).nth(3).click({ modifiers: ['ControlOrMeta'] });
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toContainText('2 selected');
		const { bytes, filename } = await exportAndDownload(page, undefined, async () => {
			await page.getByRole('button', { name: 'Export selected' }).click();
			await expect(page.getByRole('dialog', { name: 'Export 2 selected pages' })).toBeVisible();
		});
		expect(filename).toBe('sizes-pages.pdf');
		expect(await shape(bytes)).toEqual([
			{ size: S[1], rotate: 0 },
			{ size: S[3], rotate: 0 }
		]);
		// Extracting does not count as saving the whole document.
		await expect(options(page)).toHaveCount(6);
	});

	test('add files after the selection, paste, duplicate, insert blank, start over with undo', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf');
		await waitForPages(page, 6);
		await options(page).nth(1).click();
		await addFiles(page, 'sizes.pdf');
		await waitForPages(page, 12);
		await expect(page.getByText('Added 6 pages after page 2')).toBeVisible();
		expect((await order(page)).slice(0, 4)).toEqual(['m1', 'm2', 's1', 's2']);

		// Paste an image file.
		await page.evaluate(async () => {
			const c = document.createElement('canvas');
			c.width = 10;
			c.height = 10;
			const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/png'));
			const dt = new DataTransfer();
			dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
			document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true }));
		});
		await waitForPages(page, 13);

		await page.keyboard.press('Escape');
		await options(page).nth(0).click();
		await page.keyboard.press('Control+d');
		await waitForPages(page, 14);
		expect((await order(page)).slice(0, 2)).toEqual(['m1', 'm1']);

		await page.getByRole('button', { name: 'More actions' }).click();
		await page.getByRole('menuitem', { name: 'Insert blank page' }).click();
		await waitForPages(page, 15);
		await expect(options(page).nth(2)).toHaveAttribute('aria-label', 'Page 3, blank');

		await page.getByRole('button', { name: 'More actions' }).click();
		await page.getByRole('menuitem', { name: 'Start over' }).click();
		await expect(options(page)).toHaveCount(0);
		await expect(page.getByRole('button', { name: 'Choose files' })).toBeVisible();
		await page.getByRole('button', { name: 'Undo', exact: true }).click();
		await waitForPages(page, 15);
	});

	test('dropping files on a populated grid adds them; dragging near the edge scrolls', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf', 'multi.pdf', 'multi.pdf');
		await waitForPages(page, 18);

		const bytes = [...readFileSync(corpus('sizes.pdf'))];
		const dt = await page.evaluateHandle((b) => {
			const d = new DataTransfer();
			d.items.add(new File([new Uint8Array(b)], 'dropped.pdf', { type: 'application/pdf' }));
			return d;
		}, bytes);
		await page.dispatchEvent('main', 'dragenter', { dataTransfer: dt });
		await expect(page.getByText('Drop to add them at the end')).toBeVisible();
		await page.dispatchEvent('main', 'drop', { dataTransfer: dt });
		await waitForPages(page, 24);
		await expect(page.getByText('Drop to add them at the end')).toBeHidden();

		// Hold a dragged page near the bottom edge: the grid scrolls by itself.
		await page.evaluate(() => scrollTo(0, 0));
		const a = (await options(page).nth(0).boundingBox())!;
		const vh = page.viewportSize()!.height;
		await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
		await page.mouse.down();
		await page.mouse.move(a.x + a.width / 2 + 10, a.y + a.height / 2 + 10, { steps: 2 });
		await page.mouse.move(a.x + a.width / 2, vh - 10, { steps: 6 });
		await expect.poll(() => page.evaluate(() => scrollY), { timeout: 5000 }).toBeGreaterThan(200);
		await page.keyboard.press('Escape');
		await page.mouse.up();
		expect((await order(page))[0]).toBe('m1');
		await expect(page.getByRole('button', { name: /^Undo: Add/ })).toBeVisible();
	});

	test('keyboard: focus, select, shortcut sheet, editor opens and closes', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf');
		await waitForPages(page, 6);
		await options(page).nth(0).click();
		await page.keyboard.press('ArrowRight');
		await expect(options(page).nth(1)).toBeFocused();
		await expect(options(page).nth(1)).toHaveAttribute('aria-selected', 'true');
		await page.keyboard.press('Shift+ArrowRight');
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toContainText('2 selected');
		await page.keyboard.press('Control+a');
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toContainText('6 selected');
		await page.keyboard.press('Escape');
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toBeHidden();

		await page.keyboard.press('?');
		await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
		await page.keyboard.press('Escape');

		await options(page).nth(2).dblclick();
		const close = page.getByRole('button', { name: /^Close editor/ });
		await expect(close).toBeVisible();
		await close.click();
		await expect(close).toBeHidden();
		await expect(options(page).nth(2)).toBeFocused();
	});
});

test.describe('phone', () => {
	test.beforeEach(({}, info) => test.skip(isDesktop(info.project.name), 'phone flow'));

	/** Real touch through the DevTools protocol: press, hold, optionally move, release. */
	async function touch(page: Page, x: number, y: number, holdMs: number, moveTo?: { x: number; y: number }) {
		const cdp = await page.context().newCDPSession(page);
		const point = (px: number, py: number) => [{ x: px, y: py, id: 1 }];
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: point(x, y) });
		await page.waitForTimeout(holdMs);
		if (moveTo) {
			for (let i = 1; i <= 12; i++) {
				const t = i / 12;
				await cdp.send('Input.dispatchTouchEvent', {
					type: 'touchMove',
					touchPoints: point(x + (moveTo.x - x) * t, y + (moveTo.y - y) * t)
				});
				await page.waitForTimeout(16);
			}
			await page.waitForTimeout(100);
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await cdp.detach();
	}

	async function centre(page: Page, i: number) {
		const b = (await options(page).nth(i).boundingBox())!;
		return { x: b.x + b.width / 2, y: b.y + b.height / 3 };
	}

	test('tap opens, long-press selects, bottom bar acts, touch drag reorders', async ({ page }) => {
		test.setTimeout(90_000);
		await page.goto('/');
		await addFiles(page, 'sizes.pdf');
		await waitForPages(page, 6);
		const bar = page.getByRole('toolbar', { name: 'Pages' });
		await expect(bar.getByRole('button', { name: 'Add files' })).toBeVisible();

		// A tap opens the page.
		await options(page).nth(0).tap();
		const close = page.getByRole('button', { name: /^Close editor/ });
		await expect(close).toBeVisible();
		await close.tap();
		await expect(close).toBeHidden();

		// Long-press page 2 enters selection mode; taps then toggle.
		const p1 = await centre(page, 1);
		await touch(page, p1.x, p1.y, 700);
		const selBar = page.getByRole('toolbar', { name: 'Selected pages' });
		await expect(selBar).toContainText('1 selected');
		await options(page).nth(3).tap();
		await expect(selBar).toContainText('2 selected');
		await options(page).nth(3).tap();
		await expect(selBar).toContainText('1 selected');

		await selBar.getByRole('button', { name: 'Rotate right' }).tap();
		await expect(options(page).nth(1)).toHaveAttribute('aria-label', /rotated 90°/);

		// Long-press then drag page 1 after page 3.
		await selBar.getByRole('button', { name: 'Done' }).tap();
		const from = await centre(page, 0);
		const b2 = (await options(page).nth(2).boundingBox())!;
		const scrollBefore = await page.evaluate(() => scrollY);
		await touch(page, from.x, from.y, 650, { x: b2.x + b2.width * 0.85, y: b2.y + b2.height / 2 });
		await expect.poll(() => order(page)).toEqual(['s2@90', 's3', 's1', 's4', 's5', 's6']);
		expect(Math.abs((await page.evaluate(() => scrollY)) - scrollBefore)).toBeLessThan(40);

		// The long-press that started the drag left selection mode on, with the moved page selected.
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toContainText('1 selected');
		await page.getByRole('toolbar', { name: 'Selected pages' }).getByRole('button', { name: 'Done' }).tap();

		// Delete via the bottom bar, then undo from the toast.
		await page.getByRole('toolbar', { name: 'Pages' }).getByRole('button', { name: 'Select' }).tap();
		await options(page).nth(5).tap();
		await page.getByRole('toolbar', { name: 'Selected pages' }).getByRole('button', { name: 'Delete' }).tap();
		await waitForPages(page, 5);
		await page.getByRole('button', { name: 'Undo', exact: true }).tap();
		await waitForPages(page, 6);

		const { bytes } = await exportAndDownload(page);
		expect((await shape(bytes)).map((p) => p.rotate)).toEqual([90, 0, 0, 0, 0, 0]);
	});

	test('a swipe over the grid scrolls instead of dragging', async ({ page }) => {
		await page.goto('/');
		await addFiles(page, 'multi.pdf', 'sizes.pdf');
		await waitForPages(page, 12);
		const p = await centre(page, 2);
		await touch(page, p.x, p.y + 100, 0, { x: p.x, y: p.y - 250 });
		await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(50);
		expect((await order(page)).slice(0, 3)).toEqual(['m1', 'm2', 'm3']);
		await expect(page.getByRole('toolbar', { name: 'Selected pages' })).toBeHidden();
	});
});
