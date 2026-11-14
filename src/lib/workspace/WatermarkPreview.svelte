<script lang="ts">
	// A small sheet showing where the watermark will sit on the first exported page, laid
	// out by the engine's own rule (watermark.ts watermarkLayout) in the stamp font.
	import type { PageSize, Watermark } from '../core/types';
	import { WATERMARK_OPACITY, WATERMARK_RGB, watermarkLayout } from '../engine/watermark';
	import { STAMP_FAMILY, ensureStampFont } from '../editor/stamp-view';

	let { watermark, page }: { watermark: Watermark; page: PageSize } = $props();

	let fontReady = $state(false);
	$effect(() => {
		void ensureStampFont().then(() => (fontReady = true));
	});

	/** Advance width of the text at size 1, in the stamp font (an estimate until it loads). */
	const advance = $derived.by(() => {
		void fontReady;
		const text = watermark.text;
		try {
			const ctx = document.createElement('canvas').getContext('2d');
			if (ctx) {
				ctx.font = `100px "${STAMP_FAMILY}", sans-serif`;
				return ctx.measureText(text).width / 100;
			}
		} catch {
			// No canvas: estimate below.
		}
		return 0.62 * [...text].length;
	});
	const W = $derived(Math.max(1, page.width));
	const H = $derived(Math.max(1, page.height));
	const lay = $derived(watermarkLayout(W, H, advance, watermark.look));
	const deg = $derived((-lay.angle * 180) / Math.PI);
	const fill = $derived(`rgb(${WATERMARK_RGB[watermark.color].map((v) => Math.round(v * 255)).join(' ')})`);
	/** Grey bars standing in for the page's own lines of text. */
	const lines = $derived(Array.from({ length: 9 }, (_, i) => ({ y: H * (0.14 + i * 0.085), w: W * (i % 3 === 2 ? 0.5 : 0.76) })));
</script>

<figure class="wm-preview" aria-label={`Preview: "${watermark.text}" ${watermark.look === 'diagonal' ? 'diagonally' : 'straight'} across the page`}>
	<svg viewBox="0 0 {W} {H}" style:aspect-ratio="{W} / {H}" role="img" aria-hidden="true">
		<rect width={W} height={H} fill="#fff" />
		{#each lines as l, i (i)}
			<rect x={W * 0.12} y={l.y} width={l.w} height={H * 0.022} rx={H * 0.006} fill="#d9d4c8" />
		{/each}
		<text
			x={lay.cx}
			y={lay.cy}
			font-family={`${STAMP_FAMILY}, sans-serif`}
			font-size={lay.size}
			text-anchor="middle"
			dominant-baseline="central"
			fill={fill}
			fill-opacity={WATERMARK_OPACITY[watermark.strength]}
			transform="rotate({deg} {lay.cx} {lay.cy})">{watermark.text}</text
		>
	</svg>
</figure>

<style>
	.wm-preview {
		margin: 0;
		width: 96px;
		flex: none;
	}

	svg {
		display: block;
		width: 100%;
		height: auto;
		border-radius: var(--radius-page);
		box-shadow: var(--shadow-page);
	}
</style>
