#!/usr/bin/env node
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { resolve } from 'pathe'
import { diagnoseWranglerConfig, formatWranglerDiagnostics } from '../wrangler'
import { readProjectWranglerConfig } from '../wrangler-reader'

const doctor = defineCommand({
  meta: { name: 'doctor', description: 'Audit the effective Wrangler configuration' },
  args: {
    'cwd': { type: 'string', description: 'Project directory', default: '.' },
    'config': { type: 'string', description: 'Wrangler config path' },
    'env': { type: 'string', description: 'Wrangler environment' },
    'json': { type: 'boolean', description: 'Print JSON diagnostics', default: false },
    'max-compatibility-age': { type: 'string', description: 'Compatibility date policy in days', default: '90' },
  },
  run({ args }) {
    const cwd = resolve(args.cwd)
    const loaded = readProjectWranglerConfig({ cwd, config: args.config, environment: args.env })
    const diagnostics = diagnoseWranglerConfig(loaded.config, {
      compatibilityMaxAgeDays: Number(args['max-compatibility-age']),
    })
    const payload = { configPath: loaded.path, diagnostics }
    if (args.json)
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else if (diagnostics.length === 0)
      process.stdout.write(`Cloudflare config valid: ${loaded.path ?? 'inline/default'}\n`)
    else
      process.stdout.write(`${formatWranglerDiagnostics(diagnostics)}\n`)
    if (diagnostics.some(diagnostic => diagnostic._tag === 'error'))
      process.exitCode = 1
  },
})

const main = defineCommand({
  meta: {
    name: 'nuxt-cloudflare',
    version: '0.0.1',
    description: 'Cloudflare deployment defaults and diagnostics for Nuxt',
  },
  subCommands: { doctor },
})

runMain(main)
