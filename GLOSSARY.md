# Glossary

Canonical vocabulary for this project. Public APIs, docs, routes, and messages use these terms.

## Map

| Term | Export path | Stability | Consumers | Customer word |
| --- | --- | --- | --- | --- |
| Queue Job | `@harlan-zw/nuxt-cf-jobs` | published | Nuxt server code | "job" |
| Query | `@harlan-zw/nuxt-use-query/query` | published | Nuxt app code | "query" |
| Mutation | `@harlan-zw/nuxt-use-query/mutation` | published | Nuxt app code | "mutation" |
| Subscription | `@harlan-zw/nuxt-use-query/subscription` | published | Nuxt app code | "subscription" |
| Schema Group | `@harlan-zw/nuxt-use-query/rpc` | planned | Nuxt app code | "schema group" |
| Server Deadline | `@harlan-zw/nuxt-use-query/query` | planned | Nuxt app code | "server deadline" |
| Domain Event | `@harlan-zw/nuxt-domain-events` | published | Nuxt server code | "domain event" |
| Diagnostic | `@harlan-zw/nuxt-dx` | published | developers and CI | "diagnostic" |
| Wide Event | `@harlan-zw/nuxt-wide-events` | planned | Nuxt server code | "wide event" |
| Field | `@harlan-zw/nuxt-wide-events/server` | planned | Nuxt server code | "field" |
| Wrangler Diagnostic | `@harlan-zw/nuxt-cloudflare` | published | developers and CI | "warning" |
| Collection | `@harlan-zw/comark-content/server` | published | Nuxt server code | "collection" |
| Error Report | `@harlan-zw/nuxt-sentry` | planned | Nuxt app and server code | "error" |
| Report Policy | `@harlan-zw/nuxt-sentry` | planned | developers | "reporting rules" |
| Drop Rule | `@harlan-zw/nuxt-sentry/server` | planned | developers | "filter" |
| Redaction Rule | `@harlan-zw/nuxt-sentry/server` | planned | developers | "redaction" |

Collisions

`Diagnostic` belongs to `nuxt-dx`. `nuxt-cloudflare` always qualifies its findings as `Wrangler Diagnostic`.

`Event` belongs to `Wide Event` and `Domain Event`. Sentry's own word for a captured error is "event", so `nuxt-sentry` never carries that word into its API. It says `Error Report`.

## Terms

### Wide Event

**Is:** one structured log record for one request or operation.
**Use for:** package names, APIs, configuration, docs, and emitted records.
**Never:** canonical log, event log, structured event, log blob.
**Casing:** `Wide Event` in headings, `wide event` in prose, and `wideEvent` in identifiers.

### Field

**Is:** one configured dotted key and primitive value attached to a Wide Event.
**Use for:** configuration, build errors, API parameters, and docs.
**Never:** safe key, attribute, property, tag.
**Casing:** `Field` in headings, `field` in prose, and `field` in identifiers.

### Queue Job

**Is:** a typed unit of work sent through a configured Cloudflare Queue.
**Use for:** `nuxt-cf-jobs` APIs and docs.
**Never:** task, worker job, queue task.
**Casing:** `Queue Job` in headings and `job` when the queue context is clear.

### Query

**Is:** a cacheable read operation managed by `nuxt-use-query`.
**Use for:** query APIs, docs, and telemetry.
**Never:** request, read action.
**Casing:** `Query` in headings and `query` elsewhere.

### Mutation

**Is:** a write operation managed by `nuxt-use-query`.
**Use for:** mutation APIs, docs, and telemetry.
**Never:** command, write action.
**Casing:** `Mutation` in headings and `mutation` elsewhere.

### Subscription

**Is:** a live data operation managed by `nuxt-use-query`.
**Use for:** subscription APIs and docs.
**Never:** stream, watcher.
**Casing:** `Subscription` in headings and `subscription` elsewhere.

### Schema Group

**Is:** one deferred module that exports related RPC schemas.
**Use for:** RPC APIs and docs about deferred schema loading.
**Never:** schema bundle, lazy schemas, schema chunk.
**Casing:** `Schema Group` in headings, `schema group` in prose, and `SchemaGroup` in identifiers.

### Server Deadline

**Is:** the maximum time server rendering waits for one Query.
**Use for:** Query options, docs, and deferred telemetry.
**Never:** SSR timeout, query policy, render budget.
**Casing:** `Server Deadline` in headings, `server deadline` in prose, and `ServerDeadline` in identifiers.

### Domain Event

**Is:** a typed fact emitted by the application domain for listeners.
**Use for:** `nuxt-domain-events` APIs and docs.
**Never:** Wide Event, log event, message.
**Casing:** `Domain Event` in headings and `domain event` elsewhere.

### Diagnostic

**Is:** a development or CI finding produced by `nuxt-dx`.
**Use for:** reports, budgets, and developer messages.
**Never:** issue, alert.
**Casing:** `Diagnostic` in headings and `diagnostic` elsewhere.

### Wrangler Diagnostic

**Is:** one finding that `nuxt-cloudflare` raises against a generated Wrangler config.
**Use for:** doctor output, build errors, and docs.
**Never:** Diagnostic on its own, wrangler warning, lint error.
**Casing:** `Wrangler Diagnostic` in headings and `Wrangler diagnostic` elsewhere.

### Error Report

**Is:** one captured exception sent to the error tracker.
**Use for:** `nuxt-sentry` APIs, configuration, docs, and developer messages.
**Never:** event, Sentry event, issue, exception report.
**Casing:** `Error Report` in headings, `error report` in prose, and `errorReport` in identifiers.

### Report Policy

**Is:** the rules that decide whether an Error Report is sent and what it carries.
**Use for:** `nuxt-sentry` options, docs, and developer messages.
**Never:** filter config, beforeSend config, scrubbing rules, event policy, client error policy, query policy.
**Casing:** `Report Policy` in headings, `report policy` in prose, and `reportPolicy` in identifiers.

### Drop Rule

**Is:** one predicate that stops an Error Report before it is sent.
**Use for:** `nuxt-sentry` options, docs, and developer messages.
**Never:** filter, ignore rule, exclusion.
**Casing:** `Drop Rule` in headings, `drop rule` in prose, and `dropRule` in identifiers.

### Redaction Rule

**Is:** one transform that removes a secret or personal value from an Error Report.
**Use for:** `nuxt-sentry` options, docs, and developer messages.
**Never:** scrub, sanitiser, masker.
**Casing:** `Redaction Rule` in headings, `redaction rule` in prose, and `redactionRule` in identifiers.

### Collection

**Is:** a named set of markdown files that `comark-content` ingests, queries, and serves.
**Use for:** `comark-content` APIs, configuration, and docs.
**Never:** content source, corpus, folder.
**Casing:** `Collection` in headings and `collection` elsewhere.

## Banned

| Never | Use instead | Why |
| --- | --- | --- |
| canonical log | Wide Event | The industry also uses this for unrelated aggregation patterns. |
| event log | Wide Event or Domain Event | It collapses two distinct concepts. |
| Sentry event | Error Report | `Event` already names two other concepts here. |
| scrub, sanitise, mask | Redaction Rule | Three words for one transform. |
| powerful, seamless, robust | (cut) | These words do not describe behaviour. |

## Open questions

Naming calls this file does not settle. Resolve one, fold the answer in, then delete it.

1. **Should the existing packages receive a full vocabulary audit?**
   This bootstrap records frozen package concepts and the new logging vocabulary only.
   - Audit all public exports and docs now, which expands this package task.
   - Audit each package when its public API next changes.
