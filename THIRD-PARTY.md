# Third-party components

Everything below is bundled and served from this site's own origin. All licenses are
compatible with this project's AGPL-3.0-or-later.

## PDF engine (`src/lib/engine/`)

| Component | Version | License | Used for |
|---|---|---|---|
| [qpdf](https://github.com/qpdf/qpdf), compiled to WebAssembly by [@neslinesli93/qpdf-wasm](https://github.com/neslinesli93/qpdf-wasm) | qpdf 12.2.0, package 0.3.1 | qpdf: Apache-2.0; wasm wrapper: ISC | Decrypting and rewriting inputs, assembling pages, rotation, compression, AES-256 encryption, metadata removal, `--check` |
| libjpeg-turbo and zlib, linked into the qpdf build | as built by the package | IJG / BSD-3-Clause / zlib | Stream decoding inside qpdf |
| [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`, legacy build) | 6.5.438 | Apache-2.0 | Page geometry at intake, independent re-open check at export |
| [MuPDF.js](https://mupdf.readthedocs.io/) (`mupdf`, by Artifex; MuPDF compiled to WebAssembly) | 1.28.6 | AGPL-3.0-or-later | Form fields, redaction, image shrinking (phase 2). Loaded on first use only; ~10 MB wasm |
| [@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) (maintained pdf-lib fork) | 2.11.1 | MIT | Image and blank pages, stamps, rebuilding damaged files |
| pdf-lib dependencies: fflate, culori, node-html-better-parser, tslib | see package-lock.json | MIT / MIT / MIT / 0BSD | Bundled with pdf-lib; fflate is also used directly by the lossless stream pass (inflate, fallback deflate) |
| [libdeflate](https://github.com/ebiggers/libdeflate) compiled to WebAssembly by [libdeflate.js](https://codeberg.org/EvanHahn/libdeflate.js) (npm `libdeflate`) | package 0.1.0 (2026-01-09); 58 KB wasm, vendored as base64 in `src/lib/engine/vendor/libdeflate/wasm.ts` with the package's `LICENSE.txt` | MIT (wrapper: Evan Hahn; libdeflate: Eric Biggers, Google) | Lossless compression at export (levels 6 and 12). Vendored, not installed: the package declares Node ≥ 24 and CI runs Node 22 with `engine-strict`; its Emscripten glue is replaced by `src/lib/engine/libdeflate.ts`. Loaded on first compressed export; no fetch |
| [libjpeg-turbo](https://libjpeg-turbo.org/) compiled to WebAssembly by us (`src/lib/engine/vendor/jpeg-repack/`: wrapper `repack.c`, reproducible `build.sh`, provenance in its README) | 3.1.4.1 (release tarball, SHA-256 `ecae8008…a022`), Emscripten 6.0.13; 185 KB wasm vendored as base64 (40 KB brotli as served) | IJG License, Modified BSD (3-clause), zlib (texts: `LICENSE.md`, `README.ijg` there); wrapper: this repository's AGPL-3.0-or-later | Lossless JPEG repack at export: optimised Huffman tables, the same DCT coefficients, checked coefficient by coefficient. Loaded on the first compressed export of a file with JPEG images; no fetch. This software is based in part on the work of the Independent JPEG Group |
| [@cantoo/fontkit](https://github.com/cantoo-scribe/fontkit) | 2.0.12 | MIT | Font subsetting for text stamps, glyph coverage |
| fontkit dependencies: restructure, brotli, dfa, fflate | see package-lock.json | MIT | Bundled with fontkit |
| [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) Regular (`src/lib/engine/fonts/NotoSans-Regular.ttf`, from `@expo-google-fonts/noto-sans` 0.4.2) | Noto LGC | SIL Open Font License 1.1 (`src/lib/engine/fonts/OFL.txt`) | Text stamps (embedded as a subset) |

## OCR for "Make scanned pages searchable" (`src/lib/engine/ocr/`)

Loaded only when an export uses the option (desktop), from this site, and kept by the
service worker after first use. About 9 MB as served (the language data is gzipped by us;
one core of each kind is fetched).

| Component | Version | License | Used for |
|---|---|---|---|
| [tesseract.js](https://github.com/naptha/tesseract.js) worker script (`dist/worker.min.js`) | 7.0.0 | Apache-2.0 (bundles buffer, regenerator-runtime, zlib.js: MIT; ieee754: BSD-3-Clause) | Runs the OCR engine in its own worker. Its main-thread API is not used: `ocr/tess.ts` speaks the worker's message protocol, so no URL of its own (jsDelivr by default) is ever built |
| [tesseract.js-core](https://github.com/naptha/tesseract.js-core): Tesseract (a fork with wasm build changes) and Leptonica, with libpng and zlib, compiled to WebAssembly | 7.0.0; the `.wasm.js` builds (wasm inside): LSTM-only (`relaxedsimd-lstm`, `simd-lstm`, `lstm`) for reading, legacy (`relaxedsimd`, `simd`, plain) for orientation detection | Apache-2.0 (Tesseract, the package); Leptonica: BSD-2-Clause; libpng: libpng License; zlib: zlib License | Reading text, deskew, Sauvola binarisation, orientation and script detection |
| [tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) `eng.traineddata` and `osd.traineddata` (`src/lib/engine/vendor/tesseract/*.gz`, gzipped by us; SHA-256 of the unpacked files `7d4322bd…70b2` and `9cf5d576…0ff`, as in tools/ocr/fetch-models.sh) | main branch (2019 files) | Apache-2.0 (`src/lib/engine/vendor/tesseract/LICENSE-Apache-2.0.txt`) | English `fast` LSTM model; orientation and script data |
| Tesseract's glyphless font `pdf.ttf` (572 bytes, as base64 in `src/lib/engine/ocr/glyphless.ts`, SHA-256 checked by a test) | Tesseract 5 | Apache-2.0 | The invisible text layer: every character drawn with a blank glyph |
| wasm-feature-detect probes (two byte strings in `ocr/browser.ts`) | 1.8.0 | Apache-2.0 | Choosing the relaxed-SIMD, SIMD or plain core |

## Handwriting fonts for typed signatures (`src/lib/editor/fonts/`)

Loaded only when the signature pad's Type tab opens. Latin and Latin Extended subsets,
WOFF2, from the [Fontsource](https://fontsource.org) npm packages (version 5.3.0).

| Font | Files | License |
|---|---|---|
| [Great Vibes](https://github.com/googlefonts/great-vibes) | `great-vibes-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`great-vibes-OFL.txt`) |
| [Dancing Script](https://github.com/googlefonts/DancingScript) | `dancing-script-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`dancing-script-OFL.txt`) |
| [Caveat](https://github.com/googlefonts/caveat) | `caveat-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`caveat-OFL.txt`) |
