import type { Node } from 'comark'
import { describe, expect, it } from 'vitest'
import { nodeToText, walkNodes } from '../src/runtime/core/ast'

const document: Node[] = [
  ['h1', { id: 'guide' }, 'The ', ['em', {}, 'short'], ' guide'],
  ['p', {}, 'Read ', ['a', { href: '/next' }, 'the next page'], '.'],
]

describe('markdown AST helpers', () => {
  it('joins the text of a node and its descendants', () => {
    expect(nodeToText(document[0]!)).toBe('The short guide')
    expect(nodeToText('plain')).toBe('plain')
  })

  it('visits every node in document order', () => {
    const tags: string[] = []
    walkNodes(document, node => tags.push(typeof node === 'string' ? `#${node}` : String(node[0])))

    expect(tags).toEqual(['h1', '#The ', 'em', '#short', '# guide', 'p', '#Read ', 'a', '#the next page', '#.'])
  })
})
