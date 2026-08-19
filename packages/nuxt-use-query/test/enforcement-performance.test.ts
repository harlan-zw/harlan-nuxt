import { beforeEach, describe, expect, it, vi } from 'vitest'

const visitSpy = vi.hoisted(() => vi.fn())

vi.mock('vite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vite')>()
  class TrackingVisitor extends actual.Visitor {
    override visit(...args: Parameters<InstanceType<typeof actual.Visitor>['visit']>) {
      visitSpy()
      return super.visit(...args)
    }
  }
  return {
    ...actual,
    Visitor: TrackingVisitor,
  }
})

const { createContractQueryEnforcer } = await import('../src/enforcement/scan')

describe('contract enforcement performance', () => {
  beforeEach(() => visitSpy.mockClear())

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
    expect(visitSpy).toHaveBeenCalledOnce()
  })
})
