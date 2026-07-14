# Persistence

SQLite connection, schema initialization, and repositories live here.

Persistence code owns durable goal, run, step, session, delegation-attempt,
managed-task, frozen-criterion, Judge-review, delivery, and event state. Plain
provider responses are retained only as bounded transcript evidence; runtime
gates read the structured current-state tables.

`managed_task_integrations` is the durable authority for conditional conflict
recovery. It binds one worker/original-candidate pair to its checkpoint,
conflict and allowed files, Integrator delegation, resolved candidate, and
terminal status. Reviews and deliveries carry nullable integration/candidate
foreign identities so a decision for the original Worker result cannot be
reused to authorize resolved content. Startup interrupts nonterminal attempts;
it never silently redispatches them.
