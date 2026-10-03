import { gunzipSync } from 'fflate'
import type { PreviewData } from '../types'

export const EMPTY = 0

export interface VoxelGrid {
  /** Dimensions as [x, y, z]. */
  dims: [number, number, number]
  /** Global block-id palette; index 0 is reserved for air/empty. */
  palette: string[]
  /** Palette index per voxel (y * dz * dx + z * dx + x), EMPTY for air. */
  data: Uint16Array
}

/**
 * Decode the gzipped RLE preview payload into a global voxel grid.
 * RLE order matches the backend iteration: x fastest, then z, then y.
 */
export function decodePreview(gzBytes: Uint8Array): VoxelGrid {
  const json = new TextDecoder().decode(gunzipSync(gzBytes))
  const preview = JSON.parse(json) as PreviewData
  return decodePreviewData(preview)
}

export function decodePreviewData(preview: PreviewData): VoxelGrid {
  const [dx, dy, dz] = preview.size
  const data = new Uint16Array(dx * dy * dz)

  // Build a global palette; index 0 stays empty/air.
  const globalIndex = new Map<string, number>([['minecraft:air', EMPTY]])
  const palette: string[] = ['minecraft:air']
  const intern = (id: string): number => {
    let idx = globalIndex.get(id)
    if (idx === undefined) {
      idx = palette.length
      if (idx > 0xffff) throw new Error('too many distinct blocks in preview')
      palette.push(id)
      globalIndex.set(id, idx)
    }
    return idx
  }

  for (const region of preview.regions) {
    // Intern this region's palette first so RLE expansion stays tight.
    const localToGlobal = region.palette.map(intern)
    const [sx, sy, sz] = region.size
    const [px, py, pz] = region.pos
    // A litematica sub-region spans [pos, pos + size); a negative size means
    // the region extends below pos, so its min corner is pos + size + 1.
    // Local coordinates (and the RLE order) always run 0..|size| per axis.
    const ax = Math.abs(sx)
    const ay = Math.abs(sy)
    const az = Math.abs(sz)
    const ox = px + Math.min(0, sx + 1)
    const oy = py + Math.min(0, sy + 1)
    const oz = pz + Math.min(0, sz + 1)
    let cursor = 0
    let x = 0
    let z = 0
    let y = 0
    for (const [localIdx, run] of region.rle) {
      const global = localToGlobal[localIdx]
      for (let n = 0; n < run; n++) {
        const gx = ox + x
        const gy = oy + y
        const gz = oz + z
        if (gx >= 0 && gx < dx && gy >= 0 && gy < dy && gz >= 0 && gz < dz) {
          data[gy * dz * dx + gz * dx + gx] = global
        }
        // Advance in x -> z -> y order.
        if (++x === ax) {
          x = 0
          if (++z === az) {
            z = 0
            y++
          }
        }
      }
      cursor += run
    }
    const expected = ax * ay * az
    if (cursor !== expected) {
      throw new Error(`region "${region.name}" RLE length ${cursor} != volume ${expected}`)
    }
  }

  return { dims: [dx, dy, dz], palette, data }
}
