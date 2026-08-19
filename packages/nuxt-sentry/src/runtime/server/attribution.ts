/**
 * Cloudflare Worker version attribution.
 *
 * A release identity names the source commit. It does not name the Worker
 * version that actually served the request, and a rollback or a gradual
 * deployment makes those two different things. The `CF_VERSION_METADATA`
 * binding carries the version, and six of the nine deployments already have it.
 */

export interface WorkerAttribution {
  tags: {
    worker_version: string
    worker_version_tag?: string
  }
  context: {
    id: string
    tag: string | null
    uploaded_at: string | null
  }
}

interface VersionMetadataLike {
  id?: unknown
  tag?: unknown
  timestamp?: unknown
}

/**
 * Parse the binding into attribution, or return `null` when it is absent.
 *
 * The binding is untrusted here: it is missing on any deployment that never
 * declared it, and `wrangler dev` supplies a placeholder. Parsing once at this
 * boundary keeps every caller free of the checks.
 */
export function resolveWorkerAttribution(metadata: unknown): WorkerAttribution | null {
  if (!metadata || typeof metadata !== 'object')
    return null
  const value = metadata as VersionMetadataLike
  if (typeof value.id !== 'string' || !value.id)
    return null
  const tag = typeof value.tag === 'string' && value.tag ? value.tag : null
  return {
    tags: {
      worker_version: value.id,
      ...(tag ? { worker_version_tag: tag } : {}),
    },
    context: {
      id: value.id,
      tag,
      uploaded_at: typeof value.timestamp === 'string' ? value.timestamp : null,
    },
  }
}
