import { join } from 'node:path'

type NuxtLayer = { config?: { srcDir?: string, dir?: { app?: string } } }

export const contentComponentDirectories = (layers: ReadonlyArray<NuxtLayer>) => [...layers]
  .reverse()
  .flatMap((layer) => {
    const srcDir = layer.config?.srcDir
    if (!srcDir)
      return []
    const appDir = layer.config?.dir?.app ?? 'app'
    return [
      join(srcDir, appDir, 'components/content'),
      join(srcDir, 'components/content'),
    ]
  })
