export interface CloudflareEventLike<Environment extends object> {
  context?: {
    cloudflare?: {
      env?: Environment
    }
  }
}

export function getCloudflareBinding<
  Environment extends object,
  Name extends Extract<keyof Environment, string>,
>(
  event: CloudflareEventLike<Environment>,
  name: Name,
): Environment[Name] | undefined {
  const env = event.context?.cloudflare?.env
  return env && Object.hasOwn(env, name) ? env[name] : undefined
}

export function requireCloudflareBinding<
  Environment extends object,
  Name extends Extract<keyof Environment, string>,
>(
  event: CloudflareEventLike<Environment>,
  name: Name,
): Exclude<Environment[Name], undefined> {
  const binding = getCloudflareBinding(event, name)
  if (binding === undefined)
    throw new Error(`Cloudflare binding "${name}" is unavailable`)
  return binding as Exclude<Environment[Name], undefined>
}
