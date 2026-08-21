# Cairn — captions for spatial media

**A caption standard for walkable 3D scenes (3DGS and beyond), v0.2 release candidate**

Named for the walker's cairn: stones stacked along a path, encountered by
arriving, marking the way without pointing at anything — and added to by
each traveler who passes. Cairn brings captions to media that has no master
clock — gaussian-splat scenes, virtual tours, walking simulators — where
playback is triggered by *position* and the visitor, not the editor,
controls time.

## 1. Why video captions don't transfer

WebVTT and every caption system since broadcast assume: one media element, one
monotonic timeline, one track, a passive viewer. A navigable scene violates
all four. Audio starts when a visitor crosses a zone boundary; fragments can
be interrupted by walking away, re-entered later, or never found at all;
multiple sources coexist spatially; the "frame" is wherever the visitor
looks. Captioning spatial media is not a smaller version of captioning video
— it is a different problem with a video-shaped problem nested inside it.

## 2. The model: three layers

**Spatial layer — triggers.** Triggers own *when a fragment begins*. The
visitor's movement is the play head. Three trigger types compose per scene:

- `first-move` — fires on the visitor's first navigation input after the
  scene is ready. Every scene's opening narration uses this. It is also,
  deliberately, the browser's audio-unlock gesture: captions and sound can
  begin together on the visitor's first act.
- `after` — sequential: fires when a named fragment finishes, plus a delay
  (default 10s). Chains of `after` triggers make a scene play like a
  narrated program with breathing room between segments.
- `zone` — positional: fires on entering a trigger volume.

**Trigger style is a per-scene dial, not a fixed grammar.** A small scene is
`first-move` + an `after` chain and no zones at all. A medium scene mixes a
chain with a few zones. A large scene (a creek, a rail corridor) is
`first-move` + zones almost exclusively. Same runtime, different manifest.

**Temporal layer — cues.** Within a fragment, standard time-based cues
relative to fragment start. This layer is deliberately boring: it is exactly
film captioning, and it stays in **unmodified, fully standard WebVTT** — one
.vtt per audio fragment, verifiable in any video player. Cairn never forks
VTT. All spatial semantics live in the manifest.

**State layer — memory.** Play-once-per-visit, one-voice-at-a-time queueing,
partial-play tracking, and the transcript log. Persisted (e.g. localStorage,
keyed per scene) so the scene remembers what the visitor has heard — across
page loads and portal hops, not just within one.

A **visit is gap-defined**: returning within `visitResetHours` (default 12)
keeps the scene's memory and nothing replays; a longer absence is a fresh
visit and the piece plays again. Without this, played-once would mean
played-*ever* — a visitor returning weeks later would find a silent scene.
Caption preference never resets. Set `"visitResetHours": 0` for strict
play-once-ever.

## 3. The manifest (cairn.json)

One manifest per scene binds the layers:

```json
{
  "cairn": "0.1",
  "scene": "peachtreecreek",
  "defaults": {
    "captions": "on",
    "language": "en",
    "oneVoiceAtATime": true,
    "playOncePerVisit": true
  },
  "fragments": [
    {
      "id": "gauge",
      "audio": ["audio/narrator_v1/gauge.opus", "audio/narrator_v1/gauge.m4a"],
      "captions": "captions_v1/gauge.vtt",
      "speaker": "Narrator",
      "kind": "narration",
      "trigger": { "type": "zone", "zone": "waters-edge" },
      "source": { "entity": "narrator-gauge" },
      "interruption": "complete-cue"
    },
    {
      "id": "creek-ambient",
      "captions": "captions_v1/creek-ambient.vtt",
      "kind": "ambience",
      "trigger": { "type": "zone", "zone": "creek-corridor" },
      "source": { "entity": "creek" }
    }
  ]
}
```

Notes:
- `trigger` takes one of three forms:
  `{"type": "first-move"}`,
  `{"type": "after", "fragment": "<id>", "delay": 10}`,
  `{"type": "zone", "zone": "<zone-id>"}`.
  A small scene chains: opener on `first-move`, every later segment
  `after` its predecessor with a ~10s breath.
- `"preemptible": false` protects a fragment from positional preemption
  (see behavior 6). Default is preemptible.
- `kind`: `narration` | `ambience` | `hint`. Ambience fragments may be
  caption-only (no audio file) — they describe what the scene sounds like:
  `[creek over stones]`, `[birdsong, distant]`. This is how deaf visitors
  receive the scene's sound design, not just its speech.
- `source.entity` names the world-space origin of the voice. The runtime —
  never the author — computes the directional indicator from this.
- `interruption`: `complete-cue` (default — audio fades on walk-away but the
  visible cue finishes before dismissing; comprehension beats sync) |
  `cut` | `finish-fragment`.
- `defaults.positionalQueue`: `presence` (default) | `persistent`. In
  `persistent` mode, entering a zone latches its fragment into a FIFO queue;
  the current fragment finishes, leaving the zone does not withdraw the
  latched fragment, and positional preemption is disabled for that scene.
- Audio is optional everywhere. **A Cairn scene with every speaker muted
  is still a complete experience.** This is the accessibility inversion that
  matters: text is the primary track, audio is the enhancement.

## 4. Runtime behaviors (normative)

1. **Captions default ON.** Muted is the real-world default state; a first
   visit with no gesture yet MUST still deliver the text layer. Toggle
   persists per-site.
2. **Pre-gesture start.** Zone triggers fire captions even while autoplay
   policy blocks audio. Sound joins in progress after the unlock gesture.
3. **Presentation is DOM, not engine-rendered.** Lower-third overlay in an
   ARIA live region (`aria-live="polite"`): screen readers receive the
   narration, text is selectable, styling is CSS, WCAG contrast is
   controllable. Engine-drawn text is pixels; captions must be text.
4. **Direction ticks are for located sound, not narrators.** By default,
   only `ambience`-kind captions carry a direction indicator — `[creek
   over stones]` is genuinely *somewhere*, and that spatial information
   belongs to deaf visitors. Narration carries no tick: an acousmatic
   narrator's authority depends on coming from nowhere, and when narrator
   entities are placed at their subjects a tick would point at the thing
   being described — syncing image to voice. Override per scene with
   `"defaults": {"directionTicks": "none" | "ambience" | "all"}`.
5. **One voice at a time.** Voices never interleave. Non-positional
   collisions queue; a queued fragment may show a `hint`-kind line ("a
   voice near the bridge") rather than interleaving cues.
6. **Positional preemption at cue boundaries.** Entering a zone while
   another voice is playing hands the floor to the resident voice — but
   never mid-sentence: the current cue completes, the displaced fragment
   is marked `partial` (it re-offers on return), and the new place speaks.
   This is the arrival-side twin of the walk-away rule: presence at a
   place is what gives a voice its claim. Fragments may set
   `"preemptible": false` for authored moments that must never be cut
   (endings, dedications); non-preemptible playback queues the incoming
   fragment instead. Scenes may disable preemption globally with
   `"defaults": {"positionalPreempts": false}`.
7. **Persistent positional queueing.** Traversal scenes MAY set
   `"defaults": {"positionalQueue": "persistent"}` when crossing a zone
   should be remembered as an event rather than treated as temporary presence.
   Zone entries latch in FIFO order; the current fragment and every latched
   fragment finish completely; leaving a zone neither cancels a queued fragment
   nor dismisses an active one. This policy supersedes positional preemption
   and zone-exit interruption while active, but leaves other scenes' default
   presence-based behavior unchanged.
8. **Audio completion identity.** An adapter's
   `onAudioEnd(fragmentId, callback)` signal MUST be scoped to the logical
   fragment that actually ended. When multiple fragments reuse one underlying
   audio element, sound slot, or player, one physical completion event MUST
   advance at most one logical fragment. Adapters MUST route completion through
   the currently playing fragment identity; they MUST NOT fan the same event
   out to every fragment registered on the shared player.
9. **Exceptional suspend/resume.** A scene MAY call
   `engine.interruptWith(fragmentId, {at})` for a singular authored encounter
   that must temporarily take the floor (for example, narration attached to a
   specific object). Cairn snapshots the active fragment at the adapter's exact
   clock, the FIFO queue, and any remaining `after` delays. When the interruptor
   completes, Cairn restores that state: the displaced fragment resumes at the
   saved clock, or a paused delay resumes with its remaining duration. The
   snapshot MUST persist across reload and lifecycle suspension. Hosts own the
   audio fade-out/fade-in around this state transition; ordinary zone entry MUST
   continue to use the normal preemption or persistent-queue policies above.
10. **Walk-away and re-entry.** Partial plays are recorded. Re-entry behavior
   follows `playOncePerVisit`; a partially-heard fragment re-offers itself.
   Re-entering its zone during the same loaded session starts that fragment
   from the beginning, treating the visitor's deliberate return as a fresh
   listen. Reload restoration is different: when persisted partial/resume state
   exists, the first navigation input restores the unfinished fragment at its
   last saved cue boundary. This asymmetry is intentionalâ€”same-session return
   restarts, while page/lifecycle interruption preserves continuity.
11. **The transcript log.** Every completed cue accumulates into a readable,
   scrollable record for the session — captions as document, not vapor.
   Scenes MAY surface this as a diegetic object (a registry, a logbook).
12. **No time pressure.** Cues never advance faster than reading speed
   (~17 cps ceiling), and the visitor pausing movement never kills a cue.
   WCAG 2.2.x: timing is adjustable by the nature of the medium.

## 5. Authoring pipeline

Scripts are known verbatim in TTS workflows, which makes caption generation
nearly free:

1. Render narration (any TTS or recorded VO)
2. Forced alignment of script against audio → word timings (existing
   tooling: script + audio → timed cues)
3. Chunk to caption rules (≤42 chars/line, 1–2 lines, clause breaks) → VTT
4. Author the manifest alongside the scene's existing zone definitions

Steps 2–3 are already implemented in the transcript-srt-aligner tool
(stdlib Python, 40 tests); VTT output is a small format addition to it.

## 6. Reference implementation (PlayCanvas first)

A single scene script (~150 lines):

- Parses manifest + VTT (or precompiled JSON cues)
- Subscribes to zone trigger events (the scenes' existing positional-audio
  zone system fires these already)
- Polls the active sound instance's playback position per frame; ambience
  and pre-gesture fragments run on a wall-clock local timer instead
- Renders to the DOM overlay; manages queue, state, transcript, toggle

Engine-agnostic by construction: nothing in the manifest or VTT is
PlayCanvas-specific. A three.js or Babylon viewer implements the same spec
against its own audio and trigger primitives. The PlayCanvas implementation
is the reference, not the definition.

## 7. WCAG mapping (the institutional argument)

| Requirement | Cairn answer |
|---|---|
| 1.2.1 audio-only alternative | transcript log + caption-only mode |
| 1.2.2 captions (prerecorded) | the temporal layer, on by default |
| 1.4.3 / 1.4.6 contrast | DOM/CSS lower-third, user-stylable |
| 2.2.1 timing adjustable | position-triggered; no forced pace |
| 4.1.2 name/role/value | ARIA live region, real text |

For museums and institutions, this converts splat experiences from
"un-procurable on accessibility grounds" to "compliant by design" — a
checkbox no current 3DGS tour product ticks.

## 8. Release status

Cairn v0.2 is production-proven in Atlanta Space Machine's native-Google
aerial and 12 walkable scenes. The reference deployment covers ten sequential
scenes, a persistent FIFO positional traversal, and a single exceptional
encounter that fades, interrupts, survives reload, and resumes displaced
narration. The open-source release remains coordinated with the ASM launch;
see `RELEASE_CHECKLIST.md` for the publication gate.

## 9. Open questions (v0.3 material)

- Multi-language manifests (`captions` as a per-language map)
- Speaker color/position conventions when scenes gain multiple narrators
- Caption behavior during free-flight vs walking navigation modes
- Whether `hint` cues should be authorable as spatial wayfinding for
  fully-silent discovery (captions as the map)
- VR presentation (the DOM overlay assumption breaks in WebXR)
