<script lang="ts">
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import Tooltip from './Tooltip.svelte';
	import type { IconName } from './icons';

	interface Props extends Omit<HTMLButtonAttributes, 'children' | 'aria-label'> {
		icon: IconName;
		/** Required: the accessible name, also shown as the tooltip. */
		label: string;
		/** Keyboard shortcut shown in the tooltip, e.g. "Ctrl+Z". */
		shortcut?: string;
		variant?: 'quiet' | 'secondary' | 'primary';
		tooltip?: 'top' | 'bottom' | false;
		/** Toggle buttons: pass true/false to expose aria-pressed. */
		pressed?: boolean;
	}

	let {
		icon,
		label,
		shortcut,
		variant = 'quiet',
		tooltip = 'top',
		pressed,
		type = 'button',
		class: className = '',
		...rest
	}: Props = $props();

	const tipText = $derived(shortcut ? `${label} (${shortcut})` : label);
</script>

{#snippet btn()}
	<button
		{...rest}
		{type}
		class="icon-btn {variant} {className}"
		aria-label={label}
		aria-pressed={pressed}
		aria-keyshortcuts={shortcut?.replace('Ctrl', 'Control').replace('Cmd', 'Meta')}
	>
		<Icon name={icon} />
	</button>
{/snippet}

{#if tooltip}
	<Tooltip text={tipText} placement={tooltip} describes={false}>
		{#snippet children()}{@render btn()}{/snippet}
	</Tooltip>
{:else}
	{@render btn()}
{/if}

<style>
	.icon-btn {
		display: inline-grid;
		place-items: center;
		width: var(--control-h);
		height: var(--control-h);
		border-radius: var(--radius-control);
		border: 1px solid transparent;
		color: var(--ink);
		transition:
			background-color var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease);
	}

	.quiet:hover:not(:disabled) {
		background: var(--hover);
	}

	.quiet:active:not(:disabled),
	.icon-btn[aria-pressed='true'] {
		background: var(--press);
	}

	.secondary {
		background: var(--surface);
		border-color: var(--line-strong);
	}

	.secondary:hover:not(:disabled) {
		border-color: var(--ink-soft);
	}

	.primary {
		background: var(--accent);
		color: var(--accent-ink);
	}

	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.icon-btn:disabled {
		opacity: 0.4;
	}
</style>
