import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWithNuxtContext } from '@nuxt/kit'
import { describe, expect, it } from 'vitest'
import { installReconcileContextTemplate } from '../src/module'

type InlineMatcher = (id: string, importer?: string) => boolean | Promise<boolean>

function createNuxtStub(dev: boolean) {
  const rootDir = mkdtempSync(join(tmpdir(), 'cf-jobs-dev-'))
  return {
    options: {
      dev,
      rootDir,
      buildDir: join(rootDir, '.nuxt'),
      alias: {} as Record<string, string>,
      nitro: {} as { externals?: { inline?: unknown } },
      build: { templates: [] as unknown[] },
    },
    hooks: { hook: () => {} },
  }
}

function inlineMatchers(nuxt: ReturnType<typeof createNuxtStub>): InlineMatcher[] {
  const inline = nuxt.options.nitro.externals?.inline
  return (Array.isArray(inline) ? inline : []).filter((entry): entry is InlineMatcher => typeof entry === 'function')
}

describe('reconcile context template', () => {
  it('hands the generated proxy to Rollup in dev instead of Node\'s ESM loader', () => {
    const nuxt = createNuxtStub(true)

    runWithNuxtContext(nuxt as never, () => {
      installReconcileContextTemplate({ terminalFailureContext: './server/reconcile-context.ts' }, nuxt as never)
    })

    const dst = nuxt.options.alias['#cf-jobs/reconcile-context']!
    expect(dst).toContain('cf-jobs/reconcile-context.mjs')
    expect(inlineMatchers(nuxt).some(match => match(dst) === true)).toBe(true)
    expect(inlineMatchers(nuxt).some(match => match(`file://${dst}`) === true)).toBe(true)
  })

  it('leaves the production bundle alone', () => {
    const nuxt = createNuxtStub(false)

    runWithNuxtContext(nuxt as never, () => {
      installReconcileContextTemplate({ terminalFailureContext: './server/reconcile-context.ts' }, nuxt as never)
    })

    expect(nuxt.options.nitro.externals).toBeUndefined()
  })
})
