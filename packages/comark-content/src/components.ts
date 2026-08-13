import { isAbsolute, join, relative, sep } from 'node:path'
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

const kebabCase = (value: string) => value
  .replaceAll(/([a-z\d])([A-Z])/g, '$1-$2')
  .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
  .toLowerCase()

const inferredTags = (component: ScannedComponent): string[] => {
  const contentComponent = component.filePath.replaceAll('\\', '/').includes('/components/content/')
  let name = component.pascalName
  if (name.startsWith('LazyContent'))
    name = `Lazy${name.slice('LazyContent'.length)}`
  else if (name.startsWith('Content'))
    name = name.slice('Content'.length)
  else if (!contentComponent && !name.startsWith('Prose'))
    return []
  if (name.startsWith('Prose'))
    name = name.slice('Prose'.length)
  const kebab = kebabCase(name)
  return [...new Set([kebab, kebab.replaceAll('-', '')])]
}

const isWithin = (directory: string, filePath: string) => {
  const path = relative(directory, filePath)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export const addUnprefixedContentAliases = <T extends ScannedComponent & { kebabName: string }>(
  components: ReadonlyArray<T>,
  directories: ReadonlyArray<string>,
): T[] => {
  const names = new Set(components.map(component => component.pascalName))
  return components.flatMap((component) => {
    if (!component.pascalName.startsWith('Content') || !directories.some(directory => isWithin(directory, component.filePath)))
      return [component]
    const pascalName = component.pascalName.slice('Content'.length)
    if (!pascalName || names.has(pascalName))
      return [component]
    names.add(pascalName)
    return [component, { ...component, pascalName, kebabName: kebabCase(pascalName) } as T]
  })
}

export const renderComponentManifest = (
  tags: ReadonlySet<string>,
  scannedComponents: ReadonlyArray<ScannedComponent>,
  templateDir: string,
) => {
  const components = new Map(scannedComponents.map(component => [component.pascalName, component]))
  const renderTags = new Set([...tags, ...scannedComponents.flatMap(inferredTags)])
  const entries = [...renderTags].sort().flatMap((tag) => {
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
