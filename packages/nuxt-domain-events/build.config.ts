import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/build/index',
  ],
  externals: [
    '#app',
    '#imports',
    'nitropack',
    'nitropack/types',
  ],
})
