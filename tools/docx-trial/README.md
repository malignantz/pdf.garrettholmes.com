# Word (.docx) to PDF in the browser: measurement harness (2026-11-14)

Not wired into the app. Results: `docs/plans/plan-2026-11-09.md` ("Word to PDF trial (2026-11-14)");
the full write-up is `/home/garrett/pdf-survey/docx-trial/report.md`; raw numbers in `$TRIAL/out/`.

Nothing large lives in the repo. Engines, fonts, test files and outputs are under
`$TRIAL=/home/garrett/pdf-survey/docx-trial`:

| Path | What |
|---|---|
| `vendor/npm/*.tgz`, `vendor/x/<pkg>/` | `npm pack` of `@matbee/libreoffice-converter@2.7.2`, `@bentopdf/libreoffice-wasm@2.3.1`, `zetajs@1.2.0`, `mammoth@1.13.0`, `docx-preview@0.4.1`, `jszip`, unpacked (`tar xzf X.tgz -C vendor/x/<name>`) |
| `vendor/zeta/` | ZetaOffice build: `soffice.js`, `soffice.wasm`, `soffice.data`, `soffice.data.js.metadata` downloaded once from `https://cdn.zetaoffice.net/zetaoffice_latest/` (`curl --compressed`), plus `zetajs/` = `vendor/x/zetajs-1.2.0/package/source` |
| `vendor/chunks/{matbee,zeta}/` | `node chunk.mjs <soffice.wasm or .data> vendor/chunks/<build>`: gzip pieces under 24 MiB and a manifest |
| `vendor/lo-desktop/` | Desktop LibreOffice 26.8.2.2 (reference renderer): `LibreOffice-26.8.2.2.basic-x86_64.AppImage` from `https://appimages.libreitalia.org/`, extracted with `--appimage-extract` (no FUSE, no sudo). Its `share/fonts/truetype/` also supplies Carlito, Caladea and Liberation to the HTML routes and office2pdf |
| `vendor/office2pdf/` | `git clone --depth 1 https://github.com/developer0hye/office2pdf` (commit e02eee4), built with a private Rust toolchain in `vendor/rust/` (rustup with `RUSTUP_HOME`/`CARGO_HOME` there): `cargo install wasm-bindgen-cli --version 0.2.115 --locked`, `cargo build --release --locked --target wasm32-unknown-unknown -p office2pdf --features wasm`, `wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/office2pdf.wasm` |
| `vendor/venv/` | `python3 -m venv` with `python-docx pillow numpy` |
| `gen/` | synthetic test set: `vendor/venv/bin/python gen_corpus.py $TRIAL/gen` |
| `raw/` | real public .docx with the PDF Word exported from each (`pairs.tsv`); untrusted, never in the repo |
| `out/` | outputs: `out/<set>/<candidate>/` with PDFs, `results.tsv`, `load.json`, `compare.tsv` |

## Steps

```sh
T=tools/docx-trial
./$T/ref_desktop.sh $TRIAL/gen $TRIAL/out/gen/lo-desktop        # reference (desktop LibreOffice)
EVAL=1 node $T/serve.mjs 4395 &                                  # COOP/COEP, CSP; EVAL=1 adds 'unsafe-eval'
ls $TRIAL/gen/*.docx | sed 's#.*/gen/#/docs/gen/#' > $TRIAL/gen-list.txt
PORT=4395 node $T/run.mjs lo $TRIAL/out/gen/lo $TRIAL/gen-list.txt          # candidates: lo zeta office2pdf mammoth docxpreview
PORT=4395 node $T/run.mjs lo $TRIAL/out/gen/lo-phone $TRIAL/gen-list.txt --phone
$TRIAL/vendor/venv/bin/python $T/compare.py REF_DIR CAND_DIR OUT.tsv
$TRIAL/vendor/venv/bin/python $T/sbs.py OUT.png PAGE ref=A.pdf cand=B.pdf
```

`run.mjs` drives system Chrome headless (`/opt/google/chrome/chrome`) with Playwright from the
repo's `node_modules`, aborts every request that is not to 127.0.0.1, reloads the page when a
conversion hangs, and records time to ready, bytes served, Chrome's resident memory and per-file times.
Run one browser at a time on the box.
