import type { Resolver } from '@nuxt/kit'
import { existsSync } from 'node:fs'

export async function resolveRuntimeFile(resolver: Resolver, path: string): Promise<string> {
  const resolved = await resolver.resolvePath(path)
  if (!existsSync(resolved))
    throw new Error(`Unable to resolve runtime file: ${path}`)
  return resolved
}
