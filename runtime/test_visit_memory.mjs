import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Cairn = require("./cairn.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log("ok  " + name); }
  catch (e) { console.error("FAIL " + name + " — " + e.message); process.exitCode = 1; }
}

const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:01.600
Welcome to Oakland Cemetery
`;

function sharedStorage() {
  const m = {};
  return { getItem: k => m[k] ?? null, setItem: (k, v) => { m[k] = v; } };
}
const manifest = {
  cairn: "0.1", scene: "revisit-test",
  defaults: { captions: "on" },
  fragments: [{ id: "opener", trigger: { type: "first-move" }, speaker: "N" }]
};
function engineAt(storage, wallStart) {
  let wall = wallStart;
  const eng = new Cairn.Engine(manifest,
    { clock: () => null, bearing: () => null },
    { storage, now: () => wall });
  eng.loadCues("opener", vtt);
  return { eng, tick: t => { wall = wallStart + t; eng.tick(); } };
}

test("return within the visit window: nothing replays", () => {
  const store = sharedStorage();
  const a = engineAt(store, 1000);
  a.eng.notifyMovement(); a.tick(3.0);            // opener completes (~2.35)
  assert.equal(a.eng.store.playedState("opener"), "complete");
  // return 1 hour later — same visit
  const b = engineAt(store, 1000 + 3600);
  assert.equal(b.eng.store.playedState("opener"), "complete", "memory kept");
  b.eng.notifyMovement();
  assert.equal(b.eng.active, null, "opener does not replay");
});

test("return after the gap: fresh visit, piece plays again, prefs kept", () => {
  const store = sharedStorage();
  const a = engineAt(store, 1000);
  a.eng.notifyMovement(); a.tick(3.0);
  a.eng.toggle();                                  // captions OFF preference
  // return 13 hours later — beyond the 12h default
  const b = engineAt(store, 1000 + 13 * 3600);
  assert.equal(b.eng.store.playedState("opener"), null, "memory cleared");
  b.eng.notifyMovement();
  assert.equal(b.eng.active.frag.id, "opener", "piece plays again");
  assert.equal(b.eng.captionsOn(), false, "caption preference survives reset");
});

test("visitResetHours: 0 disables reset (play once ever)", () => {
  const store = sharedStorage();
  const m2 = JSON.parse(JSON.stringify(manifest));
  m2.defaults.visitResetHours = 0;
  let wall = 1000;
  const a = new Cairn.Engine(m2, { clock: () => null, bearing: () => null },
    { storage: store, now: () => wall });
  a.loadCues("opener", vtt);
  a.notifyMovement(); wall = 1003; a.tick();
  wall = 1000 + 400 * 3600;                        // 400 hours later
  const b = new Cairn.Engine(m2, { clock: () => null, bearing: () => null },
    { storage: store, now: () => wall });
  assert.equal(b.store.playedState("opener"), "complete", "never resets");
});

console.log(`\n${passed} visit-memory tests passed`);
