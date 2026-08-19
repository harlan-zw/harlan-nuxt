import type { LiteralPattern, MessagePattern, SerializedPattern } from './types'

/**
 * Browser noise the estate already agreed is non-actionable.
 *
 * Every entry here was written down by at least one site with a reason next to
 * it. Nothing was invented for this module.
 */

function literal(value: string): LiteralPattern {
  return { _tag: 'literal', value }
}

function pattern(source: string, flags = 'i'): SerializedPattern {
  return { _tag: 'pattern', source, flags }
}

/**
 * A visitor on the previous deploy asking for a hashed chunk that is gone.
 *
 * Exported on its own because these three are the only entries all nine sites
 * already carried, so a site that turns the rest of the noise list off still
 * wants them.
 */
export const STALE_CHUNK_MESSAGES: readonly SerializedPattern[] = [
  pattern('Failed to fetch dynamically imported module'),
  pattern('error loading dynamically imported module'),
  pattern('Importing a module script failed'),
]

/**
 * Messages that never produce an Error Report on either scope.
 *
 * Four groups, and each one fails for a reason outside the site.
 *
 * Browser extensions and injected scripts. The page did not load the code that
 * threw, and no change to the site can stop it.
 *
 * Page teardown and benign browser warnings. `ResizeObserver loop` is a browser
 * scheduling notice, not an exception.
 *
 * Stale chunk loads. A visitor still on the previous deploy asks for a hashed
 * chunk that no longer exists. The reload handles it.
 *
 * Cancelled requests. A navigation aborts an in flight fetch, which is the
 * expected outcome of leaving a page.
 */
export const BROWSER_NOISE_MESSAGES: readonly MessagePattern[] = [
  // Browser extensions and injected scripts.
  literal('Object Not Found Matching Id'),
  literal('Extension context invalidated'),
  literal('Tab not found'),
  literal('Illegal invocation'),
  pattern('Non-Error promise rejection captured'),
  pattern('runtime\\.sendMessage'),
  pattern('\\.hasAttribute is not a function'),
  pattern('\\.getAttribute is not a function'),
  pattern('\\.addEventListener is not a function'),
  pattern('Cannot destructure property \'bum\''),
  // Page teardown and benign browser warnings.
  literal('Channel is closed'),
  pattern('ResizeObserver loop'),
  // Stale chunk loads after a deploy.
  ...STALE_CHUNK_MESSAGES,
  // Cancelled requests.
  literal('AbortError'),
  literal('The user aborted a request'),
  literal('signal is aborted without reason'),
  pattern('AsyncData request cancelled by deduplication'),
  // Safari's generic offline or blocked request failure.
  literal('Load failed'),
]

/**
 * Source URLs that never produce an Error Report.
 *
 * A stack made entirely of extension frames is an extension defect. Reporting
 * it files an issue against the site that no change to the site can close.
 */
export const BROWSER_EXTENSION_DENY_URLS: readonly SerializedPattern[] = [
  pattern('^chrome-extension:\\/\\/', ''),
  pattern('^moz-extension:\\/\\/', ''),
  pattern('^safari-(web-)?extension:\\/\\/', ''),
  pattern('^chrome:\\/\\/', ''),
  pattern('extensions\\/', 'i'),
  pattern('webkit-masked-url', ''),
  // Android in app browsers inject this protocol.
  pattern('^iabjs:\\/\\/', 'i'),
]
