## Context

Managed delegation core deliberately stops before workspace-changing behavior. This change layers isolated worktrees and supervisor-initiated review merge on top of that core so implementation children can write safely away from the supervisor workspace and merge claims can be verified before the supervisor trusts them.

The design assumes the core delegation request/result lifecycle exists. Worktree metadata and merge outcomes are additional evidence attached to child sessions and durable events, not replacements for the core delegation state.

## Goals / Non-Goals

**Goals:**
- Create isolated git worktrees for worker children and persist safe worktree metadata.
- Add a supervisor-triggered `review_merge` role with authority to apply or reject worker changes in the supervisor workspace.
- Require a clean supervisor workspace and checkpoint before merge apply.
- Validate merge outcomes and require fixed test evidence for `merged`.
- Verify revert state after failed tests or failed apply attempts.
- Surface merge evidence in backend snapshots and dashboard timeline.

**Non-Goals:**
- Building the core parent-child session lifecycle.
- Automatically merging worker output after worker success.
- Supporting distributed sandboxes, remote workers, parallel merge gates, or full permission policy.
- Designing long-term worktree cleanup beyond recording paths and outcomes.

## Decisions

1. **Depend on managed delegation core.**
   - Decision: `review_merge` uses the existing durable delegation request and result lifecycle rather than introducing a parallel orchestration path.
   - Rationale: merge behavior should add authority and evidence, not duplicate parent-child scheduling.
   - Alternative considered: implement review merge as a separate backend job. Rejected because the supervisor would lose a single delegation tree.

2. **Use local git worktrees for worker isolation.**
   - Decision: worker children run in dedicated git worktrees recorded in durable metadata.
   - Rationale: this keeps implementation writes out of the supervisor workspace until explicit review.
   - Alternative considered: same-workspace worker writes. Rejected because failed or cancelled child work can leave the supervisor workspace ambiguous.

3. **Make review merge supervisor-triggered.**
   - Decision: the backend does not automatically spawn `review_merge` after worker success; the supervisor must request it.
   - Rationale: the supervisor should judge whether the worker result is worth reviewing and when merge risk is acceptable.
   - Alternative considered: automatic merge after worker success. Rejected because successful child execution is not equivalent to acceptable workspace changes.

4. **Backend verifies merge evidence.**
   - Decision: review merge reports are accepted only after backend checks checkpoint state, diff summary, fixed test result, and revert evidence when needed.
   - Rationale: a model claim about merge success is not sufficient for workspace integrity.
   - Alternative considered: trust the review agent's final text. Rejected because workspace side effects require verifiable evidence.

5. **Fixed test command is configured, not inferred from model output.**
   - Decision: the backend runs or verifies one configured fixed command for review merge acceptance.
   - Rationale: acceptance evidence should be predictable and reproducible.
   - Alternative considered: let review merge choose tests dynamically. Deferred until a richer policy layer exists.

## Risks / Trade-offs

- [Worktree state can leak disk space] -> Persist paths and outcomes so a future cleanup task can remove accepted or ignored worktrees.
- [Review merge can damage supervisor workspace] -> Require clean workspace checks, checkpoints, fixed tests, and revert verification.
- [Git conflicts can be hard to classify] -> Record `conflict` as a first-class outcome with safe conflict summary and no required revert when no apply occurred.
- [Fixed test command may be too broad or too slow] -> Make the command configurable and document the default before implementation.

## Migration Plan

1. Add worktree metadata to delegation read models and persistence.
2. Add worktree creation service for worker children.
3. Add `review_merge` child role validation and spawn behavior.
4. Add clean workspace checkpointing, apply verification, fixed test command execution, and revert verification.
5. Add dashboard merge evidence rendering.
6. Roll back by disabling `review_merge` and worktree-backed worker scheduling; core delegation remains usable.

## Open Questions

- What exact fixed test command should be the default for this repository?
- How long should completed child worktrees be retained before cleanup?
