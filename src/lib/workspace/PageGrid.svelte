<script lang="ts">
	import type { Asset, PageId, PageRef, Renderer, Source, SourceId } from '../core/types';
	import PageTile from './PageTile.svelte';
	import { dropSlot, indicatorFor, isNoopMove, sourceBoundaries, type Rect } from './logic';

	/**
	 * The page grid and every pointer interaction on it: click selection, touch
	 * long-press, drag and drop with auto-scroll, roving focus with arrow keys.
	 * Commands go back to the workspace through callbacks.
	 */
	interface Props {
		pages: readonly PageRef[];
		sources: readonly Source[];
		assets: readonly Asset[];
		selection: ReadonlySet<PageId>;
		renderer: Renderer;
		selectionMode: boolean;
		/** Thumbnail column width in px (desktop). */
		thumb: number;
		focusedId: PageId | null;
		/** Bottom inset (px) that the auto-scroll zone should keep clear of. */
		bottomInset?: number;
		onselect: (id: PageId, mods: { toggle: boolean; range: boolean }) => void;
		onclearselection: () => void;
		onopen: (id: PageId) => void;
		/** A long-press on touch: enter selection mode with this page. */
		onlongpress: (id: PageId) => void;
		onmove: (ids: PageId[], slot: number) => void;
		onaction: (action: 'rotate-left' | 'rotate-right' | 'delete', id: PageId) => void;
		onfocuschange: (id: PageId) => void;
		ongridkey: (e: KeyboardEvent, id: PageId, columns: number) => void;
		/** Live-region announcements. */
		announce: (msg: string) => void;
	}

	let {
		pages,
		sources,
		assets,
		selection,
		renderer,
		selectionMode,
		thumb,
		focusedId,
		bottomInset = 0,
		onselect,
		onclearselection,
		onopen,
		onlongpress,
		onmove,
		onaction,
		onfocuschange,
		ongridkey,
		announce
	}: Props = $props();

	let grid: HTMLDivElement | undefined = $state();

	const byId = $derived(new Map<SourceId, Source>(sources.map((s) => [s.id, s])));
	const boundaries = $derived(sourceBoundaries(pages));
	const multiSource = $derived(sources.length > 1);

	// ------------------------------------------------------------ drag state

	interface Press {
		id: PageId;
		pointerId: number;
		type: string;
		x: number;
		y: number;
		/** Touch: long-press fired, the finger now owns the page. */
		armed: boolean;
		timer?: ReturnType<typeof setTimeout>;
	}

	interface Drag {
		ids: PageId[];
		set: Set<PageId>;
		gap: number;
		x: number;
		y: number;
		slot: number;
		/** Thumbnail of the first dragged page, copied at lift. */
		preview: string | null;
		previewAspect: number;
	}

	let press: Press | null = null;
	let drag = $state.raw<Drag | null>(null);
	/** Tile rectangles relative to the grid, measured once at lift (the layout does not change mid-drag). */
	let rects: Rect[] = [];
	let suppressClick = false;
	let lastPointerType = 'mouse';
	let scrollRaf = 0;

	const LONG_PRESS_MS = 420;
	const MOUSE_SLOP = 6;
	const TOUCH_SLOP = 10;

	function cellOf(target: EventTarget | null): HTMLElement | null {
		return (target as HTMLElement | null)?.closest?.('[data-id]') ?? null;
	}

	function onpointerdown(e: PointerEvent) {
		lastPointerType = e.pointerType;
		if (drag) return;
		const target = e.target as HTMLElement;
		if (target.closest('[data-action]')) return;
		const cell = cellOf(target);
		if (!cell || !e.isPrimary) return;
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const id = cell.dataset.id!;
		press = { id, pointerId: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, armed: false };
		if (e.pointerType !== 'mouse') {
			const p = press;
			p.timer = setTimeout(() => {
				if (press !== p) return;
				p.armed = true;
				suppressClick = true;
				navigator.vibrate?.(8);
				onlongpress(p.id);
			}, LONG_PRESS_MS);
		}
	}

	function onpointermove(e: PointerEvent) {
		if (drag) {
			if (e.pointerId !== dragPointer) return;
			drag = { ...drag, x: e.clientX, y: e.clientY };
			updateSlot();
			return;
		}
		if (!press || e.pointerId !== press.pointerId) return;
		const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
		if (press.type === 'mouse') {
			if (dist > MOUSE_SLOP && e.buttons & 1) startDrag(e);
		} else if (!press.armed) {
			// Moving before the long-press fires is a scroll: let the browser have it.
			if (dist > TOUCH_SLOP) cancelPress();
		} else if (dist > TOUCH_SLOP) {
			startDrag(e);
		}
	}

	function onpointerup(e: PointerEvent) {
		if (drag && e.pointerId === dragPointer) {
			finishDrag(true);
			return;
		}
		if (press && e.pointerId === press.pointerId) {
			if (press.armed) setTimeout(() => (suppressClick = false), 0);
			cancelPress();
		}
	}

	function onpointercancel(e: PointerEvent) {
		if (drag && e.pointerId === dragPointer) finishDrag(false);
		else if (press && e.pointerId === press.pointerId) cancelPress();
	}

	function cancelPress() {
		if (press?.timer) clearTimeout(press.timer);
		press = null;
	}

	// Once a touch is armed, stop the page from scrolling under the finger.
	function ontouchmove(e: TouchEvent) {
		if ((press?.armed || drag) && e.cancelable) e.preventDefault();
	}

	function oncontextmenu(e: MouseEvent) {
		// Long-press on touch opens the browser's context menu; the press is ours.
		if (lastPointerType !== 'mouse' && cellOf(e.target)) e.preventDefault();
	}

	let dragPointer = -1;

	function startDrag(e: PointerEvent) {
		if (!press || !grid) return;
		const id = press.id;
		const moving = selection.has(id) ? pages.filter((p) => selection.has(p.id)).map((p) => p.id) : [id];
		if (!selection.has(id)) onselect(id, { toggle: false, range: false });
		const g = grid.getBoundingClientRect();
		rects = [];
		for (const el of grid.querySelectorAll<HTMLElement>(':scope > [data-id]')) {
			const r = el.getBoundingClientRect();
			rects.push({ left: r.left - g.left, top: r.top - g.top, width: r.width, height: r.height });
		}
		const style = getComputedStyle(grid);
		const gap = parseFloat(style.columnGap) || 16;
		const { url, aspect } = previewOf(id);
		dragPointer = press.pointerId;
		if (press.timer) clearTimeout(press.timer);
		press = null;
		try {
			grid.setPointerCapture(e.pointerId);
		} catch {
			// Pointer already gone.
		}
		drag = {
			ids: moving,
			set: new Set(moving),
			gap,
			x: e.clientX,
			y: e.clientY,
			slot: -1,
			preview: url,
			previewAspect: aspect
		};
		suppressClick = true;
		updateSlot();
		announce(`Moving ${moving.length === 1 ? '1 page' : `${moving.length} pages`}. Release to drop, Escape to cancel.`);
		scrollRaf = requestAnimationFrame(autoScroll);
	}

	function previewOf(id: PageId): { url: string | null; aspect: number } {
		const canvas = grid?.querySelector<HTMLCanvasElement>(`[data-id="${CSS.escape(id)}"] canvas`);
		if (!canvas || !canvas.width || !canvas.height) return { url: null, aspect: 1 / 1.3 };
		try {
			const w = 160;
			const h = Math.round((w * canvas.height) / canvas.width);
			const c = document.createElement('canvas');
			c.width = w;
			c.height = h;
			c.getContext('2d')?.drawImage(canvas, 0, 0, w, h);
			return { url: c.toDataURL('image/png'), aspect: canvas.width / canvas.height };
		} catch {
			return { url: null, aspect: canvas.width / canvas.height };
		}
	}

	function updateSlot() {
		if (!drag || !grid) return;
		const g = grid.getBoundingClientRect();
		const slot = dropSlot(rects, drag.x - g.left, drag.y - g.top);
		if (slot !== drag.slot) drag = { ...drag, slot };
	}

	function autoScroll() {
		if (!drag) return;
		const edge = 72;
		const top = 52 + edge;
		const bottom = innerHeight - bottomInset - edge;
		let v = 0;
		if (drag.y < top) v = -Math.pow(Math.min(1, (top - drag.y) / edge), 2) * 22;
		else if (drag.y > bottom) v = Math.pow(Math.min(1, (drag.y - bottom) / edge), 2) * 22;
		if (v) {
			scrollBy(0, v);
			updateSlot();
		}
		scrollRaf = requestAnimationFrame(autoScroll);
	}

	function finishDrag(commit: boolean) {
		if (!drag) return;
		cancelAnimationFrame(scrollRaf);
		const d = drag;
		drag = null;
		try {
			grid?.releasePointerCapture(dragPointer);
		} catch {
			// Fine.
		}
		dragPointer = -1;
		if (commit && d.slot >= 0 && !isNoopMove(pages, d.set, d.slot)) onmove(d.ids, d.slot);
		else announce(commit ? 'Pages stayed where they were.' : 'Move cancelled.');
		// The click that follows pointerup must not change the selection.
		setTimeout(() => (suppressClick = false), 0);
	}

	/** Escape while dragging. Returns true when it cancelled a drag. */
	export function cancelDrag(): boolean {
		if (!drag) return false;
		finishDrag(false);
		return true;
	}

	export function isDragging() {
		return drag !== null;
	}

	const indicator = $derived(drag && drag.slot >= 0 ? indicatorFor(rects, drag.slot, drag.gap) : null);
	const noop = $derived(drag ? isNoopMove(pages, drag.set, drag.slot) : true);

	// ------------------------------------------------------------ click / keys

	function onclick(e: MouseEvent) {
		const target = e.target as HTMLElement;
		const actionBtn = target.closest<HTMLElement>('[data-action]');
		const cell = cellOf(target);
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		if (!cell) {
			if (target === grid && lastPointerType === 'mouse') onclearselection();
			return;
		}
		const id = cell.dataset.id!;
		if (actionBtn) {
			onaction(actionBtn.dataset.action as 'rotate-left' | 'rotate-right' | 'delete', id);
			return;
		}
		const type = (e as PointerEvent).pointerType || lastPointerType;
		onfocuschange(id);
		if (type === 'touch' || type === 'pen') {
			if (selectionMode) onselect(id, { toggle: true, range: false });
			else onopen(id);
			return;
		}
		onselect(id, { toggle: e.ctrlKey || e.metaKey, range: e.shiftKey });
	}

	function ondblclick(e: MouseEvent) {
		if (lastPointerType !== 'mouse') return;
		const cell = cellOf(e.target);
		if (cell && !(e.target as HTMLElement).closest('[data-action]')) onopen(cell.dataset.id!);
	}

	function onkeydown(e: KeyboardEvent) {
		const cell = cellOf(e.target);
		if (!cell || (e.target as HTMLElement) !== cell) return;
		ongridkey(e, cell.dataset.id!, columns());
	}

	function onfocusin(e: FocusEvent) {
		const cell = cellOf(e.target);
		if (cell && cell.dataset.id !== focusedId) onfocuschange(cell.dataset.id!);
	}

	export function columns(): number {
		if (!grid) return 1;
		const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
		return Math.max(1, cols);
	}

	export function focusPage(id: PageId, scroll = true) {
		const el = grid?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
		if (!el) return;
		el.focus({ preventScroll: true });
		if (scroll) el.scrollIntoView({ block: 'nearest', behavior: 'auto' });
	}

	export function scrollToPage(id: PageId) {
		const el = grid?.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`);
		el?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
	}

	export function element() {
		return grid;
	}

	// Roving tabindex needs one tabbable tile even before anything was focused.
	const tabbable = $derived(focusedId && pages.some((p) => p.id === focusedId) ? focusedId : (pages[0]?.id ?? null));

	$effect(() => {
		if (!grid) return;
		const el = grid;
		el.addEventListener('touchmove', ontouchmove, { passive: false });
		return () => el.removeEventListener('touchmove', ontouchmove);
	});
</script>

<div
	bind:this={grid}
	class="grid"
	class:dragging={!!drag}
	style:--thumb="{thumb}px"
	role="listbox"
	tabindex="-1"
	aria-multiselectable="true"
	aria-label="Pages"
	aria-describedby="grid-help"
	{onpointerdown}
	{onpointermove}
	{onpointerup}
	{onpointercancel}
	{onclick}
	{ondblclick}
	{onkeydown}
	{onfocusin}
	{oncontextmenu}
>
	{#each pages as page, i (page.id)}
		<PageTile
			{page}
			number={i + 1}
			source={byId.get(page.sourceId)}
			{renderer}
			{assets}
			selected={selection.has(page.id)}
			focused={page.id === tabbable}
			boundary={multiSource && boundaries.has(page.id)}
			named={multiSource}
			lifted={!!drag && drag.set.has(page.id)}
			{selectionMode}
		/>
	{/each}

	{#if indicator && !noop}
		<div
			class="indicator"
			aria-hidden="true"
			style:left="{indicator.x}px"
			style:top="{indicator.top}px"
			style:height="{indicator.height}px"
		></div>
	{/if}
</div>
<p id="grid-help" class="visually-hidden">
	Arrow keys move between pages. Space selects, Enter opens a page, Alt with an arrow key moves the selected pages.
	Press question mark for all shortcuts.
</p>

{#if drag}
	<div class="drag-preview" aria-hidden="true" style:transform="translate({drag.x}px, {drag.y}px)">
		<div class="stack" class:many={drag.ids.length > 1} style:--a={drag.previewAspect}>
			{#if drag.ids.length > 1}<span class="under u2"></span><span class="under u1"></span>{/if}
			<span class="top">
				{#if drag.preview}<img src={drag.preview} alt="" />{/if}
			</span>
		</div>
		<span class="count num">{drag.ids.length}</span>
	</div>
{/if}

<style>
	.grid {
		position: relative;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(var(--thumb), 1fr));
		gap: var(--s-4) var(--s-3);
		align-content: start;
		padding: var(--s-5) calc(var(--s-5) + var(--safe-right)) calc(var(--s-7) * 2 + var(--safe-bottom))
			calc(var(--s-5) + var(--safe-left));
		min-height: calc(100dvh - var(--bar-h) - var(--safe-top));
		outline: none;
	}

	.dragging {
		cursor: grabbing;
	}

	.dragging :global(.cell) {
		cursor: grabbing;
	}

	@media (max-width: 599px) {
		.grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: var(--s-3) var(--s-2);
			padding: var(--s-3) calc(var(--s-3) + var(--safe-right)) calc(96px + var(--safe-bottom))
				calc(var(--s-3) + var(--safe-left));
		}
	}

	@media (max-width: 599px) and (orientation: landscape), (max-height: 499px) and (orientation: landscape) and (pointer: coarse) {
		.grid {
			grid-template-columns: repeat(3, minmax(0, 1fr));
		}
	}

	.indicator {
		position: absolute;
		z-index: 5;
		width: 3px;
		margin-left: -1.5px;
		border-radius: 2px;
		background: var(--accent);
		pointer-events: none;
		box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.indicator::before,
	.indicator::after {
		content: '';
		position: absolute;
		left: 50%;
		width: 9px;
		height: 9px;
		margin-left: -4.5px;
		border-radius: 50%;
		background: var(--accent);
	}

	.indicator::before {
		top: -4px;
	}

	.indicator::after {
		bottom: -4px;
	}

	.drag-preview {
		position: fixed;
		left: 0;
		top: 0;
		z-index: 70;
		pointer-events: none;
		/* Offset so the finger or cursor does not cover the preview. */
		margin: -28px 0 0 14px;
	}

	.stack {
		position: relative;
		width: 72px;
		aspect-ratio: var(--a);
		max-height: 104px;
	}

	.top,
	.under {
		position: absolute;
		inset: 0;
		background: var(--sheet);
		border-radius: var(--radius-page);
		box-shadow: var(--shadow-float);
		overflow: hidden;
	}

	.top {
		transform: rotate(-3deg);
	}

	.u1 {
		transform: translate(5px, 4px) rotate(2deg);
	}

	.u2 {
		transform: translate(9px, 8px) rotate(5deg);
	}

	.top img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.count {
		position: absolute;
		top: -10px;
		right: -14px;
		min-width: 24px;
		height: 24px;
		padding: 0 7px;
		border-radius: 12px;
		background: var(--accent);
		color: var(--accent-ink);
		font-size: var(--text-caption);
		font-weight: 650;
		line-height: 24px;
		text-align: center;
		box-shadow: 0 1px 3px rgb(0 0 0 / 0.25);
	}
</style>
