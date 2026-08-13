import { join } from 'node:path'

type NuxtLayer = { config?: { srcDir?: string } }

export const contentComponentDirectories = (layers: ReadonlyArray<NuxtLayer>) => [...layers]
  .reverse()
  .flatMap(layer => layer.config?.srcDir ? [join(layer.config.srcDir, 'components/content')] : [])
