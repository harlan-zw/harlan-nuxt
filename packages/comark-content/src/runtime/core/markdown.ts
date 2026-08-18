import type { Node } from 'comark'
import type { PageCollectionItemBase } from '../types'
import { renderMarkdown } from 'comark/render'
import { textContent } from 'comark/utils'

export interface RenderPageMarkdownOptions {
  /** Prepend the page frontmatter as a YAML block. @default false */
  frontmatter?: boolean
}

const isElement = (node: Node): node is Exclude<Node, string> => typeof node !== 'string' && node[0] !== null

const highlightClasses = new Set(['rangi', 'shiki'])

/**
 * Highlighted code carries the syntax spans, classes, and inline colours the
 * build added. Markdown has no place for them, so a plain render would emit an
 * MDC container around the fence. Rebuild the fence from the code text instead.
 */
const stripHighlight = (node: Node): Node => {
  if (!isElement(node))
    return node
  const [tag, attributes, ...children] = node
  if (tag !== 'pre') {
    return [tag, attributes, ...children.map(stripHighlight)] as Node
  }
  const classes = String(attributes.class ?? '').split(/\s+/).filter(Boolean)
  if (!classes.some(value => highlightClasses.has(value)))
    return node
  const { class: _class, style: _style, ...rest } = attributes
  const language = typeof rest.language === 'string' ? rest.language : undefined
  const code = children.map(child => textContent(child as Node)).join('')
  return ['pre', rest, ['code', language ? { class: `language-${language}` } : {}, code]] as Node
}

/**
 * Render a stored page body back to Markdown source.
 *
 * Build-time consumers (llms.txt indexers, search extractors) want the Markdown
 * a page was authored from without an SSR render. This is the inverse of the
 * ingestion parser, so it runs in process against the generated body asset.
 */
export const renderPageMarkdown = (
  body: PageCollectionItemBase['body'],
  options: RenderPageMarkdownOptions = {},
): Promise<string> => renderMarkdown(
  options.frontmatter
    ? { ...body, nodes: body.nodes.map(stripHighlight) }
    : { nodes: body.nodes.map(stripHighlight) },
)
