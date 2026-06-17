export default defineEventHandler(async (event) => {
  const first = await event.$fetch('/api/telemetry/delay', {
    query: { label: 'waterfall-a', ms: 150 },
  })
  const second = await event.$fetch('/api/telemetry/delay', {
    query: { label: 'waterfall-b', ms: 150 },
  })

  return {
    kind: 'waterfall',
    results: [first, second],
  }
})
