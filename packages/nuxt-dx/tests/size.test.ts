import { describe, expect, it } from 'vitest'
import { formatBytes, kilobytesToBytes } from '../src/size-budget/size'

describe('kilobytesToBytes', () => {
  it('scales by 1024 and lands on a whole byte count', () => {
    expect(kilobytesToBytes(20)).toBe(20480)
    expect(kilobytesToBytes(1.5)).toBe(1536)
    expect(kilobytesToBytes(0.001)).toBe(1)
  })
})

describe('formatBytes', () => {
  it('scales to a readable unit', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(20480)).toBe('20 kB')
    expect(formatBytes(1572864)).toBe('1.5 MB')
  })
})
