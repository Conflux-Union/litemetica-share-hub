/**
 * Pure-module tests for render/bundle: the three-free bundle derivations
 * the mesh worker shares with the main-thread loader (assets.ts keeps
 * re-export coverage in assets.test.ts).
 */
import { describe, expect, it } from 'vitest'
import type { AssetBundle } from '../types'
import {
  buildVanillaAssets,
  bundleTintColors,
  makeLookups,
  resolveTextureId,
  surfaceAssetsFromBundle,
} from './bundle'
import { resolveStateGeometry } from './model'
import { DEFAULT_TINT_COLORS } from './tint'

function fixtureBundle(): AssetBundle {
  return {
    formatVersion: 2,
    minecraftVersion: 'test',
    atlas: 'atlas-00000000.png',
    grid: 2,
    tile: 16,
    blockStates: {
      'minecraft:block/stone': {
        variants: { '': { model: 'minecraft:block/stone' } },
      },
    },
    blockModels: {
      'minecraft:block/stone': {
        textures: { all: { sprite: 'minecraft:block/stone' } },
      },
    },
    itemModels: {
      'minecraft:redstone': { textures: { layer0: 'item/redstone' } },
    },
    textures: {
      'minecraft:block/stone': { uv: [1, 0], alpha: 'opaque' },
      'minecraft:block/glass': { uv: [0, 1], alpha: 'translucent' },
    },
    tintColors: { grass: [124, 189, 108] },
  }
}

describe('resolveTextureId (namespace tolerance)', () => {
  it('qualifies bare ids and passes namespaced ones through', () => {
    const bundle = fixtureBundle()
    expect(resolveTextureId(bundle, 'block/stone')).toBe('minecraft:block/stone')
    expect(resolveTextureId(bundle, 'minecraft:block/stone')).toBe('minecraft:block/stone')
    // Namespaced but absent: kept verbatim (caller reports it missing).
    expect(resolveTextureId(bundle, 'missingno:block/stone')).toBe('missingno:block/stone')
  })
})

describe('makeLookups', () => {
  it('resolves bare ids to their atlas tile and alpha class', () => {
    const { tileTransform, alphaClass } = makeLookups(fixtureBundle())
    expect(tileTransform('block/stone')).toEqual(tileTransform('minecraft:block/stone'))
    expect(tileTransform('block/stone')).not.toBeNull()
    expect(alphaClass('block/glass')).toBe('translucent')
  })

  it('reports unknown textures as absent / opaque', () => {
    const { tileTransform, alphaClass } = makeLookups(fixtureBundle())
    expect(tileTransform('minecraft:missingno')).toBeNull()
    expect(alphaClass('minecraft:missingno')).toBe('opaque')
  })
})

describe('buildVanillaAssets', () => {
  it('re-keys blockstates to state names and keeps the bundle keys', () => {
    const assets = buildVanillaAssets(fixtureBundle())
    expect(assets.blockStates['minecraft:stone']).toBeDefined()
    expect(assets.blockStates['minecraft:block/stone']).toBe(assets.blockStates['minecraft:stone'])
  })

  it('merges block and item models with sprite textures unwrapped', () => {
    const assets = buildVanillaAssets(fixtureBundle())
    expect(assets.blockModels['minecraft:block/stone']).toBeDefined()
    expect(assets.blockModels['minecraft:redstone']).toBeDefined()
    expect(assets.blockModels['minecraft:block/stone'].textures?.all).toBe('minecraft:block/stone')
    expect(assets.blockModels['minecraft:redstone'].textures?.layer0).toBe('item/redstone')
  })
})

describe('bundleTintColors', () => {
  it('scales bundle colormap samples to 0..1 and defaults the rest', () => {
    const colors = bundleTintColors(fixtureBundle())
    expect(colors.grass).toEqual([124 / 255, 189 / 255, 108 / 255])
    expect(colors.foliage).toEqual(DEFAULT_TINT_COLORS.foliage)
  })

  it('falls back to the built-in palette when the bundle omits samples', () => {
    const bundle = fixtureBundle()
    bundle.tintColors = {}
    expect(bundleTintColors(bundle)).toEqual(DEFAULT_TINT_COLORS)
  })
})

describe('surfaceAssetsFromBundle (mesher input without three.js)', () => {
  it('feeds resolveStateGeometry end-to-end', () => {
    const bundle = fixtureBundle()
    // Give the model real cube geometry so the resolver finds quads.
    bundle.blockModels['minecraft:block/stone'] = {
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
    }
    const surface = surfaceAssetsFromBundle(bundle)
    const geo = resolveStateGeometry('minecraft:stone', surface.assets, new Map())
    expect(geo.missing).toBe(false)
    expect(geo.quads).toHaveLength(6)
    expect(geo.quads.every((q) => q.texture === 'minecraft:block/stone')).toBe(true)
    expect(surface.tileTransform('minecraft:block/stone')).not.toBeNull()
    expect(surface.alphaClass('minecraft:block/stone')).toBe('opaque')
  })
})
