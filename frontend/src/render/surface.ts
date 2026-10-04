/**
 * Neighbor-aware surface mesher (plan §5 P2.4) with greedy face merging.
 *
 * Mergeable states — vanilla full-cube models, the synthesized water cube
 * and the no-bundle fallback — are meshed by six directional mask scans.
 * The merge key is the face's *material* (atlas tile + tint + alpha segment,
 * or the fallback block color) packed with its corner-AO tuple: runs of one
 * material whose corner AO matches merge into maximal rectangles that
 * reproduce the unmerged per-vertex shading exactly, so different palette
 * states that render identically (stair facings, water levels) merge too.
 * Every face is emitted exactly once; the scans never re-emit what the
 * template path draws.
 *
 * Giant grids (more than `COARSE_MERGE_MAX_OCCLUDERS` occluding voxels —
 * bridge-scale captures with rough natural terrain) cannot afford per-vertex
 * AO shading: exact AO tuples keep ~1×1 quads on noisy surfaces and the
 * vertex buffers alone would exhaust a browser tab. Past the cap the mesher
 * drops baked AO, and in the no-bundle fallback it also merges runs by
 * geometry alone, coloring each merged rectangle from its corner cells'
 * block colors — locally averaged shading instead of per-block boundaries.
 * Smaller grids keep full detail; the synthetic stress fixture stays under
 * the cap on purpose.
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

/** True when a palette entry is one of the three vanilla airs (property
 * suffix stripped); the coarse downsampler (render/lod) shares this. */
export function isAirState(stateKey: string): boolean {
  return AIR_NAMES.has(parseState(stateKey).name)
}

/** Quad-budget guardrail thrown by {@link extractSurface} when a mesh would
 * exceed the cap. The pipeline (render/meshWorker) catches exactly this and
 * degrades to the coarse LOD mesh instead of failing the render; the
 * Chinese message is the user-facing text either way. */
export class MeshBudgetError extends Error {
  constructor() {
    super('原理图过大,无法在浏览器中生成预览')
    this.name = 'MeshBudgetError'
  }
}

/** Budget overrides and tier switches for {@link extractSurface}; tests stub
 * a small `maxQuads` to exercise the guardrail without a multi-million-quad
 * fixture, and `cubeProxy` to exercise the box-approximation tier. */
export interface MeshLimits {
  maxQuads?: number
  /** Box-proxy tier: non-cube states (stairs, walls, panes, …) mesh as full
   * cubes wearing the state's first resolvable texture, making them
   * greedy-mergeable and turning them into occluders. The pipeline
   * (render/meshWorker) retries with this after the full-detail mesh
   * overruns the budget — a textured whole-block approximation, unlike the
   * flat coarse LOD. */
  cubeProxy?: boolean
}

/** AO brightness by occluder count (side1&&side2 counts as 3); research §3
 * strength table [1, 0.7, 0.5, 0.2]. */
const AO_STRENGTH = [1, 0.7, 0.5, 0.2] as const

/** Hard cap on emitted quads: past it the mesher throws MeshBudgetError and
 * the pipeline degrades to the coarse LOD mesh (render/meshWorker) instead
 * of dying. Each quad costs ~232B of typed channels (52 floats + 6
 * indices); capacity-doubling briefly holds two copies, and the final
 * concat adds another full set before the channels free. The cap must sit
 * where a tab still reaches it — the old 16M (~3.7GB of channels alone)
 * fired long after the OOM it was meant to prevent. Anchor: the real
 * bridge fixture (566x256x1423, rough terrain) meshes to 2.34M quads and
 * must stay full-precision, so the budget sits just above it; anything
 * rougher degrades. decode.ts guards the voxel count upstream. */
const MAX_QUADS = 3_000_000

/** Above this many AO-occluding voxels the mesher stops baking per-vertex
 * AO (and, in the flat-color fallback, merges runs by geometry with corner
 * cell colors): exact AO tuples keep terrain at ~1 quad per face, which at
 * this scale overflows browser memory. The synthetic stress fixture
 * (566x256x1423 deck + pillars) sits at ~2.3M occluders and stays in exact
 * mode; real bridge captures with rough terrain land well above the cap. */
const COARSE_MERGE_MAX_OCCLUDERS = 3_000_000

const WHITE: Rgb = [1, 1, 1]
const MAGENTA: Rgb = [1, 0, 1]

/** Directional shade per face, by dominant normal axis (up 1.0, down 0.5,
 * ±z 0.86, ±x 0.72 — same table the previous mesher baked). Exported for
 * the coarse LOD mesher, which bakes the same shading. */
export function faceLight(normal: readonly number[]): number {
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

/** Shared cube topology: corner winding and per-corner uv anchors of the
 * six full-cube faces. Exported so the coarse LOD mesher (render/lod)
 * emits provably same-source normals/winding — backface culling stays
 * consistent between the two levels. */
export const CUBE_FACES: CubeFace[] = [
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

/** Exported with CUBE_FACES: which axis each direction's greedy scan slides
 * (d) and runs along (u row, v column) — see render/lod. */
export const DIR_SCAN: ScanAxes[] = [
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

/** Axis index of each SCAN_T1 / SCAN_T2 tangent (0=x, 1=y, 2=z). Note the
 * tangents do not always align with the scan's u/v axes: west/east scans
 * run u=z, v=y while their AO tangents are t1=y, t2=z. */
const T1_AXIS = SCAN_T1.map((t) => (t[0] !== 0 ? 0 : t[1] !== 0 ? 1 : 2))
const T2_AXIS = SCAN_T2.map((t) => (t[0] !== 0 ? 0 : t[1] !== 0 ? 1 : 2))

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

/** One mergeable cube face, resolved once per palette entry: its baked
 * material info (the merged path rebuilds geometry from CUBE_FACES). */
interface FaceInfo {
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
  /** Material id per CUBE_FACES direction (see `internMaterial`); faces of
   * different palette entries that render identically share an id and merge. */
  mergeIds: Int32Array
  /** Synthesized water cube (water block or waterlogged state), always
   * greedy-mergeable; null without water. */
  waterFaces: FaceInfo[] | null
  /** Material ids of the synthesized water faces; null without water. */
  waterMergeIds: Int32Array | null
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

/** True when a full-cube model compiles to exactly the six canonical cube
 * faces — one culled quad per direction whose corner positions and
 * per-corner uv binding match CUBE_FACES (corners matched by position, so
 * the compiled vertex order may be any rotation of the table's). The merged
 * path rebuilds geometry and uvs from that table, so anything else must keep
 * the template path, which preserves the model's uvs verbatim: explicit uv
 * sub-rects, per-face texture rotation 90/180/270 (glazed terracotta,
 * crafter, pistons — the corner set still covers 0/16 but each corner reads
 * a rotated texel), and variant turns that spin the uv axes (horizontal
 * logs via cube_column x=90). */
function mergeableCube(quads: Quad[]): boolean {
  if (quads.length !== 6) return false
  const seen = new Set<FaceDir>()
  for (const q of quads) {
    if (q.cullface === undefined || seen.has(q.cullface)) return false
    seen.add(q.cullface)
    const face = CUBE_FACES[DIR_INDEX[q.cullface]]
    let bound = 0
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const c = face.corners[j]
        if (
          Math.abs(q.positions[i][0] - c[0]) > 1e-6 ||
          Math.abs(q.positions[i][1] - c[1]) > 1e-6 ||
          Math.abs(q.positions[i][2] - c[2]) > 1e-6
        ) {
          continue
        }
        if (
          Math.abs(q.uvs[i][0] - face.uvs[j][0]) > 1e-6 ||
          Math.abs(q.uvs[i][1] - face.uvs[j][1]) > 1e-6
        ) {
          return false
        }
        bound |= 1 << j
        break
      }
    }
    if (bound !== 0b1111) return false
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
 * shared state-geometry cache (tests pass isolated maps). `limits`
 * overrides the quad budget (tests stub a small one; exceeding it throws
 * {@link MeshBudgetError}, which the pipeline turns into coarse-LOD
 * degradation instead of a failed render).
 *
 * `onProgress`, when given, receives a 0..1 fraction: once after the
 * per-palette template build, then per swept slice of the six greedy
 * scans and per y layer of the template pass — never per voxel. Omitting
 * it keeps the callback-free path's behavior.
 */
export function extractSurface(
  grid: VoxelGrid,
  store: SurfaceAssets | null,
  cache: Map<string, StateGeometry> = stateGeometryCache,
  onProgress?: (fraction: number) => void,
  limits?: MeshLimits,
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

  /** Cube quads for a non-cube state in the box-proxy tier: the state's
   * first atlas-resolvable texture on a canonical cube. Whole-model views
   * are visually near-identical (stairs/walls/panes read as solid blocks at
   * distance); the loss of true shape up close is the tier's documented
   * approximation. Null when no quad resolves to a tile — the state then
   * keeps the exact template path. */
  const proxyCubeQuads = (quads: Quad[]): Quad[] | null => {
    for (const q of quads) {
      const { id, tile } = resolveTexture(q.texture)
      if (tile) return cubeTemplate(id, q.tintindex)
    }
    return null
  }

  /** Material interning: one small integer per distinct face appearance
   * (atlas tile + tint + alpha segment, or the fallback block color), so
   * the greedy scans can merge on `materialId << 8 | aoTuple` and states
   * that render identically collapse into shared runs. `flatColors` keeps
   * the packed 24-bit rgb per untextured material for coarse-merge corner
   * colors. Id 0 is reserved so keys of real faces are never 0. */
  const materialIds = new Map<string, number>()
  const flatColors: number[] = [0]
  const internMaterial = (face: FaceInfo, textureId: string): number => {
    const key = face.tile
      ? `${textureId}|${face.tile.u0},${face.tile.v0}|${face.tint ?? ''}|${face.segment}`
      : `flat|${face.flat?.join(',') ?? ''}|${face.segment}`
    let id = materialIds.get(key)
    if (id === undefined) {
      id = materialIds.size + 1
      materialIds.set(key, id)
      flatColors[id] = face.flat
        ? (Math.round(face.flat[0] * 255) << 16) |
          (Math.round(face.flat[1] * 255) << 8) |
          Math.round(face.flat[2] * 255)
        : 0
    }
    return id
  }

  /** Per-direction face infos for a six-quad cube template (indexed by
   * CUBE_FACES position via each quad's cullface). */
  const buildFaces = (
    quads: Quad[],
    state: BlockState,
    flatOf: (tint: Rgb | null) => Rgb | null,
    warnMissing: boolean,
  ): { faces: FaceInfo[]; mergeIds: Int32Array } => {
    const faces: FaceInfo[] = new Array(6)
    const mergeIds = new Int32Array(6)
    for (const q of quads) {
      const tint = resolveTint(state.name, state.props, q.tintindex)
      const { id, tile } = resolveTexture(q.texture)
      if (!tile && warnMissing) warnTexture(q.texture)
      const face: FaceInfo = {
        tint,
        tile,
        segment: tile ? segmentOfAlpha(store?.alphaClass(id) ?? 'opaque') : 'flat',
        flat: flatOf(tint),
      }
      const slot = DIR_INDEX[q.cullface!]
      faces[slot] = face
      mergeIds[slot] = internMaterial(face, id)
    }
    return { faces, mergeIds }
  }

  // One template per palette entry; air variants mesh as empty.
  const templates: (VoxelTemplate | null)[] = grid.palette.map((stateKey, i) => {
    if (i === 0 || AIR_NAMES.has(parseState(stateKey).name)) return null

    if (!store) {
      // No bundle: flat-colored full cubes (blockColor strips state strings).
      const color = blockColor(stateKey)
      const { faces, mergeIds } = buildFaces(FALLBACK_QUADS, parseState(stateKey), () => color, false)
      return {
        placeholder: false,
        quads: [],
        faces,
        mergeIds,
        waterFaces: null,
        waterMergeIds: null,
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

    const canonical = !geo.missing && mergeableCube(geo.quads)
    const proxy =
      !canonical && !geo.missing && limits?.cubeProxy === true
        ? proxyCubeQuads(geo.quads)
        : null
    const mergeable = canonical || proxy !== null
    const block = mergeable ? buildFaces(proxy ?? geo.quads, state, () => null, true) : null
    // Water cubes carry tintindex 0 → the constant water blue; a missing
    // water texture degrades silently to the flat water tint, not magenta.
    const water =
      isWater || waterlogged
        ? buildFaces(WATER_QUADS, state, (tint) => tint ?? MAGENTA, false)
        : null
    return {
      placeholder: geo.missing,
      quads: geo.missing || mergeable ? [] : geo.quads,
      faces: block?.faces ?? null,
      mergeIds: block?.mergeIds ?? new Int32Array(6),
      waterFaces: water?.faces ?? null,
      waterMergeIds: water?.mergeIds ?? null,
      // Glass/ice/… keep their faces against non-group neighbors, so only
      // cull-group-free full cubes hide neighboring faces. In the box-proxy
      // tier every non-air state is a cube, so proxies occlude like one.
      occludesFaces: (geo.fullCube || proxy !== null) && group === undefined,
      occludesAo: geo.fullCube || proxy !== null,
      group,
      hasWater: isWater || waterlogged,
      name: state.name,
      props: state.props,
      color: [1, 1, 1],
    }
  })

  // Coarse-merge gate: one LUT pass counts AO-occluding voxels (skipped
  // entirely for grids that could not reach the cap). Past the cap the
  // mesher drops baked AO everywhere, and the flat-color fallback also
  // merges runs by geometry alone with corner-cell colors.
  let aoDetail = true
  if (grid.data.length > COARSE_MERGE_MAX_OCCLUDERS) {
    const occluderLut = new Uint8Array(templates.length)
    for (let i = 0; i < templates.length; i++) occluderLut[i] = templates[i]?.occludesAo ? 1 : 0
    let occluders = 0
    for (let i = 0; i < grid.data.length; i++) occluders += occluderLut[grid.data[i]]
    aoDetail = occluders <= COARSE_MERGE_MAX_OCCLUDERS
  }
  const coarseColors = !aoDetail && store === null

  // Progress phases: template build 0..2%, greedy scans 2..72%, template
  // pass 72..100%. Per-slice / per-y-layer granularity only.
  if (onProgress) onProgress(0.02)
  const scanProgress = (dirIdx: number, slice: number, slices: number): number =>
    0.02 + 0.7 * ((dirIdx + slice / slices) / 6)

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

  /** Scratch 3x3 occluder ring around a face's outside cell, indexed
   * `(du + 1) * 3 + dv + 1` with du along SCAN_T1 and dv along SCAN_T2. */
  const aoRing = new Uint8Array(9)

  /** Packed corner-AO tuple of one mergeable face at (x,y,z) toward
   * CUBE_FACES[dirIdx].dir: the per-corner AO strength indices (the same
   * values vertexAo computes for the template path) as 2 bits each in
   * CUBE_FACES corner order. 0 means every corner fully lit. Faces merge
   * only into runs of one material AND one tuple — the run then reproduces
   * the unmerged per-corner shading exactly (water quads pass 0: water
   * never receives AO). Returns 0 in coarse-merge mode (no baked AO). */
  const cornerAo = (x: number, y: number, z: number, dirIdx: number): number => {
    if (!aoDetail) return 0
    const n = FACE_NORMALS[CUBE_FACES[dirIdx].dir]
    const e1 = SCAN_T1[dirIdx]
    const e2 = SCAN_T2[dirIdx]
    const bx = x + n[0]
    const by = y + n[1]
    const bz = z + n[2]
    aoRing.fill(0)
    for (let du = -1; du <= 1; du++) {
      for (let dv = -1; dv <= 1; dv++) {
        if (
          aoOccluder(
            bx + du * e1[0] + dv * e2[0],
            by + du * e1[1] + dv * e2[1],
            bz + du * e1[2] + dv * e2[2],
          )
        ) {
          aoRing[(du + 1) * 3 + dv + 1] = 1
        }
      }
    }
    // Corner sign follows the corner position relative to the block center
    // along each tangent axis — vertexAo's `p[t] > 0.5` convention.
    const corners = CUBE_FACES[dirIdx].corners
    const a1 = T1_AXIS[dirIdx]
    const a2 = T2_AXIS[dirIdx]
    let bits = 0
    for (let i = 0; i < 4; i++) {
      const c = corners[i]
      const su = c[a1] > 0 ? 1 : -1
      const sv = c[a2] > 0 ? 1 : -1
      const s1 = aoRing[(su + 1) * 3 + 1] === 1
      const s2 = aoRing[3 + (sv + 1)] === 1
      const cr = aoRing[(su + 1) * 3 + (sv + 1)] === 1
      const strength = s1 && s2 ? 3 : (s1 ? 1 : 0) + (s2 ? 1 : 0) + (cr ? 1 : 0)
      bits |= strength << (6 - 2 * i)
    }
    return bits
  }

  /** Per-vertex AO from the full-cube neighbors around the face's outside
   * cell; corner sign follows the vertex position relative to block center.
   * Fully lit in coarse-merge mode (AO is not baked at that scale). */
  const vertexAo = (quad: Quad, wx: number, wy: number, wz: number): number[] => {
    if (!aoDetail) return [1, 1, 1, 1]
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
  const quadCap = limits?.maxQuads ?? MAX_QUADS
  const spendQuad = (): void => {
    if (++quadBudget > quadCap) throw new MeshBudgetError()
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

  /** One merged rectangle: CUBE_FACES corner/uv topology with the in-plane
   * offsets and uv values scaled by w/h; constant normal, face light × tint
   * × per-corner AO from the run's shared tuple (the exact shading the
   * unmerged cells would show), with the quad diagonal flipped toward the
   * brighter corner pair like the per-face path. `cornerFlat` (coarse
   * fallback only) overrides the tint per corner with the packed 24-bit
   * block colors of the rectangle's corner cells, so geometry-merged runs
   * of mixed blocks shade as a local color average. */
  const emitMerged = (
    info: FaceInfo,
    dirIdx: number,
    a0: number,
    b0: number,
    s: number,
    w: number,
    h: number,
    aoBits: number,
    cornerFlat: number[] | null,
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
      const ao = AO_STRENGTH[(aoBits >> (6 - 2 * i)) & 3]
      // Coarse fallback: the corner cell's own block color × face light.
      const cr = cornerFlat ? (((cornerFlat[i] >> 16) & 0xff) / 255) * light * ao : color[0] * light * ao
      const cg = cornerFlat ? (((cornerFlat[i] >> 8) & 0xff) / 255) * light * ao : color[1] * light * ao
      const cb = cornerFlat ? ((cornerFlat[i] & 0xff) / 255) * light * ao : color[2] * light * ao
      col.data[col.length++] = cr
      col.data[col.length++] = cg
      col.data[col.length++] = cb
    }
    const idx = bucket.indices
    idx.reserve(6)
    // Flip the shared diagonal toward the brighter pair to hide AO seams.
    if (
      AO_STRENGTH[(aoBits >> 6) & 3] + AO_STRENGTH[(aoBits >> 2) & 3] <
      AO_STRENGTH[(aoBits >> 4) & 3] + AO_STRENGTH[aoBits & 3]
    ) {
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

  // -------------------------------------------------------------------------
  // Greedy scans: six directions × (block pass + water pass). Block mask
  // values are merge keys `(materialId << 8) | aoTuple`, water mask values
  // carry the water material; parallel `*Pi` masks keep the anchor cell's
  // palette index for face-info lookup. 0 is nothing. In coarse fallback
  // mode runs merge by geometry alone and take their colors from the corner
  // cells' materials. Sweeps clear every non-zero cell, so the masks start
  // zeroed for the next slice.
  // -------------------------------------------------------------------------

  /** Scratch corner colors for one coarse-mode emission (packed 24-bit). */
  const cornerColors = [0, 0, 0, 0]

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
    const blockPi = new Int32Array(nu * nv)
    const waterMask = new Int32Array(nu * nv)
    const waterPi = new Int32Array(nu * nv)

    // Merge-key LUTs for this direction (0 = not mergeable).
    const keyLut = new Int32Array(templates.length)
    const waterKeyLut = new Int32Array(templates.length)
    for (let i = 0; i < templates.length; i++) {
      const rec = templates[i]
      if (!rec) continue
      if (rec.faces) keyLut[i] = rec.mergeIds[dirIdx] << 8
      if (rec.waterFaces && rec.waterMergeIds) waterKeyLut[i] = rec.waterMergeIds[dirIdx] << 8
    }

    /** Standard maximal-rectangle sweep over equal merge keys; the shared
     * AO tuple drives per-corner shading and the diagonal flip. */
    const sweep = (mask: Int32Array, piMask: Int32Array, water: boolean, s: number): void => {
      for (let b = 0; b < nv; b++) {
        const row = b * nu
        for (let a = 0; a < nu; ) {
          const v = mask[row + a]
          if (v === 0) {
            a++
            continue
          }
          const anchor = piMask[row + a]
          const info = (water ? templates[anchor]!.waterFaces : templates[anchor]!.faces)![dirIdx]
          let w = 1
          if (coarseColors) {
            while (a + w < nu && mask[row + a + w] !== 0) w++
          } else {
            while (a + w < nu && mask[row + a + w] === v) w++
          }
          let h = 1
          grow: while (b + h < nv) {
            const below = (b + h) * nu + a
            for (let k = 0; k < w; k++) {
              if (coarseColors ? mask[below + k] === 0 : mask[below + k] !== v) break grow
            }
            h++
          }
          let cornerFlat: number[] | null = null
          if (coarseColors && !water) {
            // Corner i's signs run along the AO tangents, which swap the
            // scan's u/v roles on west/east scans.
            const t1IsU = T1_AXIS[dirIdx] === ua
            const corners = CUBE_FACES[dirIdx].corners
            const a1 = T1_AXIS[dirIdx]
            const a2 = T2_AXIS[dirIdx]
            for (let i = 0; i < 4; i++) {
              const c = corners[i]
              const su = c[a1] > 0 ? 1 : -1
              const sv = c[a2] > 0 ? 1 : -1
              const colSign = t1IsU ? su : sv
              const rowSign = t1IsU ? sv : su
              const col = a + (colSign > 0 ? w - 1 : 0)
              const cell = (b + (rowSign > 0 ? h - 1 : 0)) * nu + col
              cornerColors[i] = flatColors[mask[cell] >>> 8]
            }
            cornerFlat = cornerColors
          }
          emitMerged(info, dirIdx, a, b, s, w, h, v & 0xff, cornerFlat)
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
          if (keyLut[pi] !== 0 && !culled(x, y, z, dir, rec.group)) {
            blockMask[m] = keyLut[pi] | cornerAo(x, y, z, dirIdx)
            blockPi[m] = pi
          }
          if (waterKeyLut[pi] !== 0 && !waterCulled(x, y, z, dir)) {
            waterMask[m] = waterKeyLut[pi]
            waterPi[m] = pi
          }
        }
      }
      sweep(blockMask, blockPi, false, s)
      sweep(waterMask, waterPi, true, s)
      if (onProgress) onProgress(scanProgress(dirIdx, s + 1, nd))
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
    if (onProgress && y + 1 < dy) onProgress(0.72 + 0.28 * ((y + 1) / dy))
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

  if (onProgress) onProgress(1)
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
