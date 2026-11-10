<script lang="ts">
	import type { Asset, FormValue, PageRef, Renderer, Source } from '../core/types';
	import PageCanvas from '../render/PageCanvas.svelte';
	import StampLayer from '../editor/StampLayer.svelte';
	import Icon from '../ui/Icon.svelte';

	/**
	 * One page in the grid. Pure presentation: the grid handles every pointer
	 * and key event by delegation (data-id on the cell, data-action on buttons).
	 */
	interface Props {
		page: PageRef;
		number: number;
		source: Source | undefined;
		renderer: Renderer;
		assets: readonly Asset[];
		selected: boolean;
		focused: boolean;
		/** First page of a run from one file: show the file name. */
		boundary: boolean;
		/** Several files are open: reserve a line for file names. */
		named: boolean;
		/** Being dragged right now. */
		lifted: boolean;
		selectionMode: boolean;
		/** Form answers of this page's source (drawn into the thumbnail). */
		formValues?: Readonly<Record<string, FormValue>>;
		/** The page has form fields: show the "Form" chip. */
		hasFields?: boolean;
	}

	let {
		page,
		number,
		source,
		renderer,
		assets,
		selected,
		focused,
		boundary,
		named,
		lifted,
		selectionMode,
		formValues,
		hasFields = false
	}: Props = $props();

	/** The frame is a fixed portrait box; each page is fitted inside it. */
	const FRAME = 1 / 1.3;
	const size = $derived.by(() => {
		const s = source?.pages[page.pageIndex];
		if (!s) return { w: 1, h: 1.3 };
		return page.rotation % 180 === 0 ? { w: s.width, h: s.height } : { w: s.height, h: s.width };
	});
	const aspect = $derived(size.w / size.h);
	const fitWidth = $derived(aspect >= FRAME ? 100 : (aspect / FRAME) * 100);
	const name = $derived(source?.kind === 'blank' ? 'Blank page' : (source?.name ?? ''));
	const label = $derived(
		`Page ${number}` +
			(source?.kind === 'blank'
				? ', blank'
				: source
					? `, ${name}${source.pages.length > 1 ? ` page ${page.pageIndex + 1}` : ''}`
					: '') +
			(page.rotation ? `, rotated ${page.rotation}°` : '') +
			(page.stamps.length ? `, ${page.stamps.length} ${page.stamps.length === 1 ? 'mark' : 'marks'}` : '') +
			(hasFields ? ', has form fields' : '')
	);
</script>

<div
	class="cell"
	class:selected
	class:lifted
	class:boundary={boundary && number > 1}
	class:named
	data-id={page.id}
	role="option"
	aria-selected={selected}
	aria-label={label}
	tabindex={focused ? 0 : -1}
	title={source && source.kind !== 'blank' ? `${name}, page ${page.pageIndex + 1} of ${source.pages.length}` : undefined}
>
	<div class="frame">
		<div class="page" style:width="{fitWidth}%" style:aspect-ratio="{size.w} / {size.h}">
			{#if source}
				<svelte:boundary>
					<PageCanvas {source} pageIndex={page.pageIndex} rotation={page.rotation} {renderer} {formValues} />
					{#snippet failed()}
						<div class="broken">This page could not be shown.</div>
					{/snippet}
				</svelte:boundary>
				{#if page.stamps.length}
					<div class="stamps">
						<svelte:boundary>
							<StampLayer {page} {assets} />
							{#snippet failed()}{/snippet}
						</svelte:boundary>
					</div>
				{/if}
			{/if}
		</div>

		{#if hasFields}
			<span class="form-chip" aria-hidden="true" title="This page has form fields. Open it to fill them in." data-testid="form-chip">Form</span>
		{/if}

		{#if selected || selectionMode}
			<span class="tick" class:on={selected} aria-hidden="true">
				{#if selected}<Icon name="check" size={16} />{/if}
			</span>
		{/if}

		<div class="tools" aria-hidden="true">
			<button type="button" tabindex="-1" data-action="rotate-left" title="Rotate left (Shift+R)">
				<Icon name="rotate-left" size={18} />
			</button>
			<button type="button" tabindex="-1" data-action="rotate-right" title="Rotate right (R)">
				<Icon name="rotate-right" size={18} />
			</button>
			<button type="button" tabindex="-1" data-action="delete" title="Delete (Delete)">
				<Icon name="trash" size={18} />
			</button>
		</div>
	</div>

	<div class="caption">
		<span class="chip num">{number}</span>
		{#if named}<span class="src">{boundary ? name : ''}</span>{/if}
	</div>
</div>

<style>
	.cell {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
		border-radius: var(--radius-sheet);
		outline-offset: 2px;
		-webkit-touch-callout: none;
		user-select: none;
		-webkit-user-select: none;
		touch-action: manipulation;
		cursor: default;
		/* Off-screen tiles skip style, layout and paint; the grid sets the measured size. */
		content-visibility: auto;
		contain-intrinsic-size: auto var(--cell-w, 160px) auto var(--cell-h, 240px);
	}

	.frame {
		position: relative;
		display: grid;
		place-items: center;
		aspect-ratio: 1 / 1.3;
		padding: 8%;
		border-radius: var(--radius-sheet);
		transition: background-color var(--dur-fast) var(--ease);
	}

	.page {
		position: relative;
		max-height: 100%;
		background: var(--sheet);
		border-radius: var(--radius-page);
		box-shadow: var(--shadow-page);
		transition:
			box-shadow var(--dur-fast) var(--ease),
			opacity var(--dur) var(--ease),
			transform var(--dur) var(--ease);
	}

	.page :global(.sheet) {
		border-radius: var(--radius-page);
	}

	.stamps {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.broken {
		display: grid;
		place-items: center;
		aspect-ratio: inherit;
		padding: var(--s-2);
		font-size: var(--text-caption);
		color: #5b5342;
		text-align: center;
	}

	@media (hover: hover) {
		.cell:hover .frame {
			background: var(--hover);
		}
	}

	.selected .frame,
	.selected:hover .frame {
		background: color-mix(in srgb, var(--accent) 9%, transparent);
	}

	.selected .page {
		box-shadow:
			0 0 0 2px var(--accent),
			var(--shadow-page);
	}

	.cell:focus-visible {
		outline: 2px solid var(--accent);
	}

	.lifted .page {
		opacity: 0.3;
		transform: scale(0.96);
	}

	.tick {
		position: absolute;
		top: 6px;
		left: 6px;
		display: grid;
		place-items: center;
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 1.5px solid var(--line-strong);
		background: var(--surface);
		color: var(--accent-ink);
	}

	.tick.on {
		border-color: var(--accent);
		background: var(--accent);
	}

	.form-chip {
		position: absolute;
		right: 4px;
		bottom: 4px;
		padding: 1px 7px;
		border: 1px solid var(--line);
		border-radius: 999px;
		background: var(--surface);
		color: var(--ink-soft);
		font-size: 11px;
		line-height: 16px;
		pointer-events: none;
	}

	.tools {
		position: absolute;
		top: 6px;
		right: 6px;
		display: flex;
		gap: 2px;
		padding: 2px;
		border-radius: var(--radius-control);
		background: var(--surface);
		box-shadow: var(--shadow-float);
		opacity: 0;
		transform: translateY(-2px);
		pointer-events: none;
		transition:
			opacity var(--dur-fast) var(--ease),
			transform var(--dur-fast) var(--ease);
	}

	.tools button {
		display: grid;
		place-items: center;
		width: 30px;
		height: 30px;
		border-radius: 4px;
		color: var(--ink);
	}

	.tools button:hover {
		background: var(--hover);
	}

	.tools button[data-action='delete']:hover {
		color: var(--danger);
	}

	@media (hover: hover) and (pointer: fine) {
		.cell:hover .tools {
			opacity: 1;
			transform: none;
			pointer-events: auto;
		}
	}

	:global(.dragging) .tools {
		display: none;
	}

	.caption {
		display: grid;
		justify-items: center;
		min-width: 0;
		padding: 0 4px;
		line-height: 16px;
		color: var(--ink-soft);
	}

	.chip {
		flex: none;
		color: var(--ink);
	}

	.selected .chip {
		color: var(--accent);
	}

	.src {
		max-width: 100%;
		min-height: 16px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
	}

	/* A file boundary: a short hairline to the left of the frame marks where a new file starts. */
	.boundary .frame::before {
		content: '';
		position: absolute;
		left: -1px;
		top: 18%;
		bottom: 18%;
		width: 2px;
		border-radius: 1px;
		background: var(--line-strong);
	}

	@media (prefers-reduced-motion: reduce) {
		.lifted .page {
			transform: none;
		}
	}
</style>
