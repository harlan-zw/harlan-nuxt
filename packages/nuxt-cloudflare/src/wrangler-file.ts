import type { JSONCParseError } from 'confbox'
import type { WranglerConfigInput } from './wrangler'
import { existsSync, readFileSync } from 'node:fs'
import { parseJSON, parseJSONC, parseTOML } from 'confbox'
import { dirname, extname, resolve } from 'pathe'

export type WranglerConfigFileResult
  = | { _tag: 'loaded', config: WranglerConfigInput, path: string }
    | { _tag: 'missing', path: string }
    | { _tag: 'invalid', path: string, reason: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseWranglerConfigSource(path: string, source: string): WranglerConfigInput {
  const extension = extname(path)
  if (extension === '.toml')
    return parseTOML(source) as WranglerConfigInput
  if (extension === '.jsonc') {
    const errors: JSONCParseError[] = []
    const config = parseJSONC(source, { errors }) as WranglerConfigInput
    if (errors.length > 0) {
      const { error, offset } = errors[0]!
      throw new SyntaxError(`JSONC parse error ${error} at offset ${offset}`)
    }
    return config
  }
  return parseJSON(source) as WranglerConfigInput
}

export function readWranglerConfigFile(path: string): WranglerConfigFileResult {
  if (!existsSync(path))
    return { _tag: 'missing', path }
  try {
    return {
      _tag: 'loaded',
      config: parseWranglerConfigSource(path, readFileSync(path, 'utf8')),
      path,
    }
  }
  catch (error) {
    return { _tag: 'invalid', path, reason: errorMessage(error) }
  }
}

export function findProjectWranglerConfig(cwd: string): string | undefined {
  let directory = resolve(cwd)
  while (true) {
    for (const name of ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml']) {
      const candidate = resolve(directory, name)
      if (existsSync(candidate))
        return candidate
    }
    const parent = dirname(directory)
    if (parent === directory)
      return undefined
    directory = parent
  }
}

export type AuthoredWranglerConfigResult
  = | { _tag: 'authored', config: WranglerConfigInput, path: string }
    | { _tag: 'absent' }
    | { _tag: 'invalid', path: string, reason: string }

/**
 * Reads the root Wrangler config the consumer authored.
 *
 * Nitro writes the deployed config as `defu(overrides, nitro.cloudflare.wrangler,
 * thisFile, defaults)`, so every value in this file loses to a module default
 * that names the same key. Module policy reads the file for that reason only:
 * a value the consumer wrote here stays the value that deploys.
 */
export function readAuthoredWranglerConfig(rootDir: string | undefined): AuthoredWranglerConfigResult {
  const path = rootDir === undefined ? undefined : findProjectWranglerConfig(rootDir)
  if (!path)
    return { _tag: 'absent' }
  const loaded = readWranglerConfigFile(path)
  if (loaded._tag === 'loaded')
    return { _tag: 'authored', config: loaded.config, path }
  if (loaded._tag === 'missing')
    return { _tag: 'absent' }
  return { _tag: 'invalid', path, reason: loaded.reason }
}
