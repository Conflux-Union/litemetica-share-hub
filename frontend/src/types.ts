export interface User {
  id: number
  username: string
  nickname: string
  avatar_url: string | null
  permission_level: number
}

export interface SchematicSummary {
  id: string
  name: string
  author: string
  description: string
  uploader: string
  size_bytes: number
  mc_version_name: string
  mc_data_version: number
  litematica_version: number
  width: number
  height: number
  depth: number
  region_count: number
  total_blocks: number
  created_at: number
}

export interface MaterialEntry {
  item_id: string
  name_zh: string
  count: number
}

export interface SchematicDetail extends SchematicSummary {
  original_filename: string
  materials: MaterialEntry[]
  can_delete: boolean
  download_remaining: number | null
}

export interface ListResponse {
  total: number
  page: number
  size: number
  items: SchematicSummary[]
}

export interface SiteConfig {
  site_name: string
  download_per_ip: number
  download_window_secs: number
  max_upload_mb: number
}

export interface RegionPreview {
  name: string
  pos: [number, number, number]
  size: [number, number, number]
  /** Schema 2: canonical full-state strings; schema 1: bare block ids
   * (valid property-less state strings). */
  palette: string[]
  rle: [number, number][]
}

export interface PreviewData {
  /** 1 = bare-id palette (legacy), 2 = full-state-string palette. Absent
   * on stored schema-1 previews, so treat undefined as 1. */
  schema?: number
  size: [number, number, number]
  regions: RegionPreview[]
}

// ---------------------------------------------------------------------------
// Render-bundle wire types (GET /api/textures/bundle, gzip JSON; see
// backend/src/textures.rs build_bundle for the emitter).
// ---------------------------------------------------------------------------

export type AlphaClass = 'opaque' | 'cutout' | 'translucent'

/** Newer (26.x) model JSON wraps texture values in an object; the sprite id
 * is the only field the renderer needs. */
export interface SpriteRef {
  sprite: string
  force_translucent?: boolean
}

/** Verbatim model JSON as carried by the bundle. `elements` are trusted
 * passthrough for the model layer (render/model); assets.ts only unwraps
 * the `textures` values. */
export interface BundleModel {
  parent?: string
  ambientocclusion?: boolean
  textures?: Record<string, string | SpriteRef>
  elements?: unknown[]
}

export interface BundleTexture {
  /** Atlas grid cell [col, row]; pixel rect = [col*tile, row*tile,
   * (col+1)*tile, (row+1)*tile]. */
  uv: [number, number]
  alpha: AlphaClass
}

export interface AssetBundle {
  formatVersion: number
  minecraftVersion: string
  /** Content-hashed atlas filename, e.g. "atlas-38ab7aad.png". */
  atlas: string
  grid: number
  tile: number
  /** Keyed "minecraft:block/<name>", vanilla blockstate JSON verbatim. */
  blockStates: Record<string, unknown>
  /** Keyed "minecraft:block/<path>", vanilla model JSON verbatim. */
  blockModels: Record<string, BundleModel>
  textures: Record<string, BundleTexture>
  /** 0..255 rgb sampled from the colormaps' center pixels (default biome). */
  tintColors: Partial<Record<'grass' | 'foliage', [number, number, number]>>
}
