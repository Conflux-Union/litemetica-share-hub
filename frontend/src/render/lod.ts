/**
 * Coarse-grained LOD mesh (plan §5): a stride-8/16/32 downsampling of the
 * voxel grid meshed with the same greedy six-direction scan as the main
 * surface mesher, but with one flat color per coarse cell instead of
 * textures — at far camera distances a textured preview flickers into
 * noise, a solid color is the conventional treatment.
 *
 * Two consumers:
 *  - distance LOD: render/meshWorker also builds this mesh when the
 *    full-precision face count is large, and Viewer3D swaps the levels by
 *    camera distance (hysteresis below);
 *  - degradation: when extractSurface throws its quad-budget guardrail
 *    (MeshBudgetError), the pipeline falls back to this mesh so an
 *    oversized schematic still renders, with a notice instead of an error.
 *
 * Downsampling semantics: a coarse cell is occupied when any non-air voxel
 * lies in its stride³ range; its representative state is the most frequent
 * non-air palette entry of that range (mode). The mode counting is one
 * O(volume) pass in total — every voxel is read exactly once, counted in a
 * shared scratch histogram that resets only the entries a cell touched, so
 * no per-cell reallocation and no per-cell rescans of foreign ranges. Ties
 * keep the entry that reached the top count first in scan order
 * (deterministic).
 *
 * Meshing: cells are opaque cubes — every occupied cell occludes its
 * neighbors — and the greedy merge key is the cell's representative
 * palette entry. Faces come from surface.ts's CUBE_FACES/DIR_SCAN tables
 * and shading from its faceLight, so normals, winding (backface culling)
 * and directional shade match the full-precision path exactly. Boundary
 * cells clamp to the grid edge, so the coarse mesh shares the full mesh's
 * bounding box (no size pop when switching levels).
 */

import { blockColor } from './colors'
import type { VoxelGrid } from './decode'
import { FACE_NORMALS } from './model'
import { CUBE_FACES, DIR_SCAN, faceLight, isAirState, type MeshData, type MeshRanges } from './surface'

/** Strides tried in order when the coarse mesh exceeds the quad cap. */
export const LOD_STRIDES = [8, 16, 32] as const

/** Above this many coarse quads buildLodMesh escalates to the next stride. */
export const MAX_COARSE_QUADS = 2_000_000

/** Camera-to-target distance (in bounding-sphere radii) past which the
 * viewer switches to the coarse mesh. */
export const LOD_ENTER_RATIO = 2.5

/** Distance below which it switches back; the band between the two ratios
 * holds the current level (hysteresis against border flicker). */
export const LOD_RETURN_RATIO = 2.1

export type LodLevel = 'full' | 'coarse'

/** Pure distance-switch decision with hysteresis: farther than
 * LOD_ENTER_RATIO radii → coarse, nearer than LOD_RETURN_RATIO → full,
 * in between keep `current`. A non-positive radius is treated as 1 (the
 * viewer never passes one, but the function stays total for tests). */
export function lodLevelForDistance(distance: number, radius: number, current: LodLevel): LodLevel {
  const ratio = distance / (radius > 0 ? radius : 1)
  if (ratio > LOD_ENTER_RATIO) return 'coarse'
  if (ratio < LOD_RETURN_RATIO) return 'full'
  return current
}

/** Grow-only scratch channels; smaller than surface.ts's Builder because
 * the coarse mesh needs a single untextured segment. */
class Channel {
  data: Float32Array
  length = 0

  constructor(initialWords: number) {
    this.data = new Float32Array(initialWords)
  }

  reserve(n: number): void {
    const need = this.length + n
    if (need <= this.data.length) return
    let cap = this.data.length * 2
    while (cap < need) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
}

/** Growable Uint32Array channel for the index buffer (surface.ts keeps its
 * own private copy; both stay allocation-free per quad). */
class IndexChannel {
  data: Uint32Array
  length = 0

  constructor(initialWords: number) {
    this.data = new Uint32Array(initialWords)
  }

  reserve(n: number): void {
    const need = this.length + n
    if (need <= this.data.length) return
    let cap = this.data.length * 2
    while (cap < need) cap *= 2
    const next = new Uint32Array(cap)
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
}

/**
 * Downsample `grid` to `stride`-sized cells and greedy-mesh the occupied
 * cell surface as a flat-colored MeshData (uvs/tileOrigins are zero arrays;
 * everything lands in the `flat` range, the untextured material path).
 * `onProgress`, when given, receives 0..1: the sampling pass to 45%, the
 * six greedy scans the rest, per y slab / per slice.
 */
export function buildCoarseMesh(
  grid: VoxelGrid,
  stride: number,
  onProgress?: (fraction: number) => void,
): MeshData {
  const [dx, dy, dz] = grid.dims
  const cx = Math.ceil(dx / stride)
  const cy = Math.ceil(dy / stride)
  const cz = Math.ceil(dz / stride)

  // Per-palette LUTs: air-ness for occupancy, block color for shading.
  const airLut = new Uint8Array(grid.palette.length)
  const colorLut = new Float32Array(grid.palette.length * 3)
  for (let i = 0; i < grid.palette.length; i++) {
    if (i !== 0 && !isAirState(grid.palette[i])) {
      const [r, g, b] = blockColor(grid.palette[i])
      colorLut[i * 3] = r
      colorLut[i * 3 + 1] = g
      colorLut[i * 3 + 2] = b
    } else {
      airLut[i] = 1
    }
  }

  // ---------------------------------------------------------------------
  // Sampling pass: representative state (mode) + occupancy per cell, one
  // voxel read total. cells[(yc*cz+zc)*cx+xc] = representative index, 0
  // for empty cells (global palette index 0 is air).
  // ---------------------------------------------------------------------
  const cells = new Uint16Array(cx * cy * cz)
  const counts = new Uint32Array(grid.palette.length)
  const touched: number[] = []
  for (let yc = 0; yc < cy; yc++) {
    const y0 = yc * stride
    const y1 = Math.min(y0 + stride, dy)
    for (let zc = 0; zc < cz; zc++) {
      const z0 = zc * stride
      const z1 = Math.min(z0 + stride, dz)
      for (let xc = 0; xc < cx; xc++) {
        const x0 = xc * stride
        const x1 = Math.min(x0 + stride, dx)
        let best = 0
        let bestCount = 0
        touched.length = 0
        for (let y = y0; y < y1; y++) {
          for (let z = z0; z < z1; z++) {
            const rowOff = (y * dz + z) * dx
            for (let x = x0; x < x1; x++) {
              const pi = grid.data[rowOff + x]
              if (pi === 0 || airLut[pi] !== 0) continue
              if (counts[pi] === 0) touched.push(pi)
              const c = ++counts[pi]
              if (c > bestCount) {
                bestCount = c
                best = pi
              }
            }
          }
        }
        for (const pi of touched) counts[pi] = 0
        cells[(yc * cz + zc) * cx + xc] = best
      }
    }
    if (onProgress && yc + 1 < cy) onProgress(0.05 + 0.4 * ((yc + 1) / cy))
  }
  if (onProgress) onProgress(0.45)

  // ---------------------------------------------------------------------
  // Greedy scans over the cell grid — same mask/sweep structure as
  // surface.ts, with the representative state as the whole merge key and
  // every occupied cell an occluder. Emitted rectangles span the covered
  // cells' world extent; the grid edge clamps so the last (partial) cell
  // row ends exactly at the grid bound.
  // ---------------------------------------------------------------------
  const dims = [cx, cy, cz] as const
  const worldDims = [dx, dy, dz] as const
  /** Index strides per axis for cells[(y*cz+z)*cx+x]. */
  const strideAxis = [1, cx * cz, cx] as const
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= cx || y >= cy || z >= cz) return -1
    return cells[(y * cz + z) * cx + x]
  }

  const positions = new Channel(1 << 14)
  const normals = new Channel(1 << 14)
  const colors = new Channel(1 << 14)
  const indices = new IndexChannel(1 << 14)

  /** World-space edge of cell index `a` along `axis`: `a * stride`, with the
   * far edge of the last cell clamped to the grid bound. */
  const edge = (a: number, axis: number): number =>
    a >= dims[axis] ? worldDims[axis] : a * stride

  for (let dirIdx = 0; dirIdx < 6; dirIdx++) {
    const face = CUBE_FACES[dirIdx]
    const scan = DIR_SCAN[dirIdx]
    const ua = scan.u
    const va = scan.v
    const da = scan.d
    const nu = dims[ua]
    const nv = dims[va]
    const nd = dims[da]
    const strideU = strideAxis[ua]
    const strideV = strideAxis[va]
    const strideD = strideAxis[da]
    const normal = FACE_NORMALS[face.dir]
    const light = faceLight(normal)
    const mask = new Int32Array(nu * nv)

    /** One merged flat rectangle: CUBE_FACES corner winding scaled by
     * stride, face light × block color baked per vertex. uvs / tile origins
     * stay all-zero (the return allocates them); the position pattern
     * mirrors surface.ts's emitMerged. */
    const emit = (pi: number, a0: number, b0: number, s: number, w: number, h: number): void => {
      const base = positions.length / 3
      positions.reserve(12)
      normals.reserve(12)
      colors.reserve(12)
      indices.reserve(6)
      for (let i = 0; i < 4; i++) {
        const c = face.corners[i]
        const cu = c[ua]
        const cv = c[va]
        const cd = c[da]
        positions.data[positions.length++] =
          ua === 0 ? edge(a0 + cu * w, 0) : va === 0 ? edge(b0 + cv * h, 0) : edge(s + cd, 0)
        positions.data[positions.length++] =
          ua === 1 ? edge(a0 + cu * w, 1) : va === 1 ? edge(b0 + cv * h, 1) : edge(s + cd, 1)
        positions.data[positions.length++] =
          ua === 2 ? edge(a0 + cu * w, 2) : va === 2 ? edge(b0 + cv * h, 2) : edge(s + cd, 2)
        normals.data[normals.length++] = normal[0]
        normals.data[normals.length++] = normal[1]
        normals.data[normals.length++] = normal[2]
        colors.data[colors.length++] = colorLut[pi * 3] * light
        colors.data[colors.length++] = colorLut[pi * 3 + 1] * light
        colors.data[colors.length++] = colorLut[pi * 3 + 2] * light
      }
      indices.data[indices.length++] = base
      indices.data[indices.length++] = base + 1
      indices.data[indices.length++] = base + 2
      indices.data[indices.length++] = base
      indices.data[indices.length++] = base + 2
      indices.data[indices.length++] = base + 3
    }

    for (let s = 0; s < nd; s++) {
      // Occupied cell whose neighbor along the face normal is outside the
      // grid or unoccupied: visible face. Same reconstruction as surface.ts
      // (`culled`): offset by the direction's normal, never diagonally;
      // at() returns -1 outside, and outside is visible.
      let m = 0
      const n = FACE_NORMALS[face.dir]
      for (let b = 0; b < nv; b++) {
        const rowOff = s * strideD + b * strideV
        for (let a = 0; a < nu; a++, m++) {
          const pi = cells[rowOff + a * strideU]
          if (pi === 0) continue
          const x = ua === 0 ? a : va === 0 ? b : s
          const y = ua === 1 ? a : va === 1 ? b : s
          const z = ua === 2 ? a : va === 2 ? b : s
          if (at(x + n[0], y + n[1], z + n[2]) > 0) continue
          mask[m] = pi
        }
      }
      // Maximal-rectangle sweep over equal representative states.
      for (let b = 0; b < nv; b++) {
        const row = b * nu
        for (let a = 0; a < nu; ) {
          const v = mask[row + a]
          if (v === 0) {
            a++
            continue
          }
          let w = 1
          while (a + w < nu && mask[row + a + w] === v) w++
          let h = 1
          grow: while (b + h < nv) {
            const below = (b + h) * nu + a
            for (let k = 0; k < w; k++) {
              if (mask[below + k] !== v) break grow
            }
            h++
          }
          emit(v, a, b, s, w, h)
          for (let bb = 0; bb < h; bb++) {
            const clear = (b + bb) * nu + a
            for (let k = 0; k < w; k++) mask[clear + k] = 0
          }
          a += w
        }
      }
      if (onProgress) onProgress(0.45 + 0.55 * ((dirIdx + (s + 1) / nd) / 6))
    }
  }

  const vertCount = positions.length / 3
  const ranges: MeshRanges = {
    opaque: { start: 0, count: 0 },
    cutout: { start: 0, count: 0 },
    translucent: { start: 0, count: 0 },
    flat: { start: 0, count: indices.length },
  }
  if (onProgress) onProgress(1)
  return {
    positions: positions.data.slice(0, positions.length),
    normals: normals.data.slice(0, normals.length),
    uvs: new Float32Array(vertCount * 2),
    tileOrigins: new Float32Array(vertCount * 2),
    colors: colors.data.slice(0, colors.length),
    indices: indices.data.slice(0, indices.length),
    ranges,
    faceCount: indices.length / 6,
  }
}

export interface LodResult {
  mesh: MeshData
  /** The stride that produced `mesh`. */
  stride: number
}

/**
 * Build the coarse LOD mesh, escalating the stride when the result exceeds
 * the quad cap: stride 8 first, then 16, then 32. If even the coarsest
 * stride stays above the cap it is returned anyway — it is still the
 * cheapest representation available. `opts.maxQuads` / `opts.strides`
 * override the cap and the ladder (tests).
 */
export function buildLodMesh(
  grid: VoxelGrid,
  onProgress?: (fraction: number) => void,
  opts?: { maxQuads?: number; strides?: readonly number[] },
): LodResult {
  const cap = opts?.maxQuads ?? MAX_COARSE_QUADS
  const strides = opts?.strides ?? LOD_STRIDES
  let mesh: MeshData | null = null
  let stride = strides[0]
  for (let i = 0; i < strides.length; i++) {
    stride = strides[i]
    mesh = buildCoarseMesh(grid, stride, onProgress)
    if (mesh.faceCount <= cap) return { mesh, stride }
  }
  return { mesh: mesh as MeshData, stride }
}
