/** The largest MCP request body a server should accept by default. */
export const MCP_BODY_LIMIT_BYTES = 1024 * 1024

/**
 * True when the request DECLARES a body larger than the cap.
 *
 * Header-only on purpose. A server that streams and cancels the reader can
 * enforce the cap exactly, but only when it owns the body end to end. A server
 * that passes the request down to another handler cannot read the stream in
 * front of it without leaving that handler with nothing to parse. The declared
 * check stops the honest case, and an undeclared oversized body still meets
 * the runtime's own request limits.
 */
export function exceedsMcpBodyLimit(
  contentLength: string | null | undefined,
  maxBytes: number = MCP_BODY_LIMIT_BYTES,
): boolean {
  const declared = Number(contentLength)
  return Number.isFinite(declared) && declared > maxBytes
}
