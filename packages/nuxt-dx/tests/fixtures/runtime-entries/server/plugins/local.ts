export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('request', (event) => {
    event.context.localRuntimeBudget = 'plugin'
  })
})
