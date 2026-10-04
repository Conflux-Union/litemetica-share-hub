/// <reference types="node" />
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { gzipSync, gunzipSync } from 'fflate'
import { decodePreview } from './decode'
import { parseState } from './model'

// ---------------------------------------------------------------------------
// Independent encoder for the schema-3 binary preview format — the spec's
// second implementation next to the backend writer. Layout: magic "LPRV",
// u8 version 3, uvarint dx/dy/dz, uvarint regionCount; per region uvarint
// nameLen + UTF-8 name, zigzag pos/size triples, uvarint paletteCount +
// (uvarint len + UTF-8 canonical state)*, uvarint runCount +
// (uvarint paletteIdx, uvarint runLength)*. Unsigned values are LEB128;
// signed values zigzag first. The payload is gzipped as a whole.
// ---------------------------------------------------------------------------

function uvarint(value: number): number[] {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`uvarint expects a non-negative integer, got ${value}`)
  }
  const out: number[] = []
  let v = value
  for (;;) {
    const b = v % 128
    v = Math.floor(v / 128)
    if (v === 0) {
      out.push(b)
      return out
    }
    out.push(b + 128)
  }
}

function zigzag(value: number): number[] {
  return uvarint(value >= 0 ? value * 2 : -value * 2 - 1)
}

interface EncodedRegion {
  name: string
  pos: [number, number, number]
  size: [number, number, number]
  palette: string[]
  runs: [number, number][]
}

function pushBytes(out: number[], bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) out.push(bytes[i])
}

function pushText(out: number[], text: string): void {
  const bytes = new TextEncoder().encode(text)
  pushBytes(out, uvarint(bytes.length))
  pushBytes(out, bytes)
}

function encodePreview(dims: [number, number, number], regions: EncodedRegion[]): Uint8Array {
  const out: number[] = [0x4c, 0x50, 0x52, 0x56, 3] // "LPRV", version 3
  for (const d of dims) pushBytes(out, uvarint(d))
  pushBytes(out, uvarint(regions.length))
  for (const region of regions) {
    pushText(out, region.name)
    for (const p of region.pos) pushBytes(out, zigzag(p))
    for (const s of region.size) pushBytes(out, zigzag(s))
    pushBytes(out, uvarint(region.palette.length))
    for (const state of region.palette) pushText(out, state)
    pushBytes(out, uvarint(region.runs.length))
    for (const [idx, run] of region.runs) {
      pushBytes(out, uvarint(idx))
      pushBytes(out, uvarint(run))
    }
  }
  return gzipSync(new Uint8Array(out))
}

describe('encoder primitives (spec pinning)', () => {
  it('writes LEB128 uvarints', () => {
    expect(uvarint(0)).toEqual([0x00])
    expect(uvarint(127)).toEqual([0x7f])
    expect(uvarint(128)).toEqual([0x80, 0x01])
    expect(uvarint(16384)).toEqual([0x80, 0x80, 0x01])
    // 2^21 - 1 fits three bytes; 2^21 (and larger runs) needs four.
    expect(uvarint(2 ** 21 - 1).length).toBe(3)
    expect(uvarint(2 ** 21).length).toBe(4)
  })

  it('zigzags signed values before LEB128', () => {
    expect(zigzag(0)).toEqual([0])
    expect(zigzag(-1)).toEqual([1])
    expect(zigzag(1)).toEqual([2])
    expect(zigzag(-2)).toEqual([3])
  })
})

describe('LPRV schema-3 previews', () => {
  it('decodes multiple regions into one global palette with shared states', () => {
    const stateKey = 'minecraft:redstone_wire[east=none,north=up,power=7,south=none,west=none]'
    const gz = encodePreview(
      [4, 1, 3],
      [
        // Local palette index 0 is stone here — index 0 is NOT guaranteed
        // to be air (only the global index 0 is reserved for air).
        {
          name: 'floor',
          pos: [0, 0, 0],
          size: [4, 1, 3],
          palette: ['minecraft:stone', stateKey],
          runs: [[0, 12]],
        },
        {
          name: 'pillar',
          pos: [1, 0, 1],
          size: [1, 1, 1],
          // 'minecraft:stone' dedupes into the global entry from 'floor'.
          palette: ['minecraft:glowstone', 'minecraft:stone'],
          runs: [[0, 1]],
        },
      ],
    )
    const grid = decodePreview(gz)
    expect(grid.dims).toEqual([4, 1, 3])
    expect(grid.palette).toEqual(['minecraft:air', 'minecraft:stone', stateKey, 'minecraft:glowstone'])
    // All stone except the pillar voxel (1, 0, 1) → index 5.
    expect(Array.from(grid.data)).toEqual([1, 1, 1, 1, 1, 3, 1, 1, 1, 1, 1, 1])
    // State strings survive verbatim so states share resolution cache keys.
    expect(parseState(grid.palette[2]).props.power).toBe('7')
  })

  it('anchors negative-size regions at pos + min(0, size+1)', () => {
    // size [-2, 2, 1] at pos [2, 1, 0]: local x runs 0..1 mapping to
    // global 1..2 (min corner 2 + (-2 + 1) = 1), local y 0..1 → 1..2.
    const gz = encodePreview(
      [4, 3, 1],
      [
        {
          name: 'seam',
          pos: [2, 1, 0],
          size: [-2, 2, 1],
          palette: ['minecraft:gold_block', 'minecraft:diamond_block'],
          runs: [
            [0, 1],
            [1, 1],
            [0, 1],
            [1, 1],
          ],
        },
      ],
    )
    const grid = decodePreview(gz)
    expect(grid.palette).toEqual(['minecraft:air', 'minecraft:gold_block', 'minecraft:diamond_block'])
    // RLE order x -> z -> y: gold|diamond per x-row, two y rows.
    expect(Array.from(grid.data)).toEqual([0, 0, 0, 0, 0, 1, 2, 0, 0, 1, 2, 0])
  })

  it('clips runs that extend outside the grid on any side', () => {
    const gz = encodePreview(
      [3, 2, 2],
      [
        {
          // Spans global x -1..3, y -1..1, z 0..1 — covers the whole
          // 3x2x2 grid plus clipped margins, as one 30-voxel run.
          name: 'slab',
          pos: [-1, -1, 0],
          size: [5, 3, 2],
          palette: ['minecraft:iron_block'],
          runs: [[0, 30]],
        },
        {
          // Spans global x 1..4 at y 0, z 1; x = 3 is outside dx = 3.
          name: 'trim',
          pos: [1, 0, 1],
          size: [4, 1, 1],
          palette: ['minecraft:gold_block'],
          runs: [[0, 4]],
        },
      ],
    )
    const grid = decodePreview(gz)
    expect(grid.palette).toEqual(['minecraft:air', 'minecraft:iron_block', 'minecraft:gold_block'])
    // Iron everywhere, gold overwriting (1, 0, 1) and (2, 0, 1).
    expect(Array.from(grid.data)).toEqual([1, 1, 1, 1, 2, 2, 1, 1, 1, 1, 1, 1])
  })

  it('decodes runs longer than 2^21 (multi-byte varints)', () => {
    const length = 2 ** 21 + 5
    const gz = encodePreview(
      [length, 1, 1],
      [
        {
          name: 'long',
          pos: [0, 0, 0],
          size: [length, 1, 1],
          palette: ['minecraft:stone'],
          runs: [[0, length]],
        },
      ],
    )
    const grid = decodePreview(gz)
    expect(grid.data.length).toBe(length)
    expect(grid.data[0]).toBe(1)
    expect(grid.data[length - 1]).toBe(1)
    expect(grid.data.every((v) => v === 1)).toBe(true)
  })

  it('throws the volume guard above 512,000,000 voxels', () => {
    const gz = encodePreview([512_000_001, 1, 1], [])
    expect(() => decodePreview(gz)).toThrowError('原理图过大,无法在浏览器中生成预览')
  })

  it('keeps the Uint16 palette cap semantics (65535 distinct states pass)', () => {
    const states = Array.from({ length: 65535 }, (_, i) => `minecraft:cap_${i}`)
    const gz = encodePreview(
      [1, 1, 1],
      [
        {
          name: 'cap',
          pos: [0, 0, 0],
          size: [1, 1, 1],
          palette: states,
          runs: [[65534, 1]],
        },
      ],
    )
    const grid = decodePreview(gz)
    expect(grid.palette.length).toBe(65536)
    expect(grid.data[0]).toBe(65535)
  })

  it('throws when interning exceeds 65535 distinct states', () => {
    const states = Array.from({ length: 65536 }, (_, i) => `minecraft:cap_${i}`)
    const gz = encodePreview(
      [1, 1, 1],
      [
        {
          name: 'cap',
          pos: [0, 0, 0],
          size: [1, 1, 1],
          palette: states,
          runs: [[65535, 1]],
        },
      ],
    )
    expect(() => decodePreview(gz)).toThrowError('too many distinct blocks in preview')
  })

  it('rejects legacy JSON payloads and wrong magic/version', () => {
    const legacyJson = gzipSync(new TextEncoder().encode('{"schema":2,"size":[1,1,1],"regions":[]}'))
    expect(() => decodePreview(legacyJson)).toThrowError(/LPRV/)
    const wrongVersion = gzipSync(new Uint8Array([0x4c, 0x50, 0x52, 0x56, 2]))
    expect(() => decodePreview(wrongVersion)).toThrowError(/unsupported preview version 2/)
  })

  it('rejects truncated payloads and RLE/volume mismatches', () => {
    const valid = gunzipSync(
      encodePreview(
        [2, 1, 1],
        [
          {
            name: 'short',
            pos: [0, 0, 0],
            size: [2, 1, 1],
            palette: ['minecraft:stone'],
            runs: [[0, 2]],
          },
        ],
      ),
    )
    const truncated = gzipSync(valid.subarray(0, valid.length - 3))
    expect(() => decodePreview(truncated)).toThrowError(/malformed preview payload/)

    const mismatch = encodePreview(
      [2, 1, 1],
      [
        {
          name: 'bad',
          pos: [0, 0, 0],
          size: [2, 1, 1],
          palette: ['minecraft:stone'],
          runs: [[0, 1]],
        },
      ],
    )
    expect(() => decodePreview(mismatch)).toThrowError('region "bad" RLE length 1 != volume 2')
  })
})

// Cross-implementation probe against the backend writer: when the visual-
// smoke fixture exists (frontend/public/smoke.bin, regenerated by the
// backend tooling), it must be an LPRV schema-3 payload that decodes.
const SMOKE_PATH = fileURLToPath(new URL('../../public/smoke.bin', import.meta.url))
const smokeAvailable = existsSync(SMOKE_PATH)
if (!smokeAvailable) {
  console.info(`[decode] skipping smoke.bin probe: ${SMOKE_PATH} does not exist.`)
}
const smokeSuite = smokeAvailable ? describe : describe.skip
smokeSuite('backend smoke fixture (LPRV cross-implementation probe)', () => {
  it('carries the LPRV magic, version 3 and a non-empty palette', () => {
    const gz = new Uint8Array(readFileSync(SMOKE_PATH))
    const raw = gunzipSync(gz)
    expect(Array.from(raw.subarray(0, 4))).toEqual([0x4c, 0x50, 0x52, 0x56])
    expect(raw[4]).toBe(3)
    const grid = decodePreview(gz)
    expect(grid.dims.every((d) => d > 0)).toBe(true)
    // Index 0 is reserved air; a real fixture has at least one state.
    expect(grid.palette.length).toBeGreaterThan(1)
  })
})
