import type { PayloadUsageReport } from '../runtime/app/payload-usage'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineCommand } from 'citty'
import { chromium } from 'playwright'

export const payload = defineCommand({
  meta: { name: 'payload', description: 'Observe payload field reads while a browser hydrates a route' },
  args: {
    url: { type: 'positional', required: true, description: 'Full URL of a served dev or prerendered route' },
    output: { type: 'string', description: 'Write the JSON diagnostic to this file' },
    timeout: { type: 'string', default: '30000', description: 'Hydration timeout in milliseconds' },
  },
  async run({ args }) {
    const timeout = Number(args.timeout)
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('If using --timeout, provide a positive number of milliseconds.')
    const url = new URL(args.url)
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Provide an HTTP or HTTPS URL.')
    url.searchParams.set('__nuxt_dx_payload', '1')
    const browser = await chromium.launch().catch((error: unknown) => {
      throw new Error('Chromium could not start. Run `pnpm exec nuxt-dx install-browser`.', { cause: error })
    })
    try {
      const page = await browser.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(error.message))
      const response = await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout })
      if (!response?.ok())
        throw new Error(`The route returned HTTP ${response?.status() ?? 'no response'}.`)
      await page.waitForFunction(() => window.__NUXT_DX_PAYLOAD__ !== undefined, { }, { timeout }).catch((error: unknown) => {
        throw new Error('No hydration diagnostic arrived. Enable payloadUsage.prerender, regenerate, and check browser errors.', { cause: error })
      })
      const report: PayloadUsageReport = await page.evaluate(() => window.__NUXT_DX_PAYLOAD__!)
      if (report.status === 'unavailable')
        throw new Error(report.reason)
      if (errors.length)
        throw new Error(`Browser errors prevented a reliable diagnostic: ${errors.join('; ')}`)
      const output = `${JSON.stringify({ url: args.url, ...report }, null, 2)}\n`
      if (args.output)
        await writeFile(args.output, output)
      else
        process.stdout.write(output)
    }
    finally {
      await browser.close()
    }
  },
})

/** Install the browser version matching this package, including with strict pnpm dependency isolation. */
export const installBrowser = defineCommand({
  meta: { name: 'install-browser', description: 'Install Chromium for payload diagnostics' },
  async run() {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright')))
    const result = await promisify(execFile)(process.execPath, [cli, 'install', 'chromium'], { maxBuffer: 10 * 1024 * 1024 })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
  },
})
