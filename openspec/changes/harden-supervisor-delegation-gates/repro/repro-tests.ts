
// ---------------------------------------------------------------------------
// REPRO SECTION (temporary, not for commit): desired-behavior tests for the
// three high-severity supervisor delegation hardening items. Each test
// asserts the behavior the fix spec requires; failures on current master
// are the reproduction evidence.
// ---------------------------------------------------------------------------

test("REPRO-H4: a validated spec result requires a Supervisor review gate before review-merge", async () => {
  const fixture = createManagerFixture("repro semantic spec review gate");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 2, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "Only slice." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id).some((event) =>
    event.data.runtimeEventType === "change.spec_approved" ||
    event.data.runtimeEventType === "change.spec_review_requested"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(
    events.some((event) => event.data.runtimeEventType === "change.spec_review_requested"),
    "backend must request a Supervisor semantic review after a structurally valid spec result",
  );
  assert.ok(
    events.some((event) =>
      event.data.runtimeEventType === "delegation.rejected" &&
      /approv/i.test(String(event.data.safeReason))),
    "review-merge without a Supervisor spec approval must be rejected",
  );
  fixture.db.close();
});

test("REPRO-H5: spec retry-budget exhaustion blocks the change but keeps the goal alive", async () => {
  const fixture = createManagerFixture("repro spec budget goal survival");
  const openSpec = recordingOpenSpecService("cli", {
    validateFailures: [
      ["Requirement R1 has no WHEN/THEN scenario."],
      ["Requirement R1 has no WHEN/THEN scenario."],
    ],
  });
  const gates = [0, 1].map(() => {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    return { promise, release };
  });
  let sendCount = 0;
  let supervisorStarted = false;
  const adapter: AgentRuntimeAdapter = {
    providerId: "codex-local",
    async detectCapabilities() {
      return { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true };
    },
    async startSession(input) {
      if (input.parent?.sessionId) {
        return createHandle(input.sessionId, [
          { type: "session.completed", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
            message: "Spec worker completed.", occurredAt: "2026-07-17T00:00:02.000Z" },
        ]);
      }
      if (supervisorStarted) return createHandle(input.sessionId, []);
      supervisorStarted = true;
      const specDelegation = (at: string): AgentRuntimeEvent => ({
        type: "progress", sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
        message: "Delegating spec authoring.", occurredAt: at,
        metadata: { delegationControlEvent: {
          type: "managed_delegation.request", role: "worker", taskId: "spec:change-one",
          prompt: "Author change-one specs.", summary: "Author change-one specs.",
        } },
      });
      return {
        ...createHandle(input.sessionId, []),
        capabilities: { eventStreaming: true, approval: false, cancellation: true, resume: true, childSessions: true },
        async *events() {
          yield {
            ...changePlanEvent([{ id: "change-one", title: "Change one", rationale: "Only slice." }]),
            sessionId: input.sessionId, goalId: input.goalId, runId: input.runId,
          } satisfies AgentRuntimeEvent;
          yield specDelegation("2026-07-17T00:00:01.000Z");
          await gates[0]!.promise;
          yield specDelegation("2026-07-17T00:00:03.000Z");
          await gates[1]!.promise;
          yield specDelegation("2026-07-17T00:00:05.000Z");
        },
        async send() {
          gates[sendCount++]?.release();
        },
      };
    },
  };
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => fixture.eventRepo.listForGoal(fixture.goal.id)
    .some((event) => event.data.runtimeEventType === "change.blocked"));

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(events.some((event) =>
    event.data.runtimeEventType === "change.blocked" && event.data.changeId === "change-one"));
  assert.ok(
    !events.some((event) => event.type === "goal.blocked"),
    "one change spec-budget exhaustion must not terminally block the whole goal",
  );
  assert.equal(
    fixture.goalRepo.getById(fixture.goal.id)?.status,
    "running",
    "the goal must stay alive so the Supervisor can reassess and re-plan the blocked scope",
  );
  fixture.db.close();
});

test("REPRO-H6: reworded but semantically identical repeated gaps must still trip the circuit breaker", async () => {
  const fixture = createManagerFixture("repro reworded gaps goal");
  const openSpec = recordingOpenSpecService("cli");
  const adapter = scriptedEpochAdapter(fixture, 4, (_input, tools) =>
    runScript(
      (function* () {
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-one", title: "Change one", rationale: "First batch." }],
          },
          "2026-07-13T00:00:01.000Z",
        );
        yield* specFlow(tools, "change-one", 0, (offset) => `2026-07-13T00:00:0${2 + offset}.000Z`);
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-one archived."],
            remainingGaps: ["End-to-end verification is missing."],
            nextEpochRationale: "Close the verification gap.",
          },
          "2026-07-13T00:00:04.000Z",
        );
        yield tools.controlEvent(
          {
            type: "managed_change.plan",
            changes: [{ id: "change-two", title: "Retry", rationale: "Close the gap again." }],
          },
          "2026-07-13T00:00:05.000Z",
        );
        yield* specFlow(tools, "change-two", 2, (offset) => `2026-07-13T00:00:0${6 + offset}.000Z`);
        // Same gap, reworded: a prose-equality signature is trivially bypassed
        // by any LLM's natural paraphrasing.
        yield tools.controlEvent(
          {
            type: "managed_goal.reassessment",
            goalSatisfied: false,
            evidence: ["change-two archived."],
            remainingGaps: ["There is still no end-to-end verification coverage."],
            nextEpochRationale: "Try once more.",
          },
          "2026-07-13T00:00:08.000Z",
        );
      })(),
    ),
  );
  const manager = createAgentSessionManager({
    ...fixture,
    openSpecWorkspaceService: openSpec.service,
    supervisorCwd: "C:\\goal-workspace",
  });

  await manager.startManagedSession({
    goalId: fixture.goal.id, providerId: "codex-local", modelLabel: "gpt-5-codex", adapter,
  });
  await waitFor(() => {
    const events = fixture.eventRepo.listForGoal(fixture.goal.id);
    return (
      events.some((event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker") ||
      events.filter((event) => event.data.runtimeEventType === "supervisor.reassessment").length === 2
    );
  });

  const events = fixture.eventRepo.listForGoal(fixture.goal.id);
  assert.ok(
    events.some((event) => event.data.runtimeEventType === "supervisor.reassessment_circuit_breaker"),
    "a non-converging macro loop must trip the breaker even when the gaps are reworded",
  );
  assert.equal(fixture.goalRepo.getById(fixture.goal.id)?.status, "blocked");
  fixture.db.close();
});
