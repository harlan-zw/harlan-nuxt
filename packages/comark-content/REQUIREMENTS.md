# comark-content requirements

Inventory date: 2026-08-14. Scope source: `/home/harlan/sites/SITES.md`.

The fleet has 34 Markdown page collections across eight consumers. `zhead.dev` and `mdream.dev` need no Content replacement. No collection needs a database. Site D1 bindings store application data only.

## Requirement matrix

| Site | Collections and sources | Used API | Renderer and transforms | Database behaviour | Deployment |
| --- | --- | --- | --- | --- | --- |
| `nuxtseo.com` | 16 page collections. Local module docs or GitHub repositories. Markdown only. Include globs, tags, prefixes, and token auth. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `limit`, `all`, `first`. | `ContentRenderer`, `unwrap="p"`, table of contents, relative link transform. | None. | Cloudflare Workers. Separate site, pro, and admin applications. Production and staging. |
| `unlighthouse.dev` | Three page collections. Local glossary and learning content. Local module docs or one GitHub repository. Markdown only. Include and exclude globs. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. Server imports are used. | `ContentRenderer`, table of contents, relative link and hydration transforms. | None. | Cloudflare Worker. |
| `unhead.unjs.io` | Four page collections. Local snippets and learning content. Two GitHub revisions. Markdown only. Include globs. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. | `ContentRenderer`, table of contents, header anchor transform. | None. | Cloudflare Pages. |
| `scripts.nuxt.com` | Five page collections. Three local learning files. Four collections use two GitHub revisions, with a local development override. Markdown only. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`, `queryCollectionSearchSections`. Query methods: `path`, `where`, `select`, `order`, `all`, `first`. | `ContentRenderer`, component alias from `code-group` to `CodeGroup`, table of contents. | None. | Vercel production. Dormant Cloudflare configuration remains. |
| `skilld.dev` | Two local page collections. Markdown only. | `defineContentConfig`, `defineCollection`, `queryCollection`. Query methods: `path`, `first`. | `ContentRenderer`, table of contents. | None. | Cloudflare Worker. |
| `zhead.dev` | No collection, package, or Content API use. | None. | None. | None. | Cloudflare Worker. |
| `request-indexing` | Two local page collections with nine Markdown files. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`. Query methods: `path`, `all`, `first`. | `ContentRenderer`, table of contents. | None. | Cloudflare Worker. |
| `harlanzw.com` | One local page collection with 21 Markdown files. Project data is an application TypeScript module. | `defineContentConfig`, `defineCollection`, `queryCollection`. Query methods: `path`, `where`, `select`, `order`, `limit`, `all`, `first`. Server imports are used. | `ContentRenderer`, renderer classes, table of contents, reading time, node normalization, prose links and described images. | None. | Two Cloudflare Worker configurations. |
| `mdream.dev` | No collection, package, route, or Content API use. | None. | None. | None. | Cloudflare Worker. |
| `gscdump.com` | One local page collection with 18 Markdown files. | `defineContentConfig`, `defineCollection`, `queryCollection`, `queryCollectionNavigation`, `queryCollectionItemSurroundings`. Query methods: `path`, `first`. Server imports are used. | `ContentRenderer`, table of contents depth three, focusability transform. | None. | Cloudflare Durable Object Worker. |

## Shared contracts

| Area | Required | Excluded |
| --- | --- | --- |
| Content configuration | `defineContentConfig`, `defineCollection`, page collections, Standard Schema parsing, declared indexes accepted as metadata | Data collections, schema-library re-exports, runtime configuration mutation, `#build/content/types`, `#content/manifest`, auto-generated compatibility aliases |
| Local sources | Markdown, include and exclude globs, collection prefixes, numeric ordering prefixes, and directory `index` paths | `.navigation.yml`, YAML documents, JSON, CSV, SQL sources, arbitrary filesystem reads outside declared roots |
| Remote sources | GitHub and Git repository URL, branch, tag, token auth, include and exclude globs, prefix, deterministic cache | Provider APIs, write access, stale fallback after refresh failure |
| Query | `path`, `where`, `select`, `order`, `limit`, `all`, `first`; operators `=`, `LIKE`, `<>`, `IS NULL`; server and browser execution | Raw SQL, count, skip, mutation, browser database |
| Derived data | `id`, `path`, `stem`, `extension`, title, description, navigation metadata, table of contents, sitemap entries | Fields unused by the fleet |
| Navigation | Navigation tree, item surroundings, heading search sections, hidden navigation entries | General-purpose navigation customization not present in scoped content |
| Rendering | Direct Comark nodes, semantic HTML, renderer classes, `ContentProseX` and `ProseX` HTML overrides, `ContentX`, `ProseX`, and `LazyContentX` component resolution, aliases, named slots, bound props, `unwrap="p"`, described images, styled links, and code blocks. Shiki loads only configured themes and languages. | MDC nodes, MDC parser, `@nuxtjs/mdc`, runtime Markdown parsing, a general MDC compatibility layer |
| Dependencies | `comark` and `@nuxt/kit` are direct runtime dependencies. Nuxt and Vue are peers. Shiki is an optional peer for configured highlighting. | Runtime utility, glob, Git, database, schema, Markdown, and rendering packages |
| Integrations | Sitemap entries projected from collections at Nitro build time. Nuxt UI prose and content components. `content:file:beforeParse` and `content:file:afterParse` for Nuxt SEO modules. | Nuxt Content compatibility endpoints and database hooks |
| Database | None | D1, SQLite, PostgreSQL, browser WASM, generated SQL endpoint |
| Authoring | Build-time read only | Studio, preview API, live edit, content writes |

## Error cases

Contract tests must cover empty collections, malformed Markdown, schema failures, remote source failures, stale caches, and rejected database configuration. Every source error reports its file or repository, line, and column. Database options return an explicit unsupported feature error because no content database requirement exists.

## Benchmark contract

Use Node 24.17.0 and pnpm 11.2.1. Run ten isolated samples for baseline and candidate. Preserve every sample in raw JSON and compute medians from raw values.

Track cold parse and index time, one-file incremental rebuild time, `nuxt prepare`, production build, SSR render latency, total client JavaScript, Content-related client JavaScript, Nitro server output, and installed dependency size. Size metrics use exact bytes. Timing metrics use milliseconds from a monotonic clock.

The repeatable command is `pnpm --filter @harlan-zw/comark-content bench`. It writes under `packages/comark-content/bench/results`.
