#!/usr/bin/env bash
# Mux a voiceover onto the silent demo video. Video is copied untouched; audio is encoded to AAC and padded/trimmed to the video length.
#   bash video/merge_voice.sh /path/to/voice.m4a      (also accepts .wav / .mp3 / .aiff / .mov with audio)
# Output: video/out/pennbridge-demo-voice.mp4
set -euo pipefail
IMAGE="linuxserver/ffmpeg@sha256:6547359fac23a2747e606d380e10267b2923a38f68485d9cacefd039e74d3aa8"  # same pinned image as record.ts
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VOICE="${1:-}"
[ -n "$VOICE" ] && [ -f "$VOICE" ] || { echo "Usage: bash video/merge_voice.sh <voice.m4a>" >&2; exit 2; }
[ -f "$HERE/out/pennbridge-demo.mp4" ] || { echo "Missing $HERE/out/pennbridge-demo.mp4 - run: npx tsx video/record.ts --po <PO>" >&2; exit 2; }
VDIR="$(cd "$(dirname "$VOICE")" && pwd)"; VFILE="$(basename "$VOICE")"
docker run --rm -v "$HERE/out:/work" -v "$VDIR:/voice:ro" -w /work --entrypoint ffmpeg "$IMAGE" \
  -y -hide_banner -loglevel error \
  -i pennbridge-demo.mp4 -i "/voice/$VFILE" \
  -map 0:v:0 -map 1:a:0 -c:v copy -c:a aac -b:a 192k -ar 48000 -ac 2 \
  -af "apad" -shortest -movflags +faststart pennbridge-demo-voice.mp4
echo "Wrote $HERE/out/pennbridge-demo-voice.mp4"
