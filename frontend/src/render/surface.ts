/**
 * Neighbor-aware surface mesher (plan §5 P2.4).
 *
 * Per voxel the cached per-state quad templates (render/model) are
 * instantiated into world space. Faces declared with `cullface` are dropped
 * when the neighbor in that direction is a full-cube occluder or belongs to
 * the same cull group (glass / ice / slime+honey / leaves / water — research
 * §3); non-cube blocks never occlude neighbors. Classic per-vertex ambient
 * occlusion samples full-cube neighbors only, and the quad diagonal flips to
 * follow the AO gradient. Face-direction shade × AO × per-face tint
 * (tintindex gate, render/tint) is baked into vertex colors. Quads are
 * bucketed by their texture's alpha class into three draw ranges plus an
 * untextured `flat` range for magenta placeholders and the no-bundle
 * fallback.
 */

import { blockColor } from './colors'
import type { VoxelGrid } from './decode'
import {
  FACE_NORMALS,
  parseState,
  resolveStateGeometry,
  stateGeometryCache,
  type FaceDir,
  type Quad,
  type StateGeometry,
  type VanillaAssets,
} from './model'
import { resolveTint, type Rgb } from './tint'
import type { TileTransform } from './assets'
import type { AlphaClass } from '../types'

/** Textured-mesh inputs the mesher needs from a loaded bundle; AssetStore
 * (render/assets) satisfies this structurally. */
export interface SurfaceAssets {
  assets: VanillaAssets
  /** Atlas mapping for a texture id; null when absent from the atlas. */
  tileTransform(textureId: string): TileTransform | null
  /** Alpha class of an atlas texture; unknown ids read as opaque. */
  alphaClass(textureId: string): AlphaClass
}

export type SegmentName = 'opaque' | 'cutout' | 'translucent' | 'flat'

export interface IndexRange {
  start: number
  count: number
}

export interface MeshRanges {
  opaque: IndexRange
  cutout: IndexRange
  translucent: IndexRange
  /** Untextured: magenta placeholders and the flat-color fallback. */
  flat: IndexRange
}

export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  uvs: Float32Array
  colors: Float32Array
  indices: Uint32Array
  /** Contiguous index ranges, in order opaque → cutout → translucent → flat. */
  ranges: MeshRanges
  faceCount: number
}

/** Face-merge families: shared faces with a same-family neighbor are culled
 * (replaces the old TRANSPARENT whitelist; research §3 cull groups). */
function cullGroup(name: string): string | undefined {
  if (
    name === 'minecraft:glass' ||
    name === 'minecraft:glass_pane' ||
    name.endsWith('_glass') ||
    name.endsWith('_glass_pane')
  ) {
    return 'glass'
  }
  if (name === 'minecraft:ice' || name.endsWith('_ice')) return 'ice'
  if (name === 'minecraft:slime_block' || name === 'minecraft:honey_block') return 'slime'
  if (name.endsWith('_leaves')) return 'leaves'
  return undefined
}

const WATER_NAMES = new Set(['minecraft:water', 'minecraft:flowing_water'])

const AIR_NAMES = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air'])

/** AO brightness by occluder count (side1&&side2 counts as 3); research §3
 * strength table [1, 0.7, 0.5, 0.2]. */
const AO_STRENGTH = [1, 0.7, 0.5, 0.2] as const

const WHITE: Rgb = [1, 1, 1]
const MAGENTA: Rgb = [1, 0, 1]

/** Directional shade per face, by dominant normal axis (up 1.0, down 0.5,
 * ±z 0.86, ±x 0.72 — same table the previous mesher baked). */
function faceLight(normal: readonly number[]): number {
  const ax = Math.abs(normal[0])
  const ay = Math.abs(normal[1])
  const az = Math.abs(normal[2])
  if (ay >= ax && ay >= az) return normal[1] > 0 ? 1.0 : 0.5
  if (az >= ax) return 0.86
  return 0.72
}

// ---------------------------------------------------------------------------
// Synthesized cube templates (placeholder / water / flat fallback)
// ---------------------------------------------------------------------------

interface CubeFace {
  dir: FaceDir
  /** Corners in CCW order seen from outside. */
  corners: [number, number, number][]
  /** Texture-space uv per corner (v grows downward). */
  uvs: [number, number][]
}

const CUBE_FACES: CubeFace[] = [
  {
    dir: 'up',
    corners: [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    uvs: [[0, 0], [0, 16], [16, 16], [16, 0]],
  },
  {
    dir: 'down',
    corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
    uvs: [[0, 16], [16, 16], [16, 0], [0, 0]],
  },
  {
    dir: 'north',
    corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
    uvs: [[0, 16], [16, 16], [16, 0], [0, 0]],
  },
  {
    dir: 'south',
    corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
    uvs: [[0, 16], [16, 16], [16, 0], [0, 0]],
  },
  {
    dir: 'west',
    corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
    uvs: [[0, 16], [16, 16], [16, 0], [0, 0]],
  },
  {
    dir: 'east',
    corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
    uvs: [[0, 16], [16, 16], [16, 0], [0, 0]],
  },
]

/** Full-cube quad template with a cullface per direction. */
function cubeTemplate(texture: string, tintindex?: number): Quad[] {
  return CUBE_FACES.map((f) => ({
    positions: f.corners.map((c) => [c[0], c[1], c[2]]),
    normal: [...FACE_NORMALS[f.dir]] as [number, number, number],
    uvRect: [0, 0, 16, 16] as [number, number, number, number],
    uvs: f.uvs.map((uv) => [uv[0], uv[1]]),
    texture,
    cullface: f.dir,
    tintindex,
  }))
}

const PLACEHOLDER_QUADS = cubeTemplate('')
/** v1 water: full translucent cubes (heightfield is P3); tintindex 0 makes
 * render/tint apply the water color. */
const WATER_QUADS = cubeTemplate('minecraft:block/water_still', 0)
const FALLBACK_QUADS = cubeTemplate('')

// ---------------------------------------------------------------------------
// Per-palette-entry templates
// ---------------------------------------------------------------------------

interface VoxelTemplate {
  /** Assets lack this state: render the magenta placeholder cube. */
  placeholder: boolean
  quads: Quad[]
  /** Synthesized water cube (water block or waterlogged state). */
  water: Quad[] | null
  /** Hides neighbors' culled faces: full-cube shape outside cull groups. */
  occludesFaces: boolean
  /** Darkens neighbor vertices via AO: full-cube shape. */
  occludesAo: boolean
  group: string | undefined
  /** The block itself or a waterlogged state carries water. */
  hasWater: boolean
  name: string
  props: Record<string, string>
  /** Flat-color fallback (no bundle). */
  color: Rgb
}

const warnedStates = new Set<string>()
const warnedTextures = new Set<string>()

function warnPlaceholder(stateKey: string): void {
  if (warnedStates.has(stateKey)) return
  warnedStates.add(stateKey)
  console.warn(`[render] no vanilla model for "${stateKey}"; rendering magenta placeholder`)
}

function warnTexture(textureId: string): void {
  if (warnedTextures.has(textureId)) return
  warnedTextures.add(textureId)
  console.warn(`[render] texture "${textureId}" is not in the atlas; rendering magenta`)
}

function buildTemplate(
  stateKey: string,
  store: SurfaceAssets | null,
  cache: Map<string, StateGeometry>,
): VoxelTemplate {
  if (!store) {
    // No bundle: flat-colored full cubes (blockColor strips state strings).
    return {
      placeholder: false,
      quads: FALLBACK_QUADS,
      water: null,
      occludesFaces: true,
      occludesAo: true,
      group: undefined,
      hasWater: false,
      name: '',
      props: {},
      color: blockColor(stateKey),
    }
  }

  const geo = resolveStateGeometry(stateKey, store.assets, cache)
  const state = parseState(geo.stateKey)
  const group = cullGroup(state.name)
  const isWater = WATER_NAMES.has(state.name)
  const waterlogged = state.props.waterlogged === 'true'
  if (geo.missing) warnPlaceholder(geo.stateKey)

  return {
    placeholder: geo.missing,
    quads: geo.missing ? [] : geo.quads,
    water: isWater || waterlogged ? WATER_QUADS : null,
    // Glass/ice/… keep their faces against non-group neighbors, so only
    // cull-group-free full cubes hide neighboring faces.
    occludesFaces: geo.fullCube && group === undefined,
    occludesAo: geo.fullCube,
    group,
    hasWater: isWater || waterlogged,
    name: state.name,
    props: state.props,
    color: [1, 1, 1],
  }
}

// ---------------------------------------------------------------------------
// Mesher
// ---------------------------------------------------------------------------

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

const SEGMENT_ORDER: SegmentName[] = ['opaque', 'cutout', 'translucent', 'flat']

function segmentOfAlpha(alpha: AlphaClass): SegmentName {
  return alpha === 'opaque' ? 'opaque' : alpha
}

/**
 * Extract the visible surface of the voxel grid as one indexed mesh with
 * per-alpha-class draw ranges. `store === null` keeps the flat-color
 * fallback (full cubes tinted with block colors). `cache` overrides the
 * shared state-geometry cache (tests pass isolated maps).
 */
export function extractSurface(
  grid: VoxelGrid,
  store: SurfaceAssets | null,
  cache: Map<string, StateGeometry> = stateGeometryCache,
): MeshData {
  const [dx, dy, dz] = grid.dims
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return -1
    return grid.data[y * dz * dx + z * dx + x]
  }

  // One template per palette entry; air variants mesh as empty.
  const templates: (VoxelTemplate | null)[] = grid.palette.map((stateKey, i) => {
    if (i === 0 || AIR_NAMES.has(parseState(stateKey).name)) return null
    return buildTemplate(stateKey, store, cache)
  })

  const buckets: Record<SegmentName, Builder> = {
    opaque: newBuilder(),
    cutout: newBuilder(),
    translucent: newBuilder(),
    flat: newBuilder(),
  }

  /** Face culling: neighbor is a full-cube occluder or same cull group. */
  const culled = (x: number, y: number, z: number, dir: FaceDir, group: string | undefined): boolean => {
    const n = FACE_NORMALS[dir]
    const i = at(x + n[0], y + n[1], z + n[2])
    if (i <= 0) return false
    const nb = templates[i]
    if (!nb) return false
    return nb.occludesFaces || (group !== undefined && nb.group === group)
  }

  const aoOccluder = (x: number, y: number, z: number): boolean => {
    const i = at(x, y, z)
    if (i <= 0) return false
    return templates[i]?.occludesAo ?? false
  }

  const waterCulled = (x: number, y: number, z: number, dir: FaceDir): boolean => {
    const n = FACE_NORMALS[dir]
    const i = at(x + n[0], y + n[1], z + n[2])
    if (i <= 0) return false
    const nb = templates[i]
    if (!nb) return false
    return nb.occludesFaces || nb.hasWater
  }

  /** Texture lookup with the model layer's namespace tolerance: 26.x model
   * JSON carries bare texture ids ("block/snow") while atlas keys are
   * namespaced ("minecraft:block/snow"). */
  const resolveTexture = (textureId: string): { id: string; tile: TileTransform | null } => {
    const tile = store?.tileTransform(textureId) ?? null
    if (tile || textureId.includes(':')) return { id: textureId, tile }
    const namespaced = `minecraft:${textureId}`
    const nsTile = store?.tileTransform(namespaced) ?? null
    return { id: nsTile ? namespaced : textureId, tile: nsTile }
  }

  /** Per-vertex AO from the full-cube neighbors around the face's outside
   * cell; corner sign follows the vertex position relative to block center. */
  const vertexAo = (quad: Quad, wx: number, wy: number, wz: number): number[] => {
    const nx = Math.abs(quad.normal[0])
    const ny = Math.abs(quad.normal[1])
    const nz = Math.abs(quad.normal[2])
    const axis: 0 | 1 | 2 = ny >= nx && ny >= nz ? 1 : nx >= nz ? 0 : 2
    const t1 = axis === 0 ? 1 : 0
    const t2 = axis === 2 ? 1 : 2
    const sign = quad.normal[axis] > 0 ? 1 : -1
    const base: [number, number, number] = [wx, wy, wz]
    base[axis] += sign
    const ao: number[] = []
    for (let i = 0; i < 4; i++) {
      const p = quad.positions[i]
      const o1: [number, number, number] = [0, 0, 0]
      o1[t1] = p[t1] > 0.5 ? 1 : -1
      const o2: [number, number, number] = [0, 0, 0]
      o2[t2] = p[t2] > 0.5 ? 1 : -1
      const side1 = aoOccluder(base[0] + o1[0], base[1] + o1[1], base[2] + o1[2])
      const side2 = aoOccluder(base[0] + o2[0], base[1] + o2[1], base[2] + o2[2])
      const corner = aoOccluder(
        base[0] + o1[0] + o2[0],
        base[1] + o1[1] + o2[1],
        base[2] + o1[2] + o2[2],
      )
      ao.push(
        side1 && side2
          ? AO_STRENGTH[3]
          : AO_STRENGTH[(side1 ? 1 : 0) + (side2 ? 1 : 0) + (corner ? 1 : 0)],
      )
    }
    return ao
  }

  const pushQuad = (
    bucket: Builder,
    wx: number,
    wy: number,
    wz: number,
    quad: Quad,
    tile: TileTransform | null,
    tint: Rgb | null,
    ao: number[] | null,
    flat: Rgb | null,
  ): void => {
    const base = bucket.positions.length / 3
    const light = faceLight(quad.normal)
    const color = tile ? (tint ?? WHITE) : (flat ?? MAGENTA)
    for (let i = 0; i < 4; i++) {
      const p = quad.positions[i]
      bucket.positions.push(wx + p[0], wy + p[1], wz + p[2])
      bucket.normals.push(quad.normal[0], quad.normal[1], quad.normal[2])
      if (tile) {
        bucket.uvs.push(
          tile.u0 + tile.du * quad.uvs[i][0],
          tile.v0 + tile.dv * quad.uvs[i][1],
        )
      } else {
        bucket.uvs.push(0, 0)
      }
      const v = light * (ao ? ao[i] : 1)
      bucket.colors.push(color[0] * v, color[1] * v, color[2] * v)
    }
    // Flip the shared diagonal toward the brighter pair to hide AO seams.
    if (ao && ao[0] + ao[2] < ao[1] + ao[3]) {
      bucket.indices.push(base + 1, base + 2, base + 3, base + 1, base + 3, base)
    } else {
      bucket.indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
  }

  const emitPlaceholder = (x: number, y: number, z: number): void => {
    for (const q of PLACEHOLDER_QUADS) {
      if (q.cullface && culled(x, y, z, q.cullface, undefined)) continue
      pushQuad(buckets.flat, x, y, z, q, null, null, vertexAo(q, x, y, z), MAGENTA)
    }
  }

  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      for (let x = 0; x < dx; x++) {
        const rec = templates[grid.data[y * dz * dx + z * dx + x]]
        if (!rec) continue

        if (!store) {
          // No-bundle fallback: full cubes, block colors baked per vertex.
          for (const q of rec.quads) {
            if (q.cullface && culled(x, y, z, q.cullface, rec.group)) continue
            pushQuad(buckets.flat, x, y, z, q, null, null, vertexAo(q, x, y, z), rec.color)
          }
          continue
        }

        if (rec.placeholder) {
          emitPlaceholder(x, y, z)
          continue
        }

        for (const q of rec.quads) {
          if (q.cullface && culled(x, y, z, q.cullface, rec.group)) continue
          const tint = resolveTint(rec.name, rec.props, q.tintindex)
          const { id, tile } = resolveTexture(q.texture)
          if (tile) {
            pushQuad(
              buckets[segmentOfAlpha(store.alphaClass(id))],
              x,
              y,
              z,
              q,
              tile,
              tint,
              vertexAo(q, x, y, z),
              null,
            )
          } else {
            // Texture absent from the atlas: flat magenta, never a garbage texel.
            warnTexture(q.texture)
            pushQuad(buckets.flat, x, y, z, q, null, null, vertexAo(q, x, y, z), MAGENTA)
          }
        }

        if (rec.water) {
          for (const q of rec.water) {
            if (q.cullface && waterCulled(x, y, z, q.cullface)) continue
            const tint = resolveTint(rec.name, rec.props, q.tintindex)
            const { id, tile } = resolveTexture(q.texture)
            // Water never receives AO; a missing water texture degrades to
            // the flat water tint rather than magenta.
            pushQuad(
              tile ? buckets[segmentOfAlpha(store.alphaClass(id))] : buckets.flat,
              x,
              y,
              z,
              q,
              tile,
              tint,
              null,
              tint,
            )
          }
        }
      }
    }
  }

  // Concatenate buckets in fixed order, remapping indices per vertex base.
  const totalVerts =
    (buckets.opaque.positions.length +
      buckets.cutout.positions.length +
      buckets.translucent.positions.length +
      buckets.flat.positions.length) /
    3
  const totalIndices =
    buckets.opaque.indices.length +
    buckets.cutout.indices.length +
    buckets.translucent.indices.length +
    buckets.flat.indices.length

  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  const colors = new Float32Array(totalVerts * 3)
  const indices = new Uint32Array(totalIndices)

  const ranges = {} as MeshRanges
  let vertOffset = 0
  let indexOffset = 0
  for (const name of SEGMENT_ORDER) {
    const b = buckets[name]
    positions.set(b.positions, vertOffset * 3)
    normals.set(b.normals, vertOffset * 3)
    uvs.set(b.uvs, vertOffset * 2)
    colors.set(b.colors, vertOffset * 3)
    for (let i = 0; i < b.indices.length; i++) {
      indices[indexOffset + i] = b.indices[i] + vertOffset
    }
    ranges[name] = { start: indexOffset, count: b.indices.length }
    vertOffset += b.positions.length / 3
    indexOffset += b.indices.length
  }

  return { positions, normals, uvs, colors, indices, ranges, faceCount: totalIndices / 6 }
}
