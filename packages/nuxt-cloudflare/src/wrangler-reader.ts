import type { WranglerConfigInput } from './wrangler'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'pathe'
import { unstable_readConfig } from 'wrangler'

export interface ReadProjectWranglerOptions {
  config?: string
  cwd: string
  environment?: string
}

export interface ProjectWranglerConfig {
  config: WranglerConfigInput
  path: string | undefined
}

function resolveNitroDeployConfig(cwd: string): string | undefined {
  const redirectPath = resolve(cwd, '.wrangler/deploy/config.json')
  if (!existsSync(redirectPath))
    return undefined

  const parsed: unknown = JSON.parse(readFileSync(redirectPath, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || !('configPath' in parsed) || typeof parsed.configPath !== 'string')
    throw new Error(`Invalid Nitro deploy config: ${redirectPath}`)
  return resolve(dirname(redirectPath), parsed.configPath)
}

/** Wrangler owns JSONC/TOML parsing, validation, and environment flattening. */
export function readProjectWranglerConfig(options: ReadProjectWranglerOptions): ProjectWranglerConfig {
  const configPath = options.config
    ? resolve(options.cwd, options.config)
    : resolveNitroDeployConfig(options.cwd)
  const config = unstable_readConfig({
    config: configPath,
    env: options.environment,
    script: resolve(options.cwd, '__nuxt-cloudflare-doctor.mjs'),
  }, {
    hideWarnings: true,
    useRedirectIfAvailable: false,
  })
  return {
    config,
    path: config.configPath,
  }
}
