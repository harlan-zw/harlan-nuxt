import { describe, expect, it } from 'vitest'
import { parseComponentTrace, parseHydrationWarning } from '../src/runtime/app/hydration'

// Captured from Vue 3.5.41 running a Nuxt 4 dev server, as `warnHandler` receives them: Vue has
// already flattened the DOM nodes it passed as warning arguments into the message.
const TEXT_CONTENT_WARNING = `Hydration text content mismatch on[object HTMLParagraphElement]
  - rendered on server:  Rendered at 1786426149186
  - expected on client:  Rendered at 1786426150046`

const CLASS_WARNING = `Hydration class mismatch on[object HTMLSpanElement]
  - rendered on server: class="warm"
  - expected on client: class="cool"
  Note: this mismatch is check-only. The DOM will not be rectified in production due to performance overhead.
  You should fix the source of the mismatch.`

const NODE_WARNING = `Hydration node mismatch:
- rendered on server:[object HTMLSpanElement]
- expected on client:Symbol(v-cmt)`

const CHILDREN_WARNING = `Hydration children mismatch on[object HTMLDivElement]
Server rendered element contains more child nodes than client vdom.`

const TEXT_NODE_WARNING = `Hydration text mismatch in[object HTMLDivElement]
  - rendered on server: "12"
  - expected on client: "13"`

describe('parseHydrationWarning', () => {
  it('reads the element and both sides of a text content mismatch', () => {
    expect(parseHydrationWarning(TEXT_CONTENT_WARNING)).toEqual({
      kind: 'text',
      element: 'HTMLParagraphElement',
      server: ' Rendered at 1786426149186',
      client: ' Rendered at 1786426150046',
      detail: undefined,
    })
  })

  it('drops the check-only footnote Vue appends to prop mismatches', () => {
    expect(parseHydrationWarning(CLASS_WARNING)).toEqual({
      kind: 'class',
      element: 'HTMLSpanElement',
      server: 'class="warm"',
      client: 'class="cool"',
      detail: undefined,
    })
  })

  it('names the vnode symbol a node mismatch reports on the client side', () => {
    expect(parseHydrationWarning(NODE_WARNING)).toEqual({
      kind: 'node',
      element: undefined,
      server: 'HTMLSpanElement',
      client: 'comment node (a v-if placeholder)',
      detail: undefined,
    })
  })

  it('keeps the trailing sentence when there is no server/client pair', () => {
    expect(parseHydrationWarning(CHILDREN_WARNING)).toEqual({
      kind: 'children',
      element: 'HTMLDivElement',
      server: undefined,
      client: undefined,
      detail: 'Server rendered element contains more child nodes than client vdom.',
    })
  })

  it('handles the `in` phrasing Vue uses for text vnodes', () => {
    expect(parseHydrationWarning(TEXT_NODE_WARNING)).toMatchObject({
      kind: 'text',
      element: 'HTMLDivElement',
      server: '"12"',
      client: '"13"',
    })
  })

  it.each([
    'Failed to resolve component: NuxtLnk',
    'Invalid prop: type check failed for prop "count".',
    'Extraneous non-props attributes (class) were passed to component',
    '',
  ])('ignores the unrelated warning %j', (message) => {
    expect(parseHydrationWarning(message)).toBeUndefined()
  })
})

describe('parseComponentTrace', () => {
  it('reads the component chain nearest first', () => {
    expect(parseComponentTrace('at <DriftingClock>\nat <Index>\nat <NuxtRoot>')).toEqual(['DriftingClock', 'Index', 'NuxtRoot'])
  })

  it('drops the props Vue inlines into a trace entry', () => {
    expect(parseComponentTrace('at <Badge seed=11 >\nat <Index>')).toEqual(['Badge', 'Index'])
  })

  it('returns nothing for an empty trace', () => {
    expect(parseComponentTrace('')).toEqual([])
  })
})
