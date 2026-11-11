# Survey harness

Measures how the engine (`src/lib/engine/core.ts`, the same core the browser's
engine worker runs) behaves on a large pile of real-world PDFs. Nothing from the
pile is copied into the repo; all output goes to `/home/garrett/pdf-survey/out/`
(or `--out DIR`, or `$SURVEY_OUT`). The tool refuses an output folder inside the repo.

How it runs: plain Node 22.18+ with `--experimental-transform-types` and a small
resolve hook (`register.mjs`, `resolve-ts.mjs`) so the repo's extensionless
TypeScript imports load without a build step. The npm scripts carry the flags.
Needs poppler (`pdfinfo`, `pdftotext`, `pdfimages`) on the PATH as the second,
independent reader. No new npm dependencies.

## Steps

```sh
npm run survey:profile                 # traits of every file → out/profiles.jsonl
npm run survey:sample                  # stratified sample → out/sample.json, out/coverage.tsv
npm run survey:run                     # scenarios → out/results.jsonl, out/suspects/
npm run survey:report                  # out/report.md, out/report.json
```

Every step is resumable: `profile` skips files already in `profiles.jsonl` (by
sha256), `run` skips (file, scenario) pairs already in `results.jsonl`. Delete a
file to redo that step.

Options (pass after `--`, e.g. `npm run survey:run -- --workers 2`):

| step | option | default |
|---|---|---|
| all | `--out DIR` | `/home/garrett/pdf-survey/out` |
| profile | `--input PATH` (repeatable: a folder, or a TSV of sha256, path, size, source) | `pile/files.tsv` if present, else `pile/raw`, plus `tests/corpus/files` |
| profile | `--no-corpus`, `--limit N`, `--workers 3`, `--mem-mb 1500`, `--timeout 90` (s) | |
| sample | `--size 600`, `--k 2`, `--max-mb 100`, `--seed 1`, `--no-pairs`, `--profiles FILE` | |
| run | `--workers 3`, `--mem-mb 1800`, `--timeout 180` (s, per scenario), `--scenarios a,b`, `--limit N`, `--only SHAPREFIX`, `--files LIST` (a file with one sha256 prefix or path per line), `--sample FILE`, `--profiles FILE` | |
| report | `--label TEXT`, `--profiles FILE` | |

Files modified in the last two minutes are skipped by folder discovery (still downloading).

## Isolation

Work runs in child processes (`lib/pool.ts`): a V8 heap cap per child, the
parent kills a child whose resident memory passes `--mem-mb` (WebAssembly memory
sits outside the V8 heap), and a child silent for `--timeout` seconds is killed.
`run` uses a fresh child per file and per-scenario timeouts; after a crash the
remaining scenarios of that file continue in a new child. Poppler runs under
`prlimit --as=2G` with its own timeout. Default memory: 3 × 1.8 GB.

## Scenarios (`run`)

`open`, `plain` (all pages, lossless compress), `arrange` (reverse, rotate one,
duplicate one, delete one, merge two pages of `tests/corpus/files/multi.pdf`),
`stamps` (text, check mark, highlight on first and last page; "Page n of total"),
`protect` (AES-256 + strip metadata), `redact` (box over the first text line of
page 1, found with MuPDF), `forms` and `forms-flat` (only with a fillable form),
`target` (half the original size; only with images).

Outcomes: verified, refused (EngineError with a user message), crashed (engine
`internal` error, other exception, timeout, memory cap, child exit), wrong
(engine verified it, an independent check disagrees), suspect (borderline; PNGs
and the output PDF are in `out/suspects/<sha>/`), needs-password, skipped.

Independent checks: poppler and MuPDF re-open every output and count pages;
MuPDF renders input and output pages at 40 dpi and compares them (thresholds in
`lib/raster.ts`, printed in the report); `arrange` checks every page size with
MuPDF; `stamps` reads the page numbers back with poppler; `protect` checks with
poppler that the file needs the password, uses AES-256 and has no Info/XMP;
`redact` checks with poppler that no word's centre lies inside the box; `forms`
reads answers back with PDF.js, `forms-flat` checks that no widgets remain and the
answer text is on the page (poppler).

## Limits of "wrong"

- Pixel checks compare two renders by the same renderer (MuPDF); a fault MuPDF
  itself hides (or invents in both) is not seen. Only page 1 and one random page
  are compared for `plain`; first and last for `stamps`; page 1 for `redact` and `target`.
- At 40 dpi a change smaller than ~2 px (a moved comma) can pass.
- Where forms are flattened or redaction touches images, the threshold is
  softened to "suspect", not "wrong".
- `redact` checks only the one box and only page-1 text; a box over text that
  poppler cannot extract (no ToUnicode) passes vacuously (noted in the message).
- `forms` matches by field name; a field PDF.js lists under another name is suspect, not wrong.
- `target` is lossy by design; only a mean pixel difference above the threshold is flagged.

The engine code is not changed by this harness; bugs it finds go to the plan's backlog.
