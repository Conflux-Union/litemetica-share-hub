/**
 * Entry point for vanilla model resolution: stateKey → resolved quad
 * templates, cached per canonical stateKey. Re-exports the pure layers
 * (state parsing/resolution, model flattening, geometry compilation) so
 * consumers import from './model' only.
 */

import {
  formatState,
  parseState,
  resolveBlockstate,
  type BlockstateJson,
  type VariantModel,
} from './state'
import {
  compileGeometry,
  flattenModel,
  isFullCube,
  type FlattenedModel,
  type ModelJson,
  type Quad,
} from './geometry'

export * from './state'
export * from './geometry'

/** Minimal asset surface the resolver needs; the P2.1 bundle satisfies
 * this structurally (blockStates/blockModels keyed by full id). */
export interface VanillaAssets {
  /** Block id ("minecraft:redstone_wire") → verbatim blockstate JSON. */
  blockStates: Record<string, BlockstateJson>
  /** Model id ("minecraft:block/wall_torch") → verbatim model JSON. */
  blockModels: Record<string, ModelJson>
}

/** Pre-1.20.3 block ids renamed since; older litematics may still carry
 * them and a current bundle cannot resolve them (plan §5 P2.5). */
const LEGACY_STATE_ALIASES: Record<string, string> = {
  'minecraft:grass': 'minecraft:short_grass',
  'minecraft:grass_path': 'minecraft:dirt_path',
  'minecraft:chain': 'minecraft:iron_chain',
}

/** Blocks whose vanilla models are intentionally element-less and that are
 * invisible in-world (or synthesized by the mesher, like water). They are
 * not missing-model placeholders; everything else that resolves to zero
 * quads — chests, banners, heads, … vanilla renders from block entities —
 * becomes the placeholder so it is never an invisible hole. */
const ELEMENTLESS_VISIBLE_NEVER = new Set([
  'minecraft:air',
  'minecraft:cave_air',
  'minecraft:void_air',
  'minecraft:water',
  'minecraft:light',
  'minecraft:structure_void',
  'minecraft:barrier',
  'minecraft:moving_piston',
  'minecraft:bubble_column',
])

/** Fully resolved per-state geometry for the mesher. */
export interface StateGeometry {
  /** Canonical state string (properties sorted by key). */
  stateKey: string
  quads: Quad[]
  /** Single full-span element (no rotation): occludes neighbor faces. */
  fullCube: boolean
  /** true when assets lack the blockstate or every referenced model —
   * the mesher renders the placeholder cube (quads may still be partial). */
  missing: boolean
  /** Model ids actually resolved (diagnostics). */
  modelIds: string[]
}

/** Shared per-stateKey resolution cache. Keyed by canonical stateKey. */
export const stateGeometryCache = new Map<string, StateGeometry>()

/**
 * Resolve a stateKey to its cached quad templates. Pure with respect to
 * `assets`; `cache` defaults to the shared {@link stateGeometryCache}.
 * Equivalent spellings of one state (property order) share a cache entry.
 */
export function resolveStateGeometry(
  stateKey: string,
  assets: VanillaAssets,
  cache: Map<string, StateGeometry> = stateGeometryCache,
): StateGeometry {
  const canonical = formatState(parseState(stateKey))
  const cached = cache.get(canonical)
  if (cached) return cached

  const state = parseState(canonical)
  let blockstate = assets.blockStates[state.name]
  if (!blockstate) {
    // Version skew: retry once under the current name (grass→short_grass…).
    const alias = LEGACY_STATE_ALIASES[state.name]
    if (alias) blockstate = assets.blockStates[alias]
  }
  const variants: VariantModel[] = blockstate ? resolveBlockstate(state.props, blockstate) : []
  let missing = !blockstate || variants.length === 0

  const quads: Quad[] = []
  const modelIds: string[] = []
  const flattened: FlattenedModel[] = []
  for (const variant of variants) {
    const model = flattenModel(variant.model, assets.blockModels)
    if (!model) {
      missing = true
      continue
    }
    modelIds.push(variant.model)
    flattened.push(model)
    quads.push(...compileGeometry(model, { x: variant.x, y: variant.y }))
  }

  // A resolved model without elements (particle-only) contributes no quads;
  // unless the block is invisible by design, render the placeholder cube
  // instead of leaving an invisible hole (plan §5 P2.4/P3: chests are
  // placeholder cubes until synthesized models exist).
  if (!missing && quads.length === 0 && !ELEMENTLESS_VISIBLE_NEVER.has(state.name)) {
    missing = true
  }

  // A single full-cube model stays a full cube under quarter-turn variant
  // rotations (the centered [0,16]³ span maps onto itself).
  const fullCube = flattened.length === 1 && isFullCube(flattened[0])

  const result: StateGeometry = { stateKey: canonical, quads, fullCube, missing, modelIds }
  cache.set(canonical, result)
  return result
}
