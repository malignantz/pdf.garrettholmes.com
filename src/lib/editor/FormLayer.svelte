<script lang="ts">
	// Real HTML controls laid exactly over the form widgets of one page in the editor.
	// The page bitmap draws the answers (PageCanvas gets the form values); a control
	// shows its own text only while it is focused, or while the bitmap has not caught
	// up with its answer yet, so text is never drawn twice. Checkboxes and radios are
	// see-through: the bitmap draws the tick.
	import type { FormField, FormValue, PageSize, Rotation } from '../core/types';
	import { controlFontPx, noZoomFont, pageWidgets, rotateBox, shownValue, type PlacedWidget } from './form-view';
	import type { StampBox } from '../core/types';

	interface Props {
		fields: readonly FormField[];
		/** 0-based index into the source's pages. */
		pageIndex: number;
		rotation: Rotation;
		/** The source page as displayed, in points (Source.pages[pageIndex]). */
		pagePt: PageSize;
		/** The page on screen (after rotation), in CSS px. */
		pagePx: PageSize;
		/** Answers of this source (the store's object). */
		values: Readonly<Record<string, FormValue>> | undefined;
		/** The answers the page bitmap was last drawn with. */
		drawn: Readonly<Record<string, FormValue>> | undefined;
		/** A stamp tool is armed: pointer events go to the tool. */
		passthrough: boolean;
		/** Prefix for radio group names, unique per editor. */
		group: string;
		onset: (field: FormField, value: FormValue) => void;
		onfocusfield: (box: StampBox) => void;
		onblurfield: () => void;
		onundo: () => void;
		onredo: () => void;
		onescape: () => void;
	}

	let {
		fields,
		pageIndex,
		rotation,
		pagePt,
		pagePx,
		values,
		drawn,
		passthrough,
		group,
		onset,
		onfocusfield,
		onblurfield,
		onundo,
		onredo,
		onescape
	}: Props = $props();

	const widgets = $derived(pageWidgets(fields, pageIndex));
	const swapped = $derived(rotation === 90 || rotation === 270);
	/** The source page on screen before the page's rotation. */
	const srcPx = $derived(swapped ? { width: pagePx.height, height: pagePx.width } : pagePx);
	const pxPerPt = $derived(pagePt.width > 0 ? srcPx.width / pagePt.width : 1);

	let focused = $state<string | null>(null);
	const keyOf = (w: PlacedWidget) => `${w.field.name}#${w.index}`;

	function same(a: FormValue, b: FormValue): boolean {
		if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
		return a === b;
	}

	/** The bitmap does not show this field's answer yet. */
	const behind = (f: FormField) => !same(shownValue(f, values), shownValue(f, drawn));

	const text = (f: FormField) => {
		const v = shownValue(f, values);
		return typeof v === 'string' ? v : '';
	};
	const choice = (f: FormField) => {
		const v = shownValue(f, values);
		return Array.isArray(v) ? (v[0] ?? '') : '';
	};
	const label = (f: FormField) => f.label || f.name;

	function geometry(w: PlacedWidget) {
		const r = rotateBox(w.box, rotation);
		const wpx = w.box.w * srcPx.width;
		const hpx = w.box.h * srcPx.height;
		const want = controlFontPx(hpx, pxPerPt, !!w.field.multiline);
		const { font, scale } = noZoomFont(want);
		return {
			slot: `left:${r.x * 100}%;top:${r.y * 100}%;width:${r.w * 100}%;height:${r.h * 100}%`,
			inner:
				`width:${wpx / scale}px;height:${hpx / scale}px;font-size:${font}px;` +
				`transform:translate(-50%,-50%) rotate(${rotation}deg) scale(${scale})`,
			box: r
		};
	}

	function keydown(e: KeyboardEvent) {
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		if (mod && k === 'z') {
			e.preventDefault();
			e.stopPropagation();
			if (e.shiftKey) onredo();
			else onundo();
		} else if (mod && k === 'y') {
			e.preventDefault();
			e.stopPropagation();
			onredo();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onescape();
		}
	}

	function focus(w: PlacedWidget, box: StampBox) {
		focused = keyOf(w);
		onfocusfield(box);
	}

	function blur(w: PlacedWidget) {
		if (focused === keyOf(w)) focused = null;
		onblurfield();
	}
</script>

<div class="form-layer" class:passthrough data-testid="form-layer">
	{#each widgets as w (keyOf(w))}
		{@const g = geometry(w)}
		{@const f = w.field}
		{@const show = focused === keyOf(w) || behind(f)}
		{#if w.locked}
			<div class="slot locked" style={g.slot} title="This field is locked by the form" data-field={f.name} data-form-slot></div>
		{:else}
			<div class="slot {f.kind}" class:show style={g.slot} data-field={f.name} data-form-slot>
				<div class="inner" style={g.inner}>
					{#if f.kind === 'text' && f.multiline}
						<textarea
							class="ctl"
							aria-label={label(f)}
							value={text(f)}
							maxlength={f.maxLength}
							spellcheck="false"
							oninput={(e) => onset(f, e.currentTarget.value)}
							onkeydown={keydown}
							onfocus={() => focus(w, g.box)}
							onblur={() => blur(w)}
						></textarea>
					{:else if f.kind === 'text'}
						<input
							class="ctl"
							type="text"
							aria-label={label(f)}
							value={text(f)}
							maxlength={f.maxLength}
							autocomplete="off"
							spellcheck="false"
							oninput={(e) => onset(f, e.currentTarget.value)}
							onkeydown={keydown}
							onfocus={() => focus(w, g.box)}
							onblur={() => blur(w)}
						/>
					{:else if f.kind === 'checkbox'}
						<input
							class="ctl"
							type="checkbox"
							aria-label={label(f)}
							checked={shownValue(f, values) === true}
							onchange={(e) => onset(f, e.currentTarget.checked)}
							onkeydown={keydown}
							onfocus={() => focus(w, g.box)}
							onblur={() => blur(w)}
						/>
					{:else if f.kind === 'radio'}
						<input
							class="ctl"
							type="radio"
							name={`${group}:${f.name}`}
							value={w.option}
							aria-label={`${label(f)}: ${w.option}`}
							checked={shownValue(f, values) === w.option}
							onchange={(e) => {
								if (e.currentTarget.checked && w.option !== undefined) onset(f, w.option);
							}}
							onkeydown={keydown}
							onfocus={() => focus(w, g.box)}
							onblur={() => blur(w)}
						/>
					{:else if f.kind === 'choice'}
						<select
							class="ctl"
							aria-label={label(f)}
							value={choice(f)}
							onchange={(e) => {
								const v = e.currentTarget.value;
								onset(f, v ? [v] : []);
							}}
							onkeydown={keydown}
							onfocus={() => focus(w, g.box)}
							onblur={() => blur(w)}
						>
							<option value="">&nbsp;</option>
							{#each f.options ?? [] as o (o.value)}
								<option value={o.value}>{o.label}</option>
							{/each}
						</select>
					{/if}
				</div>
			</div>
		{/if}
	{/each}
</div>

<style>
	.form-layer {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}

	.slot {
		position: absolute;
		box-sizing: border-box;
		pointer-events: auto;
		/* Subtle, so the form's own design shows through, but discoverable. */
		background: color-mix(in srgb, #2f5fb3 9%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, #2f5fb3 45%, transparent);
		border-radius: 1px;
		touch-action: none;
	}

	.passthrough .slot {
		pointer-events: none;
	}

	@media (hover: hover) {
		.slot:not(.locked):hover {
			background: color-mix(in srgb, #2f5fb3 16%, transparent);
		}
	}

	.slot:focus-within {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
		box-shadow: none;
	}

	.slot.locked {
		background: transparent;
		box-shadow: none;
		border: 1px dashed color-mix(in srgb, #5b5342 55%, transparent);
		cursor: not-allowed;
	}

	.inner {
		position: absolute;
		left: 50%;
		top: 50%;
		transform-origin: 50% 50%;
	}

	.ctl {
		display: block;
		box-sizing: border-box;
		width: 100%;
		height: 100%;
		margin: 0;
		padding: 0 0.15em;
		border: 0;
		border-radius: 0;
		outline: none;
		background: transparent;
		color: transparent;
		caret-color: transparent;
		font: inherit;
		font-family: Helvetica, Arial, ui-sans-serif, system-ui, sans-serif;
		line-height: 1.15;
		-webkit-appearance: none;
		appearance: none;
		cursor: text;
	}

	textarea.ctl {
		padding: 0.1em 0.15em;
		resize: none;
		overflow: hidden;
	}

	/* Focused (or the page has not been redrawn yet): the control draws the answer over a white box. */
	.show .ctl {
		background: #fff;
		color: #000;
		caret-color: #000;
	}

	textarea.ctl:focus {
		overflow: auto;
	}

	input[type='checkbox'].ctl,
	input[type='radio'].ctl,
	select.ctl {
		cursor: pointer;
	}

	/* The bitmap draws ticks and dots; the control only takes the click. */
	.show input[type='checkbox'].ctl,
	.show input[type='radio'].ctl {
		background: transparent;
	}

	select.ctl {
		white-space: nowrap;
		text-overflow: ellipsis;
	}

	select.ctl option {
		color: #000;
		background: #fff;
	}
</style>
