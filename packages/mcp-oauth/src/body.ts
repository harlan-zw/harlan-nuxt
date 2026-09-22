/** The largest MCP request body a server should accept by default. */
export const MCP_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * True when the request declares a body this server will not accept.
 *
 * An UNPARSEABLE declaration counts as over the cap. The earlier version used
 * `Number.isFinite`, which made every malformed value pass: `'Infinity'` and
 * `'1e999'` overflow, and `'5, 2000000'` (what a header getter yields when it
 * joins duplicate `Content-Length` values, as some proxies produce) parses to
 * `NaN`. Each read as "under the limit". A declaration that is not a plain
 * decimal integer is not evidence of a small body.
 *
 * An ABSENT declaration still passes: that is not evidence of a large body
 * either, and the runtime's own request limit remains behind this check.
 *
 * Header-only by design. A server that streams and cancels the reader can
 * enforce the cap exactly, but only when it owns the body end to end; a server
 * that passes the request to another handler cannot drain the stream in front
 * of it without leaving that handler with nothing to parse.
 */
export function exceedsMcpBodyLimit(
  contentLength: string | null | undefined,
  maxBytes: number = MCP_BODY_LIMIT_BYTES,
): boolean {
  if (contentLength === null || contentLength === undefined)
    return false
  const declared = contentLength.trim()
  if (declared === '')
    return false
  if (!/^\d+$/.test(declared))
    return true
  return Number(declared) > maxBytes
}
