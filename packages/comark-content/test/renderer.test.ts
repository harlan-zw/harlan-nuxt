import { describe, expect, it } from 'vitest'
import type { Node } from 'comark'
import type { VNode } from 'vue'
import { componentCandidates, componentMatchesTag } from '../src/runtime/components/names'
import { renderNodes } from '../src/runtime/components/render'

describe('Comark rendering', () => {
  it('renders direct nodes and removes internal source attributes', () => {
    const nodes: Node[] = [['p', { class: 'lead', $: { line: 4 } }, 'Hello ', ['strong', {}, 'world']]]
    const rendered = renderNodes(nodes, { source: '/content/page.md' })

    expect(rendered).toHaveLength(1)
    expect(rendered[0]).toMatchObject({ type: 'p', props: { class: 'lead' } })
    expect((rendered[0] as VNode).props).not.toHaveProperty('$')
  })

  it('unwraps a requested root element', () => {
    const nodes: Node[] = [['p', {}, 'Inline']]
    expect(renderNodes(nodes, { source: '/content/page.md', unwrap: ['p'] })).toEqual(['Inline'])
  })

  it('prefers Nuxt content component names for custom Markdown tags', () => {
    expect(componentCandidates('two-col')).toEqual(['ContentTwoCol', 'TwoCol'])
    expect(componentCandidates('p')).toEqual(['ProseP'])
    expect(componentMatchesTag('newsletterlist', 'ContentNewsletterList')).toBe(true)
    expect(componentMatchesTag('img', 'ContentProseImg')).toBe(true)
  })

  it('maps Comark template nodes to component slots', () => {
    const component = { name: 'Columns' }
    const nodes: Node[] = [['two-col', {}, ['template', { name: 'left' }, ['p', {}, 'Left']], ['p', {}, 'Default']]]
    const [rendered] = renderNodes(nodes, { source: '/content/page.md', resolveTag: tag => tag === 'two-col' ? component : tag }) as VNode[]

    expect(rendered?.children).toMatchObject({ default: expect.any(Function), left: expect.any(Function) })
    expect((rendered?.children as Record<string, () => VNode[]>).left?.()[0]).toMatchObject({ type: 'p' })
  })

  it('parses Comark bound properties for Vue components', () => {
    const component = { name: 'Image' }
    const node: Node = ['prose-img', { ':no-margin': 'true', ':width': '812', ':sizes': '[400,800]' }]
    const [rendered] = renderNodes([node], { source: '/content/page.md', resolveTag: () => component }) as VNode[]

    expect(rendered?.props).toMatchObject({
      'no-margin': true,
      'width': 812,
      'sizes': [400, 800],
      '__node': node,
    })
  })

  it('renders an inline head reference as text', () => {
    const nodes: Node[] = [['p', {}, 'Document ', ['head', { $: { html: 1, block: 0 } }, ' tag manager.']]]
    const [paragraph] = renderNodes(nodes, { source: '/content/page.md' }) as VNode[]

    expect((paragraph?.children as VNode[])[1]).toMatchObject({ type: 'span', children: '<head> tag manager.' })
  })
})
