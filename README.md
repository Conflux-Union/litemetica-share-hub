# Litematica Share Hub

Share and preview [Litematica](https://modrinth.com/mod/litematica) schematics (`.litematic`) online.

- **Backend**: Rust (axum + rusqlite + rustmatica), single binary that also serves the built frontend
- **Frontend**: Vue 3 + Vite + TypeScript, styled with [zhimo-ui](https://github.com/Conflux-Union/zhimo-ui) web components
- **Auth**: [RMSSSO](https://sso.cxu.org.cn) OAuth 2.0 (authorization code + PKCE); no local passwords
- **3D preview**: browser-side voxel rendering with extracted vanilla textures (three.js)
- **Material list**: server-side palette counting with Chinese block names
- **Download quota**: anonymous downloads limited per IP (default 3 per minute, configurable); logged-in users unrestricted

## Features

| Feature | Notes |
|---|---|
| Upload `.litematic` | Login required; parsed server-side for metadata, materials, and a compressed RLE preview |
| Online 3D preview | Runs entirely from the server-generated preview data; the original file is never exposed except through the rate-limited download endpoint |
| Material list | Chinese names, per-item counts, search/sort, block icons |
| Schematic info | Minecraft version (DataVersion), Litematica format version, size, block/volume counts, author |
| Anonymous download | Per-IP sliding-window quota with `Retry-After` on 429 |
| Dark mode | Follows zhimo-ui `data-theme="dark"` |

## Setup

Requires Rust 1.75+ and Node 18+.

```bash
# 1. Frontend build (embedded into the binary at compile time)
cd frontend && npm install && npm run build && cd ..

# 2. Config
cp config.example.toml config.toml
#    - Fill sso.client_id / client_secret after registering this app in the
#      RMSSSO admin panel (redirect_uri must match exactly).
#    - Tune [limits] as needed.

# 3. Build & run
cd backend && cargo build --release
cd .. && ./backend/target/release/Litematica-share-hub
```

Development mode: run the backend (`cargo run`), then `npm run dev` in `frontend/`
(the Vite dev server proxies `/api` and `/oauth` to `localhost:8080`).

## Texture atlas (3D preview textures)

The preview renders with real block textures. Generate the atlas once after
building:

```bash
# Downloads the client jar from Mojang's official piston-meta endpoint
./backend/target/release/Litematica-share-hub extract-textures

# Or pin a version / use a local jar:
./backend/target/release/Litematica-share-hub extract-textures --version 1.21.4
./backend/target/release/Litematica-share-hub extract-textures --jar /path/to/client.jar
```

The command extracts `assets/minecraft/textures/block/*.png`, resolves
blockstates → models → per-face textures (top/side/bottom, `#ref` indirection,
animation strips, biome tints), and bakes a single atlas into
`data/textures/` (content-hashed filename, long-lived caching).

Without an atlas the viewer falls back to flat per-block colors.

> Textures are Mojang assets fetched on demand from official endpoints for
> deployment-local use only (`data/` is gitignored); nothing is redistributed
> with this repository or binary. A resource pack zip placed at
> `data/resourcepack.zip`… (resource-pack override is planned; jar path works today.)

## Configuration

See `config.example.toml`. Key options:

| Option | Default | Meaning |
|---|---|---|
| `listen` | `0.0.0.0:8080` | Bind address |
| `data_dir` | `data` | DB, schematics, previews, textures live here |
| `sso.*` | — | RMSSSO endpoints and OAuth client credentials |
| `limits.download_per_ip` | `3` | Anonymous downloads per IP per window |
| `limits.download_window_secs` | `60` | Sliding window length |
| `limits.max_upload_mb` | `64` | Upload size cap |
| `limits.min_permission_level` | `1` | RMSSSO permission level required to upload |
| `limits.trust_x_forwarded_for` | `false` | Enable behind a reverse proxy |

## API overview

| Endpoint | Description |
|---|---|
| `GET /api/auth/login` | Redirect to RMSSSO authorize (PKCE S256) |
| `GET /oauth/callback` | OAuth callback; sets local session cookie |
| `GET /api/auth/me` / `POST /api/auth/logout` | Session info / logout (+ SSO revoke) |
| `GET /api/schematics?page&size&q` | Paginated list |
| `POST /api/schematics` | Multipart upload (login required) |
| `GET /api/schematics/{id}` | Detail incl. materials and anonymous quota |
| `GET /api/schematics/{id}/preview` | Gzipped RLE voxel data (not rate limited) |
| `GET /api/schematics/{id}/download` | Original file (anonymous: per-IP quota) |
| `DELETE /api/schematics/{id}` | Uploader only |
| `GET /api/textures/manifest` / `GET /api/textures/{atlas}` | Texture atlas metadata/PNG |

## Development

```bash
# Backend tests (incl. RLE roundtrip + a generated sample house)
cd backend && cargo test

# Regenerate static tables (data versions, zh_cn block names)
python tools/gen_static_data.py

# Lints
cd backend && cargo clippy --all-targets && cargo fmt --check
cd frontend && npm run typecheck
```

## License

GPL-3.0-only — see [LICENSE](LICENSE). Frontend dependencies: zhimo-ui (MIT), Vue/three/fflate (MIT).
