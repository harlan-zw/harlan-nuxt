/**
 * One line, written before a job's handler runs, naming the job.
 *
 * This exists for a failure mode nothing else survives. When the Workers runtime
 * kills an invocation for exceeding its memory limit, the isolate is gone before
 * any logger, error reporter or `finally` block can flush — there is no
 * post-mortem to read. The one artefact that still reaches an observer is the
 * Tail Worker trace, and that trace carries `logs`: whatever the invocation
 * managed to write before it died.
 *
 * A queue trace names the QUEUE, not the job. That is coarse wherever one queue
 * carries many job kinds, which is the normal shape — a consumer with sixteen
 * job types reports every memory kill against one bucket. This marker is what
 * closes that gap: a tail consumer scanning `logs` for the prefix recovers the
 * job name for an invocation that produced no other output at all.
 *
 * Deliberately `console.log` and not the job logger: only console output is
 * captured into a trace event, and the marker is worthless if it goes anywhere
 * a dying isolate cannot flush from.
 *
 * Off by default. It costs one log line per message, and an application that
 * does not consume traces should not pay for it.
 */

/**
 * Prefix a tail consumer matches on. Deliberately unlovely and unlikely to
 * collide with application output.
 */
export const JOB_TRACE_MARKER_PREFIX = 'cfjob:'

/**
 * The marker line for a job. Exported so a consumer can build the same string
 * it parses, rather than duplicating the format.
 */
export function jobTraceMarker(taskName: string): string {
  return `${JOB_TRACE_MARKER_PREFIX}${taskName}`
}

/**
 * Recover a job name from a trace event's captured log lines.
 *
 * Scans rather than reading the last line: the marker is written FIRST, so
 * anything the job logs afterwards would displace it. Returns the last marker
 * found, which is the job that was actually running when the invocation died —
 * a batch delivers several messages to one invocation, and only the final one
 * matters for attributing the kill.
 *
 * @param logs Message arrays as they appear on a `TraceItem`'s `logs`.
 */
export function jobNameFromTraceLogs(logs: readonly { message: unknown }[] | undefined): string | null {
  if (!logs?.length)
    return null
  for (let index = logs.length - 1; index >= 0; index--) {
    const parts = logs[index]?.message
    if (!Array.isArray(parts))
      continue
    for (const part of parts) {
      if (typeof part === 'string' && part.startsWith(JOB_TRACE_MARKER_PREFIX)) {
        const name = part.slice(JOB_TRACE_MARKER_PREFIX.length).trim()
        if (name)
          return name
      }
    }
  }
  return null
}

/** Write the marker. Separate from the formatter so callers can test both. */
export function writeJobTraceMarker(taskName: string): void {
  // The rule allows only warn/error, but this is routine diagnostic output, not
  // a fault: one line per message. Raising it to warn would push that volume
  // into every consuming application's warn-level drain and alerting, where it
  // would drown the faults those channels exist to surface. Trace capture does
  // not care about level — `log` is recorded the same as `warn`.
  // eslint-disable-next-line no-console
  console.log(jobTraceMarker(taskName))
}
