// Review screenshots of the editor. Skipped unless EDITOR_SHOTS names an output folder:
//   EDITOR_SHOTS=/tmp/shots npx playwright test tests/e2e/editor-shots.spec.ts
import { test } from './fixtures';
import { chooseTool, drawOnPad, makeSignature, openEditor, tapPage } from './editor-helpers';

const dir = process.env.EDITOR_SHOTS;

for (const scheme of ['light', 'dark'] as const) {
	test(`editor screenshots (${scheme})`, async ({ page }, info) => {
		test.skip(!dir, 'set EDITOR_SHOTS to an output folder');
		const tag = `${info.project.name}-${scheme}`;
		await page.emulateMedia({ colorScheme: scheme });
		await openEditor(page, 'file=multi.pdf&page=3');

		// Several stamps, one selected.
		await makeSignature(page, { ink: 'Blue', save: true });
		await tapPage(page, 0.62, 0.78);
		await chooseTool(page, 'Text');
		await tapPage(page, 0.12, 0.3);
		await page.keyboard.type('Jane Q. Example');
		await page.keyboard.press('Escape');
		await chooseTool(page, 'Date');
		await tapPage(page, 0.12, 0.85);
		await chooseTool(page, 'Check');
		await tapPage(page, 0.1, 0.45);
		await tapPage(page, 0.1, 0.5);
		await page.keyboard.press('Escape');
		await chooseTool(page, 'Cross');
		await tapPage(page, 0.1, 0.55);
		await page.keyboard.press('Escape');
		await page.locator('[data-stamp]').first().click();
		await page.waitForTimeout(300);
		await page.screenshot({ path: `${dir}/${tag}-1-stamps-selected.png` });

		// Text editing in place.
		await page.locator('[data-stamp]').nth(1).dblclick();
		await page.keyboard.press('End');
		await page.waitForTimeout(150);
		await page.screenshot({ path: `${dir}/${tag}-2-text-editing.png` });
		await page.keyboard.press('Escape');

		// Signature pad with a drawn signature (and the saved list above it).
		await chooseTool(page, 'Signature');
		await drawOnPad(page);
		await page.waitForTimeout(200);
		await page.screenshot({ path: `${dir}/${tag}-3-signature-pad.png` });
		await page.getByRole('button', { name: 'Cancel' }).click();

		// Type tab with a name in the three styles (light only).
		if (scheme === 'light') {
			await chooseTool(page, 'Signature');
			const dlg = page.getByRole('dialog', { name: 'Add signature' });
			await dlg.getByRole('radio', { name: 'Type' }).click();
			await dlg.getByRole('textbox', { name: 'Your name' }).fill('Jane Q. Example');
			await dlg.getByRole('radio', { name: /^Flowing style/ }).click();
			await page.evaluate(() => document.fonts.ready);
			await page.waitForTimeout(300);
			await page.screenshot({ path: `${dir}/${tag}-5-type-tab.png` });
			await dlg.getByRole('button', { name: 'Cancel' }).click();
		}

		// Saved signatures list after a reload.
		await page.reload();
		await openEditor(page, 'file=multi.pdf&page=3');
		await chooseTool(page, 'Signature');
		await page.waitForTimeout(200);
		await page.screenshot({ path: `${dir}/${tag}-4-saved-list.png` });
	});
}

// Highlight and Redact, at device scale 1: a highlight over text with a redaction box,
// and a selected highlight with its colours.
test('editor screenshots: drawn tools', async ({ browser }, info) => {
	test.skip(!dir, 'set EDITOR_SHOTS to an output folder');
	test.setTimeout(90_000);
	const phone = info.project.name === 'phone';
	const ctx = await browser.newContext({
		baseURL: info.project.use.baseURL,
		viewport: phone ? { width: 412, height: 839 } : { width: 1440, height: 900 },
		deviceScaleFactor: 1,
		hasTouch: phone,
		isMobile: phone
	});
	const page = await ctx.newPage();
	const tag = info.project.name;
	await openEditor(page, 'file=multi.pdf&page=1');
	const b = (await page.getByTestId('editor-page').boundingBox())!;
	const drag = async (x0: number, y0: number, x1: number, y1: number) => {
		await page.mouse.move(b.x + x0 * b.width, b.y + y0 * b.height);
		await page.mouse.down();
		await page.mouse.move(b.x + x1 * b.width, b.y + y1 * b.height, { steps: 6 });
		await page.mouse.up();
	};
	// The fixture's only text is the "multi p1" label at the top left: highlight it, redact beside it.
	await chooseTool(page, 'Redact');
	await drag(0.16, 0.012, 0.3, 0.036);
	await chooseTool(page, 'Highlight');
	await drag(0.004, 0.012, 0.125, 0.036);
	await page.keyboard.press('Escape');
	await page.keyboard.press('Escape');
	// Zoom in on them so the text under the highlight can be seen.
	await page.mouse.move(b.x + (phone ? 0.02 : 0.15) * b.width, b.y + 0.024 * b.height);
	await page.keyboard.down('Control');
	await page.mouse.wheel(0, -100);
	await page.keyboard.up('Control');
	await page.mouse.move(0, 0);
	// Let the one-time redaction note go, and the sharp redraw land.
	await page.waitForTimeout(7500);
	await page.screenshot({ path: `${dir}/${tag}-drawn-1-highlight-redact.png` });
	await page.locator('.stamp.highlight.ed').first().click({ position: { x: 4, y: 4 } });
	await page.getByRole('radio', { name: 'Green' }).click();
	await page.waitForTimeout(200);
	await page.screenshot({ path: `${dir}/${tag}-drawn-2-highlight-selected.png` });
	await ctx.close();
});

// Phone tool bar: five fixed slots, the More sheet open, and a sheet tool armed (light and dark, 412 and 320 px).
for (const scheme of ['light', 'dark'] as const) {
	for (const width of [412, 320]) {
		test(`editor screenshots: phone More sheet (${scheme}, ${width}px)`, async ({ browser }, info) => {
			test.skip(!dir, 'set EDITOR_SHOTS to an output folder');
			test.skip(info.project.name !== 'phone', 'phone layout');
			test.skip(scheme === 'dark' && width !== 412, 'one dark size is enough');
			const ctx = await browser.newContext({
				baseURL: info.project.use.baseURL,
				viewport: { width, height: width === 412 ? 839 : 640 },
				deviceScaleFactor: 2,
				hasTouch: true,
				isMobile: true,
				colorScheme: scheme
			});
			const page = await ctx.newPage();
			const tag = `phone-${scheme}-${width}`;
			const settle = () => page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'));
			await openEditor(page, 'file=multi.pdf&page=1');
			await page.screenshot({ path: `${dir}/${tag}-more-1-bar.png` });
			const more = page.getByRole('toolbar', { name: 'Tools' }).getByRole('button', { name: /More tools$/ });
			await more.tap();
			await settle();
			await page.screenshot({ path: `${dir}/${tag}-more-2-sheet-open.png` });
			await page.getByRole('menuitemradio', { name: 'Redact' }).tap();
			await settle();
			await page.waitForTimeout(150);
			await page.screenshot({ path: `${dir}/${tag}-more-3-redact-armed.png` });
			await more.tap();
			await settle();
			await page.screenshot({ path: `${dir}/${tag}-more-4-sheet-armed.png` });
			await ctx.close();
		});
	}
}
