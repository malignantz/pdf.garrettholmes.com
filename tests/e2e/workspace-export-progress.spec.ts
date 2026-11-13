/**
 * A long export shows how far it has got: the final check of a file of scans fills a
 * determinate bar, and after 10 seconds a remaining-time line appears. The file is made
 * here (noise "scans", one picture object per page); Playwright's clock stands in for
 * the 10 seconds.
 */
import * as mupdf from 'mupdf';
import { PDFDocument } from '@cantoo/pdf-lib';
import { test, expect } from './fixtures';

const PAGES = 40;

/** Grey noise compresses badly and decodes slowly: what makes the check of a scan long. */
function noiseJpeg(w: number, h: number): Uint8Array {
	const pix = new mupdf.Pixmap(mupdf.ColorSpace.DeviceGray, [0, 0, w, h], false);
	const px = pix.getPixels();
	let s = 12345;
	for (let i = 0; i < px.length; i++) {
		s = (Math.imul(s, 1103515245) + 12345) >>> 0;
		px[i] = 200 + ((s >>> 24) % 56);
	}
	const out = pix.asJPEG(50).slice();
	pix.destroy();
	return out;
}

async function scans(): Promise<Buffer> {
	const jpeg = noiseJpeg(1275, 1650);
	const doc = await PDFDocument.create({ updateMetadata: false });
	for (let p = 0; p < PAGES; p++) {
		// A picture object of its own on every page (as a scanner writes), so each is checked.
		const img = await doc.embedJpg(jpeg);
		doc.addPage([612, 792]).drawImage(img, { x: 0, y: 0, width: 612, height: 792 });
	}
	return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test('the final check of a long export shows a filling bar and, after 10 seconds, the time left', async ({ page }) => {
	test.setTimeout(180_000);
	const file = await scans();
	await page.clock.install();
	await page.goto('/');
	await page.locator('input[type=file]').first().setInputFiles([{ name: 'scans.pdf', mimeType: 'application/pdf', buffer: file }]);
	await expect(page.getByRole('option')).toHaveCount(PAGES, { timeout: 60_000 });
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	// Compress off: the build is quick, so the check is most of the export.
	await dialog.getByRole('switch', { name: 'Compress' }).click();
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();

	const bar = page.getByRole('progressbar', { name: 'Building and checking your file' });
	await expect(page.getByText('Checking the finished file…')).toBeVisible({ timeout: 60_000 });
	await expect(bar).toHaveAttribute('aria-valuenow', /^\d+$/);
	await expect.poll(async () => Number(await bar.getAttribute('aria-valuenow')), { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
	const left = page.getByText(/^(Less than 10 seconds|About (\d+ seconds|a minute|\d+ minutes)|More than an hour) left$/);
	await expect(left).toHaveCount(0);

	await page.clock.fastForward(10_000);
	await expect(left).toBeVisible({ timeout: 10_000 });

	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(`Checked: ${PAGES} pages, opens cleanly.`)).toBeVisible({ timeout: 120_000 });
});
