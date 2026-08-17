import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const CairnAsm = require("./asm-html-audio.js");

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

console.log("\n" + passed + " ASM host tests passed");
