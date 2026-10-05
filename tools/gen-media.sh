#!/bin/sh
# WebM-ролик для e2e (решение Р-9): Chromium из Playwright не декодирует H.264/AAC, поэтому VP9 + Opus.
# Синтетический: тестовая таблица ffmpeg и синус 440 Гц, 60 с. Флаги bitexact — чтобы повторный запуск давал тот же файл.
set -eu

cd "$(dirname "$0")/.."
OUT=tools/kpmock/media/sample.webm

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "gen-media: ffmpeg not found (brew install ffmpeg)" >&2
  exit 1
fi
ENCODERS=$(ffmpeg -hide_banner -encoders 2>/dev/null)
for enc in libvpx-vp9 libopus; do
  if ! printf '%s\n' "$ENCODERS" | grep -q " $enc "; then
    echo "gen-media: ffmpeg has no $enc encoder" >&2
    exit 1
  fi
done

mkdir -p "$(dirname "$OUT")"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i testsrc=size=320x180:rate=15 \
  -f lavfi -i sine=frequency=440:sample_rate=48000 \
  -t 60 -c:v libvpx-vp9 -b:v 40k -threads 1 -c:a libopus -b:a 16k \
  -map_metadata -1 -fflags +bitexact -flags:v +bitexact -flags:a +bitexact \
  "$OUT"
echo "gen-media: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"
