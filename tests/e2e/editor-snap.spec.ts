/**
 * Snap on tap (editor/snap.ts, snap-cache.ts) on the generated flat form
 * tests/corpus/files/forms-snap.pdf (612 × 792 pt; "First name" line at y 102 from
 * x 130 to 290, "Yes" square 130-139 × 259-268). Mouse on desktop, finger taps on
 * the phone project.
 */
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, openEditor, pageBox, stamps, type StampJson } from './editor-helpers';

const W = 612;
const H = 792;
const BASELINE_EM = 0.988;
const isPhone = (info: TestInfo) => info.project.name === 'phone';

/** Tap (finger on phones, mouse click on desktop) at a page point. */
async function tapAt(page: Page, info: TestInfo, x: number, y: number) {
	const b = await pageBox(page);
	const px = b.x + (x / W) * b.width;
	const py = b.y + (y / H) * b.height;
	if (isPhone(info)) await page.touchscreen.tap(px, py);
	else await page.mouse.click(px, py);
}

/** Resolves once the engine has answered pageBlanks for the page (the editor then has it). */
async function watchBlanks(page: Page) {
	await page.evaluate(() => {
		const w = window as unknown as { __editor: { engine: Record<string, (...a: unknown[]) => Promise<unknown>> }; __blanks: number };
		const e = w.__editor.engine;
		const orig = e.pageBlanks;
		w.__blanks = 0;
		e.pageBlanks = (...a: unknown[]) => orig(...a).then((r) => ((w.__blanks += 1), r));
	});
}
async function blanksRead(page: Page) {
	await page.waitForFunction(() => (window as unknown as { __blanks: number }).__blanks > 0, null, { timeout: 30_000 });
	// The answer is stored a moment later (after the decision module has loaded).
	await page.waitForTimeout(300);
}

const textStamp = async (page: Page, pageIndex = 0) => (await stamps(page, pageIndex)).find((s) => s.kind === 'text')!;
const baselinePt = (s: StampJson) => (s.y! + BASELINE_EM * s.size!) * H;

async function typeAndClose(page: Page, info: TestInfo, text: string) {
	const box = page.getByRole('textbox', { name: 'Text on the page' });
	if (isPhone(info)) await page.waitForTimeout(400);
	await expect(box).toBeFocused();
	await page.keyboard.type(text);
	await page.keyboard.press('Escape');
	await expect(box).toHaveCount(0);
}

test.describe('snap on tap', () => {
	test('a sloppy Text tap near a line puts the text on it', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=1');
		await watchBlanks(page);
		await chooseTool(page, 'Text');
		await blanksRead(page);
		// 9 pt above the "First name" line, a little right of its start.
		await tapAt(page, info, 150, 93);
		await typeAndClose(page, info, 'Jane');
		const s = await textStamp(page);
		expect(s.text).toBe('Jane');
		expect(baselinePt(s)).toBeCloseTo(100, 0);
		expect(s.x! * W).toBeCloseTo(150, 0);
		expect(s.size! * H).toBeCloseTo(11, 1);
		// On screen the text box sits on the line, inside the blank.
		const b = await pageBox(page);
		const el = (await page.locator(`[data-stamp="${s.id}"] .txt`).boundingBox())!;
		const lineY = b.y + (102 / H) * b.height;
		const ptPx = b.height / H;
		expect(el.y + el.height).toBeLessThanOrEqual(lineY + 1.5 * ptPx);
		expect(el.y + el.height).toBeGreaterThan(lineY - 4 * ptPx);
		expect(el.x).toBeGreaterThanOrEqual(b.x + (130 / W) * b.width);
		expect(el.x + el.width).toBeLessThanOrEqual(b.x + (290 / W) * b.width);
	});

	test('a Text tap on empty paper lands as before', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=1');
		await watchBlanks(page);
		await chooseTool(page, 'Text');
		await blanksRead(page);
		await tapAt(page, info, 400, 650);
		await typeAndClose(page, info, 'Note');
		const s = await textStamp(page);
		expect(s.x! * W).toBeCloseTo(400, 0);
		// Plain placement: the first line box (1.2 em) centred on the tap.
		expect((s.y! + 0.6 * s.size!) * H).toBeCloseTo(650, 0);
		expect(s.size! * H).toBeCloseTo(11, 1);
	});

	test('a Text tap before the page has been read lands as before', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=1');
		// The engine never answers for this page.
		await page.evaluate(() => {
			const e = (window as unknown as { __editor: { engine: Record<string, unknown> } }).__editor.engine;
			e.pageBlanks = () => new Promise(() => undefined);
		});
		await chooseTool(page, 'Text');
		await tapAt(page, info, 150, 93);
		await typeAndClose(page, info, 'Jane');
		const s = await textStamp(page);
		expect(s.x! * W).toBeCloseTo(150, 0);
		expect((s.y! + 0.6 * s.size!) * H).toBeCloseTo(93, 0);
	});

	test('snapped text moves like any text and is not snapped again', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=1');
		await watchBlanks(page);
		await chooseTool(page, 'Text');
		await blanksRead(page);
		await tapAt(page, info, 150, 95);
		await typeAndClose(page, info, 'Jane');
		const before = await textStamp(page);
		expect(baselinePt(before)).toBeCloseTo(100, 0);
		// Drag it down by 14 pt and right by 30 pt: between the lines, near "Address".
		const b = await pageBox(page);
		const el = page.locator(`[data-stamp="${before.id}"]`);
		const grip = el.locator('[data-handle="move"]');
		const from = isPhone(info) ? (await grip.boundingBox())! : (await el.locator('.txt').boundingBox())!;
		const gx = from.x + from.width / 2;
		const gy = from.y + from.height / 2;
		const dx = (30 / W) * b.width;
		const dy = (14 / H) * b.height;
		await page.mouse.move(gx, gy);
		await page.mouse.down();
		await page.mouse.move(gx + dx / 2, gy + dy / 2, { steps: 4 });
		await page.mouse.move(gx + dx, gy + dy, { steps: 4 });
		await page.mouse.up();
		const after = (await stamps(page)).find((s) => s.id === before.id)!;
		expect((after.x! - before.x!) * W).toBeCloseTo(30, 0);
		expect((after.y! - before.y!) * H).toBeCloseTo(14, 0);
		expect(after.size).toBeCloseTo(before.size!, 6);
		// Undo puts it back on the line, as it was placed.
		await page.keyboard.press('Control+z');
		const undone = (await stamps(page)).find((s) => s.id === before.id)!;
		expect(baselinePt(undone)).toBeCloseTo(100, 0);
	});

	test('a Check tap beside a drawn box ticks the box; elsewhere it lands as before', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=1');
		await watchBlanks(page);
		await chooseTool(page, 'Check');
		await blanksRead(page);
		// 2 pt right of the "Yes" square, 1 pt below its middle.
		await tapAt(page, info, 141, 264.5);
		let marks = (await stamps(page)).filter((s) => s.kind === 'mark');
		expect(marks).toHaveLength(1);
		const m = marks[0].box!;
		expect(m.x * W).toBeCloseTo(130, 0);
		expect(m.y * H).toBeCloseTo(259, 0);
		expect(m.w * W).toBeCloseTo(9, 0);
		expect(m.h * H).toBeCloseTo(9, 0);
		// On empty paper: the default tick (0.026 of the shorter side) centred on the tap.
		await tapAt(page, info, 450, 650);
		marks = (await stamps(page)).filter((s) => s.kind === 'mark');
		expect(marks).toHaveLength(2);
		const p = marks[1].box!;
		expect((p.x + p.w / 2) * W).toBeCloseTo(450, 0);
		expect((p.y + p.h / 2) * H).toBeCloseTo(650, 0);
		expect(p.w * W).toBeCloseTo(0.026 * W, 0);
	});

	test('no snapping on a scanned page', async ({ page }, info) => {
		await openEditor(page, 'file=forms-snap.pdf&page=2');
		await watchBlanks(page);
		await chooseTool(page, 'Text');
		await blanksRead(page);
		// 6 pt above the line drawn over the scan (y 102).
		await tapAt(page, info, 150, 96);
		await typeAndClose(page, info, 'Jane');
		const s = await textStamp(page, 1);
		expect((s.y! + 0.6 * s.size!) * H).toBeCloseTo(96, 0);
	});
});
