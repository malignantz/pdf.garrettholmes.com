# jpeg-repack: lossless JPEG Huffman optimisation in WebAssembly

Used by the stream pass of compressed exports (`../../pack.ts`, loader `../../jpeg-repack.ts`).
It rewrites the entropy coding of a JPEG with optimised Huffman tables, baseline sequential,
and leaves every DCT coefficient as it was; it also compares two JPEGs coefficient by
coefficient. Measurement behind it: `/home/garrett/pdf-survey/out-jpeg-repack/notes.md`.

| File | What |
|---|---|
| `repack.c` | our wrapper (about 200 lines): `jr_repack`, `jr_verify`; this repository's licence |
| `build.sh` | the reproducible build (downloads and checks the upstream tarball, builds, writes `wasm.ts`) |
| `wasm.ts` | the built module, base64, with its SHA-256 (checked by `tests/engine/jpeg-repack.test.ts`) |
| `LICENSE.md`, `README.ijg` | libjpeg-turbo's licence texts, copied unchanged from the tarball |

## Provenance

- **Upstream:** libjpeg-turbo **3.1.4.1**, release tarball
  `https://github.com/libjpeg-turbo/libjpeg-turbo/releases/download/3.1.4.1/libjpeg-turbo-3.1.4.1.tar.gz`,
  SHA-256 `ecae8008e2cc9ade2f2c1bb9d5e6d4fb73e7c433866a056bd82980741571a022`
  (tag 3.1.4.1, commit `9217719d3a58633923b096af4c1d50d304768a64`). Not patched: the only
  change is configuration (below) and our own `repack.c`.
- **Toolchain:** Emscripten **6.0.13** (emsdk, `e13ee988ce3d87a738dd8f3661d02223308c412a`), cmake 3.31.
- **Build:** `EMSDK=/path/to/emsdk ./build.sh [workdir]`. libjpeg is configured with
  `-DWITH_SIMD=0 -DWITH_ARITH_DEC=0 -DWITH_ARITH_ENC=0 -DWITH_TURBOJPEG=0 -DWITH_TOOLS=0 -DWITH_TESTS=0`,
  compiled with `-Oz -flto -DNO_GETENV`, and linked as a standalone wasm
  (`-sSTANDALONE_WASM --no-entry -sMALLOC=emmalloc -sALLOW_MEMORY_GROWTH -sMAXIMUM_MEMORY=1GB`).
  Two builds in different directories gave the same bytes.
- **Result:** 185,345 bytes of wasm (27.7 KB brotli, 32.8 KB gzip); as the base64 module the
  site serves, 40.1 KB brotli, 47.0 KB gzip. SHA-256
  `4bf67c70d25d1c65492cc7c3d98295627d48f95d82025d3a6cfe40c709ae5d74`.

## Interface

The module imports one function (`env.emscripten_notify_memory_growth`, a no-op) and needs
no Emscripten JavaScript glue. Exports: `_initialize`, `memory`, `jr_malloc`, `jr_free`,
`jr_repack(in, n, maxCoef)`, `jr_out_ptr`, `jr_out_len`, `jr_out_free`,
`jr_verify(a, na, b, nb, maxCoef)`, `jr_last_error`, `jr_test_tamper` (tests only).

- libjpeg errors **trap** (`error_exit` stores the message code, then `unreachable`): no
  setjmp, so no wasm exception handling is needed; the loader drops a trapped instance.
- A libjpeg **warning** (corrupt or truncated data, which libjpeg would otherwise fill in
  silently) fails the call.
- **Markers:** the output carries the input's APP0 `JFIF`, APP2 `ICC_PROFILE` and APP14
  `Adobe` segments byte for byte, in input order, and nothing libjpeg would write itself
  (`write_JFIF_header` and `write_Adobe_marker` are off). EXIF, XMP, thumbnails, comments
  and other APPn segments are dropped. Restart markers are not written.
- **Memory:** `maxCoef` caps the coefficient buffers (`max_memory_to_use` too); progressive
  input with more than 1,000 scans is refused.
