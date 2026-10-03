/**
 * Vanilla block-model interpretation: parent-chain flattening and
 * element → quad-template compilation. Pure logic, no rendering imports.
 *
 * Spec: docs/research/shulkr-litematica-viewer-rendering.md §3 — Shulkr
 * meshWorker parent walk (textures merged root→leaf, elements from the
 * deepest declaration, #ref resolution with cycle guard), from/to scaled
 * /16 with inverted bounds normalized, per-face default UVs from element
 * bounds, 0/90/180/270 face rotation, element rotation {origin, axis, angle},
 * variant x/y quarter turns around the block center with cullface remap
 * (clockwise seen from the positive axis end — vanilla's convention).
 */

/** Face directions with their vanilla meaning: north=-z, south=+z, east=+x,
 * west=-x, up=+y, down=-y. */
export type FaceDir = 'north' | 'south' | 'east' | 'west' | 'up' | 'down'

export const FACE_DIRS: readonly FaceDir[] = ['down', 'up', 'north', 'south', 'west', 'east']

export const FACE_NORMALS: Record<FaceDir, readonly [number, number, number]> = {
  north: [0, 0, -1],
  south: [0, 0, 1],
  east: [1, 0, 0],
  west: [-1, 0, 0],
  up: [0, 1, 0],
  down: [0, -1, 0],
}

type Vec3 = [number, number, number]

/** [u0, v0, u1, v1] in the model's 0..16 texture-pixel space. */
export type UvRect = [number, number, number, number]

export interface ElementRotation {
  /** Rotation center in 0..16 model space. */
  origin: [number, number, number]
  axis: 'x' | 'y' | 'z'
  /** Degrees; vanilla restricts elements to 0, ±22.5, ±45. Right-hand rule. */
  angle: number
  /** Parsed as data; vanilla's post-rotation rescale is not applied. */
  rescale?: boolean
}

export interface FaceJson {
  /** "#ref" into the merged texture map, or a literal texture id. */
  texture: string
  /** Explicit 0..16-space UV; defaults to the element bounds per face. */
  uv?: UvRect
  /** Cull direction (pre variant-rotation). Absent = never culled. */
  cullface?: string
  rotation?: 0 | 90 | 180 | 270
  tintindex?: number
}

export interface ElementJson {
  from: [number, number, number]
  to: [number, number, number]
  rotation?: ElementRotation
  /** Parsed as data; the preview applies AO uniformly (as Shulkr does). */
  shade?: boolean
  faces: Partial<Record<FaceDir, FaceJson>>
}

/** Verbatim vanilla model JSON. */
export interface ModelJson {
  parent?: string
  ambientocclusion?: boolean
  textures?: Record<string, string>
  elements?: ElementJson[]
}

/** Face record after flattening: texture resolved, uv still optional here
 * (compileGeometry fills the default from the element bounds). */
export interface FlattenedFace {
  /** Resolved texture id; an unresolvable "#ref" is kept verbatim. */
  texture: string
  uv?: UvRect
  cullface?: FaceDir
  rotation?: 0 | 90 | 180 | 270
  tintindex?: number
}

export interface FlattenedElement {
  /** Normalized (min ≤ max) bounds in 0..16 model space. */
  from: Vec3
  to: Vec3
  rotation?: ElementRotation
  faces: Partial<Record<FaceDir, FlattenedFace>>
}

export interface FlattenedModel {
  elements: FlattenedElement[]
  /** Fully resolved texture map (particle lookups etc.). */
  textures: Record<string, string>
}

function lookupModel(id: string, models: Record<string, ModelJson>): ModelJson | undefined {
  // Vanilla JSONs sometimes omit the "minecraft:" namespace; tolerate it.
  return models[id] ?? (id.includes(':') ? undefined : models[`minecraft:${id}`])
}

/** Resolve "#a" → "#b" → literal chains inside a merged texture map,
 * with a cycle guard. Unresolvable refs keep their verbatim "#x" value. */
export function resolveTextureMap(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(map)) {
    let value = map[key]
    const seen = new Set<string>()
    while (value.startsWith('#')) {
      const ref = value.slice(1)
      if (seen.has(ref) || !(ref in map)) break
      seen.add(ref)
      value = map[ref]
    }
    out[key] = value
  }
  return out
}

/**
 * Walk the parent chain of `modelId` and produce one flat model:
 * textures merged root→leaf (leaf overrides), elements taken from the
 * deepest model that declares them, face "#refs" resolved. Returns null
 * when the model id itself is unknown.
 */
export function flattenModel(
  modelId: string,
  models: Record<string, ModelJson>,
): FlattenedModel | null {
  const chain: ModelJson[] = []
  const seen = new Set<string>()
  let id: string | undefined = modelId
  while (id && !seen.has(id)) {
    seen.add(id)
    const m = lookupModel(id, models)
    if (!m) break // missing parent: keep whatever deeper models provided
    chain.push(m)
    id = m.parent
  }
  if (!chain.length) return null

  const merged: Record<string, string> = {}
  for (let i = chain.length - 1; i >= 0; i--) {
    Object.assign(merged, chain[i].textures ?? {})
  }
  const textures = resolveTextureMap(merged)

  const source = chain.find((m) => Array.isArray(m.elements) && m.elements.length > 0)
  const elements: FlattenedElement[] = (source?.elements ?? []).map((el) => ({
    from: [Math.min(el.from[0], el.to[0]), Math.min(el.from[1], el.to[1]), Math.min(el.from[2], el.to[2])],
    to: [Math.max(el.from[0], el.to[0]), Math.max(el.from[1], el.to[1]), Math.max(el.from[2], el.to[2])],
    rotation: el.rotation,
    faces: Object.fromEntries(
      Object.entries(el.faces ?? {}).map(([dir, face]) => [
        dir,
        {
          texture: resolveFaceTexture(face.texture, textures),
          uv: face.uv,
          cullface: isFaceDir(face.cullface) ? face.cullface : undefined,
          rotation: face.rotation,
          tintindex: face.tintindex,
        },
      ]),
    ),
  }))
  return { elements, textures }
}

function resolveFaceTexture(tex: string, map: Record<string, string>): string {
  if (!tex.startsWith('#')) return tex
  const ref = tex.slice(1)
  return ref in map ? map[ref] : tex
}

function isFaceDir(v: string | undefined): v is FaceDir {
  return v === 'north' || v === 'south' || v === 'east' || v === 'west' || v === 'up' || v === 'down'
}

/** One output quad (template): block-local geometry, per-corner UVs in
 * 0..16 texture space, and culling/tint metadata. */
export interface Quad {
  /** 4 corner positions in block-local [0,1] space, CCW seen from outside. */
  positions: Vec3[]
  normal: Vec3
  /** UV bounds actually used (explicit or defaulted from element bounds). */
  uvRect: UvRect
  /** uvs[i] belongs to positions[i], values interpolated from uvRect. */
  uvs: [number, number][]
  texture: string
  /** Cull direction after variant x/y remap; undefined = never culled. */
  cullface?: FaceDir
  tintindex?: number
}

/** Variant-level x/y rotations from the blockstate file (quarter turns). */
export interface VariantRotation {
  x?: number
  y?: number
}

/**
 * Default face UV from the element bounds (vanilla FaceBakery rules).
 * v is measured from the texture's top edge, u/v follow each face's axes:
 * up/down u=x v=z (down flipped), north/east mirror u across the block.
 */
export function autoUV(dir: FaceDir, from: readonly number[], to: readonly number[]): UvRect {
  switch (dir) {
    case 'up':
      return [from[0], from[2], to[0], to[2]]
    case 'down':
      return [from[0], 16 - to[2], to[0], 16 - from[2]]
    case 'north':
      return [16 - to[0], 16 - to[1], 16 - from[0], 16 - from[1]]
    case 'south':
      return [from[0], 16 - to[1], to[0], 16 - from[1]]
    case 'west':
      return [from[2], 16 - to[1], to[2], 16 - from[1]]
    case 'east':
      return [16 - to[2], 16 - to[1], 16 - from[2], 16 - from[1]]
  }
}

/** Corner table per face direction, vanilla vertex order:
 * pos selects from/to per axis; uv is the (u,v) rect corner each vertex
 * receives (0/1 = uvRect[0]/uvRect[2] and uvRect[1]/uvRect[3]). */
const FACE_CORNERS: Record<FaceDir, { pos: ('f' | 't')[][]; uv: (0 | 1)[][] }> = {
  up: {
    pos: [['f', 't', 'f'], ['t', 't', 'f'], ['t', 't', 't'], ['f', 't', 't']],
    uv: [[0, 0], [1, 0], [1, 1], [0, 1]],
  },
  down: {
    pos: [['t', 'f', 't'], ['t', 'f', 'f'], ['f', 'f', 'f'], ['f', 'f', 't']],
    uv: [[1, 0], [1, 1], [0, 1], [0, 0]],
  },
  north: {
    pos: [['f', 'f', 'f'], ['f', 't', 'f'], ['t', 't', 'f'], ['t', 'f', 'f']],
    uv: [[1, 1], [1, 0], [0, 0], [0, 1]],
  },
  south: {
    pos: [['t', 'f', 't'], ['t', 't', 't'], ['f', 't', 't'], ['f', 'f', 't']],
    uv: [[1, 1], [1, 0], [0, 0], [0, 1]],
  },
  west: {
    pos: [['f', 'f', 't'], ['f', 't', 't'], ['f', 't', 'f'], ['f', 'f', 'f']],
    uv: [[1, 1], [1, 0], [0, 0], [0, 1]],
  },
  east: {
    pos: [['t', 'f', 'f'], ['t', 't', 'f'], ['t', 't', 't'], ['t', 'f', 't']],
    uv: [[1, 1], [1, 0], [0, 0], [0, 1]],
  },
}

const CENTER: Vec3 = [0.5, 0.5, 0.5]

/** ((angle/90) rounded mod 4) → 0..3 quarter turns. */
function quarterTurns(angle: number | undefined): number {
  return ((Math.round((angle ?? 0) / 90) % 4) + 4) % 4
}

function rotateAroundAxis(p: Vec3, origin: Vec3, axis: 'x' | 'y' | 'z', degrees: number): Vec3 {
  if (degrees === 0) return p
  const rad = (degrees * Math.PI) / 180
  const c = Math.cos(rad)
  const s = Math.sin(rad)
  const [x, y, z] = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]
  let r: Vec3
  if (axis === 'x') r = [x, y * c - z * s, y * s + z * c]
  else if (axis === 'y') r = [x * c + z * s, y, -x * s + z * c]
  else r = [x * c - y * s, x * s + y * c, z]
  return [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]]
}

/** Exact +90°-turn rotation around an axis through `origin`; repeat k times. */
function quarterRotate(p: Vec3, origin: Vec3, axis: 'x' | 'y' | 'z', k: number): Vec3 {
  let out: Vec3 = [p[0], p[1], p[2]]
  for (let i = 0; i < k; i++) {
    const [x, y, z] = [out[0] - origin[0], out[1] - origin[1], out[2] - origin[2]]
    // Right-hand rule quarter turns: x: y→z, y: z→x, z: x→y.
    const r: Vec3 =
      axis === 'x' ? [x, -z, y] : axis === 'y' ? [z, y, -x] : [-y, x, z]
    out = [r[0] + origin[0], r[1] + origin[1], r[2] + origin[2]]
  }
  return out
}

/** Remap a cull direction through the variant's x then y quarter turns. */
function remapCullface(dir: FaceDir, xTurns: number, yTurns: number): FaceDir {
  let v: Vec3 = [...FACE_NORMALS[dir]] as Vec3
  if (xTurns) v = quarterRotate(v, [0, 0, 0], 'x', xTurns)
  if (yTurns) v = quarterRotate(v, [0, 0, 0], 'y', yTurns)
  const found = (Object.keys(FACE_NORMALS) as FaceDir[]).find(
    (d) => FACE_NORMALS[d][0] === v[0] && FACE_NORMALS[d][1] === v[1] && FACE_NORMALS[d][2] === v[2],
  )
  return found ?? dir
}

/**
 * Compile a flattened model into face quad templates in block-local space.
 * `variant` rotates the whole block x-then-y around its center (quarter
 * turns) and remaps cullface directions accordingly. Face UVs stay in the
 * model's 0..16 texture space; atlas mapping happens downstream.
 */
export function compileGeometry(model: FlattenedModel, variant: VariantRotation = {}): Quad[] {
  const quads: Quad[] = []
  // Vanilla blockstate x/y angles rotate clockwise seen from the positive
  // axis end (negative right-hand turns): y=90 maps north→east (furnace
  // facing=east), x=90 maps up→north (end_rod facing=north).
  const xTurns = quarterTurns(variant.x === undefined ? undefined : -variant.x)
  const yTurns = quarterTurns(variant.y === undefined ? undefined : -variant.y)

  for (const el of model.elements) {
    const from: Vec3 = [el.from[0] / 16, el.from[1] / 16, el.from[2] / 16]
    const to: Vec3 = [el.to[0] / 16, el.to[1] / 16, el.to[2] / 16]

    for (const dir of FACE_DIRS) {
      const face = el.faces[dir]
      if (!face) continue

      const uvRect: UvRect = face.uv ?? autoUV(dir, el.from, el.to)
      const corners = FACE_CORNERS[dir]
      // Face rotation shifts which base uv corner each vertex receives
      // (vanilla getShiftedIndex: (i + rotation/90) % 4).
      const shift = ((face.rotation ?? 0) / 90) % 4
      let positions: Vec3[] = corners.pos.map((sel) => [
        sel[0] === 'f' ? from[0] : to[0],
        sel[1] === 'f' ? from[1] : to[1],
        sel[2] === 'f' ? from[2] : to[2],
      ])
      let uvs: [number, number][] = corners.uv.map((_, i) => {
        const [cu, cv] = corners.uv[(i + shift) % 4]
        return [uvRect[cu * 2], uvRect[1 + cv * 2]]
      })

      // Winding: three.js front faces are CCW seen from outside; vanilla's
      // table order differs on ±Y, so normalize per quad (uv stays glued).
      const e1 = sub(positions[1], positions[0])
      const e2 = sub(positions[2], positions[0])
      const n = FACE_NORMALS[dir]
      if (dot(cross(e1, e2), n) < 0) {
        positions = positions.slice().reverse()
        uvs = uvs.slice().reverse()
      }

      // Element rotation around its own origin (arbitrary angle, right-hand).
      let normal: Vec3 = [n[0], n[1], n[2]]
      if (el.rotation && el.rotation.angle) {
        const o: Vec3 = [el.rotation.origin[0] / 16, el.rotation.origin[1] / 16, el.rotation.origin[2] / 16]
        positions = positions.map((p) => rotateAroundAxis(p, o, el.rotation!.axis, el.rotation!.angle))
        normal = rotateAroundAxis(normal, [0, 0, 0], el.rotation.axis, el.rotation.angle)
      }

      // Variant rotation: x then y quarter turns around the block center.
      if (xTurns) {
        positions = positions.map((p) => quarterRotate(p, CENTER, 'x', xTurns))
        normal = quarterRotate(normal, [0, 0, 0], 'x', xTurns)
      }
      if (yTurns) {
        positions = positions.map((p) => quarterRotate(p, CENTER, 'y', yTurns))
        normal = quarterRotate(normal, [0, 0, 0], 'y', yTurns)
      }

      quads.push({
        positions,
        normal,
        uvRect,
        uvs,
        texture: face.texture,
        cullface: face.cullface !== undefined ? remapCullface(face.cullface, xTurns, yTurns) : undefined,
        tintindex: face.tintindex,
      })
    }
  }
  return quads
}

/**
 * True when the model is a single element spanning the full 0..16 block
 * without rotation — i.e. the block fully occludes its neighbors' faces.
 */
export function isFullCube(model: FlattenedModel): boolean {
  if (model.elements.length !== 1) return false
  const el = model.elements[0]
  if (el.rotation && el.rotation.angle % 360 !== 0) return false
  return el.from.every((v) => v <= 0) && el.to.every((v) => v >= 16)
}

function sub(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a: readonly number[], b: readonly number[]): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}
