# Curva Assets

## `sample-clip.mp4`

Bundled fallback demo clip. Loaded when a room's `room/settings.videoUrl` is empty.

**Codec pin (do not deviate):**
- H.264 baseline profile, level 3.0
- AAC LC audio, 128 kbps
- 1280x720 @ 30fps
- yuv420p pixel format
- `+faststart` movflag (metadata at head, streams from any range read)

**Why baseline:** Electron 40's bundled Chromium supports H.264 baseline out of
the box on macOS, Windows, and most desktop Linux. Main/High profiles need
system codec support that is not reliable across the judge machines.

## Sourcing

Phase 0 ships a **placeholder** (`sample-clip.mp4.placeholder`, 0 bytes). Ops
must source a real, license-clear clip before the Phase 2 clip-share demo.

Candidates (all confirmed as public-good / CC-licensed in past years - re-verify
before demo day):

- Deutsche Welle (dw.com) World Cup archive clips (some CC BY-SA)
- RAI Teche archive (RAI Italian public broadcaster, historical clips)
- FIFA official YouTube (some clips marked CC)
- Wikimedia Commons category "Association football videos"

**Do NOT bundle any FIFA-owned broadcast footage without a written license.**
The Curva narrative is that peers watch a legally-obtained broadcast on their
own screens; the app syncs playhead only. The bundled sample is for demo-day
insurance when the judges' machines don't have a broadcast tuned in.

## Re-encoding

```sh
./scripts/reencode-sample-clip.sh downloads/source.mp4 assets/sample-clip.mp4
```

After re-encode, verify:

```sh
ffprobe -show_streams assets/sample-clip.mp4 | grep -E '(codec_name|profile|width|height|r_frame_rate)'
```

Expected:

```
codec_name=h264
profile=Constrained Baseline
width=1280
height=720
r_frame_rate=30/1
codec_name=aac
profile=LC
```

## License file

Once a clip is sourced, add `assets/sample-clip.LICENSE.txt` noting:

- Source URL
- License (e.g. `CC BY-SA 4.0`)
- Original creator attribution
- Fetch date

`sample-clip.mp4` MUST NOT be committed without a matching `LICENSE.txt`.
