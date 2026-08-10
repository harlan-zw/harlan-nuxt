export default defineEventHandler(async (event) => {
  if (getHeader(event, 'x-telemetry-recursive-stop'))
    return { stopped: true }
  return await event.$fetch('/api/telemetry-recursive', {
    headers: {
      'x-telemetry-recursive-stop': '1',
    },
  })
})
