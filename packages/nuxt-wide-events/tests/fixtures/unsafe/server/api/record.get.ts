export default defineEventHandler((event) => {
  addWideEventFields(event, {
    password: 'secret',
  })

  return { recorded: true }
})
