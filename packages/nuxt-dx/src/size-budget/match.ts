const EXTENSION = /\.(?:m|c)?[jt]sx?$|\.vue$/

/** Plugin paths come from config without a guaranteed extension; rollup ids carry one plus a query. */
export function normalizeForMatch(id: string): string {
  return id
    .replace(/\\/g, '/')
    .replace(/^\0/, '')
    .split('?')[0]!
    .replace(EXTENSION, '')
}

export function matchTargetId(path: string, moduleIds: Iterable<string>): string | undefined {
  const wanted = normalizeForMatch(path)
  for (const id of moduleIds) {
    if (normalizeForMatch(id) === wanted)
      return id
  }
  return undefined
}
