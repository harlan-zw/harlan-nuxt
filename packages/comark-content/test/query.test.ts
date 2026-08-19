import { describe, expect, it } from 'vitest'
import { createCollectionQuery } from '../src/runtime/core/query'

const pages = [
  { id: 'pages/2.beta.md', path: '/beta', stem: '2.beta', title: 'Beta', status: 'published', score: 2 },
  { id: 'pages/1.alpha.md', path: '/alpha', stem: '1.alpha', title: 'Alpha', status: 'draft', score: null },
  { id: 'pages/3.gamma.md', path: '/gamma', stem: '3.gamma', title: 'Gamma', status: 'published', score: 3 },
]

describe('collection queries', () => {
  it('filters, orders, limits, and selects through the exported builder contract', async () => {
    const result = await createCollectionQuery(pages)
      .where('status', '=', 'published')
      .where('title', 'LIKE', '%a%')
      .order('score', 'DESC')
      .limit(1)
      .select('path', 'title')
      .all()

    expect(result).toEqual([{ path: '/gamma', title: 'Gamma' }])
  })

  it('supports path, inequality, null, and first', async () => {
    await expect(createCollectionQuery(pages).path('/alpha/').where('status', '<>', 'published').first()).resolves.toEqual(pages[1])
    await expect(createCollectionQuery(pages).where('score', 'IS NULL').all()).resolves.toEqual([pages[1]])
    await expect(createCollectionQuery([]).first()).resolves.toBeNull()
  })

  it('keeps only rows that have a value for IS NOT NULL', async () => {
    const result = await createCollectionQuery(pages).where('score', 'IS NOT NULL').select('path').all()

    expect(result).toEqual([{ path: '/beta' }, { path: '/gamma' }])
  })
})
