import type { MarkdownDocument } from 'comark'
import type { Component } from 'vue'
import type { PageCollectionItemBase } from '../types'
import { defineComponent, useAttrs } from 'vue'
import contentComponents from '#comark-content/components'
import { renderContentRoot, renderNodes } from './render'

const resolveTag = (tag: string): string | Component => contentComponents[tag]?.component ?? tag

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
