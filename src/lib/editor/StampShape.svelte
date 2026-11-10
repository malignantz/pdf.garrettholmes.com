<script lang="ts">
	// One stamp, absolutely positioned inside a layer that covers the displayed page
	// and has `container-type: size`. Draws exactly what the engine exports.
	import type { Snippet } from 'svelte';
	import type { HTMLAttributes } from 'svelte/elements';
	import type { Asset, Stamp } from '../core/types';
	import { acquireAssetUrl, markSvg, releaseAssetUrl, stampStyle } from './stamp-view';

	interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
		stamp: Stamp;
		/** The stamp's asset, for image stamps. */
		asset?: Asset;
		/** Displayed page width / height. */
		aspect: number;
		children?: Snippet;
		el?: HTMLDivElement;
	}

	let { stamp, asset, aspect, children, el = $bindable(), class: className = '', style = '', ...rest }: Props = $props();

	let url = $state<string | null>(null);
	$effect(() => {
		if (!asset) {
			url = null;
			return;
		}
		const id = asset.id;
		url = acquireAssetUrl(asset);
		return () => releaseAssetUrl(id);
	});

	const mark = $derived(stamp.kind === 'mark' ? markSvg(stamp.mark, stamp.box.w * aspect, stamp.box.h) : null);
</script>

<div bind:this={el} class="stamp {stamp.kind} {className}" style="{stampStyle(stamp)};{style}" {...rest}>
	{#if stamp.kind === 'image'}
		{#if url}<img src={url} alt="" draggable="false" />{/if}
	{:else if stamp.kind === 'mark' && mark}
		<svg viewBox={mark.viewBox} preserveAspectRatio="none" aria-hidden="true" focusable="false">
			{#if mark.circle}
				<circle cx={mark.circle.cx} cy={mark.circle.cy} r={mark.circle.r} fill="#000" />
			{:else}
				<path
					d={mark.d}
					fill="none"
					stroke="#000"
					stroke-width={mark.strokeWidth}
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			{/if}
		</svg>
	{:else if stamp.kind === 'text'}
		<span class="txt">{stamp.text}</span>
	{/if}
	{@render children?.()}
</div>

<style>
	.stamp {
		position: absolute;
		box-sizing: border-box;
	}

	img,
	svg {
		position: absolute;
		inset: 0;
		display: block;
		width: 100%;
		height: 100%;
		overflow: visible;
		user-select: none;
		-webkit-user-drag: none;
		pointer-events: none;
	}

	.text {
		/* Same rules the engine uses: bundled font, 1.2 line height, no kerning or ligatures. */
		font-family: PdfStampNotoSans, 'Noto Sans', sans-serif;
		font-weight: 400;
		font-style: normal;
		line-height: 1.2;
		white-space: pre;
		font-kerning: none;
		font-variant-ligatures: none;
		font-feature-settings:
			'kern' 0,
			'liga' 0,
			'clig' 0,
			'calt' 0;
		font-synthesis: none;
		letter-spacing: 0;
		word-spacing: 0;
		text-transform: none;
		text-align: left;
		min-width: 0.3em;
		min-height: 1.2em;
	}

	.txt {
		pointer-events: none;
	}
</style>
