import type { Component } from 'vue'
import type { MarkdownDocument } from 'comark'
import type { PageCollectionItemBase } from '../types'
import componentLoaders from '#comark-content/components'
import { defineAsyncComponent, defineComponent, resolveDynamicComponent, useAttrs } from 'vue'
import { componentCandidates } from './names'
import { renderContentRoot, renderNodes } from './render'

const contentComponents = Object.fromEntries(Object.entries(componentLoaders).map(([tag, entry]) => [tag, defineAsyncComponent(entry.load)]))

const resolveTag = (tag: string): string | Component => {
  const entry = componentLoaders[tag]
  if (entry) {
    const resolved = resolveDynamicComponent(entry.name)
    if (typeof resolved !== 'string' || resolved !== entry.name)
      return resolved as Component
  }
  const contentComponent = contentComponents[tag]
  if (contentComponent)
    return contentComponent
  for (const name of componentCandidates(tag)) {
    const resolved = resolveDynamicComponent(name)
    if (typeof resolved !== 'string' || resolved !== name)
      return resolved as Component
  }
  return tag
}

export default defineComponent({
  name: 'ContentRenderer',
  inheritAttrs: false,
  props: {
    value: {
      type: Object as () => PageCollectionItemBase | MarkdownDocument,
      required: true,
    },
    unwrap: {
      type: [String, Array] as unknown as () => string | string[],
      default: undefined,
    },
  },
  setup(props) {
    const attributes = useAttrs()
    return () => {
      const value = props.value as PageCollectionItemBase | MarkdownDocument
      const body = 'body' in value ? value.body : value
      const source = 'body' in value ? value._source : '<Comark document>'
      const unwrap = typeof props.unwrap === 'string' ? [props.unwrap] : props.unwrap
      const nodes = renderNodes(body.nodes, { source, unwrap, resolveTag })
      return renderContentRoot(nodes, attributes)
    }
  },
})
