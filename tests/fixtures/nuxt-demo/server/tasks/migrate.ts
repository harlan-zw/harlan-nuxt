// Plain nitro task: a name but no cron. Should be registered as a runnable
// task handler but never scheduled.
export default defineTask({
  meta: {
    name: 'db:migrate',
    description: 'Manual migration (run on demand)',
  },
  run() {
    return { result: 'ok' }
  },
})
