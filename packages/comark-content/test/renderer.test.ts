import type { Node } from 'comark'
import type { VNode } from 'vue'
import { describe, expect, it } from 'vitest'
import { componentCandidates, componentMatchesTag } from '../src/runtime/components/names'
import { renderContentRoot, renderNodes } from '../src/runtime/components/render'

describe('comark rendering', () => {
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

  it('keeps attributes passed to the renderer', () => {
    const rendered = renderContentRoot(['Body'], { class: 'mb-10', id: 'content' }) as VNode

    expect(rendered).toMatchObject({ type: 'div', props: { class: 'mb-10', id: 'content' }, children: ['Body'] })
  })

  it('prefers Nuxt content component names for custom Markdown tags', () => {
    expect(componentCandidates('two-col')).toEqual(['ContentTwoCol', 'ProseTwoCol', 'TwoCol'])
    expect(componentCandidates('code-group')).toEqual(['ContentCodeGroup', 'ProseCodeGroup', 'CodeGroup'])
    expect(componentCandidates('callout')).toEqual(['ContentCallout', 'ProseCallout', 'Callout'])
    expect(componentCandidates('p')).toEqual(['ContentProseP', 'ProseP'])
    expect(componentCandidates('img')).toEqual(['ContentProseImg', 'ProseImg'])
    expect(componentCandidates('lazy-chart-streaming-comparison')).toEqual([
      'ContentLazyChartStreamingComparison',
      'ProseLazyChartStreamingComparison',
      'LazyChartStreamingComparison',
      'ContentChartStreamingComparison',
      'ProseChartStreamingComparison',
      'ChartStreamingComparison',
      'LazyContentChartStreamingComparison',
    ])
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

  it('keeps fenced code native inside a prose pre component', () => {
    const prosePre = { name: 'ProsePre' }
    const proseCode = { name: 'ProseCode' }
    const nodes: Node[] = [['pre', {}, ['code', { class: 'language-dotenv' }, 'KEY="value"']]]
    const [rendered] = renderNodes(nodes, {
      source: '/content/page.md',
      resolveTag: tag => tag === 'pre' ? prosePre : tag === 'code' ? proseCode : tag,
    }) as VNode[]

    const code = (rendered?.children as Record<string, () => VNode[]>).default?.()[0]
    expect(rendered?.type).toBe(prosePre)
    expect(code).toMatchObject({ type: 'code', props: { class: 'language-dotenv' } })
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

  it('preserves static HTML attributes when Comark marks them as bound', () => {
    const proseLink = { name: 'ProseA' }
    const node: Node = ['a', { 'href': 'https://example.com', ':target': '_blank' }, 'Example']
    const [rendered] = renderNodes([node], { source: '/content/page.md', resolveTag: () => proseLink }) as VNode[]

    expect(rendered?.props).toMatchObject({ href: 'https://example.com', target: '_blank' })
  })

  it('preserves scalar types for component attributes', () => {
    const widget = { name: 'StudyIceberg' }
    const node: Node = ['study-iceberg', { 'ui-rows': '1000', 'hidden-pct': '27.5', 'compact': 'true', 'label': 'Rows' }]
    const [rendered] = renderNodes([node], { source: '/content/page.md', resolveTag: () => widget }) as VNode[]

    expect(rendered?.props).toMatchObject({ 'ui-rows': 1000, 'hidden-pct': 27.5, 'compact': true, 'label': 'Rows' })
  })

  it('renders an inline head reference as text', () => {
    const nodes: Node[] = [['p', {}, 'Document ', ['head', { $: { html: 1, block: 0 } }, ' tag manager.']]]
    const [paragraph] = renderNodes(nodes, { source: '/content/page.md' }) as VNode[]

    expect((paragraph?.children as VNode[])[1]).toMatchObject({ type: 'span', children: '<head> tag manager.' })
  })
})
