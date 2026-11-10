<script lang="ts">
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';

	/**
	 * The empty state. The whole desk (the window) is the drop target while this
	 * is mounted; the button opens the system file picker.
	 */
	interface Props {
		onfiles: (files: File[]) => void;
		/** MIME types and extensions the picker offers. */
		accept?: string;
	}

	let { onfiles, accept = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/heic,image/*' }: Props =
		$props();

	let input: HTMLInputElement | undefined = $state();
	let dragging = $state(false);
	let depth = 0;

	function hasFiles(e: DragEvent) {
		return !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
	}

	function ondragenter(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		depth++;
		dragging = true;
	}

	function ondragover(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
	}

	function ondragleave(e: DragEvent) {
		if (!hasFiles(e)) return;
		depth = Math.max(0, depth - 1);
		if (depth === 0) dragging = false;
	}

	function ondrop(e: DragEvent) {
		if (!hasFiles(e)) return;
		e.preventDefault();
		depth = 0;
		dragging = false;
		const files = [...(e.dataTransfer?.files ?? [])];
		if (files.length) onfiles(files);
	}

	function onchange() {
		const files = [...(input?.files ?? [])];
		if (input) input.value = '';
		if (files.length) onfiles(files);
	}
</script>

<svelte:window {ondragenter} {ondragover} {ondragleave} {ondrop} />

<section class="desk" class:dragging aria-labelledby="empty-title">
	<div class="stage">
		<div class="sheets" aria-hidden="true">
			<div class="sheet s1"></div>
			<div class="sheet s2"></div>
			<div class="sheet s3">
				<span class="fold"></span>
				<span class="lines"><i></i><i></i><i></i><i></i><i></i></span>
			</div>
		</div>

		<h1 id="empty-title" class="headline">
			{#if dragging}
				Drop to add them
			{:else}
				<span class="pointer-fine">Drop PDFs or images here</span><span class="pointer-coarse"
					>Open PDFs or images</span
				>
			{/if}
		</h1>

		<div class="cta">
			<Button variant="primary" size="lg" icon="add" onclick={() => input?.click()}>Choose files</Button>
			<input
				bind:this={input}
				class="visually-hidden"
				type="file"
				multiple
				{accept}
				tabindex="-1"
				aria-hidden="true"
				{onchange}
			/>
		</div>

		<p class="proof">
			<Icon name="shield-check" size={18} />Files stay on this device. This page cannot send them anywhere.
			<a href="/privacy">How that is enforced</a>
		</p>
	</div>
</section>

<style>
	.desk {
		position: relative;
		display: grid;
		place-items: center;
		min-height: calc(100dvh - var(--bar-h) - var(--safe-top));
		padding: var(--s-6) calc(var(--s-4) + var(--safe-right)) calc(var(--s-7) + var(--safe-bottom))
			calc(var(--s-4) + var(--safe-left));
		transition: background-color var(--dur) var(--ease);
	}

	/* Drag-over: the whole desk becomes a well with a dashed edge. */
	.desk::after {
		content: '';
		position: absolute;
		inset: var(--s-3);
		border: 2px dashed transparent;
		border-radius: var(--radius-sheet);
		pointer-events: none;
		transition:
			border-color var(--dur) var(--ease),
			inset var(--dur) var(--ease);
	}

	.dragging {
		background: var(--desk-deep);
	}

	.dragging::after {
		border-color: var(--accent);
		inset: var(--s-4);
	}

	.stage {
		display: flex;
		flex-direction: column;
		align-items: center;
		text-align: center;
		max-width: 34rem;
		/* Optical centre sits a little above the geometric one. */
		margin-top: -4vh;
	}

	/* ---------- Sheets illustration ---------- */

	.sheets {
		--w: 116px;
		position: relative;
		width: calc(var(--w) * 1.9);
		height: calc(var(--w) * 1.414 + 12px);
		margin-bottom: var(--s-6);
	}

	.sheet {
		position: absolute;
		left: 50%;
		top: 6px;
		width: var(--w);
		aspect-ratio: 1 / 1.414;
		margin-left: calc(var(--w) / -2);
		background: var(--sheet);
		border-radius: var(--radius-page);
		box-shadow: var(--shadow-page);
		transition: transform var(--dur-slow) var(--ease);
	}

	/* Back sheets sit lower and slightly smaller, so their corners never peek over the front one. */
	.s1 {
		transform: translate(-36%, 8px) rotate(-9deg) scale(0.94);
		background: color-mix(in srgb, var(--sheet) 88%, var(--desk-deep));
	}

	.s2 {
		transform: translate(32%, 8px) rotate(7deg) scale(0.94);
		background: color-mix(in srgb, var(--sheet) 93%, var(--desk-deep));
	}

	.s3 {
		transform: translateY(-2px);
		overflow: hidden;
	}

	.dragging .s1 {
		transform: translate(-50%, 8px) rotate(-13deg) scale(0.94);
	}

	.dragging .s2 {
		transform: translate(46%, 8px) rotate(11deg) scale(0.94);
	}

	.dragging .s3 {
		transform: translateY(-10px);
	}

	.fold {
		position: absolute;
		top: 0;
		right: 0;
		width: 22%;
		aspect-ratio: 1;
		background: linear-gradient(225deg, var(--desk) 50%, var(--accent) 50%);
		border-bottom-left-radius: 2px;
	}

	.lines {
		position: absolute;
		left: 14%;
		right: 14%;
		top: 30%;
		display: grid;
		gap: 9%;
		height: 46%;
		align-content: start;
	}

	.lines i {
		display: block;
		height: 4px;
		border-radius: 2px;
		background: var(--sheet-line);
	}

	.lines i:nth-child(1) {
		width: 62%;
		height: 6px;
		background: color-mix(in srgb, var(--sheet-line) 70%, #b9ae95);
	}

	.lines i:nth-child(3) {
		width: 88%;
	}

	.lines i:nth-child(5) {
		width: 54%;
	}

	/* ---------- Copy ---------- */

	.headline {
		font-family: var(--font-serif);
		font-weight: 500;
		font-size: clamp(1.75rem, 1.2rem + 2.2vw, 2.625rem);
		line-height: 1.12;
		letter-spacing: -0.012em;
		color: var(--ink);
	}

	.pointer-coarse {
		display: none;
	}

	@media (hover: none) and (pointer: coarse) {
		.pointer-fine {
			display: none;
		}

		.pointer-coarse {
			display: inline;
		}
	}

	.cta {
		margin-top: var(--s-5);
	}

	.proof {
		margin-top: var(--s-5);
		max-width: 36rem;
		font-size: var(--text-caption);
		line-height: 1.6;
		color: var(--ink-soft);
		text-wrap: balance;
	}

	.proof :global(.icon) {
		display: inline-block;
		color: var(--ok);
		vertical-align: -4px;
		margin-right: 4px;
	}

	.proof a {
		color: var(--ink);
		white-space: nowrap;
	}

	@media (max-width: 599px) {
		.sheets {
			--w: 92px;
			margin-bottom: var(--s-5);
		}

		.stage {
			margin-top: -6vh;
		}
	}

	@media (min-width: 1200px) {
		.sheets {
			--w: 132px;
		}
	}
</style>
