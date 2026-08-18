# @harlan-zw/comark-content

Markdown-only Nuxt content powered by [Comark](https://github.com/harlan-zw/comark).

The module parses Markdown at build time and writes compressed server assets. No database runs, and no Markdown is parsed at request time.

## Boundary

The module supports page collections of Markdown files only.

| Supported | Not supported |
| --- | --- |
| Local Markdown, include and exclude globs, collection prefixes | Data collections, YAML, JSON, CSV sources |
| Remote Git repositories with branch, tag, and token auth | Provider APIs and write access |
| Standard Schema frontmatter parsing | Schema library re-exports |
| Query, navigation, surroundings, search sections, sitemap entries | Raw SQL, count, skip, mutation |
| Rangi code highlighting | Shiki, MDC nodes, `@nuxtjs/mdc`, runtime Markdown parsing |

If you configure `database`, the build fails with an explicit error.

## Setup

```bash
pnpm add @harlan-zw/comark-content
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/comark-content'],
})
```

The module uses the `content` configuration key.

## Collections

Declare collections in `content.config.ts` at the root of any layer.

```ts
// content.config.ts
import { defineCollection, defineContentConfig } from '@harlan-zw/comark-content'
import { z } from 'zod'

export default defineContentConfig({
  collections: {
    docs: defineCollection({
      type: 'page',
      source: { include: 'docs/**/*.md', prefix: '/docs' },
      schema: z.object({
        publishedAt: z.string().optional(),
      }),
    }),
  },
})
```

Every layer may declare collections. Each name must be unique across all layers. If two files declare one name, the build fails and names both files.

Local sources resolve against the `content` directory of the layer that declares them. Set `cwd` to read from another directory.

### Remote sources

```ts
defineCollection({
  type: 'page',
  source: {
    include: 'docs/content/**/*.md',
    prefix: '/modules/og-image',
    repository: {
      url: 'https://github.com/nuxt-modules/og-image',
      tag: 'v5.1.14',
      auth: { token: process.env.GITHUB_TOKEN },
    },
  },
})
```

The checkout directory is keyed by repository URL and reference. A `tag` never moves, so its checkout is cloned once and then reused. A `branch`, or no reference, is cloned again on every full build. Local Markdown edits during development never trigger a clone.

If a clone with a token fails, the module retries once without the token. If the retry fails, the build fails. Stale content is never served after a failed refresh.

## Querying

The same functions run in the browser and on the server.

```vue
<script setup lang="ts">
const { data: page } = await useAsyncData('page', () => {
  return queryCollection('docs').path('/docs/getting-started').first()
})

const { data: navigation } = await useAsyncData('navigation', () => {
  return queryCollectionNavigation('docs')
})
</script>
```

Available functions:

- `queryCollection(name)` with `path`, `where`, `select`, `order`, `limit`, `all`, and `first`
- `queryCollectionNavigation(name, fields?)`
- `queryCollectionItemSurroundings(name, path, options?)`
- `queryCollectionSearchSections(name)`

`where` supports the `=`, `LIKE`, `<>`, and `IS NULL` operators.

Import the same functions from `@harlan-zw/comark-content/server` inside Nitro handlers. The server versions take the request event as their first argument.

```ts
// server/api/page.get.ts
import { queryCollection } from '@harlan-zw/comark-content/server'

export default defineEventHandler(async (event) => {
  return queryCollection(event, 'docs').path('/docs').first()
})
```

Only the metadata index is decompressed for a filtered query. Document bodies load one at a time, and only for matched documents.

## Rendering

```vue
<template>
  <ContentRenderer v-if="page" :value="page" />
</template>
```

`ContentRenderer` renders Comark nodes as semantic HTML. It resolves an HTML tag to `ContentProseX`, then `ProseX`. It resolves a custom tag to `ContentX`, `ProseX`, then `X`. Components in `app/components/content` are also available under their unprefixed name. Only tags present in the parsed content are imported.

Set `unwrap="p"` to render slot content without its paragraph wrapper.

The `content:file:beforeParse` and `content:file:afterParse` Nuxt hooks run around each document.

## Highlighting

Code highlighting is on by default and uses [Rangi](https://github.com/harlan-zw/rangi). The bundled theme pair is GitHub Light and GitHub Dark, with an AA contrast comment color. The bundled extra languages are `dotenv`, `env`, `robots`, `robots-txt`, and `robots.txt`.

```ts
export default defineNuxtConfig({
  content: {
    highlight: {
      theme: { light: myLightTheme, dark: myDarkTheme },
      languages: { hcl: myHclGrammar },
    },
  },
})
```

To turn highlighting off, set `highlight: false`. The Rangi stylesheet is then not added to your application.

Import the bundled theme and languages to extend them:

```ts
import { contentRangiLanguages, contentRangiTheme } from '@harlan-zw/comark-content'
```

## AST helpers

Two helpers read parsed Markdown nodes:

```ts
import { nodeToText, walkNodes } from '@harlan-zw/comark-content'

const title = nodeToText(page.body.nodes[0])

walkNodes(page.body.nodes, (node) => {
  if (typeof node !== 'string' && node[0] === 'img')
    images.push(node[1].src)
})
```

## Sitemap

If `@nuxtjs/sitemap` is installed, the module pushes one entry per document into `sitemap:input`. The Nuxt Content v3 sitemap source is excluded, so URLs are never listed twice.

A page is skipped when its frontmatter sets `sitemap: false` or `robots: false`. Frontmatter `sitemap` object fields are merged into the entry. The entry `lastmod` comes from `updatedAt`, or from `publishedAt`.

To keep a whole collection out of the sitemap, set `sitemap: false` on the collection:

```ts
snippets: defineCollection({
  type: 'page',
  source: 'snippets/**/*.md',
  sitemap: false,
})
```

## Deployment

Parsed collections are written as gzip server assets. Navigation, surroundings, and search use content-addressed GET routes. The route key hashes the parsed content only. A redeploy that changes no content keeps the same routes, so clients running the previous build keep working.

Cloudflare presets require `@harlan-zw/nuxt-cloudflare` with Workers Caching enabled. The build fails otherwise.

## License

[MIT](./LICENSE.md)
