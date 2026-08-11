export default defineEventHandler((event) => {
  event.context.ownedRuntimeBudget = 'middleware'
})
