/**
 * Protocol and pipeline tests for render/meshWorker — message assembly,
 * parsing, transfer-list plumbing and the shared decode+mesh pipeline,
 * all exercised through the exported pure functions (no real Worker is
 * spawned; the worker entry is inert outside a worker scope).
 */
import { describe, expect, it } from 'vitest'
import { gzipSync } from 'fflate'
import type { AssetBundle } from '../types'
import {
  asMeshRequest,
  asMeshResponse,
  buildMeshRequest,
  handleMeshRequest,
  meshTransferList,
  runMeshPipeline,
  type MeshResponse,
} from './meshWorker'

// ---------------------------------------------------------------------------
// Independent LPRV encoder (same spec implementation as decode.test.ts).
// ---------------------------------------------------------------------------

function uvarint(value: number): number[] {
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

function encodePreview(dims: [number, number, number], palette: string[], runs: [number, number][]): Uint8Array {
  const out: number[] = [0x4c, 0x50, 0x52, 0x56, 3] // "LPRV", version 3
  const push = (bytes: number[]): void => {
    out.push(...bytes)
  }
  const text = (s: string): void => {
    const bytes = new TextEncoder().encode(s)
    push(uvarint(bytes.length))
    out.push(...bytes)
  }
  for (const d of dims) push(uvarint(d))
  push(uvarint(1)) // one region
  text('main')
  for (const p of [0, 0, 0]) push(zigzag(p))
  for (const s of dims) push(zigzag(s))
  push(uvarint(palette.length))
  for (const state of palette) text(state)
  push(uvarint(runs.length))
  for (const [idx, run] of runs) {
    push(uvarint(idx))
    push(uvarint(run))
  }
  return gzipSync(new Uint8Array(out))
}

/** Exact-size ArrayBuffer copy of a gzipped payload (worker messages carry
 * ArrayBuffers; fflate views may sit in larger buffers). */
function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer
}

/** One fully-textured stone model so the bundle path produces real quads. */
function stoneBundle(): AssetBundle {
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
      },
    },
    textures: {
      'minecraft:block/stone': { uv: [1, 0], alpha: 'opaque' },
    },
    tintColors: {},
  }
}

// ---------------------------------------------------------------------------
// Message assembly / parsing
// ---------------------------------------------------------------------------

describe('buildMeshRequest / asMeshRequest', () => {
  it('round-trips a valid request, keeping the gz buffer identity', () => {
    const gz = toBuffer(encodePreview([1, 1, 1], ['minecraft:stone'], [[0, 1]]))
    const request = buildMeshRequest(gz, null)
    expect(asMeshRequest(request)).toEqual(request)
    expect(asMeshRequest(request)?.gz).toBe(gz)
  })

  it('round-trips a request carrying a bundle', () => {
    const bundle = stoneBundle()
    const request = buildMeshRequest(new ArrayBuffer(0), bundle)
    expect(asMeshRequest(request)?.bundle).toEqual(bundle)
  })

  it('rejects malformed envelopes', () => {
    const gz = new ArrayBuffer(8)
    expect(asMeshRequest(null)).toBeNull()
    expect(asMeshRequest('mesh')).toBeNull()
    expect(asMeshRequest({ type: 'bogus' })).toBeNull()
    expect(asMeshRequest({ type: 'mesh' })).toBeNull() // no gz
    expect(asMeshRequest({ type: 'mesh', gz: new Uint8Array(gz) })).toBeNull() // view, not buffer
    expect(asMeshRequest({ type: 'mesh', gz, bundle: 'stone' })).toBeNull()
  })
})

describe('asMeshResponse', () => {
  it('accepts progress and error messages, rejecting corrupted ones', () => {
    expect(asMeshResponse({ type: 'progress', pct: 0.42 })).toEqual({ type: 'progress', pct: 0.42 })
    expect(asMeshResponse({ type: 'progress', pct: Number.NaN })).toBeNull()
    expect(asMeshResponse({ type: 'error', message: '原理图过大,无法在浏览器中生成预览' })).toEqual({
      type: 'error',
      message: '原理图过大,无法在浏览器中生成预览',
    })
    expect(asMeshResponse({ type: 'error', message: 42 })).toBeNull()
    expect(asMeshResponse({ type: 'what' })).toBeNull()
    expect(asMeshResponse(undefined)).toBeNull()
  })

  it('accepts a real done message and rejects damaged meshes', () => {
    const gz = toBuffer(encodePreview([2, 1, 1], ['minecraft:stone'], [[0, 2]]))
    const { mesh, dims } = runMeshPipeline(gz, null)
    const done = { type: 'done' as const, mesh, dims }
    expect(asMeshResponse(done)).toEqual(done)

    const broken = { ...done, mesh: { ...mesh, positions: new Uint32Array(0) } }
    expect(asMeshResponse(broken)).toBeNull()
    expect(asMeshResponse({ ...done, dims: [1, 1] })).toBeNull()
    expect(asMeshResponse({ ...done, dims: [1, 1, Number.POSITIVE_INFINITY] })).toBeNull()
    expect(asMeshResponse({ type: 'done', mesh: null, dims })).toBeNull()
  })
})

describe('meshTransferList', () => {
  it('collects the six attribute buffers without duplicates', () => {
    const gz = toBuffer(encodePreview([2, 1, 1], ['minecraft:stone'], [[0, 2]]))
    const { mesh } = runMeshPipeline(gz, null)
    const transfer = meshTransferList(mesh)
    expect(transfer).toEqual([
      mesh.positions.buffer,
      mesh.normals.buffer,
      mesh.uvs.buffer,
      mesh.tileOrigins.buffer,
      mesh.colors.buffer,
      mesh.indices.buffer,
    ])
    expect(new Set(transfer).size).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// Pipeline (worker and inline fallback run the very same function)
// ---------------------------------------------------------------------------

describe('runMeshPipeline', () => {
  it('decodes and meshes a payload, flat fallback without a bundle', () => {
    const gz = toBuffer(encodePreview([2, 1, 1], ['minecraft:stone'], [[0, 2]]))
    const { mesh, dims } = runMeshPipeline(gz, null)
    expect(dims).toEqual([2, 1, 1])
    expect(mesh.indices.length).toBeGreaterThan(0)
    expect(mesh.ranges.flat.count).toBe(mesh.indices.length) // fallback mode
  })

  it('meshes textured quads from a plain-JSON bundle', () => {
    const gz = toBuffer(encodePreview([2, 1, 1], ['minecraft:stone'], [[0, 2]]))
    const { mesh } = runMeshPipeline(gz, stoneBundle())
    expect(mesh.ranges.opaque.count).toBeGreaterThan(0)
    expect(mesh.ranges.flat.count).toBe(0)
  })

  it('reports monotonic 0..1 progress that reaches 1, throttled far below per-voxel', () => {
    const dims: [number, number, number] = [8, 8, 8]
    const gz = toBuffer(encodePreview(dims, ['minecraft:stone'], [[0, 512]]))
    const calls: number[] = []
    const { mesh } = runMeshPipeline(gz, null, (pct) => calls.push(pct))
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]).toBeGreaterThanOrEqual(0)
    expect(calls[calls.length - 1]).toBe(1)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i]).toBeGreaterThanOrEqual(calls[i - 1])
      expect(calls[i]).toBeLessThanOrEqual(1)
    }
    // 512 voxels, a few dozen coarse callbacks (y layers / scan slices).
    expect(calls.length).toBeLessThan(dims[0] * dims[1] * dims[2])
    expect(mesh.indices.length).toBeGreaterThan(0)
  })

  it('keeps the callback-free path identical (no progress, same result)', () => {
    const gz = toBuffer(encodePreview([2, 1, 1], ['minecraft:stone'], [[0, 2]]))
    const withCb: number[] = []
    const a = runMeshPipeline(gz.slice(0), null, (pct) => withCb.push(pct))
    const b = runMeshPipeline(gz, null)
    expect(b.dims).toEqual(a.dims)
    expect(b.mesh.indices).toEqual(a.mesh.indices)
  })

  it('propagates the decode-side OOM guardrail (Chinese message)', () => {
    const gz = toBuffer(encodePreview([512_000_001, 1, 1], [], []))
    expect(() => runMeshPipeline(gz, null)).toThrowError('原理图过大,无法在浏览器中生成预览')
  })

  it('propagates decode format errors verbatim', () => {
    const gz = toBuffer(gzipSync(new TextEncoder().encode('{"schema":2}')))
    expect(() => runMeshPipeline(gz, null)).toThrowError(/LPRV/)
  })
})

// ---------------------------------------------------------------------------
// Worker-side handling — the path a real worker delegates to
// ---------------------------------------------------------------------------

/** Capture poster: records messages plus the transfer list per post. */
function recorder(): {
  posts: { message: MeshResponse; transfer: unknown[] }[]
  post: (message: MeshResponse, transfer: unknown[]) => void
} {
  const posts: { message: MeshResponse; transfer: unknown[] }[] = []
  return {
    posts,
    post: (message, transfer) => posts.push({ message, transfer }),
  }
}

describe('handleMeshRequest', () => {
  it('posts integer-percent progress steps, then done with the transfer list', () => {
    const gz = toBuffer(encodePreview([8, 8, 8], ['minecraft:stone'], [[0, 512]]))
    const { posts, post } = recorder()
    handleMeshRequest(buildMeshRequest(gz, null), post)

    const done = posts.filter((p) => p.message.type === 'done')
    expect(done).toHaveLength(1)
    const errors = posts.filter((p) => p.message.type === 'error')
    expect(errors).toHaveLength(0)

    const steps = posts.filter((p) => p.message.type === 'progress')
    expect(steps.length).toBeGreaterThan(0)
    for (let i = 0; i < steps.length; i++) {
      const pct = (steps[i].message as { pct: number }).pct
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(1)
      // Integer-percent steps: strictly increasing, no duplicate posts.
      if (i > 0) expect(pct).toBeGreaterThan((steps[i - 1].message as { pct: number }).pct)
      expect(steps[i].transfer).toEqual([])
    }

    const { message, transfer } = done[0]
    expect(message.type).toBe('done')
    if (message.type !== 'done') return
    expect(message.dims).toEqual([8, 8, 8])
    expect(transfer).toEqual(meshTransferList(message.mesh))
  })

  it('returns guardrail errors as a single error message, never done', () => {
    const gz = toBuffer(encodePreview([512_000_001, 1, 1], [], []))
    const { posts, post } = recorder()
    handleMeshRequest(buildMeshRequest(gz, null), post)
    expect(posts).toEqual([
      { message: { type: 'error', message: '原理图过大,无法在浏览器中生成预览' }, transfer: [] },
    ])
  })

  it('returns decode failures as error messages with their verbatim text', () => {
    const gz = toBuffer(gzipSync(new Uint8Array([0x4c, 0x50, 0x52, 0x56, 2])))
    const { posts, post } = recorder()
    handleMeshRequest(buildMeshRequest(gz, null), post)
    expect(posts).toHaveLength(1)
    expect(posts[0].message).toEqual({
      type: 'error',
      message: 'unsupported preview version 2',
    })
  })
})
