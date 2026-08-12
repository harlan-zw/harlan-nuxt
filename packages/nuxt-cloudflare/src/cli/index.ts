#!/usr/bin/env node
import process from 'node:process'
import { defineCommand, runMain } from 'citty'
import { resolve } from 'pathe'
import { evaluateWranglerDiagnostics, parseWranglerAllowedWarnings } from '../diagnostics'
import { diagnoseWranglerProject } from '../doctor'
import { formatWranglerDiagnostics } from '../wrangler'

const doctor = defineCommand({
  meta: { name: 'doctor', description: 'Audit the effective Wrangler configuration' },
  args: {
    'cwd': { type: 'string', description: 'Project directory', default: '.' },
    'config': { type: 'string', description: 'Wrangler config path' },
    'env': { type: 'string', description: 'Wrangler environment' },
    'json': { type: 'boolean', description: 'Print JSON diagnostics', default: false },
    'max-compatibility-age': { type: 'string', description: 'Compatibility date policy in days', default: '90' },
    'node-compat': { type: 'string', description: 'Node compatibility policy: required or ignore', default: 'required' },
    'public-var': { type: 'string', description: 'Comma-separated public var names exempt from secret-name heuristics' },
    'strict': { type: 'boolean', description: 'Fail on warnings as well as errors', default: false },
    'allow-warning': { type: 'string', description: 'Comma-separated warning codes allowed in strict mode' },
  },
  run({ args }) {
    const cwd = resolve(args.cwd)
    const compatibilityMaxAgeDays = Number(args['max-compatibility-age'])
    if (!Number.isSafeInteger(compatibilityMaxAgeDays) || compatibilityMaxAgeDays < 1)
      throw new TypeError('--max-compatibility-age must be a positive integer')
    if (args['node-compat'] !== 'required' && args['node-compat'] !== 'ignore')
      throw new TypeError('--node-compat must be required or ignore')
    const publicVarNames = args['public-var']?.split(',').map(value => value.trim()).filter(Boolean)
    const result = diagnoseWranglerProject({
      cwd,
      config: args.config,
      environment: args.env,
      compatibilityMaxAgeDays,
      publicVarNames,
      requireNodeCompat: args['node-compat'] === 'required',
    })
    const allowedWarnings = parseWranglerAllowedWarnings(args['allow-warning'])
    const policy = args.strict
      ? { _tag: 'strict' as const, allowedWarnings }
      : { _tag: 'advisory' as const }
    const outcome = evaluateWranglerDiagnostics(result.diagnostics, policy)
    const payload = {
      configPath: result.configPath,
      diagnostics: result.diagnostics,
      outcome: outcome._tag,
      ...(outcome._tag === 'failed' ? { reason: outcome.reason } : {}),
      schemaVersion: outcome.schemaVersion,
      sourceConfigPaths: result.sourceConfigPaths,
      strict: args.strict,
    }
    if (args.json)
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    else if (result.diagnostics.length === 0)
      process.stdout.write(`Cloudflare config valid: ${result.configPath ?? 'inline/default'}\n`)
    else
      process.stdout.write(`${formatWranglerDiagnostics(result.diagnostics)}\n`)
    if (outcome._tag === 'failed')
      process.exitCode = 1
  },
})

const main = defineCommand({
  meta: {
    name: 'nuxt-cloudflare',
    version: '0.0.12',
    description: 'Cloudflare deployment defaults and diagnostics for Nuxt',
  },
  subCommands: { doctor },
})

runMain(main)
