export default defineScheduledTask({
  name: 'db:cleanup',
  cron: '0 3 * * *',
  description: 'Nightly cleanup',
  run() {
    return { result: 'ok' }
  },
})
