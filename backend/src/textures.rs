//! Vanilla texture extraction: download the client jar from Mojang's official
//! piston-meta endpoint (or use a local jar / resource pack), extract block
//! textures, resolve blockstates -> models -> texture names, and bake a single
//! atlas PNG plus a manifest the frontend can consume.
//!
//! Extracted assets stay in the deployment-local `data/` directory; nothing is
//! redistributed with the repository or binary.

use crate::error::AppError;
use axum::response::IntoResponse;
use serde_json::{json, Value};
use sha2::Digest;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

const TILE: u32 = 16;

pub struct TextureOptions {
    pub version: Option<String>,
    pub jar_path: Option<PathBuf>,
    pub data_dir: PathBuf,
}

pub async fn run_extract_textures(opts: TextureOptions) -> Result<(), String> {
    let (jar_path, version) = determine_jar(&opts).await?;
    println!("using jar: {} (version {version})", jar_path.display());
    let jar_bytes = std::fs::read(&jar_path).map_err(|e| format!("read jar: {e}"))?;
    build_atlas(&jar_bytes, &opts.data_dir, &version)?;
    println!(
        "atlas written to {}",
        opts.data_dir.join("textures").display()
    );
    Ok(())
}

async fn determine_jar(opts: &TextureOptions) -> Result<(PathBuf, String), String> {
    if let Some(p) = &opts.jar_path {
        return Ok((
            p.clone(),
            opts.version.clone().unwrap_or_else(|| "local jar".into()),
        ));
    }
    let local = opts.data_dir.join("client.jar");
    if local.exists() {
        return Ok((
            local,
            opts.version.clone().unwrap_or_else(|| "local jar".into()),
        ));
    }
    let version = match &opts.version {
        Some(v) => v.clone(),
        None => latest_release_version().await?,
    };
    println!("downloading client jar for version {version} ...");
    let url = client_jar_url(&version).await?;
    let bytes = stateless_http_get(&url).await?;
    std::fs::create_dir_all(&opts.data_dir).map_err(|e| e.to_string())?;
    let path = opts.data_dir.join("client.jar");
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;
    println!("saved {}", path.display());
    Ok((path, version))
}

async fn latest_release_version() -> Result<String, String> {
    let manifest: Value = serde_json::from_slice(
        &stateless_http_get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
            .await?,
    )
    .map_err(|e| e.to_string())?;
    Ok(manifest["latest"]["release"]
        .as_str()
        .ok_or("manifest missing latest.release")?
        .to_string())
}

async fn client_jar_url(version: &str) -> Result<String, String> {
    let manifest: Value = serde_json::from_slice(
        &stateless_http_get("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json")
            .await?,
    )
    .map_err(|e| e.to_string())?;
    let entry = manifest["versions"]
        .as_array()
        .ok_or("manifest missing versions")?
        .iter()
        .find(|v| v["id"] == version)
        .ok_or_else(|| format!("version {version} not found in manifest"))?;
    let version_url = entry["url"].as_str().ok_or("version entry missing url")?;
    let version_json: Value = serde_json::from_slice(&stateless_http_get(version_url).await?)
        .map_err(|e| e.to_string())?;
    version_json["downloads"]["client"]["url"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "version json missing client download url".into())
}

async fn stateless_http_get(url: &str) -> Result<Vec<u8>, String> {
    let http = reqwest::Client::builder()
        .user_agent("litemetica-share-hub")
        .build()
        .map_err(|e| e.to_string())?;
    let resp = http.get(url).send().await.map_err(|e| e.to_string())?;
    resp.error_for_status()
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| e.to_string())
}

/// Where to read assets from: a client jar, or a resource pack zip (same layout).
fn open_zip(bytes: &[u8]) -> Result<zip::ZipArchive<std::io::Cursor<&[u8]>>, String> {
    zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("open zip/jar: {e}"))
}

fn read_zip_file(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    name: &str,
) -> Option<Vec<u8>> {
    let mut f = archive.by_name(name).ok()?;
    let mut buf = Vec::new();
    f.read_to_end(&mut buf).ok()?;
    Some(buf)
}

fn build_atlas(jar_bytes: &[u8], data_dir: &Path, version: &str) -> Result<(), String> {
    let mut archive = open_zip(jar_bytes)?;

    // 1. Collect blockstates -> model name for every block.
    let mut block_model: HashMap<String, String> = HashMap::new(); // block id (no ns) -> model path
    let zip_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();
    for name in &zip_names {
        // e.g. assets/minecraft/blockstates/stone.json
        let Some(block_id) = name
            .strip_prefix("assets/minecraft/blockstates/")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        let Some(bytes) = read_zip_file(&mut archive, name) else {
            continue;
        };
        let Ok(state) = serde_json::from_slice::<Value>(&bytes) else {
            continue;
        };
        if let Some(model) = default_variant_model(&state) {
            block_model.insert(block_id.to_string(), model);
        }
    }
    println!("collected {} blockstates", block_model.len());

    // 2. Parse all block models: model path -> textures map (after parent merge).
    let mut raw_models: HashMap<String, Value> = HashMap::new();
    for name in &zip_names {
        // e.g. assets/minecraft/models/block/stone.json
        let Some(model_path) = name
            .strip_prefix("assets/minecraft/models/block/")
            .and_then(|s| s.strip_suffix(".json"))
            .map(|s| format!("minecraft:block/{s}"))
        else {
            continue;
        };
        if let Some(bytes) = read_zip_file(&mut archive, name) {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                raw_models.insert(model_path, v);
            }
        }
    }
    println!("collected {} models", raw_models.len());

    let model_textures = |path: &str| -> Option<HashMap<String, String>> {
        let mut chain: Vec<&Value> = Vec::new();
        let mut cur = ns_model(path);
        for _ in 0..8 {
            let v = raw_models.get(&cur)?;
            chain.push(v);
            match v.get("parent").and_then(|p| p.as_str()) {
                // Builtin parents (e.g. builtin/generated) have no file; stop the chain.
                Some(p) if p.starts_with("builtin/") => break,
                Some(p) => cur = ns_model(p),
                None => break,
            }
        }
        let mut merged: HashMap<String, String> = HashMap::new();
        for v in chain.iter().rev() {
            if let Some(tex) = v.get("textures").and_then(|t| t.as_object()) {
                for (k, val) in tex {
                    if let Some(s) = val.as_str() {
                        merged.insert(k.clone(), s.to_string());
                    }
                }
            }
        }
        // Texture values may reference other keys ("up": "#all"); resolve them.
        let resolve = |key: &str| -> Option<String> {
            let mut cur = merged.get(key)?.clone();
            for _ in 0..5 {
                match cur.strip_prefix('#') {
                    Some(next) => cur = merged.get(next)?.clone(),
                    None => return Some(cur),
                }
            }
            None
        };
        let mut resolved: HashMap<String, String> = HashMap::new();
        for k in merged.keys() {
            if let Some(v) = resolve(k) {
                resolved.insert(k.clone(), v);
            }
        }
        Some(resolved)
    };

    // 3. For each block, resolve top/side/bottom texture file names.
    let mut faces_by_block: HashMap<String, [String; 3]> = HashMap::new();
    let mut needed_files: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (block, model) in &block_model {
        let Some(tex) = model_textures(model) else {
            continue;
        };
        let pick = |keys: &[&str]| -> Option<String> {
            for k in keys {
                if let Some(v) = tex.get(*k) {
                    return Some(texture_file_name(v));
                }
            }
            None
        };
        let top = pick(&["up", "top", "end", "all", "particle"]);
        let side = pick(&["north", "side", "all", "end", "particle"]);
        let bottom = pick(&["down", "bottom", "end", "all", "particle"]);
        let (Some(top), Some(side), Some(bottom)) = (top, side, bottom) else {
            continue;
        };
        for f in [&top, &side, &bottom] {
            needed_files.insert(f.clone());
        }
        faces_by_block.insert(block.clone(), [top, side, bottom]);
    }
    println!(
        "resolved faces for {} blocks ({} distinct textures)",
        faces_by_block.len(),
        needed_files.len()
    );

    // 4. Decode + normalize every needed texture to a 16x16 RGBA tile.
    let mut tiles: HashMap<String, image::RgbaImage> = HashMap::new();
    for file in &needed_files {
        let zip_name = format!("assets/minecraft/textures/{file}.png");
        let Some(bytes) = read_zip_file(&mut archive, &zip_name) else {
            continue;
        };
        let Ok(img) = image::load_from_memory(&bytes) else {
            continue;
        };
        let tile = normalize_tile(&img.to_rgba8(), file);
        tiles.insert(file.clone(), tile);
    }
    println!("decoded {} tiles", tiles.len());

    // Drop blocks whose textures are missing.
    let faces_by_block: HashMap<String, [String; 3]> = faces_by_block
        .into_iter()
        .filter(|(_, f)| {
            tiles.contains_key(&f[0]) && tiles.contains_key(&f[1]) && tiles.contains_key(&f[2])
        })
        .collect();

    // 5. Lay tiles out in a square grid atlas.
    let ordered: Vec<&String> = {
        let mut v: Vec<&String> = tiles.keys().collect();
        v.sort();
        v
    };
    let grid = (ordered.len() as f64).sqrt().ceil().max(1.0) as u32;
    let atlas_size = grid * TILE;
    let mut atlas = image::RgbaImage::new(atlas_size, atlas_size);
    let mut uv: HashMap<String, [u32; 2]> = HashMap::new();
    for (i, file) in ordered.iter().enumerate() {
        let col = (i as u32) % grid;
        let row = (i as u32) / grid;
        let tile = &tiles[*file];
        image::imageops::overlay(&mut atlas, tile, (col * TILE) as i64, (row * TILE) as i64);
        uv.insert((*file).clone(), [col, row]);
    }

    // 6. Write outputs with a content hash in the atlas filename for long-lived caching.
    let out_dir = data_dir.join("textures");
    std::fs::create_dir_all(&out_dir).map_err(|e| e.to_string())?;
    let png_bytes = encode_png(&atlas)?;
    let digest = sha2::Sha256::digest(&png_bytes);
    let hash = format!(
        "{:08x}",
        u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]])
    );
    let atlas_name = format!("atlas-{hash}.png");
    std::fs::write(out_dir.join(&atlas_name), &png_bytes).map_err(|e| e.to_string())?;

    let tiles_json: serde_json::Map<String, Value> = faces_by_block
        .iter()
        .map(|(block, [top, side, bottom])| {
            (
                format!("minecraft:{block}"),
                json!({
                    "top": top, "side": side, "bottom": bottom,
                    "uv": [uv[top], uv[side], uv[bottom]],
                }),
            )
        })
        .collect();
    let manifest = json!({
        "version": version,
        "atlas": atlas_name,
        "grid": grid,
        "tile": TILE,
        "blocks": tiles_json,
    });
    std::fs::write(
        out_dir.join("manifest.json"),
        serde_json::to_vec(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Pick the model used by the default (empty or first) variant of a blockstate.
fn default_variant_model(state: &Value) -> Option<String> {
    if let Some(variants) = state.get("variants").and_then(|v| v.as_object()) {
        let entry = variants.get("").or_else(|| variants.values().next())?;
        let model = match entry {
            Value::Array(arr) => arr.first()?["model"].as_str()?,
            Value::Object(_) => entry["model"].as_str()?,
            _ => return None,
        };
        return Some(ns_model(model));
    }
    if let Some(multipart) = state.get("multipart").and_then(|m| m.as_array()) {
        let first = multipart.first()?;
        let apply = &first["apply"];
        let model = match apply {
            Value::Array(arr) => arr.first()?["model"].as_str()?,
            _ => apply["model"].as_str()?,
        };
        return Some(ns_model(model));
    }
    None
}

/// "block/stone" -> "minecraft:block/stone" (already-namespaced stays as-is).
fn ns_model(m: &str) -> String {
    if m.contains(':') {
        m.to_string()
    } else {
        format!("minecraft:{m}")
    }
}

/// "minecraft:block/stone" -> "block/stone" (path under assets/minecraft/textures/,
/// without extension). References outside block/ (entity/, environment/...) keep
/// their directory so the file can still be located in the jar.
fn texture_file_name(v: &str) -> String {
    let no_ns = v.rsplit(':').next().unwrap_or(v);
    no_ns.trim_end_matches(".png").to_string()
}

/// Normalize an arbitrary texture to a 16x16 tile: animated strips keep their
/// first frame, other sizes are nearest-neighbor resized.
fn normalize_tile(img: &image::RgbaImage, file: &str) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    let mut tile: image::RgbaImage = if w == TILE && h == TILE {
        img.clone()
    } else if w == TILE && h > TILE {
        // Vertical animation strip: take the first frame.
        image::imageops::crop_imm(img, 0, 0, TILE, TILE).to_image()
    } else {
        image::imageops::resize(img, TILE, TILE, image::imageops::FilterType::Nearest)
    };

    // Bake biome tints for grayscale template textures.
    let tint = tint_for(file);
    if let Some([tr, tg, tb]) = tint {
        for px in tile.pixels_mut() {
            px[0] = (px[0] as u32 * tr as u32 / 255) as u8;
            px[1] = (px[1] as u32 * tg as u32 / 255) as u8;
            px[2] = (px[2] as u32 * tb as u32 / 255) as u8;
        }
    }
    tile
}

fn tint_for(file: &str) -> Option<[u8; 3]> {
    const GRASS: [u8; 3] = [0x91, 0xBD, 0x59];
    const FOLIAGE: [u8; 3] = [0x77, 0xAB, 0x2F];
    const WATER: [u8; 3] = [0x3F, 0x76, 0xE4];
    // file may carry a directory prefix (e.g. "block/grass_block_top").
    let name = file.strip_prefix("block/").unwrap_or(file);
    if name.starts_with("water_") {
        return Some(WATER);
    }
    let grass_templates = [
        "grass_block_top",
        "short_grass",
        "tall_grass_top",
        "tall_grass_bottom",
        "fern",
        "large_fern_top",
        "large_fern_bottom",
        "grass",
        "sugar_cane",
        "seagrass",
        "tall_seagrass_top",
        "tall_seagrass_bottom",
        "kelp",
        "kelp_plant",
    ];
    if grass_templates.contains(&name) {
        return Some(GRASS);
    }
    if name.ends_with("_leaves") && name != "pale_oak_leaves" {
        return Some(FOLIAGE);
    }
    if name == "vine" {
        return Some(FOLIAGE);
    }
    None
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

/// Serve the texture manifest (404 when no atlas has been extracted).
pub async fn serve_manifest(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
) -> Result<axum::response::Response, AppError> {
    let path = state.config.data_dir.join("textures").join("manifest.json");
    let bytes = std::fs::read(&path).map_err(|_| AppError::NotFound)?;
    Ok((
        axum::http::StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/json"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    )
        .into_response())
}

/// Serve the atlas PNG. The filename carries a content hash; the manifest
/// tells clients which file to request.
pub async fn serve_atlas(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
    axum::extract::Path(name): axum::extract::Path<String>,
) -> Result<axum::response::Response, AppError> {
    // Only allow the exact pattern atlas-<8 hex>.png to avoid arbitrary file reads.
    let valid = name.len() == 6 + 8 + 4
        && name.starts_with("atlas-")
        && name.ends_with(".png")
        && name[6..14].bytes().all(|b| b.is_ascii_hexdigit());
    if !valid {
        return Err(AppError::BadRequest("invalid atlas name".into()));
    }
    let path = state.config.data_dir.join("textures").join(&name);
    let bytes = std::fs::read(&path).map_err(|_| AppError::NotFound)?;
    Ok((
        axum::http::StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "image/png"),
            (
                axum::http::header::CACHE_CONTROL,
                "public, max-age=31536000, immutable",
            ),
        ],
        bytes,
    )
        .into_response())
}
