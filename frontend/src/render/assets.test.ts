import { describe, expect, it } from 'vitest'
import type { AssetBundle } from '../types'
import {
  buildTileTransforms,
  computeAtlasUv,
  makeLookups,
  normalizeBlockStates,
  normalizeModel,
} from './assets'
import { resolveStateGeometry, type BlockstateJson, type VanillaAssets } from './model'

describe('normalizeBlockStates', () => {
  it('maps "minecraft:block/<name>" keys to state-name keys', () => {
    const states = normalizeBlockStates({
      'minecraft:block/redstone_wire': { multipart: [] },
      'minecraft:block/stone': { variants: { '': { model: 'minecraft:block/stone' } } },
    })
    expect(states['minecraft:redstone_wire']).toBeDefined()
    expect(states['minecraft:stone']).toBeDefined()
  })

  it('keeps the original bundle keys alongside the mapped ones', () => {
    const states = normalizeBlockStates({
      'minecraft:block/stone': { variants: { '': { model: 'minecraft:block/stone' } } },
    })
    expect(states['minecraft:block/stone']).toBeDefined()
    expect(states['minecraft:stone']).toBe(states['minecraft:block/stone'])
  })
})

describe('normalizeModel', () => {
  it('unwraps sprite objects and keeps string textures as-is', () => {
    const model = normalizeModel({
      parent: 'minecraft:block/cube_all',
      textures: {
        all: 'minecraft:block/redstone_dust_line0',
        line: { sprite: 'block/redstone_dust_line0', force_translucent: true },
        overlay: { sprite: '#line' },
      },
    })
    expect(model.textures).toEqual({
      all: 'minecraft:block/redstone_dust_line0',
      line: 'block/redstone_dust_line0',
      overlay: '#line',
    })
  })

  it('passes models without textures through', () => {
    const model = normalizeModel({ parent: 'minecraft:block/block' })
    expect(model.parent).toBe('minecraft:block/block')
    expect(model.textures).toBeUndefined()
  })
})

describe('buildTileTransforms', () => {
  // 2x2 grid of 16px tiles: tile (1,0) sits on the top-right quadrant.
  const bundle = {
    formatVersion: 2,
    minecraftVersion: 'test',
    atlas: 'atlas-00000000.png',
    grid: 2,
    tile: 16,
    blockStates: {},
    blockModels: {},
    textures: {
      'minecraft:block/stone': { uv: [1, 0], alpha: 'opaque' },
      'minecraft:block/glass': { uv: [0, 1], alpha: 'translucent' },
    },
    tintColors: {},
  } as unknown as AssetBundle

  it('maps 0..16 model uv into the tile with a half-texel inset', () => {
    const transforms = buildTileTransforms(bundle)
    const stone = transforms.get('minecraft:block/stone')!
    const inset = 0.5 / 32
    expect(stone.u0).toBeCloseTo(0.5 + inset, 12)
    expect(stone.u0 + 16 * stone.du).toBeCloseTo(1 - inset, 12)
    // flipY: row 0 is at the top of the image; model v grows downward.
    expect(stone.v0).toBeCloseTo(1 - inset, 12)
    expect(stone.v0 + 16 * stone.dv).toBeCloseTo(0.5 + inset, 12)
    expect(stone.dv).toBeLessThan(0)
  })

  it('returns nothing for textures absent from the atlas', () => {
    const transforms = buildTileTransforms(bundle)
    expect(transforms.get('minecraft:missingno')).toBeUndefined()
  })
})

describe('makeLookups (namespace-tolerant bundle lookups)', () => {
  // 26.x model files mix namespaced and bare texture references; atlas
  // keys are always namespaced (repeater/comparator/brewing-stand family).
  const bundle = {
    formatVersion: 2,
    minecraftVersion: 'test',
    atlas: 'atlas-00000000.png',
    grid: 2,
    tile: 16,
    blockStates: {},
    blockModels: {},
    textures: {
      'minecraft:block/stone': { uv: [1, 0], alpha: 'opaque' },
      'minecraft:block/glass': { uv: [0, 1], alpha: 'translucent' },
    },
    tintColors: {},
  } as unknown as AssetBundle

  it('resolves bare texture ids to their namespaced atlas entries', () => {
    const { tileTransform, alphaClass } = makeLookups(bundle)
    expect(tileTransform('block/stone')).toEqual(tileTransform('minecraft:block/stone'))
    expect(tileTransform('block/stone')).not.toBeNull()
    expect(alphaClass('block/glass')).toBe('translucent')
  })

  it('keeps namespaced ids and reports unknown textures as absent/opaque', () => {
    const { tileTransform, alphaClass } = makeLookups(bundle)
    expect(tileTransform('minecraft:block/stone')).not.toBeNull()
    expect(tileTransform('minecraft:missingno')).toBeNull()
    expect(tileTransform('missingno:block/stone')).toBeNull()
    expect(alphaClass('minecraft:missingno')).toBe('opaque')
  })
})

describe('normalized assets feed resolveStateGeometry', () => {
  it('resolves quads with unwrapped sprite textures and mapped state keys', () => {
    const blockStates = normalizeBlockStates({
      'minecraft:block/stone': {
        variants: { '': { model: 'minecraft:block/stone' } },
      } as BlockstateJson,
    })
    const assets: VanillaAssets = {
      blockStates,
      blockModels: {
        'minecraft:block/stone': normalizeModel({
          parent: 'minecraft:block/cube_all',
          textures: { all: { sprite: 'minecraft:block/stone' } },
          elements: [
            {
              from: [0, 0, 0],
              to: [16, 16, 16],
              faces: {
                up: { texture: '#all', cullface: 'up' },
                down: { texture: '#all', cullface: 'down' },
                north: { texture: '#all', cullface: 'north' },
                south: { texture: '#all', cullface: 'south' },
                west: { texture: '#all', cullface: 'west' },
                east: { texture: '#all', cullface: 'east' },
              },
            },
          ],
        }),
      },
    }
    const geo = resolveStateGeometry('minecraft:stone', assets, new Map())
    expect(geo.missing).toBe(false)
    expect(geo.fullCube).toBe(true)
    expect(geo.quads).toHaveLength(6)
    // The sprite object must have resolved to the literal texture id.
    expect(geo.quads.every((q) => q.texture === 'minecraft:block/stone')).toBe(true)
  })
})

describe('computeAtlasUv (tiled-uv parity with the affine tile transform)', () => {
  // Same fixture shape surface.test.ts uses: one tile spanning the atlas
  // quadrant [0.25,0.75] × [0.75,0.25].
  const TILE = { u0: 0.25, du: 0.5 / 16, v0: 0.75, dv: -0.5 / 16 }
  const span = TILE.du * 16
  const oldU = (modelU: number): number => TILE.u0 + TILE.du * modelU
  const oldV = (modelV: number): number => TILE.v0 + TILE.dv * modelV

  /** 0 and 16 are tile boundaries (≤1e-3), 8 is interior (≤1e-4), and
   * 32.5 wraps past one tile so it compares against the wrapped old
   * formula (32.5 mod 16 = 0.5, boundary tolerance). */
  const cases: { t: number; tol: number; wrap: boolean }[] = [
    { t: 0, tol: 1e-3, wrap: false },
    { t: 8, tol: 1e-4, wrap: false },
    { t: 16, tol: 1e-3, wrap: false },
    { t: 32.5, tol: 1e-3, wrap: true },
  ]

  it('stays within the old affine mapping inside one tile and wraps cleanly past it', () => {
    for (const { t, tol, wrap } of cases) {
      const oldT = wrap ? t % 16 : t
      const [u, v] = computeAtlasUv(TILE, [t, t], span)
      expect(Math.abs(u - oldU(oldT))).toBeLessThanOrEqual(tol)
      expect(Math.abs(v - oldV(oldT))).toBeLessThanOrEqual(tol)
    }
  })

  it('samples one texel inside the tile edge at the wrap seam', () => {
    // Exactly on a block boundary the wrapped coordinate sits just below
    // 1.0 of the tile span, never on the neighboring tile's first texel.
    const [u] = computeAtlasUv(TILE, [16, 16], span)
    expect(u).toBeLessThan(TILE.u0 + span)
    expect(u).toBeGreaterThan(TILE.u0 + span - 1 / 128)
  })
})
