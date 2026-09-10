import { describe, expect, it } from 'vitest'
import { isReportingHandler, planTaskReporting } from '../src/build/tasks'

/**
 * The build side of task reporting: the registry rewrite that points each
 * Nitro task at a wrapper. A site never writes this code, so the plan is what
 * proves every registered task gets reported.
 */

const WRAPPER = '/mod/dist/runtime/server/task'

describe('planTaskReporting', () => {
  it('wraps a task a module registered from inside its own package', () => {
    const [plan] = planTaskReporting({
      'ai-ready:cron': { handler: '/pkg/nuxt-ai-ready/dist/runtime/server/tasks/ai-ready-cron' },
    }, WRAPPER)

    expect(plan!.name).toBe('ai-ready:cron')
    expect(plan!.code).toContain(`import { withSentryTask } from "${WRAPPER}"`)
    expect(plan!.code).toContain('import task from "/pkg/nuxt-ai-ready/dist/runtime/server/tasks/ai-ready-cron"')
    expect(plan!.code).toContain('export default withSentryTask(task)')
  })

  it('gives the wrapper an id without the colon Nitro puts in a task name', () => {
    const [plan] = planTaskReporting({ 'rate-limits:cleanup': { handler: '/site/server/tasks/rate-limits/cleanup.ts' } }, WRAPPER)

    expect(plan!.id).toBe('#nuxt-sentry/tasks/rate-limits-cleanup')
    expect(isReportingHandler(plan!.id)).toBe(true)
  })

  it('skips a task that has no handler, which Nitro warns about itself', () => {
    expect(planTaskReporting({ ghost: {} }, WRAPPER)).toEqual([])
  })

  it('leaves a task alone once its handler is already a wrapper', () => {
    const first = planTaskReporting({ 'a:b': { handler: '/site/a/b.ts' } }, WRAPPER)
    const synced = { 'a:b': { handler: first[0]!.id } }

    expect(planTaskReporting(synced, WRAPPER)).toEqual([])
  })

  it('keeps two names that slug alike apart', () => {
    const plans = planTaskReporting({
      'a:b': { handler: '/site/a/b.ts' },
      'a-b': { handler: '/site/a-b.ts' },
    }, WRAPPER)

    expect(new Set(plans.map(plan => plan.id)).size).toBe(2)
  })
})
