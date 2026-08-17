/* Node smoke tests for the Cairn core — no DOM required by design:
 * Engine logic (zones, queue, walk-away, state, transcript) runs headless;
 * only attach() touches a document, and attach() is not called here. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Cairn = require("./cairn.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok  " + name); }
  catch (e) { console.error("FAIL " + name + " — " + e.message); process.exitCode = 1; }
}

// ── parseVTT ─────────────────────────────────────────────────────────────────
const vtt = `WEBVTT

NOTE
cairn-fragment: gauge
cairn-speaker: Narrator

1
00:00:00.000 --> 00:00:01.600
Welcome to Oakland Cemetery

2
00:00:02.500 --> 00:00:06.100
Founded in 1850 it became Atlanta's first
public burial ground
`;

test("parseVTT: cues and metadata", () => {
  const r = Cairn.parseVTT(vtt);
  assert.equal(r.cues.length, 2);
  assert.equal(r.meta["cairn-speaker"], "Narrator");
  assert.equal(r.cues[0].start, 0);
  assert.equal(r.cues[1].start, 2.5);
  assert.ok(r.cues[1].text.includes("\n"), "multiline cue preserved");
});

test("parseVTT: rejects non-VTT", () => {
  assert.throws(() => Cairn.parseVTT("1\n00:00:00,000 --> 00:00:01,000\nhi"));
});

test("cueAt: inside, between, after", () => {
  const cues = Cairn.parseVTT(vtt).cues;
  assert.equal(Cairn.cueAt(cues, 1.0).text, "Welcome to Oakland Cemetery");
  assert.equal(Cairn.cueAt(cues, 2.0), null);      // between cues
  assert.equal(Cairn.cueAt(cues, 99), null);        // after all
});

// ── Engine with fake clock + fake storage ───────────────────────────────────
function fakeStorage() {
  const m = {};
  return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } };
}

const manifest = {
  cairn: "0.1",
  scene: "test",
  defaults: { captions: "on", oneVoiceAtATime: true, playOncePerVisit: true },
  fragments: [
    { id: "gauge", speaker: "Narrator", kind: "narration",
      trigger: { type: "zone", zone: "waters-edge" },
      source: { entity: "narrator-gauge" }, interruption: "complete-cue" },
    { id: "battle", speaker: "Narrator", kind: "narration",
      trigger: { type: "zone", zone: "high-ground" },
      source: { entity: "narrator-battle" } }
  ]
};

function makeEngine(clockFn) {
  let wall = 0;
  const adapter = { clock: clockFn || (() => null), bearing: () => null };
  const eng = new Cairn.Engine(manifest, adapter,
    { storage: fakeStorage(), now: () => wall });
  eng.loadCues("gauge", vtt);
  eng.loadCues("battle", vtt);
  return { eng, tick: (t) => { wall = t; eng.tick(); }, setWall: t => { wall = t; } };
}

test("captions default on", () => {
  const { eng } = makeEngine();
  assert.equal(eng.captionsOn(), true);
});

test("zone entry starts fragment; wall clock drives cues pre-gesture", () => {
  const { eng, tick } = makeEngine();          // clock() → null = audio blocked
  eng.enterZone("waters-edge");
  assert.ok(eng.active, "fragment active");
  tick(1.0);
  assert.equal(eng.active.lastCue.text, "Welcome to Oakland Cemetery");
});

test("one voice at a time: second zone queues, then plays after finish", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  eng.enterZone("high-ground");
  assert.equal(eng.active.frag.id, "gauge");
  assert.deepEqual(eng.queue, ["battle"]);
  tick(7.0);   // past last cue end (6.1) + 0.75 grace
  assert.equal(eng.active.frag.id, "battle", "queued fragment started");
});

test("walk-away completes current cue then dismisses as partial", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(1.0);                    // cue 1 visible
  eng.leaveZone("waters-edge"); // complete-cue policy
  assert.ok(eng.active, "still active while cue visible");
  tick(1.2);                    // cue 1 still running (ends 1.6)
  assert.ok(eng.active, "cue allowed to finish");
  tick(1.7);                    // cue over → dismiss
  assert.equal(eng.active, null);
  assert.equal(eng.store.playedState("gauge"), "partial");
});

test("play-once-per-visit blocks completed fragments only", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(7.0);                    // completes
  assert.equal(eng.store.playedState("gauge"), "complete");
  eng.enterZone("waters-edge");
  assert.equal(eng.active, null, "complete fragment does not replay");
  eng.enterZone("high-ground"); // battle still fresh
  assert.equal(eng.active.frag.id, "battle");
});

test("partial fragments re-offer on re-entry", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(1.0);
  eng.leaveZone("waters-edge");
  tick(1.7);                    // dismissed as partial
  eng.enterZone("waters-edge");
  assert.ok(eng.active, "partial re-offers");
});

test("transcript accumulates completed cues with speaker + kind", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(1.0); tick(3.0); tick(7.0);
  assert.ok(eng.transcript.length >= 2);
  assert.equal(eng.transcript[0].speaker, "Narrator");
  assert.equal(eng.transcript[0].text, "Welcome to Oakland Cemetery");
});

test("audio clock preferred over wall clock when available", () => {
  let audioT = 0;
  const { eng } = makeEngine(() => audioT);
  eng.enterZone("waters-edge");
  audioT = 3.0; eng.tick();
  assert.match(eng.active.lastCue.text, /^Founded in 1850/);
});

test("toggle persists through store", () => {
  const { eng } = makeEngine();
  eng.toggle();
  assert.equal(eng.captionsOn(), false);
  eng.toggle();
  assert.equal(eng.captionsOn(), true);
});

// ── Trigger grammar: first-move, after-chains, preemption ───────────────────

const chainManifest = {
  cairn: "0.1",
  scene: "small-scene",
  defaults: { captions: "on" },
  fragments: [
    { id: "opener", trigger: { type: "first-move" }, speaker: "Narrator" },
    { id: "second", trigger: { type: "after", fragment: "opener", delay: 10 },
      speaker: "Narrator" },
    { id: "third", trigger: { type: "after", fragment: "second", delay: 5 },
      speaker: "Narrator" }
  ]
};

function makeChainEngine() {
  let wall = 0;
  const adapter = { clock: () => null, bearing: () => null };
  const eng = new Cairn.Engine(chainManifest, adapter,
    { storage: fakeStorage(), now: () => wall });
  ["opener", "second", "third"].forEach(id => eng.loadCues(id, vtt));
  return { eng, tick: (t) => { wall = t; eng.tick(); } };
}

test("first-move fires the opener exactly once", () => {
  const { eng, tick } = makeChainEngine();
  assert.equal(eng.active, null, "nothing before movement");
  eng.notifyMovement();
  assert.equal(eng.active.frag.id, "opener");
  eng.notifyMovement();                       // latch: no double-fire
  assert.equal(eng.active.frag.id, "opener");
  tick(1.0);
  assert.equal(eng.active.lastCue.text, "Welcome to Oakland Cemetery");
});

test("after-chain: sequential playback with authored delay", () => {
  const { eng, tick } = makeChainEngine();
  eng.notifyMovement();
  tick(7.0);                                  // opener completes (~6.85)
  assert.equal(eng.active, null, "gap between segments");
  tick(12.0);                                 // 10s delay not yet elapsed
  assert.equal(eng.active, null);
  tick(17.0);                                 // ~6.85 + 10 = 16.85 passed
  assert.equal(eng.active.frag.id, "second", "second fires after delay");
  tick(25.0);                                 // second completes
  tick(31.0);                                 // + 5s delay
  assert.equal(eng.active.frag.id, "third", "chain continues");
});

const preemptManifest = {
  cairn: "0.1",
  scene: "medium-scene",
  defaults: { captions: "on" },
  fragments: [
    { id: "opener", trigger: { type: "first-move" }, speaker: "Narrator" },
    { id: "gauge", trigger: { type: "zone", zone: "waters-edge" },
      speaker: "Narrator" },
    { id: "finale", trigger: { type: "zone", zone: "bell-tower" },
      preemptible: false, speaker: "Narrator" }
  ]
};

function makePreemptEngine(defaults) {
  let wall = 0;
  const m = JSON.parse(JSON.stringify(preemptManifest));
  if (defaults) Object.assign(m.defaults, defaults);
  const adapter = { clock: () => null, bearing: () => null };
  const eng = new Cairn.Engine(m, adapter,
    { storage: fakeStorage(), now: () => wall });
  ["opener", "gauge", "finale"].forEach(id => eng.loadCues(id, vtt));
  return { eng, tick: (t) => { wall = t; eng.tick(); } };
}

test("positional trigger preempts at cue boundary, not mid-sentence", () => {
  const { eng, tick } = makePreemptEngine();
  eng.notifyMovement();                       // opener playing
  tick(3.0);                                  // mid cue 2 (2.5–6.1)
  eng.enterZone("waters-edge");
  assert.equal(eng.active.frag.id, "opener", "no mid-sentence cut");
  tick(4.0);                                  // still inside cue 2
  assert.equal(eng.active.frag.id, "opener", "cue allowed to finish");
  tick(6.3);                                  // cue 2 ended → boundary
  assert.equal(eng.active.frag.id, "gauge", "resident voice takes floor");
  assert.equal(eng.store.playedState("opener"), "partial",
    "displaced fragment re-offers later");
});

test("preemptible:false playback queues the zone instead", () => {
  const { eng, tick } = makePreemptEngine();
  // start the protected finale directly
  eng._start(eng.fragments["finale"]);
  tick(3.0);
  eng.enterZone("waters-edge");
  tick(6.3);
  assert.equal(eng.active.frag.id, "finale", "protected fragment uncut");
  assert.deepEqual(eng.queue, ["gauge"], "zone waits its turn");
});

test("positionalPreempts:false disables preemption scene-wide", () => {
  const { eng, tick } = makePreemptEngine({ positionalPreempts: false });
  eng.notifyMovement();
  tick(3.0);
  eng.enterZone("waters-edge");
  tick(6.3);
  assert.equal(eng.active.frag.id, "opener", "no preemption when disabled");
  assert.deepEqual(eng.queue, ["gauge"]);
});

// ── Bell Tower production-hardening regressions ──────────────────────────────

test("legacy Wayside state migrates forward without deleting rollback state", () => {
  const values = {
    "wayside.legacy-scene": JSON.stringify({
      captions: false,
      played: { opener: "complete" },
      resume: { id: "second", at: 2.5 },
      lastSeen: 100
    })
  };
  const storage = {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; }
  };
  const m = {
    cairn: "0.1",
    scene: "legacy-scene",
    defaults: { visitResetHours: 12 },
    fragments: [{ id: "opener", trigger: { type: "first-move" } }]
  };
  const eng = new Cairn.Engine(m, { clock: () => null },
    { storage, now: () => 101 });
  assert.equal(eng.captionsOn(), false);
  assert.equal(eng.store.playedState("opener"), "complete");
  assert.ok(values["cairn.legacy-scene"], "Cairn copy created");
  assert.ok(values["wayside.legacy-scene"], "legacy key preserved");
});

test("cue-boundary progress resumes the unfinished fragment", () => {
  const values = {};
  const storage = {
    getItem: key => values[key] ?? null,
    setItem: (key, value) => { values[key] = value; }
  };
  let wall = 0;
  const adapter = { clock: () => null, bearing: () => null };
  const first = new Cairn.Engine(chainManifest, adapter,
    { storage, now: () => wall });
  first.loadCues("opener", vtt);
  first.notifyMovement();
  wall = 3;
  first.tick();
  first.rememberProgress();
  assert.deepEqual(first.store.data.resume, { id: "opener", at: 2.5 });

  wall = 4;
  const resumed = new Cairn.Engine(chainManifest, adapter,
    { storage, now: () => wall });
  resumed.loadCues("opener", vtt);
  resumed.notifyMovement();
  assert.equal(resumed.active.frag.id, "opener");
  assert.equal(resumed.active.resumeAt, 2.5);
});

test("resetVisit clears scene playback state through the public API", () => {
  const { eng } = makeChainEngine();
  eng.notifyMovement();
  eng.store.data.played.opener = "complete";
  eng.store.data.resume = { id: "second", at: 0 };
  eng.resetVisit();
  assert.deepEqual(eng.store.data.played, {});
  assert.equal(eng.store.data.resume, null);
  assert.equal(eng.active, null);
  assert.equal(eng._moved, false);
});

test("caption toggle redraws the current cue immediately", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(1);
  let rendered = "not-called";
  eng._render = view => { rendered = view; };
  eng.toggle();
  assert.equal(rendered.cue.text, "Welcome to Oakland Cemetery");
});

test("HTML Audio adapter can hold captions until playback starts", () => {
  const audio = {
    paused: true,
    currentTime: 0,
    addEventListener: () => {}
  };
  const gated = new Cairn.HtmlAudioAdapter({ wallClockBeforePlayback: false });
  gated.register("opener", audio);
  assert.equal(gated.clock("opener"), 0);
  const preGesture = new Cairn.HtmlAudioAdapter();
  preGesture.register("opener", audio);
  assert.equal(preGesture.clock("opener"), null);
});

test("caption start checkpoints resume without a lifecycle event", () => {
  const { eng, tick } = makeEngine();
  eng.enterZone("waters-edge");
  tick(3);
  assert.deepEqual(eng.store.data.resume, { id: "gauge", at: 2.5 });

  // A later cue gap must not make rememberProgress fall back to fragment start.
  tick(6.2);
  eng.rememberProgress();
  assert.deepEqual(eng.store.data.resume, { id: "gauge", at: 2.5 });
});

console.log(`\n${passed} tests passed`);
