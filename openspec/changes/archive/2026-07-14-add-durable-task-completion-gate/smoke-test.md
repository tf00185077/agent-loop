# Live Managed-Provider Smoke Test

Date: 2026-07-14

- Provider: Claude Code 2.1.207, print mode.
- Judge result: passed. A live prompt returned one parseable
  `managed_review.decision` block targeting `live-worker-1`, with verdict
  `accepted` and exactly one `PASS` decision for frozen criterion `A1`.
- Fixture-only apply metadata: not used. The production path consumes the
  structured Judge block; the mock end-to-end test exercises the same path
  without `reviewMergeApplyOutcome` injection.
- Backend delivery: passed independently of provider output. Filesystem-backed
  git tests verify candidate creation, clean checkpointing, cherry-pick,
  fixed validation, committed SHA evidence, conflicts, stale attestation,
  verified rollback, and rollback failure.
- Codex note: the `codex` executable available on this machine is an unrelated
  legacy static-site tool (`codex 0.2.3`), not OpenAI Codex CLI, so it was not a
  valid managed-provider candidate.

Conclusion: structured Judge output works through a live managed provider, and
delivery remains deterministic backend-owned behavior rather than provider or
fixture metadata behavior.
