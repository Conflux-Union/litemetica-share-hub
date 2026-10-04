/**
 * Neighbor-aware surface mesher (plan §5 P2.4) with greedy face merging.
 *
 * Mergeable states — vanilla full-cube models, the synthesized water cube
 * and the no-bundle fallback — are meshed by six directional mask scans:
 * visible faces of one palette entry whose outside cell has no AO occluder
 * in its 3x3 neighborhood merge into maximal rectangles (one quad per run;
 * tint and face shade are uniform because the palette entry is uniform),
 * while AO-shadowed faces fall back to the per-face path (vertex AO +
 * diagonal flip) inside the same scan. Every face is emitted exactly once;
 * the scans never re-emit what the template path draws.
 *
 * Everything else — stairs, walls, panes, torches, cross plants, magenta
 * placeholders — keeps the per-voxel template path: cached per-state quad
 * templates (render/model) instantiated into world space, faces with
 * `cullface` dropped against full-cube occluders or same cull-group
 * neighbors (glass / ice / slime+honey / leaves / water — research §3),
 * classic per-vertex ambient occlusion from full-cube neighbors with the
 * quad diagonal following the AO gradient, and face-direction shade × AO ×
 * per-face tint (tintindex gate, render/tint) baked into vertex colors.
 *
 * Quads are bucketed by their texture's alpha class into three draw ranges
 * plus an untextured `flat` range. UVs stay in the model's local 0..16
 * texel space and carry a per-vertex tile origin; the viewer materials
 * wrap them into the atlas per fragment (render/tiledMaterial), so merged
 * quads tile their texture every block instead of stretching it.
 */

import { blockColor } from './colors'
import type { VoxelGrid } from './decode'
import {
  FACE_NORMALS,
  parseState,
  resolveStateGeometry,
  stateGeometryCache,
  type BlockState,
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
  /** Local 0..16 texel-space uvs (unmerged faces carry the template's
   * values verbatim; merged faces span 0..16*w × 0..16*h). */
  uvs: Float32Array
  /** Per-vertex atlas tile origin (u0, v0) paired with `uvs`; the viewer
   * materials wrap localUv into this tile per fragment. */
  tileOrigins: Float32Array
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

/** Hard cap on emitted quads: beyond this the vertex buffers alone would
 * exhaust a browser tab (decode.ts guards the voxel count upstream). */
const MAX_QUADS = 16_000_000

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
// Synthesized cube templates (water / placeholder / flat fallback)
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

/** Position of each direction inside CUBE_FACES (the greedy-scan order). */
const DIR_INDEX: Record<FaceDir, number> = { up: 0, down: 1, north: 2, south: 3, west: 4, east: 5 }

/** Scan geometry per CUBE_FACES entry: `d` slides along the normal axis,
 * `u` runs along the mask row (fastest), `v` down the mask column. The uv
 * axes of every CUBE_FACES table track the same axes (u↔`u`, v↔`v`), so a
 * merged rect scales uv u by w and uv v by h whatever the mirroring. */
interface ScanAxes {
  d: 0 | 1 | 2
  u: 0 | 1 | 2
  v: 0 | 1 | 2
}

const DIR_SCAN: ScanAxes[] = [
  { d: 1, u: 0, v: 2 }, // up: plane (x, z)
  { d: 1, u: 0, v: 2 }, // down
  { d: 2, u: 0, v: 1 }, // north: plane (x, y)
  { d: 2, u: 0, v: 1 }, // south
  { d: 0, u: 2, v: 1 }, // west: plane (z, y)
  { d: 0, u: 2, v: 1 }, // east
]

/** In-plane unit offsets per scan direction — the tangent pair vertexAo
 * samples around the outside cell (up/down: x,z; north/south: x,y;
 * west/east: y,z). */
const SCAN_T1: readonly [number, number, number][] = DIR_SCAN.map((s) =>
  s.d === 0 ? [0, 1, 0] : [1, 0, 0],
)
const SCAN_T2: readonly [number, number, number][] = DIR_SCAN.map((s) =>
  s.d === 2 ? [0, 1, 0] : [0, 0, 1],
)

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
// Per-palette-entry classification
// ---------------------------------------------------------------------------

/** One mergeable cube face, resolved once per palette entry: the template
 * quad for per-face (AO-shadowed) emission plus its baked material info. */
interface FaceInfo {
  quad: Quad
  tint: Rgb | null
  tile: TileTransform | null
  segment: SegmentName
  /** Vertex color when the texture is absent (magenta / fallback / water). */
  flat: Rgb | null
}

interface VoxelTemplate {
  /** Assets lack this state: render the magenta placeholder cube. */
  placeholder: boolean
  /** Template-path quads (empty when the greedy scan covers this state). */
  quads: Quad[]
  /** Greedy-mergeable block faces per CUBE_FACES direction; null when the
   * model is not a plain full cube (stairs, panes, plants, …). */
  faces: FaceInfo[] | null
  /** Synthesized water cube (water block or waterlogged state), always
   * greedy-mergeable; null without water. */
  waterFaces: FaceInfo[] | null
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

/** True when a full-cube model compiles to exactly the six cube faces —
 * one culled quad per direction whose uvs still cover the whole 0..16
 * tile. Those faces are exactly what CUBE_FACES can rebuild merged;
 * explicit uv sub-rects or missing cullfaces stay on the template path. */
function mergeableCube(quads: Quad[]): boolean {
  if (quads.length !== 6) return false
  const seen = new Set<FaceDir>()
  for (const q of quads) {
    if (q.cullface === undefined || seen.has(q.cullface)) return false
    seen.add(q.cullface)
    let combos = 0
    for (const uv of q.uvs) {
      const uEdge = uv[0] <= 1e-6 ? 0 : uv[0] >= 16 - 1e-6 ? 1 : -1
      const vEdge = uv[1] <= 1e-6 ? 0 : uv[1] >= 16 - 1e-6 ? 1 : -1
      if (uEdge < 0 || vEdge < 0) return false
      combos |= 1 << (uEdge | (vEdge << 1))
    }
    if (combos !== 0b1111) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Typed mesh builders (capacity-doubling channels)
// ---------------------------------------------------------------------------

/** Growable Float32Array channel; `length` counts live components. */
class FloatChannel {
  data = new Float32Array(1 << 14)
  length = 0

  /** Ensure room for `n` more components, doubling until it fits. */
  reserve(n: number): void {
    const need = this.length + n
    if (need <= this.data.length) return
    let cap = this.data.length * 2
    while (cap < need) cap *= 2
    const next = new Float32Array(cap)
    next.set(this.view())
    this.data = next
  }

  view(): Float32Array {
    return this.data.subarray(0, this.length)
  }
}

/** Growable Uint32Array channel for the index buffer. */
class IndexChannel {
  data = new Uint32Array(1 << 14)
  length = 0

  reserve(n: number): void {
    const need = this.length + n
    if (need <= this.data.length) return
    let cap = this.data.length * 2
    while (cap < need) cap *= 2
    const next = new Uint32Array(cap)
    next.set(this.view())
    this.data = next
  }

  view(): Uint32Array {
    return this.data.subarray(0, this.length)
  }
}

interface Builder {
  positions: FloatChannel
  normals: FloatChannel
  uvs: FloatChannel
  tileOrigins: FloatChannel
  colors: FloatChannel
  indices: IndexChannel
}

function newBuilder(): Builder {
  return {
    positions: new FloatChannel(),
    normals: new FloatChannel(),
    uvs: new FloatChannel(),
    tileOrigins: new FloatChannel(),
    colors: new FloatChannel(),
    indices: new IndexChannel(),
  }
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
  const dims = [dx, dy, dz] as const
  /** Index strides per axis for data[y*dz*dx + z*dx + x]. */
  const strideAxis = [1, dx * dz, dx] as const
  const at = (x: number, y: number, z: number): number => {
    if (x < 0 || y < 0 || z < 0 || x >= dx || y >= dy || z >= dz) return -1
    return grid.data[y * dx * dz + z * dx + x]
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

  /** Per-direction face infos for a six-quad cube template (indexed by
   * CUBE_FACES position via each quad's cullface). */
  const buildFaces = (
    quads: Quad[],
    state: BlockState,
    flatOf: (tint: Rgb | null) => Rgb | null,
    warnMissing: boolean,
  ): FaceInfo[] => {
    const faces: FaceInfo[] = new Array(6)
    for (const q of quads) {
      const tint = resolveTint(state.name, state.props, q.tintindex)
      const { id, tile } = resolveTexture(q.texture)
      if (!tile && warnMissing) warnTexture(q.texture)
      faces[DIR_INDEX[q.cullface!]] = {
        quad: q,
        tint,
        tile,
        segment: tile ? segmentOfAlpha(store?.alphaClass(id) ?? 'opaque') : 'flat',
        flat: flatOf(tint),
      }
    }
    return faces
  }

  // One template per palette entry; air variants mesh as empty.
  const templates: (VoxelTemplate | null)[] = grid.palette.map((stateKey, i) => {
    if (i === 0 || AIR_NAMES.has(parseState(stateKey).name)) return null

    if (!store) {
      // No bundle: flat-colored full cubes (blockColor strips state strings).
      const color = blockColor(stateKey)
      return {
        placeholder: false,
        quads: [],
        faces: FALLBACK_QUADS.map((q) => ({
          quad: q,
          tint: null,
          tile: null,
          segment: 'flat',
          flat: color,
        })),
        waterFaces: null,
        occludesFaces: true,
        occludesAo: true,
        group: undefined,
        hasWater: false,
        name: '',
        props: {},
        color,
      }
    }

    const geo = resolveStateGeometry(stateKey, store.assets, cache)
    const state = parseState(geo.stateKey)
    const group = cullGroup(state.name)
    const isWater = WATER_NAMES.has(state.name)
    const waterlogged = state.props.waterlogged === 'true'
    if (geo.missing) warnPlaceholder(geo.stateKey)

    const mergeable = !geo.missing && mergeableCube(geo.quads)
    return {
      placeholder: geo.missing,
      quads: geo.missing || mergeable ? [] : geo.quads,
      faces: mergeable ? buildFaces(geo.quads, state, () => null, true) : null,
      // Water cubes carry tintindex 0 → the constant water blue; a missing
      // water texture degrades silently to the flat water tint, not magenta.
      waterFaces:
        isWater || waterlogged
          ? buildFaces(WATER_QUADS, state, (tint) => tint ?? MAGENTA, false)
          : null,
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

  /** A face may merge only when every corner AO is 1: no occludesAo voxel
   * anywhere in the 3x3 neighborhood of the outside cell (water quads skip
   * this check — water never receives AO). */
  const faceAoClean = (x: number, y: number, z: number, dirIdx: number): boolean => {
    const n = FACE_NORMALS[CUBE_FACES[dirIdx].dir]
    const e1 = SCAN_T1[dirIdx]
    const e2 = SCAN_T2[dirIdx]
    const bx = x + n[0]
    const by = y + n[1]
    const bz = z + n[2]
    for (let du = -1; du <= 1; du++) {
      for (let dv = -1; dv <= 1; dv++) {
        if (
          aoOccluder(
            bx + du * e1[0] + dv * e2[0],
            by + du * e1[1] + dv * e2[1],
            bz + du * e1[2] + dv * e2[2],
          )
        ) {
          return false
        }
      }
    }
    return true
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

  let quadBudget = 0
  const spendQuad = (): void => {
    if (++quadBudget > MAX_QUADS) throw new Error('原理图过大,无法在浏览器中生成预览')
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
    spendQuad()
    const base = bucket.positions.length / 3
    const light = faceLight(quad.normal)
    const color = tile ? (tint ?? WHITE) : (flat ?? MAGENTA)
    const pos = bucket.positions
    const nrm = bucket.normals
    const uv = bucket.uvs
    const org = bucket.tileOrigins
    const col = bucket.colors
    pos.reserve(12)
    nrm.reserve(12)
    uv.reserve(8)
    org.reserve(8)
    col.reserve(12)
    for (let i = 0; i < 4; i++) {
      const p = quad.positions[i]
      pos.data[pos.length++] = wx + p[0]
      pos.data[pos.length++] = wy + p[1]
      pos.data[pos.length++] = wz + p[2]
      nrm.data[nrm.length++] = quad.normal[0]
      nrm.data[nrm.length++] = quad.normal[1]
      nrm.data[nrm.length++] = quad.normal[2]
      // Local texel-space uv (atlas wrapping happens per fragment); the
      // tile origin rides along as a second attribute.
      if (tile) {
        uv.data[uv.length++] = quad.uvs[i][0]
        uv.data[uv.length++] = quad.uvs[i][1]
        org.data[org.length++] = tile.u0
        org.data[org.length++] = tile.v0
      } else {
        uv.data[uv.length++] = 0
        uv.data[uv.length++] = 0
        org.data[org.length++] = 0
        org.data[org.length++] = 0
      }
      const v = light * (ao ? ao[i] : 1)
      col.data[col.length++] = color[0] * v
      col.data[col.length++] = color[1] * v
      col.data[col.length++] = color[2] * v
    }
    const idx = bucket.indices
    idx.reserve(6)
    // Flip the shared diagonal toward the brighter pair to hide AO seams.
    if (ao && ao[0] + ao[2] < ao[1] + ao[3]) {
      idx.data[idx.length++] = base + 1
      idx.data[idx.length++] = base + 2
      idx.data[idx.length++] = base + 3
      idx.data[idx.length++] = base + 1
      idx.data[idx.length++] = base + 3
      idx.data[idx.length++] = base
    } else {
      idx.data[idx.length++] = base
      idx.data[idx.length++] = base + 1
      idx.data[idx.length++] = base + 2
      idx.data[idx.length++] = base
      idx.data[idx.length++] = base + 2
      idx.data[idx.length++] = base + 3
    }
  }

  /** One AO-shadowed greedy cell: today's per-face emission, verbatim. */
  const emitScanFace = (info: FaceInfo, x: number, y: number, z: number): void => {
    pushQuad(
      buckets[info.segment],
      x,
      y,
      z,
      info.quad,
      info.tile,
      info.tint,
      vertexAo(info.quad, x, y, z),
      info.flat,
    )
  }

  /** One merged rectangle: CUBE_FACES corner/uv topology with the in-plane
   * offsets and uv values scaled by w/h; constant normal, face light × tint
   * (AO is 1 by the merge precondition). */
  const emitMerged = (
    info: FaceInfo,
    dirIdx: number,
    a0: number,
    b0: number,
    s: number,
    w: number,
    h: number,
  ): void => {
    spendQuad()
    const face = CUBE_FACES[dirIdx]
    const scan = DIR_SCAN[dirIdx]
    const ua = scan.u
    const va = scan.v
    const normal = FACE_NORMALS[face.dir]
    const light = faceLight(normal)
    const color = info.tile ? (info.tint ?? WHITE) : (info.flat ?? MAGENTA)
    const bucket = buckets[info.segment]
    const pos = bucket.positions
    const nrm = bucket.normals
    const uv = bucket.uvs
    const org = bucket.tileOrigins
    const col = bucket.colors
    const base = pos.length / 3
    pos.reserve(12)
    nrm.reserve(12)
    uv.reserve(8)
    org.reserve(8)
    col.reserve(12)
    for (let i = 0; i < 4; i++) {
      const c = face.corners[i]
      const cu = c[ua]
      const cv = c[va]
      const cd = c[scan.d]
      pos.data[pos.length++] = ua === 0 ? a0 + cu * w : va === 0 ? b0 + cv * h : s + cd
      pos.data[pos.length++] = ua === 1 ? a0 + cu * w : va === 1 ? b0 + cv * h : s + cd
      pos.data[pos.length++] = ua === 2 ? a0 + cu * w : va === 2 ? b0 + cv * h : s + cd
      nrm.data[nrm.length++] = normal[0]
      nrm.data[nrm.length++] = normal[1]
      nrm.data[nrm.length++] = normal[2]
      // Local texel space: the 0/16 corner values scale to 0..16w / 0..16h
      // so the tiled-UV materials repeat the tile every block.
      uv.data[uv.length++] = face.uvs[i][0] * w
      uv.data[uv.length++] = face.uvs[i][1] * h
      if (info.tile) {
        org.data[org.length++] = info.tile.u0
        org.data[org.length++] = info.tile.v0
      } else {
        org.data[org.length++] = 0
        org.data[org.length++] = 0
      }
      col.data[col.length++] = color[0] * light
      col.data[col.length++] = color[1] * light
      col.data[col.length++] = color[2] * light
    }
    const idx = bucket.indices
    idx.reserve(6)
    idx.data[idx.length++] = base
    idx.data[idx.length++] = base + 1
    idx.data[idx.length++] = base + 2
    idx.data[idx.length++] = base
    idx.data[idx.length++] = base + 2
    idx.data[idx.length++] = base + 3
  }

  // -------------------------------------------------------------------------
  // Greedy scans: six directions × (block pass + water pass). Positive mask
  // values are mergeable palette indices, negatives mark AO-shadowed cells
  // that emit immediately, 0 is nothing. Sweeps clear every non-zero cell,
  // so the masks start zeroed for the next slice.
  // -------------------------------------------------------------------------

  for (let dirIdx = 0; dirIdx < 6; dirIdx++) {
    const scan = DIR_SCAN[dirIdx]
    const ua = scan.u
    const va = scan.v
    const da = scan.d
    const dir = CUBE_FACES[dirIdx].dir
    const nu = dims[ua]
    const nv = dims[va]
    const nd = dims[da]
    const strideU = strideAxis[ua]
    const strideV = strideAxis[va]
    const strideD = strideAxis[da]
    const blockMask = new Int32Array(nu * nv)
    const waterMask = new Int32Array(nu * nv)

    /** Standard maximal-rectangle sweep; AO-shadowed cells emit alone via
     * the per-face path (vertex AO, diagonal flip). */
    const sweep = (mask: Int32Array, water: boolean, s: number): void => {
      for (let b = 0; b < nv; b++) {
        const row = b * nu
        for (let a = 0; a < nu; ) {
          const v = mask[row + a]
          if (v === 0) {
            a++
            continue
          }
          const pi = v > 0 ? v : -v
          const info = (water ? templates[pi]!.waterFaces : templates[pi]!.faces)![dirIdx]
          if (v < 0) {
            emitScanFace(info, ua === 0 ? a : va === 0 ? b : s, ua === 1 ? a : va === 1 ? b : s, ua === 2 ? a : va === 2 ? b : s)
            mask[row + a] = 0
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
          emitMerged(info, dirIdx, a, b, s, w, h)
          for (let bb = 0; bb < h; bb++) {
            const clear = (b + bb) * nu + a
            for (let k = 0; k < w; k++) mask[clear + k] = 0
          }
          a += w
        }
      }
    }

    for (let s = 0; s < nd; s++) {
      // Fill both masks for this slice (air leaves the previous zeros).
      const sliceOff = s * strideD
      let m = 0
      for (let b = 0; b < nv; b++) {
        const rowOff = sliceOff + b * strideV
        for (let a = 0; a < nu; a++, m++) {
          const pi = grid.data[rowOff + a * strideU]
          const rec = templates[pi]
          if (rec === null) continue
          const x = ua === 0 ? a : va === 0 ? b : s
          const y = ua === 1 ? a : va === 1 ? b : s
          const z = ua === 2 ? a : va === 2 ? b : s
          if (rec.faces !== null && !culled(x, y, z, dir, rec.group)) {
            blockMask[m] = faceAoClean(x, y, z, dirIdx) ? pi : -pi
          }
          if (rec.waterFaces !== null && !waterCulled(x, y, z, dir)) {
            waterMask[m] = pi
          }
        }
      }
      sweep(blockMask, false, s)
      sweep(waterMask, true, s)
    }
  }

  // -------------------------------------------------------------------------
  // Template path: non-cube models and placeholders, per voxel. Mergeable
  // states carry empty `quads` (the scans above emitted their faces), and
  // the no-bundle fallback is fully greedy, so this loop is store-only.
  // -------------------------------------------------------------------------

  const emitPlaceholder = (x: number, y: number, z: number): void => {
    for (const q of PLACEHOLDER_QUADS) {
      if (q.cullface && culled(x, y, z, q.cullface, undefined)) continue
      pushQuad(buckets.flat, x, y, z, q, null, null, vertexAo(q, x, y, z), MAGENTA)
    }
  }

  for (let y = 0; y < dy; y++) {
    for (let z = 0; z < dz; z++) {
      const rowOff = (y * dz + z) * dx
      for (let x = 0; x < dx; x++) {
        const rec = templates[grid.data[rowOff + x]]
        if (!rec) continue
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
              buckets[segmentOfAlpha(store ? store.alphaClass(id) : 'opaque')],
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
      }
    }
  }

  // Concatenate buckets in fixed order, remapping indices per vertex base.
  const totalVerts =
    buckets.opaque.positions.length / 3 +
    buckets.cutout.positions.length / 3 +
    buckets.translucent.positions.length / 3 +
    buckets.flat.positions.length / 3

  const positions = new Float32Array(totalVerts * 3)
  const normals = new Float32Array(totalVerts * 3)
  const uvs = new Float32Array(totalVerts * 2)
  const tileOrigins = new Float32Array(totalVerts * 2)
  const colors = new Float32Array(totalVerts * 3)
  const indices = new Uint32Array(
    buckets.opaque.indices.length +
      buckets.cutout.indices.length +
      buckets.translucent.indices.length +
      buckets.flat.indices.length,
  )

  const ranges = {} as MeshRanges
  let vertOffset = 0
  let indexOffset = 0
  for (const name of SEGMENT_ORDER) {
    const b = buckets[name]
    positions.set(b.positions.view(), vertOffset * 3)
    normals.set(b.normals.view(), vertOffset * 3)
    uvs.set(b.uvs.view(), vertOffset * 2)
    tileOrigins.set(b.tileOrigins.view(), vertOffset * 2)
    colors.set(b.colors.view(), vertOffset * 3)
    const src = b.indices.view()
    for (let i = 0; i < src.length; i++) {
      indices[indexOffset + i] = src[i] + vertOffset
    }
    ranges[name] = { start: indexOffset, count: src.length }
    vertOffset += b.positions.length / 3
    indexOffset += src.length
  }

  return {
    positions,
    normals,
    uvs,
    tileOrigins,
    colors,
    indices,
    ranges,
    faceCount: indices.length / 6,
  }
}
