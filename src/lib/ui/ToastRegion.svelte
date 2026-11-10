<script lang="ts">
	import Icon from './Icon.svelte';
	import { toasts } from './toasts.svelte';

	/** Rendered once, in the root layout. */

	function runAction(id: number, run: () => void) {
		run();
		toasts.dismiss(id);
	}
</script>

<!-- Two live regions: polite for info, assertive for errors. -->
<section
	class="region"
	aria-label="Notifications"
	onpointerenter={toasts.pause}
	onpointerleave={toasts.resume}
	onfocusin={toasts.pause}
	onfocusout={toasts.resume}
>
	<div class="stack" aria-live="polite" aria-relevant="additions">
		{#each toasts.list.filter((t) => t.tone !== 'error') as t (t.id)}
			{@render toast(t)}
		{/each}
	</div>
	<div class="stack" role="alert" aria-relevant="additions">
		{#each toasts.list.filter((t) => t.tone === 'error') as t (t.id)}
			{@render toast(t)}
		{/each}
	</div>
</section>

{#snippet toast(t: (typeof toasts.list)[number])}
	<div class="toast {t.tone}">
		{#if t.tone === 'ok'}<Icon name="check" />{:else if t.tone === 'error'}<Icon name="warning" />{/if}
		<p class="msg">{t.message}</p>
		{#if t.action}
			{@const action = t.action}
			<button type="button" class="action" onclick={() => runAction(t.id, action.run)}>{action.label}</button>
		{/if}
		<button type="button" class="dismiss" aria-label="Dismiss" onclick={() => toasts.dismiss(t.id)}>
			<Icon name="close" size={18} />
		</button>
	</div>
{/snippet}

<style>
	.region {
		position: fixed;
		z-index: 60;
		left: 50%;
		bottom: calc(var(--s-5) + var(--safe-bottom) + var(--toast-offset, 0px));
		transform: translateX(-50%);
		width: min(440px, calc(100vw - 2 * var(--s-4)));
		pointer-events: none;
	}

	.stack {
		list-style: none;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--s-2);
	}

	.stack:not(:empty) + .stack:not(:empty) {
		margin-top: var(--s-2);
	}

	.toast {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: 48px;
		padding: var(--s-1) var(--s-1) var(--s-1) var(--s-4);
		border-radius: var(--radius-sheet);
		background: var(--ink);
		color: var(--surface);
		box-shadow: var(--shadow-float);
		font-size: var(--text-control);
	}

	.ok > :global(.icon) {
		color: color-mix(in srgb, var(--ok) 55%, var(--surface));
	}

	.error > :global(.icon) {
		color: color-mix(in srgb, var(--accent) 60%, var(--surface));
	}

	.msg {
		flex: 1;
		padding: var(--s-2) 0;
		line-height: 1.35;
	}

	.action,
	.dismiss {
		flex: none;
		min-height: 40px;
		border-radius: var(--radius-control);
		color: var(--surface);
		transition: background-color var(--dur-fast) var(--ease);
	}

	.action {
		padding: 0 var(--s-3);
		font-weight: 650;
		text-decoration: underline;
		text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
		text-underline-offset: 0.2em;
	}

	.dismiss {
		display: grid;
		place-items: center;
		width: 40px;
		opacity: 0.75;
	}

	.action:hover,
	.dismiss:hover {
		background: color-mix(in srgb, var(--surface) 14%, transparent);
		opacity: 1;
	}

	.action:focus-visible,
	.dismiss:focus-visible {
		outline-color: var(--surface);
		outline-offset: -2px;
	}

	@media (pointer: coarse) {
		.action,
		.dismiss {
			min-height: 48px;
		}

		.dismiss {
			width: 48px;
		}
	}

	@media (prefers-reduced-motion: no-preference) {
		.toast {
			animation: enter var(--dur-slow) var(--ease);
		}

		@keyframes enter {
			from {
				opacity: 0;
				translate: 0 8px;
			}
		}
	}
</style>
