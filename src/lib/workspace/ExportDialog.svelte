<script lang="ts">
	import type { EngineErrorShape, ExportProgress, ExportResult, PageId, VerifyCheck } from '../core/types';
	import type { DocStore } from '../doc/store';
	import type { EngineClient } from '../engine/client';
	import { isEngineErrorShape } from '../engine/errors';
	import Button from '../ui/Button.svelte';
	import Dialog from '../ui/Dialog.svelte';
	import Field from '../ui/Field.svelte';
	import Icon from '../ui/Icon.svelte';
	import Progress from '../ui/Progress.svelte';
	import Select from '../ui/Select.svelte';
	import Toggle from '../ui/Toggle.svelte';
	import OptionPicker from './OptionPicker.svelte';
	import WatermarkPreview from './WatermarkPreview.svelte';
	import { exportForm } from './export-form.svelte';
	import { OCR_HINT, OCR_LABEL, countScanned, isDesktop, ocrCapNotice, ocrSummary } from './ocr-option';
	import { PRINT_CAP_LABEL, countOversized, printCapHint, printCapLine } from './print-cap-option';
	import { progressFraction, progressSample, progressText } from './export-progress';
	import { TimeLeft } from './time-left';
	import { exportPictures, exportSplit, partIds, splitNotes } from './multi-export';
	import { limitWords, removedLine, unionLimits } from '../engine/limits';
	import {
		OUTPUT_CHOICES,
		QUALITY_CHOICES,
		deviceBudget,
		estimatePictures,
		pictureExportOptions,
		pictureName,
		picturesLine,
		qualityDpi,
		reducedLine,
		tooManyPictures
	} from './pictures-plan';
	import { SPLIT_RULES, openedFileCount, partName, partNumbering, planSplit, splitSummary } from './split-plan';
	import { untrack } from 'svelte';
	import {
		FIT_CHOICES,
		NUMBER_POSITIONS,
		NUMBER_SIZES,
		NUMBER_STYLES,
		buildExportOptions,
		blankFieldsLine,
		buildNumbering,
		buildWatermark,
		defaultFilename,
		filledBlankCount,
		formatBytes,
		formatMB,
		keepBlanksBlocked,
		nameBase,
		keepBlanksHint,
		normalizeFilename,
		numberingPreview,
		parseMegabytes,
		passwordProblem,
		plainCheck,
		plural,
		redactionCount,
		shrinkSummary,
		tagsLine,
		targetBytesFor,
		WATERMARK_COLORS,
		WATERMARK_LOOKS,
		WATERMARK_MAX,
		WATERMARK_PICKS,
		WATERMARK_STRENGTHS
	} from './logic';

	interface Props {
		open: boolean;
		/** 'extract': only `ids` (in document order). */
		mode: 'all' | 'extract';
		ids: readonly PageId[];
		store: DocStore;
		engine: EngineClient;
		/** The user saved or shared the file. `kind`: one PDF, a zip of split PDFs, or pictures. */
		onsaved: (info: { filename: string; mode: 'all' | 'extract'; kind: 'pdf' | 'split' | 'pictures' }) => void;
		onclose: () => void;
	}

	let { open = $bindable(false), mode, ids, store, engine, onsaved, onclose }: Props = $props();

	type Phase =
		| { kind: 'form' }
		| { kind: 'working'; fitting: string | null }
		| {
				kind: 'done';
				filename: string;
				inputBytes: number;
				url: string;
				blob: Blob;
				/** What was made: one PDF, a zip of PDFs, or pictures (one, or a zip). */
				made: 'pdf' | 'split' | 'pictures';
				checks: VerifyCheck[];
				pageCount: number;
				warnings: string[];
				/** The single PDF's result (made 'pdf' only). */
				result: ExportResult | null;
				headline: string;
				/** "12 pictures in one zip, 3.4 MB"; null for one PDF. */
				line: string | null;
				notes: string[];
				/** Split: one line per file made ("name-part-01.pdf: pages 1–2, 120 KB"). */
				files: string[];
			}
		| { kind: 'failed'; error: EngineErrorShape };

	let phase = $state<Phase>({ kind: 'form' });
	let filename = $state('');
	// Options stay as set when the dialog is reopened (and are saved with the session);
	// only the file name and password start fresh.
	const f = exportForm;
	let usePassword = $state(false);
	let password = $state('');
	let confirm = $state('');
	let showPassword = $state(false);
	let touched = $state(false);
	let saved = $state(false);

	const plan = $derived.by(() => {
		const s = store.state;
		const set = new Set(ids);
		const pages = mode === 'extract' ? s.pages.filter((p) => set.has(p.id)) : s.pages;
		const used = new Set(pages.map((p) => p.sourceId));
		const sources = s.sources.filter((x) => used.has(x.id));
		const names = pages
			.map((p) => s.sources.find((x) => x.id === p.sourceId))
			.filter((x) => x && x.kind !== 'blank')
			.map((x) => x!.name);
		return {
			pages,
			sources,
			openedFiles: openedFileCount(pages, s.sources),
			count: pages.length,
			inputBytes: sources.reduce((n, x) => n + x.originalSize, 0),
			names,
			encryptedInput: sources.some((x) => x.wasEncrypted),
			/** A source needed a password to open (sources from before Source.limits count as needing one). */
			passwordInput: sources.some((x) => x.wasEncrypted && (x.limits?.password ?? true)),
			/** What the encrypted originals limited, together ("Remove printing and copying limits"). */
			limits: unionLimits(sources.map((x) => x.limits)),
			hasForm: sources.some((x) => x.hasForm),
			redactions: redactionCount(pages),
			blanks: filledBlankCount(pages)
		};
	});

	// "Make scanned pages searchable": desktops only, and only when a page qualifies.
	const desktop = isDesktop();
	let scanned = $state(0);
	let scanSeq = 0;
	$effect(() => {
		const pages = plan.pages;
		const sources = store.state.sources;
		const seq = ++scanSeq;
		if (!open || !desktop) return;
		countScanned(engine, pages, sources).then((n) => {
			if (seq === scanSeq) scanned = n;
		});
	});
	// "Reduce oversized pictures": only when a page shows a picture with more pixels than a print needs.
	let oversized = $state(0);
	let capSeq = 0;
	$effect(() => {
		const pages = plan.pages;
		const sources = store.state.sources;
		const seq = ++capSeq;
		if (!open) return;
		countOversized(engine, pages, sources).then((n) => {
			if (seq === capSeq) oversized = n;
		});
	});
	let progress = $state<ExportProgress | null>(null);
	/** Split only: the engine's progress within the file being made (progress counts the files). */
	let step = $state<ExportProgress | null>(null);
	const stepText = $derived(progressText(progress));
	const innerText = $derived(progressText(step));
	// The remaining-time line ("About 30 seconds left"), from the progress the engine measures.
	let timeLeft: TimeLeft | null = null;
	let clock = $state(0);
	const leftText = $derived.by(() => {
		void progress;
		return phase.kind === 'working' && timeLeft ? timeLeft.text(clock) : null;
	});
	$effect(() => {
		if (phase.kind !== 'working') return;
		const id = setInterval(() => (clock = performance.now()), 1000);
		return () => clearInterval(id);
	});
	let abort = $state<AbortController | null>(null);
	let cancelled = $state(false);

	// Fresh defaults every time the dialog opens.
	let wasOpen = false;
	$effect(() => {
		if (open && !wasOpen) {
			cancelled = false;
			scanned = 0;
			oversized = 0;
			filename = defaultFilename(plan.names, mode);
			phase = { kind: 'form' };
			password = '';
			confirm = '';
			usePassword = false;
			showPassword = false;
			touched = false;
			saved = false;
		}
		if (!open && wasOpen) revoke();
		wasOpen = open;
	});
	// The file name's extension follows what will be saved (.pdf, .zip, .jpg, .png).
	let shownExt = '';
	$effect(() => {
		const ext = targetExt;
		if (!open) {
			shownExt = '';
			return;
		}
		if (ext === shownExt) return;
		shownExt = ext;
		filename = `${nameBase(untrack(() => filename))}.${ext}`;
	});

	const pwError = $derived(usePassword && touched ? passwordProblem(password) : null);
	const confirmError = $derived(
		usePassword && touched && !pwError && confirm !== password ? 'The two passwords do not match.' : null
	);
	const redacting = $derived(plan.redactions > 0);
	const blanksBlocked = $derived(keepBlanksBlocked(f, plan));
	const fitOk = $derived(!f.fit || targetBytesFor(f.fitChoice, f.fitOther) !== null);
	const fitError = $derived(f.fit && f.fitChoice === 'other' && !fitOk ? 'Enter a size from 0.1 to 500 MB.' : undefined);

	// Characters the stamp font cannot draw in the Bates prefix, checked by the engine.
	let badChars = $state('');
	let checkSeq = 0;
	$effect(() => {
		const prefix = f.number && f.style === 'bates' ? f.prefix : '';
		const seq = ++checkSeq;
		if (!prefix) {
			badChars = '';
			return;
		}
		engine
			.unsupportedChars(prefix)
			.catch(() => '')
			.then((bad) => {
				if (seq === checkSeq) badChars = bad;
			});
	});

	const numResult = $derived(f.number ? buildNumbering({ ...f, filename: '' }, plan.count) : null);
	const numProblem = $derived.by(() => {
		if (!numResult) return null;
		if ('problem' in numResult) return numResult.problem;
		if (badChars) return `The prefix has characters that cannot be printed: ${[...badChars].join(' ')}. Remove them.`;
		return null;
	});
	const numPreview = $derived(numResult && 'numbering' in numResult ? numberingPreview(numResult.numbering, plan.count) : '');

	// Watermark: the text is checked like the Bates prefix (characters the stamp font cannot draw).
	const wmResult = $derived(f.watermark ? buildWatermark(f) : null);
	let wmBad = $state('');
	let wmSeq = 0;
	$effect(() => {
		const text = wmResult && 'watermark' in wmResult ? wmResult.watermark.text : '';
		const seq = ++wmSeq;
		if (!text) {
			wmBad = '';
			return;
		}
		engine
			.unsupportedChars(text)
			.catch(() => '')
			.then((bad) => {
				if (seq === wmSeq) wmBad = bad;
			});
	});
	const wmProblem = $derived.by(() => {
		if (!wmResult) return null;
		if ('problem' in wmResult) return wmResult.problem;
		if (wmBad) return `The watermark has characters that cannot be printed: ${[...wmBad].join(' ')}. Remove them.`;
		return null;
	});
	/** The first exported page, for the preview. */
	const firstPage = $derived((plan.pages[0] && store.displayedSize(plan.pages[0])) ?? { width: 612, height: 792 });

	// What to save: a PDF (maybe split into several), or the pages as pictures.
	const pictures = $derived(f.output !== 'pdf');
	const pictureKind = $derived(f.output === 'png' ? 'png' : 'jpg');
	const dpi = $derived(qualityDpi(f.pictureQuality));
	const budget = deviceBudget();
	const estimate = $derived(pictures ? estimatePictures(plan.pages, plan.sources, pictureKind, dpi, budget) : null);
	const picturesProblem = $derived(estimate ? tooManyPictures(plan.count, estimate, budget, pictureKind, dpi) : null);
	const canSplit = $derived(!pictures && plan.count > 1);
	const splitRules = $derived(SPLIT_RULES.filter((r) => r.value !== 'files' || plan.openedFiles > 1));
	const splitRule = $derived(splitRules.some((r) => r.value === f.splitRule) ? f.splitRule : 'each');
	const splitting = $derived(canSplit && f.split);
	const split = $derived(splitting ? planSplit(plan.pages, plan.sources, splitRule, f.splitEvery, f.splitAt) : null);
	const splitProblem = $derived(split && !split.ok ? split.problem : null);
	const splitLine = $derived.by(() => {
		if (!split?.ok) return '';
		if (splitRule !== 'files') return splitSummary(split.parts);
		const kinds = new Map(plan.sources.map((x) => [x.id, x]));
		const names = split.parts.map((part) => {
			const own = part.find((i) => kinds.get(plan.pages[i].sourceId)?.kind !== 'blank') ?? part[0];
			return kinds.get(plan.pages[own].sourceId)?.name ?? 'pages';
		});
		return splitSummary(split.parts, names);
	});
	/** The extension the file name field shows. */
	const targetExt = $derived(pictures ? (plan.count === 1 ? pictureKind : 'zip') : splitting ? 'zip' : 'pdf');
	const zipContents = $derived.by(() => {
		const base = nameBase(filename);
		if (pictures && plan.count > 1) {
			return `A zip of ${pictureName(base, 0, plan.count, pictureKind)} to ${pictureName(base, plan.count - 1, plan.count, pictureKind)}, in page order.`;
		}
		if (split?.ok) {
			const n = split.parts.length;
			return `A zip of ${partName(base, 0, n)} to ${partName(base, n - 1, n)}.`;
		}
		return null;
	});

	const canExport = $derived(
		plan.count > 0 &&
			!numProblem &&
			!wmProblem &&
			(pictures
				? !picturesProblem
				: fitOk && !splitProblem && (!usePassword || (!passwordProblem(password) && confirm === password)))
	);

	function revoke() {
		if (phase.kind === 'done') URL.revokeObjectURL(phase.url);
	}

	async function run(e?: Event) {
		e?.preventDefault();
		touched = true;
		if (!canExport || phase.kind === 'working') return;
		const mkPictures = pictures;
		const mkSplit = !mkPictures && split?.ok ? split.parts : null;
		const name = mkPictures || mkSplit ? `${nameBase(filename)}.${targetExt}` : normalizeFilename(filename);
		filename = name;
		const built = buildExportOptions(
			{ ...f, filename: name, password: usePassword && !mkPictures ? password : undefined },
			{ pageCount: plan.count, redactions: plan.redactions, hasForm: plan.hasForm, blanks: plan.blanks, scanned }
		);
		if (!built.ok) return;
		const options = mkPictures ? pictureExportOptions(built.options) : built.options;
		const inputBytes = plan.inputBytes;
		// Said on the result of a PDF or split export: the limits of the files its pages came from are gone.
		const limitsLine = removedLine(plan.limits);
		const target = options.targetBytes;
		phase = {
			kind: 'working',
			fitting: target ? `Fitting ${mkSplit ? 'each file' : ''} under ${formatMB(target)}. Large scans can take a minute.`.replace('  ', ' ') : null
		};
		progress = null;
		step = null;
		timeLeft = new TimeLeft(performance.now());
		clock = performance.now();
		cancelled = false;
		const control = mkPictures || mkSplit || options.ocr || options.printCap ? new AbortController() : null;
		abort = control;
		const report = (p: ExportProgress) => {
			clock = performance.now();
			const sample = progressSample(p);
			// The PDF the pictures are drawn from is not the end of the job.
			if (sample && mkPictures && p.stage !== 'picture') sample.final = false;
			timeLeft?.update(clock, sample);
			progress = p;
		};
		try {
			const s = store.state;
			const sources = [...s.sources];
			const assets = [...s.assets];
			const exportPlan = engine.exportPlan.bind(engine);
			let done: Extract<Phase, { kind: 'done' }>;
			if (mkPictures) {
				const out = await exportPictures({
					exportPlan,
					plan: store.toExportPlan(options, mode === 'extract' ? ids : undefined),
					sources,
					assets,
					base: nameBase(name),
					kind: pictureKind,
					dpi,
					budget,
					signal: control?.signal,
					onProgress: report
				});
				const line = picturesLine(out.count, out.blob.size);
				const reduced = reducedLine(out.reduced, dpi);
				done = {
					kind: 'done',
					filename: out.filename,
					inputBytes,
					url: '',
					blob: out.blob,
					made: 'pictures',
					// The PDF behind the pictures never has a password: that line would only confuse.
					checks: out.checks.filter((c) => c.name !== 'encryption'),
					pageCount: out.pageCount,
					warnings: out.warnings,
					result: null,
					files: [],
					headline: headline(out.checks, out.pageCount),
					line,
					notes: [
						`Drawn at ${dpi} dpi from the checked PDF, so they show exactly what it shows.`,
						...(reduced ? [reduced] : [])
					]
				};
			} else if (mkSplit) {
				const numbering = options.numbering ? partNumbering(options.numbering, mkSplit) : null;
				const groups = partIds(plan.pages, mkSplit);
				const plans = groups.map((g, i) => {
					const o = { ...options, numbering: numbering ? numbering[i] : undefined };
					if (!o.numbering) delete o.numbering;
					return store.toExportPlan(o, g);
				});
				const out = await exportSplit({
					exportPlan,
					plans,
					parts: mkSplit,
					sources,
					assets,
					base: nameBase(name),
					signal: control?.signal,
					onProgress: report,
					onStep: (p) => (step = p)
				});
				done = {
					kind: 'done',
					filename: out.filename,
					inputBytes,
					url: '',
					blob: out.blob,
					made: 'split',
					checks: out.checks,
					pageCount: out.pageCount,
					warnings: out.warnings,
					result: null,
					headline: `Checked: ${plural(out.parts.length, 'file')}, ${plural(out.pageCount, 'page')} in all, each opens cleanly.`,
					line: `${out.parts.length} files in one zip, ${formatBytes(out.blob.size)}`,
					notes: [...splitNotes(out), ...(limitsLine ? [limitsLine] : [])],
					files: out.parts.map((p) => `${p.name}: ${p.pages}, ${formatBytes(p.bytes)}`)
				};
			} else {
				const result = await engine.exportPlan(store.toExportPlan(options, mode === 'extract' ? ids : undefined), sources, assets, {
					signal: control?.signal,
					onProgress: report
				});
				done = {
					kind: 'done',
					filename: name,
					inputBytes,
					url: '',
					blob: new Blob([result.bytes as BlobPart], { type: 'application/pdf' }),
					made: 'pdf',
					checks: result.checks,
					pageCount: result.pageCount,
					warnings: result.warnings,
					result,
					headline: headline(result.checks, result.pageCount),
					line: null,
					notes: [...(tagsLine(result) ? [tagsLine(result)!] : []), ...(limitsLine ? [limitsLine] : [])],
					files: []
				};
			}
			if (control?.signal.aborted) {
				// Finished as Cancel was pressed: the user asked for nothing, so nothing is offered.
				phase = { kind: 'form' };
				cancelled = true;
				return;
			}
			done.url = URL.createObjectURL(done.blob);
			phase = done;
		} catch (err) {
			if (isEngineErrorShape(err) && err.code === 'cancelled') {
				phase = { kind: 'form' };
				cancelled = true;
				return;
			}
			phase = {
				kind: 'failed',
				error: isEngineErrorShape(err)
					? err
					: { code: 'internal', message: 'Something went wrong while building the file. Nothing was saved.' }
			};
		} finally {
			abort = null;
			progress = null;
			step = null;
			timeLeft = null;
		}
	}

	function markSaved() {
		if (phase.kind !== 'done') return;
		saved = true;
		onsaved({ filename: phase.filename, mode, kind: phase.made });
	}

	function download() {
		if (phase.kind !== 'done') return;
		const a = document.createElement('a');
		a.href = phase.url;
		a.download = phase.filename;
		a.rel = 'noopener';
		document.body.append(a);
		a.click();
		a.remove();
		markSaved();
	}

	type SavePicker = (o: {
		suggestedName: string;
		types: { description: string; accept: Record<string, string[]> }[];
	}) => Promise<{ createWritable(): Promise<{ write(d: Blob): Promise<void>; close(): Promise<void> }> }>;

	const picker = typeof window !== 'undefined' ? (window as unknown as { showSaveFilePicker?: SavePicker }).showSaveFilePicker : undefined;
	const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

	async function saveAs() {
		if (phase.kind !== 'done' || !picker) return;
		const p = phase;
		const ext = p.filename.slice(p.filename.lastIndexOf('.'));
		try {
			const handle = await picker({
				suggestedName: p.filename,
				types: [{ description: SAVE_TYPES[ext]?.[0] ?? 'File', accept: { [p.blob.type || 'application/octet-stream']: [ext] } }]
			});
			const w = await handle.createWritable();
			await w.write(p.blob);
			await w.close();
			markSaved();
		} catch (e) {
			if ((e as Error)?.name !== 'AbortError') download();
		}
	}

	const shareFile = $derived.by(() => {
		if (phase.kind !== 'done' || !coarse || typeof navigator.canShare !== 'function') return null;
		const file = new File([phase.blob], phase.filename, { type: phase.blob.type });
		try {
			return navigator.canShare({ files: [file] }) ? file : null;
		} catch {
			return null;
		}
	});

	async function share() {
		if (!shareFile) return;
		try {
			await navigator.share({ files: [shareFile], title: shareFile.name });
			markSaved();
		} catch {
			// Cancelled; the download button is still there.
		}
	}

	const TITLES: Record<VerifyCheck['name'], string> = {
		structure: 'File structure',
		'page-count': 'Page count',
		'page-sizes': 'Page sizes',
		reopen: 'Opens cleanly',
		encryption: 'Password',
		redaction: 'Redaction',
		forms: 'Form answers',
		numbering: 'Page numbers',
		visual: 'Pages look the same',
		'target-size': 'File size',
		'blank-fields': 'Filled blanks',
		'text-layer': 'Searchable text',
		tags: 'Accessibility tags',
		watermark: 'Watermark'
	};

	function headline(checks: VerifyCheck[], pageCount: number): string {
		const opens = checks.some((c) => c.name === 'reopen' && c.ok);
		return `Checked: ${plural(pageCount, 'page')}${opens ? ', opens cleanly' : ''}.`;
	}

	const SAVE_TYPES: Record<string, [string]> = {
		'.pdf': ['PDF document'],
		'.zip': ['ZIP archive'],
		'.jpg': ['JPEG picture'],
		'.png': ['PNG picture']
	};

	const title = $derived(
		phase.kind === 'done'
			? phase.made === 'pdf'
				? 'Your file is ready'
				: phase.made === 'split'
					? 'Your files are ready'
					: phase.pageCount === 1
						? 'Your picture is ready'
						: 'Your pictures are ready'
			: phase.kind === 'failed'
				? 'Export stopped'
				: mode === 'extract'
					? `Export ${plural(plan.count, 'selected page')}`
					: pictures
						? 'Export pictures'
						: 'Export PDF'
	);
</script>

{#snippet checkList(checks: VerifyCheck[], pageCount: number)}
	<ul class="checks">
		<!-- Kept accessibility tags are said under Details only (the 'tags' check). -->
		{#each checks.filter((c) => c.name !== 'tags' || !c.ok) as c, i (i)}
			<li class:bad={!c.ok}>
				<Icon name={c.ok ? 'check' : 'cross'} size={18} />
				<span>{plainCheck(c, pageCount)}</span>
			</li>
		{/each}
	</ul>
	<details class="details">
		<summary>Details</summary>
		<ul>
			{#each checks as c, i (i)}
				<li><strong>{TITLES[c.name] ?? c.name}:</strong> {c.ok ? 'passed' : 'failed'}. {c.detail}</li>
			{/each}
		</ul>
	</details>
{/snippet}

<Dialog bind:open {title} width="480px" dismissable={phase.kind !== 'working'} {onclose}>
	{#if phase.kind === 'form'}
		<form id="export-form" class="form" onsubmit={run} novalidate>
			<OptionPicker label="Save as" bind:value={f.output} options={OUTPUT_CHOICES} />
			<Field label="File name" bind:value={filename} autocomplete="off" spellcheck="false" hint={zipContents ?? undefined} />
			{#if pictures}
				<div class="section">
					<OptionPicker label="Quality" bind:value={f.pictureQuality} options={QUALITY_CHOICES} />
					<p class="caption preview">
						{pictureKind === 'jpg' ? 'JPG: smaller files, for sharing and the web.' : 'PNG: exact colours, larger files.'}
						{plan.count === 1 ? 'One picture of the page.' : `One picture per page, ${plan.count} in all.`}
					</p>
					{#if picturesProblem}
						<p class="problem" role="alert">{picturesProblem}</p>
					{:else if estimate && estimate.reduced > 0}
						<p class="caption preview">
							{estimate.reduced === 1 ? 'One very large page is' : `${estimate.reduced} very large pages are`} saved at a lower resolution so this device can draw {estimate.reduced === 1 ? 'it' : 'them'}.
						</p>
					{/if}
				</div>
			{/if}

			{#if redacting}
				<p class="notice" role="note">
					<Icon name="lock" size={18} />
					<span>
						{plural(plan.redactions, 'area')} will be redacted. What is under {plan.redactions === 1 ? 'it is' : 'them is'} removed from the file{pictures ? ' before the pictures are drawn' : ''}.
					</span>
				</p>
			{/if}

			{#if canSplit}
				<div class="split">
					<Toggle
						bind:checked={f.split}
						label="Split into several files"
						hint={usePassword ? 'Each file is checked like any export and gets the password. You get one zip.' : 'Each file is checked like any export. You get one zip.'}
					/>
					{#if f.split}
						<div class="section">
							<Select label="How to split" bind:value={f.splitRule} options={splitRules} />
							{#if splitRule === 'every'}
								<Field label="Pages per file" bind:value={f.splitEvery} inputmode="numeric" autocomplete="off" />
							{:else if splitRule === 'at'}
								<Field
									label="New file starts at pages"
									bind:value={f.splitAt}
									inputmode="numeric"
									autocomplete="off"
									placeholder="5, 12"
								/>
							{:else if splitRule === 'files'}
								<p class="caption preview">Pages go with the file they came from, in their current order. Added blank pages go with the page before them.</p>
							{/if}
							{#if splitProblem}
								<p class="problem" role="alert">{splitProblem}</p>
							{:else if splitLine}
								<p class="preview caption">{splitLine}</p>
							{/if}
						</div>
					{/if}
				</div>
			{/if}

			<div class="toggles">
				{#if !pictures}
				<Toggle
					checked={f.compress || f.fit}
					onchange={(v) => (f.compress = v)}
					disabled={f.fit}
					label="Optimize"
					hint={f.printCap ? 'Makes the file smaller. Text and drawings stay exactly as they are.' : 'Makes the file smaller. Nothing changes in how it looks.'}
				/>
				{#if oversized > 0 && (f.compress || f.fit)}
					<Toggle bind:checked={f.printCap} label={PRINT_CAP_LABEL} hint={printCapHint(oversized)} />
				{/if}

				<Toggle
					bind:checked={f.fit}
					label="Fit under a size"
					hint={splitting ? 'Lowers the quality of photos and scans until each file fits. Text stays sharp.' : 'Lowers the quality of photos and scans until the file fits. Text stays sharp.'}
				/>
				{#if f.fit}
					<div class="section">
						<OptionPicker
							label="Largest size"
							bind:value={f.fitChoice}
							options={FIT_CHOICES.map((c) => ({ value: c, label: c === 'other' ? 'Other' : `${c} MB` }))}
						/>
						{#if f.fitChoice === 'other'}
							<Field
								label="Size in MB"
								bind:value={f.fitOther}
								inputmode="decimal"
								autocomplete="off"
								placeholder="0.1 to 500"
								error={fitError}
							/>
						{/if}
					</div>
				{/if}
				{/if}

				<Toggle
					checked={f.number}
					onchange={(v) => (f.number = v)}
					label="Number the pages"
				/>
				{#if f.number}
					<div class="section">
						<Select label="Style" bind:value={f.style} options={NUMBER_STYLES} />
						<OptionPicker label="Position" layout="corners" bind:value={f.position} options={NUMBER_POSITIONS} />
						{#if f.style === 'bates'}
							<div class="pair">
								<Field label="Prefix" bind:value={f.prefix} maxlength={20} autocomplete="off" spellcheck="false" />
								<Field label="Digits" bind:value={f.digits} inputmode="numeric" autocomplete="off" />
							</div>
						{/if}
						<div class="pair">
							<Field label="Start at" bind:value={f.start} inputmode="numeric" autocomplete="off" />
							<Field label="Skip first pages" bind:value={f.skip} inputmode="numeric" autocomplete="off" />
						</div>
						<OptionPicker label="Size" bind:value={f.size} options={NUMBER_SIZES} />
						{#if numProblem}
							<p class="problem" role="alert">{numProblem}</p>
						{:else if numPreview}
							<p class="preview num caption">{numPreview}</p>
						{/if}
						{#if splitting}<p class="preview caption">Numbers continue from one file to the next.</p>{/if}
					</div>
				{/if}

				<Toggle checked={f.watermark} onchange={(v) => (f.watermark = v)} label="Add a watermark" hint="Text such as DRAFT across every page." />
				{#if f.watermark}
					<div class="section" data-testid="watermark-section">
						<OptionPicker label="Text" bind:value={f.wmPick} options={WATERMARK_PICKS} />
						{#if f.wmPick === 'other'}
							<Field label="Watermark text" bind:value={f.wmText} maxlength={WATERMARK_MAX} autocomplete="off" spellcheck="false" />
						{/if}
						<OptionPicker label="Look" bind:value={f.wmLook} options={WATERMARK_LOOKS} />
						<div class="wm-pair">
							<OptionPicker label="Strength" bind:value={f.wmStrength} options={WATERMARK_STRENGTHS} />
							<OptionPicker label="Colour" bind:value={f.wmColor} options={WATERMARK_COLORS} />
						</div>
						{#if wmProblem}
							<p class="problem" role="alert">{wmProblem}</p>
						{:else if wmResult && 'watermark' in wmResult}
							<div class="wm-row">
								<WatermarkPreview watermark={wmResult.watermark} page={firstPage} />
								<p class="caption preview">
									A watermark is a visible mark, not protection: anyone with a PDF editor can remove it.
								</p>
							</div>
						{/if}
					</div>
				{/if}

				{#if !pictures}
				{#if plan.hasForm || redacting}
					{#if plan.hasForm}
						<Toggle
							checked={f.lockForms || redacting}
							onchange={(v) => (f.lockForms = v)}
							disabled={redacting}
							label="Lock form answers"
							hint={redacting ? 'Always on when redacting.' : 'Turns the form into plain page content so answers cannot be changed.'}
						/>
					{/if}
				{/if}
				{#if plan.blanks > 0}
					<Toggle
						checked={f.keepBlanks && !blanksBlocked}
						onchange={(v) => (f.keepBlanks = v)}
						disabled={!!blanksBlocked}
						label="Keep filled blanks editable"
						hint={blanksBlocked ?? keepBlanksHint(plan.blanks)}
					/>
				{/if}
				<Toggle
					checked={f.stripMetadata || redacting}
					onchange={(v) => (f.stripMetadata = v)}
					disabled={redacting}
					label="Remove metadata"
					hint={redacting ? 'Always on when redacting.' : 'Author, title, dates and editing software.'}
				/>
				<Toggle bind:checked={usePassword} label="Add a password" hint="Needed to open the file. AES-256." />
				{#if scanned > 0}
					<Toggle bind:checked={f.ocr} label={OCR_LABEL} hint={OCR_HINT} />
					{#if f.ocr && ocrCapNotice(scanned)}<p class="caption ocr-note">{ocrCapNotice(scanned)}</p>{/if}
				{/if}
				{/if}
			</div>

			{#if pictures}
				<!-- Password, metadata and file options belong to a PDF; pictures carry none of them. -->
			{:else if usePassword}
				<div class="password">
					<Field
						label="Password"
						type={showPassword ? 'text' : 'password'}
						bind:value={password}
						autocomplete="new-password"
						error={pwError ?? undefined}
						oninput={() => (touched = touched || password.length > 0)}
						onblur={() => (touched = true)}
					/>
					<Field
						label="Confirm password"
						type={showPassword ? 'text' : 'password'}
						bind:value={confirm}
						autocomplete="new-password"
						error={confirmError ?? undefined}
						onblur={() => (touched = true)}
					/>
					<label class="show">
						<input type="checkbox" bind:checked={showPassword} />
						Show passwords
					</label>
					<p class="caption">There is no way to recover a forgotten password. Keep it somewhere safe.</p>
				</div>
			{:else if plan.passwordInput}
				<p class="note"><Icon name="lock" size={18} />A file you opened had a password. This export will have none unless you add one.</p>
			{:else if plan.limits.length}
				<p class="note" data-testid="limits-note"><Icon name="lock" size={18} />A file you opened limited {limitWords(plan.limits)}. This export will not.</p>
			{:else if plan.encryptedInput}
				<p class="note"><Icon name="lock" size={18} />A file you opened was locked. This export will not be, unless you add a password.</p>
			{/if}

			<p class="summary num">
				{`${plural(plan.count, 'page')}, ${formatBytes(plan.inputBytes)} in`}
			</p>
			{#if cancelled}<p class="caption" role="status">Export cancelled. Nothing was saved.</p>{/if}
		</form>
	{:else if phase.kind === 'working'}
		<div class="working" role="status">
			<Progress label="Building and checking your file" value={progressFraction(progress)} />
			<p>{phase.fitting ?? stepText ?? `Building and checking ${plural(plan.count, 'page')}…`}</p>
			{#if phase.fitting && stepText}<p class="step">{stepText}</p>{/if}
			{#if innerText}<p class="step">{innerText}</p>{/if}
			{#if leftText}<p class="left num">{leftText}</p>{/if}
			<p class="caption">Every export is re-opened and checked before you can save it.</p>
		</div>
	{:else if phase.kind === 'done'}
		{@const r = phase.result}
		<div class="result" role="status">
			<p class="verified"><span class="seal"><Icon name="check" size={18} /></span>{phase.headline}</p>
			<p class="sizes num">
				{phase.filename}<br />
				{#if phase.line}
					<span class="caption io">{phase.line}</span>
				{:else}
					<span class="caption io">{formatBytes(phase.inputBytes)} in → {formatBytes(phase.blob.size)} out</span>
				{/if}
			</p>
			{#if phase.notes.length}
				<div class="shrink made">
					{#each phase.notes as line, i (i)}<p class="caption">{line}</p>{/each}
				</div>
			{/if}
			{#if phase.files.length}
				<ul class="files caption num">
					{#each phase.files.length > 8 ? [...phase.files.slice(0, 6), `…and ${phase.files.length - 6} more`] : phase.files as line, i (i)}
						<li>{line}</li>
					{/each}
				</ul>
			{/if}
			{#if r}
				{#if shrinkSummary(r)}
					{@const sh = shrinkSummary(r)!}
					<div class="shrink">
						<p>{sh.size}</p>
						{#if sh.changed}<p class="caption">{sh.changed}</p>{/if}
					</div>
				{/if}
				{#if printCapLine(r)}<p class="blanks">{printCapLine(r)}</p>{/if}
				{#if blankFieldsLine(r)}<p class="blanks">{blankFieldsLine(r)}</p>{/if}
				{#if ocrSummary(r.ocr).length}
					<div class="shrink ocr-result">
						{#each ocrSummary(r.ocr) as line, i (i)}<p>{line}</p>{/each}
					</div>
				{/if}
			{/if}
			{@render checkList(phase.checks, phase.pageCount)}
			{#if phase.warnings.length}
				<ul class="warnings">
					{#each phase.warnings as w, i (i)}<li><Icon name="warning" size={18} /><span>{w}</span></li>{/each}
				</ul>
			{/if}
			{#if saved}<p class="caption saved">Saved. You can keep working; nothing here has changed.</p>{/if}
		</div>
	{:else}
		{@const err = phase.error}
		<div class="failed" role="alert">
			<p class="why"><Icon name="warning" />{err.message}</p>
			{#if err.checks?.length}
				{@render checkList(err.checks, plan.count)}
			{/if}
			<p class="caption">No file was made. Your pages are unchanged; you can try again or change the options.</p>
		</div>
	{/if}

	{#snippet actions()}
		{#if phase.kind === 'form'}
			<Button variant="quiet" onclick={() => (open = false)}>Cancel</Button>
			<Button
				variant="primary"
				icon="download"
				type="submit"
				form="export-form"
				disabled={plan.count === 0 || !!numProblem || !!wmProblem || (pictures ? !!picturesProblem : !fitOk || !!splitProblem)}>Export</Button
			>
		{:else if phase.kind === 'working'}
			{#if abort}<Button variant="quiet" onclick={() => abort?.abort()}>Cancel</Button>{/if}
			<Button variant="primary" loading>{progress?.stage === 'picture' ? 'Saving…' : 'Checking…'}</Button>
		{:else if phase.kind === 'done'}
			<Button variant="quiet" onclick={() => (open = false)}>{saved ? 'Done' : 'Close'}</Button>
			{#if picker && !coarse}<Button variant="secondary" onclick={saveAs}>Save as…</Button>{/if}
			{#if shareFile}<Button variant="secondary" onclick={share}>Share</Button>{/if}
			<Button variant="primary" icon="download" onclick={download}>Download</Button>
		{:else}
			<Button variant="quiet" onclick={() => (open = false)}>Close</Button>
			<Button variant="primary" onclick={() => (phase = { kind: 'form' })}>Change options</Button>
		{/if}
	{/snippet}
</Dialog>

<style>
	.form,
	.result,
	.failed,
	.working {
		display: grid;
		gap: var(--s-4);
	}

	.toggles {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-3) 0;
		border-block: 1px solid var(--line);
	}

	.section {
		display: grid;
		gap: var(--s-3);
		padding: var(--s-3);
		border-radius: var(--radius-control);
		background: var(--hover);
	}

	.pair {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--s-3);
	}

	.wm-pair {
		display: flex;
		flex-wrap: wrap;
		gap: var(--s-3) var(--s-5, 24px);
	}

	.wm-row {
		display: flex;
		align-items: center;
		gap: var(--s-3);
	}

	.problem {
		color: var(--danger);
		font-size: var(--text-caption);
		font-weight: 550;
	}

	.preview {
		color: var(--ink-soft);
	}

	.notice {
		display: flex;
		gap: var(--s-2);
		padding: var(--s-3);
		border-radius: var(--radius-control);
		border: 1px solid var(--line-strong);
		font-size: var(--text-control);
	}

	.notice :global(.icon) {
		flex: none;
		margin-top: 2px;
	}

	.shrink {
		display: grid;
		gap: var(--s-1);
	}

	.shrink > p:first-child,
	.blanks {
		font-weight: 550;
	}

	.shrink.made > p {
		font-weight: 400;
		color: var(--ink-soft);
	}

	.files {
		list-style: none;
		padding: 0;
		display: grid;
		gap: 2px;
		color: var(--ink-soft);
		overflow-wrap: anywhere;
	}

	.split {
		display: grid;
		gap: var(--s-3);
	}

	.password {
		display: grid;
		gap: var(--s-3);
	}

	.show {
		display: inline-flex;
		align-items: center;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
		width: fit-content;
	}

	.show input {
		width: 16px;
		height: 16px;
		accent-color: var(--ink);
	}

	.note {
		display: flex;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.note :global(.icon) {
		flex: none;
		margin-top: 1px;
	}

	.summary {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.ocr-note {
		color: var(--ink-soft);
		padding-left: var(--s-2);
	}

	.working {
		padding: var(--s-3) 0;
	}

	.working .step,
	.working .left {
		color: var(--ink-soft);
	}

	.verified {
		display: flex;
		align-items: center;
		gap: var(--s-3);
		font-family: var(--font-serif);
		font-size: 1.25rem;
		line-height: 1.3;
		color: var(--ink);
	}

	.seal {
		display: grid;
		place-items: center;
		flex: none;
		width: 32px;
		height: 32px;
		border-radius: 50%;
		background: var(--ok);
		color: var(--surface);
	}

	.sizes {
		overflow-wrap: anywhere;
		font-weight: 550;
	}

	.checks,
	.warnings {
		list-style: none;
		padding: 0;
		display: grid;
		gap: var(--s-2);
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.checks {
		padding: var(--s-3);
		border-radius: var(--radius-control);
		background: color-mix(in srgb, var(--ok) 7%, transparent);
	}

	.failed .checks {
		background: var(--hover);
	}

	.checks li,
	.warnings li {
		display: flex;
		gap: var(--s-2);
		align-items: flex-start;
	}

	.checks :global(.icon) {
		color: var(--ok);
		margin-top: 0;
	}

	.checks .bad :global(.icon) {
		color: var(--danger);
	}


	.warnings :global(.icon) {
		color: var(--ink-soft);
	}

	.why {
		display: flex;
		gap: var(--s-2);
		font-weight: 550;
	}

	.why :global(.icon) {
		color: var(--danger);
		flex: none;
	}

	.io {
		font-weight: 400;
	}

	.details {
		font-size: var(--text-caption);
		color: var(--ink-soft);
	}

	.details summary {
		width: fit-content;
		cursor: pointer;
		border-radius: 4px;
	}

	.details ul {
		margin-top: var(--s-2);
		padding-left: var(--s-4);
		display: grid;
		gap: var(--s-1);
	}

	.details strong {
		color: var(--ink);
		font-weight: 600;
	}

	.saved {
		color: var(--ok);
	}
</style>
