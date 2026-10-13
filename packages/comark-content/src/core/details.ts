import type { ComarkPlugin, MarkdownExitPlugin, Node } from 'comark'

const wrapperTag = 'comark-content-details'
const openingLine = /^<details(?:\s+[^\s"'=<>`/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*>$/i
const closingLine = /^\s*<\/details>\s*$/im

function joinDetails(node: Node): Node {
  if (typeof node === 'string' || node[0] === null)
    return node
  const [tag, attributes, ...children] = node
  const joined = children.map(joinDetails)
  const first = joined[0]
  if (tag === wrapperTag && Array.isArray(first) && first[0] === 'details')
    return ['details', first[1], ...first.slice(2), ...joined.slice(1)] as Node
  return [tag, attributes, ...joined]
}

const installDetails: MarkdownExitPlugin = (md) => {
  md.core.ruler.push('content_details', (state) => {
    const openings: number[] = []
    const pairs = new Map<number, number>()
    for (const [index, token] of state.tokens.entries()) {
      if (token.type !== 'html_block')
        continue
      const firstLine = token.content.split('\n', 1)[0]?.trim() ?? ''
      if (openingLine.test(firstLine) && !closingLine.test(token.content))
        openings.push(index)
      else if (/^<\/details>$/i.test(firstLine) && openings.length)
        pairs.set(openings.pop()!, index)
    }
    if (!pairs.size)
      return
    const closings = new Set(pairs.values())
    state.tokens = state.tokens.flatMap((token, index) => {
      if (pairs.has(index)) {
        const open = new state.Token('mdc_block_open', wrapperTag, 1)
        open.block = true
        return [open, token]
      }
      if (closings.has(index)) {
        const close = new state.Token('mdc_block_close', wrapperTag, -1)
        close.block = true
        const remaining = token.content.slice(token.content.indexOf('\n') + 1)
        if (!token.content.includes('\n') || !remaining.trim())
          return [close]
        token.content = remaining
        return [close, token]
      }
      return [token]
    })
  })
}

/** Keep Markdown between separate HTML details tokens inside the native element. */
export const details: ComarkPlugin = {
  name: 'content-details',
  markdownItPlugins: [installDetails],
  post: ({ tree }) => {
    tree.nodes = tree.nodes.map(joinDetails)
  },
}
