# Proposal: add-task-acceptance-contracts

## Why

Live supervisor runs and prior auto-loop experience expose the same failure family: the "definition of done" for a delegated task exists only inside each agent's context window, so a reviewer and a coder can disagree forever (the task never passes), the supervisor forgets what it already delegated (it re-decomposed and re-delegated task-1 repeatedly in the live smoke), and worker success claims are taken on faith instead of evidence. The fix is a frozen, machine-validated acceptance contract per task — enforced by the backend control plane, not by prompt text.

## What Changes

- Task list entries and worker delegation requests SHALL carry a frozen acceptance contract: immutable criterion IDs with binary, testable text. The backend rejects worker delegations for known tasks that omit acceptance criteria.
- Child results become structured machine results instead of free-text summaries: per-criterion evidence (`criterion_evidence`), tests run (command/exit code/summary), and `files_changed` — with `files_changed` attested by the backend from the worker worktree's git status rather than trusted from the child's self-report.
- Reviews become cite-only: a review/rejection verdict must cite existing criterion IDs; observations outside the frozen criteria are recorded durably as deferred findings and cannot block the task.
- Two substantive rejections on the same task trip a narrowing rule: the backend refuses a third identical-scope re-delegation and instructs the supervisor to split the remaining criterion gaps into strictly narrower tasks (or mark the task failed and re-plan). Blind retry of the same broad contract is structurally impossible.
- Supervisor continuations carry the durable task history: the announced task list with per-task status, acceptance criteria, delegation outcomes, and remaining criterion gaps — so fresh-continuation providers stop re-decomposing from scratch.
- Prompt contract updates ride along, but every deterministic rule above lives in backend validators (contract enforcement is code, not instructions).

## Capabilities

### New Capabilities

- `task-acceptance-contracts`: The frozen per-task acceptance contract model — criterion IDs, backend validation, structured machine results with backend-attested file evidence, cite-only review verdicts with deferred findings, and the two-rejection narrowing rule.

### Modified Capabilities

- `supervisor-goal-orchestration`: Task decomposition SHALL include acceptance criteria per task; continuation prompts SHALL carry the durable task history and per-task acceptance status; the bootstrap contract documents the acceptance and citation rules.
- `managed-delegation-core`: Worker delegation requests SHALL persist their acceptance contract; child terminal outcomes SHALL persist structured machine results; per-task rejection counts SHALL be durable and drive the narrowing rule.

## Impact

- **Domain**: new acceptance-contract and machine-result types; delegation control-event schema gains `acceptance`; task-list entries gain `acceptance`.
- **Persistence**: additive columns/JSON fields on delegation requests (acceptance contract, structured result, rejection lineage); no breaking migration.
- **Runtime**: `delegation-control-event` validation, `delegation-coordinator` (worktree git-status attestation at child terminal), `agent-session-manager` (task registry per goal, narrowing enforcement, continuation history), `supervisor-prompt` (contract sections + task-history variant).
- **Dashboard**: no new UI required; new metadata rides existing timeline events (and feeds the pending `add-agent-live-status-model` change).
- **Out of scope (non-goals)**: goal→multiple-OpenSpec-change decomposition (future change), owner-remediation/watchdog loops, parallel children, quorum review of specs, OpenSpec artifact generation inside goals.
