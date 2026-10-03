import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BlockstateJson, ModelJson, VanillaAssets } from './model'
import { resetTintColors } from './tint'
import { extractSurface, type MeshData, type SurfaceAssets } from './surface'
import type { VoxelGrid } from './decode'

// ---------------------------------------------------------------------------
// Fixtures: a fake vanilla bundle (blockstates + models + atlas metadata).
// ---------------------------------------------------------------------------

function cubeModel(texKey: string, tex: string): ModelJson {
  return {
    textures: { [texKey]: tex },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: `#${texKey}`, cullface: 'down' },
          up: { texture: `#${texKey}`, cullface: 'up' },
          north: { texture: `#${texKey}`, cullface: 'north' },
          south: { texture: `#${texKey}`, cullface: 'south' },
          west: { texture: `#${texKey}`, cullface: 'west' },
          east: { texture: `#${texKey}`, cullface: 'east' },
        },
      },
    ],
  }
}

const MODELS: Record<string, ModelJson> = {
  'minecraft:block/stone': cubeModel('all', 'minecraft:block/stone'),
  'minecraft:block/glass': cubeModel('all', 'minecraft:block/glass'),
  'minecraft:block/oak_leaves': cubeModel('all', 'minecraft:block/oak_leaves'),
  // Full cube whose texture is deliberately absent from the atlas.
  'minecraft:block/orphan_tex': cubeModel('all', 'minecraft:block/not_in_atlas'),
  'minecraft:block/grass_block': {
    textures: {
      top: 'minecraft:block/grass_top',
      side: 'minecraft:block/grass_side',
      bottom: 'minecraft:block/dirt',
    },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#bottom' },
          up: { texture: '#top', tintindex: 0 },
          north: { texture: '#side' },
          south: { texture: '#side' },
          west: { texture: '#side' },
          east: { texture: '#side' },
        },
      },
    ],
  },
  // Bottom slab: partial cube with cullfaces on the outer faces.
  'minecraft:block/stone_slab': {
    textures: { all: 'minecraft:block/stone' },
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
    ],
  },
  // Flat plant: one zero-thickness element, both windings, tinted.
  'minecraft:block/cross_plant': {
    textures: { plant: 'minecraft:block/plant' },
    elements: [
      {
        from: [0, 0, 8],
        to: [16, 16, 8],
        faces: {
          north: { texture: '#plant', tintindex: 0 },
          south: { texture: '#plant', tintindex: 0 },
        },
      },
    ],
  },
  // Vanilla water model: particle-only, no elements (needs synthesis).
  'minecraft:block/water': { textures: { particle: 'minecraft:block/water_still' } },
}

const BLOCKSTATES: Record<string, BlockstateJson> = {
  'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
  'minecraft:glass': { variants: { '': { model: 'minecraft:block/glass' } } },
  'minecraft:oak_leaves': { variants: { '': { model: 'minecraft:block/oak_leaves' } } },
  'minecraft:orphan': { variants: { '': { model: 'minecraft:block/orphan_tex' } } },
  'minecraft:grass_block': { variants: { '': { model: 'minecraft:block/grass_block' } } },
  'minecraft:stone_slab': {
    variants: {
      'type=bottom': { model: 'minecraft:block/stone_slab' },
      'type=top': { model: 'minecraft:block/stone_slab', x: 180 },
    },
  },
  'minecraft:short_grass': { variants: { '': { model: 'minecraft:block/cross_plant' } } },
  'minecraft:water': { variants: { '': { model: 'minecraft:block/water' } } },
}

const ASSETS: VanillaAssets = { blockStates: BLOCKSTATES, blockModels: MODELS }

const ALPHAS: Record<string, 'opaque' | 'cutout' | 'translucent'> = {
  'minecraft:block/stone': 'opaque',
  'minecraft:block/glass': 'translucent',
  'minecraft:block/oak_leaves': 'cutout',
  'minecraft:block/grass_top': 'opaque',
  'minecraft:block/grass_side': 'opaque',
  'minecraft:block/dirt': 'opaque',
  'minecraft:block/plant': 'cutout',
  'minecraft:block/water_still': 'translucent',
}

/** Maps model uv 0..16 onto the atlas quadrant [0.25,0.75]×[0.75,0.25]. */
const TILE = { u0: 0.25, du: 0.5 / 16, v0: 0.75, dv: -0.5 / 16 }

const STORE: SurfaceAssets = {
  assets: ASSETS,
  tileTransform: (id) => (id in ALPHAS ? { ...TILE } : null),
  alphaClass: (id) => ALPHAS[id] ?? 'opaque',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Grid from x-rows: layers[y][z] is a string over x; '.' = air, 'a'.. map
 * to palette entries in order. */
function makeGrid(palette: string[], layers: string[][]): VoxelGrid {
  const dy = layers.length
  const dz = layers[0].length
  const dx = layers[0][0].length
  const data = new Uint16Array(dx * dy * dz)
  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        const ch = layers[y][z][x]
        data[y * dz * dx + z * dx + x] = ch === '.' ? 0 : ch.charCodeAt(0) - 96
      }
    }
  }
  return { dims: [dx, dy, dz], palette: ['minecraft:air', ...palette], data }
}

/** Fresh resolution cache per call so tests never share cached templates. */
function meshOf(
  palette: string[],
  layers: string[][],
  store: SurfaceAssets | null = STORE,
): MeshData {
  return extractSurface(makeGrid(palette, layers), store, new Map())
}

const rangeEnd = (mesh: MeshData, name: 'opaque' | 'cutout' | 'translucent' | 'flat'): number =>
  mesh.ranges[name].start + mesh.ranges[name].count

/** Vertex indices at an exact corner position with an exact normal. */
function vertexAt(
  mesh: MeshData,
  pos: [number, number, number],
  normal: [number, number, number],
): number[] {
  const out: number[] = []
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    const p = [mesh.positions[i * 3], mesh.positions[i * 3 + 1], mesh.positions[i * 3 + 2]]
    const n = [mesh.normals[i * 3], mesh.normals[i * 3 + 1], mesh.normals[i * 3 + 2]]
    if (
      p.every((v, a) => Math.abs(v - pos[a]) < 1e-9) &&
      n.every((v, a) => Math.abs(v - normal[a]) < 1e-9)
    ) {
      out.push(i)
    }
  }
  return out
}

function colorAt(mesh: MeshData, vertex: number): [number, number, number] {
  return [mesh.colors[vertex * 3], mesh.colors[vertex * 3 + 1], mesh.colors[vertex * 3 + 2]]
}

function hasIndexSequence(mesh: MeshData, seq: number[]): boolean {
  for (let i = 0; i + seq.length <= mesh.indices.length; i++) {
    if (seq.every((v, j) => mesh.indices[i + j] === v)) return true
  }
  return false
}

function expectIndexSequence(mesh: MeshData, seq: number[]): void {
  expect(hasIndexSequence(mesh, seq), `index sequence ${seq} not found`).toBe(true)
}

function expectNoIndexSequence(mesh: MeshData, seq: number[]): void {
  expect(hasIndexSequence(mesh, seq), `index sequence ${seq} unexpectedly found`).toBe(false)
}

// ---------------------------------------------------------------------------
// Culling rules
// ---------------------------------------------------------------------------

describe('mesher culling', () => {
  it('stone next to stone culls the shared interior faces', () => {
    const mesh = meshOf(['minecraft:stone'], [['aaa']])
    expect(mesh.faceCount).toBe(14) // 3×6 − 2 shared faces × 2 sides
    expect(mesh.ranges.opaque.count).toBe(84)
    expect(mesh.ranges.cutout.count).toBe(0)
    expect(mesh.ranges.translucent.count).toBe(0)
    expect(mesh.ranges.flat.count).toBe(0)
  })

  it('a fully buried voxel contributes zero quads', () => {
    const mesh = meshOf(['minecraft:stone'], [
      ['aaa', 'aaa', 'aaa'],
      ['aaa', 'aaa', 'aaa'],
      ['aaa', 'aaa', 'aaa'],
    ])
    expect(mesh.faceCount).toBe(54) // only the 6 outer faces × 9 voxels each
    expect(mesh.ranges.opaque.count).toBe(324)
  })

  it('glass culls against glass (same cull group) but not against stone', () => {
    const glass = meshOf(['minecraft:glass'], [['aa']])
    expect(glass.faceCount).toBe(10)
    expect(glass.ranges.translucent.count).toBe(60)

    const pair = meshOf(['minecraft:glass', 'minecraft:stone'], [['ab']])
    // Glass face toward stone is culled (stone occludes)…
    expect(pair.ranges.translucent.count).toBe(30)
    // …but the stone face toward glass stays visible (east face at x=2).
    expect(pair.ranges.opaque.count).toBe(36)
    expect(vertexAt(pair, [2, 0, 0], [1, 0, 0])).toHaveLength(1)
  })

  it('leaves cull against leaves via their cull group', () => {
    const mesh = meshOf(['minecraft:oak_leaves'], [['aa']])
    expect(mesh.faceCount).toBe(10)
    expect(mesh.ranges.cutout.count).toBe(60)
  })

  it('a slab (non-full-cube) never occludes the neighbor face', () => {
    const mesh = meshOf(['minecraft:stone', 'minecraft:stone_slab[type=bottom]'], [['ab']])
    expect(mesh.faceCount).toBe(11) // stone keeps 6, slab keeps 5 (west culled)
    // Stone's east face at x=2 survives next to the slab.
    expect(vertexAt(mesh, [2, 0, 0], [1, 0, 0])).toHaveLength(1)
  })

  it('variant properties drive model selection (slab half)', () => {
    const bottom = meshOf(['minecraft:stone_slab[type=bottom]'], [['a']])
    const top = meshOf(['minecraft:stone_slab[type=top]'], [['a']])
    const ys = (m: MeshData) => {
      let min = Infinity
      let max = -Infinity
      for (let i = 0; i < m.positions.length / 3; i++) {
        min = Math.min(min, m.positions[i * 3 + 1])
        max = Math.max(max, m.positions[i * 3 + 1])
      }
      return [min, max]
    }
    expect(ys(bottom)).toEqual([0, 0.5])
    expect(ys(top)).toEqual([0.5, 1])
  })
})

// ---------------------------------------------------------------------------
// Placeholder paths
// ---------------------------------------------------------------------------

describe('placeholder rendering', () => {
  const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

  afterEach(() => {
    warnSpy.mockClear()
  })

  it('unknown blocks render magenta cubes and warn once per state string', () => {
    const mesh = meshOf(['minecraft:modded_thing'], [['aa']])
    expect(mesh.ranges.flat.count).toBe(72) // 12 unculled cube faces
    expect(mesh.ranges.opaque.count).toBe(0)

    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])
    expect(up).toHaveLength(1)
    expect(colorAt(mesh, up[0])).toEqual([1, 0, 1]) // magenta × face light 1.0

    // Flat quads never sample the atlas: uv stays at the origin.
    for (let i = 0; i < mesh.uvs.length / 2; i++) {
      expect(mesh.uvs[i * 2]).toBe(0)
      expect(mesh.uvs[i * 2 + 1]).toBe(0)
    }

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('minecraft:modded_thing')
  })

  it('quads whose texture is missing from the atlas go magenta, not garbage', () => {
    const mesh = meshOf(['minecraft:orphan'], [['a']])
    expect(mesh.ranges.flat.count).toBe(36)
    expect(mesh.ranges.opaque.count).toBe(0)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0]).toContain('minecraft:block/not_in_atlas')
    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])
    expect(colorAt(mesh, up[0])).toEqual([1, 0, 1])
  })

  it('the placeholder face toward a full cube is culled', () => {
    const mesh = meshOf(['minecraft:stone', 'minecraft:modded_thing'], [['ab']])
    // Stone: 6 (east face toward placeholder stays: placeholders occlude nothing).
    // Placeholder: 5 (west face toward stone culled).
    expect(mesh.ranges.opaque.count).toBe(36)
    expect(mesh.ranges.flat.count).toBe(30)
  })
})

// ---------------------------------------------------------------------------
// Ambient occlusion
// ---------------------------------------------------------------------------

describe('ambient occlusion', () => {
  it('darkens corners from full-cube neighbors and flips the quad diagonal', () => {
    // Stone at (0,0,0) with the three diagonal neighbors above it occupied.
    const mesh = meshOf(['minecraft:stone'], [
      ['a.', '..'],
      ['.a', 'aa'],
    ])
    const up = [
      vertexAt(mesh, [0, 1, 0], [0, 1, 0])[0],
      vertexAt(mesh, [1, 1, 0], [0, 1, 0])[0],
      vertexAt(mesh, [1, 1, 1], [0, 1, 0])[0],
      vertexAt(mesh, [0, 1, 1], [0, 1, 0])[0],
    ]
    // Strength table [1, 0.7, 0.5, 0.2]: free corner, 1 side, both sides, 1 side.
    expect(colorAt(mesh, up[0])).toEqual([1, 1, 1])
    expect(colorAt(mesh, up[1])[0]).toBeCloseTo(0.7, 6)
    expect(colorAt(mesh, up[2])[0]).toBeCloseTo(0.2, 6) // side1 && side2
    expect(colorAt(mesh, up[3])[0]).toBeCloseTo(0.7, 6)

    // AO trigger count: exactly 3 of the 4 corners were dimmed.
    expect(up.filter((v) => mesh.colors[v * 3] < 1).length).toBe(3)

    // Ring order here is [c3,c2,c1,c0] (compileGeometry reverses ±Y
    // winding): default diagonal c3-c1 sums 1.4 > c2-c0's 1.2, so the
    // default triangulation stays.
    const b = Math.min(...up)
    expectIndexSequence(mesh, [b, b + 1, b + 2, b, b + 2, b + 3])
    expectNoIndexSequence(mesh, [b + 1, b + 2, b + 3, b + 1, b + 3, b])
  })

  it('flips the quad diagonal when the default one joins the darker pair', () => {
    // Stone at (1,0,1); occluders at (1,1,0) and (0,1,2) darken three of the
    // four up-face corners: c0, c1 share one side block, c3 its own side.
    const mesh = meshOf(['minecraft:stone'], [
      ['...', '.a.', '...'],
      ['.a.', '...', 'a..'],
    ])
    const up = [
      vertexAt(mesh, [1, 1, 1], [0, 1, 0])[0],
      vertexAt(mesh, [2, 1, 1], [0, 1, 0])[0],
      vertexAt(mesh, [2, 1, 2], [0, 1, 0])[0],
      vertexAt(mesh, [1, 1, 2], [0, 1, 0])[0],
    ]
    expect(colorAt(mesh, up[0])[0]).toBeCloseTo(0.7, 6)
    expect(colorAt(mesh, up[1])[0]).toBeCloseTo(0.7, 6)
    expect(colorAt(mesh, up[2])[0]).toBeCloseTo(1, 6)
    expect(colorAt(mesh, up[3])[0]).toBeCloseTo(0.7, 6)
    // Push order [c3,c2,c1,c0] = [0.7, 1, 0.7, 0.7]: default diagonal sums
    // 1.4 < 1.7, so the triangulation flips onto the brighter pair.
    const b = Math.min(...up)
    expectIndexSequence(mesh, [b + 1, b + 2, b + 3, b + 1, b + 3, b])
    expectNoIndexSequence(mesh, [b, b + 1, b + 2, b, b + 2, b + 3])
  })

  it('non-full-cube neighbors do not trigger AO', () => {
    // Slab sitting directly on top of the stone: the stone's up face stays
    // fully lit because the slab is not an AO occluder.
    const mesh = meshOf(['minecraft:stone', 'minecraft:stone_slab[type=bottom]'], [
      ['a'],
      ['b'],
    ])
    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])
    expect(up).toHaveLength(1)
    expect(colorAt(mesh, up[0])).toEqual([1, 1, 1])
  })
})

// ---------------------------------------------------------------------------
// Segment layout, atlas UVs, tint, water
// ---------------------------------------------------------------------------

describe('draw-range segments', () => {
  it('opaque / cutout / translucent / flat are contiguous and non-overlapping', () => {
    const mesh = meshOf(
      ['minecraft:stone', 'minecraft:glass', 'minecraft:short_grass', 'minecraft:modded_thing'],
      [['abcd']],
    )
    const order = ['opaque', 'cutout', 'translucent', 'flat'] as const
    expect(mesh.ranges.opaque.start).toBe(0)
    for (let i = 0; i < order.length; i++) {
      const r = mesh.ranges[order[i]]
      expect(r.count).toBeGreaterThan(0)
      expect(r.count % 6).toBe(0) // whole quads
      if (i > 0) expect(r.start).toBe(rangeEnd(mesh, order[i - 1]))
    }
    expect(rangeEnd(mesh, 'flat')).toBe(mesh.indices.length)
    // Bucketed by texture alpha class: stone→opaque, plant→cutout,
    // glass→translucent, unknown→flat.
    expect(mesh.ranges.opaque.count).toBe(36)
    expect(mesh.ranges.cutout.count).toBe(12) // flat plant: 2 quads
    expect(mesh.ranges.translucent.count).toBe(30) // glass next to plant keeps 5
    expect(mesh.ranges.flat.count).toBe(36)
    // All indices address real vertices.
    const verts = mesh.positions.length / 3
    for (const idx of mesh.indices) expect(idx).toBeLessThan(verts)
  })

  it('maps model uv 0..16 through the tile transform', () => {
    const mesh = meshOf(['minecraft:stone'], [['a']])
    let minU = Infinity
    let maxU = -Infinity
    let minV = Infinity
    let maxV = -Infinity
    for (let i = 0; i < mesh.uvs.length / 2; i++) {
      minU = Math.min(minU, mesh.uvs[i * 2])
      maxU = Math.max(maxU, mesh.uvs[i * 2])
      minV = Math.min(minV, mesh.uvs[i * 2 + 1])
      maxV = Math.max(maxV, mesh.uvs[i * 2 + 1])
    }
    expect(minU).toBeCloseTo(TILE.u0, 9)
    expect(maxU).toBeCloseTo(TILE.u0 + 16 * TILE.du, 9)
    // v is flipped: model v=16 maps below model v=0.
    expect(maxV).toBeCloseTo(TILE.v0, 9)
    expect(minV).toBeCloseTo(TILE.v0 + 16 * TILE.dv, 9)
  })
})

describe('tint baking', () => {
  it('applies the grass colormap only to faces declaring tintindex', () => {
    resetTintColors()
    const mesh = meshOf(['minecraft:grass_block'], [['a']])
    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])[0]
    const upColor = colorAt(mesh, up)
    expect(upColor[0]).toBeCloseTo(124 / 255, 6)
    expect(upColor[1]).toBeCloseTo(189 / 255, 6)
    expect(upColor[2]).toBeCloseTo(108 / 255, 6)
    // Untinted side face: white × the ±z face light 0.86.
    const side = vertexAt(mesh, [0, 0, 1], [0, 0, 1])[0]
    for (const ch of colorAt(mesh, side)) expect(ch).toBeCloseTo(0.86, 6)
  })

  it('tints flat cross-plant quads (both windings)', () => {
    resetTintColors()
    const mesh = meshOf(['minecraft:short_grass'], [['a']])
    expect(mesh.ranges.cutout.count).toBe(12)
    const north = vertexAt(mesh, [0, 0, 0.5], [0, 0, -1])[0]
    const south = vertexAt(mesh, [0, 0, 0.5], [0, 0, 1])[0]
    // Plant quads face ±z, so the grass tint is multiplied by 0.86.
    expect(colorAt(mesh, north)[0]).toBeCloseTo((124 / 255) * 0.86, 6)
    expect(colorAt(mesh, south)[0]).toBeCloseTo((124 / 255) * 0.86, 6)
  })
})

describe('water synthesis', () => {
  it('renders water as tinted translucent cubes that cull against each other', () => {
    resetTintColors()
    const mesh = meshOf(['minecraft:water[level=0]'], [['aa']])
    expect(mesh.ranges.translucent.count).toBe(60) // 10 of 12 faces survive
    expect(mesh.ranges.opaque.count).toBe(0)
    expect(mesh.faceCount).toBe(10)
    // Synthesized quads carry tintindex 0 → water blue baked into vertices.
    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])[0]
    const water = colorAt(mesh, up)
    expect(water[0]).toBeCloseTo(0.24, 6)
    expect(water[1]).toBeCloseTo(0.46, 6)
    expect(water[2]).toBeCloseTo(0.89, 6)
  })

  it('waterlogged states add a tinted water cube around the block model', () => {
    resetTintColors()
    const mesh = meshOf(['minecraft:stone_slab[type=bottom,waterlogged=true]'], [['a']])
    expect(mesh.ranges.opaque.count).toBe(36) // the slab itself
    expect(mesh.ranges.translucent.count).toBe(36) // the synthesized water cube
    // The water top face carries tintindex 0; tint.ts colors waterlogged
    // states with the constant water blue.
    const up = vertexAt(mesh, [0, 1, 0], [0, 1, 0])
    expect(up).toHaveLength(1)
    const water = colorAt(mesh, up[0])
    expect(water[0]).toBeCloseTo(0.24, 6)
    expect(water[1]).toBeCloseTo(0.46, 6)
    expect(water[2]).toBeCloseTo(0.89, 6)
  })

  it('water does not occlude neighbor faces (stone shows through)', () => {
    const mesh = meshOf(['minecraft:stone', 'minecraft:water[level=0]'], [['ab']])
    expect(mesh.ranges.opaque.count).toBe(36) // stone east face kept
    expect(mesh.ranges.translucent.count).toBe(30) // water west face kept too
  })
})

// ---------------------------------------------------------------------------
// No-bundle fallback
// ---------------------------------------------------------------------------

describe('flat-color fallback (no bundle)', () => {
  it('meshes full cubes with block colors baked into vertex colors', () => {
    const mesh = meshOf(['minecraft:stone', 'minecraft:grass_block'], [['ab']], null)
    expect(mesh.ranges.flat.count).toBe(60) // 10 of 12 faces (shared pair culled)
    expect(mesh.ranges.opaque.count).toBe(0)
    const stone = vertexAt(mesh, [0, 0, 0], [-1, 0, 0])[0]
    // Stone gray 0x7d7d7d × the ±x face light 0.72.
    expect(colorAt(mesh, stone)[0]).toBeCloseTo((0x7d / 255) * 0.72, 6)
    expect(colorAt(mesh, stone)[1]).toBeCloseTo((0x7d / 255) * 0.72, 6)
    expect(colorAt(mesh, stone)[2]).toBeCloseTo((0x7d / 255) * 0.72, 6)
  })
})
