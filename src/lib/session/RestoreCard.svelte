<script lang="ts">
	import { onMount } from 'svelte';
	import Button from '../ui/Button.svelte';
	import Icon from '../ui/Icon.svelte';
	import { describeSummary, type SessionSummary } from './format';

	/** The start page's quiet offer to restore the work saved on this device. */
	interface Props {
		offer: SessionSummary;
		restoring: boolean;
		onrestore: () => void;
		ondiscard: () => void;
	}

	let { offer, restoring, onrestore, ondiscard }: Props = $props();

	let now = $state(Date.now());
	onMount(() => {
		const t = setInterval(() => (now = Date.now()), 30_000);
		return () => clearInterval(t);
	});

	const line = $derived(describeSummary(offer, now));
</script>

<section class="card" aria-labelledby="resume-title">
	<div class="text">
		<h2 id="resume-title">Pick up where you left off?</h2>
		<p class="what num">{line}</p>
		<p class="where"><Icon name="shield-check" size={16} />Saved on this device only.</p>
	</div>
	<div class="buttons">
		<Button variant="quiet" disabled={restoring} onclick={ondiscard}>Discard</Button>
		<Button variant="secondary" loading={restoring} onclick={onrestore}>Restore</Button>
	</div>
</section>

<style>
	.card {
		display: flex;
		align-items: center;
		gap: var(--s-3) var(--s-5);
		width: 100%;
		max-width: 34rem;
		margin-bottom: var(--s-5);
		padding: var(--s-4) var(--s-4) var(--s-4) var(--s-5);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		background: var(--surface);
		text-align: left;
	}

	.text {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 2px;
	}

	h2 {
		font-size: var(--text-base);
		font-weight: 600;
		color: var(--ink);
	}

	.what {
		font-size: var(--text-control);
		color: var(--ink-soft);
	}

	.num {
		font-variant-numeric: tabular-nums;
	}

	.where {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		margin-top: 2px;
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.where :global(.icon) {
		color: var(--ok);
	}

	.buttons {
		display: flex;
		gap: var(--s-2);
		flex: none;
	}

	@media (max-width: 599px) {
		.card {
			flex-direction: column;
			align-items: stretch;
			margin-bottom: var(--s-4);
			padding: var(--s-4);
		}

		.buttons {
			justify-content: flex-end;
		}
	}
</style>
