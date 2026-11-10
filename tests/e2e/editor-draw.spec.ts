// Highlight and Redact: boxes drawn with a drag (mouse, pen or one finger).
import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, openEditor, pageBox, stamps, tapPage } from './editor-helpers';

type Box = { x: number; y: number; w: number; h: number };

const isPhone = (info: TestInfo) => info.project.name === 'phone';

async function touchSession(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: [number, number][]) =>
		cdp.send('Input.dispatchTouchEvent', {
			type,
			touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 }))
		});
	return { cdp, touch };
}

let cdpFor = new WeakMap<Page, Awaited<ReturnType<typeof touchSession>>>();

/**
 * Press at one page fraction, drag to another, release: the mouse on desktop,
 * one finger (real touch events) on the phone project. `during` runs before release.
 */
async function dragOnPage(page: Page, info: TestInfo, from: [number, number], to: [number, number], during?: () => Promise<void>) {
	const b = await pageBox(page);
	const x0 = b.x + from[0] * b.width;
	const y0 = b.y + from[1] * b.height;
	const x1 = b.x + to[0] * b.width;
	const y1 = b.y + to[1] * b.height;
	const steps = 8;
	if (isPhone(info)) {
		let s = cdpFor.get(page);
		if (!s) cdpFor.set(page, (s = await touchSession(page)));
		await s.touch('touchStart', [[x0, y0]]);
		for (let i = 1; i <= steps; i++) await s.touch('touchMove', [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
		await during?.();
		await s.touch('touchEnd', []);
	} else {
		await page.mouse.move(x0, y0);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
		await during?.();
		await page.mouse.up();
	}
}

function expectBox(actual: Box | undefined, want: Box, digits = 2) {
	expect(actual).toBeDefined();
	for (const k of ['x', 'y', 'w', 'h'] as const) expect(actual![k], k).toBeCloseTo(want[k], digits);
}

const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true });

test.beforeEach(() => {
	cdpFor = new WeakMap();
});

test.describe('drawn tools', () => {
	test('highlight: a drag draws the box, the tool stays armed, Escape puts it away', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
		await expect(page.locator('.armed-hint').first()).toContainText('Drag over what to highlight');

		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34], async () => {
			// The box follows the pointer before it is let go, and nothing is in the store yet.
			await expect(page.getByTestId('draft-box')).toBeVisible();
			expect(await stamps(page)).toHaveLength(0);
		});
		await expect(page.getByTestId('draft-box')).toHaveCount(0);
		let list = await stamps(page);
		expect(list).toHaveLength(1);
		expect(list[0].kind).toBe('highlight');
		expect((list[0] as { color?: string }).color).toBe('yellow');
		expectBox(list[0].box, { x: 0.2, y: 0.3, w: 0.4, h: 0.04 });
		await expect(page.getByTestId('live')).toHaveText('Highlight placed, yellow.');
		await expect(page.locator(`[data-stamp="${list[0].id}"]`)).toHaveAccessibleName(/^Highlight, yellow/);

		// Still armed: the next line is one more drag, drawn right to left this time.
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
		await dragOnPage(page, info, [0.7, 0.42], [0.25, 0.38]);
		list = await stamps(page);
		expect(list).toHaveLength(2);
		expectBox(list[1].box, { x: 0.25, y: 0.38, w: 0.45, h: 0.04 });

		// Each box is one undo step.
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toHaveLength(1);
		await page.keyboard.press('Control+Shift+z');
		expect(await stamps(page)).toHaveLength(2);

		await page.keyboard.press('Escape');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false');
		await expect(page.locator('.armed-hint')).toHaveCount(0);
		// Put away: a drag on the page no longer draws.
		await dragOnPage(page, info, [0.2, 0.6], [0.5, 0.65]);
		expect(await stamps(page)).toHaveLength(2);

		// Tapping the tool again also puts it away.
		await chooseTool(page, 'Highlight');
		await chooseTool(page, 'Highlight');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false');
	});

	test('a tap places a default box; a tiny drag does too', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		const pt = await page.evaluate(() => {
			const s = (window as unknown as { __editor: { store: { state: { pages: unknown[] }; displayedSize: (p: unknown) => { height: number } } } }).__editor.store;
			return s.displayedSize(s.state.pages[0]).height;
		});
		const lineH = (11 / pt) * 1.4;
		await chooseTool(page, 'Redact');
		if (isPhone(info)) {
			const b = await pageBox(page);
			await page.touchscreen.tap(b.x + 0.5 * b.width, b.y + 0.5 * b.height);
		} else await tapPage(page, 0.5, 0.5);
		let list = await stamps(page);
		expect(list).toHaveLength(1);
		expect(list[0].kind).toBe('redact');
		expectBox(list[0].box, { x: 0.35, y: 0.5 - lineH / 2, w: 0.3, h: lineH }, 2);

		// A slip of a few pixels is not a box of a few pixels.
		const b = await pageBox(page);
		const d = 10 / b.width;
		await dragOnPage(page, info, [0.4, 0.7], [0.4 + d, 0.7 + 3 / b.height]);
		list = await stamps(page);
		expect(list).toHaveLength(2);
		expect(list[1].box!.w).toBeCloseTo(0.3, 3);
		expect(list[1].box!.h).toBeCloseTo(lineH, 3);
		expect(list[1].box!.x + list[1].box!.w / 2).toBeCloseTo(0.4, 3);

		// A long stroke along a line keeps its length and gets one line's height.
		await dragOnPage(page, info, [0.2, 0.8], [0.2 + 150 / b.width, 0.8 + 2 / b.height]);
		list = await stamps(page);
		expect(list).toHaveLength(3);
		expect(list[2].box!.w).toBeCloseTo(150 / b.width, 2);
		expect(list[2].box!.h).toBeCloseTo(lineH, 3);
		expect(list[2].box!.x).toBeCloseTo(0.2, 2);
	});

	test('redaction: black, see-through while selected, a one-time note, drawn under other stamps', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		// A check mark first, then a redaction box over it.
		await chooseTool(page, 'Check');
		await tapPage(page, 0.4, 0.4);
		await page.keyboard.press('Escape');
		await chooseTool(page, 'Redact');
		await dragOnPage(page, info, [0.3, 0.35], [0.6, 0.45]);
		const note = page.getByTestId('editor-note');
		await expect(note).toHaveText('Redacted areas are removed from the file when you export, not just covered.');
		const list = await stamps(page);
		const red = list.find((s) => s.kind === 'redact')!;
		const el = page.locator(`[data-stamp="${red.id}"]`);
		await expect(el).toHaveAccessibleName(/^Redaction, selected/);
		const fill = el.locator('.fill');
		expect(await fill.evaluate((f) => getComputedStyle(f).backgroundColor)).toBe('rgb(0, 0, 0)');
		expect(await fill.evaluate((f) => getComputedStyle(f).opacity)).toBe('0.75');

		// Order in the layer matches the export: redaction first, the mark drawn after.
		const order = await page.locator('[data-stamp]').evaluateAll((els) => els.map((e) => (e as HTMLElement).className.match(/\b(redact|mark|highlight)\b/)?.[1]));
		expect(order).toEqual(['redact', 'mark']);

		// Put away and deselected: solid.
		await page.keyboard.press('Escape');
		await page.keyboard.press('Escape');
		await expect(el).toHaveAccessibleName(/^Redaction$/);
		expect(await fill.evaluate((f) => getComputedStyle(f).opacity)).toBe('1');

		// The note is shown once per visit: not again in a reopened editor.
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await page.getByRole('button', { name: 'Edit page 1' }).click();
		await chooseTool(page, 'Redact');
		await dragOnPage(page, info, [0.3, 0.6], [0.6, 0.65]);
		expect(await stamps(page)).toHaveLength(3);
		await expect(note).toHaveCount(0);
	});

	test('highlight colours: chosen on a selected box, remembered for the next one', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34]);
		// The new box is selected, so its colour can be changed right away.
		const colours = page.getByRole('radiogroup', { name: 'Highlight colour' });
		await expect(colours.getByRole('radio')).toHaveCount(3);
		await expect(colours.getByRole('radio', { name: 'Yellow' })).toHaveAttribute('aria-checked', 'true');
		await colours.getByRole('radio', { name: 'Green' }).click();
		let [h] = await stamps(page);
		expect((h as { color?: string }).color).toBe('green');
		const el = page.locator(`[data-stamp="${h.id}"]`);
		await expect(el).toHaveAccessibleName(/^Highlight, green/);
		// Drawn like the export: the export colour, multiplied with the page.
		expect(await el.evaluate((e) => getComputedStyle(e).mixBlendMode)).toBe('multiply');
		expect(await el.locator('.fill').evaluate((f) => getComputedStyle(f).backgroundColor)).toBe('rgb(165, 243, 107)');

		// Next box: green.
		await dragOnPage(page, info, [0.2, 0.5], [0.6, 0.54]);
		let list = await stamps(page);
		expect((list[1] as { color?: string }).color).toBe('green');

		// Select an existing one with the tool put away and make it pink.
		await page.keyboard.press('Escape');
		await page.locator(`[data-stamp="${h.id}"]`).click();
		await colours.getByRole('radio', { name: 'Pink' }).click();
		[h] = await stamps(page);
		expect((h as { color?: string }).color).toBe('pink');
		// Colour change is one undo step.
		await page.keyboard.press('Control+z');
		expect((await stamps(page))[0].color).toBe('green');

		// Remembered on this device.
		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34]);
		list = await stamps(page);
		expect((list[0] as { color?: string }).color).toBe('pink');
	});

	test('a placed box moves, resizes freely, deletes and duplicates like other stamps', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await dragOnPage(page, info, [0.2, 0.3], [0.5, 0.35]);
		await page.keyboard.press('Escape');
		const [h] = await stamps(page);
		const start = h.box!;
		const b = await pageBox(page);
		const el = page.locator(`[data-stamp="${h.id}"]`);

		// Move: on touch with the move grip, with the mouse by the box itself.
		await el.click();
		const grab = isPhone(info) ? (await el.locator('[data-handle="move"]').boundingBox())! : (await el.boundingBox())!;
		const gx = grab.x + grab.width / 2;
		const gy = grab.y + grab.height / 2;
		await page.mouse.move(gx, gy);
		await page.mouse.down();
		await page.mouse.move(gx + 20, gy + 15, { steps: 4 });
		await page.mouse.move(gx + 40, gy + 30, { steps: 4 });
		await page.mouse.up();
		const moved = (await stamps(page))[0].box!;
		expect(moved.x - start.x).toBeCloseTo(40 / b.width, 2);
		expect(moved.y - start.y).toBeCloseTo(30 / b.height, 2);
		expect(moved.w).toBeCloseTo(start.w, 6);

		// Resize from the corner handle: not locked to the shape.
		const hb = (await el.locator('[data-handle="se"]').boundingBox())!;
		await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
		await page.mouse.down();
		await page.mouse.move(hb.x + hb.width / 2 + 60, hb.y + hb.height / 2 + 2, { steps: 6 });
		await page.mouse.up();
		const resized = (await stamps(page))[0].box!;
		expect(resized.x).toBeCloseTo(moved.x, 6);
		expect(resized.y).toBeCloseTo(moved.y, 6);
		expect(resized.w - moved.w).toBeCloseTo(60 / b.width, 2);
		expect(resized.h - moved.h).toBeCloseTo(2 / b.height, 2);

		// Undo walks back one drag at a time.
		await page.keyboard.press('Control+z');
		expect((await stamps(page))[0].box).toEqual(moved);
		await page.keyboard.press('Control+z');
		expect((await stamps(page))[0].box).toEqual(start);
		await page.keyboard.press('Control+y');
		await page.keyboard.press('Control+y');
		expect((await stamps(page))[0].box).toEqual(resized);

		// Duplicate and delete.
		await page.getByRole('button', { name: 'Duplicate' }).click();
		expect(await stamps(page)).toHaveLength(2);
		await page.getByRole('button', { name: 'Delete' }).click();
		expect(await stamps(page)).toHaveLength(1);
	});

	test('boxes drawn on a rotated page are stored as fractions of the page as shown', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1&rotate=90');
		const b = await pageBox(page);
		// Rotated: the page is shown landscape.
		expect(b.width).toBeGreaterThan(b.height);
		await chooseTool(page, 'Highlight');
		await dragOnPage(page, info, [0.1, 0.2], [0.7, 0.3]);
		await chooseTool(page, 'Redact');
		await dragOnPage(page, info, [0.6, 0.8], [0.3, 0.55]);
		const list = await stamps(page);
		expectBox(list.find((s) => s.kind === 'highlight')!.box, { x: 0.1, y: 0.2, w: 0.6, h: 0.1 });
		expectBox(list.find((s) => s.kind === 'redact')!.box, { x: 0.3, y: 0.55, w: 0.3, h: 0.25 });
		// Drawn where they were dragged.
		const hb = (await page.locator('.stamp.highlight.ed').boundingBox())!;
		expect((hb.x - b.x) / b.width).toBeCloseTo(0.1, 2);
		expect((hb.y - b.y) / b.height).toBeCloseTo(0.2, 2);
	});

	test('drawing a box does not redraw the page', async ({ page }, info) => {
		test.skip(isPhone(info), 'mouse drag');
		await openEditor(page, 'file=multi.pdf&page=1');
		await page.waitForTimeout(500);
		await page.evaluate(() => {
			const w = window as unknown as { __redraws: number };
			w.__redraws = 0;
			const c = document.querySelector('[data-testid=editor-page] canvas')!;
			new MutationObserver((ms) => (w.__redraws += ms.length)).observe(c, { attributes: true });
		});
		await chooseTool(page, 'Highlight');
		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34]);
		await dragOnPage(page, info, [0.2, 0.4], [0.6, 0.44]);
		expect(await stamps(page)).toHaveLength(2);
		expect(await page.evaluate(() => (window as unknown as { __redraws: number }).__redraws)).toBe(0);
	});

	test('keyboard: Enter on the tool places a default box at the centre, selected', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await tool(page, 'Highlight').focus();
		await page.keyboard.press('Enter');
		const [h] = await stamps(page);
		expect(h.kind).toBe('highlight');
		expect(h.box!.x + h.box!.w / 2).toBeCloseTo(0.5, 3);
		expect(h.box!.y + h.box!.h / 2).toBeCloseTo(0.5, 3);
		await expect(page.locator(`[data-stamp="${h.id}"]`)).toBeFocused();
		await page.keyboard.press('Shift+ArrowDown');
		expect((await stamps(page))[0].box!.y).toBeCloseTo(h.box!.y + 0.02, 5);
	});

	test('pinch-zoom still works with a drawn tool armed, and draws nothing', async ({ page }, info) => {
		test.skip(!isPhone(info), 'touch emulation only on the phone project');
		const sheet = await openEditor(page, 'file=multi.pdf&page=2');
		await chooseTool(page, 'Highlight');
		const { touch } = await touchSession(page);
		const b = (await sheet.boundingBox())!;
		const cx = b.x + b.width / 2;
		const cy = b.y + b.height / 2;
		// The second finger lands a moment after the first has started to move.
		await touch('touchStart', [[cx - 40, cy]]);
		await touch('touchMove', [[cx - 52, cy]]);
		await touch('touchStart', [
			[cx - 52, cy],
			[cx + 40, cy]
		]);
		for (let i = 1; i <= 8; i++)
			await touch('touchMove', [
				[cx - 52 - i * 10, cy],
				[cx + 40 + i * 10, cy]
			]);
		await touch('touchEnd', []);
		const z = (await sheet.boundingBox())!;
		expect(z.width / b.width).toBeGreaterThan(2);
		expect(await stamps(page, 1)).toHaveLength(0);
		await expect(page.getByTestId('draft-box')).toHaveCount(0);
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');

		// Zoomed in, one finger still draws (it does not pan).
		const before = (await sheet.boundingBox())!;
		await dragOnPage(page, info, [0.45, 0.5], [0.55, 0.52]);
		const after = (await sheet.boundingBox())!;
		expect(after.x).toBeCloseTo(before.x, 0);
		expect(await stamps(page, 1)).toHaveLength(1);
	});
});

test.describe('phone tool bar', () => {
	for (const width of [360, 412]) {
		test(`scrolls sideways to show all nine tools at ${width}px`, async ({ page }, info) => {
			test.skip(!isPhone(info), 'phone layout');
			await page.setViewportSize({ width, height: 800 });
			await openEditor(page, 'file=multi.pdf&page=1');
			const bar = page.getByRole('toolbar', { name: 'Tools' });
			await expect(bar.getByRole('button')).toHaveCount(9);
			// No sideways scrolling of the page itself.
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			const m = await bar.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth, cls: el.className }));
			expect(m.sw).toBeGreaterThan(m.cw);
			expect(m.cls).toContain('fade-end');
			expect(m.cls).not.toContain('fade-start');
			for (const b of await bar.getByRole('button').all()) {
				const bb = (await b.boundingBox())!;
				expect(bb.width).toBeGreaterThanOrEqual(48);
				expect(bb.height).toBeGreaterThanOrEqual(48);
			}

			// A finger swipe scrolls the bar to its end.
			const bb = (await bar.boundingBox())!;
			const { touch } = await touchSession(page);
			const y = bb.y + bb.height / 2;
			await touch('touchStart', [[bb.x + bb.width - 30, y]]);
			for (let i = 1; i <= 10; i++) await touch('touchMove', [[bb.x + bb.width - 30 - i * 25, y]]);
			await touch('touchEnd', []);
			await expect.poll(() => bar.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
			await bar.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
			await expect(bar).toHaveClass(/fade-start/);
			await expect(bar).not.toHaveClass(/fade-end/);
			const red = (await tool(page, 'Redact').boundingBox())!;
			expect(red.x + red.width).toBeLessThanOrEqual(bb.x + bb.width + 1);

			// Back to the start; tapping the half-hidden Highlight tool scrolls it fully into view.
			await bar.evaluate((el) => el.scrollTo({ left: 0 }));
			await expect(bar).not.toHaveClass(/fade-start/);
			const hl = tool(page, 'Highlight');
			let hb = (await hl.boundingBox())!;
			const right = bb.x + bb.width;
			// Scroll so that only its left part shows.
			await bar.evaluate((el, d) => el.scrollTo({ left: d }), Math.max(0, hb.x + hb.width * 0.6 - right));
			hb = (await hl.boundingBox())!;
			expect(hb.x + hb.width).toBeGreaterThan(right);
			await page.touchscreen.tap(Math.min(hb.x + 10, right - 6), hb.y + hb.height / 2);
			await expect(hl).toHaveAttribute('aria-pressed', 'true');
			await expect.poll(async () => {
				const b2 = (await hl.boundingBox())!;
				return b2.x + b2.width <= right;
			}).toBe(true);
		});
	}
});
