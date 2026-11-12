// The text highlighter (Highlight → Text): drag across words or double-tap a word.
// Mouse on desktop; real touch events (CDP) on the phone project.
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, highlightShape, openEditor, pageBox, stamps } from './editor-helpers';

type Box = { x: number; y: number; w: number; h: number };
interface Word {
	text: string;
	box: Box;
	line: number;
}

const isPhone = (info: TestInfo) => info.project.name === 'phone';
const FILE = 'file=hl-text.pdf';

/** The words of a source page, from the engine (fractions of the page as the file shows it). */
async function pageWords(page: Page, pageIndex: number): Promise<Word[]> {
	return page.evaluate(async (i) => {
		const ed = (window as unknown as { __editor: { engine: { pageText: (s: unknown, i: number) => Promise<{ words: Word[] }> }; store: { state: { sources: unknown[] } } } }).__editor;
		return (await ed.engine.pageText(ed.store.state.sources[0], i)).words;
	}, pageIndex);
}

const word = (ws: Word[], text: string, line?: number) => {
	const w = ws.find((x) => x.text === text && (line === undefined || x.line === line));
	if (!w) throw new Error(`no word ${text}`);
	return w;
};
const inside = (w: Word, fx = 0.5, fy = 0.5): [number, number] => [w.box.x + fx * w.box.w, w.box.y + fy * w.box.h];

async function touchSession(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	return (type: 'touchStart' | 'touchMove' | 'touchEnd', pts: [number, number][]) =>
		cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y], id) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
}

/** Press at one page fraction, move to another, release; `during` runs before release. */
async function drag(page: Page, info: TestInfo, from: [number, number], to: [number, number], during?: () => Promise<void>) {
	const b = await pageBox(page);
	const x0 = b.x + from[0] * b.width;
	const y0 = b.y + from[1] * b.height;
	const x1 = b.x + to[0] * b.width;
	const y1 = b.y + to[1] * b.height;
	const steps = 10;
	if (isPhone(info)) {
		const touch = await touchSession(page);
		await touch('touchStart', [[x0, y0]]);
		for (let i = 1; i <= steps; i++) await touch('touchMove', [[x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps]]);
		await during?.();
		await touch('touchEnd', []);
	} else {
		await page.mouse.move(x0, y0);
		await page.mouse.down();
		for (let i = 1; i <= steps; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
		await during?.();
		await page.mouse.up();
	}
}

/** Double tap (phone) or double click (desktop) at a page fraction. */
async function doubleTap(page: Page, info: TestInfo, at: [number, number]) {
	const b = await pageBox(page);
	const x = b.x + at[0] * b.width;
	const y = b.y + at[1] * b.height;
	if (isPhone(info)) {
		await page.touchscreen.tap(x, y);
		await page.touchscreen.tap(x, y);
	} else await page.mouse.dblclick(x, y);
}

/** Rectangles covering a word (a rectangle holds the word's centre and ends). */
function covers(rects: Box[], w: Word) {
	const c = { x: w.box.x + w.box.w / 2, y: w.box.y + w.box.h / 2 };
	return rects.some((r) => c.x > r.x && c.x < r.x + r.w && c.y > r.y && c.y < r.y + r.h && r.x <= w.box.x + 1e-6 && r.x + r.w >= w.box.x + w.box.w - 1e-6);
}
function touches(rects: Box[], w: Word) {
	const c = { x: w.box.x + w.box.w / 2, y: w.box.y + w.box.h / 2 };
	return rects.some((r) => c.x > r.x && c.x < r.x + r.w && c.y > r.y && c.y < r.y + r.h);
}

async function exportPage(page: Page, width = 900) {
	return page.evaluate(
		(w) =>
			(window as unknown as { __editor: { exportPage: (i: number, w: number) => Promise<{ dataUrl: string; checks: { name: string; ok: boolean }[] }> } }).__editor.exportPage(0, w),
		width
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

const shapes = (page: Page) => page.getByRole('radiogroup', { name: 'Highlight shape' });

test.describe('text highlighter', () => {
	test('drag across two lines: one stamp, one rectangle per line, covering just the chosen words', async ({ page }, info) => {
		await openEditor(page, `${FILE}&page=1`);
		const ws = await pageWords(page, 0);
		await chooseTool(page, 'Highlight');
		await expect(shapes(page).getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
		await expect(page.locator('.armed-hint').first()).toContainText('Drag across the words to highlight');
		await drag(page, info, inside(word(ws, 'quick'), 0.6), inside(word(ws, 'lazy'), 0.3), async () => {
			// While dragging, the would-be highlight shows; nothing is stored yet.
			await expect(page.getByTestId('draft-text')).toBeVisible();
			expect(await stamps(page)).toHaveLength(0);
		});
		await expect(page.getByTestId('draft-text')).toHaveCount(0);
		const list = await stamps(page);
		expect(list).toHaveLength(1);
		const [h] = list;
		expect(h.kind).toBe('highlight');
		expect(h.pen).toBeUndefined();
		expect(h.rects).toHaveLength(2);
		for (const t of ['quick', 'brown', 'fox', 'jumping']) expect(covers(h.rects!, word(ws, t, 0)), t).toBe(true);
		for (const t of ['over', 'the', 'lazy']) expect(covers(h.rects!, word(ws, t, 1)), t).toBe(true);
		for (const [t, l] of [['Highlight', 0], ['the', 0], ['dog,', 1], ['beside', 2]] as const) expect(touches(h.rects!, word(ws, t, l)), t).toBe(false);
		// The box is the rectangles' bounds.
		expect(h.box!.x).toBeCloseTo(Math.min(...h.rects!.map((r) => r.x)), 6);
		expect(h.box!.y + h.box!.h).toBeCloseTo(Math.max(...h.rects!.map((r) => r.y + r.h)), 6);
		await expect(page.getByTestId('live')).toHaveText('Highlighted 7 words, yellow.');
		// Drawn like the export: one path, multiplied with the page.
		const el = page.locator(`[data-stamp="${h.id}"]`);
		expect(await el.evaluate((e) => getComputedStyle(e).mixBlendMode)).toBe('multiply');
		await expect(el.locator('svg.rects-svg path')).toHaveCount(1);
		expect(await el.locator('svg.rects-svg path').getAttribute('fill')).toBe('#FFEB3B');
		// Still armed: another drag is another stamp.
		await drag(page, info, inside(word(ws, 'beside', 2), 0.2), inside(word(ws, 'hedge', 2), 0.8));
		expect(await stamps(page)).toHaveLength(2);
	});

	test('double-tap a word highlights that word; a single tap and a drag far from text make nothing', async ({ page }, info) => {
		await openEditor(page, `${FILE}&page=1`);
		const ws = await pageWords(page, 0);
		await chooseTool(page, 'Highlight');
		await expect(shapes(page).getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
		await doubleTap(page, info, inside(word(ws, 'fox')));
		const [h] = await stamps(page);
		expect(h.rects).toHaveLength(1);
		const fox = word(ws, 'fox').box;
		for (const k of ['x', 'y', 'w', 'h'] as const) expect(h.rects![0][k]).toBeCloseTo(fox[k], 5);
		await expect(page.getByTestId('live')).toHaveText('Highlighted "fox", yellow.');
		// One tap: nothing.
		const b = await pageBox(page);
		const [qx, qy] = inside(word(ws, 'quick'));
		if (isPhone(info)) await page.touchscreen.tap(b.x + qx * b.width, b.y + qy * b.height);
		else await page.mouse.click(b.x + qx * b.width, b.y + qy * b.height);
		await page.waitForTimeout(600);
		expect(await stamps(page)).toHaveLength(1);
		// A drag in the empty lower half: not a selection (on a phone at fit, it would turn the page).
		await drag(page, info, [0.3, 0.8], [0.32, 0.9]);
		expect(await stamps(page)).toHaveLength(1);
		await expect(page.getByText('1 of 10')).toBeVisible();
	});

	test('one stamp: undo and redo, recolour, move, duplicate and delete as a unit', async ({ page }, info) => {
		await openEditor(page, `${FILE}&page=1`);
		const ws = await pageWords(page, 0);
		await chooseTool(page, 'Highlight');
		await drag(page, info, inside(word(ws, 'quick'), 0.6), inside(word(ws, 'lazy'), 0.3));
		const [h] = await stamps(page);
		// One undo step, one redo step.
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toHaveLength(0);
		await page.keyboard.press('Control+Shift+z');
		expect(await stamps(page)).toEqual([h]);
		// Put the tool away; a click on a rectangle selects the stamp (not between them).
		await page.keyboard.press('Escape');
		const b = await pageBox(page);
		const r1 = h.rects![1];
		await page.mouse.click(b.x + (r1.x + r1.w * 0.5) * b.width, b.y + (r1.y + r1.h * 0.5) * b.height);
		const el = page.locator(`[data-stamp="${h.id}"]`);
		await expect(el).toHaveAccessibleName(/^Highlight, yellow, selected/);
		// No resize handle: a text highlight moves but is not resized.
		await expect(el.locator('[data-handle="se"]')).toHaveCount(0);
		// Recolour: one step.
		const bar = page.getByRole('toolbar', { name: /^Highlight, yellow/ });
		await bar.getByRole('radio', { name: 'Pink' }).click();
		expect((await stamps(page))[0].color).toBe('pink');
		await expect(el.locator('svg.rects-svg path')).toHaveAttribute('fill', '#FF9CCB');
		// Arrow keys move box and rectangles together.
		await el.focus();
		await page.keyboard.press('Shift+ArrowDown');
		const [m] = await stamps(page);
		expect(m.box!.y).toBeCloseTo(h.box!.y + 0.02, 6);
		m.rects!.forEach((r, i) => {
			expect(r.y).toBeCloseTo(h.rects![i].y + 0.02, 6);
			expect(r.x).toBeCloseTo(h.rects![i].x, 6);
		});
		// Duplicate, delete, undo.
		await page.getByRole('button', { name: 'Duplicate' }).click();
		const two = await stamps(page);
		expect(two).toHaveLength(2);
		expect(two[1].rects![0].x).toBeCloseTo(m.rects![0].x + 0.02, 6);
		await page.getByRole('button', { name: 'Delete' }).click();
		expect(await stamps(page)).toHaveLength(1);
		await page.keyboard.press('Control+z');
		expect(await stamps(page)).toHaveLength(2);
		void info;
	});

	test('a scan page: Pen stands in for Text, with a quiet note the first time only', async ({ page }, info) => {
		// Page 7 is a scan with no text; page 6 a scan with an invisible OCR layer.
		await openEditor(page, `${FILE}&page=7`);
		await chooseTool(page, 'Highlight');
		await expect(shapes(page).getByRole('radio', { name: 'Pen' })).toHaveAttribute('aria-checked', 'true');
		const text = shapes(page).getByRole('radio', { name: 'Text' });
		await expect(text).toHaveAttribute('aria-disabled', 'true');
		await expect(page.getByTestId('hl-note')).toHaveText('This page is a scan with no selectable text. Use Pen or Box.');
		// Text cannot be picked here.
		await text.click({ force: true });
		await expect(shapes(page).getByRole('radio', { name: 'Pen' })).toHaveAttribute('aria-checked', 'true');
		// The pen draws as usual.
		await drag(page, info, [0.2, 0.3], [0.6, 0.31]);
		const [h] = await stamps(page, 6);
		expect(h.pen).toBeDefined();
		// The OCR page has (invisible) text: Text again, and it highlights the hidden words.
		await page.keyboard.press('PageUp');
		await expect(page.getByText('6 of 10')).toBeVisible();
		await expect(shapes(page).getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('hl-note')).toHaveCount(0);
		const ws = await pageWords(page, 5);
		await doubleTap(page, info, inside(word(ws, 'words')));
		expect((await stamps(page, 5))[0].rects).toHaveLength(1);
		// Back on the scan page: Pen, and the note is not shown a second time.
		await page.keyboard.press('PageDown');
		await expect(page.getByText('7 of 10')).toBeVisible();
		await expect(shapes(page).getByRole('radio', { name: 'Pen' })).toHaveAttribute('aria-checked', 'true');
		await expect(page.getByTestId('hl-note')).toHaveCount(0);
	});

	test('export: colour over the selected words only, verified', async ({ page }, info) => {
		await openEditor(page, `${FILE}&page=1`);
		const ws = await pageWords(page, 0);
		// Before: the page exported without the highlight (GitHub's runner draws black text
		// with coloured fringes, so pixels are compared with this, not with plain white).
		const before = await exportPage(page);
		await chooseTool(page, 'Highlight');
		await drag(page, info, inside(word(ws, 'quick'), 0.6), inside(word(ws, 'lazy'), 0.3));
		const after = await exportPage(page);
		for (const c of after.checks) expect(c.ok, c.name).toBe(true);
		// Paper inside the words' boxes (just above the letters) and between the letters of the line.
		const probe = (t: string, line: number): [number, number][] => {
			const w = word(ws, t, line);
			return [
				[w.box.x + w.box.w * 0.5, w.box.y + w.box.h * 0.04],
				[w.box.x + Math.min(w.box.w * 0.1, 0.006), w.box.y + w.box.h * 0.5]
			];
		};
		const sel = [...probe('quick', 0), ...probe('jumping', 0), ...probe('over', 1), ...probe('lazy', 1)];
		const out = [...probe('Highlight', 0), ...probe('the', 0), ...probe('dog,', 1), ...probe('beside', 2), ...probe('the', 2)];
		const [pb, pa] = [await pixels(page, before.dataUrl, [...sel, ...out]), await pixels(page, after.dataUrl, [...sel, ...out])];
		const yellow = [255, 235, 59];
		sel.forEach((_, i) => {
			// Multiply: each channel is the page's times the colour's.
			const want = pb[i].map((v, k) => (v * yellow[k]) / 255);
			expect(pa[i].every((v, k) => Math.abs(v - want[k]) <= 12), `selected probe ${i}: ${pb[i]} -> ${pa[i]}`).toBe(true);
			if (pb[i][2] > 150) expect(pa[i][2], `selected probe ${i} has turned yellow`).toBeLessThan(pb[i][2] - 60);
		});
		out.forEach((_, j) => {
			const i = sel.length + j;
			expect(pa[i].every((v, k) => Math.abs(v - pb[i][k]) <= 6), `neighbour probe ${j}: ${pb[i]} -> ${pa[i]}`).toBe(true);
		});
	});

	test('on a page turned 90°, a double-tapped word is highlighted where it is shown', async ({ page }, info) => {
		await openEditor(page, `${FILE}&page=1&rotate=90`);
		const ws = await pageWords(page, 0);
		await chooseTool(page, 'Highlight');
		// Turned clockwise: (x, y) of the file's page shows at (1 - y - h, x).
		const fox = word(ws, 'fox').box;
		const shown = { x: 1 - fox.y - fox.h, y: fox.x, w: fox.h, h: fox.w };
		await doubleTap(page, info, [shown.x + shown.w / 2, shown.y + shown.h / 2]);
		const [h] = await stamps(page);
		for (const k of ['x', 'y', 'w', 'h'] as const) expect(h.rects![0][k]).toBeCloseTo(shown[k], 5);
	});

	test('pinch-zoom works with Text armed and selects nothing; then one finger on text selects, elsewhere pans', async ({ page }, info) => {
		test.skip(!isPhone(info), 'touch emulation only on the phone project');
		const sheet = await openEditor(page, `${FILE}&page=1`);
		const ws = await pageWords(page, 0);
		await chooseTool(page, 'Highlight');
		await expect(shapes(page).getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
		const touch = await touchSession(page);
		const b = (await sheet.boundingBox())!;
		// Start the pinch on the paragraph, so the first finger lands on words.
		const [fx, fy] = inside(word(ws, 'brown'));
		const cx = b.x + fx * b.width;
		const cy = b.y + fy * b.height;
		await touch('touchStart', [[cx - 30, cy]]);
		await touch('touchMove', [[cx - 42, cy]]);
		await touch('touchStart', [
			[cx - 42, cy],
			[cx + 30, cy]
		]);
		for (let i = 1; i <= 8; i++)
			await touch('touchMove', [
				[cx - 42 - i * 12, cy],
				[cx + 30 + i * 12, cy]
			]);
		await touch('touchEnd', []);
		const z = (await sheet.boundingBox())!;
		expect(z.width / b.width).toBeGreaterThan(2);
		expect(await stamps(page)).toHaveLength(0);
		await expect(page.getByTestId('draft-text')).toHaveCount(0);
		// Zoomed in, a finger on words selects (the page does not move)…
		const before = (await sheet.boundingBox())!;
		const zb = await pageBox(page);
		const on = (w: Word): [number, number] => [zb.x + (w.box.x + w.box.w / 2) * zb.width, zb.y + (w.box.y + w.box.h / 2) * zb.height];
		const [ax, ay] = on(word(ws, 'brown'));
		const [ex, ey] = on(word(ws, 'fox'));
		await touch('touchStart', [[ax, ay]]);
		for (let i = 1; i <= 8; i++) await touch('touchMove', [[ax + ((ex - ax) * i) / 8, ay + ((ey - ay) * i) / 8]]);
		await touch('touchEnd', []);
		const after = (await sheet.boundingBox())!;
		expect(after.x).toBeCloseTo(before.x, 0);
		const [h] = await stamps(page);
		expect(h.rects).toHaveLength(1);
		expect(covers(h.rects!, word(ws, 'brown'))).toBe(true);
		expect(covers(h.rects!, word(ws, 'fox'))).toBe(true);
		// …and a finger on empty paper pans.
		const px = zb.x + 0.5 * zb.width;
		const py = zb.y + 0.6 * zb.height;
		await touch('touchStart', [[Math.min(px, 300), Math.min(py, 500)]]);
		for (let i = 1; i <= 6; i++) await touch('touchMove', [[Math.min(px, 300) - i * 10, Math.min(py, 500) - i * 10]]);
		await touch('touchEnd', []);
		const panned = (await sheet.boundingBox())!;
		expect(Math.abs(panned.x - after.x) + Math.abs(panned.y - after.y)).toBeGreaterThan(20);
		expect(await stamps(page)).toHaveLength(1);
	});
});

test('Text | Pen | Box: Text is picked by hand like the others and lasts the visit', async ({ page }) => {
	await openEditor(page, `${FILE}&page=1`);
	await chooseTool(page, 'Highlight');
	await highlightShape(page, 'Box');
	await page.keyboard.press('Escape');
	await chooseTool(page, 'Highlight');
	await expect(shapes(page).getByRole('radio', { name: 'Box' })).toHaveAttribute('aria-checked', 'true');
	await highlightShape(page, 'Text');
	await page.getByRole('button', { name: 'Next page' }).click();
	await expect(shapes(page).getByRole('radio', { name: 'Text' })).toHaveAttribute('aria-checked', 'true');
});
