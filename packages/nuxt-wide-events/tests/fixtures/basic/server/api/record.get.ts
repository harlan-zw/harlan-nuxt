export default defineEventHandler((event) => {
  addWideEventFields(event, {
    'cache.hit': true,
    'user.id': 'user_1',
  })

  return { recorded: true }
})
