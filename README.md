# Cairn

**Captions for spatial media** — walkable 3D scenes, gaussian splats, virtual
tours: media with no master timeline, where the visitor's movement is the
play head.

Named for the walker's cairn: stones stacked along a path, encountered on
arrival, marking the way without pointing — each passing traveler adds one.

## The idea in three sentences

Video captions assume one clock; a walkable scene has none. Cairn splits
captioning into a **spatial layer** (zones trigger fragments), a **temporal
layer** (standard, unforked WebVTT within each fragment), and a **state
layer** (once-per-visit, one-voice-at-a-time, transcript). Text is the
primary track and audio the enhancement — a fully muted Cairn scene is
still a complete experience.

## Layout

```
SPEC.md               the v0.1 spec — model, manifest schema, normative behaviors
tools/
  cairn_align.py    authoring: script + Whisper timings → VTT / cues / SRT
  align_srt.py        forced-alignment + segmentation engine (stdlib only)
  tests/              58 tests
runtime/
  cairn.js          engine-agnostic core + HtmlAudio & PlayCanvas adapters
  cairn.css         WCAG-minded overlay styles
  test_cairn.mjs    22 node tests over core + Bell pilot regressions
integrations/
  asm-html-audio.js  reusable ASM browser-audio/gesture/replay host
  asm.css            ASM controls + responsive caption safe zones
  test_asm_host.mjs  audio-source selection tests
demo/
  index.html          double-click demo: zones as buttons, real pipeline output
examples/
  oaklandbelltower.cairn.json deployed sequential-pilot manifest
  peachtreecreek.cairn.json   spatial-zone / PlayCanvas target manifest
INTEGRATION.md        engine-side wiring guide (PlayCanvas first)
writeup/              the public announcement draft
```

## Authoring quickstart

```bash
# One narration fragment: known script + Whisper word timestamps in, VTT out
python3 tools/cairn_align.py script.txt whisper.json \
    --vtt gauge.vtt --cues gauge.cues.json \
    --speaker Narrator --fragment-id gauge

# NLE captions too (Premiere/Resolve), with a sequence-start offset
python3 tools/cairn_align.py script.txt whisper.json \
    --srt gauge.srt --offset 01:00:00:00@23.976
```

## Runtime quickstart

Open `demo/index.html` in a browser. Read `INTEGRATION.md` for real-scene
wiring. The core is engine-agnostic: implement `clock()` and `bearing()`
against any engine and the spec's behaviors come for free.

## Status

v0.1 draft. Proven: authoring pipeline (58 tests), core behaviors and Bell
pilot regressions (22 node tests), three ASM host tests, file-URL demo, and
the sequential HTML Audio integration in the live Oakland Bell Tower
PlayCanvas-rendered splat scene. Not yet proven: direct PlayCanvas sound-slot
adapter with positional zones (first target: Peachtree Creek), WebXR
presentation, multi-language manifests.

MIT (intended) — spec, runtime, and tools together.
