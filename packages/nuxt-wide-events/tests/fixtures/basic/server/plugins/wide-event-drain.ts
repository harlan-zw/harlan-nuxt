export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await Promise.resolve()
    console.log(`D1 Wide Event ${JSON.stringify(record)}`)
    if (record['user.id'] === 'standalone_1')
      throw new Error('D1 unavailable')
  })
  nitroApp.hooks.hook('wide-events:emit', async (record) => {
    await Promise.resolve()
    console.log(`Sentry Wide Event ${JSON.stringify(record)}`)
  })
})
