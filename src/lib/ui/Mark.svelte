<script lang="ts">
	/** The product mark: two sheets, the front one with a red corner fold. Same drawing as static/favicon.svg. */
	let { size = 24 }: { size?: number } = $props();
</script>

<svg class="mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
	<rect
		class="back"
		x="5.5" y="6" width="15" height="22.5" rx="1" transform="rotate(-11 13 17.25)"/>
	<path class="front" d="M12 4.5h8l6.5 6.5v16a1 1 0 0 1-1 1H12a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1z" />
	<path class="fold" d="M20 4.5V10a1 1 0 0 0 1 1h5.5z" />
</svg>

<style>
	.mark {
		flex: none;
	}

	path,
	rect {
		stroke: var(--mark-stroke);
		stroke-width: 1.5;
		stroke-linejoin: round;
	}

	.back {
		fill: var(--mark-back);
	}

	.front {
		fill: var(--sheet);
	}

	.fold {
		fill: var(--accent);
	}
</style>
