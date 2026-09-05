import { execSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * The `./server` barrel is the documented entry for a non Cloudflare site
 * (`sentry.server.config.ts` imports `createBeforeSend` from it), and
 * `@sentry/cloudflare` is an optional peer that only a Workers deploy
 * installs. The barrel must therefore stay free of SDK imports: if it
 * re-exports `withSentryTask` from `server/task.ts`, every Node site fails
 * module resolution on `import ... from '@harlan-zw/nuxt-sentry/server'`.
 *
 * This packs the package and loads the packed barrel in a bare Node process
 * with no `node_modules` around it, so any reachable SDK import fails.
 */

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))

describe('server barrel resolves without @sentry/cloudflare', () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'nuxt-sentry-barrel-'))

  beforeAll(() => {
    execSync('pnpm test:pack', { cwd: root, stdio: 'pipe' })
    const tarball = readdirSync(join(root, '.pack')).find(file => file.endsWith('.tgz'))
    expect(tarball, 'pnpm test:pack produced no tarball').toBeTruthy()
    const pkgDir = join(sandbox, 'node_modules', '@harlan-zw', 'nuxt-sentry')
    mkdirSync(pkgDir, { recursive: true })
    execSync(`tar -xzf ${JSON.stringify(join(root, '.pack', tarball!))} -C ${JSON.stringify(pkgDir)} --strip-components=1`)
  })

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true })
  })

  it('loads the packed ./server entry in a bare Node process', () => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const barrel = await import(${JSON.stringify(join(sandbox, 'node_modules', '@harlan-zw', 'nuxt-sentry', 'dist', 'runtime', 'server', 'index.js'))})
      if (typeof barrel.createBeforeSend !== 'function')
        throw new Error(\`createBeforeSend missing, exports: \${Object.keys(barrel).join(', ')}\`)
      console.log('loaded')
    `], { cwd: sandbox, encoding: 'utf8' })

    expect(`${result.stderr}${result.stdout}`, result.stderr).toContain('loaded')
    expect(result.status, result.stderr).toBe(0)
  })

  it('serves withSentryTask from the packed ./server/task subpath', () => {
    mkdirSync(join(sandbox, 'node_modules', '@sentry'), { recursive: true })
    symlinkSync(join(root, 'node_modules', '@sentry/cloudflare'), join(sandbox, 'node_modules', '@sentry/cloudflare'), 'dir')
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const task = await import('@harlan-zw/nuxt-sentry/server/task')
      if (typeof task.withSentryTask !== 'function')
        throw new Error(\`withSentryTask missing, exports: \${Object.keys(task).join(', ')}\`)
      const report = task.withSentryTask({ run: () => Promise.resolve(1) })
      if (typeof report.run !== 'function')
        throw new Error('withSentryTask returned no task')
      console.log('loaded')
    `], { cwd: sandbox, encoding: 'utf8' })

    expect(`${result.stderr}${result.stdout}`, result.stderr).toContain('loaded')
    expect(result.status, result.stderr).toBe(0)
  })
})
