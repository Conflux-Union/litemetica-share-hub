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

export interface TextureManifest {
  version: string
  atlas: string
  grid: number
  tile: number
  blocks: Record<
    string,
    { top: string; side: string; bottom: string; uv: [number, number][] }
  >
}

export interface RegionPreview {
  name: string
  pos: [number, number, number]
  size: [number, number, number]
  palette: string[]
  rle: [number, number][]
}

export interface PreviewData {
  size: [number, number, number]
  regions: RegionPreview[]
}
