<script lang="ts">
	import { icons, type IconName } from './icons';

	interface Props {
		name: IconName;
		/** Pixel size; the stroke scales with it (1.5px at 20px). */
		size?: number;
		/** Accessible name. Omit for decorative icons next to visible text. */
		label?: string;
		class?: string;
	}

	let { name, size = 20, label, class: className = '' }: Props = $props();
</script>

<svg
	class="icon {className}"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="1.8"
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden={label ? undefined : 'true'}
	role={label ? 'img' : undefined}
	aria-label={label}
	focusable="false"
>
	{#each icons[name] as p, i (i)}
		{#if typeof p === 'string'}
			<path d={p} />
		{:else}
			<path d={p.d} stroke-width={p.width} />
		{/if}
	{/each}
</svg>

<style>
	.icon {
		flex: none;
		display: inline-block;
		vertical-align: middle;
	}
</style>
