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
- Peachtree Creek positional-queue example and expanded integration QA contract.

### Changed

- The npm package now includes the integration guide, changelog, examples, and
  mobile viewport integration.
- The default test command now runs 29 core tests, 3 cross-load visit-memory
  tests, and 7 ASM-host tests.

### Proven in production

- Atlanta Space Machine's native-Google aerial and all 12 walkable scenes.
- Ten sequential narration scenes with ten-second authored gaps.
- South Peachtree Creek's four-zone persistent positional queue.
- Japanese Garden at ABG's single exceptional lantern interruption.

## 0.1.1 — 2026

- Corrected npm repository metadata after moving to `cairn-spec/cairn`.

## 0.1.0 — 2026

- Initial spec, engine-agnostic runtime, WebVTT authoring tools, demo, and
  sequential-scene reference integration.
