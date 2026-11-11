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
	/** True when the original was password-protected. */
	wasEncrypted: boolean;
	/** Human-readable notes from intake, e.g. "Repaired a damaged cross-reference table." */
	notes: string[];
	/** True when the file has AcroForm fields this app can fill. See Engine.formFields. */
	hasForm?: boolean;
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

export type Stamp =
	| { id: string; kind: 'image'; assetId: AssetId; box: StampBox }
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
	  }
	| { id: string; kind: 'mark'; mark: 'check' | 'cross' | 'dot'; box: StampBox }
	/**
	 * Translucent colour over the page; what is under it stays readable and stays in the file.
	 * Without `pen` the whole box is filled (a box highlight). With `pen` it is a freehand
	 * stroke and `box` is the area the stroke covers (its points, plus half its width each
	 * way, kept inside the page); moving the stamp moves box and points together.
	 */
	| { id: string; kind: 'highlight'; color: HighlightColor; box: StampBox; pen?: PenStroke }
	/**
	 * True redaction. On export, text, image pixels and drawings under the box are
	 * removed from the file (not covered) and the area is painted black. The engine
	 * checks the result or refuses to export.
	 */
	| { id: string; kind: 'redact'; box: StampBox };

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
	/** Lossless only: recompress streams, pack objects, drop unreferenced objects. */
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
		/** After shrinking images, every page still looks like it did before. */
		| 'visual'
		/** Reports the final size. ok even when the target was not reached; ExportResult.shrink.reached says which. */
		| 'target-size';
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
}

export type EngineErrorCode =
	| 'password-required'
	| 'password-wrong'
	| 'unreadable'
	| 'unsupported'
	| 'verification-failed'
	| 'too-large'
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
	exportPlan(plan: ExportPlan, sources: Source[], assets: Asset[]): Promise<ExportResult>;
	/** Characters the bundled stamp font cannot draw; empty string means all good. */
	unsupportedChars(text: string): Promise<string>;
	/** Fillable fields of a source; [] when Source.hasForm is not true. */
	formFields(source: Source): Promise<FormField[]>;
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
