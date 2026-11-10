/**
 * Shared handles every export stage module (forms, redact, stamps, numbering,
 * shrink) receives. Created once per engine in core.ts; every loader is lazy and
 * memoized, so a stage that does not need an engine never loads it.
 */

import type * as PdfLib from '@cantoo/pdf-lib';
import type { StampFont } from './font';
import type { Mupdf } from './mupdf';
import type { PdfjsLib } from './pdfjs';
import type { Qpdf } from './qpdf';

export interface EngineDeps {
	/** qpdf runner (each run is a fresh instance; runs are serialized). */
	qpdf: Qpdf;
	/** MuPDF.js, loaded on first call (~10 MB wasm). */
	mupdf: () => Promise<Mupdf>;
	/** PDF.js, configured for this environment. Copy bytes before handing them over: PDF.js transfers its input. */
	pdfjs: () => Promise<PdfjsLib>;
	/** @cantoo/pdf-lib. */
	pdfLib: () => Promise<typeof PdfLib>;
	/** The bundled stamp font (bytes, fontkit, glyph coverage). */
	font: StampFont;
}
