import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/schema',
    'src/eval',
  ],
  externals: [
    '#imports',
    'nitropack',
    'nitropack/types',
  ],
})
