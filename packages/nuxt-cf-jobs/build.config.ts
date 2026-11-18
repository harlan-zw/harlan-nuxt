import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: [
    'src/module',
    'src/checks',
    'src/cli/index',
  ],
  externals: [
    '#app',
    '#imports',
    'node:sqlite',
    'nitropack',
    'nitropack/types',
  ],
})
