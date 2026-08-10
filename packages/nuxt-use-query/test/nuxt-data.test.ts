import { describe, expect, it } from 'vitest'
import {
  listActiveNuxtDataKeys,
  listNuxtDataKeys,
  readNuxtData,
} from '../src/runtime/nuxt-data'

describe('nuxt data internals', () => {
  it('preserves an explicit null payload value', () => {
    const nuxt = {
      payload: { data: { nullable: null } },
      static: { data: { nullable: 'stale' } },
    }

    expect(readNuxtData(nuxt, 'nullable')).toBeNull()
  })

  it('includes parked inactive async-data entries when listing removable data', () => {
    const nuxt = {
      _asyncData: {
        parked: { _deps: 0, data: { value: { private: true } } },
      },
      payload: { data: {} },
    }

    expect(listNuxtDataKeys(nuxt)).toContain('parked')
  })

  it('filters active keys during collection', () => {
    const nuxt = {
      _asyncData: {
        'site:active': { _deps: 1, data: { value: 1 } },
        'site:parked': { _deps: 0, data: { value: 2 } },
        'user:active': { _deps: 1, data: { value: 3 } },
      },
      payload: { data: {} },
    }

    expect(listActiveNuxtDataKeys(nuxt, key => key.startsWith('site:')))
      .toEqual(['site:active'])
  })
})
