export default defineEventHandler(async (event) => {
  return await event.$fetch('/api/telemetry-depth/two')
})
