import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { AssetBundle } from '../types'
import {
  makeLookups,
  normalizeBlockStates,
  normalizeModel,
  type AssetStore,
} from './assets'
import { buildIconDrawList, texelTransform, type IconDrawList, type IconQuad } from './icon'
import type { BlockstateJson, ModelJson, VanillaAssets } from './model'
import { resetTintColors, setTintColors } from './tint'

/** Cube model with one texture per face slot ("#front" → north, …). */
function cubeModel(textures: Record<string, string>): ModelJson {
  const face = (key: string) => ({ texture: `#${key}` })
  return normalizeModel({
    textures,
    elements: [
      {
        from: [0, 0, 0],
        to: [16, 16, 16],
        faces: {
          up: face('top'),
          down: face('bottom'),
          north: face('front'),
          south: face('back'),
          west: face('west'),
          east: face('east'),
        },
      },
    ],
  })
}

interface Fixture {
  states: Record<string, BlockstateJson>
  models: Record<string, ModelJson>
  /** item name → item model JSON (keyed into minecraft:item/<name>). */
  itemModels?: Record<string, ModelJson>
  /** texture id → atlas cell [col, row] */
  textures: Record<string, [number, number]>
}

function makeStore(fixture: Fixture): AssetStore {
  const bundle = {
    formatVersion: 2,
    minecraftVersion: 'test',
    atlas: 'atlas-00000000.png',
    grid: 4,
    tile: 16,
    blockStates: Object.fromEntries(
      Object.entries(fixture.states).map(([key, json]) => [`minecraft:block/${key}`, json]),
    ),
    blockModels: Object.fromEntries(
      Object.entries(fixture.models).map(([key, model]) => [`minecraft:block/${key}`, model]),
    ),
    ...(fixture.itemModels
      ? {
          itemModels: Object.fromEntries(
            Object.entries(fixture.itemModels).map(([key, model]) => [
              `minecraft:item/${key}`,
              model,
            ]),
          ),
        }
      : {}),
    textures: Object.fromEntries(
      Object.entries(fixture.textures).map(([id, uv]) => [id, { uv, alpha: 'opaque' }]),
    ),
    tintColors: {},
  } as unknown as AssetBundle
  const assets: VanillaAssets = {
    blockStates: normalizeBlockStates(
      bundle.blockStates as unknown as Record<string, BlockstateJson>,
    ),
    blockModels: {
      ...Object.fromEntries(
        Object.entries(bundle.blockModels).map(([id, model]) => [id, normalizeModel(model)]),
      ),
      ...Object.fromEntries(
        Object.entries(bundle.itemModels ?? {}).map(([id, model]) => [id, normalizeModel(model)]),
      ),
    },
  }
  const lookups = makeLookups(bundle)
  return {
    bundle,
    texture: {} as THREE.Texture,
    assets,
    ...lookups,
    tintColors: { grass: [0.2, 0.9, 0.3], foliage: [0.1, 0.8, 0.2] },
  }
}

const CUBE_FIXTURE: Fixture = {
  states: { cube: { variants: { '': { model: 'minecraft:block/cube' } } } },
  models: {
    cube: cubeModel({
      top: 'minecraft:block/top',
      bottom: 'minecraft:block/bottom',
      front: 'minecraft:block/front',
      back: 'minecraft:block/back',
      west: 'minecraft:block/west',
      east: 'minecraft:block/east',
    }),
  },
  textures: {
    'minecraft:block/top': [0, 0],
    'minecraft:block/bottom': [1, 0],
    'minecraft:block/front': [2, 0],
    'minecraft:block/back': [3, 0],
    'minecraft:block/west': [0, 1],
    'minecraft:block/east': [1, 1],
  },
}

const quadsOf = (list: IconDrawList | null): IconQuad[] =>
  list && list.kind === 'blocks' ? list.quads : []

const centroid = (corners: [number, number][]): [number, number] => [
  corners.reduce((s, c) => s + c[0], 0) / corners.length,
  corners.reduce((s, c) => s + c[1], 0) / corners.length,
]

afterEach(() => {
  resetTintColors()
})

describe('buildIconDrawList (isometric inventory projection)', () => {
  it('shows top + north (left) + west (right) with vanilla face shades', () => {
    const store = makeStore(CUBE_FIXTURE)
    const list = buildIconDrawList(store, 'minecraft:cube', 64)
    expect(list).not.toBeNull()
    const byTexture = new Map(quadsOf(list).map((q) => [q.tileRect?.join(','), q]))
    expect(quadsOf(list)).toHaveLength(3)

    const front = quadsOf(list).find((q) => sameTile(q.tileRect, [2 * 16, 0, 16, 16]))
    const west = quadsOf(list).find((q) => sameTile(q.tileRect, [0 * 16, 1 * 16, 16, 16]))
    const top = quadsOf(list).find((q) => sameTile(q.tileRect, [0, 0, 16, 16]))
    expect([front, west, top].every(Boolean)).toBe(true)

    // Vanilla diffuse: up 1.0, north/south 0.8, east/west 0.6.
    expect(top!.shade).toBe(1)
    expect(front!.shade).toBeCloseTo(0.8)
    expect(west!.shade).toBeCloseTo(0.6)

    // Front (north) face sits left of center, west face right of it.
    expect(centroid(front!.corners)[0]).toBeLessThan(32)
    expect(centroid(west!.corners)[0]).toBeGreaterThan(32)
    // Top face above the side faces.
    expect(centroid(top!.corners)[1]).toBeLessThan(centroid(front!.corners)[1])
    // Everything inside the canvas.
    for (const q of quadsOf(list)) {
      for (const [x, y] of q.corners) {
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(64)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(64)
      }
    }
    expect(byTexture.size).toBe(3)
  })

  it('quads are painter-ordered (ascending depth)', () => {
    const store = makeStore({
      states: { stack: { variants: { '': { model: 'minecraft:block/stack' } } } },
      models: {
        stack: normalizeModel({
          textures: { base: 'minecraft:block/top', tip: 'minecraft:block/front' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 4, 16],
              faces: { up: { texture: '#base' }, north: { texture: '#base' } },
            },
            {
              from: [4, 4, 4],
              to: [12, 16, 12],
              faces: { up: { texture: '#tip' }, north: { texture: '#tip' } },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/top': [0, 0],
        'minecraft:block/front': [1, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:stack', 64)
    expect(list).not.toBeNull()
    const zs = quadsOf(list).map((q) => q.z)
    expect([...zs].sort((a, b) => a - b)).toEqual(zs)
    // The upper element's top face draws after the base's top face.
    const idx = (tileX: number) =>
      quadsOf(list).findIndex((q) => sameTile(q.tileRect, [tileX * 16, 0, 16, 16]))
    expect(idx(1)).toBeGreaterThan(idx(0))
  })

  it('prefers the unrotated variant so oriented fronts face left', () => {
    const store = makeStore({
      states: {
        furn: {
          variants: {
            'facing=east': { model: 'minecraft:block/furn', y: 270 },
            'facing=north': { model: 'minecraft:block/furn' },
          },
        },
      },
      models: {
        furn: cubeModel({
          top: 'minecraft:block/furn_top',
          bottom: 'minecraft:block/furn_top',
          front: 'minecraft:block/furn_front',
          back: 'minecraft:block/furn_side',
          west: 'minecraft:block/furn_side',
          east: 'minecraft:block/furn_side',
        }),
      },
      textures: {
        'minecraft:block/furn_top': [0, 0],
        'minecraft:block/furn_front': [1, 0],
        'minecraft:block/furn_side': [2, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:furn', 64)
    expect(list).not.toBeNull()
    // With y=270 the front texture would land on the (culled) east face;
    // the unrotated variant keeps it on north — visible, left, shade 0.8.
    const front = quadsOf(list).find((q) => sameTile(q.tileRect, [1 * 16, 0, 16, 16]))
    expect(front).toBeDefined()
    expect(front!.shade).toBeCloseTo(0.8)
    expect(centroid(front!.corners)[0]).toBeLessThan(32)
  })

  it('resolves bare (unnamespaced) texture references against the atlas', () => {
    const store = makeStore({
      states: {
        repeater: { variants: { 'facing=north': { model: 'minecraft:block/repeater' } } },
      },
      models: {
        repeater: normalizeModel({
          // 26.x jar style: no "minecraft:" prefix on the texture ids.
          textures: { top: 'block/repeater', slab: 'block/smooth_stone' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 2, 16],
              faces: {
                up: { texture: '#top' },
                north: { texture: '#slab' },
                west: { texture: '#slab' },
              },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/repeater': [0, 0],
        'minecraft:block/smooth_stone': [1, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:repeater', 64)
    expect(list).not.toBeNull()
    expect(quadsOf(list).length).toBe(3)
    expect(quadsOf(list).every((q) => q.tileRect !== null)).toBe(true)
  })

  it('renders exactly one model of a multi-property variant table (no state stacking)', () => {
    // Repeater-style: several unrotated entries that differ by delay/
    // powered — the icon must show only the first (default-ish) one.
    const store = makeStore({
      states: {
        repeater: {
          variants: {
            'delay=1,facing=north,powered=false': { model: 'minecraft:block/rep_1tick' },
            'delay=1,facing=north,powered=true': { model: 'minecraft:block/rep_1tick_on' },
            'delay=2,facing=north,powered=false': { model: 'minecraft:block/rep_2tick' },
            'delay=2,facing=east,powered=false': { model: 'minecraft:block/rep_2tick', y: 90 },
          },
        },
      },
      models: {
        rep_1tick: normalizeModel({
          textures: { all: 'minecraft:block/rep_top' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 2, 16],
              faces: { up: { texture: '#all' } },
            },
          ],
        }),
        rep_1tick_on: normalizeModel({
          textures: { all: 'minecraft:block/rep_on_top' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 2, 16],
              faces: { up: { texture: '#all' } },
            },
          ],
        }),
        rep_2tick: normalizeModel({
          textures: { all: 'minecraft:block/rep_2_top' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 2, 16],
              faces: { up: { texture: '#all' } },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/rep_top': [0, 0],
        'minecraft:block/rep_on_top': [1, 0],
        'minecraft:block/rep_2_top': [2, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:repeater', 64)
    expect(list).not.toBeNull()
    const tiles = new Set(quadsOf(list).map((q) => q.tileRect?.join(',')))
    expect(tiles).toEqual(new Set(['0,0,16,16']))
  })

  it('picks the straight shape among several unrotated corner variants (stairs)', () => {
    // Real oak_stairs shape: five unrotated entries whose alphabetical key
    // order starts with an INNER corner — the defaultness ranking must
    // pick the straight model, not whichever corner sorts first.
    const slab = (tex: string) =>
      normalizeModel({
        textures: { all: tex },
        elements: [
          { from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#all' }, north: { texture: '#all' } } },
        ],
      })
    const store = makeStore({
      states: {
        stairs: {
          variants: {
            'facing=east,half=bottom,shape=inner_right': { model: 'minecraft:block/stairs_inner' },
            'facing=east,half=bottom,shape=outer_right': { model: 'minecraft:block/stairs_outer' },
            'facing=east,half=bottom,shape=straight': { model: 'minecraft:block/stairs' },
            'facing=north,half=bottom,shape=straight': { model: 'minecraft:block/stairs', y: 270 },
          },
        },
      },
      models: {
        stairs: slab('minecraft:block/planks'),
        stairs_inner: slab('minecraft:block/planks_inner'),
        stairs_outer: slab('minecraft:block/planks_outer'),
      },
      textures: {
        'minecraft:block/planks': [0, 0],
        'minecraft:block/planks_inner': [1, 0],
        'minecraft:block/planks_outer': [2, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:stairs', 64)
    expect(list).not.toBeNull()
    const tiles = new Set(quadsOf(list).map((q) => q.tileRect?.join(',')))
    expect(tiles).toEqual(new Set(['0,0,16,16']))
  })

  it('multipart renders only unconditional parts for bare ids (walls show the post)', () => {
    const store = makeStore({
      states: {
        wallish: {
          multipart: [
            { apply: { model: 'minecraft:block/wall_post' } },
            { when: { north: 'true' }, apply: { model: 'minecraft:block/wall_arm' } },
          ],
        },
      },
      models: {
        wall_post: normalizeModel({
          textures: { all: 'minecraft:block/top' },
          elements: [
            {
              from: [4, 0, 4],
              to: [12, 16, 12],
              faces: { up: { texture: '#all' }, north: { texture: '#all' } },
            },
          ],
        }),
        wall_arm: normalizeModel({
          textures: { all: 'minecraft:block/front' },
          elements: [
            {
              from: [4, 0, 0],
              to: [12, 12, 4],
              faces: { up: { texture: '#all' }, north: { texture: '#all' } },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/top': [0, 0],
        'minecraft:block/front': [1, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:wallish', 64)
    expect(list).not.toBeNull()
    // `when: {north: 'true'}` fails against empty props: only the
    // unconditional post model renders, like the vanilla default state.
    const tiles = new Set(quadsOf(list).map((q) => q.tileRect?.join(',')))
    expect(tiles.has('0,0,16,16')).toBe(true)
    expect(tiles.has('16,0,16,16')).toBe(false)
  })

  it('marks atlas-missing textures as placeholder quads (tileRect null)', () => {
    const fixture: Fixture = {
      states: { holey: { variants: { '': { model: 'minecraft:block/holey' } } } },
      models: {
        holey: cubeModel({
          top: 'minecraft:block/top',
          bottom: 'minecraft:block/top',
          front: 'minecraft:block/absent',
          back: 'minecraft:block/top',
          west: 'minecraft:block/top',
          east: 'minecraft:block/top',
        }),
      },
      textures: { 'minecraft:block/top': [0, 0] },
    }
    const list = buildIconDrawList(makeStore(fixture), 'minecraft:holey', 64)
    expect(list).not.toBeNull()
    const front = quadsOf(list).find((q) => q.tileRect === null)
    expect(front).toBeDefined()
    expect(front!.shade).toBeCloseTo(0.8)
  })

  it('tints tintindex faces with the grass palette', () => {
    setTintColors({ grass: [0.2, 0.9, 0.3] })
    const fixture: Fixture = {
      states: { grass_block: { variants: { '': { model: 'minecraft:block/grass_cube' } } } },
      models: {
        grass_cube: normalizeModel({
          textures: {
            top: 'minecraft:block/grass_top',
            bottom: 'minecraft:block/dirt',
            front: 'minecraft:block/grass_side',
            back: 'minecraft:block/grass_side',
            west: 'minecraft:block/grass_side',
            east: 'minecraft:block/grass_side',
          },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 16, 16],
              faces: {
                up: { texture: '#top', tintindex: 0 },
                down: { texture: '#bottom' },
                north: { texture: '#front' },
                south: { texture: '#back' },
                west: { texture: '#west' },
                east: { texture: '#east' },
              },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/grass_top': [0, 0],
        'minecraft:block/dirt': [1, 0],
        'minecraft:block/grass_side': [2, 0],
      },
    }
    const list = buildIconDrawList(makeStore(fixture), 'minecraft:grass_block', 64)
    expect(list).not.toBeNull()
    const top = quadsOf(list).find((q) => sameTile(q.tileRect, [0, 0, 16, 16]))
    expect(top!.tint).toEqual([0.2, 0.9, 0.3])
    const side = quadsOf(list).find((q) => sameTile(q.tileRect, [2 * 16, 0, 16, 16]))
    expect(side!.tint).toBeNull()
  })

  it('renders item-form ids through their block alias (redstone → wire)', () => {
    const store = makeStore({
      states: {
        redstone_wire: { multipart: [{ apply: { model: 'minecraft:block/wire_dot' } }] },
      },
      models: {
        wire_dot: normalizeModel({
          textures: { dot: 'minecraft:block/redstone_dust_dot' },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 1, 16],
              faces: { up: { texture: '#dot', tintindex: 0 } },
            },
          ],
        }),
      },
      textures: { 'minecraft:block/redstone_dust_dot': [0, 0] },
    })
    const list = buildIconDrawList(store, 'minecraft:redstone', 64)
    expect(list).not.toBeNull()
    // power undefined → vanilla power-0 dark red tint on the dust dot.
    expect(quadsOf(list)[0].tint?.[0]).toBeCloseTo(0.4 * 0.3)
    expect(quadsOf(list)[0].tint?.[1]).toBe(0)
  })

  it('returns null for unknown blocks', () => {
    const store = makeStore(CUBE_FIXTURE)
    expect(buildIconDrawList(store, 'minecraft:does_not_exist', 64)).toBeNull()
  })
})

describe('item models (the inventory shows the item, not the placed block)', () => {
  it('renders item/generated models as flat sprites', () => {
    const store = makeStore({
      states: {
        redstone_wire: { multipart: [{ apply: { model: 'minecraft:block/wire_dot' } }] },
      },
      models: {
        wire_dot: normalizeModel({
          textures: { dot: 'minecraft:block/redstone_dust_dot' },
          elements: [{ from: [0, 0, 0], to: [16, 1, 16], faces: { up: { texture: '#dot' } } }],
        }),
      },
      itemModels: {
        generated: {},
        redstone: {
          parent: 'minecraft:item/generated',
          textures: { layer0: 'minecraft:item/redstone' },
        },
      },
      textures: {
        'minecraft:item/redstone': [3, 1],
        'minecraft:block/redstone_dust_dot': [0, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:redstone', 64)
    expect(list?.kind).toBe('sprite')
    if (list?.kind === 'sprite') {
      expect(list.tileRect).toEqual([3 * 16, 1 * 16, 16, 16])
    }
  })

  it('renders item models with their own elements isometrically', () => {
    const store = makeStore({
      states: { thing: { variants: { '': { model: 'minecraft:block/thing' } } } },
      models: {
        thing: cubeModel({
          top: 'minecraft:block/thing_top',
          bottom: 'minecraft:block/thing_top',
          front: 'minecraft:block/thing_top',
          back: 'minecraft:block/thing_top',
          west: 'minecraft:block/thing_top',
          east: 'minecraft:block/thing_top',
        }),
      },
      itemModels: {
        thing: normalizeModel({
          textures: { all: 'minecraft:block/thing_face' },
          elements: [
            {
              from: [2, 2, 2],
              to: [14, 14, 14],
              faces: {
                up: { texture: '#all' },
                down: { texture: '#all' },
                north: { texture: '#all' },
                south: { texture: '#all' },
                west: { texture: '#all' },
                east: { texture: '#all' },
              },
            },
          ],
        }),
      },
      textures: {
        'minecraft:block/thing_top': [0, 0],
        'minecraft:block/thing_face': [1, 0],
      },
    })
    const list = buildIconDrawList(store, 'minecraft:thing', 64)
    // The item's dedicated element wins over the full-cube blockstate.
    expect(list?.kind).toBe('blocks')
    const tiles = new Set(quadsOf(list).map((q) => q.tileRect?.join(',')))
    expect(tiles).toEqual(new Set(['16,0,16,16']))
  })

  it('falls back to the blockstate when the bundle has no item model', () => {
    const store = makeStore({
      states: { cube: { variants: { '': { model: 'minecraft:block/cube' } } } },
      models: {
        cube: cubeModel({
          top: 'minecraft:block/top',
          bottom: 'minecraft:block/top',
          front: 'minecraft:block/top',
          back: 'minecraft:block/top',
          west: 'minecraft:block/top',
          east: 'minecraft:block/top',
        }),
      },
      textures: { 'minecraft:block/top': [0, 0] },
    })
    const list = buildIconDrawList(store, 'minecraft:cube', 64)
    expect(list?.kind).toBe('blocks')
    expect(quadsOf(list)).toHaveLength(3)
  })
})

describe('texelTransform (affine texel→screen map)', () => {
  it('maps each uv corner onto its projected corner, including sub-rect uvs', () => {
    // Parallelogram corners paired with the bottom two texel rows of a
    // 16px tile (uv sub-rect like the repeater base's side faces).
    const corners: [number, number][] = [
      [3, 5],
      [13, 9],
      [17, 25],
      [7, 21],
    ]
    const uvs: [number, number][] = [
      [0, 14],
      [16, 14],
      [16, 16],
      [0, 16],
    ]
    const t = texelTransform(corners, uvs)!
    expect(t).not.toBeNull()
    for (let i = 0; i < 4; i++) {
      const [a, b, c, d, e, f] = t
      expect(a * uvs[i][0] + c * uvs[i][1] + e).toBeCloseTo(corners[i][0], 9)
      expect(b * uvs[i][0] + d * uvs[i][1] + f).toBeCloseTo(corners[i][1], 9)
    }
  })

  it('returns null for degenerate (zero-area) uv rects', () => {
    expect(
      texelTransform(
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ],
        [
          [5, 7],
          [5, 7],
          [5, 9],
          [5, 9],
        ],
      ),
    ).toBeNull()
  })
})

function sameTile(
  tileRect: [number, number, number, number] | null,
  expected: [number, number, number, number],
): boolean {
  return (
    tileRect !== null &&
    tileRect[0] === expected[0] &&
    tileRect[1] === expected[1] &&
    tileRect[2] === expected[2] &&
    tileRect[3] === expected[3]
  )
}
