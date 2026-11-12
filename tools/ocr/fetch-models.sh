#!/bin/sh
# Language data for the OCR measurement (not part of the app). Downloads into tools/ocr/models/
# and checks each file against the SHA-256 recorded here (tessdata repos, main branch, 2026-11-12).
#   fast      tessdata_fast/eng.traineddata   (LSTM, 8-bit integer, small)
#   best      tessdata_best/eng.traineddata   (LSTM, float)
#   best_int  @tesseract.js-data/eng 4.0.0_best_int (integer LSTM of tessdata; what tesseract.js serves by default)
#   std       @tesseract.js-data/eng 4.0.0          (tessdata: legacy + LSTM)
#   osd       tessdata_fast/osd.traineddata   (orientation and script detection, legacy engine)
set -eu
cd "$(dirname "$0")"
get() { mkdir -p "models/$1"; [ -f "models/$1/$2" ] || curl -fsSL -o "models/$1/$2" "$3"; }
get fast eng.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/eng.traineddata
get best eng.traineddata https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata
get osd osd.traineddata https://github.com/tesseract-ocr/tessdata_fast/raw/main/osd.traineddata
mkdir -p models/best_int models/std
[ -f models/best_int/eng.traineddata ] || gunzip -c node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz > models/best_int/eng.traineddata
[ -f models/std/eng.traineddata ] || gunzip -c node_modules/@tesseract.js-data/eng/4.0.0/eng.traineddata.gz > models/std/eng.traineddata
sha256sum -c <<'SUMS'
8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba  models/best/eng.traineddata
7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2  models/fast/eng.traineddata
9cf5d576fcc47564f11265841e5ca839001e7e6f38ff7f7aacf46d15a96b00ff  models/osd/osd.traineddata
5dc5d8d640a212c9d6184921ba103b186f50e0fed9ee716c53e6b312b400d747  models/best_int/eng.traineddata
daa0c97d651c19fba3b25e81317cd697e9908c8208090c94c3905381c23fc047  models/std/eng.traineddata
SUMS
