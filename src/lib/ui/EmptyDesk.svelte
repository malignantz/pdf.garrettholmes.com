<script lang="ts">
	import type { Snippet } from 'svelte';
	import Button from './Button.svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	/**
	 * The empty state. The whole desk (the window) is the drop target while this
	 * is mounted; the button opens the system file picker.
	 */
	interface Props {
		onfiles: (files: File[]) => void;
		/** MIME types and extensions the picker offers. */
		accept?: string;
		/** Shown above the headline (the "pick up where you left off" card). */
		top?: Snippet;
	}

	let { onfiles, accept = 'application/pdf,.pdf,image/png,image/jpeg,image/webp,image/gif,image/heic,image/*', top }: Props =
		$props();

	const features: { icon: IconName; title: string; line: string }[] = [
		{ icon: 'duplicate', title: 'Combine and rearrange', line: 'Merge files, then reorder, rotate, crop or delete pages.' },
		{ icon: 'sign', title: 'Sign and fill in', line: 'Add your signature, type on the page, fill in form fields.' },
		{ icon: 'highlight', title: 'Mark up', line: 'Highlight, add check marks, dates, page numbers or a watermark such as DRAFT.' },
		{ icon: 'redact', title: 'Black out private details', line: 'Redaction that truly removes what is under the box.' },
		{ icon: 'shrink', title: 'Make it smaller', line: 'Shrink a file to fit an email limit.' },
		{ icon: 'lock', title: 'Lock, unlock, convert', line: 'Add or remove a password. Unlock files that block printing or copying. Turn photos into a PDF.' }
	];

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
		{#if top}{@render top()}{/if}
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
				Combine, sign and fix PDFs
			{/if}
		</h1>
		<p class="sub">Free, no account. Your files never leave this device.</p>

		<div class="cta">
			<Button variant="primary" size="lg" icon="add" onclick={() => input?.click()}>Choose files</Button>
			<span class="drop-hint">or drop them anywhere on this page</span>
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

		<h2 class="what">What you can do</h2>
		<ul class="features">
			{#each features as f (f.title)}
				<li>
					<Icon name={f.icon} size={22} />
					<span class="ftext"><strong>{f.title}</strong><span>{f.line}</span></span>
				</li>
			{/each}
		</ul>

		<p class="once">Add a file to start. Everything is in one place, and you download once at the end.</p>

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
		padding: var(--s-6) calc(var(--s-4) + var(--safe-right)) calc(var(--s-5) + var(--safe-bottom))
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
		width: 100%;
		max-width: 56rem;
		/* Optical centre sits a little above the geometric one. */
		margin-top: -2vh;
	}

	/* ---------- Sheets illustration ---------- */

	.sheets {
		--w: 84px;
		position: relative;
		width: calc(var(--w) * 1.9);
		height: calc(var(--w) * 1.414 + 12px);
		margin-bottom: var(--s-4);
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

	.sub {
		margin-top: var(--s-2);
		font-size: var(--text-base);
		color: var(--ink-soft);
	}

	.cta {
		margin-top: var(--s-4);
		display: flex;
		align-items: center;
		justify-content: center;
		gap: var(--s-3) var(--s-4);
		flex-wrap: wrap;
	}

	.drop-hint {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	@media (hover: none) and (pointer: coarse) {
		.drop-hint {
			display: none;
		}
	}

	.what {
		margin-top: var(--s-5);
		font-family: var(--font-sans);
		font-size: var(--text-chip);
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--ink-soft);
	}

	.features {
		list-style: none;
		margin: var(--s-3) 0 0;
		padding: var(--s-4) 0 0;
		border-top: 1px solid var(--line);
		width: 100%;
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: var(--s-4) var(--s-5);
		text-align: left;
	}

	.features li {
		display: flex;
		gap: var(--s-3);
		align-items: flex-start;
	}

	.features li > :global(.icon) {
		flex: none;
		margin-top: 2px;
		color: var(--accent);
	}

	.ftext {
		display: flex;
		flex-direction: column;
		gap: 2px;
		font-size: var(--text-caption);
		line-height: 1.45;
		color: var(--ink-soft);
	}

	.ftext strong {
		font-size: var(--text-control);
		font-weight: 600;
		color: var(--ink);
	}

	.once {
		margin-top: var(--s-4);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.proof {
		margin-top: var(--s-3);
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

	@media (max-width: 759px) {
		.features {
			grid-template-columns: 1fr;
			gap: var(--s-3);
			max-width: 26rem;
		}

		.what {
			margin-top: var(--s-5);
		}
	}

	@media (max-width: 599px) {
		.desk {
			place-items: start center;
			padding-top: var(--s-4);
		}

		.sheets {
			--w: 56px;
			margin-bottom: var(--s-3);
		}

		.stage {
			margin-top: 0;
		}

		.headline {
			font-size: 1.625rem;
		}
	}
</style>
