import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/build/index',
  ],
  externals: [
    '#imports',
    '#wide-events/config',
    'nitropack',
    'nitropack/types',
  ],
})
