export default defineEventHandler((event) => {
  addWideEventFields(event, {
    'worker.ok': true,
  })
  return { recorded: true }
})
