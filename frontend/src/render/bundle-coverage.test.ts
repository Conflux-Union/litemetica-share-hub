/**
 * Permanent regression audit of the render bundle (data/textures/
 * bundle.json.gz): which blockstate families would render as the purple
 * placeholder cube. Mirrors the two production gates:
 *
 *   - model.ts resolveStateGeometry marks a state missing when its
 *     blockstate is absent, no variant matches, every referenced model
 *     fails to flatten, or every flattened model contributes zero quads
 *     (element-less particle-only models — vanilla renders those blocks
 *     from block entities: chests, shulker boxes, banners, heads, …);
 *   - surface.ts renderSurface tints quads flat MAGENTA when their
 *     texture has no atlas tile (resolveTexture, namespace-tolerant), so
 *     a face texture that resolves outside the atlas is a placeholder.
 *
 * The audit walks the real parsing layers (normalizeBlockStates,
 * normalizeModel, flattenModel) so it cannot drift from the renderer.
 * It is stricter than a single-state resolve on purpose: every model
 * reference of a blockstate entry is visited (all variant values — not
 * just the first random-weighted pick — and all multipart applies), and
 * an entry is red only when EVERY referenced chain is element-less or
 * unresolvable, or when any rendered face misses the atlas.
 */

/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gunzipSync } from 'fflate'
import type { AssetBundle } from '../types'
import { normalizeBlockStates, normalizeModel } from './assets'
import { flattenModel } from './model'
import type { BlockstateJson, ModelJson, VariantModel } from './model'

// Repo-root bundle output, three levels up from frontend/src/render/.
const BUNDLE_PATH = fileURLToPath(new URL('../../../data/textures/bundle.json.gz', import.meta.url))
const bundleAvailable = existsSync(BUNDLE_PATH)
if (!bundleAvailable) {
  console.info(
    `[bundle-coverage] skipping all tests: ${BUNDLE_PATH} does not exist. ` +
      'Regenerate it with: backend/target/debug/litemetica-share-hub ' +
      'extract-textures --jar data/client.jar',
  )
}

/**
 * Keep in sync with ELEMENTLESS_VISIBLE_NEVER in ./model.ts (the const is
 * deliberately not exported): blocks whose element-less models are by
 * design — the mesher synthesizes water, the rest never render in-world.
 * Everything else element-less becomes the placeholder and must show up
 * as a red family below. Do not grow this list to silence failures.
 */
const INVISIBLE_BY_DESIGN = new Set([
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

/** Vanilla dye colors, used to merge dyed families (shulker boxes,
 * banners) into one family id for the failure report. */
const DYE_COLORS = [
  'white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black',
] as const

/**
 * Family id of a blockstate state name. Families are blocks sharing one
 * synthesis fix: dyed shulker boxes, standing+wall banners, mob
 * heads/skulls, and copper golem statues across oxidation/wax states.
 * Unknown blocks stay their own family. Extend the rules as new families
 * get synthesized — never merge blocks that need different fixes.
 */
function familyOf(stateName: string): string {
  const name = stateName.replace(/^minecraft:/, '')
  for (const color of DYE_COLORS) {
    if (name === `${color}_banner` || name === `${color}_wall_banner`) return 'minecraft:banner'
    if (name === `${color}_shulker_box`) return 'minecraft:shulker_box'
  }
  if (
    /^(creeper|dragon|piglin|player|wither_skeleton|skeleton|zombie)(_wall_|_)(head|skull)$/.test(name)
  ) {
    return 'minecraft:head'
  }
  if (/^(waxed_)?(exposed_|weathered_|oxidized_)?copper_golem_statue$/.test(name)) {
    return 'minecraft:copper_golem_statue'
  }
  return `minecraft:${name}`
}

/** One red blockstate entry with its referenced models and causes. */
interface RedEntry {
  /** Verbatim bundle.blockStates key, e.g. "minecraft:block/white_banner". */
  id: string
  /** Unique model ids referenced by the entry (all variants + multiparts). */
  models: string[]
  reasons: string[]
}

/** Every model reference of a blockstate JSON: all variant values and all
 * multipart applies, arrays included (the renderer picks only the first
 * of a random-weighted array; the audit checks them all). */
function collectRefs(json: BlockstateJson): VariantModel[] {
  const out: VariantModel[] = []
  for (const value of Object.values(json.variants ?? {})) {
    if (Array.isArray(value)) out.push(...value)
    else out.push(value)
  }
  for (const part of json.multipart ?? []) {
    if (Array.isArray(part.apply)) out.push(...part.apply)
    else out.push(part.apply)
  }
  return out
}

function loadBundle(): AssetBundle | null {
  if (!bundleAvailable) return null
  const gz = readFileSync(BUNDLE_PATH)
  return JSON.parse(new TextDecoder().decode(gunzipSync(gz))) as AssetBundle
}

const suite = bundleAvailable ? describe : describe.skip
suite('render bundle placeholder coverage', () => {
  const bundle = loadBundle()
  if (!bundle) return // unreachable: the suite is skipped when absent

  // The production asset surface: blockstates re-keyed to state names,
  // model texture values sprite-unwrapped (assets.ts fetchAssets path).
  const { blockStates: rawStates, blockModels: rawModels, textures } = bundle
  const states = normalizeBlockStates(rawStates as Record<string, BlockstateJson>)
  const models: Record<string, ModelJson> = Object.fromEntries(
    Object.entries(rawModels).map(([id, model]) => [id, normalizeModel(model)]),
  )

  /** Atlas membership with the mesher's namespace tolerance (surface.ts
   * resolveTexture): 26.x models carry bare ids ("block/snow") while
   * atlas keys are namespaced ("minecraft:block/snow"). */
  const inAtlas = (id: string): boolean =>
    id in textures || (!id.includes(':') && `minecraft:${id}` in textures)

  /** Audit every blockstate entry; red families keyed by family id. */
  function auditBlockstates(): Map<string, RedEntry[]> {
    const families = new Map<string, RedEntry[]>()
    for (const key of Object.keys(rawStates)) {
      const stateName = key.replace(/^([^:]+):block\//, '$1:')
      if (INVISIBLE_BY_DESIGN.has(stateName)) continue
      const json = states[key]
      if (!json) continue // normalizeBlockStates keeps raw keys verbatim

      const refs = collectRefs(json)
      const reasons: string[] = []
      const emptyChains: string[] = []
      const missingTextures = new Set<string>()
      for (const ref of refs) {
        const flat = flattenModel(ref.model, models)
        if (!flat) {
          emptyChains.push(`${ref.model} (unresolvable)`)
          continue
        }
        if (flat.elements.length === 0) {
          emptyChains.push(`${ref.model} (element-less)`)
          continue
        }
        // Only rendered faces count: a face keeps an unresolvable "#ref"
        // verbatim (geometry.ts resolveFaceTexture), and a literal id the
        // atlas lacks renders flat MAGENTA (surface.ts).
        for (const element of flat.elements) {
          for (const face of Object.values(element.faces)) {
            if (!face) continue
            if (face.texture.startsWith('#')) missingTextures.add(`unresolved ref ${face.texture}`)
            else if (!inAtlas(face.texture)) missingTextures.add(face.texture)
          }
        }
      }
      if (refs.length === 0) reasons.push('no model references')
      if (refs.length > 0 && emptyChains.length === refs.length) {
        reasons.push(`all model chains element-less or unresolvable: ${[...new Set(emptyChains)].join(', ')}`)
      }
      if (missingTextures.size > 0) {
        reasons.push(`face textures missing from the atlas: ${[...missingTextures].sort().join(', ')}`)
      }
      if (reasons.length === 0) continue

      const entry: RedEntry = { id: key, models: [...new Set(refs.map((r) => r.model))], reasons }
      const family = familyOf(stateName)
      const members = families.get(family) ?? []
      members.push(entry)
      families.set(family, members)
    }
    return families
  }

  /** Grouped, deterministic failure report: one block per family, one
   * line set per member (id, referenced models, reasons). */
  function formatReport(families: Map<string, RedEntry[]>): string {
    const lines: string[] = []
    for (const [family, entries] of [...families.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`family ${family} — ${entries.length} blockstate entries`)
      for (const entry of entries.sort((a, b) => a.id.localeCompare(b.id))) {
        lines.push(`  ${entry.id}`)
        lines.push(`    models: ${entry.models.length ? entry.models.join(', ') : '(none)'}`)
        for (const reason of entry.reasons) lines.push(`    reason: ${reason}`)
      }
    }
    return lines.join('\n')
  }

  it('loads a usable bundle', () => {
    expect(bundle.formatVersion).toBe(3)
    expect(Object.keys(rawStates).length).toBeGreaterThan(0)
    expect(Object.keys(rawModels).length).toBeGreaterThan(0)
    expect(Object.keys(textures).length).toBeGreaterThan(0)
    // Material items that vanilla shows as sprites must carry item models.
    expect(Object.keys(bundle.itemModels ?? {}).length).toBeGreaterThan(100)
    expect(bundle.itemModels).toHaveProperty('minecraft:item/redstone')
  })

  it('renders every blockstate family with real geometry (no purple placeholders)', () => {
    const families = auditBlockstates()
    const report = formatReport(families)
    if (report) console.warn(`placeholder families in the bundle:\n${report}`)
    expect(report).toBe('')
  })

  it('resolves every model texture id against the atlas', () => {
    // Model-level bundle integrity: every literal texture id referenced
    // by any bundled model (parents merged via flattenModel, particles
    // included) must have an atlas tile. "#refs" left unresolved by a
    // model alone are fine — template models (cube_all, orientable, …)
    // define them for children to override, and the blockstate audit
    // above flags them when they reach a rendered face.
    // minecraft:missingno is vanilla's designated missing-texture marker
    // and is intentionally not atlased (assets.ts tileTransform treats
    // it as absent → placeholder), so it is excepted here.
    const failures: string[] = []
    for (const id of Object.keys(models)) {
      const flat = flattenModel(id, models)
      if (!flat) {
        failures.push(`${id}: model unresolvable`)
        continue
      }
      for (const value of Object.values(flat.textures)) {
        if (value.startsWith('#')) continue
        if (value === 'minecraft:missingno') continue
        if (!inAtlas(value)) failures.push(`${id}: texture ${value} not in atlas`)
      }
    }
    if (failures.length) console.warn(`texture gaps:\n${failures.join('\n')}`)
    expect(failures.join('\n')).toBe('')
  })
})
