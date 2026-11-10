<script lang="ts" module>
	import type { IconName } from './icons';

	export interface MenuItem {
		label: string;
		icon?: IconName;
		/** Shown right-aligned, e.g. "R" or "Ctrl+D". */
		hint?: string;
		danger?: boolean;
		disabled?: boolean;
		onselect: () => void;
	}
</script>

<script lang="ts">
	import Icon from './Icon.svelte';
	import Tooltip from './Tooltip.svelte';

	/**
	 * Popover menu on the native Popover API (top layer, light dismiss).
	 * Keyboard: Enter/Space/ArrowDown opens, arrows/Home/End move, Escape closes
	 * and returns focus to the trigger, Tab closes.
	 */
	interface Props {
		/** Accessible name of the trigger; also its tooltip when it is icon-only. */
		label: string;
		icon?: IconName;
		/** Show `label` as text next to the icon instead of a tooltip. */
		showLabel?: boolean;
		items: (MenuItem | 'separator')[];
		align?: 'start' | 'end';
	}

	let { label, icon = 'more', showLabel = false, items, align = 'end' }: Props = $props();

	const id = `menu-${Math.random().toString(36).slice(2, 9)}`;
	let trigger: HTMLButtonElement | undefined = $state();
	let menu: HTMLElement | undefined = $state();
	let open = $state(false);
	let pos = $state({ top: 0, left: 0 });

	function buttons(): HTMLButtonElement[] {
		return menu ? [...menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])')] : [];
	}

	function place() {
		if (!trigger || !menu) return;
		const t = trigger.getBoundingClientRect();
		const m = menu.getBoundingClientRect();
		const gap = 4;
		let top = t.bottom + gap;
		if (top + m.height > innerHeight - 8 && t.top - gap - m.height > 8) top = t.top - gap - m.height;
		let left = align === 'end' ? t.right - m.width : t.left;
		left = Math.max(8, Math.min(left, innerWidth - m.width - 8));
		pos = { top, left };
	}

	function show(focus: 'first' | 'last' = 'first') {
		if (!menu) return;
		if (!open) menu.showPopover();
		place();
		const list = buttons();
		(focus === 'first' ? list[0] : list[list.length - 1])?.focus();
	}

	function hide(returnFocus = true) {
		if (menu && open) menu.hidePopover();
		if (returnFocus) trigger?.focus();
	}

	function ontoggle(e: ToggleEvent) {
		open = e.newState === 'open';
	}

	function onTriggerKey(e: KeyboardEvent) {
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			show(e.key === 'ArrowDown' ? 'first' : 'last');
		}
	}

	function onTriggerClick() {
		if (open) hide();
		else show();
	}

	function onMenuKey(e: KeyboardEvent) {
		const list = buttons();
		const i = list.indexOf(document.activeElement as HTMLButtonElement);
		if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			e.preventDefault();
			const d = e.key === 'ArrowDown' ? 1 : -1;
			list[(i + d + list.length) % list.length]?.focus();
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			(e.key === 'Home' ? list[0] : list[list.length - 1])?.focus();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			hide();
		} else if (e.key === 'Tab') {
			hide(false);
		} else if (e.key.length === 1 && /\S/.test(e.key)) {
			// Type-ahead: jump to the next item starting with that letter.
			const k = e.key.toLowerCase();
			const order = [...list.slice(i + 1), ...list.slice(0, i + 1)];
			order.find((b) => b.textContent?.trim().toLowerCase().startsWith(k))?.focus();
		}
	}

	function select(item: MenuItem) {
		hide();
		item.onselect();
	}
</script>

<svelte:window onresize={() => open && place()} />

{#snippet triggerButton(attrs: { 'aria-describedby'?: string })}
	<button
		{...attrs}
		bind:this={trigger}
		type="button"
		class="trigger"
		class:with-label={showLabel}
		aria-label={showLabel ? undefined : label}
		aria-haspopup="menu"
		aria-expanded={open}
		aria-controls={id}
		onclick={onTriggerClick}
		onkeydown={onTriggerKey}
	>
		<Icon name={icon} />
		{#if showLabel}<span>{label}</span>{/if}
	</button>
{/snippet}

{#if showLabel}
	{@render triggerButton({})}
{:else}
	<Tooltip text={label} describes={false} placement="bottom">
		{#snippet children(attrs)}{@render triggerButton(attrs)}{/snippet}
	</Tooltip>
{/if}

<div
	bind:this={menu}
	{id}
	popover="auto"
	role="menu"
	aria-label={label}
	tabindex="-1"
	class="menu"
	style:top="{pos.top}px"
	style:left="{pos.left}px"
	{ontoggle}
	onkeydown={onMenuKey}
>
	{#each items as item, i (i)}
		{#if item === 'separator'}
			<div class="sep" role="separator"></div>
		{:else}
			<button
				type="button"
				role="menuitem"
				class="item"
				class:danger={item.danger}
				disabled={item.disabled}
				tabindex="-1"
				onclick={() => select(item)}
			>
				{#if item.icon}<Icon name={item.icon} />{:else}<span class="icon-space"></span>{/if}
				<span class="text">{item.label}</span>
				{#if item.hint}<kbd>{item.hint}</kbd>{/if}
			</button>
		{/if}
	{/each}
</div>

<style>
	.trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-2);
		min-width: var(--control-h);
		height: var(--control-h);
		border-radius: var(--radius-control);
		color: var(--ink);
		font-size: var(--text-control);
		font-weight: 550;
		transition: background-color var(--dur-fast) var(--ease);
	}

	.with-label {
		padding: 0 var(--s-3) 0 calc(var(--s-3) - 2px);
	}

	.trigger:hover,
	.trigger[aria-expanded='true'] {
		background: var(--hover);
	}

	.menu {
		position: fixed;
		inset: auto;
		margin: 0;
		min-width: 200px;
		max-width: min(320px, calc(100vw - 16px));
		padding: var(--s-1);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		background: var(--surface);
		color: var(--ink);
		box-shadow: var(--shadow-float);
	}

	.menu:popover-open {
		transition:
			opacity var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease);
	}

	@starting-style {
		.menu:popover-open {
			opacity: 0;
			transform: translateY(-4px);
		}
	}

	.item {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		width: 100%;
		min-height: var(--control-h);
		padding: 0 var(--s-3) 0 var(--s-2);
		border-radius: var(--radius-control);
		font-size: var(--text-control);
		text-align: left;
		color: var(--ink);
	}

	.item:hover:not(:disabled),
	.item:focus-visible {
		background: var(--hover);
	}

	.item:focus-visible {
		outline-offset: -2px;
	}

	.item:disabled {
		opacity: 0.45;
	}

	.danger {
		color: var(--danger);
	}

	.icon-space {
		width: var(--icon);
		flex: none;
	}

	.text {
		flex: 1;
	}

	kbd {
		font-family: var(--font-sans);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.sep {
		height: 1px;
		margin: var(--s-1) var(--s-2);
		background: var(--line);
	}
</style>
