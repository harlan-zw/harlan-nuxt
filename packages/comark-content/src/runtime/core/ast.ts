import type { Node } from 'comark'

export type NodeVisitor = (node: Node) => void

/**
 * Calls `visit` for every node in document order.
 * The visitor sees each parent before its children.
 */
export function walkNodes(nodes: readonly Node[], visit: NodeVisitor): void {
  for (const node of nodes) {
    visit(node)
    if (typeof node !== 'string')
      walkNodes(node.slice(2) as Node[], visit)
  }
}

/** Joins the text of a node and every descendant. */
export function nodeToText(node: Node): string {
  return typeof node === 'string'
    ? node
    : node.slice(2).map(child => nodeToText(child as Node)).join('')
}
