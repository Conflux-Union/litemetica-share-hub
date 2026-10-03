import type { VoxelGrid } from './decode'

/** Face definition: normal axis and the four corner offsets (CCW from outside). */
interface FaceDef {
  /** Target voxel offset for neighbor lookup. */
  n: [number, number, number]
  /** Corner offsets relative to the voxel origin. */
  c: [number, number, number][]
  /** Light multiplier for this face direction. */
  light: number
  face: 'top' | 'bottom' | 'side'
}

const FACES: FaceDef[] = [
  {
    n: [1, 0, 0],
    c: [
      [1, 0, 0],
      [1, 0, 1],
      [1, 1, 1],
      [1, 1, 0],
    ],
    light: 0.72,
    face: 'side',
  },
  {
    n: [-1, 0, 0],
    c: [
      [0, 0, 1],
      [0, 0, 0],
      [0, 1, 0],
      [0, 1, 1],
    ],
    light: 0.72,
    face: 'side',
  },
  {
    n: [0, 1, 0],
    c: [
      [0, 1, 1],
      [1, 1, 1],
      [1, 1, 0],
      [0, 1, 0],
    ],
    light: 1.0,
    face: 'top',
  },
  {
    n: [0, -1, 0],
    c: [
      [0, 0, 0],
      [1, 0, 0],
      [1, 0, 1],
      [0, 0, 1],
    ],
    light: 0.5,
    face: 'bottom',
  },
  {
    n: [0, 0, 1],
    c: [
      [0, 0, 1],
      [1, 0, 1],
      [1, 1, 1],
      [0, 1, 1],
    ],
    light: 0.86,
    face: 'side',
  },
  {
    n: [0, 0, -1],
    c: [
      [1, 0, 0],
      [0, 0, 0],
      [0, 1, 0],
      [1, 1, 0],
    ],
    light: 0.86,
    face: 'side',
  },
]

/** Blocks rendered in the transparent pass. */
const TRANSPARENT = new Set([
  'minecraft:glass',
  'minecraft:tinted_glass',
  'minecraft:glass_pane',
  'minecraft:water',
  'minecraft:ice',
  'minecraft:slime_block',
  'minecraft:honey_block',
  'minecraft:barrier',
])
for (const c of [
  'white',
  'orange',
  'magenta',
  'light_blue',
  'yellow',
  'lime',
  'pink',
  'gray',
  'light_gray',
  'cyan',
  'purple',
  'blue',
  'brown',
  'green',
  'red',
  'black',
]) {
  TRANSPARENT.add(`minecraft:${c}_stained_glass`)
  TRANSPARENT.add(`minecraft:${c}_stained_glass_pane`)
}

export function isTransparent(id: string): boolean {
  return TRANSPARENT.has(id)
}

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Opaque faces occupy [0, opaqueIndexCount); transparent the rest. */
  opaqueIndexCount: number
  faceCount: number
}

/** Per-block face UV lookup: (blockId, face) -> [u0, v0, u1, v1] or null for flat color. */
export type UvResolver = (blockId: string, face: 'top' | 'side' | 'bottom') => [number, number, number, number] | null

interface Builder {
  positions: number[]
  normals: number[]
  uvs: number[]
  colors: number[]
  indices: number[]
}

function newBuilder(): Builder {
  return { positions: [], normals: [], uvs: [], colors: [], indices: [] }
}

function finish(b: Builder): { positions: Float32Array; normals: Float32Array; uvs: Float32Array; colors: Float32Array; indices: Uint32Array } {
  return {
    positions: new Float32Array(b.positions),
    normals: new Float32Array(b.normals),
    uvs: new Float32Array(b.uvs),
    colors: new Float32Array(b.colors),
    indices: new Uint32Array(b.indices),
  }
}

/**
 * Extract visible faces from the voxel grid. Hidden faces between two solid
 * blocks are culled; classic per-vertex ambient occlusion is baked into colors.
 */
export function extractSurface(grid: VoxelGrid, resolveUv: UvResolver): MeshData {
  const [dx, dy, dz] = grid.dims
  const { data, palette } = grid

  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || x >= dx || y < 0 || y >= dy || z < 0 || z >= dz) return -1
    return data[y * dz * dx + z * dx + x]
  }

  const opaque = newBuilder()
  const alpha = newBuilder()

  const occluded = (x: number, y: number, z: number): boolean => {
    const n = at(x, y, z)
    if (n === -1 || n === 0) return false
    return !isTransparent(palette[n])
  }

  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        const idx = data[y * dz * dx + z * dx + x]
        if (idx === 0) continue
        const id = palette[idx]
        const selfTransparent = isTransparent(id)
        const target = selfTransparent ? alpha : opaque

        for (const face of FACES) {
          const nx = x + face.n[0]
          const ny = y + face.n[1]
          const nz = z + face.n[2]
          const n = at(nx, ny, nz)
          if (n > 0) {
            const nId = palette[n]
            if (!isTransparent(nId)) continue // hidden behind a solid block
            if (selfTransparent && nId === id) continue // merge same transparent blocks
            if (selfTransparent && nId === 'minecraft:water' && id === 'minecraft:water') continue
          }

          // Whether the neighbor position blocks ambient light for AO.
          const solidAt = (ox: number, oy: number, oz: number) => occluded(nx + ox, ny + oy, nz + oz)

          const base = target.positions.length / 3
          const uv = resolveUv(id, face.face)

          for (let ci = 0; ci < 4; ci++) {
            const [cx, cy, cz] = face.c[ci]
            target.positions.push(x + cx, y + cy, z + cz)
            target.normals.push(face.n[0], face.n[1], face.n[2])

            // AO per vertex from the three neighbors around the corner.
            let ao = 1
            if (!selfTransparent) {
              // Determine the two tangent directions of this corner.
              const sx = cx === 1 ? 1 : -1
              const sy = cy === 1 ? 1 : -1
              const sz = cz === 1 ? 1 : -1
              let side1 = false
              let side2 = false
              let corner = false
              if (face.n[1] !== 0) {
                side1 = solidAt(sx, 0, 0)
                side2 = solidAt(0, 0, sz)
                corner = solidAt(sx, 0, sz)
              } else if (face.n[0] !== 0) {
                side1 = solidAt(0, sy, 0)
                side2 = solidAt(0, 0, sz)
                corner = solidAt(0, sy, sz)
              } else {
                side1 = solidAt(sx, sy, 0)
                side2 = solidAt(sx, 0, 0)
                corner = solidAt(0, sy, 0)
              }
              if (side1 && side2) ao = 0.55
              else {
                const s = (side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)
                ao = 1 - s * 0.15
              }
            }
            const light = face.light * ao
            target.colors.push(light, light, light)

            if (uv) {
              const [u0, v0, u1, v1] = uv
              // Map each face's two in-plane axes to tile uv; v follows world
              // up on side faces so textures stay upright. (±Y faces lie in
              // the x/z plane, ±X faces in the z/y plane, ±Z faces in x/y.)
              let u: number
              let v: number
              if (face.n[1] !== 0) {
                u = cx === 1 ? u1 : u0
                v = cz === 1 ? v1 : v0
              } else if (face.n[0] !== 0) {
                u = cz === 1 ? u1 : u0
                v = cy === 1 ? v1 : v0
              } else {
                u = cx === 1 ? u1 : u0
                v = cy === 1 ? v1 : v0
              }
              target.uvs.push(u, v)
            } else {
              target.uvs.push(0, 0)
            }
          }
          target.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
        }
      }
    }
  }

  const o = finish(opaque)
  const a = finish(alpha)

  // Merge: opaque first, transparent second, with an index offset.
  const totalVerts = o.positions.length / 3 + a.positions.length / 3
  const indices = new Uint32Array(o.indices.length + a.indices.length)
  indices.set(o.indices, 0)
  for (let i = 0; i < a.indices.length; i++) {
    indices[o.indices.length + i] = a.indices[i] + o.positions.length / 3
  }

  return {
    positions: concatF32(o.positions, a.positions),
    normals: concatF32(o.normals, a.normals),
    uvs: concatF32(o.uvs, a.uvs),
    colors: concatF32(o.colors, a.colors),
    indices,
    opaqueIndexCount: o.indices.length,
    faceCount: indices.length / 6,
    // totalVerts retained for potential callers; silence unused otherwise
    ...(totalVerts >= 0 ? {} : {}),
  }
}

function concatF32(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}
