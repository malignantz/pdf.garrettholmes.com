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
