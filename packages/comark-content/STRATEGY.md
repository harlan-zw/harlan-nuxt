# comark-content strategy

## Decision

Build a private, fleet-specific Nuxt module. It replaces only the Nuxt Content behaviour used by repositories in `/home/harlan/sites/SITES.md`.

The implementation has five slices:

1. Ingest local Markdown at build time.
2. Generate typed collections and a constrained query service.
3. Render Comark nodes with Vue and preserve site component overrides.
4. Generate navigation, surroundings, search sections, and table of contents.
5. Fetch declared Git repositories into an isolated cache.

No database adapter is in scope. Every inventoried Markdown source is read-only and changes only during builds. Existing D1 use persists Nuxt Content's generated index. It is not a site requirement.

## Boundary

`comark-content` supports only the Markdown inventory in `REQUIREMENTS.md`. It has no data collection, YAML, JSON, MDC compatibility, Studio, preview, browser SQLite, SQL endpoint, CSV source, write API, Content hook, or general Nuxt Content compatibility.

Runtime dependencies are limited to Comark and Nuxt package APIs. Remote Git and source matching use Node platform facilities. Vue and Nuxt are peers.

Comark produces the canonical body. `body.nodes` contains the node list. `body.meta.toc` contains the table of contents. Site transforms consume those structures directly.

The build emits one server asset per collection. Server queries load assets lazily. Browser queries use a structured Nitro endpoint. The browser never receives the parser or complete index unless a query requests it.

## Success

The Harlanzw site is the canary because it is the smallest clean consumer that covers Markdown, schema defaults, server queries, SSR rendering, ordered queries, D1 removal, and Cloudflare deployment. Its JSON project data moves to an application TypeScript module before the Content migration.

Release requires all conditions:

1. Median cold parse and index time is at most 50 percent of baseline.
2. Content-related generated client JavaScript shrinks by at least 30 percent.
3. No tracked median or size metric regresses by more than 10 percent.
4. Every scoped site passes typecheck, tests, production build, and browser smoke tests.

If the canary misses either primary gate, stop. Write `bench/results/NO_GO.md` with measured bottlenecks. Do not add compatibility or publish the package.

## Failure contract

Boundary errors include the source repository or file, line, and column. Expected source and schema failures use tagged values internally. Infrastructure failures propagate with their cause. Caches record a versioned input digest and never substitute stale data after a failed refresh.
