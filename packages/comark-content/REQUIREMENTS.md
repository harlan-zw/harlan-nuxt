# comark-content requirements

Inventory date: 2026-08-13. Scope source: `/home/harlan/sites/SITES.md`.

## Requirement matrix

| Site | Collections and sources | Used API | Renderer and transforms | Database behaviour | Deployment |
| --- | --- | --- | --- | --- | --- |
| `nuxtseo.com` | 18 page collections. Local module docs or GitHub repositories. Markdown only. Include globs, tags, prefixes, and token auth. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`, `#build/content/types`. Query methods: `path`, `where`, `select`, `order`, `limit`, `all`, `first`. | `ContentRenderer`, `unwrap="p"`, table of contents, relative link transform. | D1 index copied by production and staging workflows. No content writes. | Cloudflare Workers. Separate site, pro, and admin applications. Production and staging. |
| `unlighthouse.dev` | Three page collections. Local glossary and learning content. Local module docs or one GitHub repository. Markdown only. Include and exclude globs. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. Server imports are used. | `ContentRenderer`, table of contents, relative link and hydration transforms. | D1 binding stores the generated index. No content writes. | Cloudflare Worker. |
| `unhead.unjs.io` | Four page collections. Local snippets and learning content. Two GitHub revisions. Markdown is retained. YAML content moves to Markdown or application data. Include globs. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. | `ContentRenderer`, table of contents, header anchor transform. | D1 index copied by a deployment workflow. No content writes. | Cloudflare Pages. |
| `scripts.nuxt.com` | Five page collections. Local learning content. Two GitHub revisions with a local development override. Markdown only. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. | `ContentRenderer`, component alias from `code-group` to `CodeGroup`, table of contents. | No declared database requirement. A custom route guards Nuxt Content's SQL endpoint. | Vercel production. Dormant Cloudflare configuration remains. |
| `skilld.dev` | Two local page collections. Markdown only. | `defineContentConfig`, `defineCollection`, package-provided `z`, `queryCollection`, navigation, surroundings, and search sections. Query methods: `path`, `where`, `order`, `all`, `first`. | `ContentRenderer`, table of contents. | D1 schema contains generated Content tables. No content writes. | Cloudflare Worker. |
| `zhead.dev` | No collection or Content API use. | None. Direct package dependency only. | None. | None. | Cloudflare Worker. |
| `request-indexing` | Two local page collections. Markdown only. | `defineContentConfig`, `defineCollection`, `queryCollection`, navigation, surroundings, and search sections. Query methods: `path`, `where`, `order`, `all`, `first`. | `ContentRenderer`, table of contents. | No declared database requirement. | Cloudflare Worker. |
| `harlanzw.com` | One local Markdown page collection. The JSON project collection moves to an application TypeScript module. | `defineContentConfig`, `defineCollection`, `queryCollection`. Query methods: `path`, `where`, `select`, `order`, `limit`, `all`, `first`. Server imports are used. | `ContentRenderer`, table of contents, reading time, node normalization. | D1 binding stores the generated index. No content writes. | Two Cloudflare Worker configurations. |
| `mdream.dev` | No collection or Content API use. | None. Transitive lockfile entries only. | None. | None. | Cloudflare Worker. |
| `gscdump.com` | One local page collection. Markdown only. | `defineContentConfig`, `defineCollection`, `queryCollection`, navigation, surroundings, search sections, server imports, `#content/manifest`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. | `ContentRenderer`, table of contents depth three, focusability transform. | D1 index copied by deployment tooling. Manifest checks report index health. No content writes. | Cloudflare Durable Object Worker. |

## Shared contracts

| Area | Required | Excluded |
| --- | --- | --- |
| Content configuration | `defineContentConfig`, `defineCollection`, page collections, Standard Schema parsing, declared indexes accepted as metadata | Data collections, runtime configuration mutation, auto-generated compatibility aliases |
| Local sources | Markdown, include and exclude globs, collection prefixes, numeric ordering prefixes, directory `index` paths, Markdown directory metadata | YAML, JSON, CSV, SQL sources, arbitrary filesystem reads outside declared roots |
| Remote sources | GitHub and Git repository URL, branch, tag, token auth, include and exclude globs, prefix, deterministic cache | Provider APIs, write access, stale fallback after refresh failure |
| Query | `path`, `where`, `select`, `order`, `limit`, `all`, `first`; operators `=`, `LIKE`, `<>`, `IS NULL`; server and browser execution | Raw SQL, count, skip, mutation, browser database |
| Derived data | `id`, `path`, `stem`, `extension`, title, description, navigation metadata, table of contents | Fields unused by the fleet |
| Navigation | Navigation tree, item surroundings, heading search sections, hidden navigation entries | General-purpose navigation customization not present in scoped content |
| Rendering | Direct Comark nodes, semantic HTML, Vue component resolution, component aliases, `unwrap="p"`, code blocks, source-aware errors | MDC nodes, MDC parser, `@nuxtjs/mdc`, runtime Markdown parsing |
| Dependencies | Comark and Nuxt package APIs. Nuxt and Vue are peers. | Runtime utility, glob, Git, database, schema, Markdown, and rendering packages |
| Hooks | None | All Nuxt Content hooks |
| Database | None | D1, SQLite, PostgreSQL, browser WASM, generated SQL endpoint |
| Authoring | Build-time read only | Studio, preview API, live edit, content writes |

## Error cases

Contract tests must cover empty collections, malformed Markdown, schema failures, remote source failures, stale caches, and database requests. Every source error reports its file or repository, line, and column. A database request returns an explicit unsupported feature error because no database requirement exists.

## Benchmark contract

Use Node 24.17.0 and pnpm 11.2.1. Run ten isolated samples for baseline and candidate. Preserve every sample in raw JSON and compute medians from raw values.

Track cold parse and index time, one-file incremental rebuild time, `nuxt prepare`, production build, SSR render latency, total client JavaScript, Content-related client JavaScript, Nitro server output, and installed dependency size. Size metrics use exact bytes. Timing metrics use milliseconds from a monotonic clock.

The repeatable command is `pnpm --filter @harlan-zw/comark-content bench`. It writes under `packages/comark-content/bench/results`.
