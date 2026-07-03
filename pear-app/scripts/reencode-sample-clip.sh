#!/bin/bash
# Re-encode a source video to Curva's demo profile:
#   H.264 baseline profile (level 3.0), AAC LC, 1280x720, 30fps.
#
# Chromium's built-in decoder (Electron 40) supports this profile without
# extra codec install on macOS, Windows, and most Linux distros. Other
# profiles (Main, High) require system codec support that isn't reliable
# for judges reviewing our build.
#
# Usage:
#   ./scripts/reencode-sample-clip.sh <input.mp4> <output.mp4>
#
# Example:
#   ./scripts/reencode-sample-clip.sh downloads/wc-highlight.mp4 assets/sample-clip.mp4

set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <input> <output>" >&2
  exit 1
fi

INPUT="$1"
OUTPUT="$2"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "error: ffmpeg not found in PATH" >&2
  exit 1
fi

if [ ! -f "$INPUT" ]; then
  echo "error: input file '$INPUT' not found" >&2
  exit 1
fi

ffmpeg -y -i "$INPUT" \
  -c:v libx264 -profile:v baseline -level 3.0 \
  -c:a aac -b:a 128k \
  -vf scale=1280:720 -r 30 \
  -pix_fmt yuv420p \
  -movflags +faststart \
  "$OUTPUT"

echo "done: $OUTPUT"
