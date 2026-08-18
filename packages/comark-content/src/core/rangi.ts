import type { MarkdownDocument, Node } from 'comark'

export { contentRangiLanguages, contentRangiTheme } from '../runtime/shared/rangi-theme'

function addThemeVariables(node: Node, inRangi = false): void {
  if (typeof node === 'string' || node[0] === null)
    return
  const [tag, attributes, ...children] = node
  const rangi = inRangi || (tag === 'pre' && typeof attributes.class === 'string' && attributes.class.split(/\s+/).includes('rangi'))
  if (rangi && tag === 'span' && typeof attributes.style === 'string' && !attributes.style.includes('--shiki-light:')) {
    const light = /(?:^|;)color:([^;]+)/.exec(attributes.style)?.[1]
    if (light)
      attributes.style = `--shiki-light:${light};--shiki-default:${light};${attributes.style}`
  }
  for (const child of children)
    addThemeVariables(child as Node, rangi)
}

export function normalizeRangiThemeVariables(document: MarkdownDocument): MarkdownDocument {
  for (const node of document.nodes)
    addThemeVariables(node)
  return document
}
