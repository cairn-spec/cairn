# Cairn integration guide — browser and PlayCanvas scenes

This guide covers Cairn's generic HTML Audio host and direct scene-engine
wiring. If a project already has positional-audio zones, Cairn can ride the
same triggers and audio players. Captions remain an additive layer.

## Files to ship per scene

```
<scene>/
  audio/narrator_v1/*.opus|*.m4a
  captions_v1/*.vtt                  (one per fragment)
  cairn.json                         (manifest)
  cairn.js + cairn.css               (runtime, immutable-cacheable)
  html-audio-host.js + host.css      (optional compact browser host)
  mobile-viewport.js                 (optional mobile layout stabilization)
```

Caption files follow the same versioning rule as audio: revisions go to
`captions_v2/`, never overwrite.

## Compact sequential browser host

The production-proven browser integration deliberately uses one HTML Audio
element, even when the visual scene is rendered by PlayCanvas or another 3D
engine. `integrations/html-audio-host.js` provides mobile audio unlock,
Opus/AAC selection, cue-boundary resume, mute, replay, and fail-soft caption
behavior:

```html
<link rel="stylesheet" href="cairn.css">
<link rel="stylesheet" href="host.css">
<script src="cairn.js"></script>
<script src="html-audio-host.js"></script>
<script>
CairnHost.mount({
  manifestUrl: "./cairn.json",
  volume: 0.8,
  resetParams: ["cairnReset", "waysideReset"]
}).then(controller => {
  window.__cairn = controller; // optional QA hook
});
</script>
```

This host is a compact path for small `first-move` + `after` scenes. It can
migrate legacy `wayside.<scene>` and `wayside.muted` state by copying it
forward without deleting rollback state. Its compact presentation hides the
generic transcript panel while retaining captions, CC, and sound/replay.

### Shared HTML audio ownership

The HTML Audio host intentionally reuses one `<audio>` element while changing its
source between fragments. A shared player must have one physical `ended`
listener, and that event must be routed only to the fragment currently owning
playback. Never attach one unscoped `ended` listener per logical fragment to the
same player: a single event can otherwise finish the current fragment, start
the next queued fragment, then immediately finish that new fragment through a
second listener. Cairn's `HtmlAudioAdapter` performs this identity routing.

## Direct PlayCanvas sound-slot wiring (one scene script)

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

- **Small**: `first-move` opener + an `after` chain
  with ~10s delays. No zones at all. See `examples/small-scene.cairn.json`.
- **Medium**: chain + a few zones. Positional triggers preempt the chain at
  cue boundaries by default; the displaced segment re-offers.
- **Large traversal**: `first-move` opener + zones throughout the route.
  See `examples/persistent-traversal.cairn.json`.

**Preemption contract:** a zone entered while another voice plays takes the
floor at the current cue boundary — never mid-sentence. Protect authored
moments (endings) with `"preemptible": false`; disable scene-wide with
`"defaults": {"positionalPreempts": false}`.

**Persistent traversal contract:** when discovering a zone should commit its
narration even after the visitor walks on, set
`"defaults": {"positionalQueue": "persistent"}`. Entries latch FIFO, the
current narration finishes, and `leaveZone()` does not cancel queued or active
fragments. This is useful for closely spaced cues in corridor scenes; do not
use it for object-presence experiences that should stop on walk-away.

**Exceptional object encounter contract:** when one authored location must
temporarily interrupt a sequential program and then return the visitor to the
exact point they left, do not emulate this with queue reordering or partial
preemption. Fade the current player down, capture its exact playback clock, and
call `engine.interruptWith("lantern", { at: currentTime })`. Play the exceptional
fragment fully, then follow the engine's restored `active` fragment and
`resumeAt` clock, fading that audio back in. If the encounter occurs during an
`after` delay, Cairn pauses and restores the remaining delay automatically.
The suspended fragment, queue, and delay state persist across reloads. The
HTML Audio host exposes the complete fade/state operation as
`controller.interruptWith(id, { fadeOutMs, fadeInMs })`.

Call `enterZone` even when audio cannot start yet (pre-unlock): the engine
runs cues on a wall clock so captions begin before the autoplay gesture, and
the audio clock takes over automatically once the slot is actually playing.

## Behavior contract (do not re-implement in engine code)

The engine owns: default-on state, toggle persistence, one-voice-at-a-time
queueing, walk-away cue completion, play-once-per-visit, partial re-offer,
cue-boundary resume, transcript accumulation, and direction ticks. The scene
owns: zone geometry, audio playback/fades, and calling the three methods above.
Call `engine.rememberProgress()` during page hide, and use the public
`engine.resetVisit()` API for an explicit replay control. If a behavior
seems missing, extend Cairn — don't fork caption logic into the scene.

## State hooks

`engine.store.playedState(id)` returns `null | "partial" | "complete"` and
`engine.transcript` is the session log. Hosts may use these for navigation,
progress UI, analytics, or accessibility surfaces without duplicating playback
state.

## QA checklist

- [ ] Captions visible on first load with sound muted, before any gesture
- [ ] Direction ticks appear ONLY on ambience captions (narration carries none, by design — see SPEC behavior 4); off-axis >30°
- [ ] Walking out mid-fragment: audio fades (existing), current caption
      finishes, then dismisses; fragment re-offers on re-entry
- [ ] Two overlapping zones: second fragment queues with hint line, never
      interleaves
- [ ] Persistent queue scene: enter and leave two zones while another fragment
      plays; both remain queued FIFO and each narration finishes completely
- [ ] Shared audio player: with one fragment active and two queued, one physical
      `ended` event starts only the first queued fragment and leaves the second
      queued
- [ ] Exceptional encounter: active narration fades down, exceptional narration
      plays once, and the interrupted narration resumes at its saved clock with
      captions synchronized; repeat while in an `after` gap and across reload
- [ ] CC toggle persists across reload (localStorage `cairn.<scene>`)
- [ ] Legacy `wayside.<scene>` state copies forward without being deleted
- [ ] Generic integrations: transcript panel accumulates and scrolls
- [ ] Compact host: no transcript control or panel is exposed
- [ ] VoiceOver/NVDA announce cue text (ARIA live region)
- [ ] Contrast ≥ 7:1 at default styles on the brightest scene background
