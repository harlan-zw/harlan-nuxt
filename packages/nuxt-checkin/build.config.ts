import { defineBuildConfig } from 'unbuild'

export default defineBuildConfig({
  entries: ['src/module', 'src/cli/index'],
  externals: ['#imports', 'nitropack', 'nitropack/types'],
})
