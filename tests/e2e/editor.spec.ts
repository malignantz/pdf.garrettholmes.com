import { test, expect } from './fixtures';
import { chooseTool, makeSignature, openEditor, pageBox, stamps, tapPage, drawOnPad } from './editor-helpers';

test.describe('page editor', () => {
	test('sign, add text and a check, move, resize, undo', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await expect(page.getByText('1 of 6')).toBeVisible();

		// Signature: draw, place.
		await makeSignature(page, { save: false });
		await tapPage(page, 0.5, 0.4);
		await expect(page.getByTestId('live')).toHaveText('Signature placed.');
		let list = await stamps(page);
		expect(list).toHaveLength(1);
		const sig = list[0];
		expect(sig.kind).toBe('image');
		expect(sig.box!.w).toBeCloseTo(0.25, 5);
		expect(sig.box!.x + sig.box!.w / 2).toBeCloseTo(0.5, 2);
		expect(sig.box!.y + sig.box!.h / 2).toBeCloseTo(0.4, 2);
		// The tool disarmed after one signature.
		await expect(page.getByRole('button', { name: 'Signature', exact: true })).toHaveAttribute('aria-pressed', 'false');

		// Text.
		await chooseTool(page, 'Text');
		await tapPage(page, 0.15, 0.7);
		await expect(page.getByRole('textbox', { name: 'Text on the page' })).toBeFocused();
		await page.keyboard.type('Jane Doe');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Line two');
		await page.keyboard.press('Escape');
		list = await stamps(page);
		const text = list.find((s) => s.kind === 'text')!;
		expect(text.text).toBe('Jane Doe\nLine two');
		expect(text.x).toBeCloseTo(0.15, 2);

		// Check marks: the tool stays armed for several.
		await chooseTool(page, 'Check');
		await tapPage(page, 0.1, 0.1);
		await tapPage(page, 0.2, 0.1);
		await page.keyboard.press('Escape');
		list = await stamps(page);
		expect(list.filter((s) => s.kind === 'mark')).toHaveLength(2);

		// Move the signature by dragging.
		const b = await pageBox(page);
		const before = (await stamps(page)).find((s) => s.id === sig.id)!.box!;
		const cx = b.x + (before.x + before.w / 2) * b.width;
		const cy = b.y + (before.y + before.h / 2) * b.height;
		await page.mouse.move(cx, cy);
		await page.mouse.down();
		await page.mouse.move(cx + 20, cy + 10, { steps: 4 });
		await page.mouse.move(cx + 40, cy + 20, { steps: 4 });
		await page.mouse.up();
		const moved = (await stamps(page)).find((s) => s.id === sig.id)!.box!;
		expect(moved.x - before.x).toBeCloseTo(40 / b.width, 2);
		expect(moved.y - before.y).toBeCloseTo(20 / b.height, 2);
		expect(moved.w).toBeCloseTo(before.w, 6);

		// Resize from the bottom-right handle: aspect kept, top-left fixed.
		const handle = page.locator(`[data-stamp="${sig.id}"] [data-handle="se"]`);
		const hb = (await handle.boundingBox())!;
		await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
		await page.mouse.down();
		await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 5, { steps: 6 });
		await page.mouse.up();
		const resized = (await stamps(page)).find((s) => s.id === sig.id)!.box!;
		expect(resized.w).toBeGreaterThan(moved.w * 1.2);
		expect(resized.x).toBeCloseTo(moved.x, 6);
		expect(resized.y).toBeCloseTo(moved.y, 6);
		expect(resized.w / resized.h).toBeCloseTo(moved.w / moved.h, 4);

		// Undo: one step per drag.
		await page.getByRole('button', { name: 'Undo' }).click();
		expect((await stamps(page)).find((s) => s.id === sig.id)!.box).toEqual(moved);
		await page.keyboard.press('Control+z');
		expect((await stamps(page)).find((s) => s.id === sig.id)!.box).toEqual(before);
		await page.keyboard.press('Control+Shift+z');
		expect((await stamps(page)).find((s) => s.id === sig.id)!.box).toEqual(moved);

		// Delete with the keyboard.
		await page.locator(`[data-stamp="${sig.id}"]`).focus();
		await page.keyboard.press('Delete');
		expect((await stamps(page)).some((s) => s.id === sig.id)).toBe(false);
		await page.keyboard.press('Control+z');
		expect((await stamps(page)).some((s) => s.id === sig.id)).toBe(true);
	});

	test('text: clicking away saves it, clicking it again edits it', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		const box = page.getByRole('textbox', { name: 'Text on the page' });
		// The view may zoom in while typing, so click a fixed spot in the window.
		const vp = page.viewportSize()!;
		const away = () => page.mouse.click(vp.width / 2, vp.height * 0.75);
		await chooseTool(page, 'Text');
		await tapPage(page, 0.3, 0.2);
		await page.keyboard.type('Hello');
		await away();
		await expect(box).toHaveCount(0);
		await expect(page.getByTestId('live')).toHaveText('Text saved.');
		// At phone size the resize handles cover small text; the Edit button is the way in.
		if (info.project.name === 'phone') await page.getByRole('button', { name: 'Edit', exact: true }).click();
		else await page.locator('.stamp.text.ed').click();
		await expect(box).toBeFocused();
		await page.keyboard.type(' again');
		await away();
		await expect(box).toHaveCount(0);
		expect((await stamps(page)).find((s) => s.kind === 'text')!.text).toBe('Hello again');
		await expect(page.getByText('Internal Error')).toHaveCount(0);
	});

	test('text: a new box starts as selected "Text" and typing replaces it', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		const box = page.getByRole('textbox', { name: 'Text on the page' });
		const vp = page.viewportSize()!;
		const away = () => page.mouse.click(vp.width / 2, vp.height * 0.75);
		await chooseTool(page, 'Text');
		await tapPage(page, 0.3, 0.2);
		await expect(box).toBeFocused();
		await expect(box).toHaveValue('Text');
		expect(await box.evaluate((t: HTMLTextAreaElement) => [t.selectionStart, t.selectionEnd])).toEqual([0, 4]);
		// Nothing typed: clicking away leaves nothing behind.
		await away();
		await expect(box).toHaveCount(0);
		expect((await stamps(page)).filter((s) => s.kind === 'text')).toHaveLength(0);
		await chooseTool(page, 'Text');
		await tapPage(page, 0.3, 0.2);
		await page.keyboard.type('Hi');
		await away();
		expect((await stamps(page)).find((s) => s.kind === 'text')!.text).toBe('Hi');
	});

	test('dragging a stamp does not redraw the page', async ({ page }, info) => {
		test.skip(info.project.name === 'phone', 'mouse drag');
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Text');
		await tapPage(page, 0.3, 0.2);
		await page.keyboard.type('Move me');
		await page.getByRole('button', { name: 'Done editing' }).click();
		// Let the sharper redraw that follows a zoom change finish first.
		await page.waitForTimeout(800);
		await page.evaluate(() => {
			const w = window as unknown as { __redraws: number };
			w.__redraws = 0;
			const c = document.querySelector('[data-testid=editor-page] canvas')!;
			new MutationObserver((ms) => (w.__redraws += ms.length)).observe(c, { attributes: true });
		});
		const b = (await page.locator('.stamp.text.ed').boundingBox())!;
		await page.mouse.move(b.x + 6, b.y + b.height / 2);
		await page.mouse.down();
		for (let i = 1; i <= 10; i++) await page.mouse.move(b.x + 6 + i * 6, b.y + b.height / 2 + i * 4);
		await page.mouse.up();
		await expect(page.getByTestId('live')).toContainText('moved');
		expect(await page.evaluate(() => (window as unknown as { __redraws: number }).__redraws)).toBe(0);
	});

	test('text: characters the font cannot draw are shown and can be removed', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Text');
		await tapPage(page, 0.3, 0.3);
		await page.keyboard.type('Hi 中');
		await expect(page.locator('#bad-chars')).toContainText('中');
		await page.keyboard.press('Escape');
		// Still editing: the text was not accepted.
		await expect(page.getByRole('textbox', { name: 'Text on the page' })).toBeVisible();
		await page.getByRole('button', { name: 'Remove them' }).click();
		await page.getByRole('button', { name: 'Done editing' }).click();
		const t = (await stamps(page)).find((s) => s.kind === 'text')!;
		expect(t.text).toBe('Hi ');
	});

	test('keyboard: tools place at the centre, arrows nudge, page keys navigate', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=2');
		const tool = page.getByRole('button', { name: 'Cross', exact: true });
		await tool.focus();
		await page.keyboard.press('Enter');
		const [mark] = await stamps(page, 1);
		expect(mark.kind).toBe('mark');
		await expect(page.locator(`[data-stamp="${mark.id}"]`)).toBeFocused();
		await page.keyboard.press('Shift+ArrowRight');
		await page.keyboard.press('Shift+ArrowRight');
		const after = (await stamps(page, 1))[0];
		expect(after.box!.x - mark.box!.x).toBeCloseTo(0.04, 5);
		// Both key presses were one undo step.
		await page.keyboard.press('Control+z');
		expect((await stamps(page, 1))[0].box).toEqual(mark.box);
		await page.keyboard.press('Escape');
		await page.keyboard.press('PageDown');
		await expect(page.getByText('3 of 6')).toBeVisible();
		await page.getByRole('button', { name: 'Previous page' }).click();
		await expect(page.getByText('2 of 6')).toBeVisible();
	});

	test('copy to pages is one undo step', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Dot');
		await tapPage(page, 0.9, 0.9);
		await page.keyboard.press('Escape');
		const [dot] = await stamps(page, 0);
		await page.locator(`[data-stamp="${dot.id}"]`).click();
		await page.getByRole('button', { name: 'Copy to pages…' }).click();
		const dlg = page.getByRole('dialog', { name: 'Copy to pages' });
		await dlg.getByRole('radio', { name: /^Pages/ }).check();
		await dlg.getByRole('spinbutton', { name: 'From page' }).fill('2');
		await dlg.getByRole('spinbutton', { name: 'To page' }).fill('4');
		await dlg.getByRole('button', { name: 'Copy' }).click();
		const counts = await page.evaluate(() =>
			(window as unknown as { __editor: { store: { state: { pages: { stamps: unknown[] }[] } } } }).__editor.store.state.pages.map((p) => p.stamps.length)
		);
		expect(counts).toEqual([1, 1, 1, 1, 0, 0]);
		await page.keyboard.press('Control+z');
		const after = await page.evaluate(() =>
			(window as unknown as { __editor: { store: { state: { pages: { stamps: unknown[] }[] } } } }).__editor.store.state.pages.map((p) => p.stamps.length)
		);
		expect(after).toEqual([1, 0, 0, 0, 0, 0]);
	});

	test('saved signature survives a reload, is reused in one tap, and can be deleted', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await makeSignature(page, { save: true });
		await tapPage(page, 0.5, 0.5);
		expect(await stamps(page)).toHaveLength(1);

		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Signature');
		const dlg = page.getByRole('dialog', { name: 'Add signature' });
		await expect(dlg.getByText('Saved on this device')).toBeVisible();
		await expect(dlg.getByText('never uploaded')).toBeVisible();
		await dlg.getByRole('button', { name: 'Use saved signature 1' }).click();
		await expect(dlg).toBeHidden();
		await tapPage(page, 0.4, 0.8);
		const list = await stamps(page);
		expect(list).toHaveLength(1);
		expect(list[0].kind).toBe('image');

		await chooseTool(page, 'Signature');
		await dlg.getByRole('button', { name: 'Delete saved signature 1' }).click();
		await expect(dlg.getByText('Saved on this device')).toBeHidden();
		await page.keyboard.press('Escape');
		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Signature');
		await expect(dlg.getByRole('button', { name: 'Use saved signature 1' })).toHaveCount(0);
	});

	test('done closes the editor and returns focus to the opener', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(page.getByTestId('editor-page')).toBeHidden();
		const thumb = page.getByRole('button', { name: 'Edit page 3' });
		await thumb.click();
		await expect(page.getByText('3 of 6')).toBeVisible();
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await expect(thumb).toBeFocused();
	});

	test('upload: a photo of a signature, with the paper removed', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		// A grey "photo" with dark ink, made in the page.
		const png = await page.evaluate(async () => {
			const c = document.createElement('canvas');
			c.width = 400;
			c.height = 160;
			const ctx = c.getContext('2d')!;
			ctx.fillStyle = 'rgb(225 222 215)';
			ctx.fillRect(0, 0, 400, 160);
			ctx.strokeStyle = 'rgb(30 30 40)';
			ctx.lineWidth = 6;
			ctx.beginPath();
			ctx.moveTo(60, 100);
			ctx.bezierCurveTo(120, 20, 200, 160, 340, 60);
			ctx.stroke();
			const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
			return [...new Uint8Array(await b!.arrayBuffer())];
		});
		await chooseTool(page, 'Signature');
		const dlg = page.getByRole('dialog', { name: 'Add signature' });
		await dlg.getByRole('radio', { name: 'Upload a photo' }).click();
		await dlg.locator('input[type=file]').setInputFiles({ name: 'sig.png', mimeType: 'image/png', buffer: Buffer.from(png) });
		await expect(dlg.getByLabel('Preview of the signature')).toBeVisible();
		await dlg.getByRole('switch', { name: /Save on this device/ }).click();
		await dlg.getByRole('button', { name: 'Use signature' }).click();
		await expect(dlg).toBeHidden();
		await tapPage(page, 0.5, 0.5);
		await expect.poll(() => stamps(page).then((l) => l.length)).toBe(1);
		const asset = await page.evaluate(() => {
			const st = (window as unknown as { __editor: { store: { state: { assets: { width: number; height: number }[] } } } }).__editor.store.state;
			return st.assets[0];
		});
		// Cropped to the ink (about 280 x 90 px plus stroke), not the 400 x 160 photo.
		expect(asset.width).toBeLessThan(320);
		expect(asset.height).toBeLessThan(120);
	});
});

// ---------------------------------------------------------------------------
// Preview vs export: what the editor shows must be what the exported PDF draws.

interface Bbox {
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

/** Bounding boxes of blue ink in the top half and the bottom half of an image, as fractions. */
async function blueBoxes(page: import('@playwright/test').Page, dataUrl: string): Promise<{ top: Bbox | null; bottom: Bbox | null }> {
	return page.evaluate(async (url) => {
		const img = new Image();
		img.src = url;
		await img.decode();
		const c = document.createElement('canvas');
		c.width = img.naturalWidth;
		c.height = img.naturalHeight;
		const ctx = c.getContext('2d', { willReadFrequently: true })!;
		ctx.drawImage(img, 0, 0);
		const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
		const boxes = [null, null] as (null | { x0: number; y0: number; x1: number; y1: number })[];
		for (let y = 0; y < height; y++)
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				const r = data[i];
				const g = data[i + 1];
				const b = data[i + 2];
				if (!(b - r > 45 && b - g > 25)) continue;
				const k = y < height / 2 ? 0 : 1;
				const bb = (boxes[k] ??= { x0: x, y0: y, x1: x, y1: y });
				bb.x0 = Math.min(bb.x0, x);
				bb.y0 = Math.min(bb.y0, y);
				bb.x1 = Math.max(bb.x1, x + 1);
				bb.y1 = Math.max(bb.y1, y + 1);
			}
		const norm = (bb: (typeof boxes)[number]) =>
			bb && { x0: bb.x0 / width, y0: bb.y0 / height, x1: bb.x1 / width, y1: bb.y1 / height };
		return { top: norm(boxes[0]), bottom: norm(boxes[1]) };
	}, dataUrl);
}

const CASES = [
	{ name: 'rotation 0', query: 'file=multi.pdf&page=1' },
	{ name: 'user rotation 90', query: 'file=multi.pdf&page=1&rotate=90' },
	{ name: 'intrinsic /Rotate 90', query: 'file=rotated.pdf&page=2' },
	{ name: 'CropBox offset', query: 'file=cropbox.pdf&page=2' },
	{ name: 'CropBox offset + /Rotate 270 + user 180', query: 'file=cropbox.pdf&page=5&rotate=180' }
];

for (const c of CASES) {
	test(`preview matches export: ${c.name}`, async ({ page }, info) => {
		const pageNo = Number(/page=(\d+)/.exec(c.query)![1]);
		const sheet = await openEditor(page, c.query);

		await makeSignature(page, { ink: 'Blue', save: false });
		await tapPage(page, 0.4, 0.25);

		await chooseTool(page, 'Text');
		await tapPage(page, 0.2, 0.72);
		await page.keyboard.type('Signed Hq 2026');
		await page.keyboard.press('Enter');
		await page.keyboard.type('Wy line two');
		await page.keyboard.press('Escape');
		await page.getByRole('radio', { name: 'Blue' }).click();
		// Larger text gives a sharper measurement.
		await page.getByRole('button', { name: 'Larger text' }).click();
		await page.getByRole('button', { name: 'Larger text' }).click();
		await page.keyboard.press('Escape');
		await page.locator('body').evaluate((el) => (document.activeElement as HTMLElement | null)?.blur());
		await page.mouse.move(0, 0);
		// Let the sharp re-render and the font settle.
		await page.evaluate(() => document.fonts.ready);
		await page.waitForTimeout(400);

		const shot = await sheet.screenshot({ scale: 'css' });
		const preview = await blueBoxes(page, `data:image/png;base64,${shot.toString('base64')}`);
		const b = await pageBox(page);
		const exported = await page.evaluate(
			({ i, w }) => (window as unknown as { __editor: { exportPage: (i: number, w: number) => Promise<{ dataUrl: string }> } }).__editor.exportPage(i, w),
			{ i: pageNo - 1, w: Math.round(b.width * 2) }
		);
		const out = await blueBoxes(page, exported.dataUrl);

		expect(preview.top, 'signature visible in preview').not.toBeNull();
		expect(preview.bottom, 'text visible in preview').not.toBeNull();
		expect(out.top, 'signature in export').not.toBeNull();
		expect(out.bottom, 'text in export').not.toBeNull();
		let worst = 0;
		for (const k of ['top', 'bottom'] as const)
			for (const e of ['x0', 'y0', 'x1', 'y1'] as const) worst = Math.max(worst, Math.abs(preview[k]![e] - out[k]![e]));
		info.annotations.push({ type: 'max-error', description: `${(worst * 100).toFixed(2)}% of page size` });
		console.log(`[${info.project.name}] ${c.name}: max bbox error ${(worst * 100).toFixed(3)}% of page`);
		expect(worst).toBeLessThan(0.01);
	});
}

test('draw pad: undo stroke and clear', async ({ page }) => {
	await openEditor(page, 'file=multi.pdf&page=1');
	await chooseTool(page, 'Initials');
	const dlg = page.getByRole('dialog', { name: 'Add initials' });
	const use = dlg.getByRole('button', { name: 'Use initials' });
	await expect(use).toBeDisabled();
	await drawOnPad(page);
	await expect(use).toBeEnabled();
	await dlg.getByRole('button', { name: 'Undo stroke' }).click();
	await expect(use).toBeEnabled();
	await dlg.getByRole('button', { name: 'Clear' }).click();
	await expect(use).toBeDisabled();
	await dlg.getByRole('button', { name: 'Cancel' }).click();
	await expect(dlg).toBeHidden();
});

test('zoom: buttons and Ctrl+wheel zoom about a point and re-render sharp', async ({ page }, info) => {
	test.skip(info.project.name === 'phone', 'zoom buttons are desktop chrome; pinch is tested below');
	const sheet = await openEditor(page, 'file=multi.pdf&page=1');
	const canvasWidth = () => page.locator('[data-testid=editor-page] canvas').evaluate((c: HTMLCanvasElement) => c.width);
	const w0 = (await sheet.boundingBox())!.width;
	const px0 = await canvasWidth();
	await page.getByRole('button', { name: 'Zoom in' }).click();
	await page.getByRole('button', { name: 'Zoom in' }).click();
	expect((await sheet.boundingBox())!.width).toBeCloseTo(w0 * 1.5625, 0);
	await expect.poll(canvasWidth).toBeGreaterThan(px0 * 1.4);

	// Ctrl+wheel keeps the point under the cursor in place.
	await page.getByRole('button', { name: /Fit page/ }).click();
	const b = (await sheet.boundingBox())!;
	const cx = b.x + b.width * 0.3;
	const cy = b.y + b.height * 0.6;
	await page.mouse.move(cx, cy);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -200);
	await page.keyboard.up('Control');
	const z = (await sheet.boundingBox())!;
	expect(z.width).toBeGreaterThan(b.width * 1.5);
	expect((cx - z.x) / z.width).toBeCloseTo(0.3, 2);
	expect((cy - z.y) / z.height).toBeCloseTo(0.6, 2);

	// Placing while zoomed lands where clicked.
	await chooseTool(page, 'Dot');
	await page.mouse.click(cx, cy);
	const [dot] = await stamps(page);
	expect(dot.box!.x + dot.box!.w / 2).toBeCloseTo(0.3, 2);
	expect(dot.box!.y + dot.box!.h / 2).toBeCloseTo(0.6, 2);
});

test('pinch-zoom with two fingers and swipe between pages (emulated touch)', async ({ page }, info) => {
	test.skip(info.project.name !== 'phone', 'touch emulation only on the phone project');
	const sheet = await openEditor(page, 'file=multi.pdf&page=2');
	const cdp = await page.context().newCDPSession(page);
	const b = (await sheet.boundingBox())!;
	const cx = b.x + b.width / 2;
	const cy = b.y + b.height / 2;
	const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: [number, number][]) =>
		cdp.send('Input.dispatchTouchEvent', {
			type,
			touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }))
		});
	await touch('touchStart', [
		[cx - 40, cy],
		[cx + 40, cy]
	]);
	for (let i = 1; i <= 8; i++)
		await touch('touchMove', [
			[cx - 40 - i * 10, cy],
			[cx + 40 + i * 10, cy]
		]);
	await touch('touchEnd', []);
	const z = (await sheet.boundingBox())!;
	// Fingers went from 80 px apart to 240 px: three times the size.
	expect(z.width / b.width).toBeCloseTo(3, 1);

	// Back to fit with the keyboard shortcut, then swipe left for the next page.
	await page.keyboard.press('0');
	await touch('touchStart', [[cx + 120, cy]]);
	for (let i = 1; i <= 6; i++) await touch('touchMove', [[cx + 120 - i * 40, cy + 2]]);
	await touch('touchEnd', []);
	await expect(page.getByText('3 of 6')).toBeVisible();
});

test('type a signature: pick a style, place it, export it', async ({ page }) => {
	await openEditor(page, 'file=multi.pdf&page=1');
	await chooseTool(page, 'Signature');
	const dlg = page.getByRole('dialog', { name: 'Add signature' });
	await dlg.getByRole('radio', { name: 'Type' }).click();
	await dlg.getByRole('textbox', { name: 'Your name' }).fill('Renée Łukasz');
	const styles = dlg.getByRole('radiogroup', { name: 'Handwriting style' });
	await expect(styles.getByRole('radio')).toHaveCount(3);
	// The fonts came from our own origin, as woff2.
	await styles.getByRole('radio', { name: /^Flowing style/ }).click();
	await expect(styles.getByRole('radio', { name: /^Flowing style/ })).toHaveAttribute('aria-checked', 'true');
	await dlg.getByRole('switch', { name: /Save on this device/ }).click();
	await dlg.getByRole('button', { name: 'Use signature' }).click();
	await expect(dlg).toBeHidden();
	await tapPage(page, 0.5, 0.6);
	const list = await stamps(page);
	expect(list).toHaveLength(1);
	expect(list[0].kind).toBe('image');
	const asset = await page.evaluate(() => {
		const st = (window as unknown as { __editor: { store: { state: { assets: { width: number; height: number }[] } } } }).__editor.store.state;
		return st.assets[0];
	});
	// Rendered large and cropped tight: wide and short.
	expect(asset.width).toBeGreaterThan(600);
	expect(asset.width / asset.height).toBeGreaterThan(3);

	const out = await page.evaluate(() =>
		(window as unknown as { __editor: { exportPage: (i: number, w: number) => Promise<{ checks: { ok: boolean }[] }> } }).__editor.exportPage(0, 400)
	);
	expect(out.checks.every((c) => c.ok)).toBe(true);
});

test('type: characters a style lacks are named instead of drawn', async ({ page }) => {
	await openEditor(page, 'file=multi.pdf&page=1');
	await chooseTool(page, 'Initials');
	const dlg = page.getByRole('dialog', { name: 'Add initials' });
	await dlg.getByRole('radio', { name: 'Type' }).click();
	await dlg.getByRole('textbox', { name: 'Your initials' }).fill('Ж.Д');
	const styles = dlg.getByRole('radiogroup', { name: 'Handwriting style' });
	await expect(styles.getByRole('radio').first()).toHaveAccessibleName(/cannot write Ж Д/);
	await expect(dlg.getByRole('alert')).toContainText('cannot write Ж Д');
	await expect(dlg.getByRole('button', { name: 'Use initials' })).toBeDisabled();
	await dlg.getByRole('textbox', { name: 'Your initials' }).fill('JD');
	await expect(dlg.getByRole('button', { name: 'Use initials' })).toBeEnabled();
});

test('ink colour is remembered', async ({ page }) => {
	await openEditor(page, 'file=multi.pdf&page=1');
	await chooseTool(page, 'Signature');
	const dlg = page.getByRole('dialog', { name: 'Add signature' });
	await dlg.getByRole('radio', { name: 'Blue' }).click();
	await dlg.getByRole('button', { name: 'Cancel' }).click();
	await page.reload();
	await openEditor(page, 'file=multi.pdf&page=1');
	await chooseTool(page, 'Signature');
	await expect(dlg.getByRole('radio', { name: 'Blue' })).toHaveAttribute('aria-checked', 'true');
});
