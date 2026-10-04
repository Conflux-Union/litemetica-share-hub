import { gunzipSync } from 'fflate'

export const EMPTY = 0

export interface VoxelGrid {
  /** Dimensions as [x, y, z]. */
  dims: [number, number, number]
  /** Global palette of block-state strings; index 0 is reserved for
   * air/empty. Entries are the backend's canonical state strings
   * ("minecraft:redstone_wire[east=none,power=7,...]") carried verbatim,
   * so equal states share resolution cache keys downstream. */
  palette: string[]
  /** Palette index per voxel (y * dz * dx + z * dx + x), EMPTY for air. */
  data: Uint16Array
}

// ---------------------------------------------------------------------------
// Binary preview format, schema 3 (magic "LPRV"). All multi-byte integers
// are unsigned LEB128 varints; signed values are zigzag-encoded first.
// Layout: magic | u8 version | uvarint dx,dy,dz | uvarint regionCount;
// per region { uvarint nameLen + UTF-8 name, zigzag pos x,y,z, zigzag
// size x,y,z, uvarint paletteCount + (uvarint len + UTF-8 state)*,
// uvarint runCount + (uvarint paletteIdx, uvarint runLength)* }. The whole
// payload is stored and served gzipped (Content-Type: application/gzip).
// Semantics match the retired schema-2 JSON: RLE order x fastest -> z -> y;
// a region-local palette index 0 is not guaranteed air; local coordinates
// run 0..|size| from the region's min corner and clip against the grid.
// ---------------------------------------------------------------------------

const MAGIC = [0x4c, 0x50, 0x52, 0x56] // "LPRV"
const VERSION = 3
/** Decode-side OOM guard: above this many voxels the Uint16 grid alone
 * would exceed 1 GB. */
const MAX_VOXELS = 512_000_000

const utf8 = new TextDecoder()

/**
 * Decode the gzipped LPRV preview payload into a global voxel grid.
 * RLE order matches the backend iteration: x fastest, then z, then y.
 * Runs are parsed into one flat interleaved Uint32Array per region and
 * expanded row-by-row with data.fill — never a per-voxel JS loop.
 *
 * `onProgress`, when given, receives a 0..1 fraction: once after the
 * gunzip + header, then per y layer crossed during RLE expansion and per
 * region completed (coarse granularity; no per-voxel calls). Omitting it
 * keeps the behavior and hot-loop cost of the callback-free path.
 */
export function decodePreview(
  gzBytes: Uint8Array,
  onProgress?: (fraction: number) => void,
): VoxelGrid {
  const buf = gunzipSync(gzBytes)
  let off = 0

  const malformed = (why: string): never => {
    throw new Error(`malformed preview payload: ${why}`)
  }
  const byte = (): number => {
    if (off >= buf.length) malformed('unexpected end of payload')
    return buf[off++]
  }
  const uvarint = (): number => {
    let value = 0
    let shift = 0
    for (;;) {
      const b = byte()
      value += (b & 0x7f) * 2 ** shift
      if ((b & 0x80) === 0) break
      shift += 7
      if (shift > 63) malformed('varint exceeds 64 bits')
    }
    if (value > Number.MAX_SAFE_INTEGER) malformed('varint exceeds 2^53')
    return value
  }
  const zigzag = (): number => {
    const v = uvarint()
    // Arithmetic (not >>>) so values above 32 bits keep full precision.
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2
  }
  const text = (len: number): string => {
    if (len > buf.length - off) malformed('string runs past end of payload')
    const s = utf8.decode(buf.subarray(off, off + len))
    off += len
    return s
  }

  for (let i = 0; i < MAGIC.length; i++) {
    if (byte() !== MAGIC[i]) {
      throw new Error('preview payload has no LPRV magic (legacy or corrupt payload)')
    }
  }
  const version = byte()
  if (version !== VERSION) throw new Error(`unsupported preview version ${version}`)

  const dx = uvarint()
  const dy = uvarint()
  const dz = uvarint()
  if (dx <= 0 || dy <= 0 || dz <= 0) malformed('grid dims must be positive')
  if (dx * dy * dz > MAX_VOXELS) {
    throw new Error('原理图过大,无法在浏览器中生成预览')
  }
  const data = new Uint16Array(dx * dy * dz)

  // Build a global palette; index 0 stays empty/air.
  const globalIndex = new Map<string, number>([['minecraft:air', EMPTY]])
  const palette: string[] = ['minecraft:air']
  const intern = (id: string): number => {
    let idx = globalIndex.get(id)
    if (idx === undefined) {
      idx = palette.length
      if (idx > 0xffff) throw new Error('too many distinct blocks in preview')
      palette.push(id)
      globalIndex.set(id, idx)
    }
    return idx
  }

  const regionCount = uvarint()
  // Progress: gunzip + header done (5%), region expansion the rest. The
  // y cursor inside each region gives continuous feedback between region
  // boundaries; single-region payloads (the common case) still tick.
  const regionProgress = (r: number, frac = 0): number =>
    0.05 + (0.95 * (r + Math.min(1, Math.max(0, frac)))) / Math.max(regionCount, 1)
  if (onProgress) onProgress(0.05)
  for (let r = 0; r < regionCount; r++) {
    const name = text(uvarint())
    const px = zigzag()
    const py = zigzag()
    const pz = zigzag()
    const sx = zigzag()
    const sy = zigzag()
    const sz = zigzag()

    const paletteCount = uvarint()
    if (paletteCount > buf.length - off) malformed('palette count exceeds payload size')
    // Intern this region's palette first so RLE expansion stays tight.
    const localToGlobal = new Uint16Array(paletteCount)
    for (let i = 0; i < paletteCount; i++) localToGlobal[i] = intern(text(uvarint()))

    // Runs land in one flat interleaved array (idx, run, idx, run, ...) —
    // no per-run allocations, and the reference dies with this iteration.
    const runCount = uvarint()
    if (runCount > (buf.length - off) / 2) malformed('run count exceeds payload size')
    const runs = new Uint32Array(runCount * 2)
    let totalRun = 0
    for (let i = 0; i < runCount; i++) {
      const idx = uvarint()
      if (idx >= paletteCount) malformed(`palette index ${idx} out of range`)
      const run = uvarint()
      runs[2 * i] = idx
      runs[2 * i + 1] = run
      totalRun += run
    }

    // A litematica sub-region spans [pos, pos + size); a negative size
    // means the region extends below pos, so its min corner is
    // pos + size + 1. Local coordinates (and the RLE order) always run
    // 0..|size| per axis.
    const ax = Math.abs(sx)
    const ay = Math.abs(sy)
    const az = Math.abs(sz)
    const expected = ax * ay * az
    if (totalRun !== expected) {
      throw new Error(`region "${name}" RLE length ${totalRun} != volume ${expected}`)
    }
    const ox = px + Math.min(0, sx + 1)
    const oy = py + Math.min(0, sy + 1)
    const oz = pz + Math.min(0, sz + 1)

    // Expand: each run is sliced at x-row boundaries into contiguous
    // memory ranges and filled with one data.fill per in-grid segment.
    // totalRun === expected guarantees the cursor never runs past the
    // region, so every step makes progress.
    let x = 0
    let z = 0
    let y = 0
    for (let i = 0; i < runCount; i++) {
      const global = localToGlobal[runs[2 * i]]
      let remaining = runs[2 * i + 1]
      while (remaining > 0) {
        const take = Math.min(ax - x, remaining)
        const gy = oy + y
        const gz = oz + z
        if (gy >= 0 && gy < dy && gz >= 0 && gz < dz) {
          const gx0 = ox + x
          const start = Math.max(gx0, 0)
          const end = Math.min(gx0 + take, dx)
          if (start < end) {
            const base = (gy * dz + gz) * dx
            data.fill(global, base + start, base + end)
          }
        }
        // Advance in x -> z -> y order.
        x += take
        if (x === ax) {
          x = 0
          if (++z === az) {
            z = 0
            y++
            // One callback per y layer, never per row or voxel.
            if (onProgress && y < ay) onProgress(regionProgress(r, y / ay))
          }
        }
        remaining -= take
      }
    }
    if (onProgress) onProgress(regionProgress(r + 1))
  }

  return { dims: [dx, dy, dz], palette, data }
}
