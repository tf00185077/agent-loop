# OpenSpec Workflow For Agents

Use OpenSpec to separate design decisions from implementation work. A feature should move through proposal, design/spec clarification, task planning, implementation, validation, and archive.

## 1. Explore

Use exploration when the problem or scope is still unclear. Read the existing docs and code, compare options, and clarify tradeoffs before creating artifacts.

For this repo, start with:

- `README.md`
- `ARCHITECTURE.md`
- `openspec/project.md`
- Existing changes from `openspec list`
- Existing specs from `openspec list --specs`

## 2. Propose

Create a change proposal before implementing meaningful behavior changes.

Recommended command:

```bash
openspec new change "<change-name>"
```

Then use:

```bash
openspec status --change "<change-name>" --json
openspec instructions <artifact-id> --change "<change-name>" --json
```

Generate the required artifacts in dependency order. For the spec-driven schema, expect artifacts such as `proposal.md`, `design.md`, `tasks.md`, and any required spec deltas.

## 3. Validate

Before implementation, validate the change artifacts:

```bash
openspec validate "<change-name>"
```

Fix proposal, design, task, or spec issues before writing application code.

## 4. Apply

Implement from `tasks.md`. Keep changes scoped to the accepted proposal and update task checkboxes as work is completed.

Implementation should follow the repo architecture:

- Goal-centric API and dashboard behavior.
- SQLite as durable state.
- Runtime actions represented by events.
- Provider adapter boundary.
- Local single-user MVP first.

## 5. Verify

Run the relevant verification for the changed layer. Examples:

- TypeScript compile checks.
- Unit/API/runtime tests once test scripts exist.
- Dashboard/browser verification once the frontend exists.
- `openspec validate "<change-name>"`.

## 6. Archive

After implementation is complete and validated, archive the change so accepted requirements move into the main specs:

```bash
openspec archive "<change-name>"
```

## How To Work With Codex

Ask Codex to propose a change when you know what feature or fix you want. Ask Codex to explore when the idea is fuzzy. Ask Codex to apply a change only after the proposal artifacts exist and you are ready for code changes.

Good requests:

- `Explore how goal start/pause should work before we propose it.`
- `Create an OpenSpec proposal for SQLite persistence.`
- `Apply the add-sqlite-persistence change.`
- `Validate and archive the completed add-sqlite-persistence change.`

When requesting a proposal, include the feature goal, expected user behavior, and anything explicitly out of scope. If those details are missing, Codex should ask before creating the change.
