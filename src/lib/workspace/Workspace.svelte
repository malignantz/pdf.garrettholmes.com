<script lang="ts">
	import { onMount, tick, untrack, type Component } from 'svelte';
	import { version } from '$app/env';
	import { describeError } from '../ui/error-report';
	import type { PageId } from '../core/types';
	import { getApp } from '../app';
	import { useDocStore } from '../doc/store.svelte';
	import ActionBar from '../ui/ActionBar.svelte';
	import Button from '../ui/Button.svelte';
	import EmptyDesk from '../ui/EmptyDesk.svelte';
	import Icon from '../ui/Icon.svelte';
	import IconButton from '../ui/IconButton.svelte';
	import Menu, { type MenuItem } from '../ui/Menu.svelte';
	import Slider from '../ui/Slider.svelte';
	import TopBarActions from '../ui/TopBarActions.svelte';
	import { toasts } from '../ui/toasts.svelte';
	import ExportDialog from './ExportDialog.svelte';
	import IntakePanel from './IntakePanel.svelte';
	import PageGrid from './PageGrid.svelte';
	import PasswordDialog from './PasswordDialog.svelte';
	import ShortcutSheet from './ShortcutSheet.svelte';
	import RestoreCard from '../session/RestoreCard.svelte';
	import SaveDialog from '../session/SaveDialog.svelte';
	import SaveLine from '../session/SaveLine.svelte';
	import { getSession, useSession } from '../session/index.svelte';
	import { BROKEN_MESSAGE } from '../session/session';
	import { exportForm } from './export-form.svelte';
	import { play, snapshot } from './flip';
	import { createIntake, type PasswordAsk } from './intake.svelte';
	import { holdBusy } from '../ui/busy';
	import { addedMessage, keyboardMoveSlot, pastTense, plural, slotAfterSelection } from './logic';

	const { store, engine, renderer } = getApp();
	const doc = useDocStore(store);
	const session = getSession();
	const saved = useSession(session);
	let saveOpen = $state(false);

	const ACCEPT = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/bmp,image/heic,image/heif,.heic,.heif,image/*';
	const THUMB_KEY = 'pdf-workspace.thumb';

	let grid: PageGrid | undefined = $state();
	let fileInput: HTMLInputElement | undefined = $state();
	let focusedId = $state<PageId | null>(null);
	let selectionMode = $state(false);
	let narrow = $state(false);
	let mod = $state('Ctrl');
	let thumb = $state(readThumb());

	let exportOpen = $state(false);
	let exportMode = $state<'all' | 'extract'>('all');
	let exportIds = $state<PageId[]>([]);
	let shortcutsOpen = $state(false);

	let pwAsk = $state<PasswordAsk | null>(null);
	let pwResolve: ((pw: string | null) => void) | null = null;

	type EditorComponent = Component<{ pageId: PageId; onclose: () => void }>;
	let Editor = $state<EditorComponent | null>(null);
	let editorId = $state<PageId | null>(null);

	let live = $state('');
	let fileDrag = $state(false);
	let dragDepth = 0;

	const pages = $derived(doc.state.pages);
	const selection = $derived(doc.state.selection);
	const count = $derived(pages.length);
	const selCount = $derived(selection.size);
	const hasPages = $derived(count > 0);
	const showDock = $derived(hasPages && narrow);
	const showFloat = $derived(hasPages && !narrow && selCount > 0);

	const intake = createIntake({
		store,
		engine,
		onOpened: (source, info) => session.noteOpened(source, info),
		askPassword,
		notify: (m) => toasts.show({ message: m.message, tone: m.tone }),
		onFirstPages: async (ids) => {
			await tick();
			if (store.state.pages.length > ids.length) grid?.scrollToPage(ids[0]);
		},
		onBatchDone: ({ ids, insertedAt, anchored }) => {
			const total = store.state.pages.length;
			const msg = anchored ? addedMessage(ids.length, insertedAt, total) : `Added ${plural(ids.length, 'page')}`;
			toasts.show({ message: msg, tone: 'ok' });
			say(msg);
		}
	});

	function askPassword(ask: PasswordAsk): Promise<string | null> {
		return new Promise((resolve) => {
			pwAsk = ask;
			pwResolve = resolve;
		});
	}

	function answerPassword(pw: string | null) {
		const r = pwResolve;
		pwResolve = null;
		pwAsk = null;
		r?.(pw);
	}

	// ------------------------------------------------------------ helpers

	function readThumb(): number {
		try {
			const v = Number(localStorage.getItem(THUMB_KEY));
			if (v >= 112 && v <= 320) return v;
		} catch {
			// Storage blocked: use the default.
		}
		return 168;
	}

	function saveThumb(v: number) {
		try {
			localStorage.setItem(THUMB_KEY, String(v));
		} catch {
			// Not important.
		}
	}

	function say(msg: string) {
		// A changed string is re-announced even when the words repeat.
		live = live === msg ? `${msg} ` : msg;
	}

	/** Run a store change and slide the tiles to their new places. */
	function flip<T>(fn: () => T, entering?: () => Iterable<PageId>): T {
		const el = grid?.element();
		const before = snapshot(el);
		const out = fn();
		void tick().then(() => play(grid?.element(), before, new Set(entering?.() ?? [])));
		return out;
	}

	/** Selected pages in document order, or the focused page when nothing is selected. */
	function targets(): PageId[] {
		const s = store.state;
		if (s.selection.size) return s.pages.filter((p) => s.selection.has(p.id)).map((p) => p.id);
		if (focusedId && s.pages.some((p) => p.id === focusedId) && document.activeElement?.closest('[role="listbox"]')) {
			return [focusedId];
		}
		return [];
	}

	// Announce every command, undo and redo in the live region.
	let lastEvent: unknown = null;
	$effect(() => {
		const ev = doc.state.lastEvent;
		if (!ev || ev === lastEvent) return;
		lastEvent = ev;
		say(ev.kind === 'undo' ? `Undid: ${ev.label}` : ev.kind === 'redo' ? `Redid: ${ev.label}` : pastTense(ev.label));
	});

	// On phones a selection only makes sense in selection mode (its bar holds the actions),
	// however it was made: Select all from the menu, Ctrl+A on a keyboard, a new blank page.
	$effect(() => {
		if (narrow && selCount > 0 && !selectionMode) selectionMode = true;
	});

	// Leave selection mode when the pages are gone.
	$effect(() => {
		if (!hasPages) selectionMode = false;
	});

	// Toasts sit above whichever bottom bar is showing.
	$effect(() => {
		const offset = showDock ? 64 : showFloat ? 64 : 0;
		document.documentElement.style.setProperty('--toast-offset', `${offset}px`);
		return () => document.documentElement.style.removeProperty('--toast-offset');
	});

	onMount(() => {
		const mq = matchMedia('(max-width: 599px)');
		const sync = () => (narrow = mq.matches);
		sync();
		mq.addEventListener('change', sync);
		mod = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? 'Cmd' : 'Ctrl';
		// One small read: is there saved work to offer? Never restores by itself.
		void session.init();
		const hide = () => session.pageHide();
		addEventListener('pagehide', hide);
		const vis = () => document.visibilityState === 'hidden' && session.pageHide();
		document.addEventListener('visibilitychange', vis);
		return () => {
			mq.removeEventListener('change', sync);
			removeEventListener('pagehide', hide);
			document.removeEventListener('visibilitychange', vis);
		};
	});

	// No reload for a new version while files are opening or saved work is coming back.
	$effect(() => {
		if (intake.busy || saved.restoring) return holdBusy();
	});

	// The export options are saved with the work (never the password).
	$effect(() => {
		JSON.stringify(exportForm);
		untrack(() => session.touch());
	});

	// ------------------------------------------------------------ saved work

	async function restoreSaved() {
		if (intake.busy || store.state.pages.length) return;
		const r = await session.restore(askPassword);
		if (r.ok) {
			const n = store.state.pages.length;
			const msg = r.skipped
				? `Restored ${plural(n, 'page')}. ${plural(r.skipped, 'file')} with a password ${r.skipped === 1 ? 'was' : 'were'} left out.`
				: `Restored ${plural(n, 'page')}.`;
			toasts.show({ message: msg, tone: 'ok' });
			say(msg);
		} else if (r.reason === 'broken') {
			toasts.show({ message: BROKEN_MESSAGE, tone: 'error' });
		} else if (r.reason === 'skipped') {
			toasts.show({ message: 'Nothing was restored. Your saved work is still here.' });
		} else if (!saved.offer) {
			toasts.show({ message: 'The saved work is no longer here.' });
		}
	}

	async function discardSaved() {
		await session.discard();
		toasts.show({ message: 'Saved work deleted.' });
	}

	async function setKeep(on: boolean) {
		await session.setKeep(on);
		toasts.show({ message: on ? 'Your work will be kept on this device.' : 'Your work is no longer kept on this device. What was saved is deleted.' });
	}

	async function forgetWork() {
		const ok = await session.forget();
		toasts.show(
			ok
				? { message: 'Your work was removed from this device.' }
				: { message: 'Could not remove saved work. Clear this site’s data in your browser settings.', tone: 'error' }
		);
	}

	// ------------------------------------------------------------ commands

	function addFiles(files: File[]) {
		intake.add(files);
	}

	function pickFiles() {
		(fileInput ?? document.querySelector<HTMLInputElement>('input[type=file]'))?.click();
	}

	function onFileInput() {
		const files = [...(fileInput?.files ?? [])];
		if (fileInput) fileInput.value = '';
		addFiles(files);
	}

	function rotate(delta: number, ids = targets()) {
		if (ids.length) store.rotatePages(ids, delta);
	}

	function remove(ids = targets()) {
		if (!ids.length) return;
		const first = store.state.pages.findIndex((p) => p.id === ids[0]);
		flip(() => store.removePages(ids));
		const label = store.undoLabel;
		toasts.show({
			message: pastTense(label ?? 'Delete pages'),
			action: {
				label: 'Undo',
				run: () => {
					if (store.undoLabel === label) flip(() => store.undo());
				}
			}
		});
		// Keep keyboard focus in the grid, on the page that took the deleted one's place.
		const next = store.state.pages[Math.min(first, store.state.pages.length - 1)];
		if (next) {
			focusedId = next.id;
			if (document.activeElement === document.body || !document.activeElement?.isConnected) {
				void tick().then(() => grid?.focusPage(next.id, false));
			}
		}
	}

	function duplicate(ids = targets()) {
		if (!ids.length) return;
		let created: PageId[] = [];
		flip(
			() => (created = store.duplicatePages(ids)),
			() => created
		);
		store.setSelection(created);
	}

	function extract(ids = targets()) {
		if (!ids.length) return;
		exportMode = 'extract';
		exportIds = ids;
		exportOpen = true;
	}

	function exportAll() {
		if (!hasPages) return;
		exportMode = 'all';
		exportIds = [];
		exportOpen = true;
	}

	async function insertBlank() {
		const s = store.state;
		const ids = targets();
		const neighbor = ids.length ? s.pages.find((p) => p.id === ids[ids.length - 1]) : s.pages[s.pages.length - 1];
		const size = (neighbor && store.displayedSize(neighbor)) ?? { width: 612, height: 792 };
		try {
			const source = await engine.blankPage(size);
			const cur = store.state;
			const at = neighbor ? cur.pages.findIndex((p) => p.id === neighbor.id) + 1 : cur.pages.length;
			let created: PageId[] = [];
			flip(
				() => (created = store.addSource(source, at > 0 ? at : cur.pages.length)),
				() => created
			);
			store.setSelection(created);
			focusedId = created[0] ?? focusedId;
			await tick();
			if (created[0]) grid?.scrollToPage(created[0]);
		} catch (e) {
			toasts.show({ message: (e as Error)?.message || 'Could not make a blank page.', tone: 'error' });
		}
	}

	function reverse() {
		const ids = targets();
		flip(() => store.reversePages(ids.length > 1 ? ids : undefined));
	}

	function moveTo(where: 'start' | 'end') {
		const ids = targets();
		if (ids.length) flip(() => store.movePages(ids, where === 'start' ? 0 : store.state.pages.length));
	}

	function groupByFile() {
		if (!flip(() => store.sortBySource())) toast('Pages are already grouped by file.');
	}

	function undo() {
		flip(() => store.undo());
	}

	function redo() {
		flip(() => store.redo());
	}

	function startOver() {
		if (!hasPages) return;
		const n = store.state.pages.length;
		store.clear();
		selectionMode = false;
		focusedId = null;
		const label = store.undoLabel;
		toasts.show({
			message: `Removed all ${plural(n, 'page')}.`,
			action: { label: 'Undo', run: () => store.undoLabel === label && store.undo() }
		});
	}

	function toast(message: string) {
		toasts.show({ message });
	}

	function selectAll() {
		store.selectAll();
	}

	function clearSelection() {
		store.clearSelection();
		selectionMode = false;
	}

	async function openEditor(id: PageId) {
		focusedId = id;
		try {
			Editor ??= (await import('../editor/PageEditor.svelte')).default as EditorComponent;
			editorId = id;
		} catch {
			toasts.show({ message: 'The page editor could not load. Reload the page and try again.', tone: 'error' });
		}
	}

	async function closeEditor() {
		const id = editorId;
		editorId = null;
		await tick();
		if (id && store.state.pages.some((p) => p.id === id)) grid?.focusPage(id);
	}

	/**
	 * The editor threw while drawing. Close it and keep the document, instead of
	 * letting the error take the whole workspace down.
	 */
	function editorFailed(err: unknown) {
		console.error(err);
		if (store.gestureActive) store.commitGesture();
		void closeEditor();
		// SvelteKit hands over its own error object; the real one is in `detail`.
		const real = (err as { detail?: unknown } | null)?.detail;
		const active = document.activeElement;
		const report = [
			typeof real === 'string' ? real : describeError(err),
			`focus: ${active ? `${active.tagName} ${active.className}` : 'none'}`,
			`at: ${new Date().toISOString()}; build ${version}`,
			navigator.userAgent
		].join('\n');
		toasts.show({
			message: `The page editor hit a problem and was closed. Your pages are still here. (${report.split('\n')[0].slice(0, 160)})`,
			tone: 'error',
			action: {
				label: 'Copy details',
				run: () => void navigator.clipboard?.writeText(report).catch(() => undefined)
			}
		});
	}

	// ------------------------------------------------------------ grid callbacks

	function onselect(id: PageId, m: { toggle: boolean; range: boolean }) {
		if (m.range) store.selectRange(id, { additive: m.toggle });
		else if (m.toggle) store.toggle(id);
		else store.select(id);
	}

	/** What a long-press changed, so a long-press that turns into a drag can put it back. */
	let beforeLongPress: { mode: boolean; selection: PageId[] } | null = null;

	function onlongpress(id: PageId) {
		beforeLongPress = { mode: selectionMode, selection: [...store.state.selection] };
		selectionMode = true;
		if (!store.state.selection.has(id)) store.toggle(id);
	}

	function onlongpressdragend() {
		const b = beforeLongPress;
		beforeLongPress = null;
		if (!b || b.mode) return;
		// The long-press was only the way to pick the page up: leave things as they were.
		selectionMode = false;
		store.setSelection(b.selection.filter((id) => store.state.pages.some((p) => p.id === id)));
	}

	function onmove(ids: PageId[], slot: number) {
		flip(() => store.movePages(ids, slot));
	}

	function onaction(action: 'rotate-left' | 'rotate-right' | 'delete', id: PageId) {
		// Hover buttons act on the selection when the page is part of it.
		const ids = store.state.selection.has(id) ? targets() : [id];
		if (action === 'delete') remove(ids);
		else rotate(action === 'rotate-left' ? -90 : 90, ids);
	}

	function ongridkey(e: KeyboardEvent, id: PageId, cols: number) {
		const list = store.state.pages;
		const i = list.findIndex((p) => p.id === id);
		if (i < 0) return;
		const steps: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols };
		const modKey = e.ctrlKey || e.metaKey;

		if (e.key in steps && e.altKey) {
			e.preventDefault();
			if (!store.state.selection.has(id)) store.select(id);
			const slot = keyboardMoveSlot(list, store.state.selection, steps[e.key]);
			if (slot === null) return;
			const ids = targets();
			flip(() => store.movePages(ids, slot));
			void tick().then(() => grid?.focusPage(id));
			return;
		}

		let next = -1;
		if (e.key in steps) next = Math.min(list.length - 1, Math.max(0, i + steps[e.key]));
		else if (e.key === 'Home') next = 0;
		else if (e.key === 'End') next = list.length - 1;

		if (next >= 0) {
			e.preventDefault();
			const nextId = list[next].id;
			if (e.shiftKey) {
				if (!store.state.anchor) store.select(id);
				store.selectRange(nextId, { additive: modKey });
			} else if (!modKey && !selectionMode) store.select(nextId);
			focusedId = nextId;
			grid?.focusPage(nextId);
			return;
		}

		if (e.key === ' ') {
			e.preventDefault();
			store.toggle(id);
		} else if (e.key === 'Enter') {
			e.preventDefault();
			void openEditor(id);
		}
	}

	// ------------------------------------------------------------ window events

	function isTyping(t: EventTarget | null) {
		const el = t as HTMLElement | null;
		return !!el?.closest?.('input, textarea, select, [contenteditable="true"]');
	}

	function blocked() {
		return !!editorId || !!document.querySelector('dialog[open]') || !!document.querySelector('[popover]:popover-open');
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.defaultPrevented || isTyping(e.target)) return;
		if (e.key === 'Escape' && grid?.cancelDrag()) {
			e.preventDefault();
			return;
		}
		if (blocked()) return;
		const modKey = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();

		if (e.key === '?' || (e.shiftKey && e.code === 'Slash')) {
			e.preventDefault();
			shortcutsOpen = true;
			return;
		}
		if (modKey && k === 'o') {
			e.preventDefault();
			pickFiles();
			return;
		}
		if (!hasPages) return;
		if (modKey && k === 'z') {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
		} else if (modKey && k === 'y') {
			e.preventDefault();
			redo();
		} else if (modKey && k === 'a') {
			e.preventDefault();
			selectAll();
		} else if (modKey && k === 's') {
			e.preventDefault();
			exportAll();
		} else if (modKey && k === 'd') {
			e.preventDefault();
			duplicate();
		} else if (e.key === 'Escape') {
			if (selCount || selectionMode) {
				e.preventDefault();
				clearSelection();
			}
		} else if ((e.key === 'Delete' || e.key === 'Backspace') && !modKey && !e.altKey) {
			const ids = targets();
			if (ids.length) {
				e.preventDefault();
				remove(ids);
			}
		} else if (k === 'r' && !modKey && !e.altKey) {
			const ids = targets();
			if (ids.length) {
				e.preventDefault();
				rotate(e.shiftKey ? -90 : 90, ids);
			}
		}
	}

	function onpaste(e: ClipboardEvent) {
		if (isTyping(e.target) || blocked()) return;
		const dt = e.clipboardData;
		if (!dt) return;
		let files = [...dt.files];
		if (!files.length) {
			files = [...dt.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter((f): f is File => !!f);
		}
		if (!files.length) return;
		e.preventDefault();
		addFiles(files);
	}

	function onbeforeunload(e: BeforeUnloadEvent) {
		// Work kept on this device is not lost by leaving; anything else still asks.
		if (store.state.isDirty && store.state.pages.length > 0 && !session.safeToLeave) {
			e.preventDefault();
			e.returnValue = '';
		}
	}

	// Drop files anywhere while pages are showing (EmptyDesk handles the empty state).
	function hasFiles(e: DragEvent) {
		return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	}

	function ondragenter(e: DragEvent) {
		if (!hasPages || !hasFiles(e) || blocked()) return;
		e.preventDefault();
		dragDepth++;
		fileDrag = true;
	}

	function ondragover(e: DragEvent) {
		if (!hasPages || !hasFiles(e) || blocked()) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function ondragleave(e: DragEvent) {
		if (!hasPages || !hasFiles(e)) return;
		dragDepth = Math.max(0, dragDepth - 1);
		if (dragDepth === 0) fileDrag = false;
	}

	function ondrop(e: DragEvent) {
		if (!hasPages || !hasFiles(e)) return;
		e.preventDefault();
		dragDepth = 0;
		fileDrag = false;
		if (blocked()) return;
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) addFiles(files);
	}

	const dropHint = $derived.by(() => {
		if (!selCount) return 'Drop to add them at the end';
		const slot = slotAfterSelection(pages, selection);
		return slot >= count ? 'Drop to add them at the end' : `Drop to add them after page ${slot}`;
	});

	// ------------------------------------------------------------ menus

	const menuItems = $derived.by((): (MenuItem | 'separator')[] => {
		const t = selCount > 0;
		return [
			{ label: 'Select all', icon: 'select', hint: `${mod}+A`, onselect: selectAll, disabled: !hasPages },
			{ label: 'Move to start', onselect: () => moveTo('start'), disabled: !t },
			{ label: 'Move to end', onselect: () => moveTo('end'), disabled: !t },
			{ label: t && selCount > 1 ? 'Reverse selected pages' : 'Reverse order', onselect: reverse, disabled: count < 2 },
			{ label: 'Group pages by file', onselect: groupByFile, disabled: doc.state.sources.length < 2 },
			{ label: 'Insert blank page', icon: 'blank-page', onselect: insertBlank, disabled: !hasPages },
			'separator',
			{ label: 'Keyboard shortcuts', hint: '?', onselect: () => (shortcutsOpen = true) },
			{ label: 'Your work on this device', icon: 'shield-check', onselect: () => (saveOpen = true) },
			{ label: 'Start over', icon: 'trash', danger: true, onselect: startOver, disabled: !hasPages }
		];
	});

	const selectionMenu = $derived.by((): (MenuItem | 'separator')[] => [
		{ label: 'Rotate left', icon: 'rotate-left', hint: 'Shift+R', onselect: () => rotate(-90) },
		{ label: 'Export selected pages only', icon: 'extract', onselect: () => extract() },
		{ label: 'Insert blank page after', icon: 'blank-page', onselect: insertBlank },
		'separator',
		{ label: 'Move to start', onselect: () => moveTo('start') },
		{ label: 'Move to end', onselect: () => moveTo('end') },
		{ label: selCount > 1 ? 'Reverse selected pages' : 'Reverse order', onselect: reverse, disabled: count < 2 },
		{ label: 'Select all', icon: 'select', onselect: selectAll }
	]);

	const undoTip = $derived(doc.state.undoLabel ? `Undo: ${doc.state.undoLabel}` : 'Undo');
	const redoTip = $derived(doc.state.redoLabel ? `Redo: ${doc.state.redoLabel}` : 'Redo');
</script>

<svelte:window {onkeydown} {onpaste} {onbeforeunload} {ondragenter} {ondragover} {ondragleave} {ondrop} />

<svelte:head>
	<title>{hasPages ? `${plural(count, 'page')} · PDF Workspace` : 'PDF Workspace · pdf.garrettholmes.com'}</title>
</svelte:head>

{#if hasPages}
	<TopBarActions>
		<div class="history">
			<IconButton icon="undo" label={undoTip} shortcut="{mod}+Z" tooltip="bottom" disabled={!doc.state.canUndo} onclick={undo} />
			<IconButton
				icon="redo"
				label={redoTip}
				shortcut="{mod}+Shift+Z"
				tooltip="bottom"
				disabled={!doc.state.canRedo}
				onclick={redo}
			/>
		</div>
		{#if !narrow}
			<span class="count num" aria-hidden="true">{plural(count, 'page')}</span>
			<Button variant="secondary" icon="add" onclick={pickFiles}>Add files</Button>
		{/if}
		<Menu label="More actions" items={menuItems} />
		<Button variant="primary" icon="download" onclick={exportAll}>Export</Button>
	</TopBarActions>
{/if}

{#if hasPages}
	<!-- The empty state has its own picker; this one is for "Add files". -->
	<input
		bind:this={fileInput}
		class="visually-hidden"
		type="file"
		multiple
		accept={ACCEPT}
		tabindex="-1"
		aria-hidden="true"
		onchange={onFileInput}
	/>
{/if}

<div class="workspace" inert={!!editorId}>
	{#if hasPages}
		<SaveLine saved={saved.saving} line={saved.line} onopen={() => (saveOpen = true)} />
		<PageGrid
			bind:this={grid}
			{pages}
			sources={doc.state.sources}
			assets={doc.state.assets}
			{selection}
			{renderer}
			formValues={doc.state.formValues}
			{selectionMode}
			{thumb}
			{focusedId}
			bottomInset={showDock ? 64 : showFloat ? 80 : 0}
			{onselect}
			onclearselection={clearSelection}
			onopen={openEditor}
			{onlongpress}
			{onlongpressdragend}
			{onmove}
			{onaction}
			onfocuschange={(id) => (focusedId = id)}
			{ongridkey}
			announce={say}
		/>
	{:else}
		<EmptyDesk onfiles={addFiles} accept={ACCEPT}>
			{#snippet top()}
				{#if saved.offer}
					<RestoreCard offer={saved.offer} restoring={saved.restoring} onrestore={restoreSaved} ondiscard={discardSaved} />
				{/if}
			{/snippet}
		</EmptyDesk>
	{/if}

	{#if showFloat}
		<ActionBar label="Selected pages" mode="float">
			{#snippet status()}<span class="num">{selCount} selected</span>{/snippet}
			<IconButton icon="rotate-left" label="Rotate left" shortcut="Shift+R" onclick={() => rotate(-90)} />
			<IconButton icon="rotate-right" label="Rotate right" shortcut="R" onclick={() => rotate(90)} />
			<IconButton icon="duplicate" label="Duplicate" shortcut="{mod}+D" onclick={() => duplicate()} />
			<IconButton icon="trash" label="Delete" shortcut="Delete" onclick={() => remove()} />
			<span class="sep" aria-hidden="true"></span>
			<Button variant="quiet" icon="extract" onclick={() => extract()}>Export selected</Button>
			<Menu label="More for selected pages" items={selectionMenu} />
			<IconButton icon="close" label="Clear selection" shortcut="Esc" onclick={clearSelection} />
		</ActionBar>
	{/if}

	{#if showDock}
		<ActionBar label={selectionMode ? 'Selected pages' : 'Pages'} mode="dock">
			{#snippet status()}
				{#if selectionMode}<span class="num">{selCount ? `${selCount} selected` : 'Tap pages'}</span>{/if}
			{/snippet}
			{#if selectionMode}
				<IconButton icon="rotate-right" label="Rotate right" disabled={!selCount} onclick={() => rotate(90)} />
				<IconButton icon="duplicate" label="Duplicate" disabled={!selCount} onclick={() => duplicate()} />
				<IconButton icon="trash" label="Delete" disabled={!selCount} onclick={() => remove()} />
				<Menu label="More for selected pages" items={selectionMenu} />
				<Button variant="quiet" onclick={clearSelection}>Done</Button>
			{:else}
				<Button variant="quiet" icon="add" onclick={pickFiles}>Add files</Button>
				<Button variant="quiet" icon="select" onclick={() => (selectionMode = true)}>Select</Button>
			{/if}
		</ActionBar>
	{/if}

	{#if hasPages && !narrow}
		<div class="size" class:lifted={showFloat}>
			<Slider
				label="Thumbnail size"
				hideLabel
				min={112}
				max={320}
				step={8}
				bind:value={thumb}
				valueText={(v) => `${v} pixels`}
				oninput={saveThumb}
			>
				{#snippet before()}<Icon name="image" size={14} />{/snippet}
				{#snippet after()}<Icon name="image" size={20} />{/snippet}
			</Slider>
		</div>
	{/if}

	<IntakePanel {intake} raised={showDock} />
</div>

{#if fileDrag}
	<div class="drop-veil" aria-hidden="true">
		<p>{dropHint}</p>
	</div>
{/if}

{#if editorId && Editor}
	<div class="editor-layer">
		<svelte:boundary onerror={editorFailed}>
			<Editor pageId={editorId} onclose={closeEditor} />
			{#snippet failed()}{/snippet}
		</svelte:boundary>
	</div>
{/if}

<PasswordDialog ask={pwAsk} onanswer={answerPassword} />
<ExportDialog
	bind:open={exportOpen}
	mode={exportMode}
	ids={exportIds}
	{store}
	{engine}
	onclose={() => undefined}
	onsaved={({ mode }) => {
		if (mode === 'all') store.markClean();
	}}
/>
<ShortcutSheet bind:open={shortcutsOpen} />
<SaveDialog
	bind:open={saveOpen}
	keep={saved.keep}
	line={saved.line}
	canForget={saved.state !== 'off'}
	onkeep={(on) => void setKeep(on)}
	onforget={() => void forgetWork()}
/>

<div class="visually-hidden" aria-live="polite" aria-atomic="true">{live}</div>

<style>
	.workspace {
		min-height: calc(100dvh - var(--bar-h) - var(--safe-top));
	}

	.history {
		display: flex;
		gap: 2px;
		margin-right: auto;
		padding-left: var(--s-3);
	}

	.count {
		margin-right: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
		white-space: nowrap;
	}

	.sep {
		width: 1px;
		height: 24px;
		margin: 0 var(--s-1);
		background: var(--line);
	}

	.size {
		position: fixed;
		z-index: 25;
		right: calc(var(--s-5) + var(--safe-right));
		bottom: calc(var(--s-5) + var(--safe-bottom));
		width: 212px;
		padding: 0 var(--s-3);
		border: 1px solid var(--line);
		border-radius: 999px;
		background: color-mix(in srgb, var(--surface) 92%, transparent);
		backdrop-filter: blur(6px);
		box-shadow: var(--shadow-float);
	}

	@media (max-width: 1100px) {
		.size.lifted {
			bottom: calc(var(--s-5) + 64px + var(--safe-bottom));
		}
	}

	.drop-veil {
		position: fixed;
		inset: 0;
		z-index: 90;
		display: grid;
		place-items: end center;
		padding-bottom: calc(var(--s-7) + var(--safe-bottom));
		background: color-mix(in srgb, var(--desk-deep) 55%, transparent);
		pointer-events: none;
	}

	.drop-veil::before {
		content: '';
		position: absolute;
		inset: var(--s-3);
		border: 2px dashed var(--accent);
		border-radius: var(--radius-sheet);
	}

	.drop-veil p {
		padding: var(--s-2) var(--s-4);
		border-radius: 999px;
		background: var(--ink);
		color: var(--surface);
		font-weight: 550;
		box-shadow: var(--shadow-float);
	}

	.editor-layer {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: var(--desk);
		overflow: auto;
	}

	@media (max-width: 599px) {
		.history {
			padding-left: 0;
		}
	}
</style>
