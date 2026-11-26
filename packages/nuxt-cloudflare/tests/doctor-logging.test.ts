import type { Nuxt } from '@nuxt/schema'
import type { Nitro } from 'nitropack/types'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setupCloudflareModule } from '@harlan-zw/nuxt-cloudflare'
import { afterEach, describe, expect, it, vi } from 'vitest'

const logs = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('@nuxt/kit', async original => ({
  ...await original<typeof import('@nuxt/kit')>(),
  useLogger: () => logs,
}))

const directories: string[] = []
afterEach(() => {
  directories.splice(0).forEach(directory => rmSync(directory, { force: true, recursive: true }))
  vi.clearAllMocks()
})

async function audit(doctor: Parameters<typeof setupCloudflareModule>[0]['doctor'], uploadSourceMaps = true) {
  const rootDir = mkdtempSync(join(tmpdir(), 'nuxt-cloudflare-logging-'))
  directories.push(rootDir)
  writeFileSync(join(rootDir, 'wrangler.json'), JSON.stringify({
    name: 'doctor-logging',
    compatibility_date: new Date().toISOString().slice(0, 10),
    compatibility_flags: ['nodejs_compat'],
    workers_dev: false,
    upload_source_maps: uploadSourceMaps,
    observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1 }, traces: { enabled: true, head_sampling_rate: 0.01 } },
    cache: { enabled: false },
    version_metadata: { binding: 'CF_VERSION_METADATA' },
  }))
  let initialize: ((nitro: Nitro) => void) | undefined
  let compiled: (() => Promise<void>) | undefined
  const nuxt = {
    hook(name: string, callback: unknown) {
      if (name === 'nitro:init')
        initialize = callback as typeof initialize
    },
    options: { dev: false, rootDir, buildDir: rootDir, nitro: {}, runtimeConfig: {}, sourcemap: { server: true } },
  } as unknown as Nuxt
  setupCloudflareModule({ bindingTypes: false, doctor, enabled: true }, nuxt)
  initialize!({
    options: { preset: 'cloudflare-module', output: { serverDir: rootDir, publicDir: join(rootDir, 'public') } },
    hooks: { hook(_name: string, callback: () => Promise<void>) { compiled = callback } },
  } as unknown as Nitro)
  await compiled!()
}

describe('wrangler build diagnostic logging', () => {
  it('keeps accepted strict warnings visible as information', async () => {
    await audit({ _tag: 'strict', allowedWarnings: ['observability-log-sampling-high'] })

    expect(logs.warn).not.toHaveBeenCalled()
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('INFO observability-log-sampling-high'))
  })

  it('still reports advisory warnings at warning level', async () => {
    await audit({ _tag: 'advisory' })

    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('WARN observability-log-sampling-high'))
  })

  it('still blocks strict warnings which the policy does not accept', async () => {
    await expect(audit({ _tag: 'strict', allowedWarnings: ['observability-log-sampling-high'] }, false))
      .rejects
      .toThrow('source-maps-disabled')
    expect(logs.info).toHaveBeenCalledWith(expect.stringContaining('INFO observability-log-sampling-high'))
  })
})

describe('static404Fallback build-time configuration warnings', () => {
  function runNitroConfigHook(options: {
    static404Fallback?: boolean | { assetPath?: string }
    compatibilityVersion?: number
    inlineErrorRendering?: boolean
    prerenderErrorPages?: boolean | number[]
    prerenderRoutes?: string[]
  }) {
    let onNitroConfig: ((nitroConfig: Record<string, unknown>) => void) | undefined
    const nuxt = {
      hook(name: string, callback: unknown) {
        if (name === 'nitro:config')
          onNitroConfig = callback as typeof onNitroConfig
      },
      options: {
        dev: false,
        experimental: {
          inlineErrorRendering: options.inlineErrorRendering,
          prerenderErrorPages: options.prerenderErrorPages,
        },
        future: {
          compatibilityVersion: options.compatibilityVersion ?? 4,
        },
        nitro: {},
        runtimeConfig: {},
        sourcemap: { server: false },
      },
    } as unknown as Nuxt

    setupCloudflareModule({
      bindingTypes: false,
      enabled: true,
      workersCache: { _tag: 'disabled' },
      static404Fallback: options.static404Fallback,
    }, nuxt)

    onNitroConfig!({
      prerender: options.prerenderRoutes ? { routes: options.prerenderRoutes } : undefined,
    })
  }

  it('warns during nitro:config on Nuxt 5 defaults when static404Fallback is enabled', () => {
    runNitroConfigHook({
      static404Fallback: true,
      compatibilityVersion: 5,
    })

    expect(logs.warn).toHaveBeenCalledTimes(1)
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('experimental.inlineErrorRendering: false'))
    expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining('experimental.prerenderErrorPages: true'))
  })

  it('emits no static404Fallback warnings when Nuxt 5 flags are configured or option is disabled', () => {
    runNitroConfigHook({
      static404Fallback: true,
      compatibilityVersion: 5,
      inlineErrorRendering: false,
      prerenderErrorPages: true,
    })
    runNitroConfigHook({
      static404Fallback: false,
      compatibilityVersion: 5,
    })

    expect(logs.warn).not.toHaveBeenCalled()
  })
})
