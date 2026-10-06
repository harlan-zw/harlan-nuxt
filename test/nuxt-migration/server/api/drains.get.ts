import { createWideEvent } from '@harlan-zw/nuxt-wide-events/standalone'
import { defineEventHandler } from 'nuxt/server'
import { drainEvidence } from '../utils/drain-evidence'

export default defineEventHandler(async () => {
  drainEvidence.length = 0
  const error = await Promise.resolve(createWideEvent().emit()).then(() => undefined, (error: unknown) => {
    if (!(error instanceof Error) || error.message !== 'migration-sink-failed')
      throw error
    return error.message
  })
  return { error, delivered: drainEvidence }
})
