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

`comark-content` supports only the Markdown inventory in `REQUIREMENTS.md`. It has no data collection, YAML, JSON, MDC compatibility, Studio, preview, browser SQLite, SQL endpoint, CSV source, write API, or general Nuxt Content compatibility. It invokes the two build-time Content file hooks required by the installed SEO modules.

Runtime dependencies are limited to Comark, Rangi, and Nuxt package APIs. Remote Git and source matching use Node platform facilities. Vue and Nuxt are peers.

Comark produces the canonical body. `body.nodes` contains the node list. `body.meta.toc` contains the table of contents. Site transforms consume those structures directly.

Collections store only the Comark AST. Raw Markdown exists only while ingestion and file hooks run. The module discards it before writing generated assets. Consumers that need text derive it from the AST.

The build emits a compact metadata index per collection and one compressed AST asset per document. Queries filter metadata first, then hydrate only matched documents. Navigation, surroundings, sitemap, and search use generated projections and never decode document ASTs. Browser queries use constrained Nitro endpoints. The browser never receives the parser or a complete AST collection.

Navigation, surroundings, and search endpoints include a SHA-256 content revision in their path. The revision covers the Nuxt build ID and every projected content document, excluding local source paths. Their browser and Cloudflare cache policies are immutable for one year. A production deployment registers only its current revision, so stale URLs return 404 instead of new data. Cloudflare presets require `@harlan-zw/nuxt-cloudflare` with Workers Caching enabled. Other presets keep normal HTTP immutable caching. Development uses a stable route with `no-store`.

The AST also defines the renderer component boundary. The build emits static imports only for tags present in collected nodes. HTML tags prefer site prose overrides. Custom tags prefer site content components, then Nuxt UI prose components, then plain components. The renderer never scans or resolves unused components at runtime.

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
