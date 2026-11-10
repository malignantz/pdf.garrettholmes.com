<script lang="ts">
	interface Props {
		size?: number;
		/** Announced to screen readers; omit when the surrounding control already says it is busy. */
		label?: string;
	}

	let { size = 20, label }: Props = $props();
</script>

<svg
	class="spinner"
	data-essential-motion
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	role={label ? 'status' : undefined}
	aria-label={label}
	aria-hidden={label ? undefined : 'true'}
>
	<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-opacity="0.22" stroke-width="2" />
	<path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
</svg>

<style>
	.spinner {
		flex: none;
		display: inline-block;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(1turn);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation-duration: 2.4s;
		}
	}
</style>
