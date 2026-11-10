<script lang="ts">
	import type { Renderer, Rotation, Source } from '../core/types';
	import { bucketWidth, isSwapped } from './sizing';

	interface Props {
		source: Source;
		pageIndex: number;
		rotation: Rotation;
		renderer: Renderer;
		alt?: string;
	}

	let { source, pageIndex, rotation, renderer, alt = '' }: Props = $props();

	let box: HTMLDivElement | undefined = $state();
	let canvas: HTMLCanvasElement | undefined = $state();

	let near = $state(false);
	let cssWidth = $state(0);
	let cssHeight = $state(0);
	let dpr = $state(1);
	/** Debounced, bucketed target width in device pixels (displayed page, after rotation). */
	let wantWidth = $state(0);
	/** Rotation of the pixels currently on the canvas, or null when blank. */
	let drawnRotation: Rotation | null = $state(null);

	const page = $derived(source.pages[pageIndex] ?? { width: 1, height: 1 });
	const swapped = $derived(isSwapped(rotation));
	const aspect = $derived(swapped ? page.height / page.width : page.width / page.height);

	/** Quarter turns still to show with a CSS transform until the sharp render lands. */
	const pendingTurn = $derived(drawnRotation === null ? 0 : (rotation - drawnRotation + 360) % 360);
	const turnSwapped = $derived(isSwapped(pendingTurn));

	$effect(() => {
		if (!box) return;
		const el = box;
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) near = e.isIntersecting;
			},
			{ rootMargin: '150% 0px' }
		);
		io.observe(el);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let first = true;
		const ro = new ResizeObserver((entries) => {
			const r = entries[0].contentRect;
			cssWidth = r.width;
			cssHeight = r.height;
			dpr = Math.min(3, window.devicePixelRatio || 1);
			// Render the first size at once, debounce later resizes.
			const apply = () => {
				// Width of the *unrotated* page: renderer.render() takes it that way.
				const displayed = r.width * dpr;
				const unrotated = swapped ? displayed * (page.width / page.height) : displayed;
				wantWidth = bucketWidth(unrotated);
			};
			clearTimeout(timer);
			if (first && r.width > 0) {
				first = false;
				apply();
			} else timer = setTimeout(apply, 150);
		});
		ro.observe(el);
		return () => {
			io.disconnect();
			ro.disconnect();
			clearTimeout(timer);
		};
	});

	// Rotation changes the unrotated width for the same displayed width.
	$effect(() => {
		void rotation;
		if (cssWidth > 0) {
			const displayed = cssWidth * dpr;
			wantWidth = bucketWidth(swapped ? displayed * (page.width / page.height) : displayed);
		}
	});

	// Source or page changed: the old pixels are wrong.
	$effect(() => {
		void source;
		void pageIndex;
		clear();
	});

	function clear() {
		drawnRotation = null;
		if (canvas) {
			canvas.width = 0;
			canvas.height = 0;
		}
	}

	// Render when near the viewport; abort and free when leaving or changing inputs.
	$effect(() => {
		if (!near || !wantWidth || !canvas) {
			if (!near) clear();
			return;
		}
		const ac = new AbortController();
		const target = canvas;
		const rot = rotation;
		renderer
			.render({ source, pageIndex, width: wantWidth, rotation: rot, signal: ac.signal })
			.then((bmp) => {
				if (ac.signal.aborted) {
					bmp.close();
					return;
				}
				draw(target, bmp);
				drawnRotation = rot;
			})
			.catch((e) => {
				if (e?.name !== 'AbortError') console.error('Page render failed', e);
			});
		return () => ac.abort();
	});

	function draw(target: HTMLCanvasElement, bmp: ImageBitmap) {
		// The bitmap is our own copy (see renderer.ts), so transferring it is safe.
		const br = target.dataset.ctx !== '2d' ? target.getContext('bitmaprenderer') : null;
		if (br) {
			target.dataset.ctx = 'bitmap';
			// transferFromImageBitmap does not resize the canvas; do it so the bitmap is not scaled.
			target.width = bmp.width;
			target.height = bmp.height;
			br.transferFromImageBitmap(bmp);
			return;
		}
		target.dataset.ctx = '2d';
		target.width = bmp.width;
		target.height = bmp.height;
		target.getContext('2d')?.drawImage(bmp, 0, 0);
		bmp.close();
	}

	// While a rotated render is pending, turn the old pixels with CSS. The canvas
	// keeps its old aspect, so for quarter turns it is laid out with the new box's
	// width and height swapped and then rotated into place.
	const canvasStyle = $derived.by(() => {
		if (drawnRotation === null) return 'visibility: hidden';
		if (pendingTurn === 0) return '';
		const w = turnSwapped ? cssHeight : cssWidth;
		const h = turnSwapped ? cssWidth : cssHeight;
		return (
			`position: absolute; left: 50%; top: 50%; width: ${w}px; height: ${h}px;` +
			`transform: translate(-50%, -50%) rotate(${pendingTurn}deg)`
		);
	});
</script>

<div bind:this={box} class="sheet" style:aspect-ratio={aspect} role="img" aria-label={alt}>
	<canvas bind:this={canvas} style={canvasStyle}></canvas>
</div>

<style>
	.sheet {
		position: relative;
		width: 100%;
		background: #fff;
		overflow: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
</style>
