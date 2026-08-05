import { vi } from 'vitest'

export const createQueuedEventListenerContext = vi.fn(async () => ({
  idempotency: {
    run: async (_input: unknown, effect: () => Promise<unknown>) => ({ _tag: 'executed' as const, value: await effect() }),
  },
}))
