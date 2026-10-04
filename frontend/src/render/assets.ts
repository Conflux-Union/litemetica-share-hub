/**
 * Vanilla render-bundle loader (plan §5 P2.1), replacing the old atlas.ts.
 *
 * Fetches GET /api/textures/bundle (gzip JSON) plus the content-hashed
 * atlas PNG it points at, and exposes typed accessors for the model layer
 * (resolveStateGeometry) and the mesher (tile transforms, alpha classes,
 * biome tint colors). Any failure resolves null and the viewer keeps its
 * flat-color fallback mode.
 *
 * The pure bundle derivations live in render/bundle.ts (shared with the
 * mesh worker); this module re-exports them and adds the three.js parts
 * (texture loading, sRGB).
 */

import * as THREE from 'three'
import { gunzipSync } from 'fflate'
import type { AlphaClass, AssetBundle } from '../types'
import type { VanillaAssets } from './model'
import {
  bundleTintColors,
  buildVanillaAssets,
  makeLookups,
  type BundleLookups,
  type TileTransform,
} from './bundle'
import { setTintColors, type Rgb } from './tint'

export * from './bundle'

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

  const assets = buildVanillaAssets(bundle)
  const lookups: BundleLookups = makeLookups(bundle)
  const tintColors = bundleTintColors(bundle)
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
