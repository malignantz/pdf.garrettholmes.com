// Render the PNG app icons from scripts/icon-source.svg with headless Chrome.
// Run after changing the artwork: `node scripts/make-icons.mjs`. Output goes to static/.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(`${root}scripts/icon-source.svg`, 'utf8');
const art = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const DESK = '#ece8de';

/** name, size, mark scale (fraction of the canvas), corner radius (fraction), transparent outside the tile */
const targets = [
	['icon-192.png', 192, 0.74, 0.22, true],
	['icon-512.png', 512, 0.74, 0.22, true],
	// Maskable: full bleed, mark inside the 80% safe circle.
	['icon-maskable-192.png', 192, 0.58, 0, false],
	['icon-maskable-512.png', 512, 0.58, 0, false],
	// iOS rounds the corners itself and wants no transparency.
	['apple-touch-icon.png', 180, 0.7, 0, false],
	['favicon-32.png', 32, 1, 0, true]
];

const chrome = '/opt/google/chrome/chrome';
const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
const page = await browser.newPage();

for (const [name, size, scale, radius, transparent] of targets) {
	const tile = name.startsWith('favicon') ? 'transparent' : DESK;
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(`<!doctype html><html><body style="margin:0;background:transparent">
		<div style="width:${size}px;height:${size}px;display:grid;place-items:center;background:${tile};border-radius:${radius * 100}%">
			<img src="${art}" style="width:${size * scale}px;height:${size * scale}px">
		</div></body></html>`);
	await page.locator('img').evaluate((img) => img.decode());
	await page.screenshot({ path: `${root}static/${name}`, omitBackground: transparent });
	console.log('wrote', name);
}

await browser.close();
