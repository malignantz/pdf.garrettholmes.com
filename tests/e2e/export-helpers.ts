/** Shared steps for export dialog tests. */
import { expect, type Locator } from '@playwright/test';

/** The "More options" button of the export dialog (its name also lists what is on while folded). */
export const moreButton = (dialog: Locator) => dialog.getByRole('button', { name: /^More options/ });

/** Opens "More options" (split, size limit, page numbers, watermark, metadata, searchable scans) if it is folded. */
export async function openMore(dialog: Locator): Promise<void> {
	const button = moreButton(dialog);
	if ((await button.getAttribute('aria-expanded')) !== 'true') await button.click();
	await expect(button).toHaveAttribute('aria-expanded', 'true');
}
