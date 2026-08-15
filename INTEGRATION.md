# Cairn integration guide — PlayCanvas / ASM scenes

For the engine-side implementer (Codex, per the ASM division of labor). This
document assumes the positional-audio zone system from
`NARRATION_INTEGRATION_HANDOFF.md` (Peachtree Creek) is in place — Cairn
rides the same triggers and the same audio slots. Nothing here changes the
audio behavior; captions are an additive layer.

## Files to ship per scene

```
<scene>/
  audio/narrator_v1/*.opus|*.m4a     (already deployed for peachtreecreek)
  captions_v1/*.vtt                  (one per fragment — Steve's side generates)
  cairn.json                       (manifest — see examples/peachtreecreek.cairn.json)
  cairn.js + cairn.css           (runtime, immutable-cacheable)
```

Caption files follow the same versioning rule as audio: revisions go to
`captions_v2/`, never overwrite.

## Wiring (one scene script)

```js
// 1. Boot
var adapter = new Cairn.PlayCanvasAdapter(this.app, cameraEntity);
adapter.registerSlot("gauge", narratorGaugeEntity, "gauge"); // per fragment
var engine = new Cairn.Engine(manifest, adapter).attach(document.body);

// 2. Load cues (fetch each fragment's VTT, or precompiled .cues.json)
fetch("captions_v1/gauge.vtt").then(r => r.text())
  .then(vtt => engine.loadCues("gauge", vtt));

// 3. Bridge the triggers
//    a. First movement — call once on the visitor's first navigation input
//       (this is also the audio-unlock gesture; start opener audio here too):
onFirstInput: engine.notifyMovement();
//    b. Zones — wherever the audio zones already fire play/stop:
onZoneEnter:  engine.enterZone("waters-edge");   // BEFORE audio .play()
onZoneLeave:  engine.leaveZone("waters-edge");   // audio fade proceeds as-is
//    c. Sequential (`after`) fragments need NO engine-side wiring — the
//       runtime schedules them from the manifest. The scene just needs to
//       start each fragment's audio when the engine activates it (listen
//       for engine.active changing in your update loop, or start audio in
//       the same zone/movement handlers for positional fragments).

// 4. Drive
this.app.on("update", function () { engine.tick(); });
```

## Scene sizes — same runtime, different manifests

- **Small** (Cator Spring class): `first-move` opener + an `after` chain
  with ~10s delays. No zones at all. See `examples/small-scene.cairn.json`.
- **Medium**: chain + a few zones. Positional triggers preempt the chain at
  cue boundaries by default; the displaced segment re-offers.
- **Large** (Peachtree, BeltLine): `first-move` opener + zones everywhere.
  See `examples/peachtreecreek.cairn.json`.

**Preemption contract:** a zone entered while another voice plays takes the
floor at the current cue boundary — never mid-sentence. Protect authored
moments (endings) with `"preemptible": false`; disable scene-wide with
`"defaults": {"positionalPreempts": false}`.

Call `enterZone` even when audio cannot start yet (pre-unlock): the engine
runs cues on a wall clock so captions begin before the autoplay gesture, and
the audio clock takes over automatically once the slot is actually playing.

## Behavior contract (do not re-implement in engine code)

The engine owns: default-on state, toggle persistence, one-voice-at-a-time
queueing, walk-away cue completion, play-once-per-visit, partial re-offer,
transcript accumulation, direction ticks. The scene owns: zone geometry,
audio playback/fades, and calling the three methods above. If a behavior
seems missing, extend Cairn — don't fork caption logic into the scene.

## Registry hooks (for the necklace structure, later)

`engine.store.playedState(id)` returns `null | "partial" | "complete"` and
`engine.transcript` is the session log. The bead-completion registry reads
these — no additional caption-side work is needed to support it.

## QA checklist

- [ ] Captions visible on first load with sound muted, before any gesture
- [ ] Direction ticks appear ONLY on ambience captions (narration carries none, by design — see SPEC behavior 4); off-axis >30°
- [ ] Walking out mid-fragment: audio fades (existing), current caption
      finishes, then dismisses; fragment re-offers on re-entry
- [ ] Two overlapping zones: second fragment queues with hint line, never
      interleaves
- [ ] CC toggle persists across reload (localStorage `cairn.<scene>`)
- [ ] Transcript panel accumulates and scrolls; ambience entries italic
- [ ] VoiceOver/NVDA announce cue text (ARIA live region)
- [ ] Contrast ≥ 7:1 at default styles on the brightest scene background
