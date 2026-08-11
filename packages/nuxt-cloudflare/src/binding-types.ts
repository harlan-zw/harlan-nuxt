import type { WranglerConfigInput } from './wrangler'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { parseJSON, parseJSONC, parseTOML } from 'confbox'
import { extname, resolve } from 'pathe'
import { experimental_generateTypes } from 'wrangler'
import { discoverWranglerSourceConfigs } from './diagnostics'

interface BindingTypeGenerationOptions {
  buildDir: string
  compatibilityDate?: string
  config: WranglerConfigInput
  nodeCompat: boolean
}

export interface CloudflareBindingTypeArtifact {
  content: string
  signature: string
}

interface PreparedBindingTypeGenerationOptions extends Omit<BindingTypeGenerationOptions, 'config'> {
  rootDir: string
  wrangler: WranglerConfigInput
}

const COMPUTED_WRANGLER_KEYS = new Set([
  'configPath',
  'definedEnvironments',
  'targetEnvironment',
  'topLevelName',
  'userConfigPath',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeDefaults(primary: unknown, fallback: unknown): unknown {
  if (primary === undefined || primary === null)
    return fallback
  if (Array.isArray(primary) && Array.isArray(fallback))
    return [...primary, ...fallback]
  if (!isRecord(primary) || !isRecord(fallback))
    return primary

  const merged: Record<string, unknown> = { ...primary }
  for (const [key, value] of Object.entries(fallback))
    merged[key] = mergeDefaults(merged[key], value)
  return merged
}

function normalizeConfig(config: WranglerConfigInput, options: BindingTypeGenerationOptions): WranglerConfigInput {
  const normalized = Object.fromEntries(
    Object.entries(config).filter(([key, value]) => !COMPUTED_WRANGLER_KEYS.has(key) && value !== undefined),
  ) as WranglerConfigInput
  delete normalized.main

  normalized.assets = mergeDefaults({ binding: 'ASSETS', directory: '.' }, normalized.assets) as WranglerConfigInput['assets']
  normalized.compatibility_date ??= options.compatibilityDate

  if (options.nodeCompat) {
    const flags = new Set(normalized.compatibility_flags ?? [])
    if (flags.has('nodejs_compat_v2') && flags.has('no_nodejs_compat_v2'))
      flags.delete('nodejs_compat_v2')
    if (!flags.has('nodejs_compat_v2')) {
      flags.add('nodejs_compat')
      flags.add('no_nodejs_compat_v2')
    }
    normalized.compatibility_flags = [...flags]
  }

  return normalized
}

async function readAuthoredConfig(rootDir: string): Promise<WranglerConfigInput> {
  const [path] = discoverWranglerSourceConfigs(rootDir)
  if (!path)
    return {}
  const source = await readFile(path, 'utf8')
  const extension = extname(path)
  if (extension === '.toml')
    return parseTOML(source) as WranglerConfigInput
  if (extension === '.jsonc')
    return parseJSONC(source) as WranglerConfigInput
  return parseJSON(source) as WranglerConfigInput
}

async function generateCloudflareBindingTypes(
  options: BindingTypeGenerationOptions,
): Promise<CloudflareBindingTypeArtifact> {
  const directory = resolve(options.buildDir, 'nuxt-cloudflare')
  const configPath = resolve(directory, 'wrangler.json')
  const typePath = resolve(options.buildDir, 'types/cloudflare-bindings.d.ts')
  await mkdir(directory, { recursive: true })
  await writeFile(configPath, `${JSON.stringify(normalizeConfig(options.config, options), null, 2)}\n`)

  const generated = await experimental_generateTypes({
    config: configPath,
    envInterface: 'CloudflareBindings',
    includeRuntime: true,
    path: typePath,
    strictVars: false,
  })
  if (!generated.env || !generated.runtime)
    throw new Error('[nuxt-cloudflare] Wrangler did not generate Cloudflare binding and runtime types.')

  return {
    content: generated.content,
    signature: `${generated.env}\0${generated.runtime}`,
  }
}

export async function prepareCloudflareBindingTypes(
  options: PreparedBindingTypeGenerationOptions,
): Promise<CloudflareBindingTypeArtifact> {
  const authored = await readAuthoredConfig(options.rootDir)
  const config = mergeDefaults(options.wrangler, authored) as WranglerConfigInput
  return generateCloudflareBindingTypes({ ...options, config })
}

export async function assertCloudflareBindingTypesCurrent(
  options: BindingTypeGenerationOptions & { expectedSignature: string },
): Promise<void> {
  const generated = await generateCloudflareBindingTypes(options)
  if (generated.signature !== options.expectedSignature) {
    throw new Error(
      '[nuxt-cloudflare] Generated binding types differ from the final Wrangler config. Run `nuxt prepare` and review binding configuration order.',
    )
  }
}
