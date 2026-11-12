/**
 * Pick up where you left off: the open work is kept on this device (IndexedDB) and
 * offered back on the next visit. Runs on desktop and phone.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as mupdf from 'mupdf';
import type { Page, TestInfo } from '@playwright/test';
import { test, expect } from './fixtures';
import { chooseTool, highlightShape, makeSignature, pageBox, tapPage } from './editor-helpers';

const corpus = (name: string) => fileURLToPath(new URL(`../corpus/files/${name}`, import.meta.url));
const options = (page: Page) => page.getByRole('option');
const line = (page: Page) => page.getByTestId('save-line');
const card = (page: Page) => page.getByRole('region', { name: 'Pick up where you left off?' });
const toasts = (page: Page) => page.getByRole('region', { name: 'Notifications' });
const SAVED = 'Saved on this device only.';
const isPhone = (info: TestInfo) => info.project.name === 'phone';

async function addFiles(page: Page, ...names: string[]) {
	await page.locator('input[type=file]').first().setInputFiles(names.map(corpus));
}

async function labels(page: Page): Promise<string[]> {
	return options(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
}

/** The saved record and stored blobs, read straight from IndexedDB. */
async function stored(page: Page): Promise<{ record: Record<string, unknown> | null; blobs: number }> {
	return page.evaluate(
		() =>
			new Promise((resolve, reject) => {
				const r = indexedDB.open('pdf-workspace-session');
				r.onerror = () => reject(r.error);
				r.onsuccess = () => {
					const db = r.result;
					if (!db.objectStoreNames.contains('session')) return resolve({ record: null, blobs: 0 });
					const tx = db.transaction(['session', 'blobs']);
					const rec = tx.objectStore('session').get('current');
					const n = tx.objectStore('blobs').count();
					tx.oncomplete = () => {
						db.close();
						resolve({ record: (rec.result as Record<string, unknown>) ?? null, blobs: n.result });
					};
				};
			})
	);
}

/** Wait until the saved record lists `pages` pages and nothing is pending. */
async function waitSaved(page: Page, pages: number) {
	await expect(line(page)).toContainText(SAVED);
	await expect.poll(async () => ((await stored(page)).record?.pages as unknown[] | undefined)?.length ?? 0, { timeout: 15_000 }).toBe(pages);
	await page.waitForTimeout(700);
}

/** Real touch drag through CDP (phone), or the mouse (desktop), in page fractions. */
async function dragOnPage(page: Page, info: TestInfo, from: [number, number], to: [number, number]) {
	const b = await pageBox(page);
	const pt = (f: [number, number]) => ({ x: b.x + f[0] * b.width, y: b.y + f[1] * b.height });
	const a = pt(from);
	const z = pt(to);
	if (isPhone(info)) {
		const cdp = await page.context().newCDPSession(page);
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...a, id: 1 }] });
		for (let i = 1; i <= 8; i++) {
			await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: a.x + ((z.x - a.x) * i) / 8, y: a.y + ((z.y - a.y) * i) / 8, id: 1 }] });
		}
		await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
		await cdp.detach();
	} else {
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		for (let i = 1; i <= 8; i++) await page.mouse.move(a.x + ((z.x - a.x) * i) / 8, a.y + ((z.y - a.y) * i) / 8);
		await page.mouse.up();
	}
}

async function exportAll(page: Page): Promise<Uint8Array> {
	await page.getByRole('button', { name: 'Export', exact: true }).click();
	const dialog = page.getByRole('dialog', { name: 'Export PDF' });
	await dialog.getByRole('button', { name: 'Export', exact: true }).click();
	const done = page.getByRole('dialog', { name: 'Your file is ready' });
	await expect(done.getByText(/^Checked: \d+ pages, opens cleanly\.$/)).toBeVisible({ timeout: 60_000 });
	const [download] = await Promise.all([page.waitForEvent('download'), done.getByRole('button', { name: 'Download' }).click()]);
	const bytes = new Uint8Array(readFileSync((await download.path())!));
	await done.getByRole('button', { name: /^(Done|Close)$/ }).first().click();
	await expect(done).toBeHidden();
	return bytes;
}

/** Every page rendered by MuPDF in Node, with its size: pixel for pixel. */
function renders(bytes: Uint8Array): string[] {
	const doc = new mupdf.PDFDocument(bytes.slice());
	try {
		const out: string[] = [];
		for (let i = 0; i < doc.countPages(); i++) {
			const p = doc.loadPage(i);
			const pix = p.toPixmap(mupdf.Matrix.scale(1, 1), mupdf.ColorSpace.DeviceRGB, false, true);
			out.push(`${p.getBounds().join(',')}:${Buffer.from(pix.getPixels()).toString('base64')}`);
			pix.destroy();
		}
		return out;
	} finally {
		doc.destroy();
	}
}

/**
 * Search every place the page can keep data (all IndexedDB databases, values and
 * blobs; localStorage; sessionStorage; OPFS) for a string, as UTF-8, UTF-16 and Latin-1.
 */
async function storageContains(page: Page, needle: string): Promise<string[]> {
	return page.evaluate(async (needle) => {
		const hits: string[] = [];
		const forms: Uint8Array[] = [new TextEncoder().encode(needle)];
		const u16 = new Uint8Array(needle.length * 2);
		for (let i = 0; i < needle.length; i++) {
			u16[2 * i] = needle.charCodeAt(i) & 0xff;
			u16[2 * i + 1] = needle.charCodeAt(i) >> 8;
		}
		forms.push(u16, Uint8Array.from(needle, (c) => c.charCodeAt(0) & 0xff));
		const has = (b: Uint8Array) =>
			forms.some((f) => {
				outer: for (let i = 0; i + f.length <= b.length; i++) {
					for (let j = 0; j < f.length; j++) if (b[i + j] !== f[j]) continue outer;
					return true;
				}
				return false;
			});
		const visit = async (v: unknown, where: string): Promise<void> => {
			if (v == null) return;
			if (typeof v === 'string') {
				if (v.includes(needle)) hits.push(where);
			} else if (v instanceof Blob) {
				if (has(new Uint8Array(await v.arrayBuffer()))) hits.push(`${where} (blob)`);
			} else if (v instanceof ArrayBuffer) {
				if (has(new Uint8Array(v))) hits.push(where);
			} else if (ArrayBuffer.isView(v)) {
				if (has(new Uint8Array(v.buffer, v.byteOffset, v.byteLength))) hits.push(where);
			} else if (typeof v === 'object') {
				for (const [k, x] of Object.entries(v as object)) {
					if (k.includes(needle)) hits.push(`${where}.${k} (key)`);
					await visit(x, `${where}.${k}`);
				}
			}
		};
		for (const info of await indexedDB.databases()) {
			const db = await new Promise<IDBDatabase>((res, rej) => {
				const r = indexedDB.open(info.name!);
				r.onsuccess = () => res(r.result);
				r.onerror = () => rej(r.error);
			});
			for (const name of db.objectStoreNames) {
				const all = await new Promise<unknown[]>((res) => {
					const r = db.transaction(name).objectStore(name).getAll();
					r.onsuccess = () => res(r.result);
				});
				await visit(all, `idb:${info.name}/${name}`);
			}
			db.close();
		}
		for (const [k, s] of [['local', localStorage], ['session', sessionStorage]] as const) {
			for (let i = 0; i < s.length; i++) {
				const key = s.key(i)!;
				await visit(`${key}=${s.getItem(key)}`, `${k}Storage`);
			}
		}
		try {
			const walk = async (dir: FileSystemDirectoryHandle, path: string): Promise<void> => {
				for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
					if (h.kind === 'file') await visit(await (h as FileSystemFileHandle).getFile(), `opfs:${path}/${name}`);
					else await walk(h as FileSystemDirectoryHandle, `${path}/${name}`);
				}
			};
			await walk(await navigator.storage.getDirectory(), '');
		} catch {
			// No OPFS here.
		}
		return hits;
	}, needle);
}

test('work survives a reload: Restore brings back the same pages and the same export', async ({ page }, info) => {
	test.setTimeout(180_000);
	const dialogs: string[] = [];
	page.on('dialog', (d) => {
		dialogs.push(d.type());
		void d.dismiss();
	});
	await page.goto('/');
	await addFiles(page, 'multi.pdf', 'rotated.pdf');
	await expect(options(page)).toHaveCount(12, { timeout: 30_000 });

	// Reorder and rotate with the keyboard (same on both layouts).
	await options(page).first().focus();
	await page.keyboard.press(' ');
	await page.keyboard.press('Alt+ArrowRight');
	await page.keyboard.press('Alt+ArrowRight');
	await page.keyboard.press('r');
	await page.keyboard.press('Escape');

	// Text, signature, highlight and a check on page 2.
	await options(page).nth(1).focus();
	await page.keyboard.press('Enter');
	const editor = page.getByRole('dialog', { name: /^Edit page 2 of 12/ });
	await expect(editor).toBeVisible();
	await expect(page.getByTestId('editor-page')).toBeVisible();
	await page.waitForFunction(() => {
		const c = document.querySelector<HTMLCanvasElement>('[data-testid=editor-page] canvas');
		return !!c && c.width > 0;
	});
	await chooseTool(page, 'Text');
	await tapPage(page, 0.15, 0.75);
	await expect(page.getByRole('textbox', { name: 'Text on the page' })).toBeFocused();
	await page.keyboard.type('Saved 12 Nov');
	await page.keyboard.press('Escape');
	await makeSignature(page, { save: false });
	await tapPage(page, 0.4, 0.4);
	await page.keyboard.press('Escape');
	await chooseTool(page, 'Highlight');
	await highlightShape(page, 'Box');
	await dragOnPage(page, info, [0.2, 0.55], [0.6, 0.6]);
	await page.keyboard.press('Escape');
	await chooseTool(page, 'Check');
	await tapPage(page, 0.8, 0.15);
	await page.keyboard.press('Escape');
	await editor.getByRole('button', { name: 'Done', exact: true }).click();
	await expect(editor).toBeHidden();

	const before = await labels(page);
	expect(before[2]).toContain('multi.pdf');
	expect(before[2]).toMatch(/rotated 90°/);
	const exported = await exportAll(page);
	await waitSaved(page, 12);
	const rec = (await stored(page)).record!;
	const stamps = (rec.pages as { stamps: { kind: string; mark?: string }[] }[]).flatMap((p) => p.stamps.map((s) => s.mark ?? s.kind));
	expect(stamps.sort()).toEqual(['check', 'highlight', 'image', 'text']);

	// Saved work: leaving does not ask.
	await page.reload();
	expect(dialogs).toEqual([]);
	await expect(card(page)).toBeVisible();
	await expect(card(page)).toContainText('2 files, 12 pages, saved just now');
	await expect(options(page)).toHaveCount(0);
	await card(page).getByRole('button', { name: 'Restore' }).click();
	await expect(options(page)).toHaveCount(12, { timeout: 30_000 });
	await expect(card(page)).toBeHidden();
	expect(await labels(page)).toEqual(before);
	await expect(line(page)).toContainText(SAVED);

	// Undo history is not kept.
	await expect(page.getByRole('button', { name: /^Undo/ })).toBeDisabled();

	// The same export as before the reload: same pages, same stamps, pixel for pixel.
	const again = await exportAll(page);
	const a = renders(exported);
	const b = renders(again);
	expect(b.length).toBe(12);
	expect(b).toEqual(a);
});

test('Discard deletes the saved work', async ({ page }) => {
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await waitSaved(page, 6);
	await page.reload();
	await card(page).getByRole('button', { name: 'Discard' }).click();
	await expect(card(page)).toBeHidden();
	await expect(toasts(page).getByText('Saved work deleted.')).toBeVisible();
	await expect.poll(async () => (await stored(page)).blobs).toBe(0);
	expect((await stored(page)).record).toBeNull();
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Combine, sign and fix PDFs' })).toBeVisible();
	await page.waitForTimeout(500);
	await expect(card(page)).toHaveCount(0);
});

test('opening a file instead of answering replaces the saved work once the new work is saved', async ({ page }) => {
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await waitSaved(page, 6);
	await page.reload();
	await expect(card(page)).toBeVisible();
	await addFiles(page, 'sizes.pdf');
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await expect.poll(async () => JSON.stringify((await stored(page)).record?.sources ?? [])).toContain('sizes.pdf');
	await expect.poll(async () => (await stored(page)).blobs).toBe(1);
	await page.reload();
	await expect(card(page)).toContainText('1 file, 6 pages');
});

test('Forget my work deletes everything stored now', async ({ page }) => {
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await waitSaved(page, 6);
	expect((await stored(page)).blobs).toBe(1);
	await line(page).getByRole('button', { name: 'Settings' }).click();
	const dlg = page.getByRole('dialog', { name: 'Your work on this device' });
	await expect(dlg).toContainText(SAVED);
	await dlg.getByRole('button', { name: 'Forget my work' }).click();
	await expect(toasts(page).getByText('Your work was removed from this device.')).toBeVisible();
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await expect(line(page)).toContainText('This work is not being saved. You removed it from this device.');
	expect(await stored(page)).toEqual({ record: null, blobs: 0 });
	// Changes to the forgotten work are not saved again.
	await options(page).first().focus();
	await page.keyboard.press('r');
	await page.waitForTimeout(1000);
	expect(await stored(page)).toEqual({ record: null, blobs: 0 });
	page.on('dialog', (d) => void d.accept());
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Combine, sign and fix PDFs' })).toBeVisible();
	await page.waitForTimeout(500);
	await expect(card(page)).toHaveCount(0);
});

test('the switch: off deletes what is stored and is remembered; on saves again', async ({ page }) => {
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await waitSaved(page, 6);
	await line(page).getByRole('button', { name: 'Settings' }).click();
	const dlg = page.getByRole('dialog', { name: 'Your work on this device' });
	const sw = dlg.getByRole('switch', { name: 'Keep my work on this device' });
	await expect(sw).toBeChecked();
	await sw.click();
	await expect(sw).not.toBeChecked();
	await expect(dlg).toContainText('This work is not being saved. Keeping work on this device is off.');
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await expect(line(page)).toContainText('Keeping work on this device is off.');
	await expect.poll(() => stored(page)).toEqual({ record: null, blobs: 0 });
	expect(await page.evaluate(() => localStorage.getItem('pdf-workspace.keep-work'))).toBe('0');

	page.on('dialog', (d) => void d.accept());
	await page.reload();
	await expect(page.getByRole('heading', { name: 'Combine, sign and fix PDFs' })).toBeVisible();
	await addFiles(page, 'sizes.pdf');
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await expect(line(page)).toContainText('Keeping work on this device is off.');
	await page.waitForTimeout(1000);
	expect(await stored(page)).toEqual({ record: null, blobs: 0 });

	// On again: what is open now is saved.
	await line(page).getByRole('button', { name: 'Settings' }).click();
	await sw.click();
	await expect(sw).toBeChecked();
	await dlg.getByRole('button', { name: 'Close' }).last().click();
	await waitSaved(page, 6);
});

test('a password-protected file: kept encrypted, the password asked again, never stored', async ({ page }) => {
	test.setTimeout(90_000);
	const password = 'pässwörd';
	await page.goto('/');
	await addFiles(page, 'enc-aes-256-unicode.pdf', 'multi.pdf');
	const pw = page.getByRole('dialog', { name: 'This file has a password' });
	await expect(pw).toBeVisible({ timeout: 30_000 });
	await pw.getByLabel('Password', { exact: true }).fill(password);
	await pw.getByRole('button', { name: 'Open' }).click();
	await expect(options(page)).toHaveCount(8, { timeout: 30_000 });
	await waitSaved(page, 8);
	const rec = (await stored(page)).record!;
	const enc = (rec.sources as { name: string; stored: string; needsPassword: boolean; size: number }[]).find((s) => s.name === 'enc-aes-256-unicode.pdf')!;
	expect(enc.stored).toBe('original');
	expect(enc.needsPassword).toBe(true);
	// Stored as given: the same bytes as the file on disk.
	expect(enc.size).toBe(readFileSync(corpus('enc-aes-256-unicode.pdf')).length);
	expect(await storageContains(page, password)).toEqual([]);
	const before = await labels(page);

	await page.reload();
	await card(page).getByRole('button', { name: 'Restore' }).click();
	await expect(pw).toBeVisible();
	await expect(pw).toContainText('enc-aes-256-unicode.pdf');
	// A wrong password, then the right one.
	await pw.getByLabel('Password', { exact: true }).fill('wrong');
	await pw.getByRole('button', { name: 'Open' }).click();
	await expect(pw.getByText('That password did not open the file. Check it and try again.')).toBeVisible();
	await pw.getByLabel('Password', { exact: true }).fill(password);
	await pw.getByRole('button', { name: 'Open' }).click();
	await expect(options(page)).toHaveCount(8, { timeout: 30_000 });
	expect(await labels(page)).toEqual(before);
	await page.waitForTimeout(800);
	expect(await storageContains(page, password)).toEqual([]);

	// Skipping the protected file restores the rest and leaves a consistent session.
	await page.reload();
	await card(page).getByRole('button', { name: 'Restore' }).click();
	await pw.getByRole('button', { name: 'Skip this file' }).click();
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await expect(toasts(page).getByText('Restored 6 pages. 1 file with a password was left out.')).toBeVisible();
	expect((await labels(page)).every((l) => l.includes('multi.pdf'))).toBe(true);
	await waitSaved(page, 6);
	expect(await storageContains(page, password)).toEqual([]);
});

test('a second tab works but does not save', async ({ page, context }) => {
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Combine, sign and fix PDFs' })).toBeVisible();
	const second = await context.newPage();
	await second.goto('/');
	await addFiles(second, 'sizes.pdf');
	await expect(options(second)).toHaveCount(6, { timeout: 30_000 });
	await expect(line(second)).toContainText('This work is not being saved. The app is open in another tab.');
	await second.waitForTimeout(1000);
	expect(await stored(second)).toEqual({ record: null, blobs: 0 });

	await addFiles(page, 'multi.pdf');
	await waitSaved(page, 6);
	expect(JSON.stringify((await stored(page)).record!.sources)).toContain('multi.pdf');
	// The second tab's changes never overwrite it.
	await options(second).first().focus();
	await second.keyboard.press('r');
	await second.waitForTimeout(1000);
	expect(JSON.stringify((await stored(page)).record!.sources)).not.toContain('sizes.pdf');
	await second.close();
});

test('storage blocked: the app still works, says the work is not saved, and leaving asks', async ({ page, guard }) => {
	await page.addInitScript(() => {
		const blocked = () => {
			throw new DOMException('The user denied permission to access the database.', 'SecurityError');
		};
		Object.defineProperty(IDBFactory.prototype, 'open', { value: blocked });
	});
	guard.allowConsoleErrors();
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await expect(options(page)).toHaveCount(6, { timeout: 30_000 });
	await expect(line(page)).toContainText('This work is not being saved. This browser does not allow it here.');
	// The leave warning is still there (a real click first: browsers ask only after one).
	await options(page).first().click();
	const dialog = page.waitForEvent('dialog');
	await page.close({ runBeforeUnload: true });
	const d = await dialog;
	expect(d.type()).toBe('beforeunload');
	await d.dismiss();
});

test('a session saved more than 7 days ago is gone', async ({ page }) => {
	await page.goto('/');
	await addFiles(page, 'multi.pdf');
	await waitSaved(page, 6);
	// Age it by 8 days.
	await page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				const r = indexedDB.open('pdf-workspace-session');
				r.onsuccess = () => {
					const db = r.result;
					const tx = db.transaction('session', 'readwrite');
					const s = tx.objectStore('session');
					const g = s.get('current');
					g.onsuccess = () => s.put({ ...g.result, savedAt: g.result.savedAt - 8 * 86400_000 }, 'current');
					tx.oncomplete = () => (db.close(), resolve());
				};
			})
	);
	// Leave without saving again (the old record must be what the next visit sees).
	await page.goto('about:blank');
	await page.goto('/');
	await expect(page.getByRole('heading', { name: 'Combine, sign and fix PDFs' })).toBeVisible();
	await expect.poll(() => stored(page)).toEqual({ record: null, blobs: 0 });
	await expect(card(page)).toHaveCount(0);
});
