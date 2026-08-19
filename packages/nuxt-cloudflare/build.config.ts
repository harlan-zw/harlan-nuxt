import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/bindings',
    'src/cache',
    'src/d1',
    'src/d1-stats',
    'src/deploy',
    'src/storage',
    'src/wrangler',
    'src/cli/index',
  ],
  externals: ['wrangler'],
})
