# Comark Content

[![npm version][npm-version-src]][npm-version-href]
[![npm downloads][npm-downloads-src]][npm-downloads-href]
[![License][license-src]][license-href]
[![Nuxt][nuxt-src]][nuxt-href]

> Serve Markdown page collections in Nuxt with no database, parsed at build time by [Comark](https://github.com/harlan-zw/comark).

## Why Comark Content?

Markdown pages change only during builds. A content layer that stores them in a database still makes you deploy and query one. You may see:

- 🗄️ **A database for read-only pages**: The content index lives in SQLite or D1, although nothing writes to it after the build.
- 📥 **Docs copied between repositories**: Docs that live in another Git repository get copied in by hand before you can publish them.
- 🧟 **Stale content after a failed refresh**: A remote fetch fails, and the site keeps serving the old pages without a word.

Comark Content parses Markdown with Comark during the build and writes it as compressed server assets. No database runs, and no request parses Markdown.

## Features

- 📄 **Build-time Markdown**: Requests never wait on a Markdown parse, because the build parses each page collection once.
- 🌍 **Local and remote sources**: You publish docs from another Git repository, pinned to a branch or tag, without copying files in.
- 🔎 **One query API**: You write a query once and run it in the browser or inside Nitro.
- 🗜️ **Lazy decompression**: A filtered query stays cheap, because it decompresses only the metadata index and the matched bodies.
- 🎨 **Rangi highlighting**: Code blocks get GitHub Light and Dark themes with no setup, and you can add your own grammars and themes.
- 🗺️ **Sitemap aware**: Your pages reach `@nuxtjs/sitemap` with no hand-written URL source.

## Installation

```bash
npx nuxi@latest module add @harlan-zw/comark-content
```

> [!TIP]
> Generate an Agent Skill for this package using [skilld](https://github.com/harlan-zw/skilld):
> ```bash
> npx skilld add @harlan-zw/comark-content
> ```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@harlan-zw/comark-content'],
})
```

The module reads the `content` configuration key.

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

Any layer can declare collections. Each name must be unique across all layers. If two files declare one name, the build fails and names both files.

Local sources resolve against the `content` directory of the layer that declares them. To read from another directory, set `cwd`.

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

The module keys each checkout by repository URL and reference. A `tag` never moves, so the module clones it once and reuses it. A `branch`, or no reference, clones again on every full build. Local Markdown edits during development never trigger a clone.

If a clone with a token fails, the module retries once without the token. If the retry fails, the build fails. The module never serves stale content after a failed refresh.

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

Inside Nitro handlers, import the same functions from `@harlan-zw/comark-content/server`. The server versions take the request event as their first argument.

```ts
// server/api/page.get.ts
import { queryCollection } from '@harlan-zw/comark-content/server'

export default defineEventHandler(async (event) => {
  return queryCollection(event, 'docs').path('/docs').first()
})
```

A filtered query decompresses only the metadata index. It then loads document bodies one at a time, and only for matched documents.

## Rendering

```vue
<template>
  <ContentRenderer v-if="page" :value="page" />
</template>
```

`ContentRenderer` renders Comark nodes as semantic HTML. It resolves an HTML tag to `ContentProseX`, then `ProseX`. It resolves a custom tag to `ContentX`, `ProseX`, then `X`. Components in `app/components/content` are also available under their unprefixed name. It imports only the tags present in the parsed content.

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

To turn highlighting off, set `highlight: false`. The module then leaves the Rangi stylesheet out of your application.

To extend the bundled theme and languages, import them:

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

`@nuxtjs/sitemap` 8.4.0 or later owns this integration. It reads collections through `queryCollectionManifest()` and lists them under its own data source, `@harlan-zw/comark-content:urls`. The build rejects an older `@nuxtjs/sitemap`. This module used to add the URLs itself, so the pair would list every page twice.

Frontmatter `sitemap: false` or `robots: false` keeps a page out of the sitemap. Fields in a frontmatter `sitemap` object merge into the entry. The entry `lastmod` comes from `seo.articleModifiedTime`, or from `updatedAt`.

To keep a whole collection out of the sitemap, set `sitemap: false` on the collection:

```ts
snippets: defineCollection({
  type: 'page',
  source: 'snippets/**/*.md',
  sitemap: false,
})
```

## Deployment

The build writes parsed collections as gzip server assets. Navigation, surroundings, and search use content-addressed GET routes. The route key hashes only the parsed content. So a redeploy with no content change keeps the same routes, and clients on the previous build keep working.

If you build with a Cloudflare preset, add `@harlan-zw/nuxt-cloudflare` with Workers Caching enabled. Without it, the build fails.

## Sponsors

<p align="center">
  <a href="https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg">
    <img src='https://raw.githubusercontent.com/harlan-zw/static/main/sponsors.svg' alt='sponsors'/>
  </a>
</p>

## License

Licensed under the [MIT license](https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/comark-content/LICENSE.md).

<!-- Badges -->
[npm-version-src]: https://img.shields.io/npm/v/%40harlan-zw%2Fcomark-content/latest.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-version-href]: https://npmjs.com/package/@harlan-zw/comark-content

[npm-downloads-src]: https://img.shields.io/npm/dm/%40harlan-zw%2Fcomark-content.svg?style=flat&colorA=18181B&colorB=28CF8D
[npm-downloads-href]: https://npmjs.com/package/@harlan-zw/comark-content

[license-src]: https://img.shields.io/github/license/harlan-zw/harlan-nuxt.svg?style=flat&colorA=18181B&colorB=28CF8D
[license-href]: https://github.com/harlan-zw/harlan-nuxt/blob/main/packages/comark-content/LICENSE.md

[nuxt-src]: https://img.shields.io/badge/Nuxt-18181B?logo=nuxt
[nuxt-href]: https://nuxt.com
