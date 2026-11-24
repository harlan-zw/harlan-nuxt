import type { Nuxt } from '@nuxt/schema'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { expect, it, vi } from 'vitest'
import { setupCloudflareModule } from '../src/module'

const { templates } = vi.hoisted(() => ({ templates: [] as Array<{ getContents: () => string }> }))

vi.mock('@nuxt/kit', async original => ({
  ...await original<typeof import('@nuxt/kit')>(),
  getNitroVersion: () => 3,
  addTemplate: (template: { getContents: () => string }) => {
    templates.push(template)
    return { ...template, dst: 'dev-proxy.mjs' }
  },
}))

// Simulate the Windows filesystem boundary on Linux workers as well.
vi.mock('pathe', async (original) => {
  const actual = await original<typeof import('pathe')>()
  return {
    ...actual,
    resolve: (...paths: string[]) => paths.at(-1)?.endsWith('plugins/dev-proxy.ts')
      ? 'C:/project with spaces/#app/runtime/server/plugins/dev-proxy.ts'
      : actual.resolve(...paths),
  }
})

vi.mock('node:url', async (original) => {
  const actual = await original<typeof import('node:url')>()
  return {
    ...actual,
    pathToFileURL: (path: string) => actual.pathToFileURL(path, { windows: true }),
  }
})

it('loads the standalone dev proxy through Node ESM from a Windows drive path', () => {
  const nuxt = {
    hook() {},
    options: {
      rootDir: 'C:/app',
      dev: true,
      nitro: { cloudflare: { wrangler: { vars: { LOCAL_VALUE: 'ready' } } } },
      runtimeConfig: {},
      sourcemap: { server: false },
    },
  } as unknown as Nuxt

  setupCloudflareModule({ enabled: true, dev: true, bindingTypes: false }, nuxt)
  const source = templates[0]!.getContents()
  // Supply a factory at the Windows file URL. Leave Node's handling of drive
  // specifiers intact, so a raw C:/ import fails with ERR_UNSUPPORTED_ESM_URL_SCHEME.
  const script = `
    import { registerHooks } from 'node:module';
    const factoryURL = 'file:///C:/project%20with%20spaces/%23app/runtime/server/plugins/dev-proxy.ts';
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (specifier === factoryURL)
          return { url: specifier, shortCircuit: true };
        return nextResolve(specifier, context);
      },
      load(url, context, nextLoad) {
        if (url === factoryURL) {
          return { format: 'module', shortCircuit: true, source:
            'export async function createDevProxy(options) { return options.wrangler.vars.LOCAL_VALUE }' };
        }
        return nextLoad(url, context);
      }
    });
    const plugin = await import('data:text/javascript,' + encodeURIComponent(${JSON.stringify(source)}));
    process.stdout.write(plugin.default);
  `
  expect(execFileSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8' })).toBe('ready')
})
