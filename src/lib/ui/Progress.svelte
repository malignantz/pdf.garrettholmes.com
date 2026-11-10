<script lang="ts">
	interface Props {
		/** 0..1, or undefined for indeterminate. */
		value?: number;
		label: string;
		/** Show the label and percentage above the bar. */
		showLabel?: boolean;
	}

	let { value, label, showLabel = false }: Props = $props();
	const pct = $derived(value === undefined ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100));
</script>

<div class="progress">
	{#if showLabel}
		<div class="meta">
			<span>{label}</span>
			{#if pct !== undefined}<span class="num">{pct}%</span>{/if}
		</div>
	{/if}
	<div
		class="track"
		role="progressbar"
		aria-label={label}
		aria-valuemin={pct === undefined ? undefined : 0}
		aria-valuemax={pct === undefined ? undefined : 100}
		aria-valuenow={pct}
	>
		<div
			class="bar"
			class:indeterminate={pct === undefined}
			data-essential-motion={pct === undefined ? '' : undefined}
			style:width={pct === undefined ? undefined : `${pct}%`}
		></div>
	</div>
</div>

<style>
	.progress {
		display: grid;
		gap: var(--s-1);
		min-width: 120px;
	}

	.meta {
		display: flex;
		justify-content: space-between;
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.track {
		height: 4px;
		border-radius: 2px;
		background: var(--line);
		overflow: hidden;
	}

	.bar {
		height: 100%;
		background: var(--ink);
		border-radius: inherit;
		transition: width var(--dur) var(--ease);
	}

	.indeterminate {
		width: 35%;
		animation: slide 1.2s var(--ease) infinite;
	}

	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(290%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.indeterminate {
			animation-duration: 3s;
		}
	}
</style>
