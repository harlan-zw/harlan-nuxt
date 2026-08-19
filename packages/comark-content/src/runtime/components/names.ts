import type { Node } from 'comark'

export const htmlTags = new Set([
  'a',
  'blockquote',
  'br',
  'code',
  'del',
  'details',
  'div',
  'em',
  'figcaption',
  'figure',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'head',
  'hr',
  'iframe',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strong',
  'summary',
  'table',
  'tbody',
  'td',
  'template',
  'th',
  'thead',
  'tr',
  'ul',
])

const pascalCase = (value: string) => value.split(/[-_:]/).filter(Boolean).map(part => part[0]?.toUpperCase() + part.slice(1)).join('')

export function componentCandidates(tag: string): string[] {
  const name = pascalCase(tag)
  if (htmlTags.has(tag))
    return [`ContentProse${name}`, `Prose${name}`]
  const candidates = [`Content${name}`, `Prose${name}`, name]
  if (name.startsWith('Lazy')) {
    const eagerName = name.slice('Lazy'.length)
    candidates.push(`Content${eagerName}`, `Prose${eagerName}`, eagerName, `LazyContent${eagerName}`)
  }
  return candidates
}

export function componentMatchesTag(tag: string, componentName: string): boolean {
  const candidates = componentCandidates(tag)
  if (candidates.includes(componentName) || candidates.some(candidate => `Content${candidate}` === componentName))
    return true
  const normalizedTag = tag.replaceAll(/[-_:]/g, '').toLowerCase()
  return componentName.startsWith('Content') && componentName.slice('Content'.length).toLowerCase() === normalizedTag
}

export function collectComponentTags(nodes: readonly Node[]): string[] {
  const tags = new Set<string>()
  const visit = (node: Node) => {
    if (typeof node === 'string' || node[0] === null)
      return
    tags.add(node[0])
    for (const child of node.slice(2))
      visit(child as Node)
  }
  for (const node of nodes)
    visit(node)
  return [...tags]
}
