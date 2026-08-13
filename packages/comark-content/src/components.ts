import { isAbsolute, join, relative } from 'node:path'
import { componentCandidates, componentMatchesTag } from './runtime/components/names'

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

type ScannedComponent = {
  pascalName: string
  filePath: string
  export?: string
}

export const renderComponentManifest = (
  tags: ReadonlySet<string>,
  scannedComponents: ReadonlyArray<ScannedComponent>,
  templateDir: string,
) => {
  const components = new Map(scannedComponents.map(component => [component.pascalName, component]))
  const entries = [...tags].flatMap((tag) => {
    const component = componentCandidates(tag).map(name => components.get(name)).find(Boolean)
      ?? [...components.values()].find(value => componentMatchesTag(tag, value.pascalName))
    if (!component || component.filePath.endsWith('.css'))
      return []
    const importPath = isAbsolute(component.filePath)
      ? `./${relative(templateDir, component.filePath).replaceAll('\\', '/')}`
      : component.filePath
    const exportName = component.export || 'default'
    return [`${JSON.stringify(tag)}: { name: ${JSON.stringify(component.pascalName)}, load: () => import(${JSON.stringify(importPath)}).then(module => module[${JSON.stringify(exportName)}]) }`]
  })
  return `export default {\n  ${entries.join(',\n  ')}\n}\n`
}
