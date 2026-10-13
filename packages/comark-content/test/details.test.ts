import { parseMarkdown } from 'comark'
import { describe, expect, it } from 'vitest'
import { createContentParser } from '../src/core/ingest'

describe('html details ingestion', () => {
  it.each([
    '<details>\n<summary>Title</summary>\n<p>Body</p>\n</details>',
    '<details>\n<summary>Unclosed</summary>\n\nBody.',
    '```html\n<details>\n<summary>Example</summary>\n\nBody.\n\n</details>\n```',
  ])('preserves complete HTML, unmatched tags, and code examples: %s', async (source) => {
    const parse = await createContentParser()

    expect((await parse(source)).nodes).toEqual((await parseMarkdown(source)).nodes)
  })

  it('keeps Markdown children inside a native disclosure', async () => {
    const parse = await createContentParser()
    const document = await parse([
      '<details open class="benchmarks" id="results">',
      '<summary>Benchmark results</summary>',
      '',
      'The **smaller** build.',
      '',
      '| Metric | v6 |',
      '| --- | --- |',
      '| Browser | 14.9 KB |',
      '',
      '</details>',
      '',
      'After the disclosure.',
    ].join('\n'))

    expect(document.nodes).toMatchObject([
      ['details', { ':open': 'true', 'class': 'benchmarks', 'id': 'results' }, ['summary', {}, 'Benchmark results'], ['p', {}, 'The ', ['strong', {}, 'smaller'], ' build.'], ['table', {}, ['thead', {}, ['tr', {}, ['th', {}, 'Metric'], ['th', {}, 'v6']]], ['tbody', {}, ['tr', {}, ['td', {}, 'Browser'], ['td', {}, '14.9 KB']]]],
      ],
      ['p', {}, 'After the disclosure.'],
    ])
  })

  it('keeps nested disclosures and ignores closing tags in fenced code', async () => {
    const parse = await createContentParser({ highlight: true })
    const document = await parse([
      '<details>',
      '<summary>Outer</summary>',
      '',
      '<details>',
      '<summary>Inner</summary>',
      '',
      'Inside.',
      '',
      '```html',
      '</details>',
      '```',
      '',
      '</details>',
      '',
      'Still inside the outer disclosure.',
      '',
      '</details>',
      '',
      'Outside.',
    ].join('\n'))

    expect(document.nodes).toMatchObject([
      ['details', {}, ['summary', {}, 'Outer'], ['details', {}, ['summary', {}, 'Inner'], ['p', {}, 'Inside.'], ['pre', { class: expect.stringContaining('rangi') }, ['code', { class: 'language-html' }, expect.any(Array)]]], ['p', {}, 'Still inside the outer disclosure.']],
      ['p', {}, 'Outside.'],
    ])
  })
})
