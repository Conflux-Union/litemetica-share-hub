/**
 * Vanilla render-bundle loader (plan §5 P2.1), replacing the old atlas.ts.
 *
 * Fetches GET /api/textures/bundle (gzip JSON) plus the content-hashed
 * atlas PNG it points at, and exposes typed accessors for the model layer
 * (resolveStateGeometry) and the mesher (tile transforms, alpha classes,
 * biome tint colors). Any failure resolves null and the viewer keeps its
 * flat-color fallback mode.
 */

import * as THREE from 'three'
import { gunzipSync } from 'fflate'
import type { AlphaClass, AssetBundle, BundleModel, SpriteRef } from '../types'
import type { BlockstateJson, ModelJson, VanillaAssets } from './model'
import { DEFAULT_TINT_COLORS, setTintColors, type Rgb } from './tint'

/**
 * Atlas mapping for one tile: `atlasU = u0 + du * modelU`,
 * `atlasV = v0 + dv * modelV` with model uv in 0..16 texture space (v
 * growing down from the tile's top edge). dv is negative because atlas v
 * grows upwards under THREE's flipY convention. A half-texel inset keeps
 * sampling inside the tile.
 */
export interface TileTransform {
  u0: number
  du: number
  v0: number
  dv: number
}

export interface AssetStore {
  bundle: AssetBundle
  /** Atlas PNG as a three.js texture (NearestFilter, no mipmaps, sRGB). */
  texture: THREE.Texture
  /** Normalized vanilla assets for resolveStateGeometry: blockstates
   * re-keyed to state names, model texture maps sprite-unwrapped. */
  assets: VanillaAssets
  /** Tile mapping for a texture id, or null when the texture is absent
   * from the atlas (e.g. minecraft:missingno) — render the placeholder.
   * Namespace-tolerant: bare ids ("block/stone") resolve to their
   * namespaced atlas entry. */
  tileTransform(textureId: string): TileTransform | null
  /** Alpha class of an atlas texture; unknown ids read as opaque. */
  alphaClass(textureId: string): AlphaClass
  /** Default-biome tint colors (colormap center pixels), 0..1 rgb. */
  tintColors: { grass: Rgb; foliage: Rgb }
}

/** Normalized span of one atlas tile (u and v alike), derived from the
 * same inset formula {@link buildTileTransforms} bakes into every tile. */
export function atlasTileSpan(bundle: AssetBundle): number {
  const tile = bundle.tile > 0 ? bundle.tile : 16
  const ts = 1 / bundle.grid
  const inset = 0.5 / (bundle.grid * tile)
  return ts - 2 * inset
}

/**
 * CPU parity check for the tiled-atlas fragment sampling (Viewer3D.vue /
 * render/tiledMaterial): wrap a local 0..16 texel uv into one tile and
 * offset it by the per-vertex tile origin. `fract(l/16 * (1 - 1e-4))`
 * keeps samples just inside the tile edge; the per-period inset accumulates
 * a sub-texel drift over long merged runs, which nearest filtering hides.
 */
export function computeAtlasUv(
  tileOrigin: { u0: number; v0: number },
  localUv: readonly [number, number],
  span: number,
): [number, number] {
  const fract = (t: number): number => t - Math.floor(t)
  const shrink = 1 - 1e-4
  return [
    tileOrigin.u0 + fract((localUv[0] / 16) * shrink) * span,
    tileOrigin.v0 - fract((localUv[1] / 16) * shrink) * span,
  ]
}

/**
 * Map bundle blockstate keys ("minecraft:block/<name>") to state-name keys
 * ("minecraft:<name>") so resolveStateGeometry finds them by state name;
 * original keys are kept too for tolerant lookup.
 */
export function normalizeBlockStates(
  states: Record<string, BlockstateJson>,
): Record<string, BlockstateJson> {
  const out: Record<string, BlockstateJson> = {}
  for (const [key, json] of Object.entries(states)) {
    out[key] = json
    const mapped = /^([^:]+):block\/(.+)$/.exec(key)
    if (mapped) {
      const stateKey = `${mapped[1]}:${mapped[2]}`
      if (!(stateKey in out)) out[stateKey] = json
    }
  }
  return out
}

/**
 * Unwrap one wire model: 26.x texture values may be sprite objects
 * ({sprite, force_translucent}); the model layer expects plain strings.
 * force_translucent is dropped — the mesher buckets by the bundle's
 * server-side alpha class. Elements pass through verbatim (trusted wire
 * data from our own extractor); the cast only narrows their loose type.
 */
export function normalizeModel(model: BundleModel): ModelJson {
  const { textures, ...rest } = model
  if (!textures) return rest as ModelJson
  const flat: Record<string, string> = {}
  for (const [key, value] of Object.entries(textures)) {
    flat[key] = typeof value === 'string' ? value : (value as SpriteRef).sprite
  }
  return { ...rest, textures: flat } as unknown as ModelJson
}

/**
 * Precompute per-texture atlas transforms. Model uv space is always 0..16
 * (vanilla), regardless of the tile pixel size.
 */
export function buildTileTransforms(bundle: AssetBundle): Map<string, TileTransform> {
  const { grid, tile } = bundle
  const ts = 1 / grid
  const inset = 0.5 / (grid * tile)
  const span = ts - 2 * inset
  const out = new Map<string, TileTransform>()
  for (const [id, entry] of Object.entries(bundle.textures)) {
    const [col, row] = entry.uv
    out.set(id, {
      u0: col * ts + inset,
      du: span / 16,
      v0: 1 - row * ts - inset,
      dv: -span / 16,
    })
  }
  return out
}

/**
 * Namespace-tolerant texture-id resolution: atlas keys are always
 * fully-qualified, but 26.x model files reference textures both
 * namespaced ("minecraft:block/snow") and bare ("block/stone" — the
 * repeater/comparator/brewing-stand family). Bare ids read as
 * "minecraft:<id>"; ids that already carry a namespace pass through.
 */
export function resolveTextureId(bundle: AssetBundle, id: string): string {
  return id in bundle.textures || id.includes(':') ? id : `minecraft:${id}`
}

/** Bundle lookups shared by the viewer mesher, the icon renderer and
 * tests; both are namespace-tolerant via {@link resolveTextureId}. */
export function makeLookups(bundle: AssetBundle): {
  tileTransform: AssetStore['tileTransform']
  alphaClass: AssetStore['alphaClass']
} {
  const transforms = buildTileTransforms(bundle)
  return {
    tileTransform: (id) => transforms.get(resolveTextureId(bundle, id)) ?? null,
    alphaClass: (id) => bundle.textures[resolveTextureId(bundle, id)]?.alpha ?? 'opaque',
  }
}

function isUsableBundle(bundle: AssetBundle): boolean {
  return (
    typeof bundle.atlas === 'string' &&
    bundle.atlas.length > 0 &&
    Number.isFinite(bundle.grid) &&
    bundle.grid > 0 &&
    Number.isFinite(bundle.tile) &&
    bundle.tile > 0 &&
    typeof bundle.blockStates === 'object' &&
    bundle.blockStates !== null &&
    typeof bundle.blockModels === 'object' &&
    bundle.blockModels !== null &&
    typeof bundle.textures === 'object' &&
    bundle.textures !== null
  )
}

let cached: Promise<AssetStore | null> | null = null

/**
 * Load the render bundle and atlas (module-level singleton; the result —
 * including a null failure — is cached for the page session, like the old
 * atlas loader).
 */
export function loadAssets(): Promise<AssetStore | null> {
  cached ??= fetchAssets().catch(() => null)
  return cached
}

async function fetchAssets(): Promise<AssetStore | null> {
  let resp: Response
  try {
    resp = await fetch('/api/textures/bundle')
  } catch {
    return null
  }
  if (!resp.ok) return null

  let bundle: AssetBundle
  try {
    const gz = new Uint8Array(await resp.arrayBuffer())
    bundle = JSON.parse(new TextDecoder().decode(gunzipSync(gz))) as AssetBundle
    if (!isUsableBundle(bundle)) return null
  } catch {
    return null
  }

  const texture = await new Promise<THREE.Texture>((resolve, reject) => {
    new THREE.TextureLoader().load(`/api/textures/${bundle.atlas}`, resolve, undefined, reject)
  })
  texture.magFilter = THREE.NearestFilter
  texture.minFilter = THREE.NearestFilter
  texture.generateMipmaps = false
  texture.colorSpace = THREE.SRGBColorSpace

  const assets: VanillaAssets = {
    blockStates: normalizeBlockStates(bundle.blockStates as Record<string, BlockstateJson>),
    // Item models join the model map so flattenModel can walk parent
    // chains across block and item models (keys never collide).
    blockModels: {
      ...Object.fromEntries(
        Object.entries(bundle.blockModels).map(([id, model]) => [id, normalizeModel(model)]),
      ),
      ...Object.fromEntries(
        Object.entries(bundle.itemModels ?? {}).map(([id, model]) => [id, normalizeModel(model)]),
      ),
    },
  }
  const lookups = makeLookups(bundle)

  const toRgb = (v: [number, number, number]): Rgb => [v[0] / 255, v[1] / 255, v[2] / 255]
  const tintColors = {
    grass: bundle.tintColors.grass ? toRgb(bundle.tintColors.grass) : DEFAULT_TINT_COLORS.grass,
    foliage: bundle.tintColors.foliage
      ? toRgb(bundle.tintColors.foliage)
      : DEFAULT_TINT_COLORS.foliage,
  }
  // Keep resolveTint's module palette in sync with the loaded bundle.
  setTintColors(tintColors)

  return {
    bundle,
    texture,
    assets,
    tileTransform: lookups.tileTransform,
    alphaClass: lookups.alphaClass,
    tintColors,
  }
}
