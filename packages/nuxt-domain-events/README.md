# `@nuxtseo/event-listeners`

Functional, layer-aware Nuxt server events with generated lazy registries.

Listeners run like Laravel listeners. Omitting `execution` means serial synchronous execution with propagated failure. That failure aborts the producer and prevents deferred work or queue publication. `sync` isolation, `deferred`, and `queued` are explicit alternatives.

`local` event contracts may carry request-scoped or mutable state. They support synchronous listeners and same-isolate deferred `waitUntil` listeners, but never queued delivery. `transfer` contracts own a versioned JSON codec and byte limit. Queued delivery parses that contract before importing or invoking the selected listener.

Runtime errors are tagged `Error` values and reject dispatch. Expected tags include unknown event, payload mismatch, lazy import failure, registry drift, queue failure, and after-commit misuse. Observer defects run the configured fallback, or `console.error`, without changing or relabelling the business outcome.

Queued listeners require explicit idempotency and a caller-provided stable `eventId`. The generated delivery ID is stable from `eventId + listenerName`. Producer dispatch never imports a queued listener implementation.

After-commit flow uses `planEvent`, then `commitEventPlan`. In v1, every listener for that event must be queued with `publication: 'after-commit'`. D1 batch is non-interactive, so it cannot run ordinary listeners after domain SQL while still allowing their failure to roll back that SQL. Split the event contract when one producer needs both ordinary and after-commit listeners. The caller-supplied unit of work stages the adapter's unpublished D1 statements beside domain writes. It returns `rolled-back` with zero queue evidence, or the adapter's exact staged-delivery receipt only after D1 resolves. A failed send remains an unpublished durable row for recovery.

The `./cf-jobs` adapter accepts the public `nuxt-cf-jobs/outbox` functions structurally. This keeps the event core runtime-neutral and the dependency one-way. Its generic delivery definition declares the static `maintenance` queue for `nuxt-cf-jobs` registry locality; the public outbox route override intentionally stores each listener job on the queue declared by that listener. Pro also supplies `cfJobs.reconcile.terminalFailureContext`, so an exhausted stale claim invokes the same listener `failed` callback after D1 terminal evidence is committed.

Deferred in v1: mixed ordinary and after-commit listeners on one transaction-bound event, producer-time Laravel `shouldQueue`, cooperative listener timeouts, listener ordering contracts, grouped subscriber modules, dashboards, CLI, and compatibility shims. Queued listeners cannot declare `shouldHandle`; synchronous and deferred listeners may use it as an in-process condition. Queued listeners may declare a functional `failed(payload, context, error)` callback, invoked after terminal settlement.
