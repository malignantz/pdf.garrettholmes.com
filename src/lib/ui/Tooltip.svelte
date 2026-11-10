<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		text: string;
		placement?: 'top' | 'bottom';
		/**
		 * True when the tooltip adds information beyond the trigger's own name:
		 * the trigger gets aria-describedby. False when it repeats the name
		 * (icon buttons), so screen readers do not hear it twice.
		 */
		describes?: boolean;
		/** Render the trigger; spread `attrs` on the focusable element. */
		children: Snippet<[{ 'aria-describedby'?: string }]>;
	}

	let { text, placement = 'top', describes = true, children }: Props = $props();

	const id = `tip-${Math.random().toString(36).slice(2, 9)}`;
	let open = $state(false);
	let shift = $state(0);
	let tip: HTMLElement | undefined = $state();
	let timer: ReturnType<typeof setTimeout> | undefined;

	function show(delay: number) {
		clearTimeout(timer);
		timer = setTimeout(() => {
			open = true;
			requestAnimationFrame(clamp);
		}, delay);
	}

	function hide() {
		clearTimeout(timer);
		open = false;
		shift = 0;
	}

	function clamp() {
		if (!tip) return;
		const r = tip.getBoundingClientRect();
		const margin = 8;
		if (r.left < margin) shift = margin - r.left;
		else if (r.right > innerWidth - margin) shift = innerWidth - margin - r.right;
	}

	function onpointerenter(e: PointerEvent) {
		if (e.pointerType === 'mouse') show(450);
	}

	function onfocusin(e: FocusEvent) {
		const t = e.target as HTMLElement;
		if (t.matches(':focus-visible')) show(0);
	}

	function onkeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && open) {
			hide();
			e.stopPropagation();
		}
	}
</script>

<span
	class="wrap"
	role="presentation"
	{onpointerenter}
	onpointerleave={hide}
	onpointerdown={hide}
	{onfocusin}
	onfocusout={hide}
	{onkeydown}
>
	{@render children(describes ? { 'aria-describedby': id } : {})}
	<span
		bind:this={tip}
		{id}
		role="tooltip"
		class="tip {placement}"
		class:open
		aria-hidden={describes ? undefined : 'true'}
		style:--shift="{shift}px">{text}</span
	>
</span>

<style>
	.wrap {
		position: relative;
		display: inline-flex;
	}

	.tip {
		position: absolute;
		left: 50%;
		z-index: 50;
		width: max-content;
		max-width: 240px;
		padding: 5px var(--s-2);
		border-radius: var(--radius-control);
		background: var(--ink);
		color: var(--surface);
		font-size: var(--text-caption);
		font-weight: 500;
		line-height: 1.35;
		pointer-events: none;
		opacity: 0;
		visibility: hidden;
		transform: translateX(calc(-50% + var(--shift, 0px))) translateY(var(--rise, 2px));
		transition:
			opacity var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease),
			visibility 0s linear var(--dur-fast);
	}

	.top {
		bottom: calc(100% + 6px);
	}

	.bottom {
		top: calc(100% + 6px);
		--rise: -2px;
	}

	.open {
		opacity: 1;
		visibility: visible;
		--rise: 0px;
		transition:
			opacity var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease);
	}
</style>
