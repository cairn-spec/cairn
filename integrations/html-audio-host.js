/* Cairn HTML Audio host.
 *
 * Reusable production-hardened browser integration.
 * Cairn owns captions and scene state; this host owns browser audio delivery,
 * user-gesture unlocking, mute/replay controls, and lifecycle persistence.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory(require("../runtime/cairn.js"));
  } else {
    root.CairnHost = factory(root.Cairn);
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

  function createResumeClockGate(clock) {
    var held = null;
    return {
      hold: function (fragmentId, at) {
        held = { id: fragmentId, at: Math.max(0, Number(at) || 0) };
      },
      release: function (fragmentId) {
        if (!fragmentId || (held && held.id === fragmentId)) held = null;
      },
      clock: function (fragmentId) {
        if (held && held.id === fragmentId) {
          var actual = clock(fragmentId);
          if (Number.isFinite(actual) && Math.abs(actual - held.at) <= 0.35) {
            held = null;
            return actual;
          }
          return held.at;
        }
        return clock(fragmentId);
      },
      held: function () { return held; }
    };
  }

  function hasUnfinishedResume(engine) {
    var resume = engine && engine.store && engine.store.data.resume;
    if (!resume || !engine.fragments[resume.id]) return false;
    return engine.store.playedState(resume.id) !== "complete";
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
    var muteKey = options.muteKey || "cairn.host.muted";
    var legacyMuteKey = options.legacyMuteKey || "wayside.muted";
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
    var baseVolume = options.volume === undefined ? 0.8 : options.volume;
    audio.volume = baseVolume;
    audio.hidden = true;
    doc.body.appendChild(audio);

    var adapter = new Cairn.HtmlAudioAdapter({
      wallClockBeforePlayback: false
    });
    var resumeClock = createResumeClockGate(
      adapter.clock.bind(adapter)
    );
    adapter.clock = resumeClock.clock;
    manifest.fragments.forEach(function (fragment) {
      adapter.register(fragment.id, audio);
    });

    var engine = new Cairn.Engine(manifest, adapter).attach(
      options.parent || doc.body
    );
    engine.dom.wrap.classList.add("cairn-host");
    var resumeNeedsTap = hasUnfinishedResume(engine);

    // The compact host presents captions without an in-scene transcript UI.
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
    var volumeTweenToken = 0;
    var interruptionPromise = null;

    function fadeVolume(target, durationMs) {
      var token = ++volumeTweenToken;
      var from = audio.volume;
      var duration = Math.max(0, Number(durationMs) || 0);
      if (!duration) {
        audio.volume = target;
        return Promise.resolve(true);
      }
      var started = win.performance && typeof win.performance.now === "function"
        ? win.performance.now() : Date.now();
      return new Promise(function (resolve) {
        function step(now) {
          if (token !== volumeTweenToken || disposed) {
            resolve(false);
            return;
          }
          var elapsed = (Number(now) || Date.now()) - started;
          var t = Math.max(0, Math.min(1, elapsed / duration));
          audio.volume = from + (target - from) * t;
          if (t < 1) win.requestAnimationFrame(step);
          else resolve(true);
        }
        win.requestAnimationFrame(step);
      });
    }

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
        : resumeNeedsTap ? "Resume audio"
        : replay ? "Replay narration"
        : blocked ? "Tap for sound"
        : waiting ? "Start audio"
        : "Sound on";
      muteButton.setAttribute("aria-pressed", String(audio.muted));
      var label = audio.muted
        ? "Unmute narration"
        : resumeNeedsTap ? "Resume narration"
        : replay ? "Replay narration"
        : (blocked || waiting) ? "Start narration"
        : "Mute narration";
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

    function seek(fragmentId, resumeAt) {
      if (!(resumeAt > 0)) {
        resumeClock.release(fragmentId);
        return;
      }
      resumeClock.hold(fragmentId, resumeAt);
      function apply() {
        var limit = Number.isFinite(audio.duration)
          ? Math.max(0, audio.duration - 0.05)
          : resumeAt;
        var target = Math.min(resumeAt, limit);
        try {
          audio.currentTime = target;
          if (audio.seeking) {
            audio.addEventListener("seeked", function () {
              resumeClock.release(fragmentId);
            }, { once: true });
          } else {
            resumeClock.release(fragmentId);
          }
        } catch (error) {
          resumeClock.release(fragmentId);
          if (options.debug) {
            console.error("[Cairn Host] Resume seek failed for " + fragmentId,
              error);
          }
        }
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
            console.error("[Cairn Host] Playback failed for " + fragment.id, error);
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
        var resume = resumeNeedsTap && engine.store.data.resume
          ? engine.fragments[engine.store.data.resume.id]
          : null;
        var next = pending || resume || opener;
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
          console.error("[Cairn Host] No audio source for " + fragment.id);
        }
        return;
      }

      var resumed = engine._resumedFromInterruption &&
        engine._resumedFromInterruption.id === fragment.id;
      if (resumed) {
        engine._resumedFromInterruption = null;
        audio.volume = 0;
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
      seek(fragment.id, resumeAt);
      markAudioState("starting");
      attemptPlayback(fragment);
      if (resumed) {
        fadeVolume(baseVolume,
          options.interruptionResumeFadeMs === undefined
            ? 1000 : options.interruptionResumeFadeMs);
      }
    }

    function interruptWith(fragmentId, interruptionOptions) {
      interruptionOptions = interruptionOptions || {};
      if (interruptionPromise || engine.suspended ||
          engine.store.playedState(fragmentId) === "complete") {
        return Promise.resolve(false);
      }
      var expectedId = engine.active && engine.active.frag.id;
      var shouldFade = !!expectedId && !audio.paused && !audio.ended;
      var fadeOutMs = interruptionOptions.fadeOutMs === undefined
        ? 1500 : interruptionOptions.fadeOutMs;
      var fadeInMs = interruptionOptions.fadeInMs === undefined
        ? 650 : interruptionOptions.fadeInMs;

      interruptionPromise = (shouldFade
        ? fadeVolume(0, fadeOutMs) : Promise.resolve(true))
        .then(function () {
          if (expectedId && (!engine.active ||
              engine.active.frag.id !== expectedId)) {
            audio.volume = baseVolume;
            return false;
          }
          var at = expectedId && Number.isFinite(Number(audio.currentTime))
            ? Number(audio.currentTime) : undefined;
          audio.pause();
          if (!engine.interruptWith(fragmentId, { at: at })) {
            audio.volume = baseVolume;
            return false;
          }
          audio.volume = 0;
          syncAudio(true);
          return fadeVolume(baseVolume, fadeInMs).then(function () {
            return true;
          });
        }).finally(function () {
          interruptionPromise = null;
        });
      return interruptionPromise;
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
      if (resumeNeedsTap) {
        resumeNeedsTap = false;
        audio.muted = false;
        storage.setItem(muteKey, "false");
        engine.notifyMovement();
        syncAudio(true);
        renderSoundButton();
        return;
      }
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
      if (resumeNeedsTap) {
        renderSoundButton();
        return;
      }
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
      syncAudio();
      engine.tick();

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
      interruptWith: interruptWith,
      get resumeNeedsTap() { return resumeNeedsTap; },
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
    consumeResetParams: consumeResetParams,
    createResumeClockGate: createResumeClockGate,
    hasUnfinishedResume: hasUnfinishedResume
  };
});
