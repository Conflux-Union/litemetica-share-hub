/**
 * Material-table icons, matching what the vanilla inventory shows for one
 * item: when the bundle carries item models (format 3+), the ITEM renders —
 * a flat sprite for item/generated families (redstone, rails, bell,
 * torches, seeds, …) or dedicated elements — and everything else renders
 * the placed block's default state as an orthographic isometric icon.
 *
 * Projection (vanilla gui display [30, 225, 0] under Minecraft's axis
 * conventions): after rotating 135° around Y then 30° around X, the
 * visible faces of a cube are the top, the north face (icon left, shade
 * 0.8) and the west face (icon right, shade 0.6) — a furnace-style block
 * shows its front on the left, like the inventory sprite.
 *
 * Variants resolve to exactly one model — the first unrotated entry — so
 * oriented blocks (furnace, repeater, …) render in their canonical
 * north-facing orientation and multi-property tables (delay/lit/bite…)
 * don't stack every state's model; multipart resolves the property-less
 * default selection (walls/fences show their post, redstone its dot).
 * Faces are culled by normal, z-sorted with a painter's algorithm, and
 * each projected parallelogram maps its texture tile through one affine
 * transform — sub-rect UVs, UV rotation and partial-height models land
 * exactly.
 */

import type { AssetStore } from './assets'
import { resolveTextureId } from './assets'
import {
  compileGeometry,
  flattenModel,
  formatState,
  parseState,
  parseVariantKey,
  resolveBlockstate,
  resolveStateGeometry,
  type BlockState,
  type BlockstateJson,
  type Quad,
  type VariantModel,
} from './model'
import { resolveTint, type Rgb } from './tint'

/** Canvas transform [a, b, c, d, e, f] (ctx.setTransform order):
 * x' = a·u + c·v + e, y' = b·u + d·v + f, (u, v) in tile texel space
 * (0..16, v downward like the texture image). */
export type TexTransform = [number, number, number, number, number, number]

export interface IconQuad {
  /** Projected quad corners in icon pixels (for the clip path). */
  corners: [number, number][]
  /** Affine texel→screen mapping; see {@link TexTransform}. */
  texTransform: TexTransform
  /** Atlas source rect [sx, sy, w, h] in pixels; null when the texture
   * is absent from the atlas — the quad paints as the placeholder. */
  tileRect: [number, number, number, number] | null
  /** Face shade from the model-space normal: up 1.0, north/south 0.8,
   * east/west 0.6, down 0.5 (vanilla diffuse). */
  shade: number
  tint: Rgb | null
  /** Mean camera-space depth; ascending draw order (painter's). */
  z: number
}

/** A flat item sprite (item/generated models): drawn nearest-neighbor,
 * like the vanilla GUI slot. */
export interface IconSprite {
  kind: 'sprite'
  size: number
  /** Atlas source rect [sx, sy, w, h] in pixels. */
  tileRect: [number, number, number, number]
}

/** An isometric block-model render, painter-ordered. */
export interface IconBlocks {
  kind: 'blocks'
  size: number
  quads: IconQuad[]
}

export type IconDrawList = IconSprite | IconBlocks

/** Vanilla gui pitch/yaw: 30° down, equivalent to the 225° display yaw
 * under Minecraft's per-axis sign conventions (front face ends up left). */
const PITCH = (30 * Math.PI) / 180
const YAW = (135 * Math.PI) / 180
/** View padding inside the square icon, as a fraction of the size. */
const PAD = 0.04
/** Placeholder fill for atlas-missing textures (preview convention). */
const PLACEHOLDER = '#f800f8'

/** Material-list item ids whose icon renders an associated block model —
 * the inverse of the backend's block_to_item mapping (parse.rs). Their
 * vanilla icons are item sprites, which the block render bundle does not
 * carry; the block model is the closest recognizable substitute. */
const ITEM_STATE_ALIASES: Record<string, string> = {
  'minecraft:redstone': 'minecraft:redstone_wire',
  'minecraft:string': 'minecraft:tripwire',
  'minecraft:beetroot_seeds': 'minecraft:beetroots',
  'minecraft:carrot': 'minecraft:carrots',
  'minecraft:potato': 'minecraft:potatoes',
  'minecraft:pumpkin_seeds': 'minecraft:pumpkin_stem',
  'minecraft:melon_seeds': 'minecraft:melon_stem',
  'minecraft:torchflower_seeds': 'minecraft:torchflower_crop',
  'minecraft:pitcher_pod': 'minecraft:pitcher_crop',
  'minecraft:cocoa_beans': 'minecraft:cocoa',
  'minecraft:kelp': 'minecraft:kelp_plant',
  'minecraft:glow_berries': 'minecraft:cave_vines',
  'minecraft:sweet_berries': 'minecraft:sweet_berry_bush',
  'minecraft:chorus_fruit': 'minecraft:chorus_plant',
  'minecraft:snow_layer_item': 'minecraft:snow',
}

/** x=east, y=up, z=south; p is block-local [0,1]. Screen x grows right,
 * screen y grows down (canvas), depth grows toward the camera. */
function project(p: readonly number[]): [number, number, number] {
  const x = p[0] - 0.5
  const y = p[1] - 0.5
  const z = p[2] - 0.5
  const cy = Math.cos(YAW)
  const sy = Math.sin(YAW)
  const cx = Math.cos(PITCH)
  const sx = Math.sin(PITCH)
  // Ry(YAW)
  const x1 = cy * x + sy * z
  const z1 = -sy * x + cy * z
  // Rx(PITCH)
  const y2 = cx * y - sx * z1
  const z2 = sx * y + cx * z1
  return [x1, -y2, z2]
}

/** Unit vector pointing toward the camera in model space (R^T · e_z);
 * faces with normal·toCamera <= 0 are back-facing. */
const TO_CAMERA = (() => {
  const c = Math.cos(YAW)
  const s = Math.sin(YAW)
  const cx = Math.cos(PITCH)
  const sx = Math.sin(PITCH)
  // R^T e_z = Ry(-YAW) · Rx(-PITCH) · e_z
  const y = sx
  const z = cx
  return [-s * z, y, c * z] as const
})()

/** Default-state preference orders for breaking ties between several
 * unrotated variants (stairs alone have five: straight + corners ×
 * facings, and the alphabetically-first key is an inner corner). Vanilla
 * default states are shape=straight, half=bottom, facing=north and
 * booleans false. */
const DEFAULT_PROP_ORDER: Record<string, readonly string[]> = {
  shape: ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right'],
  half: ['bottom', 'lower', 'top', 'upper'],
  facing: ['north', 'south', 'east', 'west'],
}

/** Lexicographic "defaultness" score of one variant's conditions; lower
 * wins. Unconditioned properties rank 0 (most preferred); unknown values
 * rank after every listed one. */
function variantScore(cond: Record<string, string>): number[] {
  const rank = (order: readonly string[], prop: string): number => {
    const value = cond[prop]
    if (value === undefined) return 0
    const i = order.indexOf(value)
    return i === -1 ? order.length + 1 : i + 1
  }
  return [
    rank(DEFAULT_PROP_ORDER.shape, 'shape'),
    rank(DEFAULT_PROP_ORDER.half, 'half'),
    rank(DEFAULT_PROP_ORDER.facing, 'facing'),
    Object.values(cond).filter((v) => v === 'true').length,
  ]
}

function lexLess(a: readonly number[], b: readonly number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

/** Model pick for icons — the default-state selection, like the vanilla
 * inventory: a `variants` table renders exactly ONE model. Prefer the
 * unrotated entries (canonical orientation); among them pick the most
 * default-ish property combination (straight/bottom/north/false). A
 * `multipart` resolves against empty properties, so `when`-conditioned
 * parts drop out and unconditional parts (wall/fence posts, the redstone
 * dot) remain. */
function iconVariants(bs: BlockstateJson): VariantModel[] | null {
  if (bs.variants) {
    const entries: { model: VariantModel; cond: Record<string, string> }[] = []
    for (const [key, value] of Object.entries(bs.variants)) {
      const model = Array.isArray(value) ? value[0] : value
      if (model) entries.push({ model, cond: parseVariantKey(key) })
    }
    if (!entries.length) return null
    const unrotated = entries.filter((e) => !e.model.x && !e.model.y)
    const pool = unrotated.length ? unrotated : entries
    let best = pool[0]
    for (const entry of pool) {
      if (lexLess(variantScore(entry.cond), variantScore(best.cond))) best = entry
    }
    return [best.model]
  }
  if (bs.multipart?.length) return resolveBlockstate({}, bs)
  return null
}

/**
 * Pure part of the icon renderer: the vanilla inventory shows the ITEM, so
 * prefer its model (flat sprite or dedicated elements) and fall back to
 * the placed block's default state. Null when nothing resolves (unknown
 * block — caller falls back to a flat color).
 */
export function buildIconDrawList(
  store: AssetStore,
  stateKey: string,
  size = 64,
): IconDrawList | null {
  const state = parseState(stateKey)
  const aliased = parseState(ITEM_STATE_ALIASES[stateKey] ?? stateKey)
  // The alias retry covers item-form ids (redstone, seeds, …) on stale
  // pre-v3 bundles that carry no itemModels.
  return (
    itemDrawList(store, state.name, size) ??
    itemDrawList(store, aliased.name, size) ??
    blockStateDrawList(store, aliased, size)
  )
}

/** One item's model: dedicated elements render isometrically like a
 * block; element-less models (item/generated) are sprites drawn flat. */
function itemDrawList(store: AssetStore, name: string, size: number): IconDrawList | null {
  const id = `minecraft:item/${name.replace(/^minecraft:/, '')}`
  const flat = flattenModel(id, store.assets.blockModels)
  if (!flat) return null
  if (flat.elements.length > 0) {
    return quadDrawList(store, { name, props: {} }, compileGeometry(flat), size)
  }
  const layer0 = flat.textures['layer0']
  if (!layer0) return null
  const entry = store.bundle.textures[resolveTextureId(store.bundle, layer0)]
  if (!entry) return null
  const { tile } = store.bundle
  return { kind: 'sprite', size, tileRect: [entry.uv[0] * tile, entry.uv[1] * tile, tile, tile] }
}

/** Placed-block default state: variant/multipart resolution (see
 * iconVariants) with the shared-resolver fallback for unknown names. */
function blockStateDrawList(store: AssetStore, state: BlockState, size: number): IconDrawList | null {
  let quads: Quad[] = []
  const bs = store.assets.blockStates[state.name]
  if (bs) {
    for (const v of iconVariants(bs) ?? []) {
      const flat = flattenModel(v.model, store.assets.blockModels)
      if (!flat) continue
      quads.push(...compileGeometry(flat, { x: v.x, y: v.y }))
    }
  }
  // Unknown blockstate (or legacy aliased name): the shared resolver owns
  // the alias table and missing-model semantics.
  if (!quads.length) {
    quads = resolveStateGeometry(formatState(state), store.assets).quads
  }
  return quads.length ? quadDrawList(store, state, quads, size) : null
}

/** Project resolved quads into a painter-ordered isometric draw list. */
function quadDrawList(
  store: AssetStore,
  state: BlockState,
  quads: Quad[],
  size: number,
): IconDrawList | null {
  const projected = quads
    .filter((q) => q.normal[0] * TO_CAMERA[0] + q.normal[1] * TO_CAMERA[1] + q.normal[2] * TO_CAMERA[2] > 1e-6)
    .map((q) => ({ q, pts: q.positions.map(project) }))
  if (!projected.length) return null

  // Fit the projected bounds into the padded square.
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const { pts } of projected) {
    for (const [x, y] of pts) {
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }
  const span = size * (1 - 2 * PAD)
  const scale = Math.min(span / Math.max(maxX - minX, 1e-6), span / Math.max(maxY - minY, 1e-6))
  const ox = (size - scale * (maxX + minX)) / 2
  const oy = (size - scale * (maxY + minY)) / 2
  const toScreen = (p: [number, number, number]): [number, number] => [
    ox + scale * p[0],
    oy + scale * p[1],
  ]

  const { tile } = store.bundle
  const out: IconQuad[] = []
  for (const { q, pts } of projected) {
    const corners = pts.map(toScreen)
    const texTransform = texelTransform(corners, q.uvs)
    if (!texTransform) continue
    const texId = resolveTextureId(store.bundle, q.texture)
    const entry = store.bundle.textures[texId]
    out.push({
      corners,
      texTransform,
      tileRect: entry ? [entry.uv[0] * tile, entry.uv[1] * tile, tile, tile] : null,
      shade: faceShade(q.normal),
      tint: resolveTint(state.name, state.props, q.tintindex),
      z: pts.reduce((s, p) => s + p[2], 0) / pts.length,
    })
  }
  out.sort((a, b) => a.z - b.z)
  return out.length ? { kind: 'blocks', size, quads: out } : null
}

/** Solve the affine map (u,v)→screen that takes each uv corner to its
 * projected corner. Quads project to parallelograms under orthography,
 * so corners 0/1/3 determine the whole map; null when degenerate
 * (zero-area uv, e.g. a face with no extent along one axis). */
export function texelTransform(
  corners: readonly [number, number][],
  uvs: readonly [number, number][],
): TexTransform | null {
  const [[x0, y0], [x1, y1], , [x3, y3]] = corners
  const [[u0, v0], [u1, v1], , [u3, v3]] = uvs
  const dux = u1 - u0
  const duy = v1 - v0
  const dvx = u3 - u0
  const dvy = v3 - v0
  const det = dux * dvy - dvx * duy
  if (Math.abs(det) < 1e-9) return null
  const ex = x1 - x0
  const ey = y1 - y0
  const fx = x3 - x0
  const fy = y3 - y0
  const a = (ex * dvy - fx * duy) / det
  const c = (dux * fx - dvx * ex) / det
  const b = (ey * dvy - fy * duy) / det
  const d = (dux * fy - dvx * ey) / det
  return [a, b, c, d, x0 - (a * u0 + c * v0), y0 - (b * u0 + d * v0)]
}

/** Dominant-axis shade of a (possibly element-rotated) normal. */
function faceShade(normal: readonly number[]): number {
  const [nx, ny, nz] = normal
  const ax = Math.abs(nx)
  const ay = Math.abs(ny)
  const az = Math.abs(nz)
  if (ay >= ax && ay >= az) return ny > 0 ? 1.0 : 0.5
  if (az >= ax) return 0.8
  return 0.6
}

/**
 * Paint a draw list onto a size×size 2D context. Sprites draw
 * nearest-neighbor at the largest integer scale (pixel-crisp, like the
 * vanilla GUI). Model renders draw each quad on a scratch canvas (clip to
 * the parallelogram, affine drawImage of its tile, multiply shade/tint,
 * destination-in re-mask so translucent texels stay translucent) then
 * composite in painter's order.
 */
export function paintIcon(
  ctx: CanvasRenderingContext2D,
  atlas: CanvasImageSource,
  list: IconDrawList,
): void {
  if (list.kind === 'sprite') {
    const [sx, sy, w, h] = list.tileRect
    const scale = Math.max(1, Math.floor((list.size * (1 - 2 * PAD)) / w))
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(
      atlas,
      sx,
      sy,
      w,
      h,
      (list.size - w * scale) / 2,
      (list.size - h * scale) / 2,
      w * scale,
      h * scale,
    )
    return
  }
  const scratch = document.createElement('canvas')
  scratch.width = scratch.height = list.size
  const sctx = scratch.getContext('2d')!
  sctx.imageSmoothingEnabled = false

  for (const quad of list.quads) {
    sctx.clearRect(0, 0, list.size, list.size)
    sctx.save()
    sctx.beginPath()
    sctx.moveTo(quad.corners[0][0], quad.corners[0][1])
    for (let i = 1; i < quad.corners.length; i++) {
      sctx.lineTo(quad.corners[i][0], quad.corners[i][1])
    }
    sctx.closePath()
    sctx.clip()

    const drawTile = () => {
      const [sx, sy, w, h] = quad.tileRect!
      sctx.setTransform(...quad.texTransform)
      sctx.drawImage(atlas, sx, sy, w, h, 0, 0, 16, 16)
      sctx.setTransform(1, 0, 0, 1, 0, 0)
    }

    if (quad.tileRect) {
      drawTile()
      if (quad.shade !== 1 || quad.tint) {
        const r = Math.round(255 * quad.shade * (quad.tint?.[0] ?? 1))
        const g = Math.round(255 * quad.shade * (quad.tint?.[1] ?? 1))
        const bl = Math.round(255 * quad.shade * (quad.tint?.[2] ?? 1))
        sctx.globalCompositeOperation = 'multiply'
        sctx.fillStyle = `rgb(${r},${g},${bl})`
        sctx.fillRect(0, 0, list.size, list.size)
        sctx.globalCompositeOperation = 'destination-in'
        drawTile()
      }
    } else {
      sctx.fillStyle = PLACEHOLDER
      sctx.fill()
    }
    sctx.restore()
    ctx.drawImage(scratch, 0, 0)
  }
}

/** Render a block icon to a dataURL, or null when the state resolves to
 * nothing (caller falls back to a flat color). */
export function blockIconDataURL(store: AssetStore, stateKey: string, size = 64): string | null {
  const list = buildIconDrawList(store, stateKey, size)
  if (!list) return null
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = list.size
  const ctx = canvas.getContext('2d')!
  paintIcon(ctx, store.texture.image as CanvasImageSource, list)
  return canvas.toDataURL()
}
