import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Reads the version this package publishes.
 *
 * The manifest sits two directories above this file in the source tree and in
 * the built CLI, so one path serves both. A hardcoded version drifts from the
 * published one and makes `nuxt-cloudflare --version` report a build that does
 * not exist.
 */
export function readCliVersion(): string {
  const path = fileURLToPath(new URL('../../package.json', import.meta.url))
  const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'))
  const version = manifest !== null && typeof manifest === 'object'
    ? (manifest as { version?: unknown }).version
    : undefined
  if (typeof version !== 'string')
    throw new TypeError(`Package manifest "${path}" declares no version.`)
  return version
}
