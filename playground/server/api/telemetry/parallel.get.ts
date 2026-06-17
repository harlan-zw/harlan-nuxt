export default defineEventHandler(async (event) => {
  const results = await Promise.all([
    event.$fetch('/api/telemetry/delay', {
      query: { label: 'parallel-a', ms: 150 },
    }),
    event.$fetch('/api/telemetry/delay', {
      query: { label: 'parallel-b', ms: 150 },
    }),
  ])

  return {
    kind: 'parallel',
    results,
  }
})
