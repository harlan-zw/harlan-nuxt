import { beforeEach, describe, expect, it, vi } from 'vitest'

const walkSpy = vi.hoisted(() => vi.fn())

vi.mock('oxc-walker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('oxc-walker')>()
  return {
    ...actual,
    walk: (...args: Parameters<typeof actual.walk>) => {
      walkSpy()
      return actual.walk(...args)
    },
  }
})

const { createContractQueryEnforcer } = await import('../src/enforcement/scan')

describe('contract enforcement performance', () => {
  beforeEach(() => walkSpy.mockClear())

  it('analyzes each parsed file with one AST traversal', async () => {
    const enforcer = createContractQueryEnforcer({
      readSourceFiles: async () => [{
        file: 'app/queries/site.ts',
        source: `
          import { site } from '@/shared/contracts/site'
          export const query = defineNuxtRpcQuery({
            key: 'site',
            path: '/api/site',
            response: site,
          })
        `,
      }],
    })

    await expect(enforcer.scan('.')).resolves.toEqual([])
    expect(walkSpy).toHaveBeenCalledOnce()
  })
})
