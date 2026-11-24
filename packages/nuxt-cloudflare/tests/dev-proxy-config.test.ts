import type { D1Database } from '@cloudflare/workers-types'
import type { Nuxt } from '@nuxt/schema'
import type { NitroApp } from 'nitro/types'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { createCloudflareBindings, setCloudflareBindings } from '../src/bindings'
import { setupCloudflareModule } from '../src/module'

const { templates } = vi.hoisted(() => ({ templates: [] as Array<{ filename: string, getContents: () => string }> }))
vi.mock('@nuxt/kit', async original => ({
  ...await original<typeof import('@nuxt/kit')>(),
  getNitroVersion: () => 3,
  addTemplate: (template: { filename: string, getContents: () => string }) => {
    templates.push(template)
    return { ...template, dst: template.filename }
  },
}))
vi.mock('@harlan-zw/nuxt-cloudflare/bindings', () => import('../src/bindings'))

const directories: string[] = []
afterEach(async () => {
  setCloudflareBindings(undefined)
  templates.length = 0
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it.each([false, true])('queries inline DB with an authored config: %s', async (authored) => {
  const rootDir = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-inline-'))
  directories.push(rootDir)
  await writeFile(join(rootDir, 'package.json'), '{}')
  await mkdir(join(rootDir, 'node_modules'))
  const require = createRequire(import.meta.url)
  await symlink(join(require.resolve('wrangler/package.json'), '..'), join(rootDir, 'node_modules/wrangler'))
  if (authored) {
    await mkdir(join(rootDir, 'config'))
    await writeFile(join(rootDir, 'config/wrangler.jsonc'), JSON.stringify({
      vars: { FROM_FILE: 'authored', SHARED: 'file' },
      d1_databases: [{ binding: 'AUTHORED_DB', database_name: 'authored-db', database_id: '22222222-2222-4222-8222-222222222222' }],
    }))
    await writeFile(join(rootDir, 'config/.dev.vars'), 'FROM_DEV_VARS="local"\n')
  }
  const callbacks: Array<(config: object) => void> = []
  const nuxt = {
    hook(name: string, callback: (config: object) => void) {
      if (name === 'nitro:config')
        callbacks.push(callback)
    },
    options: {
      rootDir,
      dev: true,
      sourcemap: { server: false },
      runtimeConfig: {},
      nitro: { cloudflare: { wrangler: {
        vars: { SHARED: 'inline' },
        d1_databases: [{ binding: 'DB', database_name: 'inline-db', database_id: '11111111-1111-4111-8111-111111111111' }],
      } } },
    },
  } as unknown as Nuxt
  setupCloudflareModule({ enabled: true, dev: { persistDir: false, configPath: authored ? 'config/wrangler.jsonc' : undefined }, bindingTypes: false, workersCache: { _tag: 'disabled' } }, nuxt)
  const config = { ...nuxt.options.nitro }
  for (const callback of callbacks)
    callback(config)
  const template = templates.find(template => template.filename === 'nuxt-cloudflare-dev-proxy.mjs')!
  const pluginPath = join(rootDir, template.filename)
  await writeFile(pluginPath, template.getContents())
  const { default: plugin } = await import(/* @vite-ignore */ pathToFileURL(pluginPath).href)
  const closeHandlers: Array<() => Promise<void>> = []
  let requestHook = (_event: unknown) => {}
  const app = { hooks: { hook(name: string, handler: never) {
    if (name === 'request')
      requestHook = handler
    if (name === 'close')
      closeHandlers.push(handler)
  } } } as unknown as NitroApp
  try {
    await plugin(app)
    const route = async (request: Request) => {
      const event = { req: request, context: {} }
      requestHook(event)
      const db = createCloudflareBindings<{ DB: D1Database }>().require('DB', event)
      return Response.json(await db.prepare('SELECT 42 AS answer').first())
    }
    const response = await route(new Request('http://localhost/api/db'))
    expect(await response.json()).toEqual({ answer: 42 })
    const bindings = createCloudflareBindings<{ SHARED: string, FROM_FILE: string, FROM_DEV_VARS: string, AUTHORED_DB: D1Database }>()
    expect(bindings.require('SHARED')).toBe('inline')
    if (authored) {
      expect(bindings.require('FROM_FILE')).toBe('authored')
      expect(bindings.require('FROM_DEV_VARS')).toBe('local')
      expect(await bindings.require('AUTHORED_DB').prepare('SELECT 7 AS answer').first()).toEqual({ answer: 7 })
    }
  }
  finally {
    for (const close of closeHandlers)
      await close()
  }
}, 30_000)
