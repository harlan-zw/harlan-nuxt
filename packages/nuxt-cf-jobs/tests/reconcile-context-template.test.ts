import { describe, expect, it } from 'vitest'
import { renderReconcileContextProxy } from '../src/module'

describe('renderReconcileContextProxy', () => {
  it('keeps the default reconciler runtime-neutral when no adapter is configured', () => {
    expect(renderReconcileContextProxy('/app')).toBe('export const createReconcileJobContext = undefined\n')
  })

  it('generates a static application adapter import', () => {
    expect(renderReconcileContextProxy('/app', './server/reconcile-context.ts')).toBe(
      'export { createReconcileJobContext } from "/app/server/reconcile-context.ts"\n',
    )
  })
})
