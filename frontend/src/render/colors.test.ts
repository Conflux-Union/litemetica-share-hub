import { describe, expect, it } from 'vitest'
import { blockColor, blockColorHex } from './colors'

describe('blockColor with state strings', () => {
  it('strips the [k=v,...] section before table lookup', () => {
    expect(blockColor('minecraft:oak_leaves[distance=1,persistent=true]')).toEqual(
      blockColor('minecraft:oak_leaves'),
    )
    expect(blockColor('minecraft:grass_block[snowy=false]')).toEqual(
      blockColor('minecraft:grass_block'),
    )
  })

  it('hashes unknown blocks by bare id so property variants share one color', () => {
    expect(blockColor('minecraft:modded_block[active=true]')).toEqual(
      blockColor('minecraft:modded_block'),
    )
  })

  it('still resolves plain block ids', () => {
    expect(blockColor('minecraft:stone')).toEqual([0x7d / 255, 0x7d / 255, 0x7d / 255])
  })

  it('formats hex colors from state strings', () => {
    expect(blockColorHex('minecraft:stone')).toBe('#7d7d7d')
    expect(blockColorHex('minecraft:grass_block[snowy=true]')).toBe(
      blockColorHex('minecraft:grass_block'),
    )
  })
})
