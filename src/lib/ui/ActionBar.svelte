<script lang="ts">
	import type { Snippet } from 'svelte';
	import { focusables } from './focus';

	/**
	 * Contextual action bar. Floats bottom-centre on desktop; on phones it is a
	 * docked bottom bar in thumb reach that respects the home-indicator inset.
	 * Arrow keys move between its controls (toolbar pattern); Tab still works.
	 */
	interface Props {
		label: string;
		/** 'auto': float on wide screens, dock on phones. 'static': in normal flow (previews). */
		mode?: 'auto' | 'float' | 'dock' | 'static';
		/** Optional leading status, e.g. "3 selected". */
		status?: Snippet;
		children: Snippet;
	}

	let { label, mode = 'auto', status, children }: Props = $props();
	let el: HTMLElement | undefined = $state();

	function onkeydown(e: KeyboardEvent) {
		if (!el || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
		const target = e.target as HTMLElement;
		if (target.matches('input, textarea, select')) return;
		const list = focusables(el);
		const i = list.indexOf(document.activeElement as HTMLElement);
		if (i < 0) return;
		e.preventDefault();
		const next =
			e.key === 'Home'
				? 0
				: e.key === 'End'
					? list.length - 1
					: (i + (e.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length;
		list[next].focus();
	}
</script>

<div class="action-bar {mode}" role="toolbar" tabindex="-1" aria-label={label} bind:this={el} {onkeydown}>
	{#if status}<div class="status">{@render status()}</div>{/if}
	<div class="items">{@render children()}</div>
</div>

<style>
	.action-bar {
		position: fixed;
		z-index: 30;
		display: flex;
		align-items: center;
		gap: var(--s-2);
		background: var(--surface);
		color: var(--ink);
	}

	.items {
		display: flex;
		align-items: center;
		gap: var(--s-1);
	}

	.status {
		padding: 0 var(--s-2) 0 var(--s-1);
		font-size: var(--text-control);
		font-variant-numeric: tabular-nums;
		color: var(--ink-soft);
		white-space: nowrap;
	}

	.float,
	.auto {
		left: 50%;
		bottom: calc(var(--s-5) + var(--safe-bottom));
		transform: translateX(-50%);
		padding: var(--s-1) var(--s-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		box-shadow: var(--shadow-float);
	}

	.static {
		position: relative;
		display: inline-flex;
		padding: var(--s-1) var(--s-2);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		box-shadow: var(--shadow-float);
	}

	.dock {
		left: 0;
		right: 0;
		bottom: 0;
		justify-content: space-between;
		padding: var(--s-1) calc(var(--s-2) + var(--safe-right)) calc(var(--s-1) + var(--safe-bottom))
			calc(var(--s-2) + var(--safe-left));
		border-top: 1px solid var(--line);
	}

	.dock .items {
		flex: 1;
		justify-content: space-around;
	}

	@media (max-width: 599px) {
		.auto {
			left: 0;
			right: 0;
			bottom: 0;
			transform: none;
			justify-content: space-between;
			padding: var(--s-1) calc(var(--s-2) + var(--safe-right))
				calc(var(--s-1) + var(--safe-bottom)) calc(var(--s-2) + var(--safe-left));
			border: 0;
			border-top: 1px solid var(--line);
			border-radius: 0;
			box-shadow: none;
		}

		.auto .items {
			flex: 1;
			justify-content: space-around;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.action-bar {
			animation: rise var(--dur-slow) var(--ease);
		}

		@keyframes rise {
			from {
				opacity: 0;
				translate: 0 8px;
			}
		}
	}
</style>
