# Cairn 0.2.0 release checklist

Do not publish the npm package, create the final tag/release, or change
repository visibility until the package passes this gate and Steve explicitly
starts the Cairn release.

## Prepared state

- [x] MIT license present with Steve Bransford copyright.
- [x] Runtime/spec changes merged to `main`.
- [x] Package version prepared as `0.2.0`.
- [x] README and spec describe the production-proven behavior classes.
- [x] Integration guide documents persistent queues and exceptional resume.
- [x] Changelog covers the 0.2.0 runtime and generic host contracts.
- [x] Package includes runtime, styles, browser host, viewport bridge, spec,
      integration guide, changelog, generic examples, README, and license.
- [x] Independent production-reference regression passed on 2026-08-20.

## Final preflight

- [ ] Pull `main` and confirm a clean worktree.
- [ ] Run `npm test` (expected: 30 core + 3 visit-memory + 7 host).
- [ ] Run `python -m unittest discover -s tools/tests` (expected: 58 authoring
      tests).
- [ ] Run `npm run pack:check`; inspect the file list, version, size, and MIT
      metadata.
- [ ] Confirm the tarball contains only generic Cairn names and examples.
- [ ] Confirm `npm view cairn-spec version` still reports `0.1.1`; do not
      overwrite an unexpected newer version.
- [ ] Run the independent reference deployment's own real-phone and desktop/Mac
      release gate, including one narration resume round trip.

## Launch-day publication

These are deliberate external side effects. Run them only after Steve's
launch-day approval.

1. Change `cairn-spec/cairn` visibility to public if it is still private.
2. Verify the public README, LICENSE, SPEC, INTEGRATION, and examples without an
   authenticated session.
3. Create and push the final annotated tag:

   ```bash
   git tag -a v0.2.0 -m "Cairn 0.2.0"
   git push origin v0.2.0
   ```

4. Publish the already-reviewed package:

   ```bash
   npm publish --access public
   ```

5. Verify `npm view cairn-spec version` reports `0.2.0`, then create the GitHub
   release from `v0.2.0` using the 0.2.0 changelog section.
6. Publish the Cairn announcement with the GitHub repository, npm package, and
   integration guide. External reference artworks may link to Cairn on their
   own schedules.

## Rollback / stop conditions

- Stop if `main` differs from the reviewed release commit, tests fail, the npm
  version is already occupied, or the independent reference deployment has an
  unresolved Cairn integration failure.
- npm versions cannot be overwritten. If publication succeeds but a defect is
  found, fix forward with `0.2.1`; do not attempt to replace `0.2.0`.
- A GitHub visibility change is separate from npm publication. If either step
  fails, leave the other state unchanged and report the exact completed boundary.
