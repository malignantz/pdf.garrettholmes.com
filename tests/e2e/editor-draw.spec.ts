// Highlight (a freehand pen stroke by default, or a box) and Redact (a box), drawn
// with a drag: mouse, pen or one finger.
import type { CDPSession, Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, highlightShape, moreButton, openEditor, pageBox, stamps, tapPage, type StampJson } from './editor-helpers';

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

/** Press, move through page fractions, release: the mouse on desktop, one finger on the phone. */
async function drawPath(page: Page, info: TestInfo, pts: [number, number][], during?: () => Promise<void>) {
	const b = await pageBox(page);
	const at = ([fx, fy]: [number, number]): [number, number] => [b.x + fx * b.width, b.y + fy * b.height];
	// Several samples per leg, like a real pointer.
	const path: [number, number][] = [at(pts[0])];
	for (let i = 1; i < pts.length; i++) {
		const [x0, y0] = at(pts[i - 1]);
		const [x1, y1] = at(pts[i]);
		for (let k = 1; k <= 6; k++) path.push([x0 + ((x1 - x0) * k) / 6, y0 + ((y1 - y0) * k) / 6]);
	}
	if (isPhone(info)) {
		let s = cdpFor.get(page);
		if (!s) cdpFor.set(page, (s = await touchSession(page)));
		await s.touch('touchStart', [path[0]]);
		for (const p of path.slice(1)) await s.touch('touchMove', [p]);
		await during?.();
		await s.touch('touchEnd', []);
	} else {
		await page.mouse.move(...path[0]);
		await page.mouse.down();
		for (const p of path.slice(1)) await page.mouse.move(...p);
		await during?.();
		await page.mouse.up();
	}
}

const penOf = (s: StampJson) => s.pen!;

/** Export the page through the dev harness; returns the checks and the rendered image. */
async function exportPage(page: Page, i = 0, width = 600) {
	return page.evaluate(
		({ i, w }) =>
			(window as unknown as { __editor: { exportPage: (i: number, w: number) => Promise<{ dataUrl: string; checks: { name: string; ok: boolean }[] }> } }).__editor.exportPage(i, w),
		{ i, w: width }
	);
}

/** RGB at page fractions of an exported page image. */
async function pixels(page: Page, dataUrl: string, at: [number, number][]) {
	return page.evaluate(
		async ({ url, at }) => {
			const img = new Image();
			img.src = url;
			await img.decode();
			const c = document.createElement('canvas');
			c.width = img.naturalWidth;
			c.height = img.naturalHeight;
			const ctx = c.getContext('2d', { willReadFrequently: true })!;
			ctx.drawImage(img, 0, 0);
			return at.map(([fx, fy]) => [...ctx.getImageData(Math.floor(fx * c.width), Math.floor(fy * c.height), 1, 1).data.slice(0, 3)]);
		},
		{ url: dataUrl, at }
	);
}

const yellowish = (p: number[]) => p[0] > 220 && p[1] > 200 && p[2] < 140;
const whiteish = (p: number[]) => p.every((v) => v > 240);

function expectBox(actual: Box | undefined, want: Box, digits = 2) {
	expect(actual).toBeDefined();
	for (const k of ['x', 'y', 'w', 'h'] as const) expect(actual![k], k).toBeCloseTo(want[k], digits);
}

const tool = (page: Page, name: string) => page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name, exact: true });

test.beforeEach(() => {
	cdpFor = new WeakMap();
});

test.describe('drawn tools', () => {
	test('highlight pen: a drag draws one stroke, the tool stays armed, Escape puts it away', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
		// The page has text, so Text is the default shape; the bar offers Text | Pen | Box and the colours.
		const bar = page.getByRole('toolbar', { name: 'Highlighter' });
		await expect(bar).toBeVisible();
		const shapes = bar.getByRole('radiogroup', { name: 'Highlight shape' });
		await expect(shapes.getByRole('radio')).toHaveText(['Text', 'Pen', 'Box']);
		await expect(shapes.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
		await highlightShape(page, 'Pen');
		await expect(shapes.getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'false');
		await expect(page.locator('.armed-hint').first()).toContainText('Drag over the text to highlight');
		await expect(bar.getByRole('radiogroup', { name: 'Highlight colour' }).getByRole('radio')).toHaveCount(3);

		// A wavy stroke: the preview follows the pointer, nothing is stored before release.
		const wave: [number, number][] = [
			[0.2, 0.3],
			[0.3, 0.34],
			[0.4, 0.3],
			[0.5, 0.35],
			[0.6, 0.3]
		];
		await drawPath(page, info, wave, async () => {
			await expect(page.getByTestId('draft-stroke')).toBeVisible();
			expect(await stamps(page)).toHaveLength(0);
		});
		await expect(page.getByTestId('draft-stroke')).toHaveCount(0);
		let list = await stamps(page);
		expect(list).toHaveLength(1);
		expect(list[0].kind).toBe('highlight');
		expect(list[0].color).toBe('yellow');
		const pts = penOf(list[0]).points;
		// Simplified: the corners of the wave, not every pointer sample.
		expect(pts.length).toBeGreaterThanOrEqual(4);
		expect(pts.length).toBeLessThan(15);
		expect(pts[0].x).toBeCloseTo(0.2, 2);
		expect(pts[pts.length - 1].x).toBeCloseTo(0.6, 2);
		// About 14 pt wide.
		const pt = await page.evaluate(() => {
			const s = (window as unknown as { __editor: { store: { state: { pages: unknown[] }; displayedSize: (p: unknown) => { height: number } } } }).__editor.store;
			return s.displayedSize(s.state.pages[0]).height;
		});
		expect(penOf(list[0]).width * pt).toBeCloseTo(14, 1);
		await expect(page.getByTestId('live')).toHaveText('Highlight placed, yellow.');
		const el = page.locator(`[data-stamp="${list[0].id}"]`);
		await expect(el).toHaveAccessibleName(/^Highlight, yellow/);
		// Drawn like the export: one path in the export colour, round ends, multiplied with the page.
		expect(await el.evaluate((e) => getComputedStyle(e).mixBlendMode)).toBe('multiply');
		const path = el.locator('svg path').first();
		expect(await path.getAttribute('stroke-linecap')).toBe('round');
		expect(await path.getAttribute('stroke-linejoin')).toBe('round');
		expect(await path.getAttribute('stroke')).toBe('#FFEB3B');
		// Not selected, so the highlighter bar stays.
		await expect(bar).toBeVisible();

		// Still armed: the next stroke is one more drag.
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
		await drawPath(page, info, [
			[0.7, 0.5],
			[0.25, 0.6]
		]);
		list = await stamps(page);
		expect(list).toHaveLength(2);
		expect(penOf(list[1]).points).toHaveLength(2);

		// A tap with no movement makes nothing.
		if (isPhone(info)) {
			const b = await pageBox(page);
			await page.touchscreen.tap(b.x + 0.5 * b.width, b.y + 0.8 * b.height);
		} else await tapPage(page, 0.5, 0.8);
		expect(await stamps(page)).toHaveLength(2);

		// Each stroke is one undo step.
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toHaveLength(1);
		await page.keyboard.press('Control+Shift+z');
		expect(await stamps(page)).toHaveLength(2);

		await page.keyboard.press('Escape');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false');
		await expect(page.locator('.armed-hint')).toHaveCount(0);
		await expect(bar).toHaveCount(0);
		// Put away: a drag on the page no longer draws.
		await dragOnPage(page, info, [0.2, 0.6], [0.5, 0.65]);
		expect(await stamps(page)).toHaveLength(2);

		// Tapping the tool again also puts it away.
		await chooseTool(page, 'Highlight');
		await chooseTool(page, 'Highlight');
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'false');
	});

	test('highlight pen: a nearly level line is stored as an exactly level two-point line', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		const b = await pageBox(page);
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		// About 2° off level, with a small wobble.
		const dy = (Math.tan((2 * Math.PI) / 180) * 0.4 * b.width) / b.height;
		await drawPath(page, info, [
			[0.2, 0.4],
			[0.3, 0.4 + dy / 4 + 2 / b.height],
			[0.45, 0.4 + dy / 2 - 1 / b.height],
			[0.6, 0.4 + dy]
		]);
		let [h] = await stamps(page);
		const pts = penOf(h).points;
		expect(pts).toHaveLength(2);
		expect(pts[0].y).toBe(pts[1].y);
		expect(pts[0].y).toBeCloseTo(0.4 + dy / 2, 2);
		// And near-vertical: exactly vertical.
		const dx = (Math.tan((3 * Math.PI) / 180) * 0.3 * b.height) / b.width;
		await drawPath(page, info, [
			[0.8, 0.3],
			[0.8 + dx, 0.6]
		]);
		h = (await stamps(page))[1];
		expect(penOf(h).points).toHaveLength(2);
		expect(penOf(h).points[0].x).toBe(penOf(h).points[1].x);
		// A clear diagonal stays diagonal.
		await drawPath(page, info, [
			[0.2, 0.7],
			[0.5, 0.8]
		]);
		h = (await stamps(page))[2];
		const [a, c] = penOf(h).points;
		expect(c.y - a.y).toBeCloseTo(0.1, 2);
	});

	test('highlight box: drag draws a box; taps and slips make nothing; the choice lasts the visit', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Box');
		await expect(page.locator('.armed-hint').first()).toContainText('Drag a box over what to highlight');
		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34], async () => {
			await expect(page.getByTestId('draft-box')).toBeVisible();
		});
		let list = await stamps(page);
		expect(list).toHaveLength(1);
		expect(list[0].pen).toBeUndefined();
		expectBox(list[0].box, { x: 0.2, y: 0.3, w: 0.4, h: 0.04 });
		// Slightly rounded, like the export.
		const fill = page.locator(`[data-stamp="${list[0].id}"] .fill`);
		expect(parseFloat(await fill.evaluate((f) => getComputedStyle(f).borderTopLeftRadius))).toBeGreaterThan(0.5);
		// Drawn right to left.
		await dragOnPage(page, info, [0.7, 0.42], [0.25, 0.38]);
		list = await stamps(page);
		expectBox(list[1].box, { x: 0.25, y: 0.38, w: 0.45, h: 0.04 });

		// A tap, or a slip of a few pixels, makes nothing.
		const b = await pageBox(page);
		if (isPhone(info)) await page.touchscreen.tap(b.x + 0.5 * b.width, b.y + 0.7 * b.height);
		else await tapPage(page, 0.5, 0.7);
		await dragOnPage(page, info, [0.4, 0.75], [0.4 + 10 / b.width, 0.75 + 3 / b.height]);
		expect(await stamps(page)).toHaveLength(2);
		// A long stroke along a line keeps its length and gets one line's height.
		await dragOnPage(page, info, [0.2, 0.8], [0.2 + 150 / b.width, 0.8 + 2 / b.height]);
		list = await stamps(page);
		expect(list).toHaveLength(3);
		expect(list[2].box!.w).toBeCloseTo(150 / b.width, 2);
		expect(list[2].box!.x).toBeCloseTo(0.2, 2);

		// Box is remembered when the tool is armed again and in a reopened editor…
		await page.keyboard.press('Escape');
		await chooseTool(page, 'Highlight');
		await expect(page.getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'true');
		await page.getByRole('button', { name: 'Done', exact: true }).click();
		await page.getByRole('button', { name: 'Edit page 1' }).click();
		await chooseTool(page, 'Highlight');
		await expect(page.getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'true');
		// …but a new visit starts again with Text (the page has text).
		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await expect(page.getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
	});

	test('highlighter bar: keyboard reaches Pen | Box and the colours; arrows choose', async ({ page }, info) => {
		test.skip(isPhone(info), 'keyboard');
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		// One Tab stop for the group: the checked mode (Text on a page with text).
		const text = page.getByRole('radio', { name: 'Text' });
		await expect(text).toHaveAttribute('tabindex', '0');
		await expect(page.getByRole('radio', { name: 'Pen' })).toHaveAttribute('tabindex', '-1');
		await text.focus();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('radio', { name: 'Pen' })).toBeFocused();
		await expect(page.getByRole('radio', { name: 'Pen' })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('radio', { name: 'Box' })).toBeFocused();
		await expect(page.getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'true');
		// Round the group and back.
		await page.keyboard.press('ArrowRight');
		await expect(text).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'true');
		// Arrow keys stayed in the bar: the page did not change.
		await expect(page.getByText('1 of 6')).toBeVisible();
		await page.keyboard.press('Tab');
		const yellow = page.getByRole('toolbar', { name: 'Highlighter' }).getByRole('radio', { name: 'Yellow' });
		await expect(yellow).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(page.getByRole('toolbar', { name: 'Highlighter' }).getByRole('radio', { name: 'Green' })).toHaveAttribute('aria-checked', 'true');
		await page.keyboard.press('ArrowLeft');
		await page.keyboard.press('ArrowLeft');
		await expect(page.getByRole('toolbar', { name: 'Highlighter' }).getByRole('radio', { name: 'Pink' })).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByText('1 of 6')).toBeVisible();
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

	test('highlight colours: chosen in the highlighter bar or on a selected highlight, remembered', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		const bar = page.getByRole('toolbar', { name: 'Highlighter' });
		const barColours = bar.getByRole('radiogroup', { name: 'Highlight colour' });
		await expect(barColours.getByRole('radio', { name: 'Yellow' })).toHaveAttribute('aria-checked', 'true');
		await barColours.getByRole('radio', { name: 'Green' }).click();
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.3],
			[0.6, 0.3]
		]);
		let [h] = await stamps(page);
		expect(h.color).toBe('green');
		const el = page.locator(`[data-stamp="${h.id}"]`);
		await expect(el).toHaveAccessibleName(/^Highlight, green/);
		expect(await el.locator('svg path').first().getAttribute('stroke')).toBe('#A5F36B');

		// Box shape: the same colours.
		await highlightShape(page, 'Box');
		await dragOnPage(page, info, [0.2, 0.5], [0.6, 0.54]);
		let list = await stamps(page);
		expect(list[1].color).toBe('green');
		expect(await page.locator(`[data-stamp="${list[1].id}"] .fill`).evaluate((f) => getComputedStyle(f).backgroundColor)).toBe('rgb(165, 243, 107)');

		// Select an existing one with the tool put away and make it pink.
		await page.keyboard.press('Escape');
		await el.click();
		const colours = page.getByRole('toolbar', { name: /^Highlight, green/ }).getByRole('radiogroup', { name: 'Highlight colour' });
		await colours.getByRole('radio', { name: 'Pink' }).click();
		[h] = await stamps(page);
		expect(h.color).toBe('pink');
		// Colour change is one undo step.
		await page.keyboard.press('Control+z');
		expect((await stamps(page))[0].color).toBe('green');

		// Remembered on this device.
		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.3],
			[0.6, 0.3]
		]);
		list = await stamps(page);
		expect(list[0].color).toBe('pink');
	});

	test('a pen stroke moves with its points, deletes, undoes; it has no resize handle', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.3],
			[0.35, 0.36],
			[0.5, 0.3]
		]);
		await page.keyboard.press('Escape');
		const [h] = await stamps(page);
		const el = page.locator(`[data-stamp="${h.id}"]`);
		const b = await pageBox(page);
		// The stroke itself takes the click (the middle of its box is on the stroke here: the top of the V is not).
		const p1 = penOf(h).points[1];
		await page.mouse.click(b.x + p1.x * b.width, b.y + p1.y * b.height);
		await expect(el).toHaveAccessibleName(/selected/);
		await expect(el.locator('[data-handle="se"]')).toHaveCount(0);
		const grab = isPhone(info) ? (await el.locator('[data-handle="move"]').boundingBox())! : { x: b.x + p1.x * b.width - 1, y: b.y + p1.y * b.height - 1, width: 2, height: 2 };
		const gx = grab.x + grab.width / 2;
		const gy = grab.y + grab.height / 2;
		await page.mouse.move(gx, gy);
		await page.mouse.down();
		await page.mouse.move(gx + 20, gy + 15, { steps: 4 });
		await page.mouse.move(gx + 40, gy + 30, { steps: 4 });
		await page.mouse.up();
		const [m] = await stamps(page);
		expect(m.box!.x - h.box!.x).toBeCloseTo(40 / b.width, 2);
		expect(m.box!.y - h.box!.y).toBeCloseTo(30 / b.height, 2);
		penOf(m).points.forEach((q, i) => {
			expect(q.x - penOf(h).points[i].x).toBeCloseTo(m.box!.x - h.box!.x, 6);
			expect(q.y - penOf(h).points[i].y).toBeCloseTo(m.box!.y - h.box!.y, 6);
		});
		// Arrow keys move it too.
		await page.keyboard.press('Shift+ArrowDown');
		const [k] = await stamps(page);
		expect(penOf(k).points[0].y).toBeCloseTo(penOf(m).points[0].y + 0.02, 5);
		// Duplicate, delete, undo.
		await page.getByRole('button', { name: 'Duplicate' }).click();
		const two = await stamps(page);
		expect(two).toHaveLength(2);
		expect(penOf(two[1]).points[0].x).toBeCloseTo(penOf(k).points[0].x + 0.02, 5);
		await page.getByRole('button', { name: 'Delete' }).click();
		await page.keyboard.press('Delete');
		expect(await stamps(page)).toHaveLength(0);
		await page.keyboard.press('Control+z');
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toHaveLength(2);
		// Back past the duplicate and the arrow nudge: where the drag left it.
		await page.keyboard.press('Control+z');
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toEqual([m]);
	});

	test('a placed box moves, resizes freely, deletes and duplicates like other stamps', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Box');
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
		await highlightShape(page, 'Box');
		await dragOnPage(page, info, [0.1, 0.2], [0.7, 0.3]);
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.1, 0.4],
			[0.5, 0.45],
			[0.7, 0.4]
		]);
		await chooseTool(page, 'Redact');
		await dragOnPage(page, info, [0.6, 0.8], [0.3, 0.55]);
		const list = await stamps(page);
		const pen = list.find((s) => s.pen)!;
		expect(penOf(pen).points[0].x).toBeCloseTo(0.1, 2);
		expect(penOf(pen).points[0].y).toBeCloseTo(0.4, 2);
		expect(penOf(pen).points.at(-1)!.x).toBeCloseTo(0.7, 2);
		expectBox(list.find((s) => s.kind === 'highlight' && !s.pen)!.box, { x: 0.1, y: 0.2, w: 0.6, h: 0.1 });
		expectBox(list.find((s) => s.kind === 'redact')!.box, { x: 0.3, y: 0.55, w: 0.3, h: 0.25 });
		// Drawn where they were dragged.
		const hb = (await page.locator('.stamp.highlight.ed:not(.pen)').boundingBox())!;
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
		await highlightShape(page, 'Pen');
		await dragOnPage(page, info, [0.2, 0.3], [0.6, 0.34]);
		await dragOnPage(page, info, [0.2, 0.4], [0.6, 0.44]);
		expect(await stamps(page)).toHaveLength(2);
		expect(await page.evaluate(() => (window as unknown as { __redraws: number }).__redraws)).toBe(0);
	});

	test('keyboard: Enter on the tool places a level pen stroke at the centre, selected', async ({ page }) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await tool(page, 'Highlight').focus();
		await page.keyboard.press('Enter');
		const [h] = await stamps(page);
		expect(h.kind).toBe('highlight');
		expect(penOf(h).points).toHaveLength(2);
		expect(penOf(h).points[0].y).toBe(penOf(h).points[1].y);
		expect(h.box!.x + h.box!.w / 2).toBeCloseTo(0.5, 3);
		expect(h.box!.y + h.box!.h / 2).toBeCloseTo(0.5, 3);
		await expect(page.locator(`[data-stamp="${h.id}"]`)).toBeFocused();
		await page.keyboard.press('Shift+ArrowDown');
		const [m] = await stamps(page);
		expect(m.box!.y).toBeCloseTo(h.box!.y + 0.02, 5);
		expect(penOf(m).points[0].y).toBeCloseTo(penOf(h).points[0].y + 0.02, 5);
	});

	test('pinch-zoom still works with a drawn tool armed, and draws nothing', async ({ page }, info) => {
		test.skip(!isPhone(info), 'touch emulation only on the phone project');
		const sheet = await openEditor(page, 'file=multi.pdf&page=2');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
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
		await expect(page.getByTestId('draft-stroke')).toHaveCount(0);
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
	const labelFits = (el: Element) => {
		const span = el.querySelector('span')!;
		const r = span.getBoundingClientRect();
		const b = el.getBoundingClientRect();
		return span.scrollWidth <= Math.ceil(r.width) + 0.5 && r.left >= b.left - 0.5 && r.right <= b.right + 0.5;
	};

	for (const width of [320, 360, 412]) {
		test(`five fixed slots and the More sheet fit at ${width}px`, async ({ page }, info) => {
			test.skip(!isPhone(info), 'phone layout');
			await page.setViewportSize({ width, height: 760 });
			await openEditor(page, 'file=multi.pdf&page=1');
			const bar = page.getByRole('toolbar', { name: 'Tools' });
			const buttons = bar.getByRole('button');
			await expect(buttons).toHaveCount(5);
			const names = await buttons.evaluateAll((els) => els.map((e) => e.textContent!.trim()));
			expect(names).toEqual(['Signature', 'Text', 'Cross', 'Highlight', 'More']);
			const m = await bar.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
			expect(m.sw).toBeLessThanOrEqual(m.cw);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			const widths: number[] = [];
			for (const b of await buttons.all()) {
				const bb = (await b.boundingBox())!;
				expect(bb.width).toBeGreaterThanOrEqual(48);
				expect(bb.height).toBeGreaterThanOrEqual(48);
				expect(bb.x + bb.width).toBeLessThanOrEqual(width);
				expect(await b.evaluate(labelFits)).toBe(true);
				widths.push(bb.width);
			}
			expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);

			await moreButton(page).click();
			const menu = page.getByRole('menu', { name: 'More tools' });
			await expect(menu).toBeVisible();
			await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
			const items = menu.getByRole('menuitemradio');
			expect(await items.evaluateAll((els) => els.map((e) => e.textContent!.trim()))).toEqual(['Initials', 'Date', 'Check', 'Dot', 'Redact', 'Crop']);
			const mb = (await menu.boundingBox())!;
			const barBox = (await bar.boundingBox())!;
			expect(mb.x).toBeGreaterThanOrEqual(0);
			expect(mb.x + mb.width).toBeLessThanOrEqual(width);
			expect(mb.y + mb.height).toBeLessThanOrEqual(barBox.y);
			for (const it of await items.all()) {
				const bb = (await it.boundingBox())!;
				expect(bb.width).toBeGreaterThanOrEqual(48);
				expect(bb.height).toBeGreaterThanOrEqual(48);
				expect(await it.evaluate(labelFits)).toBe(true);
			}
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
			expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

			// Highlight armed: the Pen | Box bar and the colours fit without scrolling, above the tool bar.
			await page.keyboard.press('Escape');
			await expect(menu).toBeHidden();
			await chooseTool(page, 'Highlight');
			const hl = page.getByRole('toolbar', { name: 'Highlighter' });
			await expect(hl).toBeVisible();
			const hb = (await hl.boundingBox())!;
			expect(hb.x).toBeGreaterThanOrEqual(0);
			expect(hb.x + hb.width).toBeLessThanOrEqual(width);
			expect(hb.y + hb.height).toBeLessThanOrEqual((await bar.boundingBox())!.y);
			expect(await hl.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			for (const r of await hl.getByRole('radio').all()) {
				const rb = (await r.boundingBox())!;
				expect(rb.height).toBeGreaterThanOrEqual(44);
				expect(rb.width).toBeGreaterThanOrEqual(44);
			}
			for (const r of await hl.getByRole('radiogroup', { name: 'Highlight shape' }).getByRole('radio').all()) expect(await r.evaluate(labelFits)).toBe(true);
			expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
		});
	}

	test('More: pick a tool, the slot shows it armed, pick it again to put it away', async ({ page }, info) => {
		test.skip(!isPhone(info), 'phone layout');
		await openEditor(page, 'file=multi.pdf&page=1');
		const more = moreButton(page);
		await expect(more).toHaveAttribute('aria-haspopup', 'menu');
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await more.tap();
		await expect(more).toHaveAttribute('aria-expanded', 'true');
		const menu = page.getByRole('menu', { name: 'More tools' });
		// Focus moves into the sheet.
		await expect(menu.getByRole('menuitemradio', { name: 'Initials' })).toBeFocused();
		await menu.getByRole('menuitemradio', { name: 'Redact' }).tap();
		await expect(menu).toBeHidden();
		await expect(more).toHaveAttribute('aria-expanded', 'false');
		await expect(more).toBeFocused();
		await expect(more).toHaveAccessibleName('Redact, armed. More tools');
		await expect(more).toHaveText('Redact');
		await expect(more).toHaveClass(/armed-more/);
		// Redact stays armed for several boxes.
		await dragOnPage(page, info, [0.2, 0.3], [0.5, 0.34]);
		await dragOnPage(page, info, [0.2, 0.5], [0.5, 0.54]);
		expect((await stamps(page)).filter((s) => s.kind === 'redact')).toHaveLength(2);
		await expect(more).toHaveAccessibleName('Redact, armed. More tools');

		// The sheet marks the armed tool; tapping it puts the tool away and the slot is More again.
		// (A click: the first emulated tap after a raw touch drag is swallowed by the test driver.)
		await more.click();
		const red = menu.getByRole('menuitemradio', { name: 'Redact' });
		await expect(red).toHaveAttribute('aria-checked', 'true');
		await expect(red).toBeFocused();
		await expect(menu.getByRole('menuitemradio', { name: 'Dot' })).toHaveAttribute('aria-checked', 'false');
		await red.click();
		await expect(menu).toBeHidden();
		await expect(more).toHaveAccessibleName('More tools');
		await expect(more).toHaveText('More');
		await expect(more).not.toHaveClass(/armed-more/);
		await expect(page.locator('.viewport.armed')).toHaveCount(0);

		// Arming a bar tool after a sheet tool returns the slot to More.
		await chooseTool(page, 'Dot');
		await expect(more).toHaveText('Dot');
		await chooseTool(page, 'Cross');
		await expect(tool(page, 'Cross')).toHaveAttribute('aria-pressed', 'true');
		await expect(more).toHaveText('More');
	});

	test('More: outside tap, Escape and More again close the sheet', async ({ page }, info) => {
		test.skip(!isPhone(info), 'phone layout');
		await openEditor(page, 'file=multi.pdf&page=1');
		const more = moreButton(page);
		const menu = page.getByRole('menu', { name: 'More tools' });

		// A tap on the page closes the sheet and does not place the armed check mark.
		await chooseTool(page, 'Cross');
		await more.tap();
		await expect(menu).toBeVisible();
		const b = await pageBox(page);
		await page.touchscreen.tap(b.x + b.width * 0.5, b.y + b.height * 0.4);
		await expect(menu).toBeHidden();
		expect(await stamps(page)).toHaveLength(0);
		await expect(tool(page, 'Cross')).toHaveAttribute('aria-pressed', 'true');

		// Escape closes the sheet only; a second Escape puts the tool away.
		await more.tap();
		await expect(menu).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(more).toBeFocused();
		await expect(tool(page, 'Cross')).toHaveAttribute('aria-pressed', 'true');
		await page.keyboard.press('Escape');
		await expect(tool(page, 'Cross')).toHaveAttribute('aria-pressed', 'false');

		// More again.
		await more.tap();
		await expect(menu).toBeVisible();
		await more.tap();
		await expect(menu).toBeHidden();
		await expect(more).toHaveAttribute('aria-expanded', 'false');

		// Another bar tool: closes the sheet and arms that tool.
		await more.tap();
		await tool(page, 'Highlight').tap();
		await expect(menu).toBeHidden();
		await expect(tool(page, 'Highlight')).toHaveAttribute('aria-pressed', 'true');
	});

	test('More: the selected-stamp bar steps aside while the sheet is open', async ({ page }, info) => {
		test.skip(!isPhone(info), 'phone layout');
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.3],
			[0.6, 0.3]
		]);
		await page.keyboard.press('Escape');
		await page.locator('[data-stamp]').first().click();
		const selbar = page.getByRole('toolbar', { name: /highlight/i });
		await expect(selbar).toBeVisible();
		await moreButton(page).click();
		await expect(page.getByRole('menu', { name: 'More tools' })).toBeVisible();
		await expect(selbar).toBeHidden();
		await page.keyboard.press('Escape');
		await expect(selbar).toBeVisible();
	});

	test('More: keyboard opens, moves, picks and leaves the sheet', async ({ page }, info) => {
		test.skip(!isPhone(info), 'phone layout');
		await openEditor(page, 'file=multi.pdf&page=1');
		const more = moreButton(page);
		const menu = page.getByRole('menu', { name: 'More tools' });
		const item = (name: string) => menu.getByRole('menuitemradio', { name, exact: true });
		await more.focus();
		await page.keyboard.press('ArrowUp');
		await expect(item('Initials')).toBeFocused();
		await page.keyboard.press('End');
		await expect(item('Crop')).toBeFocused();
		await page.keyboard.press('Home');
		await page.keyboard.press('ArrowDown');
		await expect(item('Dot')).toBeFocused();
		await page.keyboard.press('ArrowUp');
		await expect(item('Initials')).toBeFocused();
		await page.keyboard.press('ArrowLeft');
		await expect(item('Crop')).toBeFocused();
		await page.keyboard.press('ArrowRight');
		await expect(item('Initials')).toBeFocused();
		// Arrow keys stay in the sheet: the page did not change.
		await expect(page.getByText('1 of 6')).toBeVisible();
		await page.keyboard.press('Escape');
		await expect(menu).toBeHidden();
		await expect(more).toBeFocused();

		// Tab leaves the sheet and closes it.
		await page.keyboard.press('Enter');
		await expect(item('Initials')).toBeFocused();
		await page.keyboard.press('Tab');
		await expect(menu).toBeHidden();
		await expect(more).not.toBeFocused();

		// Enter on Date places it at the centre, selected (the keyboard path).
		await more.focus();
		await page.keyboard.press('Enter');
		await page.keyboard.press('ArrowRight');
		await expect(item('Date')).toBeFocused();
		await page.keyboard.press('Enter');
		await expect(menu).toBeHidden();
		const [d] = await stamps(page);
		expect(d.kind).toBe('text');
		await expect(page.locator(`[data-stamp="${d.id}"]`)).toBeFocused();
	});
});

test.describe('highlight export', () => {
	test('draw a pen stroke, export: verified, colour along the stroke only', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.5],
			[0.4, 0.56],
			[0.6, 0.5]
		]);
		const [h] = await stamps(page);
		expect(h.pen).toBeDefined();
		const out = await exportPage(page);
		for (const c of out.checks) expect(c.ok, c.name).toBe(true);
		const [p0, p1] = penOf(h).points;
		const mid: [number, number] = [(p0.x + p1.x) / 2, (p0.y + p1.y) / 2];
		const [onStroke, above, below] = await pixels(page, out.dataUrl, [mid, [mid[0], mid[1] - 0.06], [0.5, 0.85]]);
		expect(yellowish(onStroke), `${onStroke}`).toBe(true);
		expect(whiteish(above), `${above}`).toBe(true);
		expect(whiteish(below), `${below}`).toBe(true);
	});

	test('switch to Box, draw, export: verified, the box is coloured', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Box');
		await dragOnPage(page, info, [0.2, 0.6], [0.6, 0.7]);
		const [h] = await stamps(page);
		expect(h.pen).toBeUndefined();
		const out = await exportPage(page);
		for (const c of out.checks) expect(c.ok, c.name).toBe(true);
		const [inBox, outside] = await pixels(page, out.dataUrl, [
			[0.4, 0.65],
			[0.4, 0.75]
		]);
		expect(yellowish(inBox), `${inBox}`).toBe(true);
		expect(whiteish(outside), `${outside}`).toBe(true);
	});

	test('a snapped straight stroke exports level', async ({ page }, info) => {
		await openEditor(page, 'file=multi.pdf&page=1');
		const b = await pageBox(page);
		await chooseTool(page, 'Highlight');
		await highlightShape(page, 'Pen');
		await drawPath(page, info, [
			[0.2, 0.62],
			[0.7, 0.62 + 6 / b.height]
		]);
		const [h] = await stamps(page);
		const [a, c] = penOf(h).points;
		expect(a.y).toBe(c.y);
		const out = await exportPage(page, 0, 800);
		for (const k of out.checks) expect(k.ok, k.name).toBe(true);
		// The same height at both ends of the line.
		const half = penOf(h).width / 2;
		const [l, r, lOff, rOff] = await pixels(page, out.dataUrl, [
			[0.25, a.y + half * 0.6],
			[0.65, a.y + half * 0.6],
			[0.25, a.y + half * 1.6],
			[0.65, a.y + half * 1.6]
		]);
		expect(yellowish(l) && yellowish(r), `${l} ${r}`).toBe(true);
		expect(whiteish(lOff) && whiteish(rOff), `${lOff} ${rOff}`).toBe(true);
	});
});
