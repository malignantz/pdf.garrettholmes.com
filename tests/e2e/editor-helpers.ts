import type { Page } from '@playwright/test';
import { expect } from './fixtures';

export interface StampJson {
	id: string;
	kind: 'image' | 'text' | 'mark';
	box?: { x: number; y: number; w: number; h: number };
	x?: number;
	y?: number;
	size?: number;
	text?: string;
	color?: string;
}

/** Open the dev harness on a fixture page and wait until the page is drawn. */
export async function openEditor(page: Page, query: string) {
	await page.goto(`/dev-editor?${query}`);
	const sheet = page.getByTestId('editor-page');
	await expect(sheet).toBeVisible({ timeout: 30_000 });
	await page.waitForFunction(() => {
		const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-page] canvas');
		return !!c && c.width > 0 && getComputedStyle(c).visibility !== 'hidden';
	});
	return sheet;
}

export async function stamps(page: Page, pageIndex = 0): Promise<StampJson[]> {
	return page.evaluate(
		(i) => (window as unknown as { __editor: { store: { state: { pages: { stamps: unknown[] }[] } } } }).__editor.store.state.pages[i].stamps,
		pageIndex
	) as Promise<StampJson[]>;
}

export async function pageBox(page: Page) {
	const b = await page.getByTestId('editor-page').boundingBox();
	if (!b) throw new Error('no page box');
	return b;
}

/** Click (or tap) the page at a fraction of its displayed size. */
export async function tapPage(page: Page, fx: number, fy: number) {
	const b = await pageBox(page);
	await page.mouse.click(b.x + fx * b.width, b.y + fy * b.height);
}

/** Draw a wavy signature on the pad with synthetic pointer events. */
export async function drawOnPad(page: Page) {
	const pad = page.locator('canvas.pad');
	await expect(pad).toBeVisible();
	// The dialog slides in (a bottom sheet on phones); aim only once it has landed.
	await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
	await pad.scrollIntoViewIfNeeded();
	const b = (await pad.boundingBox())!;
	const x0 = b.x + b.width * 0.15;
	const y0 = b.y + b.height * 0.6;
	await page.mouse.move(x0, y0);
	await page.mouse.down();
	for (let i = 1; i <= 40; i++) {
		const t = i / 40;
		await page.mouse.move(x0 + t * b.width * 0.7, y0 - Math.sin(t * Math.PI * 4) * b.height * 0.25 - t * b.height * 0.1);
	}
	await page.mouse.up();
	// A second stroke (the dot of an i).
	await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.2);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width * 0.52, b.y + b.height * 0.22);
	await page.mouse.up();
}

export async function chooseTool(page: Page, name: string) {
	await page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true }).click();
}

/** Signature tool -> draw -> use. Leaves the tool armed. */
export async function makeSignature(page: Page, opts: { ink?: 'Black' | 'Blue'; save?: boolean } = {}) {
	await chooseTool(page, 'Signature');
	const dlg = page.getByRole('dialog', { name: 'Add signature' });
	await expect(dlg).toBeVisible();
	if (opts.ink) await dlg.getByRole('radio', { name: opts.ink }).click();
	if (opts.save === false) await dlg.getByRole('switch', { name: /Save on this device/ }).click();
	await drawOnPad(page);
	await dlg.getByRole('button', { name: 'Use signature' }).click();
	await expect(dlg).toBeHidden();
}
