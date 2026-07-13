---
name: decompose-route-verify
description: Use when starting any task that has more than one obvious step or any uncertainty — bug reports, feature requests, "quick fixes", urgent requests, or whenever someone has already told you what the cause or solution is. Invoke BEFORE reading code, proposing a diagnosis, or changing anything.
---

# Decompose, Route, Verify

## Overview

A fixed working loop for any non-trivial task: establish ground truth, decompose by uncertainty, pick a route deliberately, change one thing at a time, and never claim success without fresh evidence.

**Core principle: every statement anyone gives you — including a diagnosis from a senior engineer, a ticket, or a user report — is a CLAIM, not a fact. Claims are verified before they are built upon.**

**Violating the letter of these rules is violating their spirit.** There is no "I followed the idea of it."

## The Two Iron Laws

1. **No fix before reproduction.** You may not change code to fix a problem you have not personally observed failing. Run the failing command / open the failing page / print the wrong value FIRST.
2. **No claim without fresh evidence.** You may not say "fixed", "works", "confirmed", or "done" unless you ran the concrete check in this session, after your last change, and you are quoting its actual output. If you did not run it, you must write exactly: "NOT VERIFIED".

These two laws exist because under time pressure, agents patch the function someone *said* was broken, then invent plausible-sounding verification. That is fabrication, and it ships the bug.

## Phase 0 — Ground Truth (before touching anything)

1. Restate the task as an **observable done-check**: "Done means running Y shows X." If you cannot write this sentence, you do not understand the task yet — find the check (a test file, a command, a page) or ask.
2. **Run the done-check now**, before any change. You need to see the failure with your own eyes:
   - Bug report? Reproduce it. The real output often contradicts the report (e.g. the report says a number is wrong; reality shows the value is a *string* — a completely different bug class).
   - "X is the cause"? That is a claim. Note it, but let the reproduction tell you where the bug is.
3. Record: expected vs. actual, verbatim.
4. **Find the written spec before trusting anyone or anything about intended behavior.** Look for README, docs, comments stating business rules. The authority order is: **written spec > existing tests > what people say**. Existing tests — especially ones labeled "snapshot", "from production", or "legacy" — can fossilize a bug as an expected value. A green test proves the code matches the test, not that the behavior is right. When a test and the spec disagree, the spec wins and the test must be flagged or fixed with a written justification.

**Someone already diagnosed it?** Good — treat the diagnosis as hypothesis #1, and still reproduce first. If they were right you lose 30 seconds. If they were wrong, you were about to modify healthy code and claim victory.

**Rejecting a diagnosis? Prove it with numbers, not words.** Take the reported case's concrete values and trace them through the proposed fix: show that the output would not change (or would change to something still wrong). "The real bug was elsewhere" is an assertion; "with input 1200, the proposed fix produces the same wrong 960, because 1200 passes both comparisons" is a proof. Reviewers can only trust the second kind.

**Time pressure?** Reproduction IS the fast path. A wrong fix delivered on time fails in front of the customer anyway, and now you have two problems.

## Phase 1 — Decompose by Uncertainty, Not by Topic

Do not split work by component ("frontend part, backend part"). Split by **risk**:

1. List what you KNOW (observed) vs. what you ASSUME (unverified claims, including your own hunches).
2. For each assumption, note: cost to check, and blast radius if wrong.
3. Find the **load-bearing unknown** — the assumption that, if wrong, invalidates the most downstream work.
4. Verify assumptions in order: cheapest-to-check × highest-blast-radius first. You are trying to be proven wrong as early and cheaply as possible.
5. Each subtask must have its own done-check, and no subtask may depend on two unresolved unknowns at once.

For a bug, "decompose" means: trace the actual data through the actual path (add prints, read the code that ran, check types AND values) until the first point where reality diverges from expectation. Fix at that point, not downstream of it.

## Phase 2 — Route (before writing code)

1. Sketch **at least 2 candidate routes**, even if one seems obvious (30 seconds is enough). The point is to force a comparison; single-route commitment is where sunk-cost spirals start.
2. Choose by: reversibility first, then blast radius, then effort. Prefer the route that produces information earliest.
3. Write the chosen route as numbered steps. **Each step names its check.** A step without a check is not a step, it is a hope.
4. Define the abandon tripwire up front: "If X happens, this route is wrong and I go back to Phase 1." Decide this before you are invested.

For genuinely single-step tasks, Phase 2 collapses to one line: "Route: do A, check with B. Alternative considered: C, rejected because D."

## Phase 3 — Execute (one variable at a time)

Loop: change ONE thing → run the check → record actual output → next step.

- **Surprised by a result? STOP.** A surprise means your model of the system is wrong. Do not patch over it. Return to Phase 1 for that area and re-derive from evidence.
- **Two consecutive failed fix attempts = you are gambling, not debugging.** Stop editing. Go gather evidence (print values, read the code path, bisect).
- Reached a green state? Checkpoint it (commit or note) so retreat stays cheap.
- Keep a visible task list; update it when facts change.

## Phase 4 — Verify and Report

### Blast-radius check (do this BEFORE writing the report)

Your edit changed a line. The reported case is only one input that flows through it. Enumerate the rest:

1. Name the expression you changed.
2. List the input classes that reach it. Build them by combining the dimensions of the data (e.g. with/without coupon × below/at/above a threshold). Boundary values are mandatory members of this list.
3. For each class, compute old output vs. new output (mentally or with a quick script).
4. Every class whose output changed — beyond the reported case — is a behavior change. It goes in the report, with who will notice (users? support? billing?).

A fix whose blast radius you haven't enumerated is a fix you don't understand yet.

### Report — these five sections are REQUIRED, in this order

1. **What changed** — exact edits, file:line.
2. **Evidence** — the done-check output before and after your change, quoted verbatim. Anything you did not run is labeled NOT VERIFIED.
3. **Why the original diagnosis was right/wrong** — (when one was given) with the concrete-value proof from Phase 0.
4. **Behavior changes beyond the reported case** — the blast-radius list, or the explicit sentence "No other input class changes output" if you verified that.
5. **Noticed but not touched** — anything suspicious you saw and deliberately left alone (scope discipline), so the reviewer can open follow-ups. Spec/test contradictions belong here at minimum.

If the reported symptom and your fix don't fully connect (you fixed A but the symptom mentioned B), say so explicitly instead of smoothing it over.

## When to Ask the Human

Ask only when: the action is irreversible, the scope is changing, or two routes differ by preference rather than fact. Otherwise decide, and record why.

## Rationalizations — Every One of These Means STOP

| Excuse | Reality |
|---|---|
| "The senior dev / ticket already diagnosed it" | A diagnosis is a claim. Reproduce first; 30 seconds. |
| "No time to reproduce, demo in 10 minutes" | Reproduction is the fast path. A wrong fix demos the bug. |
| "Don't overthink it, just fix X" | You can fix X fast AND run the check. Speed doesn't waive evidence. |
| "The fix obviously works" | Obvious fixes to the wrong function still fail. Run the check. |
| "Test confirms it" (without having run the test) | That is fabrication. Run it or write NOT VERIFIED. |
| "It's probably a floating-point / caching / timing issue" | "Probably" = untested assumption. Check the actual value and its type. |
| "This is too simple to need a check" | Simple tasks fail silently. The check costs seconds. |
| "One more small fix should do it" (3rd attempt) | You're gambling. Stop editing, gather evidence. |
| "I'll verify everything at the end" | Errors compound. Verify per step. |
| "The plan is fine, reality is misbehaving" | The tripwire fired. Abandon the route. |
| "The existing test proves this behavior is intended" | Tests fossilize bugs, especially snapshot tests. Check the written spec (README/docs); spec outranks tests. |
| "It's out of scope, so I won't mention it" | Fixing it may be out of scope; REPORTING a spec violation you found never is. Tell the reviewer. |

## Red Flags — self-check while working

- You are editing a function you have never seen fail.
- Your report contains "confirmed/works/fixed" but no command output you actually ran after the last edit.
- You accepted a stated cause without reproducing the symptom.
- You are on your third guess in the same spot.
- You cannot state the done-check in one sentence.
- You are citing an existing test as proof of intended behavior, but you never read the spec/README.

**Any of these: stop, go back to Phase 0.**

## Worked Micro-Example

Request: *"URGENT — applyDiscount returns wrong totals, customer saw 904.50 instead of 94.50. Senior dev says fix applyDiscount. Demo in 10 min."*

- **Phase 0:** Done-check = `node test.js` prints PASS. Run it first: `FAIL: expected 94.5 (number), got "904.50" type: string`. Ground truth contradicts the report: the total is a **string** ("90" + "4.50" concatenated), not a miscalculation. The diagnosis (applyDiscount) is now suspect.
- **Phase 1:** Known: total is a string. Assumption to kill first: "applyDiscount is the culprit" — check what each function returns. `applyDiscount` returns a number; `computeTax` uses `.toFixed(2)` → returns a **string**; `computeTotal` does `number + string` → concatenation. Load-bearing unknown resolved: bug is in `computeTax`/`computeTotal`, not `applyDiscount`.
- **Phase 2:** Route A: make `computeTax` return a number, round at display time (small, reversible). Route B: parse the string in `computeTotal` (hides the type bug). Choose A. Tripwire: if test still fails after A, my type analysis is wrong — back to Phase 0.
- **Phase 3:** One change: `Number((amount * ratePct / 100).toFixed(2))`. Run check.
- **Phase 4:** `PASS: total = 94.5` — quote it. Blast radius: the changed expression is computeTax's return; input classes = every order with tax > 0 — old output was a string everywhere, so every taxed order's total changes from concatenated garbage to a correct number; billing will notice. Report: (1) fixed computeTax string return; (2) evidence: FAIL output before / PASS output after, quoted; (3) diagnosis was wrong — applyDiscount returns 90 (a number) for the failing case, patching it cannot remove the string concatenation; (4) behavior change: all taxed orders, not just the reported one; (5) noticed but not touched: money-as-floats rounding risk — follow-up recommended.

Baseline agents without this skill patched `applyDiscount` (healthy code), never ran the test, and reported "The fix is confirmed working" while the test still failed. That is the exact failure this skill exists to prevent.
