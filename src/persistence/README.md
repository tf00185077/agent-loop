# Persistence

SQLite connection, schema initialization, and repositories live here.

Persistence code owns durable goal, run, step, session, delegation-attempt,
managed-task, frozen-criterion, Judge-review, delivery, and event state. Plain
provider responses are retained only as bounded transcript evidence; runtime
gates read the structured current-state tables.
