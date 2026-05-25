import { describe, expect, it } from 'vitest'
import { createContractQueryEnforcer, formatContractQueryViolations } from '../src/enforcement'

describe('contract query enforcer', () => {
  it('scans supplied source files through the factory adapter', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'app/components/DirectFetch.vue',
          source: '<script setup>const data = await $fetch("/api/sites")</script>',
        },
        {
          file: 'app/queries/sites.ts',
          source: 'export const sites = { detail: () => ({ path: "/api/sites/1" }) }',
        },
        {
          file: 'app/queries/users.ts',
          source: 'export const users = defineNuxtRpcQuery({ key: "users", path: "/api/users", response: userSchema })',
        },
        {
          file: 'app/queries/update.ts',
          source: 'import { siteSchema } from "@/shared/contracts/site"; export const update = defineNuxtRpcMutation({ method: "PATCH", path: "/api/sites/1", response: siteSchema })',
        },
      ],
    })

    const violations = await enforcer.scan('/app')

    expect(violations.map(violation => violation.code)).toEqual([
      'api-literal-outside-query',
      'query-file-without-operation',
      'missing-contract-import',
      'mutation-body-schema-missing',
    ])
  })

  it('checks server API contract imports when enabled', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'server/api/sites.get.ts',
          source: 'export default defineEventHandler(() => ({ ok: true }))',
        },
      ],
    })

    const violations = await enforcer.scan('/app', { requireServerContracts: true })

    expect(violations).toHaveLength(1)
    expect(violations[0]?.code).toBe('server-route-missing-contract')
  })

  it('formats violations via formatContractQueryViolations', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'app/components/DirectFetch.vue',
          source: '<script setup>const data = $fetch("/api/sites")</script>',
        },
      ],
    })

    const message = formatContractQueryViolations(await enforcer.scan('/app'))

    expect(message).toContain('nuxt-use-query contract enforcement failed:')
    expect(message).toContain('[api-literal-outside-query]')
  })

  it('detects template literal API paths in Vue and TypeScript files', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'app/components/TemplateFetch.vue',
          source: '<script setup lang="ts">await $fetch(`/api/sites/$\\{id}`)</script>',
        },
        {
          file: 'app/queries/template.ts',
          source: 'export const sites = { detail: () => ({ path: `/api/sites/$\\{id}` }) }',
        },
      ],
    })

    const violations = await enforcer.scan('/app')

    expect(violations.map(violation => violation.code)).toEqual([
      'api-literal-outside-query',
      'query-file-without-operation',
    ])
  })

  it('does not flag API-looking text in comments or non-configured prefixes', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'app/components/Docs.vue',
          source: '<script setup lang="ts">// /api/pro/sites is documentation only\nconst label = "GET /api/pro/sites"</script>',
        },
        {
          file: 'app/components/PublicFetch.vue',
          source: '<script setup lang="ts">await $fetch("/api/public/sites")</script>',
        },
      ],
    })

    const violations = await enforcer.scan('/app', { apiPrefixes: ['/api/private'] })

    expect(violations).toEqual([])
  })

  it('supports member-expression operation helpers', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [
        {
          file: 'app/queries/sites.ts',
          source: `
            import { siteSchema } from '@/shared/contracts/site'
            export const sites = {
              detail: () => query.defineNuxtRpcQuery({
                key: ['sites'],
                path: '/api/sites',
                response: siteSchema,
              }),
            }
          `,
        },
      ],
    })

    const violations = await enforcer.scan('/app')

    expect(violations).toEqual([])
  })
})
