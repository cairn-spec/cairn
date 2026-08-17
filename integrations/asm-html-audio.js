/* Cairn ASM HTML Audio host.
 *
 * Reusable integration extracted from the accepted Oakland Bell Tower pilot.
 * Cairn owns captions and scene state; this host owns browser audio delivery,
 * user-gesture unlocking, mute/replay controls, and lifecycle persistence.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../runtime/cairn.js"));
  } else {
    root.CairnAsm = factory(root.Cairn);
  }
})(typeof self !== "undefined" ? self : this, function (Cairn) {
  "use strict";

  var DEFAULT_KEYS = [
    "w", "a", "s", "d", "q", "e",
    "arrowup", "arrowdown", "arrowleft", "arrowright"
  ];

  function firstPlayable(fragment, audio) {
    var sources = fragment.audio || [];
    var supportsOpus = audio.canPlayType("audio/ogg; codecs=opus") !== "";
    if (supportsOpus) {
      var opus = sources.find(function (src) {
        return /\.opus(?:$|\?)/i.test(src);
      });
      if (opus) return opus;
    }
    return sources.find(function (src) {
      return /\.m4a(?:$|\?)/i.test(src);
    }) || sources[0] || null;
  }

  function readLegacyPreference(storage, currentKey, legacyKey) {
    var current = storage.getItem(currentKey);
    if (current !== null) return current;
    var legacy = storage.getItem(legacyKey);
    if (legacy !== null) {
      storage.setItem(currentKey, legacy);
      return legacy;
    }
    return null;
  }

  function consumeResetParams(win, params, resetParams) {
    resetParams.forEach(function (key) { params.delete(key); });
    var query = params.toString();
    var cleanUrl = win.location.pathname +
      (query ? "?" + query : "") +
      (win.location.hash || "");
    win.history.replaceState(win.history.state, "", cleanUrl);
    return cleanUrl;
  }

  async function mount(options) {
    options = options || {};
    if (!Cairn) throw new Error("Cairn runtime did not load");
    if (!options.manifestUrl) throw new Error("manifestUrl is required");

    var win = options.window || window;
    var doc = options.document || win.document;
    var storage = options.storage || win.localStorage;
    var movementKeys = new Set(options.movementKeys || DEFAULT_KEYS);
    var muteKey = options.muteKey || "asm.cairn.muted";
    var legacyMuteKey = options.legacyMuteKey || "asm.wayside.muted";
    var resetParams = options.resetParams || ["cairnReset", "waysideReset"];
    var params = new URLSearchParams(win.location.search);
    var resetRequested = resetParams.some(function (key) {
      return params.get(key) === "1";
    });

    var response = await win.fetch(options.manifestUrl, { cache: "no-store" });
    if (!response.ok) {
      throw new Error("Cairn manifest failed: " + response.status);
    }
    var manifest = await response.json();

    if (resetRequested) {
      storage.removeItem("cairn." + manifest.scene);
      storage.removeItem("wayside." + manifest.scene);
      if (options.resetMute) {
        storage.removeItem(muteKey);
        storage.removeItem(legacyMuteKey);
      }
      if (typeof options.onReset === "function") options.onReset(manifest);
      // A QA reset is a one-shot action. Remove its flag immediately so a
      // later browser reload tests real resume behavior instead of clearing
      // state again.
      if (options.consumeResetParams !== false &&
          win.history && typeof win.history.replaceState === "function") {
        consumeResetParams(win, params, resetParams);
      }
    }

    var audio = doc.createElement("audio");
    audio.id = options.audioId || "cairn-narrator";
    audio.preload = options.preload || "auto";
    audio.playsInline = true;
    audio.volume = options.volume === undefined ? 0.8 : options.volume;
    audio.hidden = true;
    doc.body.appendChild(audio);

    var adapter = new Cairn.HtmlAudioAdapter({
      wallClockBeforePlayback: false
    });
    manifest.fragments.forEach(function (fragment) {
      adapter.register(fragment.id, audio);
    });

    var engine = new Cairn.Engine(manifest, adapter).attach(
      options.parent || doc.body
    );
    engine.dom.wrap.classList.add("cairn-asm");

    // ASM intentionally presents captions without an in-scene transcript UI.
    if (engine.dom.transcriptBtn) engine.dom.transcriptBtn.hidden = true;
    if (engine.dom.transcript) engine.dom.transcript.hidden = true;

    var muteButton = doc.createElement("button");
    muteButton.type = "button";
    muteButton.className = "cairn-mute";
    muteButton.textContent = "Sound";
    var storedMuted = readLegacyPreference(storage, muteKey, legacyMuteKey);
    audio.muted = storedMuted === "true";
    engine.dom.wrap.querySelector(".cairn-controls").appendChild(muteButton);

    var playingId = null;
    var failedId = null;
    var primedId = null;
    var disposed = false;
    var frameId = null;

    function complete() {
      var fragments = manifest.fragments || [];
      return fragments.length > 0 &&
        !engine.active &&
        !(engine.queue && engine.queue.length) &&
        !(engine._pending && engine._pending.length) &&
        fragments.every(function (fragment) {
          return engine.store.playedState(fragment.id) === "complete";
        });
    }

    function renderSoundButton() {
      var blocked = engine.dom.wrap.dataset.audioState === "blocked";
      var waiting = !engine._moved;
      var replay = complete();
      muteButton.textContent = audio.muted
        ? "Sound off"
        : (replay ? "Replay narration"
          : (blocked ? "Tap for sound"
            : (waiting ? "Start audio" : "Sound on")));
      muteButton.setAttribute("aria-pressed", String(audio.muted));
      var label = audio.muted
        ? "Unmute narration"
        : (replay ? "Replay narration"
          : ((blocked || waiting) ? "Start narration" : "Mute narration"));
      muteButton.setAttribute("aria-label", label);
      muteButton.title = label;
    }

    function markAudioState(state) {
      engine.dom.wrap.dataset.audioState = state;
      renderSoundButton();
    }

    function sourceUrl(fragment) {
      var source = firstPlayable(fragment, audio);
      return source ? new URL(source, doc.baseURI).href : null;
    }

    function prime(fragment) {
      if (!fragment || playingId === fragment.id || primedId === fragment.id) {
        return;
      }
      var url = sourceUrl(fragment);
      if (!url) return;
      audio.pause();
      audio.preload = "auto";
      audio.src = url;
      audio.load();
      primedId = fragment.id;
      markAudioState("preloading");
    }

    function seek(resumeAt) {
      if (!(resumeAt > 0)) return;
      function apply() {
        var limit = Number.isFinite(audio.duration)
          ? Math.max(0, audio.duration - 0.05)
          : resumeAt;
        audio.currentTime = Math.min(resumeAt, limit);
      }
      if (audio.readyState >= 1) apply();
      else audio.addEventListener("loadedmetadata", apply, { once: true });
    }

    function attemptPlayback(fragment) {
      var attempt = audio.play();
      if (attempt && typeof attempt.then === "function") {
        attempt.then(function () {
          failedId = null;
          markAudioState("playing");
        }).catch(function (error) {
          failedId = fragment.id;
          markAudioState("blocked");
          if (options.debug) {
            console.error("[Cairn ASM] Playback failed for " + fragment.id, error);
          }
        });
      }
    }

    function syncAudio(allowRetry) {
      var fragment = engine.active && engine.active.frag;
      if (!fragment) {
        if (playingId && !audio.ended) audio.pause();
        playingId = null;
        failedId = null;
        var pending = engine._pending && engine._pending.length
          ? engine.fragments[engine._pending[0].id]
          : null;
        var opener = !engine._moved
          ? manifest.fragments.find(function (candidate) {
              return candidate.trigger &&
                candidate.trigger.type === "first-move";
            })
          : null;
        var next = pending || opener;
        if (next) {
          prime(next);
          return;
        }
        markAudioState("idle");
        return;
      }

      if (fragment.id === playingId) {
        if (allowRetry && failedId === fragment.id && audio.paused) {
          attemptPlayback(fragment);
        }
        return;
      }

      var url = sourceUrl(fragment);
      if (!url) {
        failedId = fragment.id;
        markAudioState("missing");
        if (options.debug) {
          console.error("[Cairn ASM] No audio source for " + fragment.id);
        }
        return;
      }

      audio.pause();
      playingId = fragment.id;
      failedId = null;
      var resumeAt = Math.max(0, Number(engine.active.resumeAt) || 0);
      var alreadyPrimed = primedId === fragment.id && audio.src === url;
      primedId = null;
      if (!alreadyPrimed) {
        audio.src = url;
        audio.load();
      }
      seek(resumeAt);
      markAudioState("starting");
      attemptPlayback(fragment);
    }

    function replay() {
      audio.pause();
      try { audio.currentTime = 0; } catch (error) { /* metadata not ready */ }
      engine.resetVisit();
      engine.notifyMovement();
      syncAudio(true);
    }

    function onSoundClick() {
      var blocked = engine.dom.wrap.dataset.audioState === "blocked";
      if (!audio.muted && complete()) {
        replay();
        return;
      }
      if (!engine._moved) {
        audio.muted = false;
        storage.setItem(muteKey, "false");
        engine.notifyMovement();
        syncAudio(true);
        return;
      }
      if (blocked && audio.paused) {
        audio.muted = false;
        storage.setItem(muteKey, "false");
        renderSoundButton();
        syncAudio(true);
        return;
      }
      audio.muted = !audio.muted;
      storage.setItem(muteKey, String(audio.muted));
      renderSoundButton();
      if (!audio.muted) syncAudio(true);
    }

    function isViewerGesture(event) {
      var target = event.target;
      if (target && target.closest && target.closest(
        "a, button, input, select, textarea, [role=button], .cairn"
      )) return false;
      if (event.type === "keydown") {
        return movementKeys.has(String(event.key || "").toLowerCase());
      }
      return event.button === undefined || event.button === 0;
    }

    function notifyMovement(event) {
      if (!isViewerGesture(event)) return;
      engine.notifyMovement();
      // Keep play() inside the user-gesture call stack for mobile unlock.
      syncAudio(true);
    }

    function remember() {
      engine.rememberProgress();
    }

    muteButton.addEventListener("click", onSoundClick);
    win.addEventListener("keydown", notifyMovement, { capture: true });
    if ("PointerEvent" in win) {
      win.addEventListener("pointerup", notifyMovement, { capture: true });
    } else {
      win.addEventListener("touchstart", notifyMovement,
        { capture: true, passive: true });
      win.addEventListener("mousedown", notifyMovement, { capture: true });
    }
    win.addEventListener("pagehide", remember);
    doc.addEventListener("visibilitychange", function () {
      if (doc.visibilityState === "hidden") remember();
    });

    await Promise.all(manifest.fragments.map(async function (fragment) {
      var cueResponse = await win.fetch(fragment.captions, { cache: "no-store" });
      if (!cueResponse.ok) {
        throw new Error("Caption load failed: " + fragment.id);
      }
      engine.loadCues(fragment.id, await cueResponse.text());
    }));

    function frame() {
      if (disposed) return;
      engine.tick();
      syncAudio();

      // If neither encode can play, captions still finish on wall time.
      if (failedId && engine.active && engine.active.frag.id === failedId) {
        var elapsed = engine._now() - engine.active.startedAt;
        if (elapsed > Number(engine.active.frag.duration || 0) + 0.75) {
          engine._finish("complete");
        }
      }
      frameId = win.requestAnimationFrame(frame);
    }

    renderSoundButton();
    frameId = win.requestAnimationFrame(frame);

    var controller = {
      engine: engine,
      manifest: manifest,
      audio: audio,
      replay: replay,
      syncAudio: syncAudio,
      dispose: function () {
        disposed = true;
        if (frameId !== null) win.cancelAnimationFrame(frameId);
        remember();
        audio.pause();
        muteButton.removeEventListener("click", onSoundClick);
        win.removeEventListener("keydown", notifyMovement, { capture: true });
        win.removeEventListener("pointerup", notifyMovement, { capture: true });
        win.removeEventListener("touchstart", notifyMovement, { capture: true });
        win.removeEventListener("mousedown", notifyMovement, { capture: true });
        win.removeEventListener("pagehide", remember);
        engine.dom.wrap.remove();
        audio.remove();
      }
    };

    if (typeof options.onReady === "function") options.onReady(controller);
    return controller;
  }

  return {
    mount: mount,
    firstPlayable: firstPlayable,
    consumeResetParams: consumeResetParams
  };
});
