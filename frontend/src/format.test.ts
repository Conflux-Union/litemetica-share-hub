import { describe, expect, it } from 'vitest'
import { formatStackSize } from './format'

describe('formatStackSize', () => {
  it('formats pure item counts', () => {
    expect(formatStackSize(0)).toBe('0个')
    expect(formatStackSize(1)).toBe('1个')
    expect(formatStackSize(63)).toBe('63个')
  })

  it('formats stacks, omitting zero boxes and items', () => {
    expect(formatStackSize(64)).toBe('1组')
    expect(formatStackSize(65)).toBe('1组1个')
    expect(formatStackSize(320)).toBe('5组')
  })

  it('formats full and partial shulker boxes (27 stacks each)', () => {
    expect(formatStackSize(27 * 64)).toBe('1盒')
    expect(formatStackSize(1729)).toBe('1盒1个')
    expect(formatStackSize(2 * 1728 + 3 * 64 + 5)).toBe('2盒3组5个')
  })
})
