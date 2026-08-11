import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  failOnWarn: false,
  entries: ['src/module', 'src/cli/index'],
  externals: ['#app', '#imports'],
})
