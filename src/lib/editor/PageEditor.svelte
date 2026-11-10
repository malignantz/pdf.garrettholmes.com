<script lang="ts" module>
	/** The note about what redaction does is shown once per visit. */
	let redactNoteShown = false;
</script>

<script lang="ts">
	// Full-screen view of one page for placing stamps: signature, initials, text,
	// date and marks (placed by a tap), highlight and redaction boxes (drawn by a
	// drag). Zoom/pan, page navigation, undo/redo through the store.
	import { flushSync, onMount, tick, untrack } from 'svelte';
	import type { Asset, FormField, FormValue, HighlightColor, PageId, PageRef, Stamp, StampBox } from '../core/types';
	import { getApp } from '../app';
	import { useDocStore } from '../doc/store.svelte';
	import type { NewStamp } from '../doc/store';
	import PageCanvas from '../render/PageCanvas.svelte';
	import Button from '../ui/Button.svelte';
	import IconButton from '../ui/IconButton.svelte';
	import Icon from '../ui/Icon.svelte';
	import type { IconName } from '../ui/icons';
	import { trapTab } from '../ui/focus';
	import StampShape from './StampShape.svelte';
	import SignaturePad from './SignaturePad.svelte';
	import CopyDialog from './CopyDialog.svelte';
	import FormLayer from './FormLayer.svelte';
	import { formFieldsOf } from './form-fields.svelte';
	import { panToReveal, redactionEcho } from './form-view';
	import { ensureStampFont, stampName, cssColor, HIGHLIGHT_COLORS, HIGHLIGHT_CSS, paintOrder } from './stamp-view';
	import { stampForPage } from './copy';
	import {
		arrowDelta,
		boxAround,
		centeredView,
		clampBox,
		clampPan,
		clampZoom,
		fitSize,
		imageBoxSize,
		moveBox,
		nudgeStep,
		pinchView,
		resizeBox,
		screenToFraction,
		squareBoxSize,
		zoomAt,
		type Handle,
		type Point,
		type View
	} from './geometry';

	let { pageId, onclose }: { pageId: PageId; onclose: () => void } = $props();

	const app = getApp();
	const store = app.store;
	const doc = useDocStore(store);

	// ------------------------------------------------------------ page
	// svelte-ignore state_referenced_locally
	let currentId = $state<PageId>(pageId);
	let lastIndex = 0;
	const pages = $derived(doc.state.pages);
	const index = $derived(pages.findIndex((p) => p.id === currentId));
	const page = $derived<PageRef | undefined>(index >= 0 ? pages[index] : undefined);
	const source = $derived(page ? doc.state.sources.find((s) => s.id === page.sourceId) ?? store.sourceOf(page.id) : undefined);
	const ptSize = $derived(page ? store.displayedSize(page) : undefined);
	const aspect = $derived(ptSize && ptSize.height > 0 ? ptSize.width / ptSize.height : 0.7727);
	const assets = $derived(doc.state.assets);

	// History is scoped to this editing session: steps from before the editor
	// opened (e.g. a reorder in the grid) cannot be undone or redone from here.
	const undoMark = store.undoToken;
	const redoMark = store.redoToken;
	const canUndoHere = $derived(doc.state.canUndo && store.undoToken !== undoMark);
	const canRedoHere = $derived(doc.state.canRedo && store.redoToken !== redoMark);
	const assetById = $derived(new Map(assets.map((a) => [a.id, a])));

	$effect(() => {
		if (index >= 0) {
			lastIndex = index;
			return;
		}
		// The page went away (undo of an insert, or removed elsewhere).
		if (pages.length === 0) onclose();
		else currentId = pages[Math.min(lastIndex, pages.length - 1)].id;
	});

	// ------------------------------------------------------------ view
	let vp: HTMLDivElement | undefined = $state();
	let vpW = $state(0);
	let vpH = $state(0);
	const margin = $derived(vpW < 600 ? 12 : 32);
	const base = $derived(fitSize({ width: vpW, height: vpH }, aspect, margin));
	let view = $state<View>({ zoom: 1, panX: 0, panY: 0 });
	const port = $derived({ width: vpW, height: vpH });

	function setView(v: View) {
		view = clampPan(v, port, base, margin);
	}

	// Fit on page change and whenever the viewport or page shape changes at zoom 1.
	let fittedFor = '';
	$effect(() => {
		const key = `${currentId}|${vpW}|${vpH}|${aspect}`;
		if (vpW === 0) return;
		const pageChanged = !fittedFor.startsWith(`${currentId}|`);
		fittedFor = key;
		// `view` is read untracked: this effect writes it, and tracking it loops.
		const v = untrack(() => view);
		if (pageChanged || v.zoom <= 1.0001) view = centeredView(port, base, 1);
		else setView(v);
	});

	const pageStyle = $derived(
		`left:${view.panX}px;top:${view.panY}px;width:${base.width * view.zoom}px;height:${base.height * view.zoom}px`
	);

	function vpPoint(e: { clientX: number; clientY: number }): Point {
		const r = vp!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function toFraction(e: { clientX: number; clientY: number }): Point {
		return screenToFraction(vpPoint(e), view, base);
	}

	function zoomBy(factor: number, anchor?: Point) {
		const a = anchor ?? { x: vpW / 2, y: vpH / 2 };
		setView(zoomAt(view, base, clampZoom(view.zoom * factor), a));
	}

	function fit() {
		view = centeredView(port, base, 1);
	}

	$effect(() => {
		if (!vp) return;
		const el = vp;
		const onWheel = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				e.preventDefault();
				const d = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				zoomBy(Math.exp(-d * 0.01), vpPoint(e));
			} else if (view.zoom > 1.0001) {
				e.preventDefault();
				setView({ ...view, panX: view.panX - e.deltaX, panY: view.panY - e.deltaY });
			}
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		// Safari trackpad pinch.
		let g0 = 1;
		const gs = (e: Event) => {
			e.preventDefault();
			g0 = view.zoom;
		};
		const gc = (e: Event) => {
			e.preventDefault();
			const ge = e as Event & { scale: number; clientX: number; clientY: number };
			setView(zoomAt(view, base, clampZoom(g0 * ge.scale), vpPoint(ge)));
		};
		el.addEventListener('gesturestart', gs);
		el.addEventListener('gesturechange', gc);
		return () => {
			el.removeEventListener('wheel', onWheel);
			el.removeEventListener('gesturestart', gs);
			el.removeEventListener('gesturechange', gc);
		};
	});

	// ------------------------------------------------------------ viewport pointers (tap, pan, pinch, swipe)
	const pointers = new Map<number, Point>();
	let pmode: 'none' | 'tap' | 'pan' | 'swipe' | 'pinch' | 'draw' = 'none';
	let pstart = { x: 0, y: 0, t: 0, view: { zoom: 1, panX: 0, panY: 0 } as View };
	let pinch0 = { view: { zoom: 1, panX: 0, panY: 0 } as View, m: { x: 0, y: 0 }, d: 1 };

	function mid() {
		const [a, b] = [...pointers.values()];
		return { m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, d: Math.hypot(a.x - b.x, a.y - b.y) };
	}

	/** The event started on a form field's control (or a locked field). */
	const onField = (t: EventTarget | null) => t instanceof Element && !!t.closest('[data-form-slot]');
	let downOnField = false;

	function vpDown(e: PointerEvent) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		const field = onField(e.target);
		// A mouse on a field is the field's: it focuses, clicks and selects text natively.
		if (field && e.pointerType === 'mouse') {
			if (editing) finishEditing(true);
			selectedId = null;
			return;
		}
		// A finger on a field still pans and pinches, so it is not captured: a plain tap
		// reaches the control as usual and focuses it.
		if (!field) vp!.setPointerCapture?.(e.pointerId);
		if (pointers.size === 0) downOnField = field;
		pointers.set(e.pointerId, vpPoint(e));
		if (pointers.size === 1) {
			const p = vpPoint(e);
			pmode = 'tap';
			pstart = { x: p.x, y: p.y, t: performance.now(), view: { ...view } };
		} else if (pointers.size === 2) {
			// A second finger always means pinch: a box being drawn is dropped.
			draft = null;
			pmode = 'pinch';
			const { m, d } = mid();
			pinch0 = { view: { ...view }, m, d };
		}
	}

	function vpMove(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		const p = vpPoint(e);
		pointers.set(e.pointerId, p);
		if (pmode === 'pinch' && pointers.size >= 2) {
			const { m, d } = mid();
			setView(pinchView(pinch0.view, base, pinch0.m, pinch0.d, m, d));
			return;
		}
		const dx = p.x - pstart.x;
		const dy = p.y - pstart.y;
		if (pmode === 'tap' && Math.hypot(dx, dy) > 8) {
			const f0 = screenToFraction(pstart, pstart.view, base);
			// With a drawn tool armed, one finger (or the mouse) on the page draws instead of panning.
			if (isDrawn(armed) && insidePage(f0)) {
				pmode = 'draw';
				draftStart = f0;
			} else pmode = pstart.view.zoom > 1.0001 ? 'pan' : 'swipe';
		}
		if (pmode === 'draw') draft = drawnBox(draftStart, toFraction(e));
		else if (pmode === 'pan') setView({ ...pstart.view, panX: pstart.view.panX + dx, panY: pstart.view.panY + dy });
	}

	function vpUp(e: PointerEvent) {
		if (!pointers.has(e.pointerId)) return;
		const p = vpPoint(e);
		pointers.delete(e.pointerId);
		if (pmode === 'tap') {
			if (downOnField) {
				if (editing) finishEditing(true);
				selectedId = null;
			} else onTap(toFraction(e));
		}
		else if (pmode === 'draw') finishDraw(toFraction(e));
		else if (pmode === 'swipe') {
			const dx = p.x - pstart.x;
			const dy = p.y - pstart.y;
			if (Math.abs(dx) > 60 && Math.abs(dx) > 1.5 * Math.abs(dy) && performance.now() - pstart.t < 800) {
				if (dx < 0) go(1);
				else go(-1);
			}
		}
		if (pointers.size === 0) pmode = 'none';
		else if (pmode === 'pinch') pmode = 'none';
	}

	function vpCancel(e: PointerEvent) {
		pointers.delete(e.pointerId);
		if (pmode === 'draw') draft = null;
		if (pointers.size === 0) pmode = 'none';
	}

	const insidePage = (f: Point) => f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1;

	// ------------------------------------------------------------ drawing a box (highlight, redact)
	/** The box being drawn, as page fractions. Local state only: the store sees one stamp on release. */
	let draft = $state<StampBox | null>(null);
	let draftStart: Point = { x: 0, y: 0 };

	function drawnBox(a: Point, b: Point): StampBox {
		const c = (v: number) => Math.min(1, Math.max(0, v));
		const x0 = c(Math.min(a.x, b.x));
		const x1 = c(Math.max(a.x, b.x));
		const y0 = c(Math.min(a.y, b.y));
		const y1 = c(Math.max(a.y, b.y));
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}

	/** A drag that stays within this many screen pixels is a slip: it places the default box. */
	const SLIP_PX = 12;
	/** A side thinner than this (a quick stroke along a line) gets the default size. */
	const MIN_DRAWN_PX = 6;

	/** Default drawn box: about 30% of the page wide, one text line high. */
	function defaultBoxSize() {
		return { width: 0.3, height: Math.min(0.2, textSize * 1.4) };
	}

	function finishDraw(end: Point) {
		const t = armed;
		const b = drawnBox(draftStart, end);
		draft = null;
		if (!isDrawn(t)) return;
		const pw = base.width * view.zoom;
		const ph = base.height * view.zoom;
		const def = defaultBoxSize();
		const thinW = b.w * pw < MIN_DRAWN_PX;
		const thinH = b.h * ph < MIN_DRAWN_PX;
		let box: StampBox;
		if ((thinW && thinH) || Math.max(b.w * pw, b.h * ph) < SLIP_PX) box = boxAround(draftStart, def.width, def.height);
		else {
			// One side too thin: that side gets the default size, centred on the stroke.
			const w = thinW ? def.width : b.w;
			const h = thinH ? def.height : b.h;
			box = boxAround({ x: b.x + b.w / 2, y: b.y + b.h / 2 }, w, h);
		}
		addBox(t, box, false);
	}

	// ------------------------------------------------------------ live region
	let live = $state('');
	function announce(msg: string) {
		live = '';
		setTimeout(() => (live = msg), 30);
	}

	// ------------------------------------------------------------ tools
	type Tool = 'signature' | 'initials' | 'text' | 'date' | 'check' | 'cross' | 'dot' | 'highlight' | 'redact';
	const TOOLS: { id: Tool; label: string; icon: IconName }[] = [
		{ id: 'signature', label: 'Signature', icon: 'sign' },
		{ id: 'initials', label: 'Initials', icon: 'initials' },
		{ id: 'text', label: 'Text', icon: 'text' },
		{ id: 'date', label: 'Date', icon: 'calendar' },
		{ id: 'check', label: 'Check', icon: 'check' },
		{ id: 'cross', label: 'Cross', icon: 'cross' },
		{ id: 'dot', label: 'Dot', icon: 'dot' },
		{ id: 'highlight', label: 'Highlight', icon: 'highlight' },
		{ id: 'redact', label: 'Redact', icon: 'redact' }
	];
	const isMark = (t: Tool | null): t is 'check' | 'cross' | 'dot' => t === 'check' || t === 'cross' || t === 'dot';
	/** Tools whose box is drawn with a drag; they stay armed for several boxes. */
	const isDrawn = (t: Tool | null): t is 'highlight' | 'redact' => t === 'highlight' || t === 'redact';

	// Last highlight colour, remembered on this device (a convenience; fine if storage is blocked).
	const HL_KEY = 'pdf-editor-highlight';
	function readHl(): HighlightColor {
		try {
			const v = localStorage.getItem(HL_KEY);
			return v === 'green' || v === 'pink' ? v : 'yellow';
		} catch {
			return 'yellow';
		}
	}
	let hlColor = $state<HighlightColor>(readHl());
	function rememberHl(c: HighlightColor) {
		hlColor = c;
		try {
			localStorage.setItem(HL_KEY, c);
		} catch {
			// Storage blocked: the choice lasts for this visit only.
		}
	}

	/** Shown once per visit, the first time a redaction box is placed. */
	let note = $state('');
	let noteTimer: ReturnType<typeof setTimeout> | undefined;
	function showNote(msg: string) {
		clearTimeout(noteTimer);
		note = msg;
		noteTimer = setTimeout(() => (note = ''), 7000);
	}

	let armed = $state<Tool | null>(null);
	let armedAsset = $state.raw<Asset | null>(null);
	let padOpen = $state(false);
	let padKind = $state<'signature' | 'initials'>('signature');
	let padByKeyboard = false;

	const armedHint = $derived.by(() => {
		if (!armed) return '';
		const what = TOOLS.find((t) => t.id === armed)!.label.toLowerCase();
		const verb = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click';
		if (armed === 'highlight') return `Drag over what to highlight, or ${verb.toLowerCase()} for a box. Press Escape when done.`;
		if (armed === 'redact') return `Drag over what to remove, or ${verb.toLowerCase()} for a box. Press Escape when done.`;
		return isMark(armed) ? `${verb} each spot to place a ${what} mark. Press Escape when done.` : `${verb} the page where the ${what} goes.`;
	});

	function toolClick(t: Tool, e: MouseEvent) {
		finishEditing(true);
		const byKeyboard = e.detail === 0;
		if (armed === t) {
			disarm();
			return;
		}
		if (t === 'signature' || t === 'initials') {
			padKind = t;
			padByKeyboard = byKeyboard;
			padOpen = true;
			return;
		}
		armed = t;
		armedAsset = null;
		void tick().then(() => revealTool(t));
		if (byKeyboard) {
			// No pointer to aim with: place in the middle, selected, so arrow keys move it.
			place(t, { x: 0.5, y: 0.5 }, true);
		} else announce(armedHint);
	}

	function onPicked(asset: Asset) {
		armed = padKind;
		armedAsset = asset;
		if (padByKeyboard) {
			void tick().then(() => place(padKind, { x: 0.5, y: 0.5 }, true));
		} else announce(armedHint);
	}

	function disarm() {
		if (!armed) return;
		armed = null;
		armedAsset = null;
	}

	function onTap(f: Point) {
		const inside = f.x >= 0 && f.x <= 1 && f.y >= 0 && f.y <= 1;
		if (editing) {
			finishEditing(false);
			return;
		}
		if (armed && inside) place(armed, f, false);
		else select(null);
	}

	/** Default text size: 11 pt on the page, as a fraction of its displayed height. */
	const textSize = $derived(Math.min(0.05, Math.max(0.006, 11 / (ptSize?.height ?? 792))));

	function place(t: Tool, f: Point, byKeyboard: boolean) {
		if (!page) return;
		const pid = page.id;
		const label = TOOLS.find((x) => x.id === t)!.label;
		if (t === 'signature' || t === 'initials') {
			const asset = armedAsset;
			if (!asset) return;
			const sz = imageBoxSize(asset.width, asset.height, aspect, t === 'signature' ? 0.25 : 0.1);
			const box = boxAround(f, sz.width, sz.height);
			const id = store.transaction(`Place ${label.toLowerCase()}`, () => {
				if (!store.state.assets.some((a) => a.id === asset.id)) store.addAsset(asset);
				return store.addStamp(pid, { kind: 'image', assetId: asset.id, box });
			});
			disarm();
			select(id, byKeyboard);
			announce(`${label} placed.`);
		} else if (isMark(t)) {
			const sz = squareBoxSize(aspect, 0.026);
			const id = store.addStamp(pid, { kind: 'mark', mark: t, box: boxAround(f, sz.width, sz.height) });
			if (byKeyboard) {
				disarm();
				select(id, true);
			}
			announce(`${label} placed.`);
		} else if (t === 'date') {
			const text = new Date().toLocaleDateString();
			const size = textSize;
			const id = store.addStamp(pid, { kind: 'text', text, size, color: 'black', ...textOrigin(f, size) });
			disarm();
			select(id, byKeyboard);
			announce(`Date placed: ${text}. Press Enter to edit it.`);
			void tick().then(() => clampText(id));
		} else if (isDrawn(t)) {
			const sz = defaultBoxSize();
			addBox(t, boxAround(f, sz.width, sz.height), byKeyboard);
		} else if (t === 'text') {
			disarm();
			const size = textSize;
			gestureBegin('Add text');
			// Starts as a selected placeholder, so the box is visible and typing replaces it.
			const id = store.addStamp(pid, { kind: 'text', text: PLACEHOLDER, size, color: 'black', ...textOrigin(f, size) });
			selectedId = id;
			editing = { id, isNew: true };
			untouched = true;
			zoomToText(f.x, f.y, size);
			// Focus inside the tap itself, or phones will not bring up the keyboard.
			flushSync();
			void tick().then(() => clampText(id));
			announce('Type your text. Press Escape when done.');
		}
	}

	/** Add a highlight or redaction box. The tool stays armed, except on the keyboard path. */
	function addBox(t: 'highlight' | 'redact', box: StampBox, byKeyboard: boolean) {
		if (!page) return;
		const pid = page.id;
		const ns: NewStamp = t === 'highlight' ? { kind: 'highlight', color: hlColor, box } : { kind: 'redact', box };
		const id = store.transaction(t === 'highlight' ? 'Add highlight' : 'Add redaction', () => store.addStamp(pid, ns));
		if (byKeyboard) {
			disarm();
			select(id, true);
		} else select(id);
		announce(t === 'highlight' ? `Highlight placed, ${hlColor}.` : 'Redaction placed.');
		if (t === 'redact' && !redactNoteShown) {
			redactNoteShown = true;
			showNote('Redacted areas are removed from the file when you export, not just covered.');
		}
	}

	/** Text placed so the middle of its first line sits on the tapped point. */
	function textOrigin(f: Point, size: number) {
		return { x: Math.min(Math.max(0, f.x), 0.98), y: Math.min(Math.max(0, f.y - (1.2 * size) / 2), 1 - 1.2 * size) };
	}

	// ------------------------------------------------------------ selection
	let selectedId = $state<string | null>(null);
	const selected = $derived<Stamp | undefined>(page?.stamps.find((s) => s.id === selectedId));
	let layer: HTMLDivElement | undefined = $state();

	$effect(() => {
		if (selectedId && !selected && !editing) selectedId = null;
	});

	function stampEl(id: string): HTMLElement | null {
		return layer?.querySelector<HTMLElement>(`[data-stamp="${CSS.escape(id)}"]`) ?? null;
	}

	function select(id: string | null, focus = false) {
		if (id !== selectedId) finishEditing(true);
		selectedId = id;
		if (id && focus) void tick().then(() => stampEl(id)?.focus());
	}

	/** Displayed box of any stamp, as page fractions (text is measured). */
	function boxOf(s: Stamp): StampBox {
		if (s.kind !== 'text') return s.box;
		const el = stampEl(s.id);
		const pw = base.width * view.zoom;
		const ph = base.height * view.zoom;
		const w = el ? el.offsetWidth / pw : 0.1;
		const h = el ? el.offsetHeight / ph : s.size * 1.2;
		return { x: s.x, y: s.y, w, h };
	}

	/** Keep a text stamp inside the page after its text or size changed. */
	function clampText(id: string) {
		const s = page?.stamps.find((x) => x.id === id);
		if (!s || s.kind !== 'text' || !page) return;
		const b = clampBox(boxOf(s));
		if (Math.abs(b.x - s.x) > 1e-6 || Math.abs(b.y - s.y) > 1e-6) store.updateStamp(page.id, id, { x: b.x, y: b.y });
	}

	function gestureBegin(label: string) {
		clearTimeout(nudgeTimer);
		nudging = false;
		if (store.gestureActive) store.commitGesture();
		store.beginGesture(label);
	}

	// ------------------------------------------------------------ dragging stamps and handles
	interface Drag {
		id: string;
		pointerId: number;
		kind: 'move' | 'resize';
		handle?: Handle;
		start: Point;
		startPx: Point;
		box: StampBox;
		size: number;
		moved: boolean;
		wasSelected: boolean;
		/** Started on the move grip: a tap there never opens the text. */
		grip: boolean;
	}
	let drag: Drag | null = null;

	function stampDown(e: PointerEvent, s: Stamp, handle?: Handle, grip = false) {
		if (e.pointerType === 'mouse' && e.button !== 0) return;
		e.stopPropagation();
		if (editing?.id === s.id && !handle) return; // clicks inside the text box place the caret
		e.preventDefault();
		const wasSelected = selectedId === s.id;
		if (editing && editing.id !== s.id) finishEditing(true);
		selectedId = s.id;
		(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
		stampEl(s.id)?.focus({ preventScroll: true });
		drag = {
			id: s.id,
			pointerId: e.pointerId,
			kind: handle ? 'resize' : 'move',
			handle,
			start: toFraction(e),
			startPx: { x: e.clientX, y: e.clientY },
			box: boxOf(s),
			size: s.kind === 'text' ? s.size : 0,
			moved: false,
			wasSelected,
			grip
		};
	}

	function stampMove(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId || !page) return;
		e.stopPropagation();
		if (!drag.moved) {
			if (Math.hypot(e.clientX - drag.startPx.x, e.clientY - drag.startPx.y) < 4) return;
			const s = page.stamps.find((x) => x.id === drag!.id);
			if (!s) return;
			drag.moved = true;
			gestureBegin(`${drag.kind === 'move' ? 'Move' : 'Resize'} ${stampName(s, assets).toLowerCase().replace(/^text ".*"$/, 'text')}`);
		}
		const f = toFraction(e);
		const s = page.stamps.find((x) => x.id === drag!.id);
		if (!s) return;
		let next: StampBox;
		if (drag.kind === 'move') next = moveBox(drag.box, f.x - drag.start.x, f.y - drag.start.y);
		else {
			// Move the dragged corner by the pointer's travel, so grabbing a handle never jumps.
			const h = drag.handle!;
			const cx = h === 'nw' || h === 'sw' ? drag.box.x : drag.box.x + drag.box.w;
			const cy = h === 'nw' || h === 'ne' ? drag.box.y : drag.box.y + drag.box.h;
			next = resizeBox(drag.box, h, { x: cx + f.x - drag.start.x, y: cy + f.y - drag.start.y }, s.kind !== 'highlight' && s.kind !== 'redact');
		}
		if (s.kind === 'text') {
			if (drag.kind === 'move') store.updateStamp(page.id, s.id, { x: next.x, y: next.y });
			else {
				const scale = drag.box.w > 0 ? next.w / drag.box.w : 1;
				store.updateStamp(page.id, s.id, { x: next.x, y: next.y, size: Math.min(0.5, Math.max(0.004, drag.size * scale)) });
			}
		} else store.updateStamp(page.id, s.id, { box: next });
	}

	function stampUp(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		e.stopPropagation();
		const d = drag;
		drag = null;
		if (d.moved) {
			if (store.gestureActive) store.commitGesture();
			const s = page?.stamps.find((x) => x.id === d.id);
			if (s?.kind === 'text') clampText(s.id);
			if (s) announce(`${stampName(s, assets)} ${d.kind === 'move' ? 'moved' : 'resized'}.`);
		} else if (d.wasSelected && d.kind === 'move' && !d.grip) {
			const s = page?.stamps.find((x) => x.id === d.id);
			if (s?.kind === 'text') startEditing(s.id);
		}
	}

	function stampCancel(e: PointerEvent) {
		if (!drag || e.pointerId !== drag.pointerId) return;
		if (drag.moved && store.gestureActive) store.cancelGesture();
		drag = null;
	}

	// ------------------------------------------------------------ keyboard on stamps
	let nudging = $state(false);

	function stampKey(e: KeyboardEvent, s: Stamp) {
		if (editing?.id === s.id || !page) return;
		const dir = arrowDelta(e.key);
		if (dir) {
			e.preventDefault();
			e.stopPropagation();
			clearTimeout(nudgeTimer);
			if (!nudging) {
				gestureBegin(`Move ${stampName(s, assets).toLowerCase().replace(/^text ".*"$/, 'text')}`);
				nudging = true;
			}
			const step = nudgeStep(e.shiftKey);
			const b = moveBox(boxOf(s), dir.x * step, dir.y * step);
			if (s.kind === 'text') store.updateStamp(page.id, s.id, { x: b.x, y: b.y });
			else store.updateStamp(page.id, s.id, { box: b });
			return;
		}
		if (e.key === 'Delete' || e.key === 'Backspace') {
			e.preventDefault();
			e.stopPropagation();
			removeSelected();
		} else if (e.key === 'Enter' && s.kind === 'text') {
			e.preventDefault();
			e.stopPropagation();
			startEditing(s.id);
		} else if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			selectedId = null;
			viewportFocus();
		}
	}

	let nudgeTimer: ReturnType<typeof setTimeout> | undefined;

	/** Arrow presses in quick succession are one undo step. */
	function nudgeKeyUp() {
		clearTimeout(nudgeTimer);
		if (nudging) nudgeTimer = setTimeout(endNudge, 600);
	}

	function endNudge() {
		clearTimeout(nudgeTimer);
		if (nudging) {
			nudging = false;
			if (store.gestureActive) store.commitGesture();
		}
	}

	/**
	 * After a touch tap the browser sends a late mousedown, which would move focus
	 * from the text box just opened to the viewport, and typing would go nowhere.
	 */
	function keepTextFocus(e: MouseEvent) {
		if (editing && e.target !== textarea && !onField(e.target)) e.preventDefault();
	}

	function viewportFocus() {
		vp?.focus({ preventScroll: true });
	}

	// ------------------------------------------------------------ actions on the selection
	function removeSelected() {
		endNudge();
		const s = selected;
		if (!s || !page) return;
		finishEditing(true);
		const name = stampName(s, assets);
		const list = page.stamps;
		const i = list.findIndex((x) => x.id === s.id);
		store.removeStamp(page.id, s.id);
		selectedId = null;
		announce(`${name} deleted.`);
		const neighbour = list[i + 1] ?? list[i - 1];
		if (neighbour && neighbour.id !== s.id) select(neighbour.id, true);
		else viewportFocus();
	}

	function duplicateSelected() {
		endNudge();
		const s = selected;
		if (!s || !page) return;
		finishEditing(true);
		const off = 0.02;
		let ns: NewStamp;
		if (s.kind === 'text') {
			const { id: _id, ...rest } = s;
			const b = clampBox({ ...boxOf(s), x: s.x + off, y: s.y + off });
			ns = { ...rest, x: b.x, y: b.y };
		} else {
			const { id: _id, ...rest } = s;
			ns = { ...rest, box: moveBox(s.box, off, off) } as NewStamp;
		}
		const id = store.transaction('Duplicate stamp', () => store.addStamp(page!.id, ns));
		select(id, true);
		announce(`${stampName(s, assets)} duplicated.`);
	}

	function setColor(color: 'black' | 'blue' | 'red') {
		endNudge();
		if (selected?.kind !== 'text' || !page) return;
		store.updateStamp(page.id, selected.id, { color });
	}

	function setHighlightColor(color: HighlightColor) {
		endNudge();
		if (selected?.kind !== 'highlight' || !page) return;
		store.updateStamp(page.id, selected.id, { color });
		rememberHl(color);
	}

	function resizeText(factor: number) {
		endNudge();
		if (selected?.kind !== 'text' || !page) return;
		const id = selected.id;
		store.updateStamp(page.id, id, { size: Math.min(0.5, Math.max(0.004, selected.size * factor)) });
		void tick().then(() => clampText(id));
	}

	const fontPt = $derived(selected?.kind === 'text' && ptSize ? Math.round(selected.size * ptSize.height * 10) / 10 : 0);

	let copyOpen = $state(false);
	function copyTo(indices: number[]) {
		endNudge();
		const s = selected;
		if (!s || !page) return;
		const name = stampName(s, assets);
		const n = indices.length;
		store.transaction(`Copy ${name.toLowerCase().replace(/^text ".*"$/, 'text')} to ${n} ${n === 1 ? 'page' : 'pages'}`, () => {
			for (const i of indices) {
				const target = store.state.pages[i];
				if (!target) continue;
				const ts = store.displayedSize(target);
				const ta = ts && ts.height > 0 ? ts.width / ts.height : aspect;
				store.addStamp(target.id, stampForPage(s, aspect, ta));
			}
		});
		announce(`${name} copied to ${n} ${n === 1 ? 'page' : 'pages'}.`);
	}

	// ------------------------------------------------------------ text editing
	let editing = $state<{ id: string; isNew: boolean } | null>(null);
	let textarea: HTMLTextAreaElement | undefined = $state();
	const PLACEHOLDER = 'Text';
	/** A new text box still holds the placeholder: nothing was typed. */
	let untouched = false;
	let badChars = $state('');
	let checkSeq = 0;
	const editingStamp = $derived(editing ? page?.stamps.find((s) => s.id === editing!.id) : undefined);

	let viewBeforeText: View | null = null;

	/** Text smaller than about 14 px on screen is hard to edit (phones): zoom in on it. */
	function zoomToText(x: number, y: number, size: number) {
		const px = size * base.height * view.zoom;
		const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
		if (px >= (coarse ? 14 : 9) || px <= 0) return;
		viewBeforeText = { ...view };
		const anchor = { x: view.panX + x * base.width * view.zoom, y: view.panY + y * base.height * view.zoom };
		const z = clampZoom(view.zoom * (16 / px));
		const v = zoomAt(view, base, z, anchor);
		// Then bring the start of the text to the left third and upper part of the viewport.
		const sx = v.panX + x * base.width * z;
		const sy = v.panY + y * base.height * z;
		setView({ ...v, panX: v.panX + (vpW * 0.15 - sx), panY: v.panY + (vpH * 0.3 - sy) });
	}

	function startEditing(id: string) {
		if (!page) return;
		const s = page.stamps.find((x) => x.id === id);
		if (s?.kind !== 'text') return;
		gestureBegin('Edit text');
		selectedId = id;
		editing = { id, isNew: false };
		zoomToText(s.x, s.y, s.size);
		badChars = '';
	}

	$effect(() => {
		if (editing && textarea) {
			const ta = textarea;
			ta.focus({ preventScroll: true });
			if (editing.isNew) ta.select();
			else ta.setSelectionRange(ta.value.length, ta.value.length);
		}
	});

	function onTextInput(e: Event) {
		if (!editing || !page) return;
		const text = (e.currentTarget as HTMLTextAreaElement).value;
		untouched = false;
		store.updateStamp(page.id, editing.id, { text });
		const id = editing.id;
		void tick().then(() => clampText(id));
		void checkText(text);
	}

	async function checkText(text: string): Promise<string> {
		const seq = ++checkSeq;
		let bad = '';
		try {
			bad = await app.engine.unsupportedChars(text);
		} catch {
			bad = '';
		}
		if (seq === checkSeq) badChars = bad;
		return bad;
	}

	function stripBad() {
		if (!editing || !page || !editingStamp || editingStamp.kind !== 'text') return;
		const bad = new Set([...badChars]);
		const text = [...editingStamp.text.normalize('NFC')].filter((c) => !bad.has(c)).join('');
		store.updateStamp(page.id, editing.id, { text });
		badChars = '';
		textarea?.focus();
	}

	/**
	 * Leave text editing. `force` (page change, Done, another action) never keeps
	 * the editor open: characters the font cannot draw are dropped.
	 */
	function finishEditing(force: boolean) {
		if (!editing || !page) return;
		if (badChars && !force) {
			announce(`These characters cannot be used: ${badChars}`);
			textarea?.focus();
			return;
		}
		if (badChars) stripBad();
		const ed = editing;
		const s = page.stamps.find((x) => x.id === ed.id);
		editing = null;
		if (viewBeforeText) {
			view = viewBeforeText;
			viewBeforeText = null;
		}
		badChars = '';
		const empty = !s || s.kind !== 'text' || s.text.replace(/\s/g, '') === '' || (ed.isNew && untouched);
		untouched = false;
		if (ed.isNew && empty) {
			if (store.gestureActive) store.cancelGesture();
			selectedId = null;
			return;
		}
		if (empty && s) store.removeStamp(page.id, s.id);
		if (store.gestureActive) store.commitGesture();
		if (empty) {
			selectedId = null;
			announce('Empty text removed.');
		} else {
			announce('Text saved.');
			void tick().then(() => stampEl(ed.id)?.focus({ preventScroll: true }));
		}
	}

	async function commitEditing() {
		if (!editingStamp || editingStamp.kind !== 'text') return finishEditing(false);
		await checkText(editingStamp.text);
		finishEditing(false);
	}

	function textKey(e: KeyboardEvent) {
		e.stopPropagation();
		if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) {
			e.preventDefault();
			void commitEditing();
		}
	}

	$effect(() => {
		if (page?.stamps.some((s) => s.kind === 'text') || editing) void ensureStampFont();
	});

	// ------------------------------------------------------------ form fields
	const fields = $derived<readonly FormField[]>(formFieldsOf(app.engine, source) ?? []);
	const formVals = $derived(source ? doc.state.formValues[source.id] : undefined);
	/** The answers the page bitmap was last drawn with (see FormLayer). */
	let drawnVals = $state.raw<Readonly<Record<string, FormValue>> | undefined>(undefined);
	const groupId = `pf${Math.random().toString(36).slice(2, 8)}`;
	/** A field is focused: the view may be panned off its usual place to keep it in sight. */
	let fieldFocused = false;
	let focusedBox: StampBox | null = null;

	function setField(field: FormField, value: FormValue) {
		if (!source) return;
		if (editing) finishEditing(true);
		endNudge();
		store.setFormValue(source.id, field.name, value);
	}

	/** Visible part of the viewport, in viewport px: the on-screen keyboard can cover its bottom. */
	function visibleArea() {
		const r = vp!.getBoundingClientRect();
		const vv = window.visualViewport;
		const bottom = vv ? Math.min(r.height, vv.offsetTop + vv.height - r.top) : r.height;
		const top = vv ? Math.max(0, vv.offsetTop - r.top) : 0;
		return { left: 0, top, right: r.width, bottom: Math.max(top + 1, bottom) };
	}

	function revealField(box: StampBox) {
		if (!vp) return;
		const next = panToReveal(view, base, box, visibleArea(), 12);
		if (next !== view) view = next;
	}

	function onFieldFocus(box: StampBox) {
		if (editing) finishEditing(true);
		endNudge();
		selectedId = null;
		fieldFocused = true;
		focusedBox = box;
		revealField(box);
	}

	function onFieldBlur() {
		fieldFocused = false;
		focusedBox = null;
		// Leaving the fields: bring the page back where it belongs if keeping a field in view moved it.
		setTimeout(() => {
			if (!fieldFocused) setView(view);
		}, 0);
	}

	// The on-screen keyboard opening or closing changes what is visible.
	$effect(() => {
		const vv = window.visualViewport;
		if (!vv) return;
		const onResize = () => {
			if (fieldFocused && focusedBox) revealField(focusedBox);
		};
		vv.addEventListener('resize', onResize);
		return () => vv.removeEventListener('resize', onResize);
	});

	// Browsers scroll clipped boxes to show a focused control (Tab, the keyboard).
	// The page is placed by `view`, so turn any such scroll into a pan and undo it.
	function absorbScroll(e: Event) {
		const el = e.currentTarget as HTMLElement;
		if (el.scrollTop === 0 && el.scrollLeft === 0) return;
		view = { ...view, panX: view.panX - el.scrollLeft, panY: view.panY - el.scrollTop };
		el.scrollTop = 0;
		el.scrollLeft = 0;
	}

	/** A redaction here hides a field that also shows on another page. */
	const echo = $derived(page && fields.length ? redactionEcho(pages, index, fields) : null);

	// ------------------------------------------------------------ navigation, history, close
	function go(delta: number) {
		const next = pages[index + delta];
		if (!next) return;
		finishEditing(true);
		endNudge();
		selectedId = null;
		currentId = next.id;
		announce(`Page ${index + delta + 1} of ${pages.length}.`);
	}

	function undo() {
		finishEditing(true);
		endNudge();
		if (store.undoToken === undoMark) {
			if (store.canUndo) announce('Nothing to undo on this page. Changes made before opening it can be undone in the page grid.');
			return;
		}
		if (store.undo()) announce(`Undid: ${store.state.lastEvent?.label ?? ''}`);
	}

	function redo() {
		finishEditing(true);
		endNudge();
		if (store.redoToken === redoMark) return;
		if (store.redo()) announce(`Redid: ${store.state.lastEvent?.label ?? ''}`);
	}

	function done() {
		finishEditing(true);
		endNudge();
		onclose();
	}

	const typingTarget = (t: EventTarget | null) =>
		t instanceof HTMLElement &&
		(t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);

	function onKey(e: KeyboardEvent) {
		if (padOpen || copyOpen) return;
		if (root && e.key === 'Tab') trapTab(e, root);
		if (typingTarget(e.target)) return;
		const mod = e.ctrlKey || e.metaKey;
		const k = e.key.toLowerCase();
		if (mod && k === 'z') {
			e.preventDefault();
			if (e.shiftKey) redo();
			else undo();
		} else if (mod && k === 'y') {
			e.preventDefault();
			redo();
		} else if (mod && k === 'd') {
			e.preventDefault();
			duplicateSelected();
		} else if (e.key === 'Escape') {
			if (armed) {
				e.preventDefault();
				disarm();
				announce('Tool put away.');
			} else if (selectedId) {
				e.preventDefault();
				selectedId = null;
			}
		} else if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !selectedId)) {
			e.preventDefault();
			go(1);
		} else if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !selectedId)) {
			e.preventDefault();
			go(-1);
		} else if (!mod && (e.key === '+' || e.key === '=')) {
			zoomBy(1.25);
		} else if (!mod && e.key === '-') {
			zoomBy(0.8);
		} else if (!mod && e.key === '0') {
			fit();
		} else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
			e.preventDefault();
			removeSelected();
		}
	}

	function onKeyUp(e: KeyboardEvent) {
		if (arrowDelta(e.key)) nudgeKeyUp();
	}

	// ------------------------------------------------------------ focus in and out
	let root: HTMLDivElement | undefined = $state();
	onMount(() => {
		const opener = document.activeElement as HTMLElement | null;
		root?.focus({ preventScroll: true });
		const prevOverflow = document.documentElement.style.overflow;
		document.documentElement.style.overflow = 'hidden';
		return () => {
			clearTimeout(noteTimer);
			document.documentElement.style.overflow = prevOverflow;
			if (store.gestureActive) store.commitGesture();
			if (opener && opener.isConnected) opener.focus({ preventScroll: true });
		};
	});

	// ------------------------------------------------------------ tool bar (scrolls sideways on phones)
	let toolsEl: HTMLDivElement | undefined = $state();
	let fadeStart = $state(false);
	let fadeEnd = $state(false);

	function updateFades() {
		const el = toolsEl;
		if (!el) return;
		const max = el.scrollWidth - el.clientWidth;
		fadeStart = max > 1 && el.scrollLeft > 1;
		fadeEnd = max > 1 && el.scrollLeft < max - 1;
	}

	$effect(() => {
		const el = toolsEl;
		if (!el) return;
		updateFades();
		const ro = new ResizeObserver(updateFades);
		ro.observe(el);
		return () => ro.disconnect();
	});

	/** Bring an armed tool fully into view in a bar that scrolls sideways. */
	function revealTool(t: Tool) {
		const el = toolsEl;
		const btn = el?.querySelector<HTMLElement>(`[data-tool="${t}"]`);
		if (!el || !btn || el.scrollWidth <= el.clientWidth + 1) return;
		const pad = 24;
		const left = btn.offsetLeft - el.offsetLeft;
		const right = left + btn.offsetWidth;
		let to = el.scrollLeft;
		if (left - pad < el.scrollLeft) to = left - pad;
		else if (right + pad > el.scrollLeft + el.clientWidth) to = right + pad - el.clientWidth;
		if (to !== el.scrollLeft) el.scrollTo({ left: to, behavior: 'smooth' });
	}

	/** Stamps in the order the export draws them (redaction, highlights, the rest). */
	const ordered = $derived(page ? paintOrder(page.stamps) : []);

	/** One resize handle, set off from the stamp so it never covers small text or marks. */
	const RESIZE: Handle = 'se';
	const zoomLabel = $derived(`${Math.round(view.zoom * 100)}%`);
</script>

<svelte:window onkeydown={onKey} onkeyup={onKeyUp} />

<div
	bind:this={root}
	class="editor"
	role="dialog"
	aria-modal="true"
	aria-label={`Edit page ${index + 1} of ${pages.length}`}
	tabindex="-1"
>
	<header class="top">
		<div class="nav">
			<IconButton icon="chevron-left" label="Previous page" shortcut="PageUp" tooltip="bottom" disabled={index <= 0} onclick={() => go(-1)} />
			<span class="indicator" aria-live="polite"><span class="num">{index + 1}</span> of <span class="num">{pages.length}</span></span>
			<IconButton icon="chevron-right" label="Next page" shortcut="PageDown" tooltip="bottom" disabled={index >= pages.length - 1} onclick={() => go(1)} />
		</div>
		<div class="history">
			<IconButton icon="undo" label="Undo" shortcut="Ctrl+Z" tooltip="bottom" disabled={!canUndoHere && !editing && !nudging} onclick={undo} />
			<IconButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" tooltip="bottom" disabled={!canRedoHere} onclick={redo} />
		</div>
		<div class="zoom">
			<IconButton icon="zoom-out" label="Zoom out" shortcut="-" tooltip="bottom" disabled={view.zoom <= 1.0001} onclick={() => zoomBy(0.8)} />
			<button type="button" class="zoom-level" aria-label={`Zoom ${zoomLabel}. Fit page`} onclick={fit}>{zoomLabel}</button>
			<IconButton icon="zoom-in" label="Zoom in" shortcut="+" tooltip="bottom" disabled={view.zoom >= 5.999} onclick={() => zoomBy(1.25)} />
		</div>
		<Button variant="primary" onclick={done}>Done</Button>
	</header>

	<div
		class="tools"
		class:fade-start={fadeStart}
		class:fade-end={fadeEnd}
		role="toolbar"
		aria-label="Tools"
		bind:this={toolsEl}
		onscroll={updateFades}
	>
		{#each TOOLS as t (t.id)}
			<button
				type="button"
				class="tool"
				aria-pressed={armed === t.id}
				data-tool={t.id}
				onclick={(e) => toolClick(t.id, e)}
			>
				<Icon name={t.icon} />
				<span>{t.label}</span>
			</button>
		{/each}
	</div>

	<div class="main">
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions (mousedown only guards focus) -->
		<div
			bind:this={vp}
			bind:clientWidth={vpW}
			bind:clientHeight={vpH}
			class="viewport"
			class:armed={!!armed}
			role="group"
			aria-label={`Page ${index + 1}. ${armed ? armedHint : 'Choose a tool to add a stamp. Pinch or Ctrl+scroll to zoom.'}`}
			tabindex="0"
			onpointerdown={vpDown}
			onpointermove={vpMove}
			onpointerup={vpUp}
			onpointercancel={vpCancel}
			onmousedown={keepTextFocus}
			onscroll={absorbScroll}
		>
			{#if page && source}
				<div class="page" style={pageStyle} data-testid="editor-page">
					<PageCanvas
						{source}
						pageIndex={page.pageIndex}
						rotation={page.rotation}
						renderer={app.renderer}
						alt={`Page ${index + 1}`}
						formValues={formVals}
						onrender={(v) => (drawnVals = v)}
					/>
					{#if fields.length && source.pages[page.pageIndex]}
						<FormLayer
							{fields}
							pageIndex={page.pageIndex}
							rotation={page.rotation}
							pagePt={source.pages[page.pageIndex]}
							pagePx={{ width: base.width * view.zoom, height: base.height * view.zoom }}
							values={formVals}
							drawn={drawnVals}
							passthrough={!!armed}
							group={groupId}
							onset={setField}
							onfocusfield={onFieldFocus}
							onblurfield={onFieldBlur}
							onundo={undo}
							onredo={redo}
							onescape={viewportFocus}
						/>
					{/if}
					<div class="layer" bind:this={layer} class:passthrough={!!armed}>
						{#each ordered as s (s.id)}
							{@const isSel = s.id === selectedId}
							{@const isEdit = editing?.id === s.id}
							<StampShape
								stamp={s}
								asset={s.kind === 'image' ? assetById.get(s.assetId) : undefined}
								{aspect}
								class="ed {isSel ? 'selected' : ''} {isEdit ? 'editing' : ''}"
								data-stamp={s.id}
								role="button"
								tabindex={0}
								aria-label={`${stampName(s, assets)}${isSel ? ', selected' : ''}`}
								aria-describedby="stamp-help"
								onpointerdown={(e: PointerEvent) => stampDown(e, s)}
								onpointermove={stampMove}
								onpointerup={stampUp}
								onpointercancel={stampCancel}
								onkeydown={(e: KeyboardEvent) => stampKey(e, s)}
								onfocus={() => {
									if (selectedId !== s.id && !drag) select(s.id);
								}}
								onblur={endNudge}
							>
								{#if isEdit && s.kind === 'text'}
									<textarea
										bind:this={textarea}
										class="text-input"
										value={s.text}
										wrap="off"
										spellcheck="false"
										autocomplete="off"
										aria-label="Text on the page"
										aria-invalid={badChars ? 'true' : undefined}
										aria-describedby={badChars ? 'bad-chars' : undefined}
										oninput={onTextInput}
										onkeydown={textKey}
										onpointerdown={(e) => e.stopPropagation()}
									></textarea>
								{/if}
								{#if isSel && !isEdit && !armed}
									<!-- Touch only (see CSS): a finger covers a small stamp, so moving gets its own grip. -->
									<span
										class="handle move"
										aria-hidden="true"
										data-handle="move"
										onpointerdown={(e) => stampDown(e, s, undefined, true)}
										onpointermove={stampMove}
										onpointerup={stampUp}
										onpointercancel={stampCancel}
									>
										<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
											<path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2" />
										</svg>
									</span>
									<span
										class="handle {RESIZE}"
										aria-hidden="true"
										data-handle={RESIZE}
										onpointerdown={(e) => stampDown(e, s, RESIZE)}
										onpointermove={stampMove}
										onpointerup={stampUp}
										onpointercancel={stampCancel}
									></span>
								{/if}
							</StampShape>
						{/each}
						{#if draft && isDrawn(armed)}
							<StampShape
								stamp={armed === 'highlight' ? { id: 'draft', kind: 'highlight', color: hlColor, box: draft } : { id: 'draft', kind: 'redact', box: draft }}
								{aspect}
								class="ed selected draft"
								data-testid="draft-box"
								aria-hidden="true"
							/>
						{/if}
					</div>
				</div>
			{/if}
		</div>

		{#if armed || note || echo}
			<div class="hints">
				{#if armed}<p class="armed-hint" role="status">{armedHint}</p>{/if}
				{#if note}
					<p class="armed-hint note" role="status" data-testid="editor-note">{note}</p>
				{/if}
				{#if echo}
					<p class="armed-hint warn" role="status" data-testid="form-echo">
						This field also appears on page {echo.pageNumber}. Redact it there too if it should be hidden.
					</p>
				{/if}
			</div>
		{/if}

		{#if editing && editingStamp?.kind === 'text'}
			<div class="selbar" role="toolbar" aria-label="Text">
				{#if badChars}
					<p id="bad-chars" class="bad" role="alert">Cannot use: <span class="chars">{[...badChars].join(' ')}</span></p>
					<Button variant="quiet" onclick={stripBad}>Remove them</Button>
				{/if}
				<Button variant="primary" onclick={() => void commitEditing()}>Done editing</Button>
			</div>
		{:else if selected}
			<div class="selbar" role="toolbar" aria-label={stampName(selected, assets)}>
				{#if selected.kind === 'text'}
					<div class="colors" role="radiogroup" aria-label="Text colour">
						{#each ['black', 'blue', 'red'] as const as c (c)}
							<button
								type="button"
								role="radio"
								class="color"
								aria-checked={selected.color === c}
								aria-label={c[0].toUpperCase() + c.slice(1)}
								style="--c: {cssColor(c)}"
								onclick={() => setColor(c)}
							></button>
						{/each}
					</div>
					<IconButton icon="zoom-out" label="Smaller text" onclick={() => resizeText(1 / 1.15)} />
					<span class="pt num" aria-label={`Size ${fontPt} points`}>{fontPt} pt</span>
					<IconButton icon="zoom-in" label="Larger text" onclick={() => resizeText(1.15)} />
					<Button variant="quiet" icon="text" onclick={() => startEditing(selected!.id)}>Edit</Button>
				{:else if selected.kind === 'highlight'}
					<div class="colors" role="radiogroup" aria-label="Highlight colour">
						{#each HIGHLIGHT_COLORS as c (c)}
							<button
								type="button"
								role="radio"
								class="color"
								aria-checked={selected.color === c}
								aria-label={c[0].toUpperCase() + c.slice(1)}
								style="--c: {HIGHLIGHT_CSS[c]}"
								onclick={() => setHighlightColor(c)}
							></button>
						{/each}
					</div>
				{/if}
				<IconButton icon="duplicate" label="Duplicate" shortcut="Ctrl+D" onclick={duplicateSelected} />
				{#if pages.length > 1}
					<Button variant="quiet" icon="extract" onclick={() => (copyOpen = true)}>Copy to pages…</Button>
				{/if}
				<IconButton icon="trash" label="Delete" shortcut="Delete" onclick={removeSelected} />
			</div>
		{/if}
	</div>

	<p id="stamp-help" class="sr">Arrow keys move it, Shift with arrows moves further, Delete removes it, Enter edits text.</p>
	<div class="sr" aria-live="polite" data-testid="live">{live}</div>
</div>

<SignaturePad bind:open={padOpen} kind={padKind} onpick={onPicked} {announce} />
{#if selected}
	<CopyDialog bind:open={copyOpen} pageCount={pages.length} current={index} what={stampName(selected, assets).toLowerCase()} oncopy={copyTo} />
{/if}

<style>
	.editor {
		position: fixed;
		inset: 0;
		z-index: 40;
		display: grid;
		grid-template-columns: auto 1fr;
		grid-template-rows: auto 1fr;
		grid-template-areas:
			'top top'
			'tools main';
		background: var(--desk);
		color: var(--ink);
		outline: none;
		overscroll-behavior: contain;
	}

	.top {
		grid-area: top;
		display: flex;
		align-items: center;
		gap: var(--s-3);
		min-height: var(--bar-h);
		padding: var(--safe-top) calc(var(--s-3) + var(--safe-right)) 0 calc(var(--s-3) + var(--safe-left));
		background: var(--surface);
		border-bottom: 1px solid var(--line);
	}

	.nav,
	.history,
	.zoom {
		display: flex;
		align-items: center;
		gap: 2px;
	}

	.nav {
		margin-right: auto;
	}

	.indicator {
		min-width: 4.5em;
		text-align: center;
		font-size: var(--text-control);
		color: var(--ink-soft);
	}

	.num {
		font-variant-numeric: tabular-nums;
		color: var(--ink);
	}

	.zoom-level {
		min-width: 3.6em;
		min-height: var(--control-h);
		border-radius: var(--radius-control);
		font-size: var(--text-caption);
		font-variant-numeric: tabular-nums;
		color: var(--ink-soft);
	}

	.zoom-level:hover {
		background: var(--hover);
	}

	.tools {
		grid-area: tools;
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: var(--s-2);
		background: var(--surface);
		border-right: 1px solid var(--line);
		overflow-y: auto;
		z-index: 2;
	}

	.tool {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 3px;
		width: 72px;
		min-height: 56px;
		border-radius: var(--radius-control);
		color: var(--ink);
		font-size: var(--text-caption);
	}

	.tool:hover {
		background: var(--hover);
	}

	.tool[aria-pressed='true'] {
		background: var(--accent);
		color: var(--accent-ink);
	}

	.main {
		grid-area: main;
		position: relative;
		overflow: hidden;
		min-width: 0;
		min-height: 0;
	}

	.viewport {
		position: absolute;
		inset: 0;
		overflow: hidden;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
		outline: none;
	}

	.viewport:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: -4px;
	}

	.viewport.armed {
		cursor: crosshair;
	}

	.page {
		position: absolute;
		background: var(--sheet);
		box-shadow: var(--shadow-page);
		border-radius: var(--radius-page);
	}

	.page :global(.sheet) {
		height: 100%;
	}

	.layer {
		position: absolute;
		inset: 0;
		container-type: size;
		/* Only the stamps take pointers, so form fields under the layer can be clicked. */
		pointer-events: none;
	}

	.layer :global(.ed:not(.draft)) {
		pointer-events: auto;
	}

	.layer.passthrough :global(.ed:not(.draft)) {
		pointer-events: none;
	}

	.layer :global(.ed) {
		cursor: move;
		outline: none;
		touch-action: none;
	}

	.layer :global(.ed::before) {
		content: '';
		position: absolute;
		inset: -6px;
	}

	@media (pointer: coarse) {
		.layer :global(.ed::before) {
			inset: -12px;
		}
	}

	.layer :global(.ed:focus-visible),
	.layer :global(.ed.selected) {
		box-shadow:
			0 0 0 1.5px var(--accent),
			0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
	}

	.layer :global(.ed.text.selected:not(.editing)) {
		box-shadow: none;
		outline: 1.5px solid var(--accent);
		outline-offset: 3px;
	}

	/* Redaction: solid black, see-through while selected or drawn so the user sees what it covers. */
	.layer :global(.ed.redact.selected .fill) {
		opacity: 0.75;
	}

	.layer :global(.ed.draft) {
		pointer-events: none;
	}

	.layer :global(.ed.draft::before) {
		content: none;
	}

	.layer :global(.ed.editing) {
		cursor: text;
		box-shadow: 0 0 0 1.5px var(--accent);
		min-width: 1em;
	}

	.layer :global(.ed.editing .txt) {
		visibility: hidden;
	}

	.text-input {
		position: absolute;
		left: 0;
		top: 0;
		width: calc(100% + 2em);
		height: 100%;
		margin: 0;
		padding: 0;
		border: 0;
		outline: none;
		background: transparent;
		font: inherit;
		line-height: inherit;
		color: inherit;
		letter-spacing: 0;
		white-space: pre;
		overflow: hidden;
		resize: none;
		font-kerning: none;
		font-variant-ligatures: none;
		font-feature-settings: inherit;
		caret-color: var(--accent);
		z-index: 1;
	}

	.handle {
		position: absolute;
		width: 12px;
		height: 12px;
		margin: -6px 0 0 -6px;
		background: var(--sheet);
		border: 2px solid var(--accent);
		border-radius: 2px;
		z-index: 2;
		touch-action: none;
	}

	.handle::before {
		content: '';
		position: absolute;
		inset: -10px;
	}

	@media (pointer: coarse) {
		.handle {
			width: 16px;
			height: 16px;
			margin: -8px 0 0 -8px;
			border-radius: 50%;
		}

		.handle::before {
			inset: -14px;
		}
	}

	.handle.se {
		left: calc(100% + 5px);
		top: calc(100% + 5px);
		cursor: nwse-resize;
	}

	.handle.move {
		display: none;
	}

	@media (pointer: coarse) {
		/* Touch targets stop at the stamp's edge, so a tap on the stamp is never taken by a handle. */
		.handle.se {
			left: calc(100% + 18px);
			top: calc(100% + 18px);
		}

		.handle.se::before {
			inset: -10px;
		}

		.handle.move {
			display: grid;
			place-items: center;
			left: -20px;
			top: -20px;
			width: 26px;
			height: 26px;
			margin: -13px 0 0 -13px;
			background: var(--accent);
			border-color: var(--accent);
			color: var(--sheet);
		}

		.handle.move::before {
			inset: -7px;
		}
	}

	.hints {
		position: absolute;
		top: var(--s-3);
		left: 50%;
		transform: translateX(-50%);
		display: grid;
		justify-items: center;
		gap: var(--s-2);
		width: max-content;
		max-width: calc(100% - 2 * var(--s-4));
		pointer-events: none;
		z-index: 3;
	}

	.armed-hint {
		padding: var(--s-2) var(--s-4);
		background: var(--ink);
		color: var(--surface);
		border-radius: 999px;
		font-size: var(--text-caption);
		box-shadow: var(--shadow-float);
		pointer-events: none;
		text-align: center;
	}

	.selbar {
		position: absolute;
		left: 50%;
		bottom: calc(var(--s-4) + var(--safe-bottom));
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 2px;
		max-width: calc(100% - 2 * var(--s-3));
		padding: var(--s-1) var(--s-2);
		background: var(--surface);
		border: 1px solid var(--line);
		border-radius: var(--radius-sheet);
		box-shadow: var(--shadow-float);
		overflow-x: auto;
		z-index: 3;
	}

	.colors {
		display: flex;
		gap: 2px;
		margin-right: var(--s-1);
	}

	.color {
		display: grid;
		place-items: center;
		width: var(--control-h);
		height: var(--control-h);
		border-radius: var(--radius-control);
	}

	.color::after {
		content: '';
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--c);
		box-shadow: 0 0 0 1px var(--line-strong);
	}

	.color[aria-checked='true'] {
		background: var(--press);
	}

	.color[aria-checked='true']::after {
		box-shadow:
			0 0 0 2px var(--surface),
			0 0 0 4px var(--ink);
	}

	.pt {
		min-width: 3.5em;
		text-align: center;
		font-size: var(--text-caption);
	}

	.bad {
		color: var(--danger);
		font-size: var(--text-control);
		padding: 0 var(--s-2);
		white-space: nowrap;
	}

	.chars {
		font-weight: 600;
	}

	.sr {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0 0 0 0);
		white-space: nowrap;
	}

	/* Phone and narrow windows: tools move to a bottom bar in thumb reach. */
	@media (max-width: 899px) {
		.editor {
			grid-template-columns: 1fr;
			grid-template-rows: auto 1fr auto;
			grid-template-areas:
				'top'
				'main'
				'tools';
		}

		.top {
			gap: var(--s-1);
		}

		.zoom {
			display: none;
		}

		/* Nine tools do not fit a phone: the bar scrolls sideways, with a soft fade on the side that has more. */
		.tools {
			flex-direction: row;
			justify-content: flex-start;
			padding: var(--s-1) calc(var(--s-1) + var(--safe-right)) calc(var(--s-1) + var(--safe-bottom))
				calc(var(--s-1) + var(--safe-left));
			border-right: 0;
			border-top: 1px solid var(--line);
			overflow-x: auto;
			overflow-y: hidden;
			overscroll-behavior-x: contain;
			-webkit-overflow-scrolling: touch;
			scrollbar-width: none;
			touch-action: pan-x;
			--fade-l: 0px;
			--fade-r: 0px;
			mask-image: linear-gradient(to right, transparent 0, #000 var(--fade-l), #000 calc(100% - var(--fade-r)), transparent 100%);
		}

		.tools::-webkit-scrollbar {
			display: none;
		}

		.tools.fade-start {
			--fade-l: 28px;
		}

		.tools.fade-end {
			--fade-r: 28px;
		}

		.tool {
			flex: 1 0 54px;
			width: auto;
			min-width: 48px;
			min-height: 56px;
			font-size: 11px;
		}

		.selbar {
			bottom: var(--s-3);
		}
	}
</style>
