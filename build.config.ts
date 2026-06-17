import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  externals: [
    '#app',
    'nitropack',
    'nitropack/runtime',
    'nitropack/types',
  ],
})
