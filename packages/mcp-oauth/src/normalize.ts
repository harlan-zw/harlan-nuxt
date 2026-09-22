/**
 * Normalisation, which is where both of this package's real defects lived.
 *
 * A rule that compares an attacker-supplied string against a known value is
 * only as good as the normalisation in front of it. Two separate bugs came
 * from skipping it: a path compared with `===` classified `/mcp/` as "not the
 * protected resource" while the downstream router served it as one, and a
 * brand name compared with `\s*` between the words let `Acme-Cloud` through.
 * Both are the same mistake, so both normalisers live here.
 */

/**
 * Collapse a request path to the form a router will route on.
 *
 * Deliberately AGGRESSIVE. Over-classifying a path as a protocol endpoint
 * costs a bearer check on a request that then 404s. Under-classifying skips
 * the bearer check on a request the router still delivers, which is an
 * authentication bypass. Those outcomes are not symmetric, so every variant a
 * router might fold onto an endpoint must fold here too:
 *
 *   /mcp/  //mcp  /./mcp  /a/../mcp  /mcp%2F  /mcp;x
 *
 * Percent-decoding runs first, because `%2F` is a slash to some routers and a
 * literal to others, and the safe reading is the one that matches.
 */
export function normalizeMcpPath(path: string): string {
  // Query and fragment go FIRST, before decoding, so a percent-encoded `?`
  // inside a real path segment cannot truncate the path. `event.path` in h3
  // and a raw request target both carry the query string, so an adopter who
  // passes either one straight in would otherwise have `/mcp?x=1` classify as
  // Ignore: the same bypass class this normaliser exists to close.
  const withoutQuery = path.split(/[?#]/)[0] ?? ''
  let decoded = withoutQuery
  try {
    decoded = decodeURIComponent(withoutQuery)
  }
  catch {
    // A malformed escape is not a reason to skip normalisation; the rest of
    // the pipeline still has to run against something. The raw path is the
    // honest fallback and it cannot match an endpoint by accident.
  }
  // A NUL or control character never appears in a legitimate path and is a
  // classic truncation trick against whatever parses the value next.
  // Control characters are STRIPPED rather than treated as terminators. No JS
  // router truncates on NUL, so `/mcp%00x` normalises to `/mcpx` and is
  // correctly not the endpoint. A runtime that did truncate would serve `/mcp`,
  // and this module's own asymmetry doctrine would then want the truncating
  // reading; the choice is recorded here rather than left implicit.
  // eslint-disable-next-line no-control-regex
  const cleaned = decoded.replaceAll(/[\0-\x1F\x7F]/g, '')
  const segments: string[] = []
  // A backslash is a segment separator to WHATWG `new URL()` for special
  // schemes, so a caller passing a raw request target must fold it here to
  // agree with a caller passing `new URL(req.url).pathname`.
  for (const segment of cleaned.replaceAll('\\', '/').split('/')) {
    // `;x` is a path parameter, which some routers strip before matching.
    // A path parameter (`;jsessionid=…`) is stripped by some routers before
    // matching. Surrounding whitespace is trimmed by others.
    const bare = (segment.split(';')[0] ?? '').trim()
    if (bare === '' || bare === '.')
      continue
    if (bare === '..') {
      segments.pop()
      continue
    }
    segments.push(bare)
  }
  return `/${segments.join('/')}`
}

/**
 * Reduce a name to a comparison skeleton.
 *
 * `Acme Cloud`, `acmecloud`, `Acme-Cloud`, `Acme_Cloud`, `Acme.Cloud`, the
 * full-width spelling, a zero-width space between the words and an accented
 * `A` all reduce to `acmecloud`. The steps, in order and each load-bearing:
 *
 * 1. NFKD folds full-width and other compatibility forms onto ASCII, and
 *    splits a precomposed letter into its base plus a combining mark (NFKC
 *    would leave `A-acute` whole, so the mark strip below would find nothing).
 * 2. Combining marks (`\p{M}`) go, so a diacritic is not a disguise.
 * 3. Format and control characters (`\p{Cf}`, `\p{Cc}`) go: zero-width space,
 *    word joiner and the bidi overrides are invisible on a consent page and
 *    were each enough to evade a regex over the raw string.
 * 4. Case folds.
 * 5. Everything that is not a letter or a number goes, which covers the
 *    hyphen, dot and underscore spellings a `\s*` join misses.
 *
 * NOT covered: cross-script homoglyphs that NFKD leaves alone, such as a
 * Cyrillic `а` for a Latin `a`, or a digit `0` for a letter `O`. Catching
 * those needs a confusables table, which is more than this package should
 * carry. The consent page's unverified marker is the backstop for them.
 */
export function mcpNameSkeleton(value: string): string {
  return value
    .normalize('NFKD')
    .replaceAll(/[\p{M}\p{Cf}\p{Cc}]/gu, '')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]/gu, '')
}

/**
 * True when `host` is `root` or a subdomain of it.
 *
 * Anchored on a dot on purpose. The obvious `host.endsWith(root)` gives
 * `evilclaude.ai` the `claude.ai` treatment, and that predicate is the one an
 * adopter is most likely to write by hand, which is why it ships here.
 */
export function isMcpHostOwnedBy(host: string, roots: readonly string[]): boolean {
  const normalized = normalizeHost(host)
  return roots.some((root) => {
    const owner = normalizeHost(root)
    // A blank root would match every host, including the empty hostname a
    // non-special client id such as `urn:foo:bar` parses to, which then read
    // as first-party. Same mistake `assessMcpClientName` guards for a blank
    // reserved name.
    if (owner === '')
      return false
    return normalized === owner || normalized.endsWith(`.${owner}`)
  })
}

/**
 * Lower-case, and drop the dots that carry no meaning at either end.
 *
 * A leading dot is the natural way to write a wildcard root (`.example.com`),
 * and without stripping it `ownedHosts` written that way is dead config: every
 * first-party client silently reads as unverified.
 */
function normalizeHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\.+/, '').replace(/\.+$/, '')
}
