/**
 * Per-face block tinting (plan §5 P2.3): redstone power ramp, biome
 * grass/foliage colors, water constant and stem age ramp.
 *
 * Semantics (research §3): a face is tinted only when its model declared
 * `tintindex >= 0`; the mesher passes the quad's tintindex through, and
 * every branch below is behind that gate. Water quads are synthesized by
 * the mesher and must carry `tintindex: 0` to receive the water color.
 */

export type Rgb = [number, number, number]

export interface TintPalette {
  grass: Rgb
  foliage: Rgb
}

/** Built-in defaults equal the bundle's sampled colormap center pixels
 * (grass [124,189,108], foliage [91,171,71] — plains), so tints look
 * right even before (or without) the bundle. */
export const DEFAULT_TINT_COLORS: TintPalette = {
  grass: [124 / 255, 189 / 255, 108 / 255],
  foliage: [91 / 255, 171 / 255, 71 / 255],
}

let palette: TintPalette = DEFAULT_TINT_COLORS

/** Install bundle-provided biome colors (0..1 rgb); called by loadAssets. */
export function setTintColors(colors: Partial<TintPalette>): void {
  palette = { ...palette, ...colors }
}

/** Restore the built-in defaults. */
export function resetTintColors(): void {
  palette = DEFAULT_TINT_COLORS
}

/** Vanilla constant foliage colors: spruce 0x619961, birch 0x80a755
 * (biome colormaps do not apply to these leaves). */
const SPRUCE_LEAVES_COLOR: Rgb = [0x61 / 255, 0x99 / 255, 0x61 / 255]
const BIRCH_LEAVES_COLOR: Rgb = [0x80 / 255, 0xa7 / 255, 0x55 / 255]

/** Water and waterlogged faces share one constant blue, as in vanilla. */
const WATER_COLOR: Rgb = [0.24, 0.46, 0.89]

/** Blocks tinted with the grass colormap (top faces via tintindex 0). */
const GRASS_TINTED = new Set([
  'minecraft:grass_block',
  'minecraft:short_grass',
  'minecraft:grass', // pre-1.20.3 alias for short_grass
  'minecraft:tall_grass',
  'minecraft:fern',
  'minecraft:large_fern',
  'minecraft:sugar_cane',
  'minecraft:pink_petals',
  'minecraft:moss_block',
])

/** Crop stems: attached variants carry no age property and read as mature. */
const STEM_BLOCKS = new Set([
  'minecraft:pumpkin_stem',
  'minecraft:attached_pumpkin_stem',
  'minecraft:melon_stem',
  'minecraft:attached_melon_stem',
])

/** Young stems are green, mature (age 7) ones orange; linear lerp of the
 * two endpoints approximates vanilla's age-based gradient. */
const STEM_YOUNG: Rgb = [0.42, 0.73, 0.24]
const STEM_MATURE: Rgb = [0.97, 0.64, 0.12]

/** Redstone wire tint from the `power` property. Vanilla RedstoneWireBlock:
 * r = (power/15) * 0.6 + 0.4, with power 0 additionally dimmed ×0.3 (dark
 * red); green/blue stay 0 (research §3 power ramp, 16 entries). */
function redstoneColor(power: string | undefined): Rgb {
  const p = clampInt(power, 0, 15)
  return [p === 0 ? 0.4 * 0.3 : (p / 15) * 0.6 + 0.4, 0, 0]
}

function stemColor(age: string | undefined): Rgb {
  const t = age === undefined ? 1 : clampInt(age, 0, 7) / 7
  return [
    STEM_YOUNG[0] + (STEM_MATURE[0] - STEM_YOUNG[0]) * t,
    STEM_YOUNG[1] + (STEM_MATURE[1] - STEM_YOUNG[1]) * t,
    STEM_YOUNG[2] + (STEM_MATURE[2] - STEM_YOUNG[2]) * t,
  ]
}

function clampInt(value: string | undefined, min: number, max: number): number {
  const n = parseInt(value ?? '', 10)
  if (Number.isNaN(n)) return min
  return Math.min(Math.max(n, min), max)
}

/**
 * Resolve the tint color for one block-state face. Returns 0..1 rgb, or
 * null when the face is untinted (no `tintindex >= 0`, or a block family
 * without a tint).
 */
export function resolveTint(
  name: string,
  props: Record<string, string>,
  tintindex: number | undefined,
): Rgb | null {
  if (tintindex === undefined || tintindex < 0) return null

  if (name === 'minecraft:redstone_wire') return redstoneColor(props.power)
  if (name === 'minecraft:water' || props.waterlogged === 'true') return WATER_COLOR
  if (STEM_BLOCKS.has(name)) return stemColor(props.age)
  if (name === 'minecraft:spruce_leaves') return SPRUCE_LEAVES_COLOR
  if (name === 'minecraft:birch_leaves') return BIRCH_LEAVES_COLOR
  if (name === 'minecraft:vine' || name.endsWith('_leaves')) return palette.foliage
  if (GRASS_TINTED.has(name)) return palette.grass
  return null
}
