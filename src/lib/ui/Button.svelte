<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { HTMLButtonAttributes } from 'svelte/elements';
	import Icon from './Icon.svelte';
	import Spinner from './Spinner.svelte';
	import type { IconName } from './icons';

	interface Props extends Omit<HTMLButtonAttributes, 'children'> {
		/** primary: the one red action on screen. secondary: outlined. quiet: text only. danger: delete confirmation. */
		variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
		size?: 'md' | 'lg';
		/** Leading icon, by name or as a snippet. */
		icon?: IconName | Snippet;
		/** Shows a spinner, keeps focus, ignores clicks. */
		loading?: boolean;
		/** Render as a link instead of a button. */
		href?: string;
		children: Snippet;
	}

	let {
		variant = 'secondary',
		size = 'md',
		icon,
		loading = false,
		href,
		type = 'button',
		disabled,
		onclick,
		class: className = '',
		children,
		...rest
	}: Props = $props();

	function handleClick(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
		if (loading) {
			e.preventDefault();
			return;
		}
		onclick?.(e);
	}
</script>

{#snippet inner()}
	{#if loading}
		<Spinner size={18} />
	{:else if typeof icon === 'string'}
		<Icon name={icon} />
	{:else if icon}
		{@render icon()}
	{/if}
	<span class="label">{@render children()}</span>
{/snippet}

{#if href}
	<a {href} class="btn {variant} {size} {className}">{@render inner()}</a>
{:else}
	<button
		{...rest}
		{type}
		{disabled}
		class="btn {variant} {size} {className}"
		aria-busy={loading || undefined}
		aria-disabled={loading || undefined}
		onclick={handleClick}
	>
		{@render inner()}
	</button>
{/if}

<style>
	.btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-2);
		min-height: var(--control-h);
		padding: 0 var(--s-4);
		border-radius: var(--radius-control);
		border: 1px solid transparent;
		font-size: var(--text-control);
		font-weight: 550;
		line-height: 1;
		white-space: nowrap;
		text-decoration: none;
		user-select: none;
		transition:
			background-color var(--dur-fast) var(--ease),
			border-color var(--dur-fast) var(--ease),
			color var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease);
	}

	.btn:has(:global(.icon), :global(.spinner)) {
		padding-left: calc(var(--s-4) - 3px);
	}

	.lg {
		min-height: max(44px, var(--control-h));
		padding: 0 var(--s-5);
		font-size: var(--text-base);
	}

	.btn:active:not(:disabled) {
		transform: translateY(0.5px);
	}

	.primary {
		background: var(--accent);
		color: var(--accent-ink);
	}

	.primary:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	.secondary {
		background: var(--surface);
		color: var(--ink);
		border-color: var(--line-strong);
	}

	.secondary:hover:not(:disabled) {
		background: color-mix(in srgb, var(--surface) 100%, var(--ink) 4%);
		border-color: var(--ink-soft);
	}

	.quiet {
		color: var(--ink);
	}

	.quiet:hover:not(:disabled) {
		background: var(--hover);
	}

	.quiet:active:not(:disabled) {
		background: var(--press);
	}

	.danger {
		background: var(--danger);
		color: var(--accent-ink);
	}

	.danger:hover:not(:disabled) {
		background: color-mix(in srgb, var(--danger) 86%, var(--ink));
	}

	.btn:disabled {
		opacity: 0.45;
	}

	.btn[aria-busy='true'] {
		cursor: progress;
	}

	.label {
		display: inline-block;
	}
</style>
