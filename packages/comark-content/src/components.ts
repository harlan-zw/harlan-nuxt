import { isAbsolute, join, relative, sep } from 'node:path'
import { componentCandidates, componentMatchesTag } from './runtime/components/names'

interface NuxtLayer { config?: { srcDir?: string, dir?: { app?: string } } }

export function contentComponentDirectories(layers: ReadonlyArray<NuxtLayer>) {
  return [...layers]
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
}

export interface ScannedComponent {
  pascalName: string
  filePath: string
  export?: string
  global?: boolean | 'sync'
}

function kebabCase(value: string) {
  return value
    .replaceAll(/([a-z\d])([A-Z])/g, '$1-$2')
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, '$1-$2')
    .toLowerCase()
}

function isWithin(directory: string, filePath: string) {
  const path = relative(directory, filePath)
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

export function localizeNuxtUiProseComponents<T extends ScannedComponent>(components: ReadonlyArray<T>): T[] {
  return components.map(component => component.filePath
    .replaceAll('\\', '/')
    .includes('/@nuxt/ui/dist/runtime/components/prose/')
    ? { ...component, global: false }
    : component)
}

export interface SelectedContentComponent {
  tag: string
  component: ScannedComponent
}

export function selectContentComponents(tags: ReadonlySet<string>, scannedComponents: ReadonlyArray<ScannedComponent>): SelectedContentComponent[] {
  const components = new Map(scannedComponents.map(component => [component.pascalName, component]))
  return [...tags].sort().flatMap((tag) => {
    const component = componentCandidates(tag).map(name => components.get(name)).find(Boolean)
      ?? [...components.values()].find(value => componentMatchesTag(tag, value.pascalName))
    return !component || component.filePath.endsWith('.css') ? [] : [{ tag, component }]
  })
}

export function addUnprefixedContentAliases<T extends ScannedComponent & { kebabName: string }>(components: ReadonlyArray<T>, directories: ReadonlyArray<string>): T[] {
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

export function renderComponentManifest(tags: ReadonlySet<string>, scannedComponents: ReadonlyArray<ScannedComponent>, templateDir: string) {
  const selected = selectContentComponents(tags, scannedComponents)
  const imports = selected.map(({ component }, index) => {
    const importPath = isAbsolute(component.filePath)
      ? `./${relative(templateDir, component.filePath).replaceAll('\\', '/')}`
      : component.filePath
    return `import * as component${index} from ${JSON.stringify(importPath)}`
  })
  const entries = selected.map(({ tag, component }, index) => `${JSON.stringify(tag)}: { name: ${JSON.stringify(component.pascalName)}, component: component${index}[${JSON.stringify(component.export || 'default')}] }`)
  return `${imports.join('\n')}\n\nexport default {\n  ${entries.join(',\n  ')}\n}\n`
}
