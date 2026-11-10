/**
 * The whole job through the real `/` page: open files, arrange, sign and type on a
 * page in the real editor, export with a password, and check the downloaded file.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDict, PDFDocument, PDFName, type PDFPage } from '@cantoo/pdf-lib';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, drawOnPad, tapPage } from './editor-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const M = [612, 792];
const S = [
	[612, 792],
	[595.28, 841.89],
	[612, 1008],
	[595.28, 419.53],
	[100, 60],
	[1224, 792]
];

const options = (page: Page) => page.getByRole('option');

async function order(page: Page): Promise<string[]> {
	const labels = await options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
	return labels.map((l) => {
		const m = /, ([\w-]+)\.\w+(?: page (\d+))?(?:, rotated (\d+)°)?/.exec(l);
		if (!m) return l;
		return `${m[1][0]}${m[2] ?? 1}${m[3] ? `@${m[3]}` : ''}`;
	});
}

/** Real touch through the DevTools protocol. */
async function touch(page: Page, x: number, y: number, holdMs: number, moveTo?: { x: number; y: number }) {
	const cdp = await page.context().newCDPSession(page);
	const pt = (px: number, py: number) => [{ x: px, y: py, id: 1 }];
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x, y) });
	await page.waitForTimeout(holdMs);
	if (moveTo) {
		for (let i = 1; i <= 12; i++) {
			const t = i / 12;
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x + (moveTo.x - x) * t, y + (moveTo.y - y) * t) });
			await page.waitForTimeout(16);
		}
		await page.waitForTimeout(100);
	}
	await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
	await cdp.detach();
}

function resourceCount(p: PDFPage, kind: 'XObject' | 'Font'): number {
	const res = p.node.Resources();
	const dict = res?.lookupMaybe(PDFName.of(kind), PDFDict);
	return dict ? dict.keys().length : 0;
}

async function shape(bytes: Uint8Array, password?: string) {
	const doc = await PDFDocument.load(bytes, password ? { password } : undefined);
	return doc.getPages().map((p) => {
		const { width, height } = p.getMediaBox();
		return {
			size: [Math.round(width * 100) / 100, Math.round(height * 100) / 100],
			rotate: p.getRotation().angle,
			xobjects: resourceCount(p, 'XObject'),
			fonts: resourceCount(p, 'Font')
		};
	});
}

async function signInEditor(page: Page) {
	const editor = page.getByRole('dialog', { name: /^Edit page 2 of 13/ });
	await expect(editor).toBeVisible();
	await expect(page.getByTestId('editor-page')).toBeVisible();

	// A drawn signature, saved on this device.
	await chooseTool(page, 'Signature');
	const pad = page.getByRole('dialog', { name: 'Add signature' });
	await expect(pad).toBeVisible();
	await drawOnPad(page);
	await pad.getByRole('button', { name: 'Use signature' }).click();
	await expect(pad).toBeHidden();
	await tapPage(page, 0.3, 0.3);
	await expect(page.getByTestId('live')).toHaveText('Signature placed.');

	// The saved one is offered next time; this time type a signature instead.
	await chooseTool(page, 'Signature');
	await expect(pad.getByRole('button', { name: 'Use saved signature 1' })).toBeVisible();
	await pad.getByRole('radio', { name: 'Type' }).click();
	await pad.getByRole('textbox', { name: 'Your name' }).fill('Jane Doe');
	await pad.getByRole('button', { name: 'Use signature' }).click();
	await expect(pad).toBeHidden();
	await tapPage(page, 0.6, 0.55);

	await chooseTool(page, 'Text');
	await tapPage(page, 0.12, 0.8);
	await expect(page.getByRole('textbox', { name: 'Text on the page' })).toBeFocused();
	await page.keyboard.type('Jane Doe, 9 Nov');
	await page.keyboard.press('Escape');

	await chooseTool(page, 'Check');
	await tapPage(page, 0.8, 0.12);
	await page.keyboard.press('Escape');

	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();
}

async function exportWithPassword(page: Page, password: string) {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await expect(dialog).toBeVisible();
	await dialog.getByRole('switch', { name: 'Add a password' }).click();
	await dialog.getByLabel('Password', { exact: true }).fill(password);
	await dialog.getByLabel('Confirm password').fill(password);
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText('Checked: 13 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	await expect(done.getByText('It opens only with your password.')).toBeVisible();
	// Tool names stay in the Details disclosure.
	await expect(done.getByText(/qpdf|PDF\.js/).first()).toBeHidden();
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	return readFileSync((await download.path())!);
}

async function checkOutput(bytes: Uint8Array, password: string) {
	await expect(PDFDocument.load(bytes)).rejects.toThrow();
	const out = await shape(bytes, password);
	const original = (await shape(readFileSync(corpus('multi.pdf'))))[0];
	expect(out).toHaveLength(13);
	// Order: photo, m1 (stamped), m2 (rotated), m3..m6, s1..s6.
	expect(out[0].size).not.toEqual(M);
	expect(out.slice(1, 7).map((p) => p.size)).toEqual([M, M, M, M, M, M]);
	expect(out.slice(7).map((p) => p.size)).toEqual(S);
	expect(out.map((p) => p.rotate)).toEqual([0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
	// The stamped page gained images (two signatures) and a font (the text).
	expect(out[1].xobjects).toBeGreaterThan(original.xobjects);
	expect(out[1].fonts).toBeGreaterThan(original.fonts);
	// Unstamped pages are untouched.
	expect(out[3].xobjects).toBe(original.xobjects);
}

test('whole job on desktop: open, arrange, sign, export with a password', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop flow');
	test.setTimeout(120_000);
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('multi.pdf'), corpus('sizes.pdf'), corpus('photo-plain.jpg')]);
	await expect(options(page)).toHaveCount(13, { timeout: 30_000 });
	// The whole drop is one undo step.
	await expect(page.getByRole('button', { name: 'Undo: Add 3 files' })).toBeVisible();

	// Drag the photo to the front.
	const a = (await options(page).nth(12).boundingBox())!;
	const b = (await options(page).nth(0).boundingBox())!;
	await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
	await page.mouse.down();
	await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 8, { steps: 3 });
	await page.mouse.move(b.x + b.width * 0.15, b.y + b.height / 2, { steps: 10 });
	await page.mouse.up();
	await expect.poll(() => order(page)).toEqual(['p1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4', 's5', 's6']);

	// Rotate m2.
	await options(page).nth(2).click();
	await page.keyboard.press('r');
	await expect(options(page).nth(2)).toHaveAttribute('aria-label', /rotated 90°/);

	// Open m1 and stamp it.
	await options(page).nth(1).dblclick();
	await signInEditor(page);
	await expect(options(page).nth(1)).toBeFocused();
	await expect(options(page).nth(1)).toHaveAttribute('aria-label', /4 marks/);
	await expect(options(page).nth(1).locator('.stamp-layer .stamp')).toHaveCount(4);
	await expect(options(page).nth(1).locator('.stamp-layer img').first()).toBeVisible();

	await checkOutput(await exportWithPassword(page, 'job pass 1'), 'job pass 1');
});

test('whole job on a phone: open, arrange by touch, sign, export with a password', async ({ page }, info) => {
	test.skip(info.project.name !== 'phone', 'phone flow');
	test.setTimeout(150_000);
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('multi.pdf'), corpus('sizes.pdf'), corpus('photo-plain.jpg')]);
	await expect(options(page)).toHaveCount(13, { timeout: 30_000 });

	// Long-press the photo and drag it to the front (auto-scroll brings the top into view).
	await options(page).nth(12).scrollIntoViewIfNeeded();
	const a = (await options(page).nth(12).boundingBox())!;
	await touch(page, a.x + a.width / 2, a.y + a.height / 3, 650, { x: a.x + a.width / 2, y: 70 });
	await expect.poll(async () => (await order(page)).indexOf('p1')).toBeLessThan(12);
	// Finish the move from the menu: precise and reachable by thumb.
	const idx = (await order(page)).indexOf('p1');
	await options(page).nth(idx).scrollIntoViewIfNeeded();
	const c = (await options(page).nth(idx).boundingBox())!;
	await touch(page, c.x + c.width / 2, c.y + c.height / 3, 650);
	const bar = page.getByRole('toolbar', { name: 'Selected pages' });
	await expect(bar).toContainText('1 selected');
	await bar.getByRole('button', { name: 'More for selected pages' }).tap();
	await page.getByRole('menuitem', { name: 'Move to start' }).tap();
	await expect.poll(() => order(page)).toEqual(['p1', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 's1', 's2', 's3', 's4', 's5', 's6']);
	await bar.getByRole('button', { name: 'Done' }).tap();

	// Rotate m2 from the bottom bar.
	await page.evaluate(() => scrollTo(0, 0));
	const r = (await options(page).nth(2).boundingBox())!;
	await touch(page, r.x + r.width / 2, r.y + r.height / 3, 650);
	await bar.getByRole('button', { name: 'Rotate right' }).tap();
	await expect(options(page).nth(2)).toHaveAttribute('aria-label', /rotated 90°/);
	await bar.getByRole('button', { name: 'Done' }).tap();

	// A tap opens m1.
	await options(page).nth(1).tap();
	await signInEditor(page);
	await expect(options(page).nth(1).locator('.stamp-layer .stamp')).toHaveCount(4);

	await checkOutput(await exportWithPassword(page, 'job pass 2'), 'job pass 2');
});

test('editor undo is scoped to the editing session', async ({ page }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'desktop flow');
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([corpus('multi.pdf')]);
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await options(page).nth(0).click();
	await page.keyboard.press('r');
	await page.keyboard.press('Enter');
	const editor = page.getByRole('dialog', { name: 'Edit page 1 of 6' });
	await expect(editor).toBeVisible();
	const undo = editor.getByRole('button', { name: 'Undo' });
	await expect(undo).toBeDisabled();
	await page.keyboard.press('Control+z');
	// The rotation made in the grid is still there.
	await chooseTool(page, 'Check');
	await tapPage(page, 0.5, 0.5);
	await page.keyboard.press('Escape');
	await expect(undo).toBeEnabled();
	await undo.click();
	await expect(undo).toBeDisabled();
	await page.keyboard.press('Control+z');
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(options(page).nth(0)).toHaveAttribute('aria-label', 'Page 1, multi.pdf page 1, rotated 90°');
	// Back in the grid, undo reaches the rotation.
	await page.getByRole('button', { name: /^Undo: Rotate/ }).click();
	await expect(options(page).nth(0)).toHaveAttribute('aria-label', 'Page 1, multi.pdf page 1');
});

test('offline after the first load: open, type a signature, export', async ({ page, context }, info) => {
	test.skip(info.project.name !== 'desktop-chrome', 'one project is enough');
	test.setTimeout(120_000);
	await page.goto('/');
	await page.waitForFunction(async () => {
		const reg = await navigator.serviceWorker.ready;
		return !!reg.active && !!navigator.serviceWorker.controller;
	});
	await context.setOffline(true);
	await page.reload();
	await page.locator('input[type=file]').first().setInputFiles([corpus('multi.pdf'), corpus('sizes.pdf'), corpus('photo-plain.jpg')]);
	await expect(options(page)).toHaveCount(13, { timeout: 30_000 });
	await options(page).nth(1).dblclick();
	await expect(page.getByRole('dialog', { name: /^Edit page 2 of 13/ })).toBeVisible();
	await chooseTool(page, 'Signature');
	const pad = page.getByRole('dialog', { name: 'Add signature' });
	await pad.getByRole('radio', { name: 'Type' }).click();
	await pad.getByRole('textbox', { name: 'Your name' }).fill('Offline Person');
	await pad.getByRole('button', { name: 'Use signature' }).click();
	await tapPage(page, 0.5, 0.5);
	await page.getByRole('button', { name: 'Done', exact: true }).click();
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	await page.getByRole('dialog', { name: 'Export PDF' }).getByRole('button', { name: 'Export', exact: true }).click();
	await expect(page.getByText('Checked: 13 pages, opens cleanly.')).toBeVisible({ timeout: 60_000 });
	await context.setOffline(false);
});
