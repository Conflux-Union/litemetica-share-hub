/**
 * Pure (three-free) render-bundle helpers shared by the main-thread asset
 * loader (render/assets), the mesh worker (render/meshWorker) and tests:
 * tile transforms, namespace-tolerant lookups, and the vanilla-assets shape
 * resolveStateGeometry needs — all derived from the plain-JSON AssetBundle
 * wire type. assets.ts re-exports this module for compatibility.
 */

import type { AlphaClass, AssetBundle, BundleModel, SpriteRef } from '../types'
import type { BlockstateJson, ModelJson, VanillaAssets } from './model'
import type { SurfaceAssets } from './surface'
import { DEFAULT_TINT_COLORS, type TintPalette } from './tint'

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

/** Namespace-tolerant bundle lookups shared by the viewer mesher, the mesh
 * worker, the icon renderer and tests. */
export interface BundleLookups {
  /** Atlas mapping for a texture id, or null when the texture is absent
   * from the atlas (e.g. minecraft:missingno) — render the placeholder. */
  tileTransform(textureId: string): TileTransform | null
  /** Alpha class of an atlas texture; unknown ids read as opaque. */
  alphaClass(textureId: string): AlphaClass
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

/** Bundle lookups per {@link BundleLookups}; both accessors are
 * namespace-tolerant via {@link resolveTextureId}. */
export function makeLookups(bundle: AssetBundle): BundleLookups {
  const transforms = buildTileTransforms(bundle)
  return {
    tileTransform: (id) => transforms.get(resolveTextureId(bundle, id)) ?? null,
    alphaClass: (id) => bundle.textures[resolveTextureId(bundle, id)]?.alpha ?? 'opaque',
  }
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
 * Build the normalized {@link VanillaAssets} shape resolveStateGeometry
 * needs from a plain-JSON bundle: blockstates re-keyed to state names and
 * model texture maps sprite-unwrapped. Item models join the model map so
 * flattenModel can walk parent chains across block and item models (keys
 * never collide).
 */
export function buildVanillaAssets(bundle: AssetBundle): VanillaAssets {
  return {
    blockStates: normalizeBlockStates(bundle.blockStates as Record<string, BlockstateJson>),
    blockModels: {
      ...Object.fromEntries(
        Object.entries(bundle.blockModels).map(([id, model]) => [id, normalizeModel(model)]),
      ),
      ...Object.fromEntries(
        Object.entries(bundle.itemModels ?? {}).map(([id, model]) => [id, normalizeModel(model)]),
      ),
    },
  }
}

/** Bundle colormap samples as 0..1 rgb, falling back to the built-in
 * plains defaults when the bundle omits them. Pure — installing the
 * palette into render/tint is the caller's job (setTintColors). */
export function bundleTintColors(bundle: AssetBundle): TintPalette {
  const toRgb = (v: [number, number, number]): [number, number, number] => [
    v[0] / 255,
    v[1] / 255,
    v[2] / 255,
  ]
  return {
    grass: bundle.tintColors.grass ? toRgb(bundle.tintColors.grass) : DEFAULT_TINT_COLORS.grass,
    foliage: bundle.tintColors.foliage
      ? toRgb(bundle.tintColors.foliage)
      : DEFAULT_TINT_COLORS.foliage,
  }
}

/**
 * Assemble the mesher's {@link SurfaceAssets} view of a plain-JSON bundle
 * (normalized vanilla assets + atlas lookups) without touching three.js —
 * what the mesh worker feeds extractSurface.
 */
export function surfaceAssetsFromBundle(bundle: AssetBundle): SurfaceAssets {
  return { assets: buildVanillaAssets(bundle), ...makeLookups(bundle) }
}
