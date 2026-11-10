<script lang="ts">
	// Create or pick a signature / initials. Draw with a pen, or upload a photo of
	// one (with optional paper-background removal). Output: tightly cropped
	// transparent PNG as an Asset. Saved ones live in IndexedDB on this device only.
	import Dialog from '../ui/Dialog.svelte';
	import Button from '../ui/Button.svelte';
	import IconButton from '../ui/IconButton.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import Slider from '../ui/Slider.svelte';
	import type { Asset } from '../core/types';
	import { addPoint, drawStrokes, type Stroke } from './ink';
	import { imageDataPng, photoPixels, processPhoto, strokesToPng } from './png';
	import { deleteInk, listSaved, saveInk, type SavedInk } from './saved';
	import { inkRgb } from './stamp-view';

	interface Props {
		open: boolean;
		kind: 'signature' | 'initials';
		onpick: (asset: Asset) => void;
		/** Live-region announcer from the editor. */
		announce?: (msg: string) => void;
	}

	let { open = $bindable(false), kind, onpick, announce }: Props = $props();

	const noun = $derived(kind === 'signature' ? 'signature' : 'initials');
	const Noun = $derived(kind === 'signature' ? 'Signature' : 'Initials');

	let mode = $state<'draw' | 'upload'>('draw');
	let ink = $state<'black' | 'blue'>('black');
	let save = $state(true);
	let busy = $state(false);
	let error = $state('');

	// ---------------------------------------------------------------- saved
	let saved = $state.raw<SavedInk[]>([]);
	let savedUrls = $state<Record<string, string>>({});
	let storageOk = $state(true);

	async function loadSaved() {
		const list = await listSaved(kind);
		for (const u of Object.values(savedUrls)) URL.revokeObjectURL(u);
		const urls: Record<string, string> = {};
		for (const s of list) urls[s.id] = URL.createObjectURL(new Blob([s.png as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
		saved = list;
		savedUrls = urls;
	}

	$effect(() => {
		if (!open) return;
		void kind;
		error = '';
		void loadSaved();
		return () => {
			for (const u of Object.values(savedUrls)) URL.revokeObjectURL(u);
			savedUrls = {};
		};
	});

	function pickSaved(s: SavedInk) {
		onpick({ id: s.id, kind: s.kind, png: s.png, width: s.width, height: s.height });
		open = false;
	}

	async function removeSaved(s: SavedInk, index: number) {
		if (await deleteInk(s.id)) {
			announce?.(`Deleted saved ${noun} ${index + 1}.`);
			await loadSaved();
		} else {
			error = 'Could not delete it. This browser is blocking site storage.';
		}
	}

	// ---------------------------------------------------------------- draw
	/** Points are stored as fractions of the pad width, so resizing keeps the drawing. */
	let strokes = $state.raw<Stroke[]>([]);
	let current: Stroke | null = null;
	let pad: HTMLCanvasElement | undefined = $state();
	let padW = $state(0);
	let padH = $state(0);
	const PEN = 0.0055; // pen width as a fraction of pad width
	const REF_W = 600; // output reference width in CSS px

	const inkCss = $derived(`rgb(${inkRgb(ink).join(' ')})`);

	$effect(() => {
		// Redraw on any change of strokes, size or colour.
		void strokes.length;
		void inkCss;
		void padW;
		void padH;
		redraw();
	});

	function redraw() {
		if (!pad || padW === 0) return;
		const dpr = Math.min(3, window.devicePixelRatio || 1);
		const w = Math.round(padW * dpr);
		const h = Math.round(padH * dpr);
		if (pad.width !== w || pad.height !== h) {
			pad.width = w;
			pad.height = h;
		}
		const ctx = pad.getContext('2d');
		if (!ctx) return;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, w, h);
		const s = padW * dpr;
		ctx.strokeStyle = inkCss;
		ctx.fillStyle = inkCss;
		ctx.lineWidth = PEN * s;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		drawStrokes(ctx, strokes, PEN, s);
	}

	function padPoint(e: PointerEvent) {
		const r = pad!.getBoundingClientRect();
		return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.width };
	}

	function down(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		e.preventDefault();
		pad!.setPointerCapture(e.pointerId);
		current = [];
		addPoint(current, padPoint(e), 0);
		strokes = [...strokes, current];
	}

	function move(e: PointerEvent) {
		if (!current) return;
		const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
		let changed = false;
		for (const ev of events.length ? events : [e]) changed = addPoint(current, padPoint(ev), 1.2 / Math.max(1, padW)) || changed;
		if (changed) redraw();
	}

	function up() {
		if (!current) return;
		current = null;
		strokes = [...strokes];
	}

	function undoStroke() {
		strokes = strokes.slice(0, -1);
	}

	function clearPad() {
		strokes = [];
	}

	// ---------------------------------------------------------------- upload
	let fileInput: HTMLInputElement | undefined = $state();
	let photo = $state.raw<ImageData | null>(null);
	let removeBg = $state(true);
	let strength = $state(50);
	let preview: HTMLCanvasElement | undefined = $state();
	let processed = $state.raw<ImageData | null>(null);

	async function onFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		(e.currentTarget as HTMLInputElement).value = '';
		if (!file) return;
		error = '';
		try {
			const bmp = await createImageBitmap(file);
			photo = photoPixels(bmp);
			bmp.close();
		} catch {
			photo = null;
			error = 'This image could not be read here. Use a JPEG or PNG photo.';
		}
	}

	$effect(() => {
		if (!photo) {
			processed = null;
			return;
		}
		processed = processPhoto(photo, { removeBackground: removeBg, strength: strength / 100, ink: inkRgb(ink) });
	});

	$effect(() => {
		if (!preview) return;
		const img = processed;
		if (!img) {
			preview.width = 0;
			return;
		}
		preview.width = img.width;
		preview.height = img.height;
		preview.getContext('2d')?.putImageData(img, 0, 0);
	});

	// ---------------------------------------------------------------- use
	const canUse = $derived(mode === 'draw' ? strokes.length > 0 : !!processed);

	async function use() {
		if (!canUse || busy) return;
		busy = true;
		error = '';
		try {
			const px = strokes.map((s) => s.map((p) => ({ x: p.x * REF_W, y: p.y * REF_W })));
			const result = mode === 'draw' ? await strokesToPng(px, PEN * REF_W, inkCss, 3) : await imageDataPng(processed!);
			if (!result) {
				error = `Nothing to use yet. ${mode === 'draw' ? 'Draw your ' + noun + ' first.' : 'Choose another photo.'}`;
				return;
			}
			const asset: Asset = { id: crypto.randomUUID(), kind, png: result.png, width: result.width, height: result.height };
			if (save) {
				storageOk = await saveInk({ ...asset, kind, created: Date.now() });
			}
			onpick(asset);
			strokes = [];
			photo = null;
			open = false;
		} catch {
			error = `Could not make the ${noun} image. Try again.`;
		} finally {
			busy = false;
		}
	}
</script>

<Dialog bind:open title={`Add ${noun}`} width="720px">
	{#if saved.length > 0}
		<section class="saved" aria-labelledby="saved-h">
			<h3 id="saved-h">Saved on this device</h3>
			<ul>
				{#each saved as s, i (s.id)}
					<li>
						<button type="button" class="saved-pick" onclick={() => pickSaved(s)} aria-label={`Use saved ${noun} ${i + 1}`}>
							{#if savedUrls[s.id]}<img src={savedUrls[s.id]} alt="" />{/if}
						</button>
						<IconButton icon="trash" label={`Delete saved ${noun} ${i + 1}`} tooltip={false} onclick={() => removeSaved(s, i)} />
					</li>
				{/each}
			</ul>
			<p class="note">Saved only in this browser on this device. It is never uploaded.</p>
		</section>
		<h3 class="new-h">Or make a new one</h3>
	{/if}

	<div class="tabs" role="radiogroup" aria-label="How to add it">
		<button type="button" role="radio" aria-checked={mode === 'draw'} onclick={() => (mode = 'draw')}>Draw</button>
		<button type="button" role="radio" aria-checked={mode === 'upload'} onclick={() => (mode = 'upload')}>Upload a photo</button>
	</div>

	<div class="inks" role="radiogroup" aria-label="Ink colour">
		<button type="button" role="radio" aria-checked={ink === 'black'} onclick={() => (ink = 'black')}>
			<span class="swatch" style="background: rgb({inkRgb('black').join(' ')})"></span>Black
		</button>
		<button type="button" role="radio" aria-checked={ink === 'blue'} onclick={() => (ink = 'blue')}>
			<span class="swatch" style="background: rgb({inkRgb('blue').join(' ')})"></span>Blue
		</button>
	</div>

	{#if mode === 'draw'}
		<div class="pad-wrap" class:initials={kind === 'initials'} bind:clientWidth={padW} bind:clientHeight={padH}>
			<canvas
				bind:this={pad}
				class="pad"
				aria-label={`Drawing area. Draw your ${noun} with a finger, pen or mouse.`}
				onpointerdown={down}
				onpointermove={move}
				onpointerup={up}
				onpointercancel={up}
			></canvas>
			<div class="baseline" aria-hidden="true"></div>
			{#if strokes.length === 0}<p class="hint" aria-hidden="true">{kind === 'signature' ? 'Sign here' : 'Initial here'}</p>{/if}
		</div>
		<div class="pad-actions">
			<Button variant="quiet" icon="undo" disabled={strokes.length === 0} onclick={undoStroke}>Undo stroke</Button>
			<Button variant="quiet" icon="close" disabled={strokes.length === 0} onclick={clearPad}>Clear</Button>
		</div>
	{:else}
		<input bind:this={fileInput} type="file" accept="image/png,image/jpeg,image/webp" class="visually-hidden" tabindex="-1" onchange={onFile} />
		<div class="upload">
			<Button icon="upload" onclick={() => fileInput?.click()}>{photo ? 'Choose another photo' : 'Choose a photo'}</Button>
			{#if photo}
				<div class="preview checker">
					{#if processed}<canvas bind:this={preview} aria-label={`Preview of the ${noun}`}></canvas>{:else}<p>Nothing is left. Lower the setting below.</p>{/if}
				</div>
				<Toggle bind:checked={removeBg} label="Remove paper background" hint="Makes the paper transparent and keeps the ink." />
				{#if removeBg}
					<Slider bind:value={strength} min={0} max={100} step={1} label="Keep fainter lines" valueText={(v) => `${v} percent`} />
				{/if}
			{:else}
				<p class="note">Photograph your {noun} on plain white paper, in good light, filling most of the photo.</p>
			{/if}
		</div>
	{/if}

	<div class="save">
		<Toggle bind:checked={save} label="Save on this device" hint="Kept only in this browser so you can reuse it. Delete it here any time." />
		{#if !storageOk}<p class="error" role="alert">This browser did not allow saving. It is used for this document only.</p>{/if}
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}

	{#snippet actions()}
		<Button variant="quiet" onclick={() => (open = false)}>Cancel</Button>
		<Button variant="primary" disabled={!canUse} loading={busy} onclick={use}>Use {noun}</Button>
	{/snippet}
</Dialog>

<style>
	h3 {
		font-size: var(--text-control);
		font-weight: 600;
		margin-bottom: var(--s-2);
	}

	.new-h {
		margin-top: var(--s-4);
	}

	.saved ul {
		list-style: none;
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-2);
		padding: 0;
		margin: 0;
	}

	.saved li {
		display: flex;
		align-items: center;
		gap: 2px;
		background: var(--sheet);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: 2px;
		color: #1d1a14;
	}

	.saved li :global(.icon-btn) {
		color: #5b5342;
	}

	.saved-pick {
		display: grid;
		place-items: center;
		width: 160px;
		height: 64px;
		border-radius: 4px;
		padding: 6px;
	}

	.saved-pick:hover {
		background: #f3efe6;
	}

	.saved-pick img {
		max-width: 100%;
		max-height: 100%;
	}

	.note {
		margin-top: var(--s-2);
		color: var(--ink-soft);
		font-size: var(--text-caption);
	}

	.tabs,
	.inks {
		display: inline-flex;
		border: 1px solid var(--line-strong);
		border-radius: var(--radius-control);
		overflow: hidden;
		margin: 0 var(--s-2) var(--s-3) 0;
	}

	.tabs button,
	.inks button {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		min-height: var(--control-h);
		padding: 0 var(--s-3);
		font-size: var(--text-control);
		color: var(--ink);
	}

	.tabs button + button,
	.inks button + button {
		border-left: 1px solid var(--line-strong);
	}

	.tabs [aria-checked='true'],
	.inks [aria-checked='true'] {
		background: var(--press);
		font-weight: 600;
	}

	.swatch {
		width: 14px;
		height: 14px;
		border-radius: 50%;
	}

	.pad-wrap {
		position: relative;
		width: 100%;
		aspect-ratio: 3 / 1;
		max-height: 45dvh;
		background: var(--sheet);
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		overflow: hidden;
	}

	.pad-wrap.initials {
		aspect-ratio: 2 / 1;
		max-width: 420px;
	}

	.pad {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		touch-action: none;
		cursor: crosshair;
		z-index: 1;
	}

	.baseline {
		position: absolute;
		left: 8%;
		right: 8%;
		bottom: 26%;
		border-bottom: 1px solid #d7cdb6;
	}

	.hint {
		position: absolute;
		left: 8%;
		bottom: calc(26% + 6px);
		color: #8b8170;
		font-size: var(--text-caption);
		pointer-events: none;
	}

	.pad-actions {
		display: flex;
		gap: var(--s-2);
		margin-top: var(--s-2);
	}

	.upload {
		display: grid;
		gap: var(--s-3);
		justify-items: start;
	}

	.preview {
		display: grid;
		place-items: center;
		width: 100%;
		min-height: 120px;
		max-height: 40dvh;
		border: 1px solid var(--line);
		border-radius: var(--radius-control);
		padding: var(--s-3);
		color: #5b5342;
	}

	.preview canvas {
		max-width: 100%;
		max-height: calc(40dvh - 24px);
	}

	.checker {
		background-color: #fff;
		background-image:
			linear-gradient(45deg, #eee 25%, transparent 25%),
			linear-gradient(-45deg, #eee 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #eee 75%),
			linear-gradient(-45deg, transparent 75%, #eee 75%);
		background-size: 16px 16px;
		background-position:
			0 0,
			0 8px,
			8px -8px,
			-8px 0;
	}

	.save {
		margin-top: var(--s-4);
	}

	.error {
		margin-top: var(--s-2);
		color: var(--danger);
		font-size: var(--text-control);
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}
</style>
