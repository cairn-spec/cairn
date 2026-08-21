# Changelog

All notable changes to Cairn are documented here. Cairn follows semantic
versioning for the runtime and integration contracts.

## 0.2.0 — prepared 2026-08-20

### Added

- Persistent FIFO positional queues for traversal scenes where crossing a zone
  is a durable request to hear that fragment.
- Exceptional `interruptWith()` suspend/resume for one-off encounters that
  fade the current narration, play once, and restore the displaced fragment or
  sequential delay—even after reload.
- Shared-player completion identity so one HTML Audio `ended` event advances
  exactly one queued fragment.
- Deterministic unfinished-fragment resume with explicit browser audio unlock
  and synchronized caption/audio clocks.
- Safari visual-viewport bridge for stable mobile controls after browser chrome
  and privacy notices change the usable viewport.
- Persistent-traversal positional-queue example and expanded integration QA
  contract.
- A zones-only regression that keeps first movement from bypassing authored
  zone triggers when no opener or legacy resume state exists.

### Changed

- The npm package now includes the integration guide, changelog, examples, and
  mobile viewport integration.
- The default test command now runs 30 core tests, 3 cross-load visit-memory
  tests, and 7 host-integration tests.
- The spec now defines deliberate same-session re-entry as a restart and
  persisted reload restoration as cue-boundary continuation.

### Proven in production

- A production aerial experience and all 12 walkable scenes in its collection.
- Ten sequential narration scenes with ten-second authored gaps.
- A four-zone persistent positional queue.
- A single exceptional object encounter that interrupts and resumes narration.

## 0.1.1 — 2026

- Corrected npm repository metadata after moving to `cairn-spec/cairn`.

## 0.1.0 — 2026

- Initial spec, engine-agnostic runtime, WebVTT authoring tools, demo, and
  sequential-scene reference integration.
