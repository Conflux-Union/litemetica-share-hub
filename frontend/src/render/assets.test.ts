import { describe, expect, it } from 'vitest'
import type { AssetBundle } from '../types'
import {
  buildTileTransforms,
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
