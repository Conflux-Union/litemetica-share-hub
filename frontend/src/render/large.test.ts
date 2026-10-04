/**
 * Greedy-mesher scale gate: a solid 128x48x128 block with an internal
 * cavity must mesh orders of magnitude below the per-face quad count and
 * well inside the per-test timeout — this is the shape that used to OOM
 * browser tabs when every visible face became four JS-array vertices.
 */

import { describe, expect, it } from 'vitest'
import type { VoxelGrid } from './decode'
import { extractSurface } from './surface'

const DX = 128
const DY = 48
const DZ = 128
/** Cavity [c0, c1) per axis, hollowed out of the solid block. */
const C0 = [40, 8, 48] as const
const C1 = [88, 24, 80] as const

function solidWithCavity(): VoxelGrid {
  const data = new Uint16Array(DX * DY * DZ)
  data.fill(1) // palette 1: minecraft:stone
  for (let y = C0[1]; y < C1[1]; y++) {
    for (let z = C0[2]; z < C1[2]; z++) {
      data.fill(0, (y * DZ + z) * DX + C0[0], (y * DZ + z) * DX + C1[0])
    }
  }
  return { dims: [DX, DY, DZ], palette: ['minecraft:air', 'minecraft:stone'], data }
}

/** Brute-force count of visible faces (the old mesher's quad count). */
function perFaceCount(grid: VoxelGrid): number {
  const [dx, dy, dz] = grid.dims
  const solid = (x: number, y: number, z: number): boolean =>
    x >= 0 && y >= 0 && z >= 0 && x < dx && y < dy && z < dz && grid.data[(y * dz + z) * dx + x] !== 0
  let faces = 0
  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        if (!solid(x, y, z)) continue
        if (!solid(x + 1, y, z)) faces++
        if (!solid(x - 1, y, z)) faces++
        if (!solid(x, y + 1, z)) faces++
        if (!solid(x, y - 1, z)) faces++
        if (!solid(x, y, z + 1)) faces++
        if (!solid(x, y, z - 1)) faces++
      }
    }
  }
  return faces
}

describe('large greedy mesh', () => {
  it(
    'collapses a 128x48x128 solid-with-cavity far below the per-face count',
    () => {
      const grid = solidWithCavity()
      const mesh = extractSurface(grid, null)
      const perFace = perFaceCount(grid)

      // Outer shell + cavity: at least one quad per direction and surface.
      expect(mesh.faceCount).toBeGreaterThanOrEqual(12)
      // Greedy merging must win by roughly two orders of magnitude (the
      // measured ratio here is ~83x); the AO-shadowed bands around the
      // cavity edges keep several hundred single quads, everything else
      // collapses to maximal rectangles.
      expect(mesh.faceCount).toBeLessThan(perFace / 50)
      expect(mesh.faceCount).toBeLessThan(5000)
      expect(mesh.ranges.flat.count).toBe(mesh.indices.length) // fallback mode
    },
    120_000,
  )
})
