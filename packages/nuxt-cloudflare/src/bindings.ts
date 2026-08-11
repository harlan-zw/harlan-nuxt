export interface CloudflareEventLike {
  context?: {
    cloudflare?: {
      env?: Record<string, unknown>
    }
  }
}

export function getCloudflareBinding<Binding = unknown>(
  event: CloudflareEventLike,
  name: string,
): Binding | undefined {
  const env = event.context?.cloudflare?.env
  return env && name in env ? env[name] as Binding : undefined
}

export function requireCloudflareBinding<Binding = unknown>(
  event: CloudflareEventLike,
  name: string,
): Binding {
  const binding = getCloudflareBinding<Binding>(event, name)
  if (binding === undefined)
    throw new Error(`Cloudflare binding "${name}" is unavailable`)
  return binding
}
