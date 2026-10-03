import { describe, expect, it } from 'vitest'
import {
  autoUV,
  compileGeometry,
  flattenModel,
  isFullCube,
  type ModelJson,
  type Quad,
} from './geometry'

// ---------------------------------------------------------------------------
// Fixtures: vanilla JSON snippets (cube parent chain, wall torch, stairs,
// redstone dust plates).
// ---------------------------------------------------------------------------

const cubeChainModels: Record<string, ModelJson> = {
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
  'minecraft:block/stone_bricks': {
    parent: 'minecraft:block/cube_all',
    textures: { all: 'minecraft:block/stone_bricks' },
  },
}

const wallTorchModels: Record<string, ModelJson> = {
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
}

const stairsModels: Record<string, ModelJson> = {
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bbox(quads: Quad[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity]
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  for (const q of quads) {
    for (const p of q.positions) {
      for (let i = 0; i < 3; i++) {
        if (p[i] < min[i]) min[i] = p[i]
        if (p[i] > max[i]) max[i] = p[i]
      }
    }
  }
  return { min, max }
}

function hasCorner(quads: Quad[], x: number, y: number, z: number, eps = 1e-9): boolean {
  return quads.some((q) =>
    q.positions.some((p) => Math.abs(p[0] - x) < eps && Math.abs(p[1] - y) < eps && Math.abs(p[2] - z) < eps),
  )
}

/** Every quad must be counter-clockwise seen from outside (three.js front). */
function assertCcw(quads: Quad[]): void {
  for (const q of quads) {
    const [a, b, c] = q.positions
    const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const cross = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ]
    const dot = cross[0] * q.normal[0] + cross[1] * q.normal[1] + cross[2] * q.normal[2]
    if (dot <= 0) throw new Error(`quad not CCW: normal ${q.normal}, dot ${dot}`)
  }
}

// ---------------------------------------------------------------------------
// flattenModel
// ---------------------------------------------------------------------------

describe('flattenModel: parent chain', () => {
  it('merges textures root→leaf, takes elements from the deepest declarer, resolves #refs', () => {
    const flat = flattenModel('minecraft:block/stone', cubeChainModels)
    expect(flat).not.toBeNull()
    expect(flat!.textures).toEqual({
      particle: 'minecraft:block/stone',
      all: 'minecraft:block/stone',
    })
    // Elements come from cube, two levels up the chain.
    expect(flat!.elements).toHaveLength(1)
    expect(flat!.elements[0].from).toEqual([0, 0, 0])
    expect(flat!.elements[0].to).toEqual([16, 16, 16])
    // Face #refs are resolved to concrete texture ids.
    expect(flat!.elements[0].faces.north).toMatchObject({
      texture: 'minecraft:block/stone',
      cullface: 'north',
    })
  })

  it('lets the leaf model override a parent texture', () => {
    const flat = flattenModel('minecraft:block/stone_bricks', cubeChainModels)
    expect(flat!.textures.all).toBe('minecraft:block/stone_bricks')
    expect(flat!.elements[0].faces.up!.texture).toBe('minecraft:block/stone_bricks')
  })

  it('keeps an unresolvable #ref verbatim', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/orphan': {
        textures: { a: '#missing' },
        elements: [
          { from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#a' } } },
        ],
      },
    }
    expect(flattenModel('minecraft:block/orphan', models)!.elements[0].faces.up!.texture).toBe(
      '#missing',
    )
  })

  it('guards #ref cycles without hanging', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/cyclic': {
        textures: { a: '#b', b: '#a' },
        elements: [
          { from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#a' } } },
        ],
      },
    }
    const flat = flattenModel('minecraft:block/cyclic', models)!
    expect(flat.textures.a).toBe('#b')
    expect(flat.elements[0].faces.up!.texture).toBe('#b')
  })

  it('guards parent-chain cycles and tolerates missing parents', () => {
    const models: Record<string, ModelJson> = {
      a: { parent: 'b', textures: { t: 'minecraft:block/x' } },
      b: { parent: 'a' },
      c: { parent: 'minecraft:block/nope', textures: { t: 'minecraft:block/y' } },
    }
    const a = flattenModel('a', models)!
    expect(a.textures.t).toBe('minecraft:block/x')
    expect(a.elements).toHaveLength(0)
    const c = flattenModel('c', models)!
    expect(c.textures.t).toBe('minecraft:block/y')
    expect(flattenModel('minecraft:block/nope', models)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isFullCube
// ---------------------------------------------------------------------------

describe('isFullCube', () => {
  it('accepts a single full-span element (cube_all chain)', () => {
    expect(isFullCube(flattenModel('minecraft:block/stone', cubeChainModels)!)).toBe(true)
  })

  it('accepts inverted from/to bounds after normalization', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/inverted': {
        elements: [
          {
            from: [16, 16, 16],
            to: [0, 0, 0],
            faces: { up: { texture: 't' } },
          },
        ],
      },
    }
    expect(isFullCube(flattenModel('minecraft:block/inverted', models)!)).toBe(true)
  })

  it('rejects partial spans, multi-element models and rotated elements', () => {
    const slab: Record<string, ModelJson> = {
      'minecraft:block/slab': {
        elements: [
          { from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: 't' } } },
        ],
      },
    }
    expect(isFullCube(flattenModel('minecraft:block/slab', slab)!)).toBe(false)
    expect(isFullCube(flattenModel('minecraft:block/oak_stairs', stairsModels)!)).toBe(false)
    expect(isFullCube(flattenModel('minecraft:block/wall_torch', wallTorchModels)!)).toBe(false)
    const rotated: Record<string, ModelJson> = {
      'minecraft:block/rot': {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            rotation: { origin: [8, 8, 8], axis: 'x', angle: 45 },
            faces: { up: { texture: 't' } },
          },
        ],
      },
    }
    expect(isFullCube(flattenModel('minecraft:block/rot', rotated)!)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// compileGeometry
// ---------------------------------------------------------------------------

describe('compileGeometry: cube template', () => {
  const quads = compileGeometry(flattenModel('minecraft:block/stone', cubeChainModels)!)

  it('emits one quad per face with per-direction normal and cullface', () => {
    expect(quads).toHaveLength(6)
    const byCull = new Map(quads.map((q) => [q.cullface, q]))
    expect([...byCull.keys()].sort()).toEqual(['down', 'east', 'north', 'south', 'up', 'west'])
    expect(byCull.get('north')!.normal).toEqual([0, 0, -1])
    expect(byCull.get('up')!.normal).toEqual([0, 1, 0])
    expect(byCull.get('east')!.normal).toEqual([1, 0, 0])
    expect(byCull.get('north')!.texture).toBe('minecraft:block/stone')
  })

  it('spans [0,1]³ and winds CCW seen from outside', () => {
    const { min, max } = bbox(quads)
    expect(min).toEqual([0, 0, 0])
    expect(max).toEqual([1, 1, 1])
    assertCcw(quads)
  })

  it('defaults face UVs to the full texture for a full block', () => {
    for (const q of quads) expect(q.uvRect).toEqual([0, 0, 16, 16])
    const north = quads.find((q) => q.cullface === 'north')!
    expect(north.uvs).toEqual([
      [16, 16],
      [16, 0],
      [0, 0],
      [0, 16],
    ])
  })
})

describe('compileGeometry: default UVs from element bounds (vanilla rules)', () => {
  const models: Record<string, ModelJson> = {
    'minecraft:block/carpet': {
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 1, 16],
          faces: {
            down: { texture: 't' },
            up: { texture: 't' },
            north: { texture: 't' },
            west: { texture: 't' },
          },
        },
      ],
    },
    'minecraft:block/dust_line': {
      elements: [
        {
          from: [0, 3, 7],
          to: [16, 7, 9],
          faces: { up: { texture: 't' }, north: { texture: 't' } },
        },
      ],
    },
  }

  it('derives per-face UVs from the element bounds', () => {
    const quads = compileGeometry(flattenModel('minecraft:block/carpet', models)!)
    const byNormal = (n: [number, number, number]) =>
      quads.find((q) => q.normal[0] === n[0] && q.normal[1] === n[1] && q.normal[2] === n[2])!
    // carpet: up/down keep x/z; sides take a 1px-tall band.
    expect(byNormal([0, 1, 0]).uvRect).toEqual([0, 0, 16, 16])
    expect(byNormal([0, 0, -1]).uvRect).toEqual([0, 15, 16, 16])
    expect(byNormal([-1, 0, 0]).uvRect).toEqual([0, 15, 16, 16])
  })

  it('derives the middle texture band for a dust line (autoUV table)', () => {
    expect(autoUV('up', [0, 3, 7], [16, 7, 9])).toEqual([0, 7, 16, 9])
    expect(autoUV('down', [0, 3, 7], [16, 7, 9])).toEqual([0, 7, 16, 9])
    expect(autoUV('north', [0, 3, 7], [16, 7, 9])).toEqual([0, 9, 16, 13])
    expect(autoUV('south', [0, 3, 7], [16, 7, 9])).toEqual([0, 9, 16, 13])
    expect(autoUV('west', [0, 3, 7], [16, 7, 9])).toEqual([7, 9, 9, 13])
    expect(autoUV('east', [0, 3, 7], [16, 7, 9])).toEqual([7, 9, 9, 13])
    expect(autoUV('up', [0, 0, 0], [16, 1, 16])).toEqual([0, 0, 16, 16])
    expect(autoUV('north', [0, 0, 0], [16, 1, 16])).toEqual([0, 15, 16, 16])
  })

  it('uses the default UV in compiled quads', () => {
    const quads = compileGeometry(flattenModel('minecraft:block/dust_line', models)!)
    const north = quads.find((q) => q.normal[2] === -1)!
    expect(north.uvRect).toEqual([0, 9, 16, 13])
    // v spans the 4px band; u spans the full width.
    expect(north.uvs).toEqual([
      [16, 13],
      [16, 9],
      [0, 9],
      [0, 13],
    ])
  })
})

describe('compileGeometry: explicit UVs and face rotation', () => {
  const models: Record<string, ModelJson> = {
    'minecraft:block/explicit': {
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: {
            north: { texture: 't', uv: [2, 4, 10, 12] },
            south: { texture: 't', uv: [2, 4, 10, 12], rotation: 90 },
          },
        },
      ],
    },
  }
  const quads = compileGeometry(flattenModel('minecraft:block/explicit', models)!)

  it('keeps explicit UVs in 0..16 space', () => {
    expect(quads.find((q) => q.normal[2] === -1)!.uvs).toEqual([
      [10, 12],
      [10, 4],
      [2, 4],
      [2, 12],
    ])
  })

  it('rotates UV corners by 90° steps', () => {
    expect(quads.find((q) => q.normal[2] === 1)!.uvs).toEqual([
      [10, 4],
      [2, 4],
      [2, 12],
      [10, 12],
    ])
  })
})

describe('compileGeometry: tintindex passthrough', () => {
  it('carries tintindex only where declared', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/grass': {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              up: { texture: 'grass_top', tintindex: 0 },
              north: { texture: 'grass_side' },
              south: { texture: 'grass_side_overlay', tintindex: 0 },
            },
          },
        ],
      },
    }
    const quads = compileGeometry(flattenModel('minecraft:block/grass', models)!)
    expect(quads.find((q) => q.normal[1] === 1)!.tintindex).toBe(0)
    expect(quads.find((q) => q.normal[2] === -1)!.tintindex).toBeUndefined()
    expect(quads.find((q) => q.normal[2] === 1)!.tintindex).toBe(0)
  })
})

describe('compileGeometry: element rotation', () => {
  const models: Record<string, ModelJson> = {
    'minecraft:block/rot45': {
      elements: [
        {
          from: [0, 6, 6],
          to: [8, 10, 10],
          rotation: { origin: [8, 8, 8], axis: 'y', angle: 45 },
          faces: { up: { texture: 't' }, north: { texture: 't' } },
        },
      ],
    },
  }
  const quads = compileGeometry(flattenModel('minecraft:block/rot45', models)!)

  it('rotates vertices around the element origin (right-hand rule)', () => {
    // Corner (0,6,6)/16 rotated 45° around (8,8,8)/16 around +y:
    // rel=(-0.5,-0.125,-0.125) → (-0.625·cos45, -0.125, 0.375·cos45).
    expect(hasCorner(quads, 0.05805826175841, 0.375, 0.76516504294496, 1e-9)).toBe(true)
  })

  it('preserves the axis coordinate and radial distances to the origin', () => {
    const o = [0.5, 0.5, 0.5]
    // Original x/z offsets from the origin: x ∈ {-0.5, 0}, z ∈ {-0.125, 0.125}.
    const expectedRadii = [0.125, 0.5, Math.hypot(0.5, 0.125)]
    for (const q of quads) {
      for (const p of q.positions) {
        expect(p[1] === 0.375 || p[1] === 0.625).toBe(true)
        const r = Math.hypot(p[0] - o[0], p[2] - o[2])
        expect(expectedRadii.some((e) => Math.abs(r - e) < 1e-12)).toBe(true)
      }
    }
  })
})

describe('compileGeometry: variant x/y rotation with cullface remap', () => {
  it('rotates a wall torch y=90 around the block center', () => {
    const quads = compileGeometry(flattenModel('minecraft:block/wall_torch', wallTorchModels)!, {
      y: 90,
    })
    expect(quads).toHaveLength(6)
    assertCcw(quads)
    // Unrotated x∈[6,10]/16 z∈[7,9]/16 → after y+90: x∈[7,9]/16, z∈[6,10]/16.
    const { min, max } = bbox(quads)
    expect(min).toEqual([7 / 16, 0, 6 / 16])
    expect(max).toEqual([9 / 16, 10 / 16, 10 / 16])
  })

  it('remaps cullface under y rotation (north→east)', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/cull_cube': {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: 't', cullface: 'north' } },
          },
        ],
      },
    }
    const quads = compileGeometry(flattenModel('minecraft:block/cull_cube', models)!, { y: 90 })
    expect(quads).toHaveLength(1)
    expect(quads[0].cullface).toBe('east')
    expect(quads[0].normal).toEqual([1, 0, 0])
    // The north plane (z=0) maps onto the east plane (x=1).
    for (const p of quads[0].positions) expect(p[0]).toBe(1)
  })

  it('remaps cullface under x rotation (down→up) and flips stairs half=top', () => {
    const quads = compileGeometry(flattenModel('minecraft:block/oak_stairs', stairsModels)!, {
      x: 180,
    })
    // The base slab's down face (cullface down, y=0) becomes the top plane.
    const up = quads.find((q) => q.cullface === 'up')!
    expect(up).toBeDefined()
    for (const p of up.positions) expect(p[1]).toBe(1)
    // The upper step's up face (cullface up, y=1) becomes the bottom plane.
    const down = quads.find((q) => q.cullface === 'down')!
    for (const p of down.positions) expect(p[1]).toBe(0)
    assertCcw(quads)
  })

  it('remaps cullface under combined x then y rotations', () => {
    const models: Record<string, ModelJson> = {
      'minecraft:block/cull_cube': {
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: { north: { texture: 't', cullface: 'north' } },
          },
        ],
      },
    }
    // x=90 (clockwise seen from +x): north(0,0,-1) → (0,-1,0)=down; then
    // y=270: down stays down.
    const quads = compileGeometry(flattenModel('minecraft:block/cull_cube', models)!, {
      x: 90,
      y: 270,
    })
    expect(quads[0].cullface).toBe('down')
    expect(quads[0].normal).toEqual([0, -1, 0])
  })
})

// ---------------------------------------------------------------------------
// Vanilla rotation direction, regression-tested against the real 26.3
// bundle data (furnace / wall_torch / end_rod blockstates quoted verbatim;
// models reduced to the load-bearing geometry).
// ---------------------------------------------------------------------------

describe('compileGeometry: vanilla variant rotation direction (26.3 bundle data)', () => {
  const bundleModels: Record<string, ModelJson> = {
    // block/furnace via block/orientable(_with_bottom): the #front face is
    // north in the unrotated model.
    'minecraft:block/furnace': {
      textures: { front: 'minecraft:block/furnace_front' },
      elements: [
        {
          from: [0, 0, 0],
          to: [16, 16, 16],
          faces: { north: { texture: '#front', cullface: 'north' } },
        },
      ],
    },
    // block/wall_torch via template_torch_wall: from [-1,3.5,7] to
    // [1,13.5,9] — flush against the west wall, pointing east.
    'minecraft:block/wall_torch': {
      textures: { torch: 'minecraft:block/torch' },
      elements: [
        {
          from: [-1, 3.5, 7],
          to: [1, 13.5, 9],
          faces: { up: { texture: '#torch' }, down: { texture: '#torch' } },
        },
      ],
    },
    // end_rod-style rod growing +y (single up face at the tip).
    'minecraft:block/end_rod': {
      textures: { rod: 'minecraft:block/end_rod' },
      elements: [
        {
          from: [0, 4, 7],
          to: [2, 16, 9],
          faces: { up: { texture: '#rod' } },
        },
      ],
    },
  }

  it('furnace facing=east (y=90) shows its front on the east face', () => {
    // Verbatim bundle variant: "facing=east,lit=false": { y: 90 }.
    const quads = compileGeometry(flattenModel('minecraft:block/furnace', bundleModels)!, { y: 90 })
    const front = quads.find((q) => q.texture === 'minecraft:block/furnace_front')!
    expect(front.normal).toEqual([1, 0, 0])
    expect(front.cullface).toBe('east')
  })

  it('wall_torch facing=south (y=90) mounts on the north wall', () => {
    // Verbatim bundle variant: "facing=south": { y: 90 }. The torch hugs the
    // west plane (x∈[-1,1]/16) unrotated; y=90 must move it to the north
    // wall: x∈[7,9]/16, z∈[-1,1]/16 (centered, flush at z=0).
    const quads = compileGeometry(flattenModel('minecraft:block/wall_torch', bundleModels)!, {
      y: 90,
    })
    const { min, max } = bbox(quads)
    expect(min[0]).toBeCloseTo(7 / 16, 12)
    expect(max[0]).toBeCloseTo(9 / 16, 12)
    expect(min[2]).toBeCloseTo(-1 / 16, 12)
    expect(max[2]).toBeCloseTo(1 / 16, 12)
  })

  it('end_rod facing=north (x=90) points its tip face toward north', () => {
    // Verbatim bundle variant: "facing=north": { x: 90 }. The rod's up face
    // must become the north face, not the south face.
    const quads = compileGeometry(flattenModel('minecraft:block/end_rod', bundleModels)!, {
      x: 90,
    })
    const tip = quads.find((q) => q.texture === 'minecraft:block/end_rod')!
    expect(tip.normal).toEqual([0, 0, -1])
  })

  it('end_rod facing=west (x=90 then y=270) points its tip face west', () => {
    // Verbatim bundle variant: "facing=west": { x: 90, y: 270 }.
    const quads = compileGeometry(flattenModel('minecraft:block/end_rod', bundleModels)!, {
      x: 90,
      y: 270,
    })
    const tip = quads.find((q) => q.texture === 'minecraft:block/end_rod')!
    expect(tip.normal).toEqual([-1, 0, 0])
  })
})
