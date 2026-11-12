<script lang="ts">
	import Icon from '../ui/Icon.svelte';

	/** One quiet line above the pages: saved on this device, or why not. */
	interface Props {
		saved: boolean;
		line: string;
		onopen: () => void;
	}

	let { saved, line, onopen }: Props = $props();
</script>

<p class="line" class:unsaved={!saved} data-testid="save-line">
	{#if saved}<Icon name="shield-check" size={16} />{/if}
	<span>{line}</span>
	<button type="button" class="more" onclick={onopen}>Settings</button>
</p>

<style>
	.line {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 2px 6px;
		padding: var(--s-3) calc(var(--s-5) + var(--safe-right)) 0 calc(var(--s-5) + var(--safe-left));
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.line :global(.icon) {
		color: var(--ok);
	}

	.more {
		padding: 2px 4px;
		margin: -2px 0;
		border-radius: var(--radius-control);
		color: var(--ink);
		text-decoration: underline;
		text-underline-offset: 2px;
		font-size: inherit;
	}

	.more:hover {
		background: var(--hover);
	}

	@media (max-width: 599px) {
		.line {
			padding: var(--s-2) calc(var(--s-3) + var(--safe-right)) 0 calc(var(--s-3) + var(--safe-left));
		}
	}
</style>
