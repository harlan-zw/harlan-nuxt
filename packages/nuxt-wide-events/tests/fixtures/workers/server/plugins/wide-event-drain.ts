export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', (record) => {
    console.log(`Workerd Drain ${JSON.stringify(record)}`)
    return new Promise<void>(() => {})
  })
})
