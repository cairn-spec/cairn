import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CairnAsm = require("./asm-html-audio.js");
const MobileViewport = require("./asm-mobile-viewport.js");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log("ok  " + name);
  } catch (error) {
    console.error("FAIL " + name + " — " + error.message);
    process.exitCode = 1;
  }
}

const fragment = {
  audio: [
    "audio/narrator_v1/opener.opus",
    "audio/narrator_v1/opener.m4a"
  ]
};

test("chooses Opus when the browser supports it", () => {
  const audio = { canPlayType: () => "probably" };
  assert.equal(
    CairnAsm.firstPlayable(fragment, audio),
    "audio/narrator_v1/opener.opus"
  );
});

test("falls back to AAC/M4A when Opus is unavailable", () => {
  const audio = { canPlayType: () => "" };
  assert.equal(
    CairnAsm.firstPlayable(fragment, audio),
    "audio/narrator_v1/opener.m4a"
  );
});

test("returns the first source when no preferred extension exists", () => {
  const audio = { canPlayType: () => "" };
  assert.equal(
    CairnAsm.firstPlayable({ audio: ["voice.mp3"] }, audio),
    "voice.mp3"
  );
});

test("consumes reset parameters without dropping other query state", () => {
  let replaced = null;
  const win = {
    location: {
      pathname: "/oaklandbelltower/",
      hash: "#view"
    },
    history: {
      state: { keep: true },
      replaceState: (state, title, url) => { replaced = { state, title, url }; }
    }
  };
  const params = new URLSearchParams(
    "stats=true&cairnReset=1&waysideReset=1"
  );
  const clean = CairnAsm.consumeResetParams(
    win, params, ["cairnReset", "waysideReset"]
  );
  assert.equal(clean, "/oaklandbelltower/?stats=true#view");
  assert.equal(replaced.url, clean);
  assert.deepEqual(replaced.state, { keep: true });
});

test("holds the caption clock at the saved cue while audio seeks on reload", () => {
  let audioTime = 0;
  const gate = CairnAsm.createResumeClockGate(() => audioTime);
  gate.hold("wave", 12.5);
  assert.equal(gate.clock("wave"), 12.5);
  assert.equal(gate.clock("designer"), 0);
  audioTime = 12.6;
  assert.equal(gate.clock("wave"), 12.6);
  assert.equal(gate.held(), null);
});

test("requires an explicit resume tap only for unfinished saved progress", () => {
  const engine = {
    fragments: { wave: { id: "wave" } },
    store: {
      data: { resume: { id: "wave", at: 12.5 } },
      playedState: () => null
    }
  };
  assert.equal(CairnAsm.hasUnfinishedResume(engine), true);
  engine.store.playedState = () => "complete";
  assert.equal(CairnAsm.hasUnfinishedResume(engine), false);
  engine.store.data.resume = null;
  assert.equal(CairnAsm.hasUnfinishedResume(engine), false);
});

test("resynchronizes the render surface when Safari's visual viewport grows", () => {
  const viewportListeners = {};
  const container = { style: {} };
  const properties = {};
  let resizeEvents = 0;
  const win = {
    innerWidth: 402,
    innerHeight: 666,
    visualViewport: {
      width: 402,
      height: 520,
      addEventListener: (name, fn) => { viewportListeners[name] = fn; }
    },
    document: {
      hidden: false,
      getElementById: () => container,
      documentElement: {
        style: { setProperty: (name, value) => { properties[name] = value; } }
      },
      addEventListener: () => {}
    },
    addEventListener: () => {},
    requestAnimationFrame: (fn) => fn(),
    dispatchEvent: (event) => { if (event.type === "resize") resizeEvents++; },
    setInterval: () => 1,
    Event: class { constructor(type) { this.type = type; } }
  };

  MobileViewport.install(win);
  assert.equal(properties["--asm-visual-viewport-height"], "520px");
  assert.equal(container.style.height, "var(--asm-visual-viewport-height)");

  win.visualViewport.height = 666;
  viewportListeners.resize();
  assert.equal(properties["--asm-visual-viewport-height"], "666px");
  assert.equal(resizeEvents, 2);
});

console.log("\n" + passed + " ASM host tests passed");
