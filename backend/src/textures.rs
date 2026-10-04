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
const BUNDLE_FORMAT_VERSION: u32 = 3;

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
    let mut families = synthesize_chests(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    // 2.6. The other block-entity families get the same treatment, and the
    // bare face-texture refs of shipped models (heavy_core) are normalized.
    families += synthesize_shulker_boxes(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_banners(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_heads(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_golem_statues(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_conduits(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_decorated_pots(
        &mut block_states,
        &mut raw_models,
        &mut archive,
        &mut derived_tiles,
    );
    families += synthesize_end_portals(&mut block_states, &mut raw_models);
    families += synthesize_lava(&mut block_states, &mut raw_models);
    let fixed_refs = normalize_face_texture_refs(&mut raw_models);
    println!(
        "synthesized models for {families} blockstate families ({} derived tiles), normalized {fixed_refs} bare face texture refs",
        derived_tiles.len()
    );

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

    // 3.5. Item models for the material universe. The material table lists
    // block_to_item ids, and vanilla shows several of them (redstone, rails,
    // bell, torches, seeds, …) as item models — flat sprites or dedicated
    // elements — rather than the placed block. Keep their parent closures so
    // the frontend icon renderer can prefer the item, like the inventory.
    let item_seeds: Vec<String> = block_states
        .keys()
        .filter_map(|key| {
            let block = key.strip_prefix("minecraft:block/")?;
            let item = crate::schematics::parse::block_to_item(&format!("minecraft:{block}"))?;
            Some(format!(
                "minecraft:item/{}",
                item.trim_start_matches("minecraft:")
            ))
        })
        .collect();
    let item_closure = collect_model_closure(&raw_models, item_seeds);
    println!(
        "item-model closure: {} models for material items",
        item_closure.len()
    );
    let item_models: Map<String, Value> = item_closure
        .iter()
        .filter(|key| !closure.contains(*key))
        .filter_map(|key| raw_models.get(key).map(|v| ((key).clone(), v.clone())))
        .collect();

    // 4. Collect every texture referenced by a reachable model.
    let mut texture_ids: BTreeSet<String> = BTreeSet::new();
    for key in &closure {
        for id in model_texture_ids(&raw_models[key]) {
            texture_ids.insert(id);
        }
    }
    for key in &item_closure {
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
        image::imageops::overlay(
            &mut atlas,
            &tiles[*id],
            (col * TILE) as i64,
            (row * TILE) as i64,
        );
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
        "itemModels": item_models,
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
//
// Chest boxes are UV-inverted relative to generic entity boxes (skins put
// the up face in the first top-row slot — Steve's arm/hand squares prove
// that convention). In chest textures the first slot (u+d, v) holds the
// interior view and the second (u+d+w, v) the exterior surface: christmas.png
// has the ribbon cross only in the second slot, and the wiki's chest render
// shows a planks top. chest_part_element therefore swaps up/down.

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
        Rect {
            x: u + d,
            y: v,
            w,
            h: d,
        },
        Rect {
            x: u + d + w,
            y: v,
            w,
            h: d,
        },
        Rect {
            x: u + d,
            y: v + d,
            w,
            h,
        },
        Rect {
            x: u + 2 * d + w,
            y: v + d,
            w,
            h,
        },
        Rect {
            x: u,
            y: v + d,
            w: d,
            h,
        },
        Rect {
            x: u + d + w,
            y: v + d,
            w: d,
            h,
        },
    ]
}

/// Crop one face region into its own transparent-padded 16x16 atlas tile.
/// `flip` mirrors the tile east-west: entity boxes run side-face u from
/// west to east while block models run it east to west, so double-chest
/// halves (whose seam-side edges are borderless for seamless joins) need
/// flipped crops on exactly those faces — see chest_part_element.
fn crop_tile(src: &image::RgbaImage, r: Rect, flip: bool) -> image::RgbaImage {
    let mut tile = image::RgbaImage::new(TILE, TILE);
    let mut region = image::imageops::crop_imm(src, r.x, r.y, r.w, r.h).to_image();
    if flip {
        region = image::imageops::flip_horizontal(&region);
    }
    image::imageops::overlay(&mut tile, &region, 0, 0);
    tile
}

const CHEST_EPS: f64 = 0.002;

/// One chest body part (base or lid) as a model element. Each face samples
/// its own derived tile, so the uv is simply the region size. `prefix` names
/// the part (e.g. "base"); `w`/`h`/`d` are the entity box dims at texOffs
/// (u, v). Lateral (west/east) faces use the depth-sized rects. `mirror`
/// flips the north/south tiles east-west for double-chest halves, where the
/// entity-vs-block side-face u direction differs (see crop_tile).
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
    mirror: bool,
) -> (Value, Map<String, Value>) {
    let mut rects = box_face_rects(w, h, d, u, v);
    // Chest textures draw the interior view in the generic up slot and the
    // exterior surface in the generic down slot (see the module note above),
    // so the closed chest's visible top face must sample the second rect.
    rects.swap(0, 1);
    let dirs = ["up", "down", "north", "south", "west", "east"];
    let mut faces = Map::new();
    let mut textures = Map::new();
    for (i, dir) in dirs.iter().enumerate() {
        let r = rects[i];
        let key = format!("{part}_{dir}");
        let tile_id = format!("{tile_prefix}__{key}");
        // Only the north/south faces mirror: entity boxes run side-face u
        // from west to east while block models run it east to west (up/down
        // faces agree), so a flipped crop is needed exactly there.
        let flip = mirror && matches!(*dir, "north" | "south");
        derived_tiles
            .entry(tile_id.clone())
            .or_insert_with(|| crop_tile(src, r, flip));
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
/// `half` selects the double-chest box dims, mirrors the part east-west so
/// half textures' borderless seam edges join, and hugs the latch to the seam.
fn chest_model_json(
    src: &image::RgbaImage,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
    tile_prefix: &str,
    x0: f64,
    x1: f64,
    half: bool,
) -> Value {
    let bw = if half { 15u32 } else { 14u32 };
    let (base, base_tex) = chest_part_element(
        src,
        derived_tiles,
        tile_prefix,
        "base",
        [x0, 0.0, 1.0],
        [x1, 10.0, 15.0],
        bw,
        10,
        14,
        0,
        19,
        half,
    );
    // The lid insets to avoid z-fighting the base's coplanar side walls,
    // but a half keeps its seam edge flush: an inset there opens a hairline
    // slit between the pair's lids (a black line on the top and sides). The
    // seam-side faces end up coplanar and opposite-facing, so they never
    // z-fight, and the neighbor's box occludes them. Halves are placed by
    // x0: right hugs the west edge (seam at x0), left the east edge (x1).
    let (lid_x0, lid_x1) = if half {
        if x0 == 0.0 {
            (x0, x1 - CHEST_EPS)
        } else {
            (x0 + CHEST_EPS, x1)
        }
    } else {
        (x0 + CHEST_EPS, x1 - CHEST_EPS)
    };
    let (lid, lid_tex) = chest_part_element(
        src,
        derived_tiles,
        tile_prefix,
        "lid",
        [lid_x0, 9.0, 1.0 + CHEST_EPS],
        [lid_x1, 14.0, 15.0 - CHEST_EPS],
        bw,
        5,
        14,
        0,
        0,
        half,
    );
    let mut elements = vec![base, lid];
    let mut textures = base_tex;
    for (k, v) in lid_tex {
        textures.insert(k, v);
    }
    // Latch: singles center a 2x4x1 box on the front. Halves place a 1x4x1
    // latch against the seam edge — vanilla's large chest joins the two
    // pieces into one 2-wide lock. The half textures draw their latch art
    // at different texOffs, and the type↔texture cross-mapping puts the
    // right-half file (art at (0,0)) on the left type and the left-half
    // file (art at (1,0)) on the right type; each piece's seam-side face
    // samples a transparent column hidden against the neighbor's latch.
    let (latch_x, latch_w, latch_u) = if half {
        if x0 == 0.0 {
            ((0.0, 1.0), 1u32, 1u32)
        } else {
            ((15.0, 16.0), 1u32, 0u32)
        }
    } else {
        ((7.0, 9.0), 2u32, 0u32)
    };
    let latch_tile = format!("{tile_prefix}__latch");
    let latch_region = Rect {
        x: latch_u,
        y: 0,
        w: 4 + latch_w,
        h: 5,
    };
    derived_tiles
        .entry(latch_tile.clone())
        .or_insert_with(|| crop_tile(src, latch_region, false));
    textures.insert("latch".into(), json!(latch_tile));
    let rects = box_face_rects(latch_w, 4, 1, latch_u, 0);
    let dirs = ["up", "down", "north", "south", "west", "east"];
    let mut faces = Map::new();
    for (i, dir) in dirs.iter().enumerate() {
        let r = rects[i];
        faces.insert(
            dir.to_string(),
            json!({
                "texture": "#latch",
                "uv": [r.x - latch_u, r.y, r.x - latch_u + r.w, r.y + r.h],
            }),
        );
    }
    elements.push(json!({
        "from": [latch_x.0, 7.0, 0.0],
        "to": [latch_x.1, 11.0, 1.0],
        "faces": faces,
    }));
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
            image::load_from_memory(&bytes)
                .ok()
                .map(|img| img.to_rgba8())
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
        // A type=left chest renders the *_right art: vanilla names the half
        // textures from the chest's own perspective, so they cross-map to
        // the type property (verified against in-game appearance).
        let mut variants = Map::new();
        variants.insert("".into(), json!({ "model": single_model }));
        let halves = [
            ("left", (stem.to_string() + "_right", 1.0)),
            ("right", (stem.to_string() + "_left", 0.0)),
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

// ---- Entity-rendered block synthesis: shared machinery ---------------------
//
// The same treatment chests get, generalized for the other block-entity
// families (shulker boxes, banners, heads, golem statues, conduits, decorated
// pots). Each family synthesizes real block models from its entity textures
// via the generic entity-box layout (box_face_rects, up/down slots NOT
// swapped — pixel-verified: the shulker lid's outer top face is the first
// slot (u+d, v) with fill 1.00 while the second slot holds the mostly
// transparent interior view; the chest swap is a chest-only quirk).

/// One entity-model box placed in the block. `w`/`h`/`d` are the entity box
/// dimensions at texOffs (`u`, `v`); `from`/`to` are block-model space
/// (0..16); `tint` multiplies the cropped pixels (dyed banner cloth);
/// `rotation` is an optional element rotation (piglin ears); `skip` omits
/// faces (decorated-pot neck top, coplanar with the shoulder plane).
struct BoxSpec {
    prefix: String,
    part: String,
    from: [f64; 3],
    to: [f64; 3],
    w: u32,
    h: u32,
    d: u32,
    u: u32,
    v: u32,
    tint: Option<[u8; 3]>,
    rotation: Option<Value>,
    skip: Vec<&'static str>,
}

fn box_spec(
    prefix: &str,
    part: &str,
    from: [f64; 3],
    to: [f64; 3],
    w: u32,
    h: u32,
    d: u32,
    u: u32,
    v: u32,
) -> BoxSpec {
    BoxSpec {
        prefix: prefix.into(),
        part: part.into(),
        from,
        to,
        w,
        h,
        d,
        u,
        v,
        tint: None,
        rotation: None,
        skip: Vec::new(),
    }
}

impl BoxSpec {
    fn tinted(mut self, rgb: [u8; 3]) -> BoxSpec {
        self.tint = Some(rgb);
        self
    }

    fn rotated(mut self, origin: [f64; 3], axis: &str, angle: f64) -> BoxSpec {
        self.rotation = Some(json!({ "origin": origin, "axis": axis, "angle": angle }));
        self
    }

    fn skipping(mut self, faces: &[&'static str]) -> BoxSpec {
        self.skip = faces.to_vec();
        self
    }
}

/// The cull direction when this element face lies exactly on the block
/// boundary (vanilla models cull flush faces, e.g. cube_all); interior faces
/// stay uncullable.
fn flush_cullface(dir: &str, from: &[f64; 3], to: &[f64; 3]) -> Option<&'static str> {
    let on = |v: f64, t: f64| (v - t).abs() < 1e-9;
    Some(match dir {
        "north" if on(from[2], 0.0) => "north",
        "south" if on(to[2], 16.0) => "south",
        "west" if on(from[0], 0.0) => "west",
        "east" if on(to[0], 16.0) => "east",
        "up" if on(to[1], 16.0) => "up",
        "down" if on(from[1], 0.0) => "down",
        _ => return None,
    })
}

/// Crop a face region into its own 16x16 transparent-padded atlas tile,
/// scaling down when the region exceeds the tile (banner flag faces are
/// 20x40 entity texels; nearest-neighbor keeps the pixel look). `flip`
/// mirrors east-west, `tint` multiplies the RGB channels. Returns the tile
/// plus the content size the face uv must use.
fn crop_tile_scaled(
    src: &image::RgbaImage,
    r: Rect,
    flip: bool,
    tint: Option<[u8; 3]>,
) -> (image::RgbaImage, u32, u32) {
    let mut region = image::imageops::crop_imm(src, r.x, r.y, r.w, r.h).to_image();
    if flip {
        region = image::imageops::flip_horizontal(&region);
    }
    if let Some(rgb) = tint {
        for p in region.pixels_mut() {
            for c in 0..3 {
                p.0[c] = ((p.0[c] as u16 * rgb[c] as u16 + 127) / 255) as u8;
            }
        }
    }
    let (cw, ch) = if r.w <= TILE && r.h <= TILE {
        (r.w, r.h)
    } else {
        let s = TILE as f64 / r.w.max(r.h) as f64;
        let tw = ((r.w as f64 * s).round() as u32).clamp(1, TILE);
        let th = ((r.h as f64 * s).round() as u32).clamp(1, TILE);
        region = image::imageops::resize(&region, tw, th, image::imageops::FilterType::Nearest);
        (tw, th)
    };
    let mut tile = image::RgbaImage::new(TILE, TILE);
    image::imageops::overlay(&mut tile, &region, 0, 0);
    (tile, cw, ch)
}

/// One entity box as a model element with per-face derived tiles. The
/// generic entity layout is used as-is (no chest up/down swap). North/south
/// tiles are cropped mirrored: entity boxes run side-face u west-to-east
/// while block models run it east-to-west (see crop_tile), so the flip keeps
/// the art unmirrored — imperceptible for the symmetric families here, but
/// consistent with the double-chest seam verification.
fn entity_box_element(
    src: &image::RgbaImage,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
    spec: &BoxSpec,
) -> (Value, Map<String, Value>) {
    let rects = box_face_rects(spec.w, spec.h, spec.d, spec.u, spec.v);
    let dirs = ["up", "down", "north", "south", "west", "east"];
    let mut faces = Map::new();
    let mut textures = Map::new();
    for (i, dir) in dirs.iter().enumerate() {
        if spec.skip.contains(dir) {
            continue;
        }
        let r = rects[i];
        let key = format!("{}_{}", spec.part, dir);
        let tile_id = format!("{}__{}", spec.prefix, key);
        let flip = matches!(*dir, "north" | "south");
        let (tile, cw, ch) = crop_tile_scaled(src, r, flip, spec.tint);
        derived_tiles.entry(tile_id.clone()).or_insert(tile);
        textures.insert(key.clone(), json!(tile_id));
        let mut face = Map::new();
        face.insert("texture".into(), json!(format!("#{key}")));
        face.insert("uv".into(), json!([0, 0, cw, ch]));
        if let Some(cull) = flush_cullface(*dir, &spec.from, &spec.to) {
            face.insert("cullface".into(), json!(cull));
        }
        faces.insert(dir.to_string(), Value::Object(face));
    }
    let mut element = Map::new();
    element.insert("from".into(), json!(spec.from));
    element.insert("to".into(), json!(spec.to));
    if let Some(rot) = &spec.rotation {
        element.insert("rotation".into(), rot.clone());
    }
    element.insert("faces".into(), Value::Object(faces));
    (Value::Object(element), textures)
}

/// A model assembled from entity boxes over one texture.
fn entity_box_model(
    src: &image::RgbaImage,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
    specs: &[BoxSpec],
    particle: &str,
) -> Value {
    let mut elements = Vec::new();
    let mut textures = Map::new();
    for spec in specs {
        let (element, tex) = entity_box_element(src, derived_tiles, spec);
        elements.push(element);
        for (k, v) in tex {
            textures.insert(k, v);
        }
    }
    textures.insert("particle".into(), json!(particle));
    json!({ "textures": textures, "elements": elements })
}

/// An entity texture under assets/minecraft/textures/, decoded to RGBA.
fn load_entity_texture(
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    path: &str,
) -> Option<image::RgbaImage> {
    let bytes = read_zip_file(archive, &format!("assets/minecraft/textures/{path}.png"))?;
    image::load_from_memory(&bytes)
        .ok()
        .map(|img| img.to_rgba8())
}

/// "" plus the four horizontal facings as y quarter turns (golem statues,
/// wall banners, wall heads): the y0 model faces north.
fn variants_empty_and_facing(model_id: &str) -> Map<String, Value> {
    let mut variants = Map::new();
    variants.insert("".into(), json!({ "model": model_id }));
    for (facing, y) in [("north", 0), ("east", 90), ("south", 180), ("west", 270)] {
        variants.insert(
            format!("facing={facing}"),
            json!({ "model": model_id, "y": y }),
        );
    }
    variants
}

/// Rotate a model-space point around a vertical axis through `origin` by
/// `deg` degrees, using exactly the frontend's element-rotation formula
/// (geometry.ts rotateAroundAxis, right-hand rule).
fn rotate_y_about(p: [f64; 3], origin: [f64; 3], deg: f64) -> [f64; 3] {
    if deg == 0.0 {
        return p;
    }
    let rad = deg.to_radians();
    let (s, c) = (rad.sin(), rad.cos());
    let (x, z) = (p[0] - origin[0], p[2] - origin[2]);
    [x * c + z * s + origin[0], p[1], -x * s + z * c + origin[2]]
}

/// Add a y-axis element rotation to every element of a model copy: banner
/// and floor-head `rotation` properties step 22.5°, finer than the variant
/// table's quarter turns, so the residual angle is baked per element (the
/// variant table carries the coarse quarter turn; both rotate about the
/// same vertical axis through x=8, z=8, so they compose additively).
/// Elements that already rotate (piglin ears) keep their own rotation and
/// only have their box and pivot moved along — the plate stays
/// axis-aligned, a bounded approximation for rotated piglin heads.
fn bake_y_rotation(model: &Value, deg: f64) -> Value {
    let mut out = model.clone();
    let Some(elements) = out.get_mut("elements").and_then(|e| e.as_array_mut()) else {
        return out;
    };
    for el in elements.iter_mut() {
        let arr = |key: &str| -> Option<[f64; 3]> {
            let v = el.get(key)?.as_array()?;
            Some([
                v.first()?.as_f64()?,
                v.get(1)?.as_f64()?,
                v.get(2)?.as_f64()?,
            ])
        };
        let (Some(from), Some(to)) = (arr("from"), arr("to")) else {
            continue;
        };
        let axis: [f64; 3] = [8.0, 0.0, 8.0];
        let already = el
            .get("rotation")
            .and_then(|r| r.get("angle"))
            .and_then(|a| a.as_f64())
            .is_some_and(|a| a != 0.0);
        if already {
            // Move the box (center rotated, extents kept) and its pivot;
            // the single-axis element rotation cannot express the composed
            // tilt, so the ear plate keeps its world-z tilt.
            let center = [
                (from[0] + to[0]) / 2.0,
                (from[1] + to[1]) / 2.0,
                (from[2] + to[2]) / 2.0,
            ];
            let moved = rotate_y_about(center, axis, deg);
            let half = [
                (to[0] - from[0]) / 2.0,
                (to[1] - from[1]) / 2.0,
                (to[2] - from[2]) / 2.0,
            ];
            el["from"] = json!([moved[0] - half[0], moved[1] - half[1], moved[2] - half[2]]);
            el["to"] = json!([moved[0] + half[0], moved[1] + half[1], moved[2] + half[2]]);
            if let Some(origin) = el
                .get_mut("rotation")
                .and_then(|r| r.get_mut("origin"))
                .and_then(|o| o.as_array_mut())
            {
                let p = [
                    origin.first().and_then(|v| v.as_f64()).unwrap_or(0.0),
                    origin.get(1).and_then(|v| v.as_f64()).unwrap_or(0.0),
                    origin.get(2).and_then(|v| v.as_f64()).unwrap_or(0.0),
                ];
                let rp = rotate_y_about(p, axis, deg);
                *origin = vec![json!(rp[0]), json!(rp[1]), json!(rp[2])];
            }
        } else {
            el["rotation"] = json!({ "origin": [8.0, 0.0, 8.0], "axis": "y", "angle": deg });
        }
    }
    out
}

/// Vanilla dye colors (DyeColor.textureDiffuseColor) used to tint the plain
/// banner cloth; patterns come from NBT and are approximated away.
const DYE_COLORS: [(&str, [u8; 3]); 16] = [
    ("white", [0xF9, 0xFF, 0xFE]),
    ("orange", [0xF9, 0x80, 0x1D]),
    ("magenta", [0xC7, 0x4E, 0xBD]),
    ("light_blue", [0x3A, 0xB3, 0xDA]),
    ("yellow", [0xFE, 0xD8, 0x3D]),
    ("lime", [0x80, 0xC7, 0x1F]),
    ("pink", [0xF3, 0x8B, 0xAA]),
    ("gray", [0x47, 0x4F, 0x52]),
    ("light_gray", [0x9D, 0x9D, 0x97]),
    ("cyan", [0x16, 0x9C, 0x9C]),
    ("purple", [0x89, 0x32, 0xB8]),
    ("blue", [0x3C, 0x44, 0xAA]),
    ("brown", [0x83, 0x54, 0x32]),
    ("green", [0x5E, 0x7C, 0x16]),
    ("red", [0xB0, 0x2E, 0x26]),
    ("black", [0x1D, 0x1D, 0x21]),
];

// ---- Shulker boxes -----------------------------------------------------------

fn shulker_texture_stem(block_id: &str) -> Option<String> {
    let name = block_id.strip_prefix("minecraft:block/")?;
    if name == "shulker_box" {
        Some("shulker".into())
    } else {
        name.strip_suffix("_shulker_box")
            .map(|c| format!("shulker_{c}"))
    }
}

/// Shulker boxes are block entities whose 26.3 blockstate only has the ""
/// variant. Synthesize the closed box (base y0..8, lid a tall cup y4..16
/// overlapping the base's top band) from the 64x64 entity texture and
/// rebuild the variant table with the six facings. The overlap band's side
/// textures are complementary cutouts — pixel-verified: 0 of 64 band pixels
/// are opaque in both the lid and base rows on every side face — so the
/// coplanar walls cannot z-fight and no epsilon inset is needed.
fn synthesize_shulker_boxes(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let keys: Vec<String> = block_states
        .keys()
        .filter(|k| shulker_texture_stem(k).is_some())
        .cloned()
        .collect();
    let mut count = 0;
    for state_key in keys {
        let stem = shulker_texture_stem(&state_key).unwrap();
        let Some(src) = load_entity_texture(archive, &format!("entity/shulker/{stem}")) else {
            eprintln!("[shulker] entity/shulker/{stem}.png missing; {state_key} keeps placeholder");
            continue;
        };
        let block_name = state_key.trim_start_matches("minecraft:block/").to_string();
        let tile_prefix = format!("minecraft:entity/shulker/{stem}");
        let model_id = format!("minecraft:block/{block_name}_synthetic");
        let model = entity_box_model(
            &src,
            derived_tiles,
            &[
                box_spec(
                    &tile_prefix,
                    "base",
                    [0.0, 0.0, 0.0],
                    [16.0, 8.0, 16.0],
                    16,
                    8,
                    16,
                    0,
                    28,
                ),
                box_spec(
                    &tile_prefix,
                    "lid",
                    [0.0, 4.0, 0.0],
                    [16.0, 16.0, 16.0],
                    16,
                    12,
                    16,
                    0,
                    0,
                ),
            ],
            "#lid_up",
        );
        raw_models.insert(model_id.clone(), model);
        // The model is built lid-up (facing=up); sideways facings tip the
        // box over — x90 first, then the y quarter turn, the same
        // convention as the chest table (x90 maps up to north).
        let mut variants = Map::new();
        let table = [
            ("", None, 0i32),
            ("facing=up", None, 0),
            ("facing=down", Some(180), 0),
            ("facing=north", Some(90), 0),
            ("facing=east", Some(90), 90),
            ("facing=south", Some(90), 180),
            ("facing=west", Some(90), 270),
        ];
        for (key, x, y) in table {
            let mut entry = Map::new();
            entry.insert("model".into(), json!(model_id));
            if let Some(x) = x {
                entry.insert("x".into(), json!(x));
            }
            if y != 0 {
                entry.insert("y".into(), json!(y));
            }
            variants.insert(key.into(), Value::Object(entry));
        }
        block_states.insert(state_key, json!({ "variants": variants }));
        count += 1;
    }
    count
}

// ---- Banners ------------------------------------------------------------------

/// Banners: standing (pole + crossbar + cloth) and wall (crossbar + cloth)
/// forms from entity/banner/banner_base.png. Only the undecorated cloth is
/// synthesized — patterns are NBT-driven and approximated away; the cloth
/// (white in the texture, mean 241,241,241) is multiplied by the vanilla
/// dye color while the wooden pole/bar keep their texture pixels. Banner
/// geometry is taller than one block (pole to y28, cloth y2.67..29.33;
/// wall cloth hangs to y-13) — faithful to the 26.3 entity model, whose
/// transform chain (translate(0.5,0,0.5) + scale(2/3,-2/3,-2/3)) these
/// coordinates fold down. Floor `rotation=0..15` steps 22.5°, finer than
/// quarter turns: the residual (r mod 4) is baked as an element rotation
/// and the coarse quarter turn rides on the variant's y.
fn synthesize_banners(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let Some(base) = load_entity_texture(archive, "entity/banner/banner_base") else {
        eprintln!("[banner] banner_base.png missing; banners keep placeholders");
        return 0;
    };
    let wood_prefix = "minecraft:entity/banner/wood";
    let mut count = 0;
    for (color, rgb) in DYE_COLORS {
        let cloth_prefix = format!("minecraft:entity/banner/{color}");
        let block = format!("{color}_banner");
        let wall_block = format!("{color}_wall_banner");

        // Standing: pole x/z 7.33..8.67 y0..28, crossbar y28..29.33, cloth
        // hanging the full pole length just south of it.
        let standing_specs = vec![
            box_spec(
                wood_prefix,
                "pole",
                [7.33, 0.0, 7.33],
                [8.67, 28.0, 8.67],
                2,
                42,
                2,
                44,
                0,
            ),
            box_spec(
                wood_prefix,
                "bar",
                [1.33, 28.0, 7.33],
                [14.67, 29.33, 8.67],
                20,
                2,
                2,
                0,
                42,
            ),
            box_spec(
                &cloth_prefix,
                "flag",
                [1.33, 2.67, 8.67],
                [14.67, 29.33, 9.33],
                20,
                40,
                1,
                0,
                0,
            )
            .tinted(rgb),
        ];
        let standing_id = format!("minecraft:block/{block}_synthetic");
        let standing = entity_box_model(&base, derived_tiles, &standing_specs, "#flag_north");
        raw_models.insert(standing_id.clone(), standing.clone());
        let mut residual_models = vec![standing_id.clone()];
        for s in 1..4u32 {
            let baked = bake_y_rotation(&standing, -(s as f64) * 22.5);
            let id = format!("{standing_id}_r{s}");
            raw_models.insert(id.clone(), baked);
            residual_models.push(id);
        }
        let mut variants = Map::new();
        for r in 0..16u32 {
            let mut entry = Map::new();
            entry.insert("model".into(), json!(residual_models[(r % 4) as usize]));
            if r / 4 > 0 {
                entry.insert("y".into(), json!(90 * (r / 4)));
            }
            variants.insert(format!("rotation={r}"), Value::Object(entry));
        }
        block_states.insert(
            format!("minecraft:block/{block}"),
            json!({ "variants": variants }),
        );

        // Wall (facing=north base geometry): crossbar flush under the block
        // top against the wall, cloth hanging past the block bottom.
        let wall_specs = vec![
            box_spec(
                wood_prefix,
                "bar",
                [1.33, 13.67, 14.5],
                [14.67, 15.17, 16.0],
                20,
                2,
                2,
                0,
                42,
            ),
            box_spec(
                &cloth_prefix,
                "flag",
                [1.33, -13.0, 13.67],
                [14.67, 13.67, 14.33],
                20,
                40,
                1,
                0,
                0,
            )
            .tinted(rgb),
        ];
        let wall_id = format!("minecraft:block/{wall_block}_synthetic");
        raw_models.insert(
            wall_id.clone(),
            entity_box_model(&base, derived_tiles, &wall_specs, "#flag_north"),
        );
        let mut wall_variants = Map::new();
        for (facing, y) in [("north", 0), ("east", 90), ("south", 180), ("west", 270)] {
            wall_variants.insert(
                format!("facing={facing}"),
                json!({ "model": wall_id, "y": y }),
            );
        }
        block_states.insert(
            format!("minecraft:block/{wall_block}"),
            json!({ "variants": wall_variants }),
        );
        count += 2;
    }
    count
}

// ---- Heads --------------------------------------------------------------------

/// (floor block, wall block, entity texture stem). Player heads use the
/// default skin (custom skins are NBT/UUID-driven and approximated away).
/// No hat box is synthesized: pixel-verified, the 8x8x8 hat slot at
/// texOffs (32,0) is empty in the four mob-skull skins and the default
/// player skin except one near-transparent creeper pixel (32,11, alpha 8)
/// that cutout classification drops anyway; piglin/dragon use whole-mob
/// textures whose (32,0) area belongs to other body parts, unsampled here.
const HEAD_KINDS: [(&str, &str, &str); 7] = [
    ("creeper_head", "creeper_wall_head", "creeper/creeper"),
    ("skeleton_skull", "skeleton_wall_skull", "skeleton/skeleton"),
    (
        "wither_skeleton_skull",
        "wither_skeleton_wall_skull",
        "skeleton/wither_skeleton",
    ),
    ("zombie_head", "zombie_wall_head", "zombie/zombie"),
    ("player_head", "player_wall_head", "player/slim/steve"),
    ("piglin_head", "piglin_wall_head", "piglin/piglin"),
    ("dragon_head", "dragon_wall_head", "enderdragon/dragon"),
];

/// Entity boxes of one head kind in floor position (face north, box on the
/// ground, centered): an 8x8x8 head for the mob-skull shapes, piglin's
/// snout/tusks/ears, or the dragon's 0.75-scaled head stack (texOffs all
/// pixel-verified; the dragon's world placement is the classic block-skull
/// arrangement — head box centered, lip/jaw protruding north past the block
/// edge, mouth closed).
fn head_box_specs(prefix: &str) -> Vec<BoxSpec> {
    let simple = |prefix: &str| {
        vec![box_spec(
            prefix,
            "head",
            [4.0, 0.0, 4.0],
            [12.0, 8.0, 12.0],
            8,
            8,
            8,
            0,
            0,
        )]
    };
    let piglin = |prefix: &str| {
        vec![
            box_spec(
                prefix,
                "skull",
                [3.0, 0.0, 4.0],
                [13.0, 8.0, 12.0],
                10,
                8,
                8,
                0,
                0,
            ),
            box_spec(
                prefix,
                "snout",
                [6.0, 1.0, 3.0],
                [10.0, 5.0, 4.0],
                4,
                4,
                1,
                31,
                1,
            ),
            box_spec(
                prefix,
                "tusk_left",
                [5.0, 0.0, 3.0],
                [6.0, 2.0, 4.0],
                1,
                2,
                1,
                2,
                4,
            ),
            box_spec(
                prefix,
                "tusk_right",
                [10.0, 0.0, 3.0],
                [11.0, 2.0, 4.0],
                1,
                2,
                1,
                2,
                0,
            ),
            box_spec(
                prefix,
                "ear_left",
                [2.0, 3.0, 4.0],
                [3.0, 8.0, 8.0],
                1,
                5,
                4,
                51,
                6,
            )
            .rotated([2.5, 3.0, 6.0], "z", 30.0),
            box_spec(
                prefix,
                "ear_right",
                [13.0, 3.0, 4.0],
                [14.0, 8.0, 8.0],
                1,
                5,
                4,
                39,
                6,
            )
            .rotated([13.5, 3.0, 6.0], "z", -30.0),
        ]
    };
    let dragon = |prefix: &str| {
        vec![
            box_spec(
                prefix,
                "upper_head",
                [2.0, 0.0, 2.0],
                [14.0, 12.0, 14.0],
                16,
                16,
                16,
                112,
                30,
            ),
            box_spec(
                prefix,
                "upper_lip",
                [3.5, 4.0, -6.0],
                [12.5, 7.75, 6.0],
                12,
                5,
                16,
                176,
                44,
            ),
            box_spec(
                prefix,
                "jaw",
                [3.5, 1.0, -6.0],
                [12.5, 4.0, 6.0],
                12,
                4,
                16,
                176,
                65,
            ),
            box_spec(
                prefix,
                "scale_left",
                [0.5, 7.0, 8.0],
                [2.0, 10.0, 12.5],
                2,
                4,
                6,
                0,
                0,
            ),
            box_spec(
                prefix,
                "scale_right",
                [14.0, 7.0, 8.0],
                [15.5, 10.0, 12.5],
                2,
                4,
                6,
                0,
                0,
            ),
            box_spec(
                prefix,
                "nostril_left",
                [5.0, 7.75, -3.0],
                [6.5, 9.25, 0.0],
                2,
                2,
                4,
                112,
                0,
            ),
            box_spec(
                prefix,
                "nostril_right",
                [9.5, 7.75, -3.0],
                [11.0, 9.25, 0.0],
                2,
                2,
                4,
                112,
                0,
            ),
        ]
    };
    match prefix.rsplit('/').next().unwrap_or("") {
        "piglin" => piglin(prefix),
        "dragon" => dragon(prefix),
        _ => simple(prefix),
    }
}

/// Shift a spec list by a block-space offset (wall heads move +y4 so the
/// box sits y4..12 and hug the wall side).
fn shift_specs(specs: Vec<BoxSpec>, by: [f64; 3]) -> Vec<BoxSpec> {
    specs
        .into_iter()
        .map(|mut s| {
            for i in 0..3 {
                s.from[i] += by[i];
                s.to[i] += by[i];
            }
            if let Some(rot) = &mut s.rotation {
                if let Some(origin) = rot.get_mut("origin").and_then(|o| o.as_array_mut()) {
                    for (i, v) in origin.iter_mut().enumerate() {
                        if let Some(n) = v.as_f64() {
                            *v = json!(n + by[i]);
                        }
                    }
                }
            }
            s
        })
        .collect()
}

/// Skulls and heads: floor blocks carry rotation=0..15 (22.5° steps baked
/// like banners), wall blocks carry facing. The y0 model faces north.
fn synthesize_heads(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let mut count = 0;
    for (floor_block, wall_block, tex) in HEAD_KINDS {
        let Some(src) = load_entity_texture(archive, &format!("entity/{tex}")) else {
            eprintln!("[head] entity/{tex}.png missing; {floor_block} keeps placeholder");
            continue;
        };
        let tile_prefix = format!("minecraft:entity/{tex}");
        let first_part = head_box_specs(&tile_prefix)[0].part.clone();

        let floor_specs = head_box_specs(&tile_prefix);
        let floor_id = format!("minecraft:block/{floor_block}_synthetic");
        let floor = entity_box_model(
            &src,
            derived_tiles,
            &floor_specs,
            &format!("#{first_part}_north"),
        );
        raw_models.insert(floor_id.clone(), floor.clone());
        let mut residual_models = vec![floor_id.clone()];
        for s in 1..4u32 {
            let id = format!("{floor_id}_r{s}");
            raw_models.insert(id.clone(), bake_y_rotation(&floor, -(s as f64) * 22.5));
            residual_models.push(id);
        }
        let mut variants = Map::new();
        for r in 0..16u32 {
            let mut entry = Map::new();
            entry.insert("model".into(), json!(residual_models[(r % 4) as usize]));
            if r / 4 > 0 {
                entry.insert("y".into(), json!(90 * (r / 4)));
            }
            variants.insert(format!("rotation={r}"), Value::Object(entry));
        }
        block_states.insert(
            format!("minecraft:block/{floor_block}"),
            json!({ "variants": variants }),
        );

        // Wall heads: same boxes shifted +y4/+z4 — the simple head then
        // spans y4..12 and z8..16, hugging the wall block to the south.
        let wall_specs = shift_specs(head_box_specs(&tile_prefix), [0.0, 4.0, 4.0]);
        let wall_id = format!("minecraft:block/{wall_block}_synthetic");
        raw_models.insert(
            wall_id.clone(),
            entity_box_model(
                &src,
                derived_tiles,
                &wall_specs,
                &format!("#{first_part}_north"),
            ),
        );
        block_states.insert(
            format!("minecraft:block/{wall_block}"),
            json!({ "variants": variants_empty_and_facing(&wall_id) }),
        );
        count += 2;
    }
    count
}

// ---- Copper golem statues -------------------------------------------------------

fn golem_texture_stem(block_id: &str) -> Option<&'static str> {
    let name = block_id.strip_prefix("minecraft:block/")?;
    let bare = name.strip_prefix("waxed_").unwrap_or(name);
    Some(match bare {
        "copper_golem_statue" => "copper_golem",
        "exposed_copper_golem_statue" => "copper_golem_exposed",
        "weathered_copper_golem_statue" => "copper_golem_weathered",
        "oxidized_copper_golem_statue" => "copper_golem_oxidized",
        _ => return None,
    })
}

/// Copper golem statues (standing pose; POSE variants and the glowing eyes
/// layer are approximated away). All nine box texOffs pixel-verified at
/// fill 1.00; the y0 model faces north (nose at low z), total height 24px
/// with the antenna ball poking past the block top — the vanilla silhouette.
fn synthesize_golem_statues(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let keys: Vec<String> = block_states
        .keys()
        .filter(|k| golem_texture_stem(k).is_some())
        .cloned()
        .collect();
    if keys.is_empty() {
        return 0;
    }
    // One model per oxidation texture; waxed blockstates share them (their
    // vanilla blockstates also point at the unwaxed model ids).
    let mut models: HashMap<&'static str, String> = HashMap::new();
    for stem in [
        "copper_golem",
        "copper_golem_exposed",
        "copper_golem_weathered",
        "copper_golem_oxidized",
    ] {
        let Some(src) = load_entity_texture(archive, &format!("entity/copper_golem/{stem}")) else {
            eprintln!("[golem] entity/copper_golem/{stem}.png missing");
            continue;
        };
        let tile_prefix = format!("minecraft:entity/copper_golem/{stem}");
        let specs = vec![
            box_spec(
                &tile_prefix,
                "leg_left",
                [4.0, 0.0, 6.0],
                [8.0, 5.0, 10.0],
                4,
                5,
                4,
                0,
                27,
            ),
            box_spec(
                &tile_prefix,
                "leg_right",
                [8.0, 0.0, 6.0],
                [12.0, 5.0, 10.0],
                4,
                5,
                4,
                16,
                27,
            ),
            box_spec(
                &tile_prefix,
                "body",
                [4.0, 5.0, 5.0],
                [12.0, 11.0, 11.0],
                8,
                6,
                6,
                0,
                15,
            ),
            box_spec(
                &tile_prefix,
                "arm_left",
                [1.0, 6.0, 6.0],
                [4.0, 16.0, 10.0],
                3,
                10,
                4,
                36,
                16,
            ),
            box_spec(
                &tile_prefix,
                "arm_right",
                [12.0, 6.0, 6.0],
                [15.0, 16.0, 10.0],
                3,
                10,
                4,
                50,
                16,
            ),
            box_spec(
                &tile_prefix,
                "skull",
                [4.0, 11.0, 3.0],
                [12.0, 16.0, 13.0],
                8,
                5,
                10,
                0,
                0,
            ),
            box_spec(
                &tile_prefix,
                "nose",
                [7.0, 12.0, 2.0],
                [9.0, 15.0, 4.0],
                2,
                3,
                2,
                56,
                0,
            ),
            box_spec(
                &tile_prefix,
                "antenna_stalk",
                [7.0, 16.0, 7.0],
                [9.0, 20.0, 9.0],
                2,
                4,
                2,
                37,
                8,
            ),
            box_spec(
                &tile_prefix,
                "antenna_block",
                [6.0, 20.0, 6.0],
                [10.0, 24.0, 10.0],
                4,
                4,
                4,
                37,
                0,
            ),
        ];
        let model_id = format!("minecraft:block/{stem}_statue_synthetic");
        raw_models.insert(
            model_id.clone(),
            entity_box_model(&src, derived_tiles, &specs, "#skull_north"),
        );
        models.insert(stem, model_id);
    }
    let mut count = 0;
    for state_key in keys {
        let stem = golem_texture_stem(&state_key).unwrap();
        let Some(model_id) = models.get(stem) else {
            continue;
        };
        block_states.insert(
            state_key,
            json!({ "variants": variants_empty_and_facing(model_id) }),
        );
        count += 1;
    }
    count
}

// ---- Conduits -------------------------------------------------------------------

/// Conduit: heart shell (6x6x6 from entity/conduit/base.png) inside the
/// open cage (8x8x8 from entity/conduit/cage.png — the cage texture is a
/// verified cutout lattice, alpha-classified automatically). The billboard
/// eye and the spinning wind wall are animated and approximated away.
fn synthesize_conduits(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let state_key = "minecraft:block/conduit";
    if !block_states.contains_key(state_key) {
        return 0;
    }
    let (Some(shell_src), Some(cage_src)) = (
        load_entity_texture(archive, "entity/conduit/base"),
        load_entity_texture(archive, "entity/conduit/cage"),
    ) else {
        eprintln!("[conduit] conduit textures missing; keeps placeholder");
        return 0;
    };
    let mut elements = Vec::new();
    let mut textures = Map::new();
    for (src, spec) in [
        (
            &shell_src,
            box_spec(
                "minecraft:entity/conduit/base",
                "shell",
                [5.0, 5.0, 5.0],
                [11.0, 11.0, 11.0],
                6,
                6,
                6,
                0,
                0,
            ),
        ),
        (
            &cage_src,
            box_spec(
                "minecraft:entity/conduit/cage",
                "cage",
                [4.0, 4.0, 4.0],
                [12.0, 12.0, 12.0],
                8,
                8,
                8,
                0,
                0,
            ),
        ),
    ] {
        let (element, tex) = entity_box_element(src, derived_tiles, &spec);
        elements.push(element);
        for (k, v) in tex {
            textures.insert(k, v);
        }
    }
    textures.insert("particle".into(), json!("#shell_north"));
    let model_id = "minecraft:block/conduit_synthetic";
    raw_models.insert(
        model_id.into(),
        json!({ "textures": textures, "elements": elements }),
    );
    block_states.insert(
        state_key.into(),
        json!({ "variants": { "": { "model": model_id } } }),
    );
    1
}

// ---- Decorated pots ---------------------------------------------------------------

/// Decorated pot: four one-faced wall planes (14x16 from the side texture,
/// rect (1,0,14,16) pixel-verified), shoulder/base planes (14x14 from the
/// base texture rects (0,13) and (14,13)), and the neck collar (8x3x8,
/// top face skipped — coplanar with the shoulder). Sherds are NBT-driven;
/// plain pots are approximated as the undecorated sides (all four walls
/// sample the same texture).
fn synthesize_decorated_pots(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
    archive: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>,
    derived_tiles: &mut HashMap<String, image::RgbaImage>,
) -> usize {
    let state_key = "minecraft:block/decorated_pot";
    if !block_states.contains_key(state_key) {
        return 0;
    }
    let (Some(base_src), Some(side_src)) = (
        load_entity_texture(archive, "entity/decorated_pot/decorated_pot_base"),
        load_entity_texture(archive, "entity/decorated_pot/decorated_pot_side"),
    ) else {
        eprintln!("[pot] decorated pot textures missing; keeps placeholder");
        return 0;
    };
    let base_prefix = "minecraft:entity/decorated_pot/base";
    let side_prefix = "minecraft:entity/decorated_pot/side";

    let mut elements = Vec::new();
    let mut textures = Map::new();

    // One wall plane per side: only the outward-facing face is declared,
    // with an explicit uv (zero-thickness faces get degenerate auto-UVs).
    let walls = [
        ("north", [1.0, 0.0, 1.0], [15.0, 16.0, 1.0]),
        ("south", [1.0, 0.0, 15.0], [15.0, 16.0, 15.0]),
        ("west", [1.0, 0.0, 1.0], [1.0, 16.0, 15.0]),
        ("east", [15.0, 0.0, 1.0], [15.0, 16.0, 15.0]),
    ];
    for (dir, from, to) in walls {
        let tile_id = format!("{side_prefix}__{dir}");
        let r = Rect {
            x: 1,
            y: 0,
            w: 14,
            h: 16,
        };
        derived_tiles
            .entry(tile_id.clone())
            .or_insert_with(|| crop_tile_scaled(&side_src, r, false, None).0);
        textures.insert(dir.to_string(), json!(tile_id));
        elements.push(json!({
            "from": from, "to": to,
            "faces": { dir: { "texture": format!("#{dir}"), "uv": [0, 0, 14, 16] } },
        }));
    }

    // Shoulder (up) and base (down) planes from the base texture.
    let planes = [
        (
            "up",
            [1.0, 16.0, 1.0],
            [15.0, 16.0, 15.0],
            Rect {
                x: 0,
                y: 13,
                w: 14,
                h: 14,
            },
        ),
        (
            "down",
            [1.0, 0.0, 1.0],
            [15.0, 0.0, 15.0],
            Rect {
                x: 14,
                y: 13,
                w: 14,
                h: 14,
            },
        ),
    ];
    for (dir, from, to, r) in planes {
        let tile_id = format!("{base_prefix}__{dir}");
        derived_tiles
            .entry(tile_id.clone())
            .or_insert_with(|| crop_tile_scaled(&base_src, r, false, None).0);
        textures.insert(dir.to_string(), json!(tile_id));
        elements.push(json!({
            "from": from, "to": to,
            "faces": { dir: { "texture": format!("#{dir}"), "uv": [0, 0, 14, 14] } },
        }));
    }

    // Neck collar; the up face is skipped: it is coplanar with (and hidden
    // under) the shoulder plane above it.
    let (neck, neck_tex) = entity_box_element(
        &base_src,
        derived_tiles,
        &box_spec(
            base_prefix,
            "neck",
            [4.0, 13.0, 4.0],
            [12.0, 16.0, 12.0],
            8,
            3,
            8,
            0,
            0,
        )
        .skipping(&["up"]),
    );
    elements.push(neck);
    for (k, v) in neck_tex {
        textures.insert(k, v);
    }
    textures.insert("particle".into(), json!("#north"));

    let model_id = "minecraft:block/decorated_pot_synthetic";
    raw_models.insert(
        model_id.into(),
        json!({ "textures": textures, "elements": elements }),
    );
    block_states.insert(
        state_key.into(),
        json!({ "variants": { "": { "model": model_id } } }),
    );
    1
}

// ---- End portals and lava --------------------------------------------------------

/// A full-cube model whose six faces sample `texture` and cull against
/// their own direction, used for the end-portal starfield (end_portal and
/// end_gateway share one model — both render the whole cube in 26.3) and
/// for lava (level variants fall back to "").
fn full_cube_model(texture: &str) -> Value {
    let mut faces = Map::new();
    for dir in ["up", "down", "north", "south", "west", "east"] {
        faces.insert(
            dir.to_string(),
            json!({ "texture": "#all", "uv": [0, 0, 16, 16], "cullface": dir }),
        );
    }
    json!({
        "textures": { "all": texture, "particle": "#all" },
        "elements": [{ "from": [0.0, 0.0, 0.0], "to": [16.0, 16.0, 16.0], "faces": faces }],
    })
}

fn synthesize_end_portals(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
) -> usize {
    let model_id = "minecraft:block/end_portal_synthetic";
    raw_models.insert(
        model_id.into(),
        full_cube_model("minecraft:entity/end_portal/end_portal"),
    );
    let mut count = 0;
    for name in ["end_portal", "end_gateway"] {
        let key = format!("minecraft:block/{name}");
        if block_states.remove(&key).is_some() {
            block_states.insert(key, json!({ "variants": { "": { "model": model_id } } }));
            count += 1;
        }
    }
    count
}

fn synthesize_lava(
    block_states: &mut Map<String, Value>,
    raw_models: &mut HashMap<String, Value>,
) -> usize {
    let key = "minecraft:block/lava";
    if block_states.get(key).is_none() {
        return 0;
    }
    let model_id = "minecraft:block/lava_synthetic";
    raw_models.insert(
        model_id.into(),
        full_cube_model("minecraft:block/lava_still"),
    );
    // A single "" variant also covers level=0..15 (pickVariant falls back
    // to it), and the full cube makes surface.ts occlusion/AO apply —
    // lava is an opaque fluid in vanilla.
    block_states.insert(
        key.into(),
        json!({ "variants": { "": { "model": model_id } } }),
    );
    1
}

// ---- Bare face-texture reference normalization -----------------------------------

/// 26.x ships models whose element faces name a textures-map key without
/// the '#' prefix (heavy_core writes "texture": "all"). The renderer only
/// resolves '#'-prefixed refs, so such faces fall out of the atlas. Rewrite
/// any bare face value that is a key of the same model's textures map;
/// real texture ids contain '/' and never collide with the short keys.
fn normalize_face_texture_refs(models: &mut HashMap<String, Value>) -> usize {
    let mut fixed = 0;
    for model in models.values_mut() {
        let Some(keys): Option<Vec<String>> = model
            .get("textures")
            .and_then(|t| t.as_object())
            .map(|o| o.keys().cloned().collect())
        else {
            continue;
        };
        if keys.is_empty() {
            continue;
        }
        let Some(elements) = model.get_mut("elements").and_then(|e| e.as_array_mut()) else {
            continue;
        };
        for element in elements {
            let Some(faces) = element.get_mut("faces").and_then(|f| f.as_object_mut()) else {
                continue;
            };
            for face in faces.values_mut() {
                let Some(tex) = face
                    .get("texture")
                    .and_then(|t| t.as_str())
                    .map(|s| s.to_string())
                else {
                    continue;
                };
                if !tex.starts_with('#') && keys.iter().any(|k| *k == tex) {
                    if let Some(obj) = face.as_object_mut() {
                        obj.insert("texture".into(), json!(format!("#{tex}")));
                        fixed += 1;
                    }
                }
            }
        }
    }
    fixed
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
    let path = state
        .config
        .data_dir
        .join("textures")
        .join("bundle.json.gz");
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
            assert!(
                !is_known_translucent(path),
                "{path} should stay as classified"
            );
        }
        // Cutout-classified glass becomes translucent; already-opaque stays opaque.
        let cutout_glass = image::RgbaImage::from_fn(2, 1, |x, _| {
            image::Rgba([200, 200, 200, if x == 0 { 0 } else { 255 }])
        });
        assert_eq!(
            classify_texture_alpha(&cutout_glass, "block/glass"),
            AlphaClass::Translucent
        );
        let opaque_glass = image::RgbaImage::from_pixel(2, 1, image::Rgba([200, 200, 200, 255]));
        assert_eq!(
            classify_texture_alpha(&opaque_glass, "block/glass"),
            AlphaClass::Opaque
        );
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
            [
                "minecraft:block/a",
                "minecraft:block/b",
                "minecraft:block/c",
                "minecraft:block/d"
            ]
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
        assert_rect(&base[4], 0, 33, 14, 10); // west lateral
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
        let model = chest_model_json(
            &src,
            &mut tiles,
            "minecraft:entity/chest/test",
            1.0,
            15.0,
            false,
        );

        let elements = model["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 3, "base + lid + latch");
        // Base sits inside the block; lid is inset to avoid coplanar sides.
        assert_eq!(elements[0]["from"], json!([1.0, 0.0, 1.0]));
        assert_eq!(elements[0]["to"], json!([15.0, 10.0, 15.0]));
        assert_eq!(
            elements[1]["to"],
            json!([15.0 - CHEST_EPS, 14.0, 15.0 - CHEST_EPS])
        );
        let latch = &elements[2];
        assert_eq!(latch["from"], json!([7.0, 7.0, 0.0]));
        assert_eq!(latch["to"], json!([9.0, 11.0, 1.0]));
        assert_eq!(latch["faces"]["north"]["uv"], json!([1, 1, 3, 5]));

        // Every face tile cropped its region. Chest up/down slots are
        // inverted vs the generic box layout (see chest_part_element), so
        // base_up samples the second top-row square (28, 19) and lid_up the
        // exterior-top square (28, 0) — the planks/ribbon region in real
        // chest textures, not the interior view at (14, 0).
        let up = &tiles["minecraft:entity/chest/test__base_up"];
        assert_eq!(up.get_pixel(0, 0), src.get_pixel(28, 19));
        let lid_up = &tiles["minecraft:entity/chest/test__lid_up"];
        assert_eq!(lid_up.get_pixel(0, 0), src.get_pixel(28, 0));
        let lid_down = &tiles["minecraft:entity/chest/test__lid_down"];
        assert_eq!(lid_down.get_pixel(0, 0), src.get_pixel(14, 0));
        let north = &tiles["minecraft:entity/chest/test__base_north"];
        assert_eq!(north.get_pixel(0, 0), src.get_pixel(14, 33));
        // The half variant is 15 wide, keeps its seam edge flush, mirrors
        // the north/south tiles (entity-vs-block side-face u direction),
        // and hugs a 1-wide latch to the seam.
        let mut half_tiles: HashMap<String, image::RgbaImage> = HashMap::new();
        let half = chest_model_json(
            &src,
            &mut half_tiles,
            "minecraft:entity/chest/test_h",
            0.0,
            15.0,
            true,
        );
        assert_eq!(half["elements"].as_array().unwrap().len(), 3);
        assert_eq!(half["elements"][0]["from"], json!([0.0, 0.0, 1.0]));
        // Right half hugs the west edge (seam at x0): lid starts flush there.
        assert_eq!(
            half["elements"][1]["from"],
            json!([0.0, 9.0, 1.0 + CHEST_EPS])
        );
        assert_eq!(
            half["elements"][1]["to"],
            json!([15.0 - CHEST_EPS, 14.0, 15.0 - CHEST_EPS])
        );
        // Latch hugs the same seam edge; its texOffs is (1,0) for right halves.
        assert_eq!(half["elements"][2]["from"], json!([0.0, 7.0, 0.0]));
        assert_eq!(half["elements"][2]["to"], json!([1.0, 11.0, 1.0]));
        assert_eq!(
            half["elements"][2]["faces"]["north"]["uv"],
            json!([1, 1, 2, 5])
        );
        // North/south tiles flip; up/down and laterals do not.
        let h_up = &half_tiles["minecraft:entity/chest/test_h__lid_up"];
        assert_eq!(h_up.get_pixel(0, 0), src.get_pixel(29, 0));
        assert_eq!(h_up.get_pixel(14, 0), src.get_pixel(43, 0));
        let h_north = &half_tiles["minecraft:entity/chest/test_h__base_north"];
        assert_eq!(h_north.get_pixel(0, 0), src.get_pixel(28, 33));
        let h_west = &half_tiles["minecraft:entity/chest/test_h__base_west"];
        assert_eq!(h_west.get_pixel(0, 0), src.get_pixel(0, 33));
        // The left half hugs the east edge: seam flush at x1, latch at (0,0).
        let mut left_tiles: HashMap<String, image::RgbaImage> = HashMap::new();
        let left = chest_model_json(
            &src,
            &mut left_tiles,
            "minecraft:entity/chest/test_l",
            1.0,
            16.0,
            true,
        );
        assert_eq!(
            left["elements"][1]["from"],
            json!([1.0 + CHEST_EPS, 9.0, 1.0 + CHEST_EPS])
        );
        assert_eq!(
            left["elements"][1]["to"],
            json!([16.0, 14.0, 15.0 - CHEST_EPS])
        );
        assert_eq!(left["elements"][2]["from"], json!([15.0, 7.0, 0.0]));
        assert_eq!(
            left["elements"][2]["faces"]["north"]["uv"],
            json!([1, 1, 2, 5])
        );
    }

    #[test]
    fn chest_families_map_to_entity_textures() {
        assert_eq!(chest_texture_stem("minecraft:block/chest"), Some("normal"));
        assert_eq!(
            chest_texture_stem("minecraft:block/trapped_chest"),
            Some("normal")
        );
        assert_eq!(
            chest_texture_stem("minecraft:block/ender_chest"),
            Some("ender")
        );
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

    // ---- entity-family synthesis tests ---------------------------------------

    fn synth_texture(w: u32, h: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 251) as u8, (y % 241) as u8, 77, 255])
        })
    }

    fn zip_from_textures(files: &[(&str, image::RgbaImage)]) -> Vec<u8> {
        let mut writer = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
        for (name, img) in files {
            writer
                .start_file::<_, ()>(*name, zip::write::FileOptions::default())
                .unwrap();
            let mut buf = std::io::Cursor::new(Vec::new());
            img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
            std::io::Write::write_all(&mut writer, buf.get_ref()).unwrap();
        }
        writer.finish().unwrap().into_inner()
    }

    fn empty_states(names: &[&str]) -> Map<String, Value> {
        names
            .iter()
            .map(|n| {
                (
                    format!("minecraft:block/{n}"),
                    json!({ "variants": { "": { "model": "minecraft:block/placeholder" } } }),
                )
            })
            .collect()
    }

    #[test]
    fn shulker_box_layout_matches_vanilla_textures() {
        // Lid 16x12x16 @ (0,0), base 16x8x16 @ (0,28) on the 64x64 entity
        // texture. The generic layout keeps the up face in the first slot:
        // pixel-verified the lid's outer top is (16,0) with fill 1.00 while
        // the second slot holds the mostly transparent interior view — the
        // chest up/down swap must NOT apply here.
        let lid = box_face_rects(16, 12, 16, 0, 0);
        assert_eq!((lid[0].x, lid[0].y, lid[0].w, lid[0].h), (16, 0, 16, 16));
        assert_eq!((lid[1].x, lid[1].y, lid[1].w, lid[1].h), (32, 0, 16, 16));
        assert_eq!((lid[2].x, lid[2].y, lid[2].w, lid[2].h), (16, 16, 16, 12));
        let base = box_face_rects(16, 8, 16, 0, 28);
        assert_eq!(
            (base[0].x, base[0].y, base[0].w, base[0].h),
            (16, 28, 16, 16)
        );
        assert_eq!(
            (base[3].x, base[3].y, base[3].w, base[3].h),
            (48, 44, 16, 8)
        );
        // Both 17 shulker textures are 64x64 (plain + 16 dye colors).
        assert_eq!(
            shulker_texture_stem("minecraft:block/shulker_box").as_deref(),
            Some("shulker")
        );
        assert_eq!(
            shulker_texture_stem("minecraft:block/purple_shulker_box").as_deref(),
            Some("shulker_purple")
        );
        assert_eq!(shulker_texture_stem("minecraft:block/chest"), None);
    }

    #[test]
    fn synthesizes_shulker_family_end_to_end() {
        let bytes = zip_from_textures(&[
            (
                "assets/minecraft/textures/entity/shulker/shulker.png",
                synth_texture(64, 64),
            ),
            (
                "assets/minecraft/textures/entity/shulker/shulker_purple.png",
                synth_texture(64, 64),
            ),
        ]);
        let mut archive = open_zip(&bytes).unwrap();
        let mut states = empty_states(&["shulker_box", "purple_shulker_box"]);
        let mut models = HashMap::new();
        let mut tiles = HashMap::new();
        assert_eq!(
            synthesize_shulker_boxes(&mut states, &mut models, &mut archive, &mut tiles),
            2
        );

        let model = &models["minecraft:block/shulker_box_synthetic"];
        let elements = model["elements"].as_array().unwrap();
        assert_eq!(elements.len(), 2);
        assert_eq!(elements[0]["from"], json!([0.0, 0.0, 0.0]));
        assert_eq!(elements[0]["to"], json!([16.0, 8.0, 16.0]));
        assert_eq!(elements[1]["from"], json!([0.0, 4.0, 0.0]));
        assert_eq!(elements[1]["to"], json!([16.0, 16.0, 16.0]));
        // Boundary faces cull; the interior overlap-band faces do not.
        assert_eq!(elements[0]["faces"]["north"]["cullface"], json!("north"));
        assert_eq!(elements[0]["faces"]["down"]["cullface"], json!("down"));
        assert_eq!(elements[0]["faces"]["up"]["cullface"], Value::Null);
        assert_eq!(elements[1]["faces"]["up"]["cullface"], json!("up"));

        // Generic layout, no chest swap: base_up samples the first top slot
        // (16,28) and lid_up the first slot (16,0); north tiles crop
        // mirrored east-west (entity vs block u direction).
        let src = synth_texture(64, 64);
        let base_up = &tiles["minecraft:entity/shulker/shulker__base_up"];
        assert_eq!(base_up.get_pixel(0, 0), src.get_pixel(16, 28));
        let lid_up = &tiles["minecraft:entity/shulker/shulker__lid_up"];
        assert_eq!(lid_up.get_pixel(0, 0), src.get_pixel(16, 0));
        let base_north = &tiles["minecraft:entity/shulker/shulker__base_north"];
        assert_eq!(base_north.get_pixel(0, 0), src.get_pixel(31, 44));

        let variants = states["minecraft:block/shulker_box"]["variants"]
            .as_object()
            .unwrap();
        assert_eq!(variants.len(), 7);
        assert_eq!(
            variants["facing=east"],
            json!({ "model": "minecraft:block/shulker_box_synthetic", "x": 90, "y": 90 })
        );
        assert_eq!(
            variants["facing=down"],
            json!({ "model": "minecraft:block/shulker_box_synthetic", "x": 180 })
        );
        assert_eq!(variants["facing=north"]["x"], json!(90));
        assert_eq!(variants[""].get("x"), None);
        assert!(models.contains_key("minecraft:block/purple_shulker_box_synthetic"));
    }

    #[test]
    fn crop_tile_scaled_fits_downscales_and_tints() {
        let src = image::RgbaImage::from_pixel(64, 64, image::Rgba([241, 241, 241, 255]));
        // Regions that fit keep their size.
        let (tile, w, h) = crop_tile_scaled(
            &src,
            Rect {
                x: 0,
                y: 0,
                w: 8,
                h: 10,
            },
            false,
            None,
        );
        assert_eq!((w, h), (8, 10));
        assert_eq!(tile.get_pixel(7, 9).0, [241, 241, 241, 255]);
        // Oversized regions scale to fit: the banner flag 20x40 -> 8x16.
        let (tile, w, h) = crop_tile_scaled(
            &src,
            Rect {
                x: 1,
                y: 1,
                w: 20,
                h: 40,
            },
            false,
            None,
        );
        assert_eq!((w, h), (8, 16));
        assert_eq!(
            tile.get_pixel(8, 0).0[3],
            0,
            "padded margin stays transparent"
        );
        // Tint premultiplies each channel (banner cloth dyeing).
        let (tile, _, _) = crop_tile_scaled(
            &src,
            Rect {
                x: 0,
                y: 0,
                w: 2,
                h: 2,
            },
            false,
            Some([128, 64, 255]),
        );
        assert_eq!(
            tile.get_pixel(0, 0).0,
            [
                ((241 * 128 + 127) / 255) as u8,
                ((241 * 64 + 127) / 255) as u8,
                ((241 * 255 + 127) / 255) as u8,
                255
            ]
        );
        // Flip mirrors east-west.
        let mut asym = image::RgbaImage::new(4, 1);
        for x in 0..4 {
            asym.put_pixel(x, 0, image::Rgba([x as u8, 0, 0, 255]));
        }
        let (tile, _, _) = crop_tile_scaled(
            &asym,
            Rect {
                x: 0,
                y: 0,
                w: 4,
                h: 1,
            },
            true,
            None,
        );
        assert_eq!(tile.get_pixel(0, 0).0[0], 3);
    }

    #[test]
    fn synthesizes_banners_with_dye_tint_and_rotations() {
        let cloth = image::RgbaImage::from_pixel(64, 64, image::Rgba([241, 241, 241, 255]));
        let bytes = zip_from_textures(&[(
            "assets/minecraft/textures/entity/banner/banner_base.png",
            cloth.clone(),
        )]);
        let mut archive = open_zip(&bytes).unwrap();
        let mut states = empty_states(&["white_banner", "white_wall_banner"]);
        let mut models = HashMap::new();
        let mut tiles = HashMap::new();
        assert_eq!(
            synthesize_banners(&mut states, &mut models, &mut archive, &mut tiles),
            32
        );

        let standing = &models["minecraft:block/white_banner_synthetic"];
        let els = standing["elements"].as_array().unwrap();
        assert_eq!(els.len(), 3);
        assert_eq!(els[0]["from"], json!([7.33, 0.0, 7.33]));
        assert_eq!(els[0]["to"], json!([8.67, 28.0, 8.67]));
        assert_eq!(els[1]["from"], json!([1.33, 28.0, 7.33]));
        assert_eq!(els[2]["to"], json!([14.67, 29.33, 9.33]));
        // Flag faces sample the scaled-down tile content.
        assert_eq!(els[2]["faces"]["north"]["uv"], json!([0, 0, 8, 16]));

        // Three residual bakes exist and rotate about the vertical axis
        // through (8, 0, 8).
        let r1 = &models["minecraft:block/white_banner_synthetic_r1"];
        assert_eq!(
            r1["elements"][0]["rotation"],
            json!({ "origin": [8.0, 0.0, 8.0], "axis": "y", "angle": -22.5 })
        );
        let variants = states["minecraft:block/white_banner"]["variants"]
            .as_object()
            .unwrap();
        assert_eq!(variants.len(), 16);
        assert_eq!(
            variants["rotation=0"]["model"],
            json!("minecraft:block/white_banner_synthetic")
        );
        assert_eq!(
            variants["rotation=4"],
            json!({ "model": "minecraft:block/white_banner_synthetic", "y": 90 })
        );
        assert_eq!(
            variants["rotation=5"],
            json!({ "model": "minecraft:block/white_banner_synthetic_r1", "y": 90 })
        );
        assert_eq!(
            variants["rotation=15"]["model"],
            json!("minecraft:block/white_banner_synthetic_r3")
        );

        // Wall form: facings via y quarter turns, cloth hangs below the
        // block (vanilla 26.3 wall-banner proportions).
        let wall = &models["minecraft:block/white_wall_banner_synthetic"];
        assert_eq!(wall["elements"][1]["from"], json!([1.33, -13.0, 13.67]));
        assert_eq!(
            states["minecraft:block/white_wall_banner"]["variants"]["facing=east"]["y"],
            json!(90)
        );

        // Dye tint: white cloth premultiplied by the dye color (magenta
        // 199,78,189); the wooden pole/bar tiles stay untinted and shared
        // across all sixteen colors.
        let flag = &tiles["minecraft:entity/banner/magenta__flag_north"];
        assert_eq!(flag.dimensions(), (16, 16));
        assert_eq!(
            flag.get_pixel(0, 0).0,
            [
                ((241 * 199 + 127) / 255) as u8,
                ((241 * 78 + 127) / 255) as u8,
                ((241 * 189 + 127) / 255) as u8,
                255
            ]
        );
        let pole = &tiles["minecraft:entity/banner/wood__pole_north"];
        assert_eq!(pole.get_pixel(0, 0).0, [241, 241, 241, 255]);
        assert!(tiles.contains_key("minecraft:entity/banner/black__flag_north"));
    }

    #[test]
    fn synthesizes_heads_floor_and_wall() {
        let bytes = zip_from_textures(&[
            (
                "assets/minecraft/textures/entity/creeper/creeper.png",
                synth_texture(64, 32),
            ),
            (
                "assets/minecraft/textures/entity/piglin/piglin.png",
                synth_texture(64, 64),
            ),
        ]);
        let mut archive = open_zip(&bytes).unwrap();
        let mut states = empty_states(&[
            "creeper_head",
            "creeper_wall_head",
            "piglin_head",
            "piglin_wall_head",
        ]);
        let mut models = HashMap::new();
        let mut tiles = HashMap::new();
        // Only creeper and piglin textures exist in the fixture zip; the
        // other five kinds keep their placeholder blockstates.
        assert_eq!(
            synthesize_heads(&mut states, &mut models, &mut archive, &mut tiles),
            4
        );

        let floor = &models["minecraft:block/creeper_head_synthetic"];
        assert_eq!(floor["elements"][0]["from"], json!([4.0, 0.0, 4.0]));
        assert_eq!(floor["elements"][0]["to"], json!([12.0, 8.0, 12.0]));
        let wall = &models["minecraft:block/creeper_wall_head_synthetic"];
        assert_eq!(wall["elements"][0]["from"], json!([4.0, 4.0, 8.0]));
        assert_eq!(wall["elements"][0]["to"], json!([12.0, 12.0, 16.0]));

        let floor_variants = states["minecraft:block/creeper_head"]["variants"]
            .as_object()
            .unwrap();
        assert_eq!(floor_variants.len(), 16);
        assert_eq!(
            floor_variants["rotation=7"],
            json!({ "model": "minecraft:block/creeper_head_synthetic_r3", "y": 90 })
        );
        let wall_variants = states["minecraft:block/creeper_wall_head"]["variants"]
            .as_object()
            .unwrap();
        assert_eq!(wall_variants.len(), 5);
        assert_eq!(wall_variants["facing=south"]["y"], json!(180));

        // Piglin: skull + snout + tusks + tilted ears (z-rotation).
        let piglin = &models["minecraft:block/piglin_head_synthetic"];
        let els = piglin["elements"].as_array().unwrap();
        assert_eq!(els.len(), 6);
        assert_eq!(els[0]["from"], json!([3.0, 0.0, 4.0]));
        assert_eq!(
            els[4]["rotation"],
            json!({ "origin": [2.5, 3.0, 6.0], "axis": "z", "angle": 30.0 })
        );
        // The 45-degree residual bake: plain elements gain the y rotation,
        // the already-rotated ear keeps its tilt while its box and pivot
        // move along the arc.
        let baked = &models["minecraft:block/piglin_head_synthetic_r2"];
        assert_eq!(
            baked["elements"][0]["rotation"],
            json!({ "origin": [8.0, 0.0, 8.0], "axis": "y", "angle": -45.0 })
        );
        assert_eq!(baked["elements"][4]["rotation"]["angle"], json!(30.0));
        let moved = rotate_y_about([2.5, 5.5, 6.0], [8.0, 0.0, 8.0], -45.0);
        assert_eq!(
            baked["elements"][4]["from"][0].as_f64().unwrap(),
            moved[0] - 0.5
        );
        assert_eq!(
            baked["elements"][4]["to"][1].as_f64().unwrap(),
            moved[1] + 2.5
        );
    }

    #[test]
    fn synthesizes_golem_statues_with_waxed_sharing() {
        let bytes = zip_from_textures(&[(
            "assets/minecraft/textures/entity/copper_golem/copper_golem.png",
            synth_texture(64, 64),
        )]);
        let mut archive = open_zip(&bytes).unwrap();
        let mut states = empty_states(&[
            "copper_golem_statue",
            "exposed_copper_golem_statue",
            "waxed_copper_golem_statue",
            "waxed_exposed_copper_golem_statue",
        ]);
        let mut models = HashMap::new();
        let mut tiles = HashMap::new();
        // Only the plain texture exists: plain + waxed-plain synthesize,
        // the exposed stems keep their placeholders.
        assert_eq!(
            synthesize_golem_statues(&mut states, &mut models, &mut archive, &mut tiles),
            2
        );
        let model = &models["minecraft:block/copper_golem_statue_synthetic"];
        let els = model["elements"].as_array().unwrap();
        assert_eq!(els.len(), 9);
        assert_eq!(els[5]["from"], json!([4.0, 11.0, 3.0]), "skull");
        assert_eq!(
            els[6]["from"],
            json!([7.0, 12.0, 2.0]),
            "nose at low z (faces north)"
        );
        assert_eq!(
            els[8]["to"],
            json!([10.0, 24.0, 10.0]),
            "antenna ball tops out at y24"
        );
        assert_eq!(
            states["minecraft:block/waxed_copper_golem_statue"]["variants"]["facing=east"],
            json!({ "model": "minecraft:block/copper_golem_statue_synthetic", "y": 90 })
        );
        // Untouched family keeps its placeholder blockstate verbatim.
        assert_eq!(
            states["minecraft:block/exposed_copper_golem_statue"]["variants"][""]["model"],
            json!("minecraft:block/placeholder")
        );
    }

    #[test]
    fn synthesizes_conduit_pot_end_portals_and_lava() {
        let bytes = zip_from_textures(&[
            (
                "assets/minecraft/textures/entity/conduit/base.png",
                synth_texture(32, 16),
            ),
            (
                "assets/minecraft/textures/entity/conduit/cage.png",
                synth_texture(32, 16),
            ),
            (
                "assets/minecraft/textures/entity/decorated_pot/decorated_pot_base.png",
                synth_texture(32, 32),
            ),
            (
                "assets/minecraft/textures/entity/decorated_pot/decorated_pot_side.png",
                synth_texture(16, 16),
            ),
        ]);
        let mut archive = open_zip(&bytes).unwrap();
        let mut states = empty_states(&[
            "conduit",
            "decorated_pot",
            "end_portal",
            "end_gateway",
            "lava",
        ]);
        let mut models = HashMap::new();
        let mut tiles = HashMap::new();

        assert_eq!(
            synthesize_conduits(&mut states, &mut models, &mut archive, &mut tiles),
            1
        );
        let conduit = &models["minecraft:block/conduit_synthetic"];
        let els = conduit["elements"].as_array().unwrap();
        assert_eq!(els.len(), 2);
        assert_eq!(els[0]["from"], json!([5.0, 5.0, 5.0]), "shell");
        assert_eq!(els[1]["to"], json!([12.0, 12.0, 12.0]), "cage");
        assert_eq!(conduit["textures"]["particle"], json!("#shell_north"));

        assert_eq!(
            synthesize_decorated_pots(&mut states, &mut models, &mut archive, &mut tiles),
            1
        );
        let pot = &models["minecraft:block/decorated_pot_synthetic"];
        let els = pot["elements"].as_array().unwrap();
        assert_eq!(els.len(), 7, "4 walls + shoulder + base + neck");
        assert_eq!(els[0]["faces"]["north"]["uv"], json!([0, 0, 14, 16]));
        assert_eq!(
            els[0]["faces"].as_object().unwrap().len(),
            1,
            "walls are one-faced planes"
        );
        assert_eq!(els[4]["faces"]["up"]["uv"], json!([0, 0, 14, 14]));
        let neck = &els[6];
        assert!(
            neck["faces"].get("up").is_none(),
            "neck top hidden under the shoulder plane"
        );
        assert_eq!(neck["faces"].as_object().unwrap().len(), 5);

        assert_eq!(synthesize_end_portals(&mut states, &mut models), 2);
        let end_model = &models["minecraft:block/end_portal_synthetic"];
        assert_eq!(
            end_model["textures"]["all"],
            json!("minecraft:entity/end_portal/end_portal")
        );
        for dir in ["up", "down", "north", "south", "west", "east"] {
            assert_eq!(
                end_model["elements"][0]["faces"][dir]["cullface"],
                json!(dir)
            );
        }
        assert_eq!(
            states["minecraft:block/end_gateway"]["variants"][""]["model"],
            json!("minecraft:block/end_portal_synthetic")
        );

        assert_eq!(synthesize_lava(&mut states, &mut models), 1);
        let lava = &models["minecraft:block/lava_synthetic"];
        assert_eq!(lava["textures"]["all"], json!("minecraft:block/lava_still"));
        assert_eq!(lava["elements"][0]["from"], json!([0.0, 0.0, 0.0]));
        assert_eq!(lava["elements"][0]["to"], json!([16.0, 16.0, 16.0]));
        assert_eq!(
            states["minecraft:block/lava"]["variants"][""]["model"],
            json!("minecraft:block/lava_synthetic")
        );
    }

    #[test]
    fn bare_face_texture_refs_normalized_like_heavy_core() {
        // Shaped after the shipped heavy_core model: faces name a textures
        // key without '#', which the renderer cannot resolve against the
        // atlas. Literal texture ids (paths) never match the short keys and
        // stay verbatim.
        let mut models: HashMap<String, Value> = [
            (
                "minecraft:block/heavy_core",
                json!({
                    "textures": { "all": "block/heavy_core", "particle": "block/heavy_core" },
                    "elements": [{ "from": [4, 0, 4], "to": [12, 8, 12], "faces": {
                        "north": { "uv": [0, 8, 8, 16], "texture": "all" },
                        "up": { "uv": [0, 0, 8, 8], "texture": "#all" }
                    }}]
                }),
            ),
            (
                "minecraft:block/cube",
                json!({
                    "textures": { "all": "block/stone" },
                    "elements": [{ "from": [0, 0, 0], "to": [16, 16, 16], "faces": {
                        "north": { "texture": "block/stone" }
                    }}]
                }),
            ),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v))
        .collect();

        assert_eq!(normalize_face_texture_refs(&mut models), 1);
        let heavy = &models["minecraft:block/heavy_core"];
        assert_eq!(
            heavy["elements"][0]["faces"]["north"]["texture"],
            json!("#all")
        );
        assert_eq!(
            heavy["elements"][0]["faces"]["up"]["texture"],
            json!("#all")
        );
        assert_eq!(
            heavy["textures"]["all"],
            json!("block/heavy_core"),
            "texture map untouched"
        );
        let cube = &models["minecraft:block/cube"];
        assert_eq!(
            cube["elements"][0]["faces"]["north"]["texture"],
            json!("block/stone")
        );
    }
}
