export default defineEventHandler(async (event) => {
  const query = getQuery(event)
  const ms = clampDelay(query.ms)
  await new Promise(resolve => setTimeout(resolve, ms))
  return {
    label: String(query.label ?? 'delay'),
    ms,
  }
})

function clampDelay(input: unknown): number {
  const ms = Number(input ?? 150)
  if (!Number.isFinite(ms))
    return 150
  return Math.min(Math.max(ms, 0), 2_000)
}
