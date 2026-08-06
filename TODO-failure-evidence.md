# nuxt-cf-jobs: stop destroying failure evidence

> Status: implemented 2026-07-26. Release and DLQ evidence is a bounded eight-entry JSON log. Stale terminalization carries the latest context and returns exact job identities for batch settlement. Reconcile gives Cloudflare redelivery a configurable grace period. Obsolete DLQ traffic has its own log stage. Active downstream consumers were audited: gscdump accepts arbitrary stages, skilld has no custom classifier, and nuxtseo maps obsolete DLQ traffic to record disposition.

Proposal for three upstream changes in `~/pkg/nuxt-cf-jobs`, motivated by the 2026-07-21 assessment stale-reservation investigation (triage-ledger row of that date). Root-causing took a multi-hour DB bisection because the runtime discards or mislabels the evidence at every failure boundary. Each change below would have made it a five-minute read.

A copy of this spec lives at `~/pkg/nuxt-cf-jobs/TODO-failure-evidence.md` so it travels with the package. The implementation landed with the package's runtime and outbox refactor.

## 1. Terminalization must carry the row's last known context

`failStaleReservedDurableJobs` (outbox.ts) stamps every terminalized job with the caller's static string ("stale-reservation: exhausted retries"). The row it is deleting often HAS evidence: `retry_reasons` (clean releases record the handler error there) and `last_error`. Compose the exception instead:

```
stale-reservation: exhausted retries (attempts=4, reserved 923s ago; last release: <retry_reasons tail or "none — attempts died without a release, suspect isolate kill">)
```

The absence of any `retry_reasons` is itself the highest-value signal — it distinguishes hard isolate death (exceededMemory/eviction) from handler throws. Today that distinction requires knowing the internals; the exception string should state it.

## 2. The DLQ-settle path silently drops the only copy of the message-side failure

`consumeQueueBatch`'s DLQ branch (runtime.ts) does `claimJob(jobId)` → `failJob(...)`. When the durable row is still freshly reserved (its holder died <reclaimAfterSeconds ago — the COMMON case for isolate-death storms), `claimJob` returns null and the branch acks the message having recorded NOTHING. The row is later terminalized by change-1's generic path.

Fix: when the claim misses, still record the DLQ arrival on the row without taking ownership — e.g. a repository method `noteDlqArrival(jobId, note)` appending `dlq@<ts>` to `retry_reasons` (bounded, keep the last N entries). Terminalization then shows the message exhausted CF retries while the reservation was held — direct evidence of a dead holder.

## 3. Reconcile redispatch churn manufactures phantom DLQ noise

Observed: 435 `stage: 'dlq'` log events for 212 distinct jobs in 26h, against 43 real `failed_jobs` rows. Mechanism: after an isolate death, BOTH the original CF message (redelivered by CF) and a reconcile-dispatched duplicate are live for one job; the loser cycles in-flight claim-miss retries (60s) until its CF `max_retries` exhausts and it lands on the DLQ queue — where it is logged as if a job died, even though the durable row often completes fine via the winner.

Two-part fix:

- In the DLQ branch, look up the row state BEFORE logging: row absent or `completed_at` set → log `stage: 'dlq-obsolete'` (churn debris; consumers can map it to debug-level) instead of `stage: 'dlq'`. Only a row that is genuinely dead-ended keeps the alert-worthy stage.
- In `recoverDurableJobs`, don't redispatch a ready row whose release happened within the CF redelivery horizon (the original message is still coming back on its own). A simple `releasedAt > now - redeliveryGraceSeconds` skip removes most duplicate pairs at the source.

Downstream, `classifyCfJobLog` (layers/saas/server/utils/cf-jobs-log-classify.ts in nuxtseo.com) maps `dlq-obsolete` to `cf_jobs.dlq_obsolete`; the logging catalog gives that event record disposition.

## Non-goals

- Heartbeats/stage checkpoints from inside handlers: real fix for attribution but requires handler cooperation; not needed once 1–3 land (the release-absence signal covers the isolate-death case).
- Changing reclaim/stale windows: 900s is correct for this workload; the crawl-slice postmortem already tuned it.
