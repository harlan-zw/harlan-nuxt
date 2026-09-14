import type { CheckRegistration, CheckRegistry, ModuleOptions } from './types'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { addServerTemplate, addTypeTemplate, createResolver, defineNuxtModule, getLayerDirectories, resolveFiles } from '@nuxt/kit'
import { isAbsolute, resolve } from 'pathe'
import { bundleChecks } from './build/bundle'
import { readCheckId } from './build/discovery'
import { runChecks } from './runtime/server/index'

export type { CheckRegistration, CheckRegistry, ModuleOptions } from './types'

declare module '@nuxt/schema' {
  interface NuxtHooks {
    'checkin:register': (registry: CheckRegistry) => void | Promise<void>
  }
}

export default defineNuxtModule<ModuleOptions>({
  meta: { name: '@harlan-zw/nuxt-checkin', configKey: 'checkin', compatibility: { nuxt: '>=4.5.0 <6.0.0' } },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const server = resolver.resolve('./runtime/server/index')
    const directories = options.dirs
      ? options.dirs.map(dir => resolve(nuxt.options.rootDir, dir))
      : getLayerDirectories(nuxt).map(layer => resolve(layer.server, 'checks'))
    const externalDirectories = getLayerDirectories(nuxt).map(layer => resolve(layer.root, 'checks/external'))
    const buildDirectories = getLayerDirectories(nuxt).map(layer => resolve(layer.root, 'checks/build'))
    const generate = async (execution: 'server' | 'build' | 'external' = 'server') => {
      const selectedDirectories = execution === 'server' ? directories : execution === 'external' ? externalDirectories : buildDirectories
      const sources = [...new Set((await Promise.all(selectedDirectories.filter(existsSync).map(dir => resolveFiles(dir, '**/*.{ts,js,mts,mjs}', {
        ignore: ['**/_*.*', '**/*.d.{ts,mts}', '**/*.test.*', '**/*.spec.*'],
      })))).flat())].sort()
      const ids = new Set<string>()
      const claim = (id: string) => {
        if (typeof id !== 'string' || !/^[\w.-]+$/.test(id))
          throw new Error('Module check requires a valid ID.')
        if (ids.has(id))
          throw new Error(`Duplicate check ID: ${id}`)
        ids.add(id)
      }
      const imports = [`import { defineChecks } from ${JSON.stringify(server)}`]
      const entries: string[] = []
      for (const [i, file] of sources.entries()) {
        claim(await readCheckId(file))
        imports.push(`import check${i} from ${JSON.stringify(file)}`)
        entries.push(`check${i}`)
      }
      const registrations: CheckRegistration[] = []
      await nuxt.callHook('checkin:register', { add: registration => registrations.push(registration) })
      for (const [i, registration] of registrations.filter(registration => (registration.execution ?? 'server') === execution).entries()) {
        claim(registration.id)
        if (typeof registration.handler !== 'string' || !isAbsolute(registration.handler))
          throw new Error('Module check handler must be an absolute path.')
        const name = `moduleCheck${i}`
        imports.push(`import ${name} from ${JSON.stringify(registration.handler)}`)
        entries.push(`${name}(${JSON.stringify({ ...registration.options, id: registration.id }, (_key, value: unknown) => {
          if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value)))
            throw new Error('Module check options must contain JSON values.')
          return value
        })})`)
      }
      return `${imports.join('\n')}\nexport default defineChecks([${entries.join(', ')}])\n`
    }
    const prepareNodeChecks = async (execution: 'external' | 'build') => {
      const directory = resolve(nuxt.options.buildDir, 'checkin')
      await mkdir(directory, { recursive: true })
      const destination = resolve(directory, `${execution}.mjs`)
      await bundleChecks(`${await generate(execution)}\nexport const options = ${JSON.stringify(execution === 'external' ? options.external ?? { required: [] } : options.build ?? {})}\n`, destination)
      if (execution === 'external') {
        const cache = resolve(nuxt.options.rootDir, 'node_modules/.cache/nuxt-checkin')
        await mkdir(cache, { recursive: true })
        await writeFile(resolve(cache, 'artifact.json'), JSON.stringify({ path: destination }))
      }
      return destination
    }
    nuxt.hook('ready', async () => {
      await prepareNodeChecks('external')
    })
    nuxt.hook('build:before', async () => {
      await generate()
      await prepareNodeChecks('external')
      const destination = await prepareNodeChecks('build')
      const { default: checks } = await import(`${pathToFileURL(destination).href}?v=${Date.now()}`)
      if (checks.length || options.build?.required?.length) {
        const report = await runChecks(checks, options.build)
        if (report.coverage !== 'complete' || report.severity !== 'pass')
          throw new Error(`Build checks need attention: ${JSON.stringify(report)}`)
      }
    })
    addServerTemplate({
      filename: '#checkin/checks',
      getContents: () => generate(),
    })
    addTypeTemplate({
      filename: 'checkin/types.d.ts',
      getContents: () => `declare module '#checkin/checks' { const checks: readonly import(${JSON.stringify(server)}).Check[]; export default checks }`,
    }, { nuxt: true, nitro: true })
    if (nuxt.options.dev) {
      nuxt.options.watch.push(...directories.map(dir => `${dir}/**/*`))
      const onNitroInit = nuxt.hook as unknown as (
        name: 'nitro:init',
        callback: (nitro: { hooks: { callHook: (name: 'rollup:reload') => Promise<void> } }) => void,
      ) => void
      onNitroInit('nitro:init', (nitro) => {
        nuxt.hook('builder:watch', async (_event, path) => {
          const absolute = resolve(nuxt.options.srcDir, path)
          if (directories.some(dir => absolute === dir || absolute.startsWith(`${dir}/`)))
            await nitro.hooks.callHook('rollup:reload')
        })
      })
    }
  },
})
