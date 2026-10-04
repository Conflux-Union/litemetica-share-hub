/**
 * Off-main-thread preview pipeline (module worker): decodes the gzipped
 * LPRV payload and runs the greedy mesher so huge schematics never block
 * or OOM the UI thread. Protocol:
 *
 *   main → worker: { type: 'mesh', gz, bundle }
 *     gz     — ArrayBuffer of GET /api/schematics/{id}/preview
 *     bundle — AssetBundle plain-JSON shape, or null for flat-color fallback
 *   worker → main (in order):
 *     { type: 'progress', pct }        — 0..1 fraction, integer-percent steps
 *     { type: 'done', mesh, dims, coarse, degraded, notice }
 *                                      — every mesh buffer transferred
 *                                        zero-copy; `coarse` is the LOD mesh
 *                                        for distance switching (null when
 *                                        not built), `degraded`+`notice`
 *                                        mark a budget fallback where `mesh`
 *                                        already is the coarse mesh
 *     { type: 'error', message }       — pipeline failure, incl. the Chinese
 *                                        OOM guardrails thrown by decode/mesh
 *
 * Everything above the bottom section is exported as pure functions so
 * tests cover assembly, parsing and the pipeline without spawning a
 * Worker; Viewer3D's inline fallback calls the very same runMeshPipeline.
 */

import type { AssetBundle } from '../types'
import { bundleTintColors, surfaceAssetsFromBundle } from './bundle'
import { decodePreview } from './decode'
import { buildLodMesh } from './lod'
import { extractSurface, MeshBudgetError, type MeshData } from './surface'
import { setTintColors } from './tint'

/** The mesh shape this module's protocol carries (re-exported for the
 * viewer and the smoke harness, which consume the pipeline through it). */
export type { MeshData } from './surface'

export interface MeshRequest {
  type: 'mesh'
  /** Gzipped LPRV preview payload (Content-Type: application/gzip). */
  gz: ArrayBuffer
  /** Render bundle (plain-JSON shape) or null for flat-color fallback. */
  bundle: AssetBundle | null
}

export type MeshResponse =
  | { type: 'progress'; pct: number }
  | {
      type: 'done'
      /** Full-precision mesh, or the coarse mesh when `degraded`. */
      mesh: MeshData
      dims: [number, number, number]
      /** Coarse LOD mesh for distance switching; null when not built (small
       * meshes, or degraded — there `mesh` already is the coarse one). */
      coarse: MeshData | null
      /** True when the full mesh hit the quad budget and the coarse mesh
       * replaced it. */
      degraded: boolean
      /** User-facing notice shown with a degraded render; null otherwise. */
      notice: string | null
    }
  | { type: 'error'; message: string }

export interface MeshResult {
  mesh: MeshData
  dims: [number, number, number]
  coarse: MeshData | null
  degraded: boolean
  notice: string | null
}

/** Notice text for a budget-degraded render. */
export const LOD_NOTICE = '原理图过大,已自动降低精度显示'

/** Above this full-precision face count the coarse LOD mesh is also built
 * for distance switching. */
const LOD_FACE_COUNT = 500_000

/** Pipeline progress shares: decode 0..0.35, full mesh 0.35..0.8, coarse
 * LOD (when built) 0.8..1. The windows are fixed so progress never
 * regresses when the coarse build turns out to be needed. */
const DECODE_WEIGHT = 0.35
const COARSE_START = 0.8

/** Pipeline overrides; tests stub a tiny quad budget to exercise the
 * degradation path and a tiny LOD threshold to force the coarse build. */
export interface PipelineLimits {
  maxQuads?: number
  lodFaceCount?: number
}

// ---------------------------------------------------------------------------
// Pure helpers — message assembly / parsing
// ---------------------------------------------------------------------------

export function buildMeshRequest(gz: ArrayBuffer, bundle: AssetBundle | null): MeshRequest {
  return { type: 'mesh', gz, bundle }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** Validate a main→worker message; null when malformed. The bundle's
 * internals are trusted (same-origin wire data already validated by
 * loadAssets), only the envelope is checked here. */
export function asMeshRequest(data: unknown): MeshRequest | null {
  if (!isRecord(data) || data.type !== 'mesh') return null
  if (!(data.gz instanceof ArrayBuffer)) return null
  if (data.bundle !== null && !isRecord(data.bundle)) return null
  return { type: 'mesh', gz: data.gz, bundle: data.bundle as AssetBundle | null }
}

/** Validate a worker→main message; null when malformed. */
export function asMeshResponse(data: unknown): MeshResponse | null {
  if (!isRecord(data)) return null
  switch (data.type) {
    case 'progress':
      return typeof data.pct === 'number' && Number.isFinite(data.pct)
        ? { type: 'progress', pct: data.pct }
        : null
    case 'error':
      return typeof data.message === 'string' ? { type: 'error', message: data.message } : null
    case 'done': {
      const { mesh, dims, coarse, degraded, notice } = data
      if (!isMeshData(mesh) || !Array.isArray(dims) || dims.length !== 3) return null
      if (!dims.every((d) => typeof d === 'number' && Number.isFinite(d))) return null
      let coarseMesh: MeshData | null = null
      if (coarse !== null && coarse !== undefined) {
        if (!isMeshData(coarse)) return null
        coarseMesh = coarse
      }
      if (degraded !== undefined && typeof degraded !== 'boolean') return null
      if (notice !== undefined && notice !== null && typeof notice !== 'string') return null
      return {
        type: 'done',
        mesh,
        dims: dims as [number, number, number],
        coarse: coarseMesh,
        degraded: degraded === true,
        notice: typeof notice === 'string' ? notice : null,
      }
    }
    default:
      return null
  }
}

/** Structural check of a MeshData payload (typed arrays survive the
 * structured clone as the same views). */
function isMeshData(value: unknown): value is MeshData {
  if (!isRecord(value)) return false
  return (
    value.positions instanceof Float32Array &&
    value.normals instanceof Float32Array &&
    value.uvs instanceof Float32Array &&
    value.tileOrigins instanceof Float32Array &&
    value.colors instanceof Float32Array &&
    value.indices instanceof Uint32Array &&
    isRecord(value.ranges) &&
    typeof value.faceCount === 'number'
  )
}

/** Every mesh attribute buffer — the transfer list for the done message,
 * moving all vertex data to the main thread without a copy. `coarse`, when
 * a separate LOD mesh was built, appends its buffers (the degraded case
 * passes none: `mesh` already is the coarse mesh, and an ArrayBuffer may
 * appear in a transfer list only once). */
export function meshTransferList(mesh: MeshData, coarse: MeshData | null = null): ArrayBuffer[] {
  const list: ArrayBuffer[] = [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.uvs.buffer,
    mesh.tileOrigins.buffer,
    mesh.colors.buffer,
    mesh.indices.buffer,
  ]
  if (coarse && coarse !== mesh) {
    list.push(
      coarse.positions.buffer,
      coarse.normals.buffer,
      coarse.uvs.buffer,
      coarse.tileOrigins.buffer,
      coarse.colors.buffer,
      coarse.indices.buffer,
    )
  }
  return list
}

// ---------------------------------------------------------------------------
// The pipeline itself — shared by the worker and the viewer's inline
// fallback (Viewer3D), so both paths produce byte-identical meshes.
// ---------------------------------------------------------------------------

export function runMeshPipeline(
  gz: ArrayBuffer,
  bundle: AssetBundle | null,
  onProgress?: (pct: number) => void,
  limits?: PipelineLimits,
): MeshResult {
  const grid = decodePreview(new Uint8Array(gz), (f) => onProgress?.(f * DECODE_WEIGHT))
  if (bundle) {
    // extractSurface reads the tint palette through render/tint; keep this
    // thread's palette in sync with the bundle (loadAssets does the same
    // on the main thread).
    setTintColors(bundleTintColors(bundle))
  }
  const assets = bundle ? surfaceAssetsFromBundle(bundle) : null

  // Full-precision mesh; the quad-budget guardrail degrades to the coarse
  // LOD mesh below instead of failing the render (decode-side errors —
  // including its own volume guard — still propagate: without a decoded
  // grid there is nothing to downsample).
  let full: MeshData | null = null
  const meshLimits = limits?.maxQuads === undefined ? undefined : { maxQuads: limits.maxQuads }
  try {
    full = extractSurface(
      grid,
      assets,
      undefined,
      (f) => onProgress?.(DECODE_WEIGHT + f * (COARSE_START - DECODE_WEIGHT)),
      meshLimits,
    )
  } catch (e) {
    if (!(e instanceof MeshBudgetError)) throw e
  }

  // Small meshes render alone; large ones also get a coarse mesh for
  // distance switching, and a budget-degraded render IS the coarse mesh.
  if (full && full.faceCount <= (limits?.lodFaceCount ?? LOD_FACE_COUNT)) {
    onProgress?.(1)
    return { mesh: full, dims: grid.dims, coarse: null, degraded: false, notice: null }
  }
  const lod = buildLodMesh(grid, (f) => onProgress?.(COARSE_START + f * (1 - COARSE_START)))
  return full
    ? { mesh: full, dims: grid.dims, coarse: lod.mesh, degraded: false, notice: null }
    : { mesh: lod.mesh, dims: grid.dims, coarse: null, degraded: true, notice: LOD_NOTICE }
}

// ---------------------------------------------------------------------------
// Worker-side handling
// ---------------------------------------------------------------------------

/** Post signature of DedicatedWorkerGlobalScope.postMessage (narrowed). */
export type MeshPoster = (message: MeshResponse, transfer: Transferable[]) => void

/**
 * Handle one mesh request: run the pipeline, post integer-percent progress
 * steps, then done (with the transfer list) — or a single error message.
 * Pipeline exceptions never escape; the OOM guardrails' Chinese messages
 * travel back as { type: 'error', message } verbatim.
 */
export function handleMeshRequest(request: MeshRequest, post: MeshPoster): void {
  let lastWholePct = -1
  const onProgress = (pct: number): void => {
    const whole = Math.max(0, Math.min(100, Math.floor(pct * 100)))
    if (whole <= lastWholePct) return
    lastWholePct = whole
    post({ type: 'progress', pct: whole / 100 }, [])
  }
  try {
    const { mesh, dims, coarse, degraded, notice } = runMeshPipeline(request.gz, request.bundle, onProgress)
    post({ type: 'done', mesh, dims, coarse, degraded, notice }, meshTransferList(mesh, coarse))
  } catch (e) {
    post({ type: 'error', message: e instanceof Error ? e.message : String(e) }, [])
  }
}

// ---------------------------------------------------------------------------
// Module-worker entry. Registered only inside a worker (window is absent
// there); importing this module on the main thread (inline fallback, tests)
// is side-effect free.
// ---------------------------------------------------------------------------

if (typeof window === 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((event: MessageEvent) => void) | null
    postMessage: (message: unknown, transfer: Transferable[]) => void
  }
  scope.onmessage = (event: MessageEvent) => {
    const request = asMeshRequest(event.data)
    if (request) handleMeshRequest(request, (message, transfer) => scope.postMessage(message, transfer))
  }
}
