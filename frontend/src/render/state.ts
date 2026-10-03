/**
 * Vanilla blockstate semantics: state-string parsing and
 * blockstate-JSON → model-variant resolution (variants + multipart).
 *
 * Spec: docs/research/shulkr-litematica-viewer-rendering.md §2 — Shulkr
 * meshWorker variant pick (exact → single → best partial subset match),
 * multipart `when` evaluator (implicit AND, nested OR/AND, "a|b" alternation)
 * and apply normalization ({model, x, y, uvlock}, arrays take [0]).
 */

/** A parsed block-state string. */
export interface BlockState {
  /** Block id without properties, e.g. "minecraft:redstone_wire". */
  name: string
  /** Property map, e.g. { east: 'side', power: '7' }. Insertion order kept. */
  props: Record<string, string>
}

/** One model reference produced by blockstate resolution. */
export interface VariantModel {
  model: string
  /** Quarter turns around the block's x axis (applied before y), clockwise
   * seen from the positive axis end — vanilla's rotation convention. */
  x?: number
  /** Quarter turns around the block's y axis (same convention). */
  y?: number
  /** Carried as data; the static preview does not re-derive rotated UVs. */
  uvlock?: boolean
}

/**
 * A `when` condition. A plain property map means implicit AND;
 * values may be "a|b" alternations. { OR: [...] } / { AND: [...] } nest.
 */
export type WhenCondition =
  | { OR: WhenCondition[] }
  | { AND: WhenCondition[] }
  | { [property: string]: string }

export interface MultipartCase {
  when?: WhenCondition
  apply: VariantModel | VariantModel[]
}

/** Verbatim vanilla blockstate file content. */
export interface BlockstateJson {
  variants?: Record<string, VariantModel | VariantModel[]>
  multipart?: MultipartCase[]
}

/** Parse "minecraft:redstone_wire[east=side,power=7]" into name + props. */
export function parseState(stateKey: string): BlockState {
  const key = stateKey.trim()
  const open = key.indexOf('[')
  if (open === -1) return { name: key, props: {} }
  const close = key.lastIndexOf(']')
  const name = key.slice(0, open).trim()
  const props: Record<string, string> = {}
  const body = (close === -1 ? key.slice(open + 1) : key.slice(open + 1, close)).trim()
  if (body) {
    for (const pair of body.split(',')) {
      const eq = pair.indexOf('=')
      if (eq === -1) continue
      const k = pair.slice(0, eq).trim()
      if (k) props[k] = pair.slice(eq + 1).trim()
    }
  }
  return { name, props }
}

/** Canonical state string: name[k=v,...] with properties sorted by key. */
export function formatState(state: BlockState): string {
  const keys = Object.keys(state.props).sort()
  if (!keys.length) return state.name
  return `${state.name}[${keys.map((k) => `${k}=${state.props[k]}`).join(',')}]`
}

/** Parse a variant key "facing=east,half=bottom" into its condition map. */
function parseVariantKey(key: string): Record<string, string> {
  const cond: Record<string, string> = {}
  for (const pair of key.split(',')) {
    const eq = pair.indexOf('=')
    if (eq === -1) continue
    const k = pair.slice(0, eq).trim()
    if (k) cond[k] = pair.slice(eq + 1).trim()
  }
  return cond
}

/** True when every k=v of the condition matches the state (subset match). */
function matchesConditions(cond: Record<string, string>, props: Record<string, string>): boolean {
  for (const [k, v] of Object.entries(cond)) {
    if (props[k] !== v) return false
  }
  return true
}

/** Evaluate a multipart `when` condition against a state's properties. */
export function matchesWhen(cond: WhenCondition, props: Record<string, string>): boolean {
  // Property maps cannot be told apart from {OR}/{AND} by narrowing alone,
  // so inspect the group keys defensively (property names are lowercase in
  // vanilla data, never "OR"/"AND").
  const group = cond as { OR?: unknown; AND?: unknown }
  if (Array.isArray(group.OR)) {
    return (group.OR as WhenCondition[]).some((c) => matchesWhen(c, props))
  }
  if (Array.isArray(group.AND)) {
    return (group.AND as WhenCondition[]).every((c) => matchesWhen(c, props))
  }
  for (const [k, v] of Object.entries(cond)) {
    const actual = props[k]
    if (actual === undefined) return false
    if (!String(v).split('|').includes(actual)) return false
  }
  return true
}

/** Vanilla `apply`/variant arrays are random-weighted choices; a static
 * preview deterministically renders the first entry (no random weighting). */
function firstOf(value: VariantModel | VariantModel[]): VariantModel {
  return Array.isArray(value) ? value[0] : value
}

/**
 * Resolve a state's properties against a blockstate file to the list of
 * model variants to render (variants → one entry; multipart → all matching
 * parts). Tables with no match at all fall back to their first entry, so
 * property-less states (schema-1 bare ids) still resolve a default shape
 * instead of the placeholder.
 */
export function resolveBlockstate(
  props: Record<string, string>,
  json: BlockstateJson,
): VariantModel[] {
  if (json.variants) return pickVariant(props, json.variants)
  if (json.multipart) {
    const out: VariantModel[] = []
    for (const part of json.multipart) {
      if (part.when !== undefined && !matchesWhen(part.when, props)) continue
      out.push(firstOf(part.apply))
    }
    // Zero matches happens only for property-less states (schema-1 bare
    // ids) against fully-conditioned multiparts (26.x redstone_wire even
    // conditions its dot): apply the first part as the default shape,
    // mirroring the variant-table fallback above.
    if (!out.length && json.multipart.length) out.push(firstOf(json.multipart[0].apply))
    return out
  }
  return []
}

function pickVariant(
  props: Record<string, string>,
  variants: Record<string, VariantModel | VariantModel[]>,
): VariantModel[] {
  const entries = Object.entries(variants).map(([key, value]) => ({
    cond: parseVariantKey(key),
    model: firstOf(value),
  }))
  if (!entries.length) return []
  // Union of every property the file constrains ("relevant" properties).
  const relevant = new Set(entries.flatMap((e) => Object.keys(e.cond)))

  // 1. Exact: the variant constrains every relevant property and all match.
  const exact = entries.find(
    (e) => Object.keys(e.cond).length === relevant.size && matchesConditions(e.cond, props),
  )
  if (exact) return [exact.model]

  // 2. Single variant: lenient fallback when the state lacks the properties.
  if (entries.length === 1) return [entries[0].model]

  // 3. Best partial subset match: most matched properties wins, first on tie.
  let best: (typeof entries)[number] | undefined
  for (const e of entries) {
    if (!matchesConditions(e.cond, props)) continue
    if (!best || Object.keys(e.cond).length > Object.keys(best.cond).length) best = e
  }
  // 4. No match at all — e.g. a schema-1 bare block id resolved against a
  // fully-conditioned variant table (stairs/logs/slabs/snow): fall back to
  // the first variant so property-less states render the default-ish shape
  // instead of the placeholder (plan §5 P1.1 schema-1 tolerance).
  return [best?.model ?? entries[0].model]
}
