// Multiple crons, one of which is shared with db:cleanup ('0 3 * * *').
export default defineScheduledTask({
  name: 'search:reindex',
  cron: ['0 */6 * * *', '0 3 * * *'],
  run() {
    return { result: 'ok' }
  },
})
