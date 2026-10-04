/**
 * Bridge-scale preview payloads (frontend/public/bridge.bin and
 * stress.bin, written by backend/examples/gen_smoke_fixture.rs): decode
 * plus extractSurface must complete and stay far below the quad budget.
 * stress.bin is the 566x256x1423 shape that used to OOM browser tabs.
 *
 * The files are untracked dev fixtures; like bundle-coverage.test.ts the
 * suite skips when they are absent.
 */

/// <reference types="node" />
import { gunzipSync } from 'fflate'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AssetBundle } from '../types'
import { surfaceAssetsFromBundle } from './bundle'
import { decodePreview } from './decode'
import { BOX_NOTICE, runMeshPipeline } from './meshWorker'
import { extractSurface, MeshBudgetError } from './surface'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../public/${name}`, import.meta.url))

const dataBundle = fileURLToPath(new URL('../../../data/textures/bundle.json.gz', import.meta.url))

const bridgeAvailable = existsSync(fixture('bridge.bin'))
const stressAvailable = existsSync(fixture('stress.bin'))
const bundleAvailable = existsSync(dataBundle)
if (!bridgeAvailable || !stressAvailable) {
  console.info(
    '[bridge] skipping missing fixtures: regenerate with ' +
      'cargo run --manifest-path backend/Cargo.toml --example gen_smoke_fixture ' +
      '-- --bridge PATH.litematic | --stress',
  )
}

const bridgeSuite = bridgeAvailable ? describe : describe.skip
bridgeSuite('bridge-scale preview payload', () => {
  it(
    'decodes and meshes the bridge fixture within the quad budget (flat fallback)',
    () => {
      // No-bundle path: every state is a mergeable cube, ~2.34M quads.
      // The real browser path (with the texture bundle) is covered below —
      // do not anchor budgets on this number alone.
      const grid = decodePreview(new Uint8Array(readFileSync(fixture('bridge.bin'))))
      const mesh = extractSurface(grid, null)
      expect(mesh.indices.length / 6).toBeGreaterThan(0)
      expect(mesh.indices.length / 6).toBeLessThan(3_000_000)
    },
    600_000,
  )
})

const bridgeBundleSuite = bridgeAvailable && bundleAvailable ? describe : describe.skip
bridgeBundleSuite('bridge-scale preview payload with the render bundle', () => {
  // The browser path: with real models, walls/stairs/panes go through the
  // per-voxel template path and the full-detail mesh measures ~11.15M quads
  // — past any budget a tab survives. The pipeline must land on the
  // box-proxy tier (textured whole blocks, ~2.3M quads), not the coarse LOD.
  it(
    'full detail overruns the budget; the pipeline degrades to the box-proxy tier',
    () => {
      const raw = readFileSync(fixture('bridge.bin'))
      const gz = raw.buffer.slice(
        raw.byteOffset,
        raw.byteOffset + raw.byteLength,
      ) as ArrayBuffer
      const bundle = JSON.parse(
        new TextDecoder().decode(gunzipSync(new Uint8Array(readFileSync(dataBundle)))),
      ) as AssetBundle
      const grid = decodePreview(new Uint8Array(gz))
      const store = surfaceAssetsFromBundle(bundle)
      expect(() => extractSurface(grid, store, new Map())).toThrowError(MeshBudgetError)
      const result = runMeshPipeline(gz, bundle)
      expect(result.degraded).toBe(true)
      expect(result.notice).toBe(BOX_NOTICE)
      expect(result.mesh.faceCount).toBeGreaterThan(0)
      expect(result.mesh.faceCount).toBeLessThan(3_000_000)
    },
    600_000,
  )
})

const stressSuite = stressAvailable ? describe : describe.skip
stressSuite('stress-scale preview payload', () => {
  it(
    'decodes and meshes the 566x256x1423 stress fixture within the quad budget',
    () => {
      const grid = decodePreview(new Uint8Array(readFileSync(fixture('stress.bin'))))
      const mesh = extractSurface(grid, null)
      expect(mesh.indices.length / 6).toBeGreaterThan(0)
      expect(mesh.indices.length / 6).toBeLessThan(3_000_000)
    },
    600_000,
  )
})
