import type { WranglerConfigInput } from './wrangler'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'pathe'
import { unstable_readConfig } from 'wrangler'
import { findProjectWranglerConfig } from './wrangler-file'

export interface ReadProjectWranglerOptions {
  config?: string
  cwd: string
  environment?: string
}

export type ProjectWranglerConfig
  = | {
    _tag: 'loaded'
    config: WranglerConfigInput
    generated: boolean
    path: string | undefined
  }
  | {
    _tag: 'invalid'
    generated: boolean
    path: string | undefined
    reason: string
  }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type Attempt<T>
  = | { _tag: 'loaded', value: T }
    | { _tag: 'invalid', reason: string }

function attempt<T>(run: () => T): Attempt<T> {
  try {
    return { _tag: 'loaded', value: run() }
  }
  catch (error) {
    return { _tag: 'invalid', reason: errorMessage(error) }
  }
}

function findUpFile(cwd: string, relativePath: string): string | undefined {
  let directory = resolve(cwd)
  while (true) {
    const candidate = resolve(directory, relativePath)
    if (existsSync(candidate))
      return candidate
    const parent = dirname(directory)
    if (parent === directory)
      return undefined
    directory = parent
  }
}

function resolveNitroDeployConfig(cwd: string): string | undefined {
  const redirectPath = findUpFile(cwd, '.wrangler/deploy/config.json')
  if (!redirectPath)
    return undefined
  const redirectProjectDirectory = dirname(dirname(dirname(redirectPath)))
  const authoredConfigPath = findProjectWranglerConfig(cwd)
  if (authoredConfigPath && dirname(authoredConfigPath) !== redirectProjectDirectory)
    return undefined
  const parsed: unknown = JSON.parse(readFileSync(redirectPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !('configPath' in parsed) || typeof parsed.configPath !== 'string')
    throw new Error(`Invalid Nitro deploy config: ${redirectPath}`)
  return resolve(dirname(redirectPath), parsed.configPath)
}

/** Wrangler owns JSONC/TOML parsing, validation, and environment flattening. */
export function readProjectWranglerConfig(options: ReadProjectWranglerOptions): ProjectWranglerConfig {
  const redirect = attempt(() => options.config ? undefined : resolveNitroDeployConfig(options.cwd))
  if (redirect._tag === 'invalid') {
    return {
      _tag: 'invalid',
      generated: false,
      path: findUpFile(options.cwd, '.wrangler/deploy/config.json')
        ?? resolve(options.cwd, '.wrangler/deploy/config.json'),
      reason: redirect.reason,
    }
  }
  const generatedConfigPath = redirect.value
  const configPath = options.config
    ? resolve(options.cwd, options.config)
    : generatedConfigPath
  const loaded = attempt(() => unstable_readConfig({
    config: configPath,
    env: options.environment,
    script: resolve(options.cwd, '__nuxt-cloudflare-doctor.mjs'),
  }, {
    hideWarnings: true,
    useRedirectIfAvailable: false,
  }))
  if (loaded._tag === 'invalid') {
    return {
      _tag: 'invalid',
      generated: generatedConfigPath !== undefined,
      path: configPath,
      reason: loaded.reason,
    }
  }
  return {
    _tag: 'loaded',
    config: loaded.value,
    generated: generatedConfigPath !== undefined,
    path: loaded.value.configPath,
  }
}
