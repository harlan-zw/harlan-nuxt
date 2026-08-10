export default defineEventHandler(async (event) => {
  return await event.$fetch('/api/telemetry-stack-child', {
    query: {
      token: 'fixture-secret-token',
    },
  })
})
