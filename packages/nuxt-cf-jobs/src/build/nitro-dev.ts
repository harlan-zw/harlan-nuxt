import type { Nuxt } from '@nuxt/schema'
import { fileURLToPath } from 'node:url'

const WINDOWS_SLASH_RE = /\\/g
const FILE_URL_PREFIX_RE = /^file:\/*/

type NitroExternalInlineEntry = string | RegExp | ((id: string, importer?: string) => boolean | Promise<boolean>)

/**
 * Force one generated buildDir template into Nitro's bundle during dev.
 *
 * Nitro externalizes buildDir modules in dev, so Node's own ESM loader reads
 * them. A generated template that re-exports application source by absolute
 * path then fails on that source's TypeScript syntax, path aliases, or
 * extensionless relative imports, and the whole server errors. Inlining hands
 * the file to Rollup instead, which resolves those imports normally.
 */
export function inlineTemplateInNitroDev(nuxt: Nuxt, templatePath: string): void {
  if (!nuxt.options.dev)
    return

  const nitro = ((nuxt.options as { nitro?: { externals?: { inline?: NitroExternalInlineEntry | NitroExternalInlineEntry[] } } }).nitro ??= {})
  nitro.externals ??= {}

  const inline = nitro.externals.inline
  const normalized = normalizeImportId(templatePath)
  const matchTemplate = (id: string) => normalizeImportId(id) === normalized

  nitro.externals.inline = [
    ...(Array.isArray(inline) ? inline : inline ? [inline] : []),
    matchTemplate,
  ]
}

function normalizeImportId(id: string): string {
  if (id.startsWith('file://')) {
    try {
      return fileURLToPath(id).replace(WINDOWS_SLASH_RE, '/')
    }
    catch {
      // A malformed file:// URL still has to match by path, so fall back to a
      // textual strip rather than dropping the id.
      return id.replace(FILE_URL_PREFIX_RE, '/').replace(WINDOWS_SLASH_RE, '/')
    }
  }

  return id.replace(WINDOWS_SLASH_RE, '/')
}
