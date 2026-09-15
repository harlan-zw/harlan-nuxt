import type { PayloadUsageReport } from '../runtime/app/payload-usage'
import type { DiagnosticIssue } from '../runtime/app/report'
import { execFile } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { defineCommand } from 'citty'
import { chromium } from 'playwright'
import { discoverDevServer, resolveInspectionTarget } from '../dev-server'
import { HYDRATION_SUMMARY_ERROR } from '../runtime/app/hydration'
import { createInspectionReport, formatInspectionReport } from './inspect-report'

export const inspect = defineCommand({
  meta: { name: 'inspect', description: 'Inspect a route for client errors, warnings, hydration mismatches, and unread payload fields' },
  args: {
    target: { type: 'positional', default: '/', description: 'Route path or full URL. Defaults to the running app home page' },
    cwd: { type: 'string', default: '.', description: 'Project directory used to find the running dev server' },
    output: { type: 'string', description: 'Write the JSON diagnostic report to this file' },
    json: { type: 'boolean', default: false, description: 'Print JSON instead of a readable report' },
    timeout: { type: 'string', default: '30000', description: 'Navigation and hydration timeout in milliseconds' },
  },
  async run({ args }) {
    const timeout = Number(args.timeout)
    if (!Number.isFinite(timeout) || timeout <= 0)
      throw new Error('If using --timeout, provide a positive number of milliseconds.')
    const absolute = /^[a-z][a-z\d+.-]*:/i.test(args.target)
    const url = resolveInspectionTarget(args.target, absolute ? undefined : await discoverDevServer(args.cwd))
    const browser = await chromium.launch().catch((error: unknown) => {
      throw new Error('Chromium could not start. Run `pnpm exec nuxt-dx install-browser`.', { cause: error })
    })
    try {
      const page = await browser.newPage()
      await page.addInitScript(() => {
        window.__NUXT_DX_PAYLOAD_ENABLED__ = true
        // DevTools deeply watches the payload, which would count unread fields as used.
        Object.assign(window, { __NUXT_DEVTOOLS_DISABLE__: true })
      })
      const captured: DiagnosticIssue[] = []
      let dropped = false
      const record = (kind: 'error' | 'warning', message: string) => {
        if (captured.length >= 500) {
          dropped = true
          return
        }
        captured.push({ kind, message: message.slice(0, 10000) })
      }
      page.on('pageerror', error => record('error', error.message))
      page.on('console', (message) => {
        if (message.type() === 'error' || message.type() === 'warning')
          record(message.type() === 'error' ? 'error' : 'warning', message.text())
      })
      let incomplete: string | undefined
      const response = await page.goto(url, { waitUntil: 'load', timeout }).catch((error: unknown) => {
        incomplete = `Navigation failed: ${error instanceof Error ? error.message : String(error)}`
        record('error', incomplete)
        return null
      })
      if (response && !response.ok())
        record('error', `The route returned HTTP ${response.status()}.`)
      if (response?.ok()) {
        await page.waitForFunction(() => {
          const diagnostics = window.__NUXT_DX_DIAGNOSTICS__
          return diagnostics ? diagnostics.status !== 'pending' : window.__NUXT_DX_PAYLOAD__ !== undefined
        }, {}, { timeout }).catch((error: unknown) => {
          incomplete = `No hydration signal arrived. Check Nuxt DX configuration or increase --timeout. ${error instanceof Error ? error.message : String(error)}`
        })
      }
      const state = await page.evaluate(() => ({ diagnostics: window.__NUXT_DX_DIAGNOSTICS__, payload: window.__NUXT_DX_PAYLOAD__ }))
      const rich = state.diagnostics?.issues ?? []
      const hasHydration = rich.some(entry => entry.kind === 'hydration')
      const raw = captured.filter((entry) => {
        if (entry.kind === 'hydration')
          return true
        if (hasHydration && (entry.message === HYDRATION_SUMMARY_ERROR || entry.message.startsWith('[nuxt-dx] HYDRATION')))
          return false
        return !rich.some(item => item.kind !== 'hydration' && (entry.message === `[Vue warn]: ${item.message}` || entry.message === `[Vue error]: ${item.message}`))
      })
      const payload: PayloadUsageReport = state.payload ?? { status: 'unavailable', reason: 'Payload tracking is disabled or missing. For prerendered pages, enable payloadUsage.prerender and rebuild.' }
      if (dropped)
        incomplete = 'The page exceeded the limit of 500 console and browser diagnostics.'
      const report = createInspectionReport(page.url(), [...rich, ...raw], payload, incomplete)
      const json = `${JSON.stringify(report, null, 2)}\n`
      if (args.output)
        await writeFile(args.output, json)
      process.stdout.write(args.json ? json : formatInspectionReport(report))
      if (report.diagnostics.some(entry => entry.kind === 'error'))
        process.exitCode = 1
      else if (report.status === 'partial')
        process.exitCode = 2
    }
    finally {
      await browser.close()
    }
  },
})

/** Install the browser version matching this package, including with strict pnpm dependency isolation. */
export const installBrowser = defineCommand({
  meta: { name: 'install-browser', description: 'Install Chromium for route inspection' },
  async run() {
    const cli = fileURLToPath(new URL('./cli.js', import.meta.resolve('playwright')))
    const result = await promisify(execFile)(process.execPath, [cli, 'install', 'chromium'], { maxBuffer: 10 * 1024 * 1024 })
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
  },
})
