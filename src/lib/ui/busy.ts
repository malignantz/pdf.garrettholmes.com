/**
 * "Is the user in the middle of handing us a file?" The page is never reloaded
 * for a new version while this says yes: a reload with the file picker open, or
 * while the first file is still opening, throws the file away without a word.
 */

let holds = 0;
let picking = false;

/** Mark work in hand (files opening, saved work restoring). Returns the release. */
export function holdBusy(): () => void {
	holds++;
	let released = false;
	return () => {
		if (released) return;
		released = true;
		holds--;
	};
}

export function isBusy(): boolean {
	return holds > 0 || picking;
}

/**
 * Track the browser's file picker: open from the click on a file input until it
 * reports files or a cancel. A browser that never reports a cancel leaves this
 * set, which only means the new version is offered instead of taken.
 */
export function watchFilePickers(target: Pick<Document, 'addEventListener'> = document) {
	const isFileInput = (e: Event) => {
		const el = e.target as { tagName?: string; type?: string } | null;
		return el?.tagName === 'INPUT' && el.type === 'file';
	};
	target.addEventListener('click', (e) => isFileInput(e) && (picking = true), true);
	const done = (e: Event) => isFileInput(e) && (picking = false);
	target.addEventListener('change', done, true);
	target.addEventListener('cancel', done, true);
}

/** For tests. */
export function resetBusy() {
	holds = 0;
	picking = false;
}
