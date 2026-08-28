/* Cairn v0.2 — captions for spatial media.
 *
 * Engine-agnostic core + adapters. The core knows nothing about PlayCanvas,
 * three.js, or audio APIs; it consumes a manifest, cue lists, and an adapter
 * that answers three questions:
 *
 *   adapter.clock(fragmentId)      -> seconds into fragment playback, or null
 *                                     (null => engine runs a wall clock, used
 *                                     for ambience / pre-gesture captions)
 *   adapter.bearing(entityName)    -> degrees relative to camera forward
 *                                     (-180..180), or null if unavailable
 *   adapter.onAudioEnd(fragmentId, cb)  (optional) completion signal
 *
 * The host (adapter or scene code) drives the engine with:
 *   engine.notifyMovement()  — first navigation input (fires first-move)
 *   engine.enterZone(zoneId) / engine.leaveZone(zoneId)
 *   engine.tick()  — call once per frame
 *
 * Spec: see SPEC.md. Normative behaviors implemented here:
 *   captions default ON; pre-gesture text; DOM overlay in an ARIA live
 *   region; direction tick; one-voice-at-a-time with hint lines; positional
 *   preemption at cue boundaries; walk-away completes the visible cue;
 *   sequential `after` chains; visit-gap memory; transcript log;
 *   localStorage persistence.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else {
    root.Cairn = factory();
    root.Wayside = root.Cairn;   // transitional alias (pre-rename integrations)
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ── VTT parsing (standard WebVTT; NOTE blocks carry cairn metadata) ──────

  function parseTimestamp(ts) {
    var m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})\.(\d{3})$/);
    if (!m) return null;
    var h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) +
           parseInt(m[4], 10) / 1000;
  }

  function parseVTT(text) {
    var lines = text.replace(/\r/g, "").split("\n");
    if (!/^WEBVTT/.test(lines[0] || "")) {
      throw new Error("not a WebVTT file");
    }
    var cues = [], meta = {}, i = 1;
    while (i < lines.length) {
      var line = lines[i];
      if (line.trim() === "") { i++; continue; }
      if (/^NOTE/.test(line)) {                 // metadata block
        i++;
        while (i < lines.length && lines[i].trim() !== "") {
          var kv = lines[i].match(/^([\w-]+):\s*(.+)$/);
          if (kv) meta[kv[1]] = kv[2];
          i++;
        }
        continue;
      }
      // Optional cue identifier line, then timing line
      var timing = line.indexOf("-->") >= 0 ? line : lines[++i] || "";
      if (timing.indexOf("-->") < 0) { i++; continue; }
      var parts = timing.split("-->");
      var start = parseTimestamp(parts[0]);
      var end = parseTimestamp((parts[1] || "").trim().split(" ")[0]);
      i++;
      var textLines = [];
      while (i < lines.length && lines[i].trim() !== "") {
        textLines.push(lines[i]);
        i++;
      }
      if (start !== null && end !== null && textLines.length) {
        cues.push({ start: start, end: end, text: textLines.join("\n") });
      }
    }
    return { cues: cues, meta: meta };
  }

  // ── Cue selection ──────────────────────────────────────────────────────────

  function cueAt(cues, t) {
    for (var i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) return cues[i];
    }
    return null;
  }

  // ── State persistence ──────────────────────────────────────────────────────

  function Store(sceneId, storage) {
    this.key = "cairn." + sceneId;
    this.legacyKey = "wayside." + sceneId;
    this.storage = storage || (typeof localStorage !== "undefined" ? localStorage : null);
    this.data = { captions: null, played: {} };
    if (this.storage) {
      try {
        var raw = this.storage.getItem(this.key);
        if (!raw) {
          // Copy legacy state forward once. Keep the Wayside key intact so a
          // rollback to the deployed pilot remains lossless.
          raw = this.storage.getItem(this.legacyKey);
          if (raw) this.storage.setItem(this.key, raw);
        }
        if (raw) this.data = JSON.parse(raw);
      } catch (e) { /* fresh state on parse failure */ }
    }
  }
  Store.prototype.save = function () {
    if (!this.storage) return;
    try { this.storage.setItem(this.key, JSON.stringify(this.data)); }
    catch (e) { /* storage full/blocked: captions still work, just unremembered */ }
  };
  Store.prototype.playedState = function (id) { return this.data.played[id] || null; };
  Store.prototype.markPlayed = function (id, state) {
    this.data.played[id] = state; this.save();
  };

  // ── Engine ─────────────────────────────────────────────────────────────────

  function Engine(manifest, adapter, opts) {
    opts = opts || {};
    this.manifest = manifest;
    this.adapter = adapter;
    this.defaults = manifest.defaults || {};
    this.fragments = {};
    (manifest.fragments || []).forEach(function (f) {
      this.fragments[f.id] = f;
    }, this);
    this.cuesById = {};        // fragmentId -> [{start,end,text}]
    this.store = new Store(manifest.scene || "scene", opts.storage);
    this._now = opts.now || function () { return Date.now() / 1000; };
    if (this.store.data.captions === null) {
      // Normative: captions default ON
      this.store.data.captions = (this.defaults.captions || "on") === "on";
    }
    // A "visit" is gap-defined: returning within visitResetHours keeps the
    // scene's memory (nothing replays); a longer absence is a fresh visit
    // and the piece plays again. Caption preference never resets.
    var resetH = (this.defaults.visitResetHours === undefined)
      ? 12 : this.defaults.visitResetHours;
    if (resetH && this.store.data.lastSeen &&
        (this._now() - this.store.data.lastSeen) > resetH * 3600) {
      this.store.data.played = {};
      this.store.data.resume = null;
      this.store.data.suspended = null;
    }
    this.store.data.lastSeen = this._now();
    this.store.save();
    this.active = null;        // {frag, startedAt(wall), partial}
    this.queue = [];
    this.suspended = this.store.data.suspended || null;
    this._resumedFromInterruption = null;
    this.transcript = [];
    this.dom = null;
    this._pending = [];        // scheduled `after` fragments: {id, at}
    this._moved = false;       // first-move latch
  }

  Engine.prototype.loadCues = function (fragmentId, cuesOrVtt) {
    if (typeof cuesOrVtt === "string") {
      this.cuesById[fragmentId] = parseVTT(cuesOrVtt).cues;
    } else {
      this.cuesById[fragmentId] = cuesOrVtt.cues || cuesOrVtt;
    }
  };

  Engine.prototype.captionsOn = function () { return !!this.store.data.captions; };
  Engine.prototype.toggle = function () {
    this.store.data.captions = !this.store.data.captions;
    this.store.save();
    var view = (this.active && this.active.lastCue)
      ? { frag: this.active.frag, cue: this.active.lastCue }
      : null;
    this._render(view);
    return this.store.data.captions;
  };

  // Reset only this scene's visit state. Audio playback remains host-owned;
  // callers can stop/rewind their adapter before notifying movement again.
  Engine.prototype.resetVisit = function () {
    this.store.data.played = {};
    this.store.data.resume = null;
    this.store.data.suspended = null;
    this.store.data.lastSeen = this._now();
    this.store.save();
    this.active = null;
    this.queue = [];
    this.suspended = null;
    this._resumedFromInterruption = null;
    this._pending = [];
    this._moved = false;
    this._render(null);
    return this;
  };

  // Trigger dispatch — the spatial layer.
  Engine.prototype._eligible = function (frag) {
    if (!frag) return false;
    var oncePerVisit = this.defaults.playOncePerVisit !== false;
    if (oncePerVisit && this.store.playedState(frag.id) === "complete") return false;
    if (this.active && this.active.frag.id === frag.id) return false;
    return true;
  };

  // First navigation input: fires every first-move fragment (the opener).
  // Hosts call this on the first movement gesture — which is also the
  // browser's audio-unlock moment, so sound and text start together.
  Engine.prototype.notifyMovement = function () {
    if (this._moved) return;
    this._moved = true;
    var frags = this.manifest.fragments || [];
    var resume = this.store.data.resume;
    if (resume && this._eligible(this.fragments[resume.id])) {
      this._start(this.fragments[resume.id], resume.at);
      return;
    }
    for (var i = 0; i < frags.length; i++) {
      var t = frags[i].trigger;
      if (t && t.type === "first-move" && this._eligible(frags[i])) {
        this._startOrQueue(frags[i]);
      }
    }
    // Recover state written before cue-boundary resume existed. This fallback
    // is only valid when a stale/ineligible resume record actually existed;
    // without one, the manifest's trigger grammar remains authoritative.
    if (resume && !this.active && !this.queue.length) {
      for (var j = 0; j < frags.length; j++) {
        if (this._eligible(frags[j])) {
          this._start(frags[j], 0);
          break;
        }
      }
    }
  };

  Engine.prototype.enterZone = function (zoneId) {
    var frag = this._fragmentForZone(zoneId);
    if (!this._eligible(frag)) return;
    if (this.active && this.defaults.oneVoiceAtATime !== false) {
      var persistentQueue = this.defaults.positionalQueue === "persistent";
      if (persistentQueue) {
        // A zone crossing is a durable event rather than a temporary claim on
        // playback. Preserve FIFO order and let the current fragment finish.
        if (this.queue.indexOf(frag.id) < 0) {
          this.queue.push(frag.id);
          this._hint(frag);
        }
        return;
      }
      var canPreempt = this.defaults.positionalPreempts !== false &&
                       this.active.frag.preemptible !== false;
      if (canPreempt) {
        // Arrival-side twin of walk-away: the resident voice takes the
        // floor at the current cue boundary, never mid-sentence.
        if (this.queue.indexOf(frag.id) < 0) this.queue.unshift(frag.id);
        this.active.dismissAfterCue = true;
        return;
      }
      if (this.queue.indexOf(frag.id) < 0) {
        this.queue.push(frag.id);
        this._hint(frag);           // "a voice near ..." — never interleave cues
      }
      return;
    }
    this._startOrQueue(frag);
  };

  Engine.prototype._startOrQueue = function (frag) {
    if (this.active) {
      if (this.queue.indexOf(frag.id) < 0) this.queue.push(frag.id);
    } else {
      this._start(frag);
    }
  };

  // Temporarily give an exceptional fragment the floor, then restore the
  // interrupted fragment (or remaining sequential gap) after it completes.
  // Audio fading remains host-owned; pass the adapter's exact playback clock in
  // opts.at after fade-out.
  Engine.prototype.interruptWith = function (fragmentId, opts) {
    opts = opts || {};
    var frag = this.fragments[fragmentId];
    if (!this._eligible(frag) || this.suspended) return false;

    var now = this._now();
    var activeSnapshot = null;
    if (this.active) {
      var at = Number(opts.at);
      if (!Number.isFinite(at)) {
        var clock = this.adapter.clock
          ? this.adapter.clock(this.active.frag.id) : null;
        at = clock === null || clock === undefined
          ? Math.max(0, now - this.active.startedAt)
          : Number(clock);
      }
      activeSnapshot = {
        id: this.active.frag.id,
        at: Math.max(0, Number(at) || 0)
      };
    }

    this.suspended = {
      by: fragmentId,
      active: activeSnapshot,
      queue: this.queue.slice(),
      pending: this._pending.map(function (item) {
        return { id: item.id, remaining: Math.max(0, item.at - now) };
      })
    };
    this.store.data.suspended = this.suspended;
    this.active = null;
    this.queue = [];
    this._pending = [];
    this._resumedFromInterruption = null;
    this._render(null);
    this._start(frag, 0);
    return true;
  };

  Engine.prototype._restoreSuspended = function () {
    var saved = this.suspended;
    if (!saved) return false;
    this.suspended = null;
    this.store.data.suspended = null;
    this.queue = (saved.queue || []).slice();
    var now = this._now();
    this._pending = (saved.pending || []).map(function (item) {
      return { id: item.id, at: now + Math.max(0, Number(item.remaining) || 0) };
    });

    var resume = saved.active;
    var resumeFrag = resume && this.fragments[resume.id];
    if (resumeFrag && this._eligible(resumeFrag)) {
      this._resumedFromInterruption = { id: resume.id, by: saved.by };
      this._start(resumeFrag, resume.at);
      return true;
    }
    if (this.queue.length) {
      var queued = this.fragments[this.queue.shift()];
      if (queued && this._eligible(queued)) {
        this._start(queued, 0);
        return true;
      }
    }
    this.store.data.resume = this._pending.length
      ? { id: this._pending[0].id, at: 0 } : null;
    this.store.save();
    return true;
  };

  Engine.prototype.leaveZone = function (zoneId) {
    var frag = this._fragmentForZone(zoneId);
    if (!frag) return;
    // Persistent queues latch entry. Leaving cannot withdraw a queued voice or
    // interrupt one that has already started.
    if (this.defaults.positionalQueue === "persistent") return;
    var qi = this.queue.indexOf(frag.id);
    if (qi >= 0) this.queue.splice(qi, 1);
    if (this.active && this.active.frag.id === frag.id) {
      var policy = frag.interruption || "complete-cue";
      if (policy === "cut") this._finish("partial");
      else if (policy === "complete-cue") this.active.dismissAfterCue = true;
      // "finish-fragment": no action — plays out
    }
  };

  Engine.prototype._fragmentForZone = function (zoneId) {
    var frags = this.manifest.fragments || [];
    for (var i = 0; i < frags.length; i++) {
      var t = frags[i].trigger;
      if (t && t.type === "zone" && t.zone === zoneId) return frags[i];
    }
    return null;
  };

  Engine.prototype._start = function (frag, resumeAt) {
    var at = Math.max(0, Number(resumeAt) || 0);
    this.active = {
      frag: frag,
      startedAt: this._now() - at,
      resumeAt: at,
      dismissAfterCue: false,
      lastCue: null
    };
    this.store.data.resume = { id: frag.id, at: at };
    this.store.save();
    if (this.adapter.onAudioEnd) {
      var self = this;
      this.adapter.onAudioEnd(frag.id, function () {
        if (self.active && self.active.frag.id === frag.id) {
          self._finish("complete");
        }
      });
    }
  };

  Engine.prototype._finish = function (state) {
    if (!this.active) return;
    var finished = this.active;
    var finishedId = finished.frag.id;
    this.store.markPlayed(finishedId, state);
    this.active = null;
    this._render(null);

    if (state === "complete" && this.suspended &&
        this.suspended.by === finishedId) {
      this._restoreSuspended();
      return;
    }

    // Sequential chains: schedule any `after` fragments keyed to this one.
    var frags = this.manifest.fragments || [];
    var followId = null;
    for (var i = 0; i < frags.length; i++) {
      var t = frags[i].trigger;
      if (t && t.type === "after" && t.fragment === finishedId &&
          this._eligible(frags[i])) {
        var delay = (typeof t.delay === "number") ? t.delay : 10;
        this._pending.push({ id: frags[i].id, at: this._now() + delay });
        if (!followId) followId = frags[i].id;
      }
    }

    if (state === "complete") {
      var nextId = this.queue.length ? this.queue[0] : followId;
      this.store.data.resume = nextId ? { id: nextId, at: 0 } : null;
    } else {
      var cueStart = finished.lastCue ? finished.lastCue.start : finished.resumeAt;
      this.store.data.resume = { id: finishedId, at: Math.max(0, cueStart || 0) };
    }
    this.store.save();

    if (this.queue.length) {
      var queuedId = this.queue.shift();
      var frag = this.fragments[queuedId];
      if (frag) this._start(frag);
    }
  };

  // Persist a return point at a sentence/caption boundary. Hosts call this on
  // pagehide or when the document is backgrounded.
  Engine.prototype.rememberProgress = function () {
    if (this.active) {
      var cue = this.active.lastCue;
      var at = cue ? cue.start : this.active.resumeAt;
      this.store.data.resume = {
        id: this.active.frag.id,
        at: Math.max(0, Number(at) || 0)
      };
    } else if (this._pending.length) {
      this.store.data.resume = { id: this._pending[0].id, at: 0 };
    }
    this.store.data.lastSeen = this._now();
    this.store.save();
  };

  // Per-frame drive — the temporal layer.
  Engine.prototype.tick = function () {
    // Drive scheduled `after` fragments when the floor is free.
    if (!this.active && this._pending.length) {
      var now = this._now();
      for (var p = 0; p < this._pending.length; p++) {
        if (now >= this._pending[p].at) {
          var pfrag = this.fragments[this._pending[p].id];
          this._pending.splice(p, 1);
          if (pfrag && this._eligible(pfrag)) { this._start(pfrag); }
          break;
        }
      }
    }
    if (!this.active) return;
    var frag = this.active.frag;
    var cues = this.cuesById[frag.id] || [];
    var t = this.adapter.clock ? this.adapter.clock(frag.id) : null;
    if (t === null || t === undefined) {
      // Wall clock: ambience / caption-only / pre-gesture (audio blocked)
      t = this._now() - this.active.startedAt;
    }
    var cue = cueAt(cues, t);

    // Walk-away / preemption policy: yield at the cue boundary — the moment
    // the visible cue ends (gap or next cue), never mid-sentence.
    if (this.active.dismissAfterCue &&
        (cue !== this.active.lastCue || cue === null)) {
      if (this.active.lastCue) this._log(frag, this.active.lastCue);
      this._finish("partial");
      return;
    }

    if (cue !== this.active.lastCue) {
      if (this.active.lastCue) this._log(frag, this.active.lastCue);
      this.active.lastCue = cue;
      if (cue) {
        // Persist at the moment a caption begins. Mobile browsers do not
        // guarantee pagehide/visibilitychange during every reload or eviction,
        // so lifecycle-only checkpoints can lose the first interrupted cue.
        this.active.resumeAt = cue.start;
        this.store.data.resume = { id: frag.id, at: cue.start };
        this.store.data.lastSeen = this._now();
        this.store.save();
      }
      this._render(cue ? { frag: frag, cue: cue } : null);
    }

    // Fragment end (no audio-end signal): last cue passed + grace
    var last = cues[cues.length - 1];
    if (last && t > last.end + 0.75 && !this.adapter.onAudioEnd) {
      if (this.active.lastCue) this._log(frag, this.active.lastCue);
      this._finish("complete");
    }
  };

  Engine.prototype._log = function (frag, cue) {
    this.transcript.push({
      fragment: frag.id,
      speaker: frag.speaker || null,
      kind: frag.kind || "narration",
      text: cue.text
    });
    if (this.dom) this._renderTranscript();
  };

  Engine.prototype._hint = function (frag) {
    if (!this.dom || !this.captionsOn()) return;
    var label = frag.hint || ("a voice nearby" +
      (frag.speaker ? " — " + frag.speaker : ""));
    this.dom.hint.textContent = label;
    this.dom.hint.classList.add("cairn-visible");
    var self = this;
    setTimeout(function () {
      self.dom.hint.classList.remove("cairn-visible");
    }, 4000);
  };

  // ── DOM overlay (attach-time only; core logic never requires a document) ──

  Engine.prototype.attach = function (parent) {
    var doc = parent.ownerDocument || document;
    var wrap = doc.createElement("div");
    wrap.className = "cairn";
    wrap.innerHTML =
      '<div class="cairn-hint" aria-hidden="true"></div>' +
      '<div class="cairn-caption-row">' +
      '  <span class="cairn-tick cairn-tick-left" aria-hidden="true">◀</span>' +
      '  <div class="cairn-caption" role="region" aria-live="polite" ' +
      '       aria-label="Narration captions"></div>' +
      '  <span class="cairn-tick cairn-tick-right" aria-hidden="true">▶</span>' +
      '</div>' +
      '<div class="cairn-controls">' +
      '  <button type="button" class="cairn-toggle" aria-pressed="true">CC</button>' +
      '  <button type="button" class="cairn-transcript-btn" ' +
      '          aria-expanded="false">Transcript</button>' +
      '</div>' +
      '<div class="cairn-transcript" role="log" aria-label="Transcript" hidden></div>';
    parent.appendChild(wrap);
    this.dom = {
      wrap: wrap,
      hint: wrap.querySelector(".cairn-hint"),
      caption: wrap.querySelector(".cairn-caption"),
      tickL: wrap.querySelector(".cairn-tick-left"),
      tickR: wrap.querySelector(".cairn-tick-right"),
      toggle: wrap.querySelector(".cairn-toggle"),
      transcriptBtn: wrap.querySelector(".cairn-transcript-btn"),
      transcript: wrap.querySelector(".cairn-transcript")
    };
    var self = this;
    this.dom.toggle.addEventListener("click", function () {
      var on = self.toggle();
      self.dom.toggle.setAttribute("aria-pressed", String(on));
    });
    this.dom.toggle.setAttribute("aria-pressed", String(this.captionsOn()));
    this.dom.transcriptBtn.addEventListener("click", function () {
      var hidden = self.dom.transcript.hasAttribute("hidden");
      if (hidden) self.dom.transcript.removeAttribute("hidden");
      else self.dom.transcript.setAttribute("hidden", "");
      self.dom.transcriptBtn.setAttribute("aria-expanded", String(hidden));
    });
    return this;
  };

  Engine.prototype._render = function (view) {
    if (!this.dom) return;
    var show = view && this.captionsOn();
    this.dom.caption.textContent = show ? view.cue.text : "";
    this.dom.wrap.classList.toggle("cairn-active", !!show);
    // Direction ticks are aesthetic policy, not free accessibility win:
    // locating a narrator kills the acousmatic voice-from-nowhere, and when
    // narrator entities sit at their subjects the tick points at the thing
    // being described — syncing image to voice. Default: ambience only,
    // where direction is real information ([creek over stones] is somewhere).
    var tickPolicy = this.defaults.directionTicks || "ambience";
    var wantTick = tickPolicy === "all" ||
      (tickPolicy === "ambience" && view && view.frag.kind === "ambience");
    var deg = null;
    if (show && wantTick && this.adapter.bearing && view.frag.source &&
        view.frag.source.entity) {
      deg = this.adapter.bearing(view.frag.source.entity);
    }
    // Direction tick: only when meaningfully off-axis (> 30°)
    this.dom.tickL.style.visibility =
      (deg !== null && deg < -30) ? "visible" : "hidden";
    this.dom.tickR.style.visibility =
      (deg !== null && deg > 30) ? "visible" : "hidden";
  };

  Engine.prototype._renderTranscript = function () {
    var doc = this.dom.wrap.ownerDocument;
    var el = this.dom.transcript;
    el.textContent = "";
    this.transcript.forEach(function (entry) {
      var p = doc.createElement("p");
      p.className = "cairn-transcript-entry cairn-kind-" + entry.kind;
      p.textContent = (entry.speaker ? entry.speaker + ": " : "") +
        entry.text.replace(/\n/g, " ");
      el.appendChild(p);
    });
    el.scrollTop = el.scrollHeight;
  };

  // ── HtmlAudioAdapter — reference adapter for plain <audio> (and the demo) ──

  function HtmlAudioAdapter(opts) {
    opts = opts || {};
    this.audio = {};        // fragmentId -> HTMLAudioElement
    this.bearings = {};     // entityName -> degrees (host-updated)
    this._endCbs = {};
    this._boundAudio = [];
    this._activeFragmentByAudio = [];
    this.wallClockBeforePlayback = opts.wallClockBeforePlayback !== false;
  }
  HtmlAudioAdapter.prototype.register = function (fragmentId, audioEl) {
    this.audio[fragmentId] = audioEl;
    if (this._boundAudio.indexOf(audioEl) >= 0) return;
    this._boundAudio.push(audioEl);
    this._activeFragmentByAudio.push(null);
    var self = this;
    audioEl.addEventListener("ended", function () {
      var index = self._boundAudio.indexOf(audioEl);
      var activeId = index >= 0 ? self._activeFragmentByAudio[index] : null;
      (self._endCbs[activeId] || []).slice().forEach(function (cb) { cb(); });
    });
  };
  HtmlAudioAdapter.prototype.clock = function (fragmentId) {
    var a = this.audio[fragmentId];
    if (!a) return null;
    var index = this._boundAudio.indexOf(a);
    if (index >= 0) this._activeFragmentByAudio[index] = fragmentId;
    if (a.paused && a.currentTime === 0) {
      return this.wallClockBeforePlayback ? null : 0;
    }
    return a.currentTime;
  };
  HtmlAudioAdapter.prototype.bearing = function (entityName) {
    return entityName in this.bearings ? this.bearings[entityName] : null;
  };
  HtmlAudioAdapter.prototype.onAudioEnd = function (fragmentId, cb) {
    (this._endCbs[fragmentId] = this._endCbs[fragmentId] || []).push(cb);
  };

  /* ── PlayCanvasAdapter — reference wiring (requires a pc.Application) ──────
   *
   * Usage inside a scene script:
   *
   *   var adapter = new Cairn.PlayCanvasAdapter(this.app, cameraEntity);
   *   adapter.registerSlot("gauge", narratorEntity, "gauge");  // sound slot
   *   var engine = new Cairn.Engine(manifest, adapter).attach(document.body);
   *   // Fire from your existing trigger volumes:
   *   //   engine.enterZone("waters-edge") / engine.leaveZone("waters-edge")
   *   // plus engine.notifyMovement() on first navigation input,
   *   // and call engine.tick() from app.on("update").
   */
  function PlayCanvasAdapter(app, cameraEntity) {
    this.app = app;
    this.camera = cameraEntity;
    this.slots = {};   // fragmentId -> {entity, slotName}
    this._endCbs = {};
  }
  PlayCanvasAdapter.prototype.registerSlot = function (fragmentId, entity, slotName) {
    this.slots[fragmentId] = { entity: entity, slot: slotName };
    var self = this;
    var slot = entity.sound && entity.sound.slot(slotName);
    if (slot) {
      slot.on("end", function () {
        (self._endCbs[fragmentId] || []).forEach(function (cb) { cb(); });
      });
    }
  };
  PlayCanvasAdapter.prototype.clock = function (fragmentId) {
    var reg = this.slots[fragmentId];
    if (!reg || !reg.entity.sound) return null;
    var slot = reg.entity.sound.slot(reg.slot);
    if (!slot || !slot.instances || !slot.instances.length) return null;
    var inst = slot.instances[0];
    return inst.isPlaying ? inst.currentTime : null;
  };
  PlayCanvasAdapter.prototype.bearing = function (entityName) {
    var ent = this.app.root.findByName(entityName);
    if (!ent || !this.camera) return null;
    var camPos = this.camera.getPosition();
    var fwd = this.camera.forward;
    var to = ent.getPosition().clone().sub(camPos).normalize();
    var angle = Math.atan2(to.x, -to.z) - Math.atan2(fwd.x, -fwd.z);
    var deg = angle * 180 / Math.PI;
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;
    return deg;
  };
  PlayCanvasAdapter.prototype.onAudioEnd = function (fragmentId, cb) {
    (this._endCbs[fragmentId] = this._endCbs[fragmentId] || []).push(cb);
  };

  return {
    Engine: Engine,
    parseVTT: parseVTT,
    cueAt: cueAt,
    Store: Store,
    HtmlAudioAdapter: HtmlAudioAdapter,
    PlayCanvasAdapter: PlayCanvasAdapter
  };
});
