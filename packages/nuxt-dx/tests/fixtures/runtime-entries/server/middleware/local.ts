export default defineEventHandler((event) => {
  event.context.localRuntimeBudget = 'middleware'
})
