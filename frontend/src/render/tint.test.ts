import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_TINT_COLORS,
  resolveTint,
  resetTintColors,
  setTintColors,
} from './tint'

afterEach(() => {
  resetTintColors()
})

describe('tintindex gating', () => {
  it('returns null without a declared face tintindex', () => {
    expect(resolveTint('minecraft:redstone_wire', { power: '15' }, undefined)).toBeNull()
    expect(resolveTint('minecraft:grass_block', {}, undefined)).toBeNull()
    expect(resolveTint('minecraft:water', { level: '0' }, undefined)).toBeNull()
  })

  it('returns null for negative tintindex', () => {
    expect(resolveTint('minecraft:redstone_wire', { power: '15' }, -1)).toBeNull()
  })

  it('tints any face that declares tintindex >= 0', () => {
    expect(resolveTint('minecraft:grass_block', {}, 0)).toEqual(DEFAULT_TINT_COLORS.grass)
    expect(resolveTint('minecraft:oak_leaves', {}, 2)).toEqual(DEFAULT_TINT_COLORS.foliage)
  })
})

describe('redstone power ramp', () => {
  const wire = (power?: string) =>
    resolveTint('minecraft:redstone_wire', power === undefined ? {} : { power }, 0)

  it('matches vanilla RedstoneWireBlock: (p/15)*0.6+0.4, power 0 ×0.3', () => {
    expect(wire('0')).toEqual([0.12, 0, 0])
    expect(wire('1')![0]).toBeCloseTo((1 / 15) * 0.6 + 0.4, 12)
    expect(wire('7')![0]).toBeCloseTo((7 / 15) * 0.6 + 0.4, 12)
    expect(wire('15')![0]).toBeCloseTo(1, 12)
    for (const p of [0, 5, 10, 15]) {
      const [r, g, b] = wire(String(p))!
      expect(g).toBe(0)
      expect(b).toBe(0)
      expect(r).toBeGreaterThan(0)
    }
  })

  it('is monotonically brighter with power', () => {
    let prev = -1
    for (let p = 0; p <= 15; p++) {
      const r = wire(String(p))![0]
      expect(r).toBeGreaterThan(prev)
      prev = r
    }
  })

  it('defaults missing power to 0 and clamps out-of-range values', () => {
    expect(wire(undefined)).toEqual([0.12, 0, 0])
    expect(wire('99')![0]).toBeCloseTo(wire('15')![0], 12)
    expect(wire('not-a-number')).toEqual([0.12, 0, 0])
  })
})

describe('water tint', () => {
  it('uses one constant blue for water and waterlogged blocks', () => {
    expect(resolveTint('minecraft:water', { level: '0' }, 0)).toEqual([0.24, 0.46, 0.89])
    expect(
      resolveTint('minecraft:oak_stairs', { facing: 'north', waterlogged: 'true' }, 0),
    ).toEqual([0.24, 0.46, 0.89])
  })

  it('leaves non-waterlogged blocks untinted', () => {
    expect(
      resolveTint('minecraft:oak_stairs', { facing: 'north', waterlogged: 'false' }, 0),
    ).toBeNull()
  })
})

describe('leaves and grass families', () => {
  it('overrides spruce and birch with vanilla fixed colors', () => {
    expect(resolveTint('minecraft:spruce_leaves', {}, 0)).toEqual([0x61 / 255, 0x99 / 255, 0x61 / 255])
    expect(resolveTint('minecraft:birch_leaves', {}, 0)).toEqual([0x80 / 255, 0xa7 / 255, 0x55 / 255])
  })

  it('uses the foliage color for other leaves and vines', () => {
    expect(resolveTint('minecraft:oak_leaves', { distance: '1' }, 0)).toEqual(
      DEFAULT_TINT_COLORS.foliage,
    )
    expect(resolveTint('minecraft:vine', {}, 0)).toEqual(DEFAULT_TINT_COLORS.foliage)
  })

  it('uses the grass color for the grass family', () => {
    for (const name of [
      'minecraft:grass_block',
      'minecraft:short_grass',
      'minecraft:fern',
      'minecraft:sugar_cane',
    ]) {
      expect(resolveTint(name, {}, 0)).toEqual(DEFAULT_TINT_COLORS.grass)
    }
  })

  it('follows bundle-provided colors installed via setTintColors', () => {
    setTintColors({ grass: [1, 0, 0], foliage: [0, 1, 0] })
    expect(resolveTint('minecraft:grass_block', {}, 0)).toEqual([1, 0, 0])
    expect(resolveTint('minecraft:oak_leaves', {}, 0)).toEqual([0, 1, 0])
    // Fixed overrides are independent of the biome palette.
    expect(resolveTint('minecraft:spruce_leaves', {}, 0)).toEqual([0x61 / 255, 0x99 / 255, 0x61 / 255])
    resetTintColors()
    expect(resolveTint('minecraft:grass_block', {}, 0)).toEqual(DEFAULT_TINT_COLORS.grass)
  })
})

describe('stem age ramp', () => {
  it('goes green at age 0 to orange at age 7', () => {
    const young = resolveTint('minecraft:pumpkin_stem', { age: '0' }, 0)!
    const mature = resolveTint('minecraft:pumpkin_stem', { age: '7' }, 0)!
    expect(young[1]).toBeGreaterThan(young[0]) // greenish
    expect(mature[0]).toBeGreaterThan(mature[2]) // orange
    const mid = resolveTint('minecraft:pumpkin_stem', { age: '3' }, 0)!
    for (let c = 0; c < 3; c++) {
      expect(mid[c]).toBeGreaterThan(Math.min(young[c], mature[c]) - 1e-9)
      expect(mid[c]).toBeLessThan(Math.max(young[c], mature[c]) + 1e-9)
    }
  })

  it('treats attached stems (no age property) as mature', () => {
    expect(resolveTint('minecraft:attached_melon_stem', {}, 0)).toEqual(
      resolveTint('minecraft:melon_stem', { age: '7' }, 0),
    )
  })

  it('tints pumpkin and melon stems identically per age', () => {
    expect(resolveTint('minecraft:melon_stem', { age: '2' }, 0)).toEqual(
      resolveTint('minecraft:pumpkin_stem', { age: '2' }, 0),
    )
  })
})

describe('untinted families', () => {
  it('returns null for ordinary blocks even with tintindex 0', () => {
    expect(resolveTint('minecraft:stone', {}, 0)).toBeNull()
    expect(resolveTint('minecraft:redstone_block', {}, 0)).toBeNull()
  })
})
