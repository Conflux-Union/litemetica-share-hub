import { describe, expect, it } from 'vitest'
import {
  formatState,
  matchesWhen,
  parseState,
  resolveBlockstate,
  type BlockstateJson,
  type WhenCondition,
} from './state'

describe('parseState', () => {
  it('parses name and properties', () => {
    expect(parseState('minecraft:redstone_wire[east=side,power=7]')).toEqual({
      name: 'minecraft:redstone_wire',
      props: { east: 'side', power: '7' },
    })
  })

  it('parses a bare id into empty props', () => {
    expect(parseState('minecraft:stone')).toEqual({ name: 'minecraft:stone', props: {} })
  })

  it('tolerates whitespace and an unclosed bracket', () => {
    expect(parseState(' x [ a = 1 , b = 2 ] ')).toEqual({ name: 'x', props: { a: '1', b: '2' } })
    expect(parseState('x[a=1')).toEqual({ name: 'x', props: { a: '1' } })
  })
})

describe('formatState', () => {
  it('sorts properties by key (canonical stateKey)', () => {
    expect(formatState(parseState('b[x=2,a=1]'))).toBe('b[a=1,x=2]')
  })

  it('omits the bracket when there are no properties', () => {
    expect(formatState(parseState('minecraft:stone'))).toBe('minecraft:stone')
  })
})

describe('resolveBlockstate: variants', () => {
  // Verbatim vanilla wall_torch blockstate shape.
  const wallTorch: BlockstateJson = {
    variants: {
      'facing=east': { model: 'minecraft:block/wall_torch' },
      'facing=south': { model: 'minecraft:block/wall_torch', y: 90 },
      'facing=west': { model: 'minecraft:block/wall_torch', y: 180 },
      'facing=north': { model: 'minecraft:block/wall_torch', y: 270 },
    },
  }

  it('matches a single-property key exactly', () => {
    expect(resolveBlockstate({ facing: 'south' }, wallTorch)).toEqual([
      { model: 'minecraft:block/wall_torch', y: 90 },
    ])
  })

  it('exact match without rotation omits x/y', () => {
    expect(resolveBlockstate({ facing: 'east' }, wallTorch)).toEqual([
      { model: 'minecraft:block/wall_torch' },
    ])
  })

  it('matches multi-property keys exactly (stairs facing/half/shape)', () => {
    const stairs: BlockstateJson = {
      variants: {
        'facing=south,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs', y: 90 },
        'facing=south,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180, y: 90 },
        'facing=north,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180, y: 270 },
      },
    }
    expect(resolveBlockstate({ facing: 'south', half: 'top', shape: 'straight' }, stairs)).toEqual([
      { model: 'minecraft:block/oak_stairs', x: 180, y: 90 },
    ])
  })

  it('uses the single variant when the state has none of the properties', () => {
    const single: BlockstateJson = { variants: { '': { model: 'minecraft:block/torch' } } }
    expect(resolveBlockstate({}, single)).toEqual([{ model: 'minecraft:block/torch' }])
    expect(resolveBlockstate({ lit: 'true' }, single)).toEqual([{ model: 'minecraft:block/torch' }])
  })

  it('prefers the unconstrained variant when a constrained one does not match', () => {
    // Vanilla grass_block shape: "" plus "snowy=true".
    const grass: BlockstateJson = {
      variants: {
        '': { model: 'minecraft:block/grass_block' },
        'snowy=true': { model: 'minecraft:block/grass_block_snow' },
      },
    }
    expect(resolveBlockstate({ snowy: 'false' }, grass)).toEqual([
      { model: 'minecraft:block/grass_block' },
    ])
    expect(resolveBlockstate({ snowy: 'true' }, grass)).toEqual([
      { model: 'minecraft:block/grass_block_snow' },
    ])
  })

  it('falls back to the best partial subset match', () => {
    const variants: BlockstateJson = {
      variants: {
        'facing=north': { model: 'minecraft:block/a' },
        'facing=north,half=bottom': { model: 'minecraft:block/b' },
      },
    }
    // "half" is unknown for this state: only the subset constraint matches.
    expect(resolveBlockstate({ facing: 'north' }, variants)).toEqual([{ model: 'minecraft:block/a' }])
  })

  it('falls back to the first variant when nothing matches (schema-1 bare ids)', () => {
    // Vanilla snow shape: every variant is conditioned on "layers", so a
    // property-less state (schema-1 preview payload) cannot subset-match.
    const layers: BlockstateJson = {
      variants: {
        'layers=2': { model: 'minecraft:block/snow_2' },
        'layers=8': { model: 'minecraft:block/snow_8' },
      },
    }
    expect(resolveBlockstate({}, layers)).toEqual([{ model: 'minecraft:block/snow_2' }])
  })
})

describe('resolveBlockstate: multipart when', () => {
  // Vanilla redstone_wire shape: unconditional dot, per-direction line
  // models with y rotations, "side|up" alternation, OR groups, AND groups.
  const redstone: BlockstateJson = {
    multipart: [
      { apply: { model: 'minecraft:block/redstone_dust_dot' } },
      { when: { north: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0' } },
      { when: { east: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 90 } },
      { when: { south: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 180 } },
      { when: { west: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 270 } },
      {
        when: { north: 'up' },
        apply: [
          { model: 'minecraft:block/redstone_dust_up' },
          { model: 'minecraft:block/redstone_dust_up_alt' },
        ],
      },
      {
        when: { OR: [{ south: 'up' }, { west: 'up' }] },
        apply: { model: 'minecraft:block/redstone_dust_up', y: 180 },
      },
      {
        when: { AND: [{ north: 'side' }, { east: 'side' }] },
        apply: { model: 'minecraft:block/redstone_dust_corner' },
      },
    ],
  }

  it('renders only the unconditional dot with no connections', () => {
    expect(
      resolveBlockstate(
        { north: 'none', east: 'none', south: 'none', west: 'none', power: '7' },
        redstone,
      ),
    ).toEqual([{ model: 'minecraft:block/redstone_dust_dot' }])
  })

  it('matches "side|up" alternation for a straight line', () => {
    expect(
      resolveBlockstate({ north: 'side', east: 'none', south: 'none', west: 'none' }, redstone),
    ).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
      { model: 'minecraft:block/redstone_dust_side0' },
    ])
  })

  it('matches "up" against side|up plus the dedicated riser, apply array takes the first entry', () => {
    expect(
      resolveBlockstate({ north: 'up', east: 'none', south: 'none', west: 'none' }, redstone),
    ).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
      { model: 'minecraft:block/redstone_dust_side0' },
      { model: 'minecraft:block/redstone_dust_up' },
    ])
  })

  it('evaluates nested OR groups', () => {
    // south=up matches both the south line (side|up) and the OR riser.
    expect(
      resolveBlockstate({ north: 'none', east: 'none', south: 'up', west: 'none' }, redstone),
    ).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
      { model: 'minecraft:block/redstone_dust_side0', y: 180 },
      { model: 'minecraft:block/redstone_dust_up', y: 180 },
    ])
  })

  it('evaluates nested AND groups', () => {
    expect(
      resolveBlockstate({ north: 'side', east: 'side', south: 'none', west: 'none' }, redstone),
    ).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
      { model: 'minecraft:block/redstone_dust_side0' },
      { model: 'minecraft:block/redstone_dust_side0', y: 90 },
      { model: 'minecraft:block/redstone_dust_corner' },
    ])
  })

  it('treats a condition on a missing property as false', () => {
    expect(resolveBlockstate({}, redstone)).toEqual([{ model: 'minecraft:block/redstone_dust_dot' }])
  })

  it('falls back to the first part when every part is conditioned (26.x redstone_wire)', () => {
    // 26.x even conditions the dust dot; a schema-1 bare id matches nothing
    // and must still render the first part as its default shape.
    const conditioned: BlockstateJson = {
      multipart: [
        {
          when: { OR: [{ north: 'none', east: 'none' }, { north: 'side|up', east: 'side|up' }] },
          apply: { model: 'minecraft:block/redstone_dust_dot' },
        },
        { when: { north: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0' } },
      ],
    }
    expect(resolveBlockstate({}, conditioned)).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
    ])
    // Fully-specified states still select by conditions only.
    expect(resolveBlockstate({ north: 'none', east: 'none' }, conditioned)).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
    ])
    expect(resolveBlockstate({ north: 'side', east: 'side' }, conditioned)).toEqual([
      { model: 'minecraft:block/redstone_dust_dot' },
      { model: 'minecraft:block/redstone_dust_side0' },
    ])
  })
})

describe('matchesWhen', () => {
  it('requires every property of an implicit AND', () => {
    const cond = { north: 'side', east: 'side' }
    expect(matchesWhen(cond, { north: 'side', east: 'side' })).toBe(true)
    expect(matchesWhen(cond, { north: 'side', east: 'none' })).toBe(false)
  })

  it('supports alternation values', () => {
    expect(matchesWhen({ north: 'side|up' }, { north: 'up' })).toBe(true)
    expect(matchesWhen({ north: 'side|up' }, { north: 'none' })).toBe(false)
  })

  it('supports deep OR/AND nesting', () => {
    const cond: WhenCondition = { OR: [{ AND: [{ north: 'side' }, { east: 'side' }] }, { south: 'up' }] }
    expect(matchesWhen(cond, { north: 'side', east: 'side', south: 'none' })).toBe(true)
    expect(matchesWhen(cond, { north: 'side', east: 'none', south: 'up' })).toBe(true)
    expect(matchesWhen(cond, { north: 'side', east: 'none', south: 'none' })).toBe(false)
  })
})
