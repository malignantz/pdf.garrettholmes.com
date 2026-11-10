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
	| { id: string; kind: 'mark'; mark: 'check' | 'cross' | 'dot'; box: StampBox };

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
	/** Remove Info dictionary and XMP metadata. */
	stripMetadata: boolean;
}

export interface ExportPlan {
	pages: PageRef[];
	options: ExportOptions;
}

export interface VerifyCheck {
	name: 'structure' | 'page-count' | 'page-sizes' | 'reopen' | 'encryption';
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
}

export interface RenderRequest {
	source: Source;
	pageIndex: number;
	/** Target width in CSS pixels times devicePixelRatio, before rotation. */
	width: number;
	rotation: Rotation;
	signal?: AbortSignal;
}

export interface Renderer {
	/** Rejects with AbortError when signal fires. Capped for iOS canvas limits. */
	render(req: RenderRequest): Promise<ImageBitmap>;
	/** Release everything held for a source that was removed. */
	release(sourceId: SourceId): void;
}
