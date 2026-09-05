import type { TaskFailureReport } from '../src/runtime/shared/task'
import { describe, expect, it, vi } from 'vitest'
import { describeTaskFailure, resolveTaskName, withTaskReporting } from '../src/runtime/shared/task'

/**
 * A scheduled task is the one path the Nitro plugin cannot see. Nitro's
 * `runTask` calls no hook, so these cover the wrapper that stands in for it.
 */

function captured() {
  const reports: TaskFailureReport[] = []
  return { reports, capture: (report: TaskFailureReport) => void reports.push(report) }
}

describe('task failure reporting', () => {
  it('reports the failure and still throws, so the scheduler sees it', async () => {
    const { reports, capture } = captured()
    const boom = new Error('D1_ERROR: no such table')
    const task = withTaskReporting({ meta: { name: 'ai-ready:cron' }, run: () => Promise.reject(boom) }, capture)

    await expect(task.run({})).rejects.toThrow(boom)
    expect(reports).toHaveLength(1)
    expect(reports[0]!.error).toBe(boom)
  })

  it('tags the failure with the task name so one task groups together', async () => {
    const { reports, capture } = captured()
    const task = withTaskReporting({ meta: { name: 'ai-ready:cron' }, run: () => Promise.reject(new Error('x')) }, capture)

    await expect(task.run({})).rejects.toThrow()
    expect(reports[0]!.tags).toEqual({ task: 'ai-ready:cron' })
    expect(reports[0]!.context.nitro_task).toEqual({ name: 'ai-ready:cron' })
  })

  it('reports nothing when the task succeeds', async () => {
    const { reports, capture } = captured()
    const task = withTaskReporting({ meta: { name: 'ok' }, run: async () => ({ result: 1 }) }, capture)

    await expect(task.run({})).resolves.toEqual({ result: 1 })
    expect(reports).toHaveLength(0)
  })

  it('reports a task that throws synchronously', async () => {
    const { reports, capture } = captured()
    const task = withTaskReporting({
      meta: { name: 'sync' },
      run: () => {
        throw new Error('immediate')
      },
    }, capture)

    await expect(task.run({})).rejects.toThrow('immediate')
    expect(reports).toHaveLength(1)
  })

  it('keeps the task error when reporting itself fails', async () => {
    const boom = new Error('the real failure')
    const task = withTaskReporting({
      meta: { name: 'x' },
      run: () => Promise.reject(boom),
    }, () => {
      throw new Error('sentry is down')
    })

    await expect(task.run({})).rejects.toThrow(boom)
  })

  it('preserves the task meta so Nitro still registers it', () => {
    const task = withTaskReporting({ meta: { name: 'n', description: 'd' }, run: async () => 1 }, vi.fn())

    expect(task.meta).toEqual({ name: 'n', description: 'd' })
  })

  it('falls back to the name Nitro passes when the task declares none', async () => {
    const { reports, capture } = captured()
    const task = withTaskReporting({ run: () => Promise.reject(new Error('x')) }, capture)

    await expect(task.run({ name: 'from-nitro' })).rejects.toThrow()
    expect(reports[0]!.tags.task).toBe('from-nitro')
  })

  it('names an unnamed task rather than reporting an empty tag', () => {
    expect(resolveTaskName({ run: async () => 1 })).toBe('unknown')
    expect(describeTaskFailure('a:b', new Error('x')).tags.task).toBe('a:b')
  })
})
