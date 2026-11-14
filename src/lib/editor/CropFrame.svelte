<script lang="ts">
	// The crop rectangle over a whole page in the editor: the part outside is dimmed, the
	// frame moves with a drag inside it, corners and edges resize it (mouse and touch), and
	// each edge is a slider for the keyboard (arrows: 1%, Shift: 10%). The parent is the
	// page box; `box` is in fractions of it. Pointer events stop here, so the editor does
	// not pan or turn the page while the frame is being moved.
	import type { StampBox } from '../core/types';

	interface Props {
		box: StampBox;
		/** Smallest width and height, as fractions of the page. */
		minW: number;
		minH: number;
		onchange: (box: StampBox) => void;
		/** A drag ended (for an announcement). */
		ondone?: () => void;
	}

	let { box, minW, minH, onchange, ondone }: Props = $props();

	type Grip = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
	let drag: { grip: Grip; x: number; y: number; start: StampBox; pw: number; ph: number; id: number } | null = null;
	let frame: HTMLDivElement | undefined = $state();

	const pct = (v: number) => `${v * 100}%`;

	/** The box after moving the edges named by `grip` by (dx, dy) fractions, kept on the page and at least the minimum size. */
	function adjust(start: StampBox, grip: Grip, dx: number, dy: number): StampBox {
		let x0 = start.x;
		let y0 = start.y;
		let x1 = start.x + start.w;
		let y1 = start.y + start.h;
		if (grip === 'move') {
			const mx = Math.min(1 - x1, Math.max(-x0, dx));
			const my = Math.min(1 - y1, Math.max(-y0, dy));
			return { x: x0 + mx, y: y0 + my, w: start.w, h: start.h };
		}
		if (grip.includes('w')) x0 = Math.min(x1 - minW, Math.max(0, x0 + dx));
		if (grip.includes('e')) x1 = Math.max(x0 + minW, Math.min(1, x1 + dx));
		if (grip.includes('n')) y0 = Math.min(y1 - minH, Math.max(0, y0 + dy));
		if (grip.includes('s')) y1 = Math.max(y0 + minH, Math.min(1, y1 + dy));
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}

	function down(e: PointerEvent, grip: Grip) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		// A frame over the whole page cannot move: a drag on it draws a new frame (the editor's).
		if (grip === 'move' && box.x <= 1e-6 && box.y <= 1e-6 && box.w >= 1 - 1e-6 && box.h >= 1 - 1e-6) return;
		e.stopPropagation();
		e.preventDefault();
		const page = frame?.parentElement?.getBoundingClientRect();
		if (!page || page.width <= 0 || page.height <= 0) return;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		drag = { grip, x: e.clientX, y: e.clientY, start: { ...box }, pw: page.width, ph: page.height, id: e.pointerId };
	}

	function move(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		e.stopPropagation();
		onchange(adjust(drag.start, drag.grip, (e.clientX - drag.x) / drag.pw, (e.clientY - drag.y) / drag.ph));
	}

	function up(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.id) return;
		e.stopPropagation();
		drag = null;
		ondone?.();
	}

	const EDGES = [
		{ grip: 'w', label: 'Left edge', vertical: false },
		{ grip: 'e', label: 'Right edge', vertical: false },
		{ grip: 'n', label: 'Top edge', vertical: true },
		{ grip: 's', label: 'Bottom edge', vertical: true }
	] as const;

	const edgeValue = (g: 'n' | 's' | 'e' | 'w') => (g === 'w' ? box.x : g === 'e' ? box.x + box.w : g === 'n' ? box.y : box.y + box.h);

	function key(e: KeyboardEvent, grip: 'n' | 's' | 'e' | 'w', vertical: boolean) {
		const step = e.shiftKey ? 0.1 : 0.01;
		let d = 0;
		if (vertical && e.key === 'ArrowUp') d = -step;
		else if (vertical && e.key === 'ArrowDown') d = step;
		else if (!vertical && e.key === 'ArrowLeft') d = -step;
		else if (!vertical && e.key === 'ArrowRight') d = step;
		else if (e.key === 'Home') d = -1;
		else if (e.key === 'End') d = 1;
		else return;
		e.preventDefault();
		e.stopPropagation();
		onchange(adjust(box, grip, vertical ? 0 : d, vertical ? d : 0));
	}
</script>

<div
	bind:this={frame}
	class="crop-frame"
	style:left={pct(box.x)}
	style:top={pct(box.y)}
	style:width={pct(box.w)}
	style:height={pct(box.h)}
	data-testid="crop-frame"
	role="presentation"
	onpointerdown={(e) => down(e, 'move')}
	onpointermove={move}
	onpointerup={up}
	onpointercancel={up}
>
	<span class="thirds" aria-hidden="true"></span>
	{#each ['nw', 'ne', 'sw', 'se'] as const as g (g)}
		<span
			class="corner {g}"
			aria-hidden="true"
			data-grip={g}
			onpointerdown={(e) => down(e, g)}
			onpointermove={move}
			onpointerup={up}
			onpointercancel={up}
		></span>
	{/each}
	{#each EDGES as edge (edge.grip)}
		<span
			class="edge {edge.grip}"
			role="slider"
			tabindex="0"
			aria-label={edge.label}
			aria-orientation={edge.vertical ? 'vertical' : 'horizontal'}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={Math.round(edgeValue(edge.grip) * 100)}
			aria-valuetext={`${Math.round(edgeValue(edge.grip) * 100)}% from the ${edge.vertical ? 'top' : 'left'}`}
			data-grip={edge.grip}
			onpointerdown={(e) => down(e, edge.grip)}
			onpointermove={move}
			onpointerup={up}
			onpointercancel={up}
			onkeydown={(e) => key(e, edge.grip, edge.vertical)}
		><span class="bar" aria-hidden="true"></span></span>
	{/each}
</div>

<style>
	.crop-frame {
		position: absolute;
		/* Dims everything outside the frame (the page box clips the shadow). */
		box-shadow: 0 0 0 100vmax rgb(21 19 15 / 0.55);
		outline: 2px solid var(--accent);
		outline-offset: 0;
		cursor: move;
		touch-action: none;
		z-index: 3;
	}

	.thirds {
		position: absolute;
		inset: 0;
		pointer-events: none;
		background:
			linear-gradient(to right, transparent calc(33.33% - 0.5px), rgb(255 255 255 / 0.5) calc(33.33% - 0.5px), rgb(255 255 255 / 0.5) calc(33.33% + 0.5px), transparent calc(33.33% + 0.5px), transparent calc(66.66% - 0.5px), rgb(255 255 255 / 0.5) calc(66.66% - 0.5px), rgb(255 255 255 / 0.5) calc(66.66% + 0.5px), transparent calc(66.66% + 0.5px)),
			linear-gradient(to bottom, transparent calc(33.33% - 0.5px), rgb(255 255 255 / 0.5) calc(33.33% - 0.5px), rgb(255 255 255 / 0.5) calc(33.33% + 0.5px), transparent calc(33.33% + 0.5px), transparent calc(66.66% - 0.5px), rgb(255 255 255 / 0.5) calc(66.66% - 0.5px), rgb(255 255 255 / 0.5) calc(66.66% + 0.5px), transparent calc(66.66% + 0.5px));
	}

	/* Corners: an L of the page colour on the frame, with a 44 px touch target. */
	.corner {
		position: absolute;
		width: 44px;
		height: 44px;
		touch-action: none;
	}
	.corner::before {
		content: '';
		position: absolute;
		width: 18px;
		height: 18px;
		border: 0 solid var(--accent);
		filter: drop-shadow(0 0 1px #fff);
	}
	.nw {
		left: -22px;
		top: -22px;
		cursor: nwse-resize;
	}
	.nw::before {
		left: 20px;
		top: 20px;
		border-left-width: 4px;
		border-top-width: 4px;
	}
	.ne {
		right: -22px;
		top: -22px;
		cursor: nesw-resize;
	}
	.ne::before {
		right: 20px;
		top: 20px;
		border-right-width: 4px;
		border-top-width: 4px;
	}
	.sw {
		left: -22px;
		bottom: -22px;
		cursor: nesw-resize;
	}
	.sw::before {
		left: 20px;
		bottom: 20px;
		border-left-width: 4px;
		border-bottom-width: 4px;
	}
	.se {
		right: -22px;
		bottom: -22px;
		cursor: nwse-resize;
	}
	.se::before {
		right: 20px;
		bottom: 20px;
		border-right-width: 4px;
		border-bottom-width: 4px;
	}

	/* Edges: a short bar in the middle of each side, a 32 px band to hold. */
	.edge {
		position: absolute;
		display: grid;
		place-items: center;
		touch-action: none;
		border-radius: 4px;
	}
	.edge.w,
	.edge.e {
		top: 22px;
		bottom: 22px;
		width: 32px;
		cursor: ew-resize;
	}
	.edge.w {
		left: -16px;
	}
	.edge.e {
		right: -16px;
	}
	.edge.n,
	.edge.s {
		left: 22px;
		right: 22px;
		height: 32px;
		cursor: ns-resize;
	}
	.edge.n {
		top: -16px;
	}
	.edge.s {
		bottom: -16px;
	}
	.bar {
		background: var(--accent);
		border-radius: 2px;
		box-shadow: 0 0 0 1.5px #fff;
	}
	.edge.w .bar,
	.edge.e .bar {
		width: 4px;
		height: min(28px, 60%);
	}
	.edge.n .bar,
	.edge.s .bar {
		height: 4px;
		width: min(28px, 60%);
	}
	.edge:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
