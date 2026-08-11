import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  evaluateWranglerDiagnostics,
  isWranglerDiagnosticBlocking,
  parseWranglerAllowedWarnings,
} from '../src/diagnostics'
import { diagnoseWranglerProject } from '../src/doctor'

describe('diagnoseWranglerProject', () => {
  it('warns when the authored config uses legacy TOML even if Wrangler can load it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-doctor-'))
    await mkdir(join(root, 'apps/site'), { recursive: true })
    await writeFile(join(root, 'wrangler.toml'), [
      'compatibility_date = "2026-08-11"',
      'compatibility_flags = ["nodejs_compat"]',
      'workers_dev = false',
      'upload_source_maps = true',
      '[observability]',
      'enabled = true',
      '[version_metadata]',
      'binding = "CF_VERSION_METADATA"',
    ].join('\n'))

    try {
      const result = diagnoseWranglerProject({ cwd: join(root, 'apps/site'), now: new Date('2026-08-11T00:00:00Z') })

      expect(result.sourceConfigPaths).toEqual([join(root, 'wrangler.toml')])
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        _tag: 'info',
        code: 'wrangler-jsonc-preferred',
        sourcePath: join(root, 'wrangler.toml'),
      }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('reports a missing effective config with a build-first action', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-doctor-'))

    try {
      expect(diagnoseWranglerProject({ cwd: root }).diagnostics).toContainEqual(expect.objectContaining({
        _tag: 'error',
        code: 'wrangler-config-missing',
      }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('warns when multiple root configs can drift behind Wrangler precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-doctor-'))
    await writeFile(join(root, 'wrangler.jsonc'), '{}')
    await writeFile(join(root, 'wrangler.toml'), 'name = "shadowed"')

    try {
      const result = diagnoseWranglerProject({ cwd: root, now: new Date('2026-08-11T00:00:00Z') })
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        _tag: 'warning',
        code: 'wrangler-config-shadowed',
      }))
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })

  it('never includes raw Wrangler values in an unreadable-config diagnostic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'nuxt-cloudflare-doctor-'))
    await writeFile(join(root, 'wrangler.jsonc'), JSON.stringify({
      compatibility_date: { token: 'SENSITIVE_ABC123' },
    }))

    try {
      const result = diagnoseWranglerProject({ cwd: root })
      expect(result.diagnostics).toContainEqual(expect.objectContaining({
        _tag: 'error',
        code: 'wrangler-config-unreadable',
      }))
      expect(JSON.stringify(result)).not.toContain('SENSITIVE_ABC123')
    }
    finally {
      await rm(root, { force: true, recursive: true })
    }
  })
})

describe('isWranglerDiagnosticBlocking', () => {
  const warning = {
    _tag: 'warning' as const,
    code: 'source-maps-disabled' as const,
    message: 'Enable source maps.',
    configPath: 'upload_source_maps',
  }

  it('blocks errors in advisory mode and all non-allowed warnings in strict mode', () => {
    expect(isWranglerDiagnosticBlocking(warning, { _tag: 'advisory' })).toBe(false)
    expect(isWranglerDiagnosticBlocking(warning, { _tag: 'strict' })).toBe(true)
    expect(isWranglerDiagnosticBlocking(warning, {
      _tag: 'strict',
      allowedWarnings: ['source-maps-disabled'],
    })).toBe(false)
    expect(isWranglerDiagnosticBlocking({ ...warning, _tag: 'error' }, {
      _tag: 'strict',
      allowedWarnings: ['source-maps-disabled'],
    })).toBe(true)
  })

  it('parses known CLI allowances and rejects typos', () => {
    expect(parseWranglerAllowedWarnings('source-maps-disabled, stale-compatibility-date'))
      .toEqual(['source-maps-disabled', 'stale-compatibility-date'])
    expect(() => parseWranglerAllowedWarnings('source-map-disabled')).toThrow(/Unknown Wrangler diagnostic code/)
  })

  it('returns one versioned outcome for CLI and build consumers', () => {
    const information = {
      _tag: 'info' as const,
      code: 'wrangler-jsonc-preferred' as const,
      message: 'Prefer JSONC for new projects.',
      sourcePath: 'wrangler.toml',
    }
    expect(evaluateWranglerDiagnostics([information], { _tag: 'strict' })).toMatchObject({
      _tag: 'passed',
      schemaVersion: 1,
    })
    expect(evaluateWranglerDiagnostics([warning], { _tag: 'advisory' })).toMatchObject({
      _tag: 'passed',
      schemaVersion: 1,
    })
    expect(evaluateWranglerDiagnostics([warning], { _tag: 'strict' })).toMatchObject({
      _tag: 'failed',
      reason: 'strict-warnings',
      schemaVersion: 1,
    })
    expect(evaluateWranglerDiagnostics([{ ...warning, _tag: 'error' }], { _tag: 'strict' })).toMatchObject({
      _tag: 'failed',
      reason: 'errors',
      schemaVersion: 1,
    })
  })
})
