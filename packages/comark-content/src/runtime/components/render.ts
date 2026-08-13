import type { Component, VNode, VNodeChild } from 'vue'
import type { Node } from 'comark'
import { createCommentVNode, h } from 'vue'

type RenderOptions = {
  source: string
  unwrap?: string[]
  resolveTag?: (tag: string) => string | Component
}

const componentProps = (node: Exclude<Node, string>, attributes: Record<string, unknown>, options: RenderOptions) => {
  const props: Record<string, unknown> = { __node: node }
  for (const [name, value] of Object.entries(attributes)) {
    if (!name.startsWith(':')) {
      props[name] = value
      continue
    }
    const prop = name.slice(1)
    try {
      props[prop] = typeof value === 'string' ? JSON.parse(value) : value
    }
    catch (cause) {
      throw new TypeError(`${options.source}:${node[1].$?.line ?? 1}:1 Could not parse the bound property "${prop}".`, { cause })
    }
  }
  return props
}

const renderNode = (node: Node, options: RenderOptions, key: string): VNodeChild => {
  if (typeof node === 'string')
    return node
  if (node[0] === null)
    return createCommentVNode(node[2])
  const [tag, attributes, ...children] = node
  if (!tag)
    throw new TypeError(`${options.source}:${attributes.$?.line ?? 1}:1 Comark emitted an element without a tag.`)
  const { $, ...props } = attributes
  if (tag === 'head' && $?.html === 1 && $?.block === 0)
    return h('span', { key }, `<${tag}>${children.filter(child => typeof child === 'string').join('')}`)
  if (typeof props.style === 'string') {
    const alignment = /^text-align:\s*(left|center|right);?$/.exec(props.style)?.[1]
    if (alignment) {
      props.style = { textAlign: alignment }
      props['data-allow-mismatch'] = 'style'
    }
  }
  const resolved = options.resolveTag?.(tag) ?? tag
  if (typeof resolved === 'string') {
    const renderedChildren = children.map((child, index) => renderNode(child, options, `${key}.${index}`))
    return h(resolved, { ...props, key }, renderedChildren)
  }
  const named = children.filter(child => typeof child !== 'string' && child[0] === 'template' && typeof child[1].name === 'string')
  const regular = children.filter(child => !named.includes(child as never))
  const slots: Record<string, () => VNodeChild[]> = {
    default: () => regular.map((child, index) => renderNode(child, options, `${key}.${index}`)),
  }
  for (const template of named) {
    if (typeof template === 'string' || template[0] !== 'template')
      continue
    const name = String(template[1].name)
    slots[name] = () => template.slice(2).map((child, index) => renderNode(child as Node, options, `${key}.${name}.${index}`))
  }
  return h(resolved, { ...componentProps(node, props, options), key }, slots)
}

export const renderNodes = (nodes: readonly Node[], options: RenderOptions): VNodeChild[] => {
  const unwrap = new Set(options.unwrap)
  return nodes.flatMap((node, index) => {
    if (typeof node !== 'string' && node[0] && unwrap.has(node[0]))
      return node.slice(2).map((child, childIndex) => renderNode(child as Node, options, `${index}.${childIndex}`))
    return [renderNode(node, options, String(index))]
  })
}

export const renderContentRoot = (nodes: VNodeChild[], attributes: Record<string, unknown>): VNode | VNodeChild[] => Object.keys(attributes).length
  ? h('div', attributes, nodes)
  : nodes
