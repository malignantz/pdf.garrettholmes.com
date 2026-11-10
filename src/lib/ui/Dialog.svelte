<script lang="ts">
	import type { Snippet } from 'svelte';
	import IconButton from './IconButton.svelte';
	import { focusables, trapTab } from './focus';

	interface Props {
		open: boolean;
		title: string;
		/** One plain sentence under the title. */
		description?: string;
		/** 'dialog': centred, becomes a bottom sheet on phones. 'sheet': always a bottom sheet. */
		variant?: 'dialog' | 'sheet';
		/** Close when the backdrop is clicked. Escape always closes. */
		dismissable?: boolean;
		width?: string;
		onclose?: () => void;
		children: Snippet;
		/** Footer buttons, right-aligned (stacked full-width on phones). */
		actions?: Snippet;
	}

	let {
		open = $bindable(false),
		title,
		description,
		variant = 'dialog',
		dismissable = true,
		width = '440px',
		onclose,
		children,
		actions
	}: Props = $props();

	const uid = Math.random().toString(36).slice(2, 9);
	let dialog: HTMLDialogElement | undefined = $state();
	let returnTo: HTMLElement | null = null;

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) {
			returnTo = document.activeElement as HTMLElement | null;
			dialog.showModal();
			// Prefer an explicit [autofocus], else the first control after the close button.
			const target =
				dialog.querySelector<HTMLElement>('[autofocus]') ??
				focusables(dialog).find((el) => !el.closest('.head')) ??
				dialog;
			target.focus();
		} else if (!open && dialog.open) {
			dialog.close();
		}
	});

	function handleClose() {
		open = false;
		onclose?.();
		returnTo?.focus?.();
		returnTo = null;
	}

	function onclick(e: MouseEvent) {
		// A click on the <dialog> element itself (not its panel) is a backdrop click.
		if (dismissable && e.target === dialog) open = false;
	}

	function onkeydown(e: KeyboardEvent) {
		if (dialog) trapTab(e, dialog);
	}
</script>

<dialog
	bind:this={dialog}
	class={variant}
	style:--dialog-w={width}
	aria-labelledby="dlg-title-{uid}"
	aria-describedby={description ? `dlg-desc-${uid}` : undefined}
	onclose={handleClose}
	oncancel={() => (open = false)}
	{onclick}
	{onkeydown}
	tabindex="-1"
>
	<div class="panel">
		<header class="head">
			<h2 id="dlg-title-{uid}">{title}</h2>
			<IconButton icon="close" label="Close" tooltip={false} onclick={() => (open = false)} />
		</header>
		{#if description}<p class="desc" id="dlg-desc-{uid}">{description}</p>{/if}
		<div class="body">{@render children()}</div>
		{#if actions}<footer class="actions">{@render actions()}</footer>{/if}
	</div>
</dialog>

<style>
	dialog {
		margin: auto;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--ink);
		max-width: calc(100vw - 2 * var(--s-4));
		max-height: calc(100dvh - 2 * var(--s-6));
		width: var(--dialog-w);
		overflow: visible;
		outline: none;
	}

	dialog::backdrop {
		background: var(--scrim);
	}

	.panel {
		display: flex;
		flex-direction: column;
		max-height: inherit;
		background: var(--surface);
		border-radius: var(--radius-sheet);
		box-shadow: var(--shadow-float);
		overflow: hidden;
	}

	.head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--s-3);
		padding: var(--s-3) var(--s-3) 0 var(--s-5);
		min-height: 56px;
	}

	h2 {
		font-size: 1.125rem;
		font-weight: 600;
	}

	.desc {
		padding: 0 var(--s-5);
		color: var(--ink-soft);
		font-size: var(--text-control);
	}

	.body {
		padding: var(--s-4) var(--s-5) var(--s-5);
		overflow: auto;
		overscroll-behavior: contain;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: var(--s-2);
		padding: var(--s-3) var(--s-5) var(--s-5);
	}

	/* Open animation */
	dialog[open] .panel {
		transition:
			opacity var(--dur) var(--ease),
			transform var(--dur-slow) var(--ease);
	}

	@starting-style {
		dialog[open] .panel {
			opacity: 0;
			transform: translateY(6px) scale(0.985);
		}
	}

	/* Bottom sheet: always for .sheet, and for every dialog on phones */
	dialog.sheet {
		margin: auto 0 0;
		width: 100%;
		max-width: 100%;
		max-height: 92dvh;
	}

	dialog.sheet .panel {
		border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
		padding-bottom: var(--safe-bottom);
	}

	dialog.sheet .head::before {
		content: '';
		position: absolute;
		left: 50%;
		top: 6px;
		width: 36px;
		height: 4px;
		margin-left: -18px;
		border-radius: 2px;
		background: var(--line);
	}

	dialog.sheet .head {
		position: relative;
		padding-top: var(--s-4);
	}

	@starting-style {
		dialog.sheet[open] .panel {
			opacity: 1;
			transform: translateY(100%);
		}
	}

	@media (max-width: 599px) {
		dialog.dialog {
			margin: auto 0 0;
			width: 100%;
			max-width: 100%;
			max-height: 92dvh;
		}

		dialog.dialog .panel {
			border-radius: var(--radius-sheet) var(--radius-sheet) 0 0;
			padding-bottom: var(--safe-bottom);
		}

		@starting-style {
			dialog.dialog[open] .panel {
				opacity: 1;
				transform: translateY(100%);
			}
		}

		.actions {
			flex-direction: column-reverse;
		}

		.actions :global(.btn) {
			width: 100%;
		}
	}
</style>
