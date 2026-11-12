declare module 'pdfjs-dist/legacy/image_decoders/pdf.image_decoders.mjs' {
	/** PDF.js's pure-JavaScript JPEG decoder (used by tests as a second, independent decoder). */
	export class JpegImage {
		constructor(options?: { decodeTransform?: Int32Array; colorTransform?: number });
		width: number;
		height: number;
		parse(data: Uint8Array): void;
		getData(o: { width: number; height: number; forceRGB?: boolean; isSourcePDF?: boolean }): Uint8Array;
	}
}
