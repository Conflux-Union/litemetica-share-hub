import { describe, expect, it } from 'vitest'
import {
  resolveStateGeometry,
  stateGeometryCache,
  type VanillaAssets,
} from './model'
import type { BlockstateJson, ModelJson } from './model'

// ---------------------------------------------------------------------------
// Shared vanilla-shaped fixtures (see also state.test.ts / geometry.test.ts).
// ---------------------------------------------------------------------------

const models: Record<string, ModelJson> = {
  'minecraft:block/block': {},
  'minecraft:block/cube': {
    parent: 'minecraft:block/block',
    textures: { particle: '#all' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#all', cullface: 'down' },
          up: { texture: '#all', cullface: 'up' },
          north: { texture: '#all', cullface: 'north' },
          south: { texture: '#all', cullface: 'south' },
          west: { texture: '#all', cullface: 'west' },
          east: { texture: '#all', cullface: 'east' },
        },
      },
    ],
  },
  'minecraft:block/cube_all': {
    parent: 'minecraft:block/cube',
    textures: { all: 'minecraft:block/stone' },
  },
  'minecraft:block/stone': { parent: 'minecraft:block/cube_all' },
  'minecraft:block/wall_torch': {
    textures: { torch: 'minecraft:block/torch' },
    elements: [
      {
        from: [6, 0, 7],
        to: [10, 10, 9],
        faces: {
          up: { texture: '#torch' },
          down: { texture: '#torch' },
          north: { texture: '#torch' },
          south: { texture: '#torch' },
          west: { texture: '#torch' },
          east: { texture: '#torch' },
        },
      },
    ],
  },
  'minecraft:block/redstone_dust_dot': {
    textures: { line: 'minecraft:block/redstone_dust_dot' },
    elements: [
      {
        from: [3, 0, 3],
        to: [13, 4, 13],
        faces: {
          up: { texture: '#line', tintindex: 0 },
          down: { texture: '#line', tintindex: 0 },
        },
      },
    ],
  },
  'minecraft:block/redstone_dust_side0': {
    textures: { line: 'minecraft:block/redstone_dust_line0' },
    elements: [
      {
        from: [0, 3, 7],
        to: [16, 7, 9],
        faces: {
          up: { texture: '#line', tintindex: 0 },
          down: { texture: '#line', tintindex: 0 },
          north: { texture: '#line', tintindex: 0 },
          south: { texture: '#line', tintindex: 0 },
        },
      },
    ],
  },
  'minecraft:block/redstone_dust_up': {
    textures: { line: 'minecraft:block/redstone_dust_line1' },
    elements: [
      {
        from: [3, 0, 3],
        to: [13, 16, 5],
        faces: {
          north: { texture: '#line', tintindex: 0 },
          south: { texture: '#line', tintindex: 0 },
        },
      },
    ],
  },
  // Particle-only vanilla models (26.x chest family / water): no elements.
  'minecraft:block/chest': { textures: { particle: 'minecraft:block/oak_planks' } },
  'minecraft:block/water': { textures: { particle: 'minecraft:block/water_still' } },
  'minecraft:block/plant': {
    textures: { plant: 'minecraft:block/plant' },
    elements: [
      {
        from: [0, 0, 8],
        to: [16, 16, 8],
        faces: { north: { texture: '#plant' }, south: { texture: '#plant' } },
      },
    ],
  },
  'minecraft:block/oak_stairs': {
    textures: { all: 'minecraft:block/oak_planks' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 8, 16],
        faces: {
          down: { texture: '#all', cullface: 'down' },
          up: { texture: '#all' },
          north: { texture: '#all', cullface: 'north' },
          south: { texture: '#all', cullface: 'south' },
          west: { texture: '#all', cullface: 'west' },
          east: { texture: '#all', cullface: 'east' },
        },
      },
      {
        from: [8, 8, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#all' },
          up: { texture: '#all', cullface: 'up' },
          north: { texture: '#all' },
          south: { texture: '#all' },
          west: { texture: '#all' },
          east: { texture: '#all', cullface: 'east' },
        },
      },
    ],
  },
}

const blockStates: Record<string, BlockstateJson> = {
  'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
  'minecraft:stone_rotated': { variants: { '': { model: 'minecraft:block/stone', x: 90 } } },
  'minecraft:wall_torch': {
    variants: {
      'facing=east': { model: 'minecraft:block/wall_torch' },
      'facing=south': { model: 'minecraft:block/wall_torch', y: 90 },
      'facing=west': { model: 'minecraft:block/wall_torch', y: 180 },
      'facing=north': { model: 'minecraft:block/wall_torch', y: 270 },
    },
  },
  'minecraft:oak_stairs': {
    variants: {
      'facing=east,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs' },
      'facing=south,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs', y: 90 },
      'facing=west,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs', y: 180 },
      'facing=north,half=bottom,shape=straight': { model: 'minecraft:block/oak_stairs', y: 270 },
      'facing=east,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180 },
      'facing=south,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180, y: 90 },
      'facing=west,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180, y: 180 },
      'facing=north,half=top,shape=straight': { model: 'minecraft:block/oak_stairs', x: 180, y: 270 },
    },
  },
  'minecraft:redstone_wire': {
    multipart: [
      { apply: { model: 'minecraft:block/redstone_dust_dot' } },
      { when: { north: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0' } },
      { when: { east: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 90 } },
      { when: { south: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 180 } },
      { when: { west: 'side|up' }, apply: { model: 'minecraft:block/redstone_dust_side0', y: 270 } },
      { when: { north: 'up' }, apply: { model: 'minecraft:block/redstone_dust_up' } },
      {
        when: { OR: [{ south: 'up' }, { west: 'up' }] },
        apply: { model: 'minecraft:block/redstone_dust_up', y: 180 },
      },
    ],
  },
  'minecraft:orphan': { variants: { '': { model: 'minecraft:block/missing_model' } } },
  'minecraft:chest': { variants: { '': { model: 'minecraft:block/chest' } } },
  'minecraft:water': { variants: { '': { model: 'minecraft:block/water' } } },
  'minecraft:short_grass': { variants: { '': { model: 'minecraft:block/plant' } } },
}

const assets: VanillaAssets = { blockStates, blockModels: models }

describe('resolveStateGeometry (vitest smoke: full stateKey → quads pipeline)', () => {
  it('resolves a wall torch state to rotated quad templates', () => {
    const cache = new Map()
    const geo = resolveStateGeometry('minecraft:wall_torch[facing=south]', assets, cache)
    expect(geo.missing).toBe(false)
    expect(geo.fullCube).toBe(false)
    expect(geo.modelIds).toEqual(['minecraft:block/wall_torch'])
    expect(geo.quads).toHaveLength(6)
    // y=90 rotation: the torch bar spans x 7..9/16, z 6..10/16.
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity
    for (const q of geo.quads) {
      for (const p of q.positions) {
        minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0])
        minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2])
      }
    }
    expect(minX).toBeCloseTo(7 / 16)
    expect(maxX).toBeCloseTo(9 / 16)
    expect(minZ).toBeCloseTo(6 / 16)
    expect(maxZ).toBeCloseTo(10 / 16)
    // Torch faces never declare cullface.
    expect(geo.quads.every((q) => q.cullface === undefined)).toBe(true)
  })

  it('resolves redstone multipart into dot + line + riser models', () => {
    const geo = resolveStateGeometry(
      'minecraft:redstone_wire[north=up,east=none,south=none,west=none,power=7]',
      assets,
      new Map(),
    )
    expect(geo.modelIds).toEqual([
      'minecraft:block/redstone_dust_dot',
      'minecraft:block/redstone_dust_side0',
      'minecraft:block/redstone_dust_up',
    ])
    // dot: 2 faces, line: 4 faces, riser: 2 faces.
    expect(geo.quads).toHaveLength(8)
    // Redstone faces carry tintindex 0 for the tint layer.
    expect(geo.quads.every((q) => q.tintindex === 0)).toBe(true)
  })

  it('marks full cubes for the mesher (rotation-invariant)', () => {
    const stone = resolveStateGeometry('minecraft:stone', assets, new Map())
    expect(stone.fullCube).toBe(true)
    expect(stone.quads).toHaveLength(6)
    expect(stone.quads.every((q) => q.cullface !== undefined)).toBe(true)
    const rotated = resolveStateGeometry('minecraft:stone_rotated', assets, new Map())
    expect(rotated.fullCube).toBe(true)
  })

  it('reports missing assets without throwing', () => {
    const unknown = resolveStateGeometry('minecraft:unknown_block[foo=1]', assets, new Map())
    expect(unknown.missing).toBe(true)
    expect(unknown.quads).toEqual([])
    expect(unknown.modelIds).toEqual([])
    const orphan = resolveStateGeometry('minecraft:orphan', assets, new Map())
    expect(orphan.missing).toBe(true)
    expect(orphan.quads).toEqual([])
  })
})

describe('per-stateKey cache', () => {
  it('caches by canonical stateKey across property orderings', () => {
    const cache = new Map()
    const a = resolveStateGeometry(
      'minecraft:oak_stairs[shape=straight,facing=south,half=top]',
      assets,
      cache,
    )
    const b = resolveStateGeometry(
      'minecraft:oak_stairs[facing=south,half=top,shape=straight]',
      assets,
      cache,
    )
    expect(b).toBe(a)
    expect(a.stateKey).toBe('minecraft:oak_stairs[facing=south,half=top,shape=straight]')
    expect(cache.size).toBe(1)
    // The resolved variant is the x=180,y=90 top stair.
    expect(a.modelIds).toEqual(['minecraft:block/oak_stairs'])
    const hasBottomCullAtTop = a.quads.some((q) => q.cullface === 'up')
    expect(hasBottomCullAtTop).toBe(true)
  })

  it('populates the shared exported cache by default', () => {
    stateGeometryCache.clear()
    const geo = resolveStateGeometry('minecraft:stone[x=0]', assets)
    expect(stateGeometryCache.get('minecraft:stone[x=0]')).toBe(geo)
    expect(geo.fullCube).toBe(true)
  })
})

describe('resolveStateGeometry tolerance paths', () => {
  it('resolves a schema-1 bare id against a fully-conditioned variant table', () => {
    // oak_stairs variants all constrain facing/half/shape; the bare id has
    // no properties, so the first-variant fallback must kick in (plan §5
    // P1.1: bare ids render their default shape, not the placeholder).
    const geo = resolveStateGeometry('minecraft:oak_stairs', assets, new Map())
    expect(geo.missing).toBe(false)
    expect(geo.modelIds).toEqual(['minecraft:block/oak_stairs'])
    expect(geo.quads.length).toBeGreaterThan(0)
  })

  it('marks particle-only models (chest family) as missing placeholders', () => {
    // 26.x chests have blockstates but element-less models; they must not
    // render as invisible holes (plan §5 P3: chests are placeholder cubes).
    for (const key of ['minecraft:chest', 'minecraft:chest[type=single,facing=north,waterlogged=false]']) {
      const geo = resolveStateGeometry(key, assets, new Map())
      expect(geo.missing).toBe(true)
      expect(geo.quads).toEqual([])
    }
  })

  it('keeps intentionally element-less blocks (water) non-missing', () => {
    // The mesher synthesizes water cubes; resolution stays non-missing.
    const geo = resolveStateGeometry('minecraft:water[level=0]', assets, new Map())
    expect(geo.missing).toBe(false)
    expect(geo.quads).toEqual([])
  })

  it('retries pre-1.20.3 block ids through the version-skew alias table', () => {
    // The bundle only knows short_grass; an old litematic says grass.
    const geo = resolveStateGeometry('minecraft:grass', assets, new Map())
    expect(geo.missing).toBe(false)
    expect(geo.modelIds).toEqual(['minecraft:block/plant'])
    expect(geo.stateKey).toBe('minecraft:grass')
  })
})
