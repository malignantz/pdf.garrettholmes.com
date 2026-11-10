const FOCUSABLE = [
	'a[href]',
	'button:not([disabled])',
	'input:not([disabled]):not([type="hidden"])',
	'select:not([disabled])',
	'textarea:not([disabled])',
	'[tabindex]:not([tabindex="-1"])',
	'[contenteditable="true"]'
].join(',');

export function focusables(root: HTMLElement): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
		(el) => !el.closest('[inert]') && el.getClientRects().length > 0
	);
}

/** Keep Tab and Shift+Tab inside `root`. Call from a keydown handler. */
export function trapTab(e: KeyboardEvent, root: HTMLElement) {
	if (e.key !== 'Tab') return;
	const list = focusables(root);
	if (list.length === 0) {
		e.preventDefault();
		return;
	}
	const first = list[0];
	const last = list[list.length - 1];
	const active = document.activeElement;
	if (e.shiftKey && (active === first || !root.contains(active))) {
		e.preventDefault();
		last.focus();
	} else if (!e.shiftKey && (active === last || !root.contains(active))) {
		e.preventDefault();
		first.focus();
	}
}
