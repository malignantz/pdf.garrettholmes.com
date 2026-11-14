#!/usr/bin/env bash
# Reference rendering with desktop LibreOffice (headless), one file at a time, timed.
# Usage: ref_desktop.sh IN_DIR OUT_DIR
# Needs the extracted AppImage (see README.md): $TRIAL/vendor/lo-desktop/squashfs-root.
set -u
TRIAL=${TRIAL:-/home/garrett/pdf-survey/docx-trial}
SOFFICE=$TRIAL/vendor/lo-desktop/squashfs-root/opt/libreoffice26.8/program/soffice
IN=$1
OUT=$2
mkdir -p "$OUT"
PROFILE=$(mktemp -d)
echo -e "file\tstatus\tseconds" > "$OUT/times.tsv"
for f in "$IN"/*.docx; do
	b=$(basename "$f" .docx)
	t0=$(date +%s.%N)
	timeout 180 "$SOFFICE" -env:UserInstallation=file://$PROFILE --headless --norestore \
		--convert-to pdf --outdir "$OUT" "$f" >/dev/null 2>&1
	rc=$?
	t1=$(date +%s.%N)
	st=ok
	[ -s "$OUT/$b.pdf" ] || st="fail($rc)"
	printf "%s\t%s\t%.2f\n" "$b" "$st" "$(awk "BEGIN{print $t1 - $t0}")" >> "$OUT/times.tsv"
done
rm -rf "$PROFILE"
