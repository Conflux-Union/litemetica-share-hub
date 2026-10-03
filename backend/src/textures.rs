//! Vanilla asset extraction v2: from the client jar (downloaded from Mojang's
//! official piston-meta endpoint, or a local jar), bake one gzip JSON render
//! bundle plus a 16px-tile atlas PNG:
//!
//! - blockstate JSON verbatim, keyed `minecraft:block/<name>`
//! - block model JSON verbatim for every model reachable from a blockstate
//!   (parent-chain closure; `builtin/*` parents stop the walk)
//! - an atlas containing every texture referenced by those models plus the
//!   grass/foliage colormaps, with per-texture uv and alpha class
//!   (opaque / cutout / translucent, known translucent families overridden)
//! - default-biome tint colors sampled from the colormap center pixels
//!
//! Extracted assets stay in the deployment-local `data/` directory; nothing
//! from the jar is redistributed with the repository or binary.

use crate::error::AppError;
use axum::response::IntoResponse;
use serde_json::{json, Map, Value};
use sha2::Digest;
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const TILE: u32 = 16;
const BUNDLE_FORMAT_VERSION: u32 = 2;

pub struct TextureOptions {
    pub version: Option<String>,
    pub jar_path: Option<PathBuf>,
    pub data_dir: PathBuf,
}

pub async fn run_extract_textures(opts: TextureOptions) -> Result<(), String> {
    let (jar_path, version) = determine_jar(&opts).await?;
    println!("using jar: {} (version {version})", jar_path.display());
    let jar_bytes = std::fs::read(&jar_path).map_err(|e| format!("read jar: {e}"))?;
    // A local jar without --version still gets a meaningful bundle version.
    let version = match version.as_str() {
        "local jar" => jar_reported_version(&jar_bytes).unwrap_or(version),
        _ => version,
    };
    build_bundle(&jar_bytes, &opts.data_dir, &version)?;
    println!(
        "bundle written to {}",
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

/// The release name a client jar reports about itself (version.json).
fn jar_reported_version(jar_bytes: &[u8]) -> Option<String> {
    let mut archive = open_zip(jar_bytes).ok()?;
    let bytes = read_zip_file(&mut archive, "version.json")?;
    let v: Value = serde_json::from_slice(&bytes).ok()?;
    v["name"].as_str().map(|s| s.to_string())
}

fn build_bundle(jar_bytes: &[u8], data_dir: &Path, version: &str) -> Result<(), String> {
    let mut archive = open_zip(jar_bytes)?;
    let zip_names: Vec<String> = archive.file_names().map(|s| s.to_string()).collect();

    // 1. Blockstate JSON verbatim, keyed minecraft:block/<name>.
    let mut block_states: Map<String, Value> = Map::new();
    for name in &zip_names {
        let Some(block) = name
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
        block_states.insert(format!("minecraft:block/{block}"), state);
    }
    println!("collected {} blockstates", block_states.len());

    // 2. Every model JSON in the jar, keyed minecraft:block/<path> style.
    let mut raw_models: HashMap<String, Value> = HashMap::new();
    for name in &zip_names {
        let Some(path) = name
            .strip_prefix("assets/minecraft/models/")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        if let Some(bytes) = read_zip_file(&mut archive, name) {
            if let Ok(v) = serde_json::from_slice::<Value>(&bytes) {
                raw_models.insert(format!("minecraft:{path}"), v);
            }
        }
    }
    println!("collected {} models", raw_models.len());

    // 2.5. Chests are entity-rendered in vanilla (their blockstates point at
    // element-less models), which would leave placeholder cubes. Synthesize
    // real block models from the entity textures, with facing/type variants,
    // and crop the 64x64 entity layouts into per-face atlas tiles.
    let mut derived_tiles: HashMap<String, image::RgbaImage> = HashMap::new();
    let chest_families = synthesize_chests(&mut block_states, &mut raw_models, &mut archive, &mut derived_tiles);
    println!("synthesized chest models for {chest_families} families ({} derived tiles)", derived_tiles.len());

    // 3. Keep only models reachable from any blockstate via parent chains.
    let seeds: Vec<String> = block_states
        .values()
        .flat_map(|state| blockstate_models(state).into_iter())
        .collect();
    let closure = collect_model_closure(&raw_models, seeds);
    println!(
        "model closure: {} models reachable from blockstates",
        closure.len()
    );
    let block_models: Map<String, Value> = closure
        .iter()
        .filter_map(|key| raw_models.get(key).map(|v| (key.clone(), v.clone())))
        .collect();

    // 4. Collect every texture referenced by a reachable model.
    let mut texture_ids: BTreeSet<String> = BTreeSet::new();
    for key in &closure {
        for id in model_texture_ids(&raw_models[key]) {
            texture_ids.insert(id);
        }
    }
    // Colormaps ride along as atlas tiles and provide the sampled tint colors.
    texture_ids.insert("minecraft:colormap/grass".into());
    texture_ids.insert("minecraft:colormap/foliage".into());

    // 5. Decode every texture, normalize it to a 16px tile, classify alpha,
    //    and sample the colormaps' center pixels for default-biome tints.
    let mut tiles: HashMap<String, image::RgbaImage> = HashMap::new();
    let mut alpha_classes: HashMap<String, AlphaClass> = HashMap::new();
    let mut tint_colors: Map<String, Value> = Map::new();
    let mut missing = 0usize;
    for id in &texture_ids {
        let zip_name = texture_zip_name(id);
        let Some(bytes) = read_zip_file(&mut archive, &zip_name) else {
            missing += 1;
            continue;
        };
        let Ok(img) = image::load_from_memory(&bytes) else {
            missing += 1;
            continue;
        };
        let rgba = img.to_rgba8();
        if let Some(name) = colormap_name(id) {
            let (w, h) = rgba.dimensions();
            let px = rgba.get_pixel(w / 2, h / 2);
            tint_colors.insert(name.to_string(), json!([px[0], px[1], px[2]]));
        }
        let short = id.split_once(':').map_or(id.as_str(), |(_, p)| p);
        alpha_classes.insert(id.clone(), classify_texture_alpha(&rgba, short));
        tiles.insert(id.clone(), normalize_tile(&rgba));
    }
    println!(
        "decoded {} tiles ({} missing from jar)",
        tiles.len(),
        missing
    );

    // 5.5. Derived chest tiles are not jar files; they enter the atlas the
    // same way, classified from their own pixels (regions padded with
    // transparency classify as cutout, which is correct for chests).
    for (id, tile) in &derived_tiles {
        alpha_classes.insert(id.clone(), alpha_class_of(tile.pixels().map(|p| p.0[3])));
        tiles.insert(id.clone(), tile.clone());
    }

    // 6. Lay tiles out in a square grid atlas.
    let ordered: Vec<&String> = {
        let mut v: Vec<&String> = tiles.keys().collect();
        v.sort();
        v
    };
    let grid = (ordered.len() as f64).sqrt().ceil().max(1.0) as u32;
    let atlas_size = grid * TILE;
    let mut atlas = image::RgbaImage::new(atlas_size, atlas_size);
    let mut uv: HashMap<String, [u32; 2]> = HashMap::new();
    for (i, id) in ordered.iter().enumerate() {
        let col = (i as u32) % grid;
        let row = (i as u32) / grid;
        image::imageops::overlay(&mut atlas, &tiles[*id], (col * TILE) as i64, (row * TILE) as i64);
        uv.insert((*id).clone(), [col, row]);
    }

    // 7. Write outputs. The atlas filename carries a content hash for
    //    long-lived immutable caching; the bundle filename stays stable and
    //    points at the hashed atlas.
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
    // The v1 manifest is superseded by the bundle; drop it if present.
    let _ = std::fs::remove_file(out_dir.join("manifest.json"));

    let textures_json: Map<String, Value> = ordered
        .iter()
        .map(|id| {
            (
                (*id).clone(),
                json!({
                    "uv": uv[*id],
                    "alpha": alpha_classes[*id].as_str(),
                }),
            )
        })
        .collect();
    let bundle = json!({
        "formatVersion": BUNDLE_FORMAT_VERSION,
        "minecraftVersion": version,
        "atlas": atlas_name,
        "grid": grid,
        "tile": TILE,
        "blockStates": block_states,
        "blockModels": block_models,
        "textures": textures_json,
        "tintColors": tint_colors,
    });
    let json_bytes = serde_json::to_vec(&bundle).map_err(|e| e.to_string())?;
    let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    gz.write_all(&json_bytes).map_err(|e| e.to_string())?;
    let compressed = gz.finish().map_err(|e| e.to_string())?;
    std::fs::write(out_dir.join("bundle.json.gz"), &compressed).map_err(|e| e.to_string())?;
    println!(
        "atlas {atlas_name} ({}x{}px), bundle.json.gz {} bytes ({} uncompressed)",
        atlas_size,
        atlas_size,
        compressed.len(),
        json_bytes.len()
    );
    Ok(())
}

// ---- Chest model synthesis -------------------------------------------------
//
// Vanilla renders chests as block entities: their blockstates point at
// element-less models, so a model-based renderer shows placeholder cubes
// (Shulkr's packager solves this the same way — synthesized chest models).
// We build real block models from the 64x64 entity textures, whose box
// layouts are stable across versions and were verified against the actual
// jar textures (lid 14x5x14 @ texOffs(0,0), base 14x10x14 @ (0,19), latch
// 2x4x1 @ (0,0); double-chest halves are 15 wide).

/// Entity-texture stem (under assets/minecraft/textures/entity/chest/) for
/// each chest-family blockstate. Waxed variants share the plain textures;
/// trapped chests look identical to normal ones.
fn chest_texture_stem(block_id: &str) -> Option<&'static str> {
    let name = block_id.strip_prefix("minecraft:block/")?;
    Some(match name {
        "chest" | "trapped_chest" => "normal",
        "ender_chest" => "ender",
        "copper_chest" | "waxed_copper_chest" => "copper",
        "exposed_copper_chest" | "waxed_exposed_copper_chest" => "copper_exposed",
        "weathered_copper_chest" | "waxed_weathered_copper_chest" => "copper_weathered",
        "oxidized_copper_chest" | "waxed_oxidized_copper_chest" => "copper_oxidized",
        _ => return None,
    })
}

#[derive(Clone, Copy)]
struct Rect {
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

/// The six face rects of a vanilla entity box (w x h x d) at texOffs(u, v)
/// in the standard entity-atlas layout: up/down in the first row, then
/// [lateral, front, lateral, back] in the second.
fn box_face_rects(w: u32, h: u32, d: u32, u: u32, v: u32) -> [Rect; 6] {
    [
        Rect { x: u + d, y: v, w, h: d },
        Rect { x: u + d + w, y: v, w, h: d },
        Rect { x: u + d, y: v + d, w, h },
        Rect { x: u + 2 * d + w, y: v + d, w, h },
        Rect { x: u, y: v + d, w: d, h },
        Rect { x: u + d + w, y: v + d, w: d, h },
    ]
}

/// Crop one face region into its own transparent-padded 16x16 atlas tile.
fn crop_tile(src: &image::RgbaImage, r: Rect) -> image::RgbaImage {
    let mut tile = image::RgbaImage::new(TILE, TILE);
    let region = image::imageops::crop_imm(src, r.x, r.y, r.w, r.h).to_image();
    image::imageops::overlay(&mut tile, &region, 0, 0);
    tile
}

const CHEST_EPS: f64 = 0.002;

/// One chest body part (base or lid) as a model element. Each face samples
/// its own derived tile, so the uv is simply the region size. `prefix` names
/// the part (e.g. "base"); `w`/`h`/`d` are the entity box dims at texOffs
/// (u, v). Lateral (west/east) faces use the depth-sized rects.
fn chest_part_element(
    src: &image::RgbaImage,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
    tile_prefix: &str,
    part: &str,
    from: [f64; 3],
    to: [f64; 3],
    w: u32,
    h: u32,
    d: u32,
    u: u32,
    v: u32,
) -> (Value, Map<String, Value>) {
    let rects = box_face_rects(w, h, d, u, v);
    let dirs = ["up", "down", "north", "south", "west", "east"];
    let mut faces = Map::new();
    let mut textures = Map::new();
    for (i, dir) in dirs.iter().enumerate() {
        let r = rects[i];
        let key = format!("{part}_{dir}");
        let tile_id = format!("{tile_prefix}__{key}");
        derived_tiles.entry(tile_id.clone()).or_insert_with(|| crop_tile(src, r));
        textures.insert(key.clone(), json!(tile_id));
        faces.insert(
            dir.to_string(),
            json!({ "texture": format!("#{key}"), "uv": [0, 0, r.w, r.h] }),
        );
    }
    (json!({ "from": from, "to": to, "faces": faces }), textures)
}

/// A full chest model for one texture stem. `x0`/`x1` place the base box in
/// the block (14 wide for singles, 15 wide flush to one side for halves);
/// `halves` selects the double-chest box dims and omits the latch.
fn chest_model_json(
    src: &image::RgbaImage,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
    tile_prefix: &str,
    x0: f64,
    x1: f64,
    half: bool,
) -> Value {
    let (bw, latch) = if half { (15u32, false) } else { (14u32, true) };
    let (base, base_tex) = chest_part_element(
        src, derived_tiles, tile_prefix, "base",
        [x0, 0.0, 1.0], [x1, 10.0, 15.0],
        bw, 10, 14, 0, 19,
    );
    let (lid, lid_tex) = chest_part_element(
        src, derived_tiles, tile_prefix, "lid",
        [x0 + CHEST_EPS, 9.0, 1.0 + CHEST_EPS], [x1 - CHEST_EPS, 14.0, 15.0 - CHEST_EPS],
        bw, 5, 14, 0, 0,
    );
    let mut elements = vec![base, lid];
    let mut textures = base_tex;
    for (k, v) in lid_tex {
        textures.insert(k, v);
    }
    if latch {
        // The latch samples sub-rects of one 6x5 tile cropped from the
        // texture's top-left corner (the region vanilla's lock box uses).
        let latch_tile = format!("{tile_prefix}__latch");
        derived_tiles
            .entry(latch_tile.clone())
            .or_insert_with(|| crop_tile(src, Rect { x: 0, y: 0, w: 6, h: 5 }));
        textures.insert("latch".into(), json!(latch_tile));
        let rects = box_face_rects(2, 4, 1, 0, 0);
        let dirs = ["up", "down", "north", "south", "west", "east"];
        let mut faces = Map::new();
        for (i, dir) in dirs.iter().enumerate() {
            let r = rects[i];
            faces.insert(
                dir.to_string(),
                json!({
                    "texture": "#latch",
                    "uv": [r.x, r.y, r.x + r.w, r.y + r.h],
                }),
            );
        }
        elements.push(json!({
            "from": [7.0, 7.0, 0.0],
            "to": [9.0, 11.0, 1.0],
            "faces": faces,
        }));
    }
    textures.insert("particle".into(), json!("#base_up"));
    json!({ "textures": textures, "elements": elements })
}

/// Replace every chest-family blockstate with facing/type variants that map
/// to the synthesized models, registering the models in `raw_models` (the
/// parent-closure pass picks them up from there). Returns the number of
/// chest families synthesized.
fn synthesize_chests(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let families: Vec<(String, &'static str)> = block_states
        .keys()
        .filter_map(|k| chest_texture_stem(k).map(|stem| (k.clone(), stem)))
        .collect();
    let mut count = 0;
    for (state_key, stem) in families {
        let block_name = state_key.trim_start_matches("minecraft:block/").to_string();
        let mut load = |stem: &str| -> Option<image::RgbaImage> {
            let zip_name = format!("assets/minecraft/textures/entity/chest/{stem}.png");
            let bytes = read_zip_file(archive, &zip_name)?;
            image::load_from_memory(&bytes).ok().map(|img| img.to_rgba8())
        };
        let Some(single_src) = load(stem) else {
            eprintln!("[chest] {stem}.png missing from jar; {state_key} keeps placeholder");
            continue;
        };
        let tile_prefix = format!("minecraft:entity/chest/{stem}");
        let single_model = format!("minecraft:block/{block_name}_single");
        raw_models.insert(
            single_model.clone(),
            chest_model_json(&single_src, derived_tiles, &tile_prefix, 1.0, 15.0, false),
        );

        // Variant table: "" covers property-less (schema-1) states; the
        // facing/type keys win by best-partial match. Variant y=90 maps the
        // model's north-facing front to east (the renderer's convention).
        // Double-chest halves are flush against the block-boundary seam
        // (left half hugs the east edge of its block, right half the west
        // edge) so an adjacent left+right pair reads as one continuous box.
        let mut variants = Map::new();
        variants.insert("".into(), json!({ "model": single_model }));
        let halves = [
            ("left", (stem.to_string() + "_left", 1.0)),
            ("right", (stem.to_string() + "_right", 0.0)),
        ]
        .into_iter()
        .filter_map(|(ty, (tex_stem, x0))| {
            let src = load(&tex_stem)?;
            let model_id = format!("minecraft:block/{block_name}_{ty}");
            let prefix = format!("minecraft:entity/chest/{tex_stem}");
            raw_models.insert(
                model_id.clone(),
                chest_model_json(&src, derived_tiles, &prefix, x0, x0 + 15.0, true),
            );
            Some((ty, model_id))
        })
        .collect::<Vec<_>>();
        for (facing, y) in [("north", 0), ("east", 90), ("south", 180), ("west", 270)] {
            variants.insert(
                format!("facing={facing},type=single"),
                json!({ "model": single_model, "y": y }),
            );
            for (ty, model_id) in &halves {
                variants.insert(
                    format!("facing={facing},type={ty}"),
                    json!({ "model": model_id, "y": y }),
                );
            }
        }
        block_states.insert(state_key, json!({ "variants": variants }));
        count += 1;
    }
    count
}

/// All model ids a blockstate JSON references: every variant value (object or
/// weighted array) and every multipart `apply` (object or array).
fn blockstate_models(state: &Value) -> Vec<String> {
    let mut out = Vec::new();
    fn push_apply(apply: &Value, out: &mut Vec<String>) {
        let entries: Vec<&Value> = match apply {
            Value::Array(arr) => arr.iter().collect(),
            Value::Object(_) => vec![apply],
            _ => vec![],
        };
        for entry in entries {
            if let Some(model) = entry["model"].as_str() {
                out.push(ns_id(model));
            }
        }
    }
    if let Some(variants) = state.get("variants").and_then(|v| v.as_object()) {
        for entry in variants.values() {
            push_apply(entry, &mut out);
        }
    }
    if let Some(multipart) = state.get("multipart").and_then(|m| m.as_array()) {
        for part in multipart {
            push_apply(&part["apply"], &mut out);
        }
    }
    out
}

/// The parent model id to walk next. `builtin/*` parents (e.g.
/// builtin/generated) have no JSON file and stop the chain.
fn model_parent(model: &Value) -> Option<String> {
    let parent = model.get("parent")?.as_str()?;
    if parent.starts_with("builtin/") {
        None
    } else {
        Some(ns_id(parent))
    }
}

/// Models reachable from `seeds` through parent links. Unknown ids (including
/// builtin/* parents) are dropped; cycles terminate.
fn collect_model_closure(models: &HashMap<String, Value>, seeds: Vec<String>) -> BTreeSet<String> {
    let mut queue: VecDeque<String> = seeds.into();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    while let Some(key) = queue.pop_front() {
        if !seen.insert(key.clone()) {
            continue;
        }
        let Some(model) = models.get(&key) else {
            continue;
        };
        if let Some(parent) = model_parent(model) {
            queue.push_back(parent);
        }
    }
    seen.retain(|key| models.contains_key(key));
    seen
}

/// Texture ids referenced by a model's `textures` map. Values are texture
/// ids; newer model formats wrap them as {"sprite": "...", ...}. "#key"
/// references point at another entry of the merged texture map and are
/// skipped: the literal they resolve to lives in an ancestor model that is
/// itself in the closure, so collecting all literals is a covering superset.
fn model_texture_ids(model: &Value) -> Vec<String> {
    let Some(textures) = model.get("textures").and_then(|t| t.as_object()) else {
        return Vec::new();
    };
    textures
        .values()
        .filter_map(|value| match value {
            Value::String(s) => Some(s.as_str()),
            Value::Object(obj) => obj.get("sprite").and_then(|s| s.as_str()),
            _ => None,
        })
        .filter(|id| !id.starts_with('#'))
        .map(ns_id)
        .collect()
}

/// "block/stone" -> "minecraft:block/stone" (already-namespaced stays as-is).
fn ns_id(v: &str) -> String {
    if v.contains(':') {
        v.to_string()
    } else {
        format!("minecraft:{v}")
    }
}

/// "minecraft:colormap/grass" when id is one of the colormaps we sample.
fn colormap_name(id: &str) -> Option<&'static str> {
    match id {
        "minecraft:colormap/grass" => Some("grass"),
        "minecraft:colormap/foliage" => Some("foliage"),
        _ => None,
    }
}

/// "minecraft:block/stone" -> "assets/minecraft/textures/block/stone.png".
fn texture_zip_name(id: &str) -> String {
    let (ns, path) = match id.split_once(':') {
        Some((ns, path)) => (ns, path),
        None => ("minecraft", id),
    };
    format!("assets/{ns}/textures/{path}.png")
}

/// How a texture composites: opaque blocks the z-buffer, cutout discards
/// fully transparent texels, translucent blends.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum AlphaClass {
    Opaque,
    Cutout,
    Translucent,
}

impl AlphaClass {
    fn as_str(self) -> &'static str {
        match self {
            AlphaClass::Opaque => "opaque",
            AlphaClass::Cutout => "cutout",
            AlphaClass::Translucent => "translucent",
        }
    }
}

/// Classify by pixel alphas alone: all 255 -> opaque, only 0/255 -> cutout,
/// anything in between -> translucent.
fn alpha_class_of(alphas: impl IntoIterator<Item = u8>) -> AlphaClass {
    let mut has_zero = false;
    let mut has_partial = false;
    for a in alphas {
        if a == 0 {
            has_zero = true;
        } else if a < 255 {
            has_partial = true;
        }
    }
    if has_partial {
        AlphaClass::Translucent
    } else if has_zero {
        AlphaClass::Cutout
    } else {
        AlphaClass::Opaque
    }
}

/// Pixel classification plus the known-translucent override: textures of
/// blending blocks count as translucent even when their alphas are pure
/// cutout (0/255 only).
fn classify_texture_alpha(img: &image::RgbaImage, path: &str) -> AlphaClass {
    let class = alpha_class_of(img.pixels().map(|p| p.0[3]));
    match class {
        AlphaClass::Cutout if is_known_translucent(path) => AlphaClass::Translucent,
        other => other,
    }
}

/// Texture paths of blocks vanilla renders in a blending layer.
fn is_known_translucent(path: &str) -> bool {
    let name = path.strip_prefix("block/").unwrap_or(path);
    let is_glass = name == "glass"
        || name == "tinted_glass"
        || name.starts_with("glass_pane")
        || name.contains("stained_glass"); // includes *_stained_glass_pane_top
    let is_ice = name == "ice" || name.ends_with("_ice"); // packed/blue/frosted ice
    let is_water = name.starts_with("water_"); // still/flow/overlay
    let is_sticky = name.starts_with("slime_block") || name.starts_with("honey_block");
    is_glass || is_ice || is_water || is_sticky
}

/// Normalize an arbitrary texture to a 16x16 tile: animated strips keep their
/// first frame, other sizes are nearest-neighbor resized. Tinting is not
/// baked here; the client tints per-state from the bundle's colormap data.
fn normalize_tile(img: &image::RgbaImage) -> image::RgbaImage {
    let (w, h) = img.dimensions();
    if w == TILE && h == TILE {
        img.clone()
    } else if w == TILE && h > TILE {
        // Vertical animation strip: take the first frame.
        image::imageops::crop_imm(img, 0, 0, TILE, TILE).to_image()
    } else {
        image::imageops::resize(img, TILE, TILE, image::imageops::FilterType::Nearest)
    }
}

fn encode_png(img: &image::RgbaImage) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    img.write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf.into_inner())
}

/// Serve the render bundle (404 when no bundle has been extracted). The
/// filename is stable, so a short cache lifetime suffices; the hashed atlas
/// it references is what gets immutable caching.
pub async fn serve_bundle(
    axum::extract::State(state): axum::extract::State<crate::state::AppState>,
) -> Result<axum::response::Response, AppError> {
    let path = state.config.data_dir.join("textures").join("bundle.json.gz");
    let bytes = std::fs::read(&path).map_err(|_| AppError::NotFound)?;
    Ok((
        axum::http::StatusCode::OK,
        [
            (axum::http::header::CONTENT_TYPE, "application/gzip"),
            (axum::http::header::CACHE_CONTROL, "public, max-age=3600"),
        ],
        bytes,
    )
        .into_response())
}

/// Serve an atlas PNG. The filename carries a content hash; the bundle tells
/// clients which file to request.
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn alpha_classification() {
        use AlphaClass::*;
        assert_eq!(alpha_class_of([255, 255, 255]), Opaque);
        assert_eq!(alpha_class_of([]), Opaque, "no pixels -> nothing blends");
        assert_eq!(alpha_class_of([255, 0, 255]), Cutout);
        assert_eq!(alpha_class_of([255, 254, 255]), Translucent);
        assert_eq!(alpha_class_of([0, 128, 255]), Translucent);
        assert_eq!(alpha_class_of([1, 254]), Translucent);
    }

    #[test]
    fn translucent_families_override_cutout() {
        for path in [
            "block/glass",
            "block/glass_pane_top",
            "block/red_stained_glass",
            "block/blue_stained_glass_pane_top",
            "block/tinted_glass",
            "block/ice",
            "block/packed_ice",
            "block/blue_ice",
            "block/water_still",
            "block/water_flow",
            "block/slime_block",
            "block/honey_block_top",
        ] {
            assert!(is_known_translucent(path), "{path} should be translucent");
        }
        for path in ["block/stone", "block/grass_block_top", "block/oak_leaves"] {
            assert!(!is_known_translucent(path), "{path} should stay as classified");
        }
        // Cutout-classified glass becomes translucent; already-opaque stays opaque.
        let cutout_glass = image::RgbaImage::from_fn(2, 1, |x, _| {
            image::Rgba([200, 200, 200, if x == 0 { 0 } else { 255 }])
        });
        assert_eq!(classify_texture_alpha(&cutout_glass, "block/glass"), AlphaClass::Translucent);
        let opaque_glass = image::RgbaImage::from_pixel(2, 1, image::Rgba([200, 200, 200, 255]));
        assert_eq!(classify_texture_alpha(&opaque_glass, "block/glass"), AlphaClass::Opaque);
    }

    #[test]
    fn parent_walk_stops_at_builtin() {
        assert_eq!(
            model_parent(&json!({"parent": "block/cube_all"})),
            Some("minecraft:block/cube_all".into())
        );
        assert_eq!(
            model_parent(&json!({"parent": "minecraft:block/cube"})),
            Some("minecraft:block/cube".into())
        );
        assert_eq!(model_parent(&json!({"parent": "builtin/generated"})), None);
        assert_eq!(model_parent(&json!({"textures": {}})), None);
    }

    #[test]
    fn model_closure_walks_chains_and_survives_cycles() {
        let models: HashMap<String, Value> = [
            ("minecraft:block/a", json!({"parent": "block/b"})),
            ("minecraft:block/b", json!({"parent": "block/c"})),
            ("minecraft:block/c", json!({})),
            ("minecraft:block/d", json!({"parent": "builtin/generated"})),
            // Cycle plus an unreferenced orphan.
            ("minecraft:block/x", json!({"parent": "block/y"})),
            ("minecraft:block/y", json!({"parent": "block/x"})),
            ("minecraft:block/orphan", json!({})),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();

        let closure = collect_model_closure(
            &models,
            vec!["minecraft:block/a".into(), "minecraft:block/d".into()],
        );
        assert_eq!(
            closure,
            ["minecraft:block/a", "minecraft:block/b", "minecraft:block/c", "minecraft:block/d"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        );

        let cyclic = collect_model_closure(&models, vec!["minecraft:block/x".into()]);
        assert_eq!(
            cyclic,
            ["minecraft:block/x", "minecraft:block/y"]
                .iter()
                .map(|s| s.to_string())
                .collect()
        );

        // References to models missing from the jar are dropped.
        let missing = collect_model_closure(&models, vec!["minecraft:block/nope".into()]);
        assert!(missing.is_empty());
    }

    #[test]
    fn blockstate_model_refs_cover_all_forms() {
        let state = json!({
            "variants": {
                "": {"model": "block/stone"},
                "facing=east": [{"model": "minecraft:block/x", "y": 90}, {"model": "block/y"}]
            },
            "multipart": [
                {"when": {"north": "side|up"}, "apply": {"model": "block/a"}},
                {"when": {"OR": [{"east": true}, {"west": true}]},
                 "apply": [{"model": "block/b"}, {"model": "minecraft:block/c"}]}
            ]
        });
        let mut refs = blockstate_models(&state);
        refs.sort();
        assert_eq!(
            refs,
            [
                "minecraft:block/a",
                "minecraft:block/b",
                "minecraft:block/c",
                "minecraft:block/stone",
                "minecraft:block/x",
                "minecraft:block/y"
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
        );
    }

    #[test]
    fn id_and_path_helpers() {
        assert_eq!(ns_id("block/stone"), "minecraft:block/stone");
        assert_eq!(ns_id("minecraft:block/stone"), "minecraft:block/stone");
        assert_eq!(
            texture_zip_name("minecraft:block/stone"),
            "assets/minecraft/textures/block/stone.png"
        );
        assert_eq!(colormap_name("minecraft:colormap/grass"), Some("grass"));
        assert_eq!(colormap_name("minecraft:block/stone"), None);
    }

    #[test]
    fn chest_box_layout_matches_vanilla_textures() {
        // Single-chest base (14x10x14 @ texOffs(0,19)) and lid (14x5x14 @
        // (0,0)): rects verified against the actual entity texture regions.
        let base = box_face_rects(14, 10, 14, 0, 19);
        let assert_rect = |r: &Rect, x: u32, y: u32, w: u32, h: u32| {
            assert_eq!((r.x, r.y, r.w, r.h), (x, y, w, h));
        };
        assert_rect(&base[0], 14, 19, 14, 14); // up
        assert_rect(&base[1], 28, 19, 14, 14); // down
        assert_rect(&base[2], 14, 33, 14, 10); // north
        assert_rect(&base[3], 42, 33, 14, 10); // south
        assert_rect(&base[4], 0, 33, 14, 10);  // west lateral
        assert_rect(&base[5], 28, 33, 14, 10); // east lateral
        let lid = box_face_rects(14, 5, 14, 0, 0);
        assert_rect(&lid[0], 14, 0, 14, 14);
        assert_rect(&lid[2], 14, 14, 14, 5);
        // Latch (2x4x1 @ (0,0)) fits the 6x5 top-left texture corner.
        let latch = box_face_rects(2, 4, 1, 0, 0);
        assert_rect(&latch[0], 1, 0, 2, 1);
        assert_rect(&latch[2], 1, 1, 2, 4);
        assert_rect(&latch[3], 4, 1, 2, 4);
        // Double-chest halves are 15 wide.
        let half = box_face_rects(15, 10, 14, 0, 19);
        assert_rect(&half[0], 14, 19, 15, 14);
        assert_rect(&half[3], 43, 33, 15, 10);
        assert_rect(&half[5], 29, 33, 14, 10);
    }

    #[test]
    fn synthesized_chest_model_shape() {
        // A distinct color per texture pixel lets us verify each face tile
        // sampled the right region of the synthetic 64x64 source.
        let src = image::RgbaImage::from_fn(64, 64, |x, y| {
            image::Rgba([(x * 4) as u8, (y * 4) as u8, 128, 255])
        });
        let mut tiles: HashMap<String, image::RgbaImage> = HashMap::new();
        let model = chest_model_json(&src, &mut tiles, "minecraft:entity/chest/test", 1.0, 15.0, false);

        let elements = model["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 3, "base + lid + latch");
        // Base sits inside the block; lid is inset to avoid coplanar sides.
        assert_eq!(elements[0]["from"], json!([1.0, 0.0, 1.0]));
        assert_eq!(elements[0]["to"], json!([15.0, 10.0, 15.0]));
        assert_eq!(elements[1]["to"], json!([15.0 - CHEST_EPS, 14.0, 15.0 - CHEST_EPS]));
        let latch = &elements[2];
        assert_eq!(latch["from"], json!([7.0, 7.0, 0.0]));
        assert_eq!(latch["to"], json!([9.0, 11.0, 1.0]));
        assert_eq!(latch["faces"]["north"]["uv"], json!([1, 1, 3, 5]));

        // Every face tile cropped its region: the base-up tile's first pixel
        // equals the source pixel at the region origin (14, 19).
        let up = &tiles["minecraft:entity/chest/test__base_up"];
        assert_eq!(up.get_pixel(0, 0), src.get_pixel(14, 19));
        let north = &tiles["minecraft:entity/chest/test__base_north"];
        assert_eq!(north.get_pixel(0, 0), src.get_pixel(14, 33));
        // The half variant has no latch and is 15 wide.
        let mut half_tiles: HashMap<String, image::RgbaImage> = HashMap::new();
        let half = chest_model_json(&src, &mut half_tiles, "minecraft:entity/chest/test_h", 0.0, 15.0, true);
        assert_eq!(half["elements"].as_array().unwrap().len(), 2);
        assert_eq!(half["elements"][0]["from"], json!([0.0, 0.0, 1.0]));
        assert!(half["textures"].get("latch").is_none());
    }

    #[test]
    fn chest_families_map_to_entity_textures() {
        assert_eq!(chest_texture_stem("minecraft:block/chest"), Some("normal"));
        assert_eq!(
            chest_texture_stem("minecraft:block/trapped_chest"),
            Some("normal")
        );
        assert_eq!(chest_texture_stem("minecraft:block/ender_chest"), Some("ender"));
        assert_eq!(
            chest_texture_stem("minecraft:block/waxed_exposed_copper_chest"),
            Some("copper_exposed")
        );
        assert_eq!(chest_texture_stem("minecraft:block:oak_planks"), None);
    }

    #[test]
    fn texture_ids_cover_strings_sprite_objects_and_refs() {
        let model = json!({
            "textures": {
                "all": "block/stone",
                "side": "minecraft:block/dirt",
                // Newer format: wrapped sprites (e.g. redstone dust lines).
                "line": {"force_translucent": true, "sprite": "block/redstone_dust_line0"},
                "overlay": {"sprite": "block/redstone_dust_overlay"},
                // References resolve to an ancestor's literal; skip here.
                "up": "#all",
                "nested": {"sprite": "#line"},
            }
        });
        let mut ids = model_texture_ids(&model);
        ids.sort();
        assert_eq!(
            ids,
            [
                "minecraft:block/dirt",
                "minecraft:block/redstone_dust_line0",
                "minecraft:block/redstone_dust_overlay",
                "minecraft:block/stone",
            ]
            .iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
        );
        assert!(model_texture_ids(&json!({"parent": "block/cube"})).is_empty());
    }
}
