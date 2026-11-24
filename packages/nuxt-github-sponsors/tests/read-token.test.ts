import { describe, expect, it } from 'vitest'
import { readSponsorToken } from '../src/runtime/server/token'

describe('readSponsorToken', () => {
  it.each([
    ['the aliased env name', { NUXT_GITHUB_AUTH_TOKEN: ' aliased ' }, { tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN', token: 'slot' }, 'aliased'],
    ['the runtime config slot when the alias is unset', {}, { tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN', token: 'slot' }, 'slot'],
    ['nothing when both are blank', { NUXT_GITHUB_AUTH_TOKEN: '  ' }, { tokenEnv: 'NUXT_GITHUB_AUTH_TOKEN', token: '' }, undefined],
  ])('reads %s', (_label, env, config, expected) => {
    expect(readSponsorToken(env, config)).toBe(expected)
  })
})
