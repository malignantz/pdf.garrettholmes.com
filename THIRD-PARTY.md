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
| pdf-lib dependencies: fflate, culori, node-html-better-parser, tslib | see package-lock.json | MIT / MIT / MIT / 0BSD | Bundled with pdf-lib |
| [@cantoo/fontkit](https://github.com/cantoo-scribe/fontkit) | 2.0.12 | MIT | Font subsetting for text stamps, glyph coverage |
| fontkit dependencies: restructure, brotli, dfa, fflate | see package-lock.json | MIT | Bundled with fontkit |
| [Noto Sans](https://github.com/notofonts/latin-greek-cyrillic) Regular (`src/lib/engine/fonts/NotoSans-Regular.ttf`, from `@expo-google-fonts/noto-sans` 0.4.2) | Noto LGC | SIL Open Font License 1.1 (`src/lib/engine/fonts/OFL.txt`) | Text stamps (embedded as a subset) |

## Handwriting fonts for typed signatures (`src/lib/editor/fonts/`)

Loaded only when the signature pad's Type tab opens. Latin and Latin Extended subsets,
WOFF2, from the [Fontsource](https://fontsource.org) npm packages (version 5.3.0).

| Font | Files | License |
|---|---|---|
| [Great Vibes](https://github.com/googlefonts/great-vibes) | `great-vibes-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`great-vibes-OFL.txt`) |
| [Dancing Script](https://github.com/googlefonts/DancingScript) | `dancing-script-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`dancing-script-OFL.txt`) |
| [Caveat](https://github.com/googlefonts/caveat) | `caveat-latin{,-ext}-400-normal.woff2` | SIL Open Font License 1.1 (`caveat-OFL.txt`) |
