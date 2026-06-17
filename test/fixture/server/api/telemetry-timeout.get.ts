export default defineEventHandler(async (event) => {
  try {
    await globalThis.$fetch(new URL('/api/telemetry-delay', getRequestURL(event)).href)
    return { timedOut: false }
  }
  catch (error) {
    return {
      name: error instanceof Error ? error.name : undefined,
      timedOut: true,
    }
  }
})
