export default defineEventHandler(async (event) => {
  const result = await event.$fetch('/api/telemetry/delay', {
    query: { label: 'slow', ms: 150 },
  })
  return {
    kind: 'slow',
    result,
  }
})
