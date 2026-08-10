import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: ['src/module'],
  externals: ['#app', '#imports', 'nitropack', 'nitropack/runtime'],
})
