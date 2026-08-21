#!/usr/bin/env bash
# encode-audio.sh — WAV masters → Cairn delivery pair (.opus + .m4a).
#
# Usage:
#   ./encode-audio.sh master.wav [more.wav ...]      # encode alongside source
#   OUT=path/to/dir ./encode-audio.sh *.wav          # encode into OUT
#
# Production delivery defaults: mono, 48kHz,
# Opus 64k (primary) + AAC-LC 96k (fallback for old Safari/kiosks).
# Always feed this WAV/AIFF masters — never re-encode from lossy.
set -uo pipefail
command -v ffmpeg >/dev/null || { echo "ffmpeg not found"; exit 1; }
[ $# -ge 1 ] || { echo "usage: encode-audio.sh <master.wav> [...]"; exit 2; }

for IN in "$@"; do
  [ -f "$IN" ] || { echo "skip (not found): $IN"; continue; }
  BASE=$(basename "${IN%.*}")
  DIR="${OUT:-$(dirname "$IN")}"
  mkdir -p "$DIR"
  ffmpeg -hide_banner -loglevel error -y -i "$IN" \
    -ac 1 -ar 48000 -c:a libopus -b:a 64k "$DIR/$BASE.opus" \
    && echo "✓ $DIR/$BASE.opus"
  ffmpeg -hide_banner -loglevel error -y -i "$IN" \
    -ac 1 -ar 48000 -c:a aac -b:a 96k -movflags +faststart "$DIR/$BASE.m4a" \
    && echo "✓ $DIR/$BASE.m4a"
done
