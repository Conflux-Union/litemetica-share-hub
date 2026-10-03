import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { AssetBundle } from '../types'
import {
  buildTileTransforms,
  normalizeBlockStates,
  normalizeModel,
  stateTexture,
  type AssetStore,
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

describe('stateTexture (representative texture per state)', () => {
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

  const assets: VanillaAssets = {
    blockStates: normalizeBlockStates({
      'minecraft:block/stone': { variants: { '': { model: 'minecraft:block/stone' } } },
      'minecraft:block/glass_block': { variants: { '': { model: 'minecraft:block/glass_block' } } },
      'minecraft:block/flat': { variants: { '': { model: 'minecraft:block/flat' } } },
      // Vanilla stairs shape: every variant conditioned on properties.
      'minecraft:block/stairs_multi': {
        variants: {
          'facing=east,half=bottom,shape=straight': { model: 'minecraft:block/stairs_multi' },
          'facing=north,half=bottom,shape=straight': {
            model: 'minecraft:block/stairs_multi',
            y: 270,
          },
        },
      } as BlockstateJson,
    } as Record<string, BlockstateJson>),
    blockModels: {
      'minecraft:block/stone': normalizeModel({
        textures: { all: 'minecraft:block/stone' },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              up: { texture: '#all' },
              down: { texture: '#all' },
              north: { texture: '#all' },
              south: { texture: '#all' },
              west: { texture: '#all' },
              east: { texture: '#all' },
            },
          },
        ],
      }),
      // Top face stone, sides glass: face preference must discriminate.
      'minecraft:block/glass_block': normalizeModel({
        textures: { top: 'minecraft:block/stone', side: 'minecraft:block/glass' },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 16, 16],
            faces: {
              up: { texture: '#top' },
              north: { texture: '#side' },
              south: { texture: '#side' },
            },
          },
        ],
      }),
      // Only an up-facing quad (dust-like): side falls back to it.
      'minecraft:block/flat': normalizeModel({
        textures: { line: 'minecraft:block/stone' },
        elements: [
          {
            from: [0, 0, 6],
            to: [16, 2, 10],
            faces: { up: { texture: '#line' } },
          },
        ],
      }),
      // Material-table icon input is a bare id; conditioned variant tables
      // must still resolve a shape (first-variant fallback).
      'minecraft:block/stairs_multi': normalizeModel({
        textures: { all: 'minecraft:block/stone' },
        elements: [
          {
            from: [0, 0, 0],
            to: [16, 8, 16],
            faces: { up: { texture: '#all' }, north: { texture: '#all' } },
          },
        ],
      }),
    },
  }

  const transforms = buildTileTransforms(bundle)
  const store: AssetStore = {
    bundle,
    texture: {} as THREE.Texture,
    assets,
    tileTransform: (id) => transforms.get(id) ?? null,
    alphaClass: (id) => bundle.textures[id]?.alpha ?? 'opaque',
    tintColors: { grass: [0, 0, 0], foliage: [0, 0, 0] },
  }

  it('prefers the quad matching the requested face slot', () => {
    expect(stateTexture(store, 'minecraft:glass_block', 'top')).toBe('minecraft:block/stone')
    expect(stateTexture(store, 'minecraft:glass_block', 'side')).toBe('minecraft:block/glass')
    expect(stateTexture(store, 'minecraft:stone[anything=1]', 'bottom')).toBe(
      'minecraft:block/stone',
    )
  })

  it('falls back to any atlas-backed quad for flat blocks', () => {
    expect(stateTexture(store, 'minecraft:flat', 'side')).toBe('minecraft:block/stone')
  })

  it('resolves bare ids of multi-variant blocks to the first variant (material icons)', () => {
    // The backend material list always reports property-less ids; stairs
    // and friends must still produce an icon texture, not null.
    expect(stateTexture(store, 'minecraft:stairs_multi', 'side')).toBe('minecraft:block/stone')
  })

  it('returns null for states without a resolvable texture', () => {
    expect(stateTexture(store, 'minecraft:unknown_block', 'side')).toBeNull()
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
