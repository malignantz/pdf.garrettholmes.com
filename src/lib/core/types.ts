/**
 * Shared contracts. Every module (engine, render, doc store, workspace, editor)
 * codes against these types. Change them only with the plan in docs/plans/.
 */

export type SourceId = string;
export type PageId = string;
export type AssetId = string;
export type Rotation = 0 | 90 | 180 | 270;

/** Size of one source page in PDF points, as displayed (intrinsic /Rotate already applied). */
export interface PageSize {
	width: number;
	height: number;
}

/**
 * An opened input. `bytes` is always a normalized, unencrypted PDF: images and
 * blank pages are converted to one-page PDFs on intake, encrypted files are
 * decrypted with the password the user typed, damaged files are repaired or rejected.
 */
export interface Source {
	id: SourceId;
	name: string;
	kind: 'pdf' | 'image' | 'blank';
	bytes: Uint8Array;
	pages: PageSize[];
	/** Size in bytes of the file the user gave us, before normalizing. */
	originalSize: number;
	/** True when the original was encrypted: it needed a password, or it opened without one but had limits (see `limits`). */
	wasEncrypted: boolean;
	/** Human-readable notes from intake, e.g. "Repaired a damaged cross-reference table." */
	notes: string[];
	/** True when the file has AcroForm fields this app can fill. See Engine.formFields. */
	hasForm?: boolean;
	/**
	 * Added 2026-11-13 ("Remove printing and copying limits"): what the encrypted original
	 * limited, read from its permission flags at open. Present only when `wasEncrypted`
	 * and the flags could be read. The limits never reach an export: `bytes` is decrypted,
	 * so an export has no encryption unless ExportOptions.password sets one (and then
	 * allows everything). Derived at every open and never stored by the session (a
	 * restored protected file is opened again); absent on sources from before this field.
	 */
	limits?: SourceLimits;
}

/** What an encrypted original did not allow (true: limited). See Source.limits. */
export interface SourceLimits {
	/** It was opened with a password the user typed (the open password or the owner password); false: it opened without one. */
	password: boolean;
	/** Printing not allowed, or only at low quality. */
	print: boolean;
	/** Copying text and pictures not allowed. */
	copy: boolean;
	/** Changing the pages' content, their order (assembly) or their comments not allowed. */
	edit: boolean;
	/** Filling in form fields not allowed. */
	fill: boolean;
}

/**
 * Stamp coordinates are fractions (0..1) of the page as the user sees it in the
 * workspace: after the source's intrinsic rotation and after PageRef.rotation,
 * origin at the top-left corner. The engine converts to PDF space.
 */
export interface StampBox {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Turned stamps (2026-11-13). Rotating a page turns every mark with it, so a redaction
 * or highlight still covers the same content and text, pictures and ticks still sit
 * on the same spot, turned like the page. Boxes, rectangles and pen points are simply
 * mapped to the turned page; a stamp that is drawn upright (text, picture, check
 * mark) carries `turn`: how far it is turned clockwise from upright, 0 when absent.
 * Text: `x`, `y` stay the corner the first line starts at (the pivot of the turn).
 * Picture and check: `box` is the turned stamp's bounding box on the page as
 * displayed; the drawing is made upright in a box of swapped width and height and
 * turned into it. Cross and dot look the same turned, so they need no `turn`.
 */
export type Stamp =
	| { id: string; kind: 'image'; assetId: AssetId; box: StampBox; turn?: Rotation }
	| {
			id: string;
			kind: 'text';
			text: string;
			/** Top-left of the first line. */
			x: number;
			y: number;
			/** Font size as a fraction of the displayed page height. */
			size: number;
			color: 'black' | 'blue' | 'red';
			/** The drawn blank this text was snapped into (see StampBlank). */
			blank?: StampBlank;
			/** Clockwise turn about (x, y); see above. */
			turn?: Rotation;
	  }
	| { id: string; kind: 'mark'; mark: 'check' | 'cross' | 'dot'; box: StampBox; blank?: StampBlank; turn?: Rotation }
	/**
	 * Translucent colour over the page; what is under it stays readable and stays in the file.
	 * Without `pen` the whole box is filled (a box highlight). With `pen` it is a freehand
	 * stroke and `box` is the area the stroke covers (its points, plus half its width each
	 * way, kept inside the page); moving the stamp moves box and points together.
	 * With `rects` (2026-11-11) it is a text highlight: one rectangle per line of the
	 * selected text, in the same space as `box`, each filled like a box highlight (where
	 * two overlap the colour does not get darker); `box` is their bounds, and moving the
	 * stamp moves them together. A stamp has `pen` or `rects` or neither, never both.
	 */
	| { id: string; kind: 'highlight'; color: HighlightColor; box: StampBox; pen?: PenStroke; rects?: StampBox[] }
	/**
	 * True redaction. On export, text, image pixels and drawings under the box are
	 * removed from the file (not covered) and the area is painted black. The engine
	 * checks the result or refuses to export.
	 */
	| { id: string; kind: 'redact'; box: StampBox };

/**
 * Snap on tap (2026-11-12, "Filled blanks as form fields"): the drawn blank a text or
 * tick stamp was snapped into, kept while the stamp still belongs to it. `box` is the
 * blank's rectangle in stamp space (fractions of the page as displayed). Only a text
 * stamp has kind 'text' and only a check mark kind 'check'. DocStore drops it when the
 * stamp is moved or resized, when a one-line blank gets a second line of text, when
 * the page is rotated, and on copies of the stamp. With ExportOptions.blankFields the
 * export turns such a stamp into a form field over the blank; otherwise, or when the
 * field cannot be verified, the stamp is drawn as usual.
 */
export interface StampBlank {
	kind: 'text' | 'check';
	box: StampBox;
}

export type HighlightColor = 'yellow' | 'green' | 'pink';

/**
 * A highlighter pen stroke: one polyline drawn with round ends and joins.
 * `points` are in the stamp space of StampBox (fractions of the page as displayed,
 * origin top-left), at least two, all inside `box`. `width` is the stroke's
 * thickness as a fraction of the displayed page height (like text `size`).
 */
export interface PenStroke {
	points: { x: number; y: number }[];
	width: number;
}

/**
 * The selectable text of one source page, for the text highlighter (Engine.pageText).
 * Only text the highlighter can mark reliably is listed: text at more than a few
 * degrees from the page's axes, glyphs without usable metrics and text clipped away
 * or in hidden layers are left out (`skipped` counts left-out characters that would
 * show). Invisible text (an OCR layer over a scan) is listed.
 */
export interface PageText {
	/** Words in reading order, as the file's text gives it (not sorted by position). */
	words: TextWord[];
	/** Characters on the page that are not offered (see above). */
	skipped: number;
}

export interface TextWord {
	text: string;
	/**
	 * Where a highlight of this word alone goes: its letters with a small margin, one
	 * line high (the font's ascent to descent, kept off the neighbouring lines' ink).
	 * Fractions of the source page as displayed (intrinsic /Rotate applied,
	 * PageRef.rotation not), origin top-left, like FormWidget.box.
	 */
	box: StampBox;
	/** Line number, in reading order. The words of one line are consecutive. */
	line: number;
}

/**
 * Value of one form field. text: string. checkbox: boolean. radio: the chosen
 * option's name, or '' for none. choice (dropdown or list): the selected option values.
 */
export type FormValue = string | boolean | string[];

/** Where one field shows on a page. A field can have several widgets (radio groups always do). */
export interface FormWidget {
	/** 0-based index into Source.pages. */
	pageIndex: number;
	/** Fractions of the source page as displayed (intrinsic /Rotate applied, PageRef.rotation not), origin top-left. */
	box: StampBox;
	/** radio: the option this widget selects. */
	option?: string;
}

/** A fillable AcroForm field of a Source. Fields the app will not fill are not listed. */
export interface FormField {
	/** Fully qualified field name; unique within the source. */
	name: string;
	kind: 'text' | 'checkbox' | 'radio' | 'choice';
	/** Tooltip (/TU) when the form has one. */
	label?: string;
	/** Value in the file as opened. */
	value: FormValue;
	/** Shown but not editable (read-only flag, or computed by the form's own scripts). */
	readOnly: boolean;
	/** text only. */
	multiline?: boolean;
	/** text only. */
	maxLength?: number;
	/** choice only. */
	options?: { value: string; label: string }[];
	/** choice only: more than one option may be selected. */
	multiSelect?: boolean;
	widgets: FormWidget[];
}

/** Answers typed into the forms of the open sources: source id -> field name -> value. */
export type FormValues = Record<SourceId, Record<string, FormValue>>;

/** Page numbers or Bates numbers drawn in the margin of every numbered page on export. */
export interface PageNumbering {
	/** 'n': "3". 'n-of-total': "3 of 12". 'page-n': "Page 3". 'page-n-of-total': "Page 3 of 12". 'bates': prefix + zero-padded number. */
	style: 'n' | 'n-of-total' | 'page-n' | 'page-n-of-total' | 'bates';
	position: 'top-left' | 'top-center' | 'top-right' | 'bottom-left' | 'bottom-center' | 'bottom-right';
	/** Number printed on the first numbered page (>= 0, integer). */
	start: number;
	/** Leading pages left without a number (cover pages). They are not counted. */
	skip: number;
	/** Font size in points, 6..24. */
	size: number;
	/** bates only. prefix: up to 20 characters the stamp font can draw. digits: 3..10. */
	bates?: { prefix: string; digits: number };
	/**
	 * Added 2026-11-13 (split export): the number printed after "of" in the -of-total
	 * styles. Default (undefined): the number on the last numbered page of this export.
	 * A part of a split file sets it to the whole file's last number, so its pages read
	 * "Page 7 of 12" rather than "Page 1 of 4". Integer, at least the part's own last
	 * number. Ignored by the other styles.
	 */
	total?: number;
}

/** A PNG the user created or picked (drawn signature, initials, image). */
export interface Asset {
	id: AssetId;
	kind: 'signature' | 'initials' | 'image';
	png: Uint8Array;
	width: number;
	height: number;
}

/** One page in the workspace grid. The same source page may appear many times. */
export interface PageRef {
	id: PageId;
	sourceId: SourceId;
	/** 0-based index into Source.pages. */
	pageIndex: number;
	/** Extra clockwise rotation the user applied. */
	rotation: Rotation;
	stamps: Stamp[];
}

export interface ExportOptions {
	filename: string;
	/**
	 * Recompress streams, pack objects, drop unreferenced objects: lossless, except that
	 * with `printCap` oversized photos are brought down to 300 ppi as drawn.
	 */
	compress: boolean;
	/** AES-256 open password, or undefined for none. */
	password?: string;
	/** Remove Info dictionary and XMP metadata. Forced on when the plan has redactions. */
	stripMetadata: boolean;
	/** Turn form fields into plain page content. Forced on when the plan has redactions. */
	flattenForms?: boolean;
	numbering?: PageNumbering;
	/**
	 * Lossy: lower the resolution and quality of photos and scans, step by step,
	 * until the file is at most this many bytes. Text and line art are not touched.
	 * If the target cannot be reached the smallest verified file is returned and
	 * ExportResult.shrink.reached is false.
	 */
	targetBytes?: number;
	/**
	 * Keep filled blanks editable: text and ticks with a live Stamp `blank` become AcroForm
	 * fields (text fields, checkboxes) instead of page content. Ignored with flattenForms
	 * (and so with redaction). ExportResult.blankFields says how many became fields.
	 */
	blankFields?: boolean;
	/** Make scanned pages searchable: an invisible OCR text layer (see OcrReport). Desktop only in the app. */
	ocr?: boolean;
	/**
	 * Print-size cap (2026-11-13), only with `compress`: photos and scans that hold more
	 * pixels than a 300 ppi print of the size they are drawn at are brought down to
	 * 300 ppi (JPEG). Flat-colour images, masks, 1-bit, CMYK and anything the engine
	 * cannot follow everywhere it is drawn stay exactly as they are, as does every image
	 * of a digitally signed file. Undefined or false: off. See ExportResult.printCap.
	 */
	printCap?: boolean;
}

export interface ExportPlan {
	pages: PageRef[];
	options: ExportOptions;
	formValues?: FormValues;
}

export interface VerifyCheck {
	name:
		| 'structure'
		| 'page-count'
		| 'page-sizes'
		| 'reopen'
		| 'encryption'
		/** Nothing readable is left under any redaction box, and the boxes are black. */
		| 'redaction'
		/** Every form answer reads back from the exported file. */
		| 'forms'
		/** Every numbered page carries its number. */
		| 'numbering'
		/** After shrinking or capping images, every page still looks like it did before. */
		| 'visual'
		/** Reports the final size. ok even when the target was not reached; ExportResult.shrink.reached says which. */
		| 'target-size'
		/** Every filled blank made into a form field reads back with its answer and rectangle. */
		| 'blank-fields'
		/** Every page that got an OCR text layer reads back with its words (ExportOptions.ocr). */
		| 'text-layer'
		/**
		 * Added 2026-11-13: the accessibility tags (structure tree) kept from a tagged source
		 * read back whole and tied to their page content (ExportResult.tags).
		 */
		| 'tags';
	ok: boolean;
	detail: string;
}

export interface ExportResult {
	bytes: Uint8Array;
	pageCount: number;
	/** Every check must be ok, or the engine throws instead of returning. */
	checks: VerifyCheck[];
	warnings: string[];
	elapsedMs: number;
	/** Present when ExportOptions.targetBytes was set. */
	shrink?: {
		targetBytes: number;
		reached: boolean;
		/** Images that were re-encoded. */
		imagesChanged: number;
		/** Resolution cap that was applied, in pixels per inch; 0 when no image was changed. */
		dpi: number;
	};
	/**
	 * Present when ExportOptions.blankFields was on: linked stamps that became form fields,
	 * and those drawn as plain text or ticks instead (they could not be made or verified).
	 */
	blankFields?: { fields: number; plain: number };
	/** Present when ExportOptions.ocr was set. */
	ocr?: OcrReport;
	/**
	 * Present when ExportOptions.printCap was on (with compress). `images`: pictures
	 * brought down to `ppi` (0 when none needed it or none could be changed safely).
	 * `ppi`: the cap (print-cap.ts CAP_PPI). `savedBytes`: what that saved. With targetBytes it is exact (finalized size without
	 * the cap minus with it); without, it is the saving on the image streams themselves
	 * (finalizing twice to know it exactly would double the work).
	 */
	printCap?: { images: number; savedBytes: number; ppi: number };
	/**
	 * Added 2026-11-13 (accessibility tags). Present when a source of the export is a tagged
	 * PDF (it has a structure tree): `kept` when the export carries the tags, checked (the
	 * 'tags' check); otherwise `reason` says why it has none.
	 */
	tags?: { kept: true } | { kept: false; reason: TagsDropReason };
}

/**
 * Why an export of a tagged file has no accessibility tags. 'redacted': something is
 * blacked out; 'flattened': a tagged form is locked (flattened); 'merged': pages from
 * another file, other than blank pages; 'repeated': a page is used more than once;
 * 'damaged': the source's tags do not match its pages; 'unsupported': a tree the engine
 * cannot copy exactly; 'check': the export's own check of the tags failed.
 */
export type TagsDropReason = 'redacted' | 'flattened' | 'merged' | 'repeated' | 'damaged' | 'unsupported' | 'check';

/**
 * "Make scanned pages searchable" (ExportOptions.ocr): OCR adds an invisible text
 * layer to scanned pages; the page picture never changes. Only eligible pages are
 * tried (a PDF page with no text that is one picture of at least 200 ppi, without
 * redaction boxes), at most `cap` of them in document order. A tried page is either
 * made searchable or left exactly as it was ("declined": the text could not be read
 * well enough, or a check failed).
 */
export interface OcrReport {
	/** Eligible pages in the export. */
	eligible: number;
	/** Most pages one export tries. */
	cap: number;
	/** 1-based output page numbers that got a text layer. */
	searchable: number[];
	/** 1-based output page numbers that were tried and left as they were. */
	declined: number[];
}

/** Progress of a long export, for the dialog ("Reading page 3 of 12"). */
export type ExportProgress =
	/** Loading the OCR engine (the first time: a download of a few megabytes). */
	| { stage: 'ocr-load' }
	/** `done` of `total` pages read so far. */
	| { stage: 'ocr'; done: number; total: number }
	/** Print-size cap: `done` of `total` oversized pictures handled so far ("Reducing picture 3 of 20"). */
	| { stage: 'pictures'; done: number; total: number }
	// Added 2026-11-13 (remaining-time estimate). Each stage starts again at done 0; a stage
	// may run more than once (fit under a size tries steps; a failed check retries).
	/** Compress: `done` of `total` bytes of stream data through the lossless pass (it may stop early on its time budget). */
	| { stage: 'pack'; done: number; total: number }
	/** Print-size cap, before 'pictures': `done` of `total` JPEG pictures read and measured (their size after the lossless repack). */
	| { stage: 'pictures-read'; done: number; total: number }
	/** Fit under a size: `done` of `total` pictures re-encoded for the step being tried. */
	| { stage: 'reduce'; done: number; total: number }
	/** Fit under a size and the print-size cap: `done` of `total` pages rendered before and after and compared. */
	| { stage: 'compare'; done: number; total: number }
	/**
	 * The final check (qpdf --check, which decodes every stream: most of a long export of
	 * scans): `done` of `total` bytes of the exported file read so far. `last`: nothing
	 * slow follows it (no form, redaction, numbering, field or text-layer check), so its
	 * end is about the end of the export.
	 */
	| { stage: 'check'; done: number; total: number; last: boolean }
	// Added 2026-11-13 (pictures and split export). Reported by the app's export dialog, not
	// by the engine: both run Engine.exportPlan (one verified PDF; one per part) and then
	// work on its result, so their counts span several engine calls.
	/** Saving pages as pictures: `done` of `total` pages rendered and encoded ("Saving picture 3 of 20"). */
	| { stage: 'picture'; done: number; total: number }
	/** Split into several files: `done` of `total` parts built and verified ("Making file 2 of 9"). */
	| { stage: 'part'; done: number; total: number };

/** Optional extras for Engine.exportPlan. */
export interface ExportControl {
	onProgress?: (p: ExportProgress) => void;
	/** Aborting stops the export; it then rejects with code 'cancelled' and nothing is made. */
	signal?: AbortSignal;
}

export type EngineErrorCode =
	| 'password-required'
	| 'password-wrong'
	| 'unreadable'
	| 'unsupported'
	| 'verification-failed'
	| 'too-large'
	/** The caller cancelled (ExportControl.signal). */
	| 'cancelled'
	| 'internal';

/** Errors cross the worker boundary as plain objects of this shape. */
export interface EngineErrorShape {
	code: EngineErrorCode;
	/** Plain-language sentence safe to show the user. */
	message: string;
	checks?: VerifyCheck[];
}

export interface Engine {
	/** Normalize a PDF. Throws password-required / password-wrong / unreadable. */
	openPdf(bytes: Uint8Array, name: string, password?: string): Promise<Source>;
	/** JPEG and PNG directly; callers convert other formats to PNG first. */
	openImage(bytes: Uint8Array, mime: 'image/jpeg' | 'image/png', name: string): Promise<Source>;
	blankPage(size: PageSize): Promise<Source>;
	/** Build, then verify. Never returns an unverified file. */
	exportPlan(plan: ExportPlan, sources: Source[], assets: Asset[], control?: ExportControl): Promise<ExportResult>;
	/** Characters the bundled stamp font cannot draw; empty string means all good. */
	unsupportedChars(text: string): Promise<string>;
	/** Fillable fields of a source; [] when Source.hasForm is not true. */
	formFields(source: Source): Promise<FormField[]>;
	/** What the blank detector reads on one page, for snap on tap (see PageBlanks). Never throws for an odd page: it declines. */
	pageBlanks(source: Source, pageIndex: number): Promise<PageBlanks>;
	/**
	 * The selectable words of one page (0-based index into Source.pages), for the text
	 * highlighter. `{ words: [], skipped: 0 }` for a page with no text (a scan without
	 * OCR) and for image and blank sources. Loads MuPDF on first use.
	 */
	pageText(source: Source, pageIndex: number): Promise<PageText>;
	/**
	 * 0-based indexes of the pages "Make scanned pages searchable" would try (see
	 * OcrReport): [] for image and blank sources and for files without such pages.
	 * Loads MuPDF only when a page has a picture large enough to qualify.
	 */
	scannedPages(source: Source): Promise<number[]>;
	/**
	 * Pictures the print-size cap (ExportOptions.printCap) would bring down: one entry
	 * per picture, the 0-based pages of `source` it is drawn on. [] for blank sources,
	 * signed files and files without such pictures. A hint for the export dialog; the
	 * export decides for itself. Loads MuPDF only when a big enough image exists (for a
	 * picture the app placed itself, a JPEG filling an image source's page, not at all).
	 */
	oversizedPictures(source: Source): Promise<number[][]>;
}

/**
 * Blanks of one source page for "snap on tap" (the editor's Text and Check tools on
 * flat forms; engine/snap-tap.ts, editor/snap.ts). Page space: points, origin
 * top-left, the page as displayed before PageRef.rotation. `declined`: nothing to
 * snap to (scanned page, too detailed to read within the time and size budget,
 * page size not matching the source); `data` is null then. Otherwise `data` is
 * engine/snap-tap.ts `TapData`, read only by editor/snap.ts.
 */
export interface PageBlanks {
	width: number;
	height: number;
	declined: boolean;
	data: unknown;
}

export interface RenderRequest {
	source: Source;
	pageIndex: number;
	/** Target width in CSS pixels times devicePixelRatio, before rotation. */
	width: number;
	rotation: Rotation;
	/** Form answers of this source to draw in place of the file's own values (preview quality). */
	formValues?: Record<string, FormValue>;
	signal?: AbortSignal;
}

export interface Renderer {
	/** Rejects with AbortError when signal fires. Capped for iOS canvas limits. */
	render(req: RenderRequest): Promise<ImageBitmap>;
	/** Release everything held for a source that was removed. */
	release(sourceId: SourceId): void;
}
