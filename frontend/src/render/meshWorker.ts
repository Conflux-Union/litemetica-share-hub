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
 *     { type: 'done', mesh, dims }     — every mesh buffer transferred zero-copy
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
import { extractSurface, type MeshData } from './surface'
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
  | { type: 'done'; mesh: MeshData; dims: [number, number, number] }
  | { type: 'error'; message: string }

export interface MeshResult {
  mesh: MeshData
  dims: [number, number, number]
}

/** Share of the pipeline spent decoding (the rest is meshing). */
const DECODE_WEIGHT = 0.35

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
      const { mesh, dims } = data
      if (!isRecord(mesh) || !Array.isArray(dims) || dims.length !== 3) return null
      if (!dims.every((d) => typeof d === 'number' && Number.isFinite(d))) return null
      const valid =
        mesh.positions instanceof Float32Array &&
        mesh.normals instanceof Float32Array &&
        mesh.uvs instanceof Float32Array &&
        mesh.tileOrigins instanceof Float32Array &&
        mesh.colors instanceof Float32Array &&
        mesh.indices instanceof Uint32Array &&
        isRecord(mesh.ranges) &&
        typeof mesh.faceCount === 'number'
      return valid
        ? { type: 'done', mesh: mesh as unknown as MeshData, dims: dims as [number, number, number] }
        : null
    }
    default:
      return null
  }
}

/** Every mesh attribute buffer — the transfer list for the done message,
 * moving all vertex data to the main thread without a copy. */
export function meshTransferList(mesh: MeshData): ArrayBuffer[] {
  return [
    mesh.positions.buffer,
    mesh.normals.buffer,
    mesh.uvs.buffer,
    mesh.tileOrigins.buffer,
    mesh.colors.buffer,
    mesh.indices.buffer,
  ] as ArrayBuffer[]
}

// ---------------------------------------------------------------------------
// The pipeline itself — shared by the worker and the viewer's inline
// fallback (Viewer3D), so both paths produce byte-identical meshes.
// ---------------------------------------------------------------------------

export function runMeshPipeline(
  gz: ArrayBuffer,
  bundle: AssetBundle | null,
  onProgress?: (pct: number) => void,
): MeshResult {
  const grid = decodePreview(new Uint8Array(gz), (f) => onProgress?.(f * DECODE_WEIGHT))
  if (bundle) {
    // extractSurface reads the tint palette through render/tint; keep this
    // thread's palette in sync with the bundle (loadAssets does the same
    // on the main thread).
    setTintColors(bundleTintColors(bundle))
  }
  const mesh = extractSurface(
    grid,
    bundle ? surfaceAssetsFromBundle(bundle) : null,
    undefined,
    (f) => onProgress?.(DECODE_WEIGHT + f * (1 - DECODE_WEIGHT)),
  )
  return { mesh, dims: grid.dims }
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
    const { mesh, dims } = runMeshPipeline(request.gz, request.bundle, onProgress)
    post({ type: 'done', mesh, dims }, meshTransferList(mesh))
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
