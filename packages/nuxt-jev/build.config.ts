import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/schema',
  ],
  externals: [
    '#imports',
    'nitropack',
    'nitropack/types',
  ],
})
