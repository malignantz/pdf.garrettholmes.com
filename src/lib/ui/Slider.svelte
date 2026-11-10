<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		label: string;
		/** Hide the visible label (it stays the accessible name). */
		hideLabel?: boolean;
		/** Spoken value, e.g. "4 columns". */
		valueText?: (v: number) => string;
		/** Decorations either side, e.g. small and large grid icons. */
		before?: Snippet;
		after?: Snippet;
		oninput?: (v: number) => void;
	}

	let {
		value = $bindable(50),
		min = 0,
		max = 100,
		step = 1,
		label,
		hideLabel = false,
		valueText,
		before,
		after,
		oninput
	}: Props = $props();

	const uid = Math.random().toString(36).slice(2, 9);
	const fill = $derived(((value - min) / (max - min)) * 100);
</script>

<div class="slider">
	<label for="sl-{uid}" class:visually-hidden={hideLabel}>{label}</label>
	<div class="row">
		{#if before}{@render before()}{/if}
		<input
			id="sl-{uid}"
			type="range"
			{min}
			{max}
			{step}
			bind:value
			aria-valuetext={valueText?.(value)}
			style:--fill="{fill}%"
			oninput={() => oninput?.(value)}
		/>
		{#if after}{@render after()}{/if}
	</div>
</div>

<style>
	.slider {
		display: grid;
		gap: var(--s-1);
	}

	label {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.row {
		display: flex;
		align-items: center;
		gap: var(--s-2);
		color: var(--ink-soft);
	}

	input {
		-webkit-appearance: none;
		appearance: none;
		flex: 1;
		min-width: 96px;
		height: var(--control-h);
		background: transparent;
		cursor: pointer;
	}

	input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 2px;
		background: linear-gradient(to right, var(--ink) var(--fill), var(--line-strong) var(--fill));
	}

	input::-moz-range-track {
		height: 4px;
		border-radius: 2px;
		background: var(--line-strong);
	}

	input::-moz-range-progress {
		height: 4px;
		border-radius: 2px;
		background: var(--ink);
	}

	input::-webkit-slider-thumb {
		-webkit-appearance: none;
		width: 18px;
		height: 18px;
		margin-top: -7px;
		border-radius: 50%;
		background: var(--surface);
		border: 1.5px solid var(--ink);
		box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
	}

	input::-moz-range-thumb {
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--surface);
		border: 1.5px solid var(--ink);
	}

	@media (pointer: coarse) {
		input::-webkit-slider-thumb {
			width: 24px;
			height: 24px;
			margin-top: -10px;
		}
	}

	input:focus-visible {
		outline: none;
	}

	input:focus-visible::-webkit-slider-thumb {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	input:focus-visible::-moz-range-thumb {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
