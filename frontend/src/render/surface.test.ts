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
          down: { texture: '#bottom', cullface: 'down' },
          up: { texture: '#top', tintindex: 0, cullface: 'up' },
          north: { texture: '#side', cullface: 'north' },
          south: { texture: '#side', cullface: 'south' },
          west: { texture: '#side', cullface: 'west' },
          east: { texture: '#side', cullface: 'east' },
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
  // Full cube with one rotated face (glazed-terracotta pattern): the uv
  // corner set still covers 0/16, but each corner reads a rotated texel.
  'minecraft:block/rotated_face': {
    textures: { all: 'minecraft:block/glaze' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#all', cullface: 'down' },
          up: { texture: '#all', cullface: 'up' },
          north: { texture: '#all', cullface: 'north', rotation: 90 },
          south: { texture: '#all', cullface: 'south' },
          west: { texture: '#all', cullface: 'west' },
          east: { texture: '#all', cullface: 'east' },
        },
      },
    ],
  },
  // cube_column shape: canonical upright, but the axis=x variant turn spins
  // the uv axes of the faces it rotates (horizontal logs).
  'minecraft:block/column': {
    textures: { end: 'minecraft:block/log_end', side: 'minecraft:block/log_side' },
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          down: { texture: '#end', cullface: 'down' },
          up: { texture: '#end', cullface: 'up' },
          north: { texture: '#side', cullface: 'north' },
          south: { texture: '#side', cullface: 'south' },
          west: { texture: '#side', cullface: 'west' },
          east: { texture: '#side', cullface: 'east' },
        },
      },
    ],
  },
}

const BLOCKSTATES: Record<string, BlockstateJson> = {
  'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
  // Distinct id resolving to the same model+texture as stone (material-key
  // merging coverage).
  'minecraft:stone2': { variants: { '': { model: 'minecraft:block/stone' } } },
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
  'minecraft:glaze': { variants: { '': { model: 'minecraft:block/rotated_face' } } },
  'minecraft:oak_log': {
    variants: {
      'axis=y': { model: 'minecraft:block/column' },
      'axis=x': { model: 'minecraft:block/column', x: 90 },
    },
  },
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
  'minecraft:block/glaze': 'opaque',
  'minecraft:block/log_end': 'opaque',
  'minecraft:block/log_side': 'opaque',
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

function uvAt(mesh: MeshData, vertex: number): [number, number] {
  return [mesh.uvs[vertex * 2], mesh.uvs[vertex * 2 + 1]]
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
  it('stone next to stone culls the shared interior faces and merges the rest', () => {
    const mesh = meshOf(['minecraft:stone'], [['aaa']])
    expect(mesh.faceCount).toBe(6) // one merged quad per direction
    expect(mesh.ranges.opaque.count).toBe(36)
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
    expect(mesh.faceCount).toBe(6) // the 6 outer faces merge to one quad each
    expect(mesh.ranges.opaque.count).toBe(36)
  })

  it('glass culls against glass (same cull group) but not against stone', () => {
    const glass = meshOf(['minecraft:glass'], [['aa']])
    expect(glass.faceCount).toBe(6) // shared east/west pair culled, rest merged
    expect(glass.ranges.translucent.count).toBe(36)

    const pair = meshOf(['minecraft:glass', 'minecraft:stone'], [['ab']])
    // Glass face toward stone is culled (stone occludes)…
    expect(pair.ranges.translucent.count).toBe(30)
    // …but the stone face toward glass stays visible (east face at x=2).
    expect(pair.ranges.opaque.count).toBe(36)
    expect(vertexAt(pair, [2, 0, 0], [1, 0, 0])).toHaveLength(1)
  })

  it('leaves cull against leaves via their cull group', () => {
    const mesh = meshOf(['minecraft:oak_leaves'], [['aa']])
    expect(mesh.faceCount).toBe(6)
    expect(mesh.ranges.cutout.count).toBe(36)
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

    // Flat quads never sample the atlas: uv and tile origin stay at 0.
    for (let i = 0; i < mesh.uvs.length / 2; i++) {
      expect(mesh.uvs[i * 2]).toBe(0)
      expect(mesh.uvs[i * 2 + 1]).toBe(0)
      expect(mesh.tileOrigins[i * 2]).toBe(0)
      expect(mesh.tileOrigins[i * 2 + 1]).toBe(0)
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

    // The greedy scan emits single AO-shadowed cells in CUBE_FACES corner
    // order — here [(0,1,0),(0,1,1),(1,1,1),(1,1,0)] with strengths
    // [1, 0.7, 0.2, 0.7]: the default diagonal 0-2 sums 1.2 < the flipped
    // pair's 1.4, so the triangulation flips onto the brighter pair.
    const b = Math.min(...up)
    expectIndexSequence(mesh, [b + 1, b + 2, b + 3, b + 1, b + 3, b])
    expectNoIndexSequence(mesh, [b, b + 1, b + 2, b, b + 2, b + 3])
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
    // Corner order [(1,1,1),(1,1,2),(2,1,2),(2,1,1)] with strengths
    // [0.7, 0.7, 1, 0.7]: default diagonal 0-2 sums 1.7 > the other pair's
    // 1.4, so the default triangulation already joins the brighter pair.
    const b = Math.min(...up)
    expectIndexSequence(mesh, [b, b + 1, b + 2, b, b + 2, b + 3])
    expectNoIndexSequence(mesh, [b + 1, b + 2, b + 3, b + 1, b + 3, b])
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

  it('emits local texel uvs paired with per-vertex tile origins', () => {
    const mesh = meshOf(['minecraft:stone'], [['a']])
    // Every vertex carries the stone tile's atlas origin; the uv attribute
    // stays in model texel space (corner values 0 or 16) for the
    // tiled-uv materials to wrap per fragment.
    for (let i = 0; i < mesh.uvs.length / 2; i++) {
      expect(mesh.uvs[i * 2] === 0 || mesh.uvs[i * 2] === 16).toBe(true)
      expect(mesh.uvs[i * 2 + 1] === 0 || mesh.uvs[i * 2 + 1] === 16).toBe(true)
      expect(mesh.tileOrigins[i * 2]).toBeCloseTo(TILE.u0, 9)
      expect(mesh.tileOrigins[i * 2 + 1]).toBeCloseTo(TILE.v0, 9)
    }
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
    expect(mesh.ranges.translucent.count).toBe(36) // 10 of 12 faces survive, merged to 6
    expect(mesh.ranges.opaque.count).toBe(0)
    expect(mesh.faceCount).toBe(6)
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
    expect(mesh.ranges.flat.count).toBe(60) // 10 of 12 faces (shared pair culled, rest merged)
    expect(mesh.ranges.opaque.count).toBe(0)
    const stone = vertexAt(mesh, [0, 0, 0], [-1, 0, 0])[0]
    // Stone gray 0x7d7d7d × the ±x face light 0.72.
    expect(colorAt(mesh, stone)[0]).toBeCloseTo((0x7d / 255) * 0.72, 6)
    expect(colorAt(mesh, stone)[1]).toBeCloseTo((0x7d / 255) * 0.72, 6)
    expect(colorAt(mesh, stone)[2]).toBeCloseTo((0x7d / 255) * 0.72, 6)
  })
})

// ---------------------------------------------------------------------------
// Greedy merging
// ---------------------------------------------------------------------------

describe('greedy merging', () => {
  it('merges a same-state run into one quad per direction', () => {
    const mesh = meshOf(['minecraft:stone'], [['aaa', 'aaa', 'aaa']])
    expect(mesh.faceCount).toBe(6)
    // The up face is one 3x3 quad whose far corner sits at the run's edge
    // with its uv scaled to 0..48 texels (16 per block).
    const far = vertexAt(mesh, [3, 1, 3], [0, 1, 0])
    expect(far).toHaveLength(1)
    expect(uvAt(mesh, far[0])).toEqual([48, 48])
    expect(mesh.tileOrigins[far[0] * 2]).toBeCloseTo(TILE.u0, 9)
    expect(mesh.tileOrigins[far[0] * 2 + 1]).toBeCloseTo(TILE.v0, 9)
    // Interior merge does not double-emit: the down face's near corner
    // exists exactly once too.
    expect(vertexAt(mesh, [0, 0, 0], [0, -1, 0])).toHaveLength(1)
  })

  it('keeps AO-shadowed faces unmerged with per-corner AO like the per-face path', () => {
    // A 3-wide stone strip with one raised block on top: the strip's up
    // faces flanking the raised block see it in their outside-cell rings
    // and emit alone with vertex AO (the middle one is culled outright);
    // the raised block's own top and the strip's down face stay clean and
    // merge. Same AO strength values as the per-voxel path would bake.
    const mesh = meshOf(['minecraft:stone'], [['aaa'], ['.a.']])
    // up 3 (two AO-shadowed + merged raised top), down 1 (merged strip),
    // north/south 2 each (merged strip + merged raised), west/east 2 each
    // (merged strip end + AO-shadowed raised side).
    expect(mesh.faceCount).toBe(12)
    const cornerLight = (p: [number, number, number]): number[] =>
      vertexAt(mesh, p, [0, 1, 0]).map((v) => colorAt(mesh, v)[0])
    expect(cornerLight([0, 1, 0])).toEqual([1])
    // Vertex colors live in a Float32Array: compare the AO strength, not
    // the exact float32 rounding of 0.7.
    expect(cornerLight([1, 1, 0])[0]).toBeCloseTo(0.7, 6)
    expect(cornerLight([2, 1, 0])[0]).toBeCloseTo(0.7, 6)
  })

  it('merges glass runs while the cull group still hides shared faces', () => {
    const mesh = meshOf(['minecraft:glass'], [['aaa']])
    expect(mesh.faceCount).toBe(6) // interior east/west pair culled
    expect(mesh.ranges.translucent.count).toBe(36)
  })

  it('merges water surfaces into single quads with the water tint', () => {
    resetTintColors()
    const mesh = meshOf(['minecraft:water[level=0]'], [['aaa', 'aaa']])
    expect(mesh.faceCount).toBe(6)
    expect(mesh.ranges.translucent.count).toBe(36)
    const far = vertexAt(mesh, [3, 1, 2], [0, 1, 0])
    expect(far).toHaveLength(1)
    expect(uvAt(mesh, far[0])).toEqual([48, 32])
    const water = colorAt(mesh, far[0])
    expect(water[0]).toBeCloseTo(0.24, 6)
    expect(water[1]).toBeCloseTo(0.46, 6)
    expect(water[2]).toBeCloseTo(0.89, 6)
  })

  it('keeps tint and alpha segmentation on merged quads', () => {
    resetTintColors()
    const grass = meshOf(['minecraft:grass_block'], [['aa']])
    // Grass textures are opaque: all six merged faces land in opaque.
    expect(grass.ranges.opaque.count).toBe(36)
    expect(grass.ranges.cutout.count).toBe(0)
    const up = vertexAt(grass, [2, 1, 1], [0, 1, 0])[0]
    expect(colorAt(grass, up)[0]).toBeCloseTo(124 / 255, 6)
    expect(colorAt(grass, up)[1]).toBeCloseTo(189 / 255, 6)
    expect(colorAt(grass, up)[2]).toBeCloseTo(108 / 255, 6)
    // The untinted dirt down face keeps the 0.5 down light.
    const down = vertexAt(grass, [2, 0, 1], [0, -1, 0])[0]
    expect(colorAt(grass, down)[0]).toBeCloseTo(0.5, 6)

    const leaves = meshOf(['minecraft:oak_leaves'], [['aa']])
    expect(leaves.ranges.cutout.count).toBe(36) // cutout alpha class kept
    expect(leaves.ranges.translucent.count).toBe(0)
  })

  it('does not merge across different palette states', () => {
    const mesh = meshOf(['minecraft:stone', 'minecraft:grass_block'], [['ab']])
    // Two different blocks: the shared interior pair is culled and each
    // direction stays two single-width runs.
    expect(mesh.faceCount).toBe(10)
    expect(mesh.ranges.opaque.count).toBe(60)
  })

  it('merges different states that render identically (shared texture)', () => {
    // stone and stone2 resolve to the same model/texture/tint/alpha: their
    // faces are one material, so the run merges as if it were one state.
    const mesh = meshOf(['minecraft:stone', 'minecraft:stone2'], [['ab']])
    expect(mesh.faceCount).toBe(6)
    expect(mesh.ranges.opaque.count).toBe(36)
  })

  it('merges different states that share one fallback color (no bundle)', () => {
    // Stair facings differ only in properties; blockColor strips them, so
    // both cells render the same flat color and merge.
    const mesh = meshOf(
      ['minecraft:oak_stairs[facing=east]', 'minecraft:oak_stairs[facing=west]'],
      [['ab']],
      null,
    )
    expect(mesh.faceCount).toBe(6)
    expect(mesh.ranges.flat.count).toBe(36)
  })

  it('keeps per-face texture rotation off the merged path', () => {
    // The rotated north face's uv corners still cover 0/16 (the old
    // mergeability check passed), but a merged quad would rebuild the
    // canonical binding and spin the texture. The run must stay unmerged
    // and the model's uvs must survive verbatim.
    const mesh = meshOf(['minecraft:glaze'], [['aa']])
    expect(mesh.faceCount).toBe(10) // two cubes, shared pair culled, no merge
    const corner = vertexAt(mesh, [0, 0, 0], [0, 0, -1])
    expect(corner).toHaveLength(1)
    // rotation 90: the (0,0,0) corner reads texel (16,0), not the canonical
    // (16,16) a merged quad would emit.
    expect(uvAt(mesh, corner[0])).toEqual([16, 0])
  })

  it('keeps variant-turned cubes (horizontal logs) off the merged path', () => {
    // Upright logs are canonical cubes and merge; the x=90 turn spins the
    // uv axes of the rotated faces, so the lying run stays per-voxel.
    const upright = meshOf(['minecraft:oak_log[axis=y]'], [['aa']])
    expect(upright.faceCount).toBe(6)
    const lying = meshOf(['minecraft:oak_log[axis=x]'], [['aa']])
    expect(lying.faceCount).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// Coarse merge (giant grids)
// ---------------------------------------------------------------------------

describe('coarse merge', () => {
  /** Solid block with a one-deep square trench carved into the top layer;
   * the trench walls/floor are the AO-shadowed surfaces. */
  function trenchedCube(n: number): VoxelGrid {
    const data = new Uint16Array(n * n * n)
    data.fill(1)
    const lo = Math.floor(n / 4)
    const hi = n - lo
    for (let z = lo; z < hi; z++) {
      for (let x = lo; x < hi; x++) data[((n - 1) * n + z) * n + x] = 0
    }
    return { dims: [n, n, n], palette: ['minecraft:air', 'minecraft:stone'], data }
  }

  it(
    'drops per-vertex AO and merges by geometry past the occluder cap',
    () => {
      // 160^3 = 4.096M occluders > COARSE_MERGE_MAX_OCCLUDERS (3M).
      const huge = extractSurface(trenchedCube(160), null, new Map())
      // Geometry-only merging: 4 top rects around the trench, trench floor,
      // 4 trench walls, 4 outer sides, bottom.
      expect(huge.faceCount).toBeLessThan(20)
      // No AO anywhere: every vertex color is the stone color × one of the
      // four directional face lights (never darker).
      const stone = 0x7d / 255
      const lights = [1.0, 0.86, 0.72, 0.5]
      for (let i = 0; i < huge.colors.length; i++) {
        const c = huge.colors[i] / stone
        expect(lights.some((l) => Math.abs(c - l) < 1e-6)).toBe(true)
      }

      // Control: the same shape at 40^3 (64k occluders) keeps exact AO, so
      // trench edges stop merging and darkened corners exist.
      const small = extractSurface(trenchedCube(40), null, new Map())
      expect(small.faceCount).toBeGreaterThan(huge.faceCount)
      let darkened = 0
      for (let i = 0; i < small.colors.length; i++) {
        if (small.colors[i] < stone * 0.5 - 1e-6) darkened++
      }
      expect(darkened).toBeGreaterThan(0)
    },
    120_000,
  )

  it(
    'colors geometry-merged runs from the corner cells in the fallback',
    () => {
      // Two half-slabs of different colors side by side, made giant by
      // depth so the coarse path engages: one merged top quad whose corner
      // colors are each half's block color (locally averaged, not one flat
      // color and not the palette anchor alone).
      const n = 200
      const data = new Uint16Array(n * n * n)
      for (let y = 0; y < n; y++) {
        for (let z = 0; z < n; z++) {
          for (let x = 0; x < n; x++) data[(y * n + z) * n + x] = x < n / 2 ? 1 : 2
        }
      }
      const grid: VoxelGrid = {
        dims: [n, n, n],
        palette: ['minecraft:air', 'minecraft:stone', 'minecraft:sand'],
        data,
      }
      const mesh = extractSurface(grid, null, new Map())
      // Top faces merge into one quad spanning both colors: its four
      // corners split between stone and sand.
      const stone = 0x7d / 255
      const sand = 0xdb / 255
      let stoneCorners = 0
      let sandCorners = 0
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        if (mesh.normals[i * 3 + 1] !== 1) continue
        // Only the single merged top quad spans y = n.
        if (Math.abs(mesh.positions[i * 3 + 1] - n) > 1e-9) continue
        if (mesh.positions[i * 3] < n / 2) stoneCorners++
        else sandCorners++
      }
      expect(stoneCorners).toBe(2)
      expect(sandCorners).toBe(2)
      // And the corner colors really are the two block colors × up light.
      for (let i = 0; i < mesh.positions.length / 3; i++) {
        if (mesh.normals[i * 3 + 1] !== 1) continue
        if (Math.abs(mesh.positions[i * 3 + 1] - n) > 1e-9) continue
        const expected = mesh.positions[i * 3] < n / 2 ? stone : sand
        expect(mesh.colors[i * 3]).toBeCloseTo(expected, 6)
      }
    },
    120_000,
  )
})
