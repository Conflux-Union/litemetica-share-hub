/**
 * Coarse-LOD tests: downsampling semantics (occupancy, representative
 * mode), stride escalation, mesh compatibility with the full-precision
 * path, and the distance-switch hysteresis.
 */
import { describe, expect, it } from 'vitest'
import type { VoxelGrid } from './decode'
import { blockColor } from './colors'
import {
  buildCoarseMesh,
  buildLodMesh,
  lodLevelForDistance,
  LOD_ENTER_RATIO,
  LOD_RETURN_RATIO,
  type LodLevel,
} from './lod'

function grid(dims: [number, number, number], fill: (x: number, y: number, z: number) => string): VoxelGrid {
  const [dx, dy, dz] = dims
  const palette = ['minecraft:air']
  const intern = new Map<string, number>([['minecraft:air', 0]])
  const data = new Uint16Array(dx * dy * dz)
  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        const state = fill(x, y, z)
        if (state === 'minecraft:air') continue
        let pi = intern.get(state)
        if (pi === undefined) {
          pi = palette.length
          palette.push(state)
          intern.set(state, pi)
        }
        data[(y * dz + z) * dx + x] = pi
      }
    }
  }
  return { dims, palette, data }
}

interface QuadView {
  normal: [number, number, number]
  positions: [number, number, number][]
  colors: [number, number, number][]
}

/** Decode a MeshData back into per-quad views (indices come in base+1/+2 /
 * base / +2/+3 triangles sharing four vertices). */
function quads(mesh: {
  positions: Float32Array
  normals: Float32Array
  colors: Float32Array
  indices: Uint32Array
}): QuadView[] {
  const out: QuadView[] = []
  for (let i = 0; i < mesh.indices.length; i += 6) {
    const verts = [...mesh.indices.subarray(i, i + 6)]
      .sort((a, b) => a - b)
      .filter((v, k, arr) => k === 0 || v !== arr[k - 1])
    if (verts.length !== 4) throw new Error(`quad ${i / 6} does not have 4 vertices`)
    out.push({
      normal: [mesh.normals[verts[0] * 3], mesh.normals[verts[0] * 3 + 1], mesh.normals[verts[0] * 3 + 2]],
      positions: verts.map((vi) => [
        mesh.positions[vi * 3],
        mesh.positions[vi * 3 + 1],
        mesh.positions[vi * 3 + 2],
      ]) as [number, number, number][],
      colors: verts.map((vi) => [
        mesh.colors[vi * 3],
        mesh.colors[vi * 3 + 1],
        mesh.colors[vi * 3 + 2],
      ]) as [number, number, number][],
    })
  }
  return out
}

describe('buildCoarseMesh downsampling', () => {
  it('marks a cell occupied by any non-air voxel and skips air variants', () => {
    const sparse = grid([4, 4, 4], (x, y, z) => (x === 0 && y === 0 && z === 0 ? 'minecraft:stone' : 'minecraft:air'))
    const mesh = buildCoarseMesh(sparse, 2)
    // One occupied cell → its cube: exactly six quads.
    expect(mesh.faceCount).toBe(6)
    expect(mesh.indices.length).toBe(36)
    // All quads land in the flat (untextured) range.
    expect(mesh.ranges.flat.count).toBe(mesh.indices.length)
    expect(mesh.ranges.opaque.count).toBe(0)
    expect(mesh.ranges.cutout.count).toBe(0)
    expect(mesh.ranges.translucent.count).toBe(0)

    const caveAir = grid([4, 4, 4], () => 'minecraft:cave_air')
    expect(buildCoarseMesh(caveAir, 2).faceCount).toBe(0)
    const empty = grid([4, 4, 4], () => 'minecraft:air')
    expect(buildCoarseMesh(empty, 2).faceCount).toBe(0)
  })

  it('picks the most frequent non-air palette entry as the representative', () => {
    // One stride-2 cell over a 2x2x1 slab: 3 stone + 1 planks → stone.
    const majority = grid([2, 2, 1], (x, y) =>
      x === 1 && y === 1 ? 'minecraft:oak_planks' : 'minecraft:stone',
    )
    const mesh = buildCoarseMesh(majority, 2)
    expect(mesh.faceCount).toBe(6)
    const up = quads(mesh).find((q) => q.normal[1] === 1)!
    const [r, g, b] = blockColor('minecraft:stone')
    for (const c of up.colors) {
      expect(c[0]).toBeCloseTo(r, 6) // faceLight(up) === 1.0
      expect(c[1]).toBeCloseTo(g, 6)
      expect(c[2]).toBeCloseTo(b, 6)
    }
    // Down faces carry the 0.5 directional shade from surface.ts.
    const down = quads(mesh).find((q) => q.normal[1] === -1)!
    for (const c of down.colors) {
      expect(c[0]).toBeCloseTo(r * 0.5, 6)
    }

    const flipped = grid([2, 2, 1], (x, y) =>
      x === 0 && y === 0 ? 'minecraft:stone' : 'minecraft:oak_planks',
    )
    const mesh2 = buildCoarseMesh(flipped, 2)
    const up2 = quads(mesh2).find((q) => q.normal[1] === 1)!
    const [pr, pg, pb] = blockColor('minecraft:oak_planks')
    for (const c of up2.colors) {
      expect(c[0]).toBeCloseTo(pr, 6)
      expect(c[1]).toBeCloseTo(pg, 6)
      expect(c[2]).toBeCloseTo(pb, 6)
    }
  })

  it('emits zero uvs/tileOrigins sized to the vertex count (flat material path)', () => {
    const solid = grid([4, 4, 4], () => 'minecraft:stone')
    const mesh = buildCoarseMesh(solid, 2)
    expect(mesh.uvs).toBeInstanceOf(Float32Array)
    expect(mesh.tileOrigins).toBeInstanceOf(Float32Array)
    expect(mesh.uvs.length).toBe((mesh.positions.length / 3) * 2)
    expect(mesh.tileOrigins.length).toBe((mesh.positions.length / 3) * 2)
    expect(mesh.uvs.every((v) => v === 0)).toBe(true)
    expect(mesh.tileOrigins.every((v) => v === 0)).toBe(true)
  })

  it('shares the six axis normals with the full-precision mesher', () => {
    const solid = grid([4, 4, 4], () => 'minecraft:stone')
    const mesh = buildCoarseMesh(solid, 4)
    expect(mesh.faceCount).toBe(6) // one cell
    const normals = quads(mesh)
      .map((q) => q.normal.join(','))
      .sort()
    expect(normals).toEqual(
      ['-1,0,0', '0,-1,0', '0,0,-1', '0,0,1', '0,1,0', '1,0,0'].sort(),
    )
  })

  it('clamps the last partial cell row to the grid bound', () => {
    // 5 wide, stride 2 → 3 cells; only the 1-voxel-wide third cell is set.
    const partial = grid([5, 1, 1], (x) => (x === 4 ? 'minecraft:stone' : 'minecraft:air'))
    const mesh = buildCoarseMesh(partial, 2)
    expect(mesh.faceCount).toBe(6)
    let maxX = -Infinity
    let minX = Infinity
    for (let i = 0; i < mesh.positions.length; i += 3) {
      maxX = Math.max(maxX, mesh.positions[i])
      minX = Math.min(minX, mesh.positions[i])
    }
    expect(minX).toBe(4) // cell starts at 2*2
    expect(maxX).toBe(5) // clamped to dx, not 6
  })

  it('spans exactly the grid bounding box for a full solid grid', () => {
    const solid = grid([8, 8, 8], () => 'minecraft:stone')
    const mesh = buildCoarseMesh(solid, 8) // one cell
    for (let axis = 0; axis < 3; axis++) {
      let lo = Infinity
      let hi = -Infinity
      for (let i = 0; i < mesh.positions.length; i += 3) {
        lo = Math.min(lo, mesh.positions[i + axis])
        hi = Math.max(hi, mesh.positions[i + axis])
      }
      expect(lo).toBe(0)
      expect(hi).toBe(8)
    }
  })

  it('merges same-representative runs but not differing ones', () => {
    // Two side-by-side stride cells of different representatives: the
    // shared wall is culled, the outer faces stay per-cell (colors differ
    // per merge key), so 10 quads — not the 6 a single-material 2x1x1
    // slab would give.
    const pair = grid([2, 1, 1], (x) => (x === 0 ? 'minecraft:stone' : 'minecraft:oak_planks'))
    const mesh = buildCoarseMesh(pair, 1)
    expect(mesh.faceCount).toBe(10)

    const same = grid([2, 1, 1], () => 'minecraft:stone')
    expect(buildCoarseMesh(same, 1).faceCount).toBe(6)
  })
})

describe('buildLodMesh stride escalation', () => {
  /** 2x2x2 blocks alternating filled/empty: at cell stride 2 a 3D
   * checkerboard (every face exposed), at stride 4 fully occupied. */
  function checkerVolume(): VoxelGrid {
    return grid([8, 8, 8], (x, y, z) =>
      (Math.floor(x / 2) + Math.floor(y / 2) + Math.floor(z / 2)) % 2 === 0 ? 'minecraft:stone' : 'minecraft:air',
    )
  }

  it('keeps the first stride when under the cap', () => {
    const solid = grid([8, 8, 8], () => 'minecraft:stone')
    const result = buildLodMesh(solid)
    expect(result.stride).toBe(8)
    expect(result.mesh.faceCount).toBe(6)
  })

  it('escalates to a coarser stride when the quad cap is exceeded', () => {
    const result = buildLodMesh(checkerVolume(), undefined, { maxQuads: 10, strides: [2, 4] })
    expect(result.stride).toBe(4)
    expect(result.mesh.faceCount).toBe(6) // fully occupied → outer shell only
  })

  it('returns the coarsest attempt when every stride exceeds the cap', () => {
    const result = buildLodMesh(checkerVolume(), undefined, { maxQuads: 1, strides: [2, 4] })
    expect(result.stride).toBe(4)
    expect(result.mesh.faceCount).toBeGreaterThan(1)
  })
})

describe('lodLevelForDistance hysteresis', () => {
  const R = 10

  function levelAt(distance: number, current: LodLevel): LodLevel {
    return lodLevelForDistance(distance, R, current)
  }

  it('switches to coarse beyond the enter threshold and back below the return threshold', () => {
    expect(levelAt(R * LOD_ENTER_RATIO + 0.01, 'full')).toBe('coarse')
    expect(levelAt(R * LOD_RETURN_RATIO - 0.01, 'coarse')).toBe('full')
  })

  it('holds the current level inside the hysteresis band', () => {
    const mid = R * (LOD_ENTER_RATIO + LOD_RETURN_RATIO) / 2
    expect(levelAt(mid, 'full')).toBe('full')
    expect(levelAt(mid, 'coarse')).toBe('coarse')
  })

  it('treats the exact thresholds as inside the band', () => {
    expect(levelAt(R * LOD_ENTER_RATIO, 'full')).toBe('full')
    expect(levelAt(R * LOD_RETURN_RATIO, 'coarse')).toBe('coarse')
  })

  it('falls back to radius 1 for non-positive radii', () => {
    expect(lodLevelForDistance(3, 0, 'full')).toBe('coarse')
    expect(lodLevelForDistance(2, -5, 'coarse')).toBe('full')
  })
})
