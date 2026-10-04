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
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { decodePreview } from './decode'
import { extractSurface } from './surface'

const fixture = (name: string): string =>
  fileURLToPath(new URL(`../../public/${name}`, import.meta.url))

const bridgeAvailable = existsSync(fixture('bridge.bin'))
const stressAvailable = existsSync(fixture('stress.bin'))
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
    'decodes and meshes the bridge fixture within the quad budget',
    () => {
      const grid = decodePreview(new Uint8Array(readFileSync(fixture('bridge.bin'))))
      const mesh = extractSurface(grid, null)
      expect(mesh.indices.length / 6).toBeGreaterThan(0)
      expect(mesh.indices.length / 6).toBeLessThan(3_000_000)
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
