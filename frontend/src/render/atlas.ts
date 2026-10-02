import * as THREE from 'three'
import type { TextureManifest } from '../types'
import type { UvResolver } from './surface'

export interface AtlasBundle {
  texture: THREE.Texture
  manifest: TextureManifest
  resolveUv: UvResolver
}

let cached: Promise<AtlasBundle | null> | null = null

/** Load the backend-extracted vanilla atlas, or null when none exists. */
export function loadAtlas(): Promise<AtlasBundle | null> {
  cached ??= (async () => {
    let manifest: TextureManifest
    try {
      const resp = await fetch('/api/textures/manifest')
      if (!resp.ok) return null
      manifest = (await resp.json()) as TextureManifest
    } catch {
      return null
    }

    const texture = await new Promise<THREE.Texture>((resolve, reject) => {
      new THREE.TextureLoader().load(`/api/textures/${manifest.atlas}`, resolve, undefined, reject)
    })
    texture.magFilter = THREE.NearestFilter
    texture.minFilter = THREE.NearestFilter
    texture.generateMipmaps = false
    texture.colorSpace = THREE.SRGBColorSpace

    const grid = manifest.grid
    const ts = 1 / grid
    // Half-texel inset avoids bleeding between neighbouring tiles.
    const inset = 0.5 / (grid * manifest.tile)

    const cache = new Map<string, [number, number, number, number]>()
    const tileUv = (col: number, row: number): [number, number, number, number] => {
      // THREE flipY: row 0 is at the top of the image, v grows upwards.
      const v1 = 1 - row * ts - inset
      const v0 = 1 - (row + 1) * ts + inset
      return [col * ts + inset, v0, (col + 1) * ts - inset, v1]
    }

    const resolveUv: UvResolver = (blockId, face) => {
      const entry = manifest.blocks[blockId]
      if (!entry) return null
      const faceIdx = face === 'top' ? 0 : face === 'side' ? 1 : 2
      const key = `${blockId}:${faceIdx}`
      let uv = cache.get(key)
      if (!uv) {
        uv = tileUv(entry.uv[faceIdx][0], entry.uv[faceIdx][1])
        cache.set(key, uv)
      }
      return uv
    }

    return { texture, manifest, resolveUv }
  })()
  return cached
}
