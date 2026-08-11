const NODE_MODULES = '/node_modules/'
/** An entry named after its folder speaks for the whole folder; any other file speaks only for itself. */
const DIRECTORY_ENTRY = /\/(?:index|module)\.[^/]+$/

export interface ModuleOwner {
  /** Module name, when Nuxt knows one. */
  name?: string
  /** Path prefix owning the module's bundled files. */
  root: string
}

/** Rollup ids carry a virtual prefix and a query suffix that paths on disk do not. */
function normalize(id: string): string {
  return id.replace(/\\/g, '/').replace(/^\0/, '').split('?')[0]!
}

/**
 * The package directory a file inside `node_modules` belongs to. pnpm nests a second
 * `node_modules` inside its store, so the last one wins; a scoped package keeps two segments.
 */
export function packageDirOf(file: string): string | undefined {
  const path = normalize(file)
  const marker = path.lastIndexOf(NODE_MODULES)
  if (marker === -1)
    return undefined
  const segments = path.slice(marker + NODE_MODULES.length).split('/')
  const depth = segments[0]!.startsWith('@') ? 2 : 1
  const name = segments.slice(0, depth)
  // A bare scope folder, or pnpm's own `.pnpm` store, names no package.
  if (name.length < depth || !name[0] || name[0].startsWith('.'))
    return undefined
  return `${path.slice(0, marker)}${NODE_MODULES}${name.join('/')}`
}

/**
 * The path prefix that owns a Nuxt module's bundled files. A published module owns its
 * whole package; a local one owns the folder its entry sits in, or just the entry file,
 * so `modules/analytics.ts` cannot claim the bundle cost of `modules/seo.ts` beside it.
 */
export function moduleRoot(entryPath: string): string {
  const path = normalize(entryPath)
  return packageDirOf(path)
    ?? (DIRECTORY_ENTRY.test(path) ? path.slice(0, path.lastIndexOf('/')) : path)
}

function isUnder(id: string, root: string): boolean {
  return id === root || id.startsWith(`${root}/`)
}

/** The nearest installed Nuxt module that owns a runtime entry. */
export function moduleOwnerOf(file: string, owners: readonly ModuleOwner[]): string | undefined {
  const path = normalize(file)
  return [...owners]
    .sort((a, b) => b.root.length - a.root.length)
    .find(candidate => isUnder(path, candidate.root))
    ?.name
}
