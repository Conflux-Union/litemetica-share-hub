use litematica::{decompress_gzip_with_limit, BlockState, Document};
use serde::Serialize;
use std::collections::HashMap;

pub const MC_DATA_VERSIONS: &str = include_str!("../data/mc_data_versions.json");
pub const BLOCK_NAMES_ZH_CN: &str = include_str!("../data/block_names_zh_cn.json");

/// Preview payload schema version.
/// 1 = palette carried bare block ids; 2 = palette carries full state strings.
pub const PREVIEW_SCHEMA_VERSION: u32 = 2;

/// Map a Minecraft data version to the release it belongs to (or the closest older release).
pub fn mc_version_name(data_version: i64) -> String {
    let versions: HashMap<String, String> =
        serde_json::from_str(MC_DATA_VERSIONS).expect("bundled mc_data_versions.json is valid");
    let mut best: Option<(i64, &String)> = None;
    for (dv, name) in versions.iter() {
        let dv: i64 = dv.parse().expect("data version keys are integers");
        if dv <= data_version && best.map(|(b, _)| dv > b).unwrap_or(true) {
            best = Some((dv, name));
        }
    }
    match best {
        Some((dv, name)) if dv == data_version => name.clone(),
        Some((_, name)) => format!("{name}+"),
        None => format!("未知 (DataVersion {data_version})"),
    }
}

#[derive(Debug, Serialize, Clone)]
pub struct MaterialEntry {
    pub item_id: String,
    pub name_zh: String,
    pub count: u64,
}

#[derive(Debug, Serialize)]
pub struct RegionPreview {
    pub name: String,
    pub pos: [i64; 3],
    pub size: [i64; 3],
    /// Canonical full-state strings `name[k=v,...]` (properties sorted by key),
    /// aligned with RLE palette indices. Property-less blocks keep the bare name.
    pub palette: Vec<String>,
    /// Run-length encoding in block iteration order (x fastest, then z, then y).
    pub rle: Vec<[u64; 2]>,
}

#[derive(Debug, Serialize)]
pub struct PreviewData {
    pub schema: u32,
    pub size: [i64; 3],
    pub regions: Vec<RegionPreview>,
}

#[derive(Debug)]
pub struct ParsedSchematic {
    pub name: String,
    pub author: String,
    pub description: String,
    pub litematica_version: i64,
    pub mc_data_version: i64,
    pub mc_version_name: String,
    pub width: i64,
    pub height: i64,
    pub depth: i64,
    pub region_count: usize,
    pub total_blocks: u64,
    pub materials: Vec<MaterialEntry>,
    pub preview: PreviewData,
}

/// Format a block state as the canonical state string `name[k=v,...]` with
/// properties sorted by key, so equal states always serialize identically.
/// Blocks without properties serialize as the bare block name.
fn state_key(block: &BlockState) -> String {
    if block.properties.is_empty() {
        return block.name.clone();
    }
    let mut props: Vec<(&str, &str)> = block
        .properties
        .iter()
        .map(|(k, v)| (k.as_str(), v.as_str()))
        .collect();
    props.sort_unstable();
    let mut key = String::with_capacity(block.name.len() + props.len() * 8);
    key.push_str(&block.name);
    key.push('[');
    for (i, (k, v)) in props.iter().enumerate() {
        if i > 0 {
            key.push(',');
        }
        key.push_str(k);
        key.push('=');
        key.push_str(v);
    }
    key.push(']');
    key
}

/// Strip the `[k=v,...]` property section from a state string, returning the
/// bare block name that material/stat helpers expect.
fn bare_block_name(state: &str) -> &str {
    match state.find('[') {
        Some(i) => &state[..i],
        None => state,
    }
}

/// Blocks that never appear in a survival material list.
fn is_excluded_block(name: &str) -> bool {
    matches!(
        name,
        "minecraft:air"
            | "minecraft:cave_air"
            | "minecraft:void_air"
            | "minecraft:water"
            | "minecraft:lava"
            | "minecraft:fire"
            | "minecraft:soul_fire"
            | "minecraft:nether_portal"
            | "minecraft:end_portal"
            | "minecraft:end_gateway"
            | "minecraft:moving_piston"
            | "minecraft:piston_head"
            | "minecraft:barrier"
            | "minecraft:structure_void"
            | "minecraft:light"
            | "minecraft:bubble_column"
    )
}

/// Map a block id to the item id players actually need to craft/place it.
/// Shared with the texture extractor, which uses it to collect item models
/// for the material universe (several items render as sprites, not blocks).
pub(crate) fn block_to_item(block: &str) -> Option<String> {
    let name = block.strip_prefix("minecraft:").unwrap_or(block);
    if is_excluded_block(block) {
        return None;
    }
    let mapped = match name {
        // Torch family
        "wall_torch" => "torch",
        "soul_wall_torch" => "soul_torch",
        "redstone_wall_torch" => "redstone_torch",
        // Crops and plants whose item differs
        "beetroots" => "beetroot_seeds",
        "carrots" => "carrot",
        "potatoes" => "potato",
        "pumpkin_stem" | "attached_pumpkin_stem" => "pumpkin_seeds",
        "melon_stem" | "attached_melon_stem" => "melon_seeds",
        "torchflower_crop" => "torchflower_seeds",
        "pitcher_crop" => "pitcher_pod",
        "cocoa" => "cocoa_beans",
        "kelp_plant" => "kelp",
        "cave_vines" | "cave_vines_plant" => "glow_berries",
        "bamboo_sapling" => "bamboo",
        "sweet_berry_bush" => "sweet_berries",
        "redstone_wire" => "redstone",
        "tripwire" => "string",
        "farmland" => "dirt",
        "dirt_path" => "dirt",
        "frosted_ice" => "ice",
        "water_cauldron" | "lava_cauldron" | "powder_snow_cauldron" => "cauldron",
        "chorus_plant" => "chorus_fruit",
        "snow" => "snow_layer_item",
        // Wall signs -> signs
        other => {
            if let Some(base) = other.strip_suffix("_wall_sign") {
                return Some(format!("minecraft:{base}_sign"));
            }
            if let Some(base) = other.strip_suffix("_wall_hanging_sign") {
                return Some(format!("minecraft:{base}_hanging_sign"));
            }
            if other.starts_with("potted_") {
                return Some("minecraft:flower_pot".to_string());
            }
            other
        }
    };
    let mapped = match mapped {
        // "snow" layers place a snow (layer) block using the snow item in modern versions.
        "snow_layer_item" => "snow",
        other => other,
    };
    Some(format!("minecraft:{mapped}"))
}

fn zh_name(item_id: &str) -> String {
    let names: HashMap<String, String> =
        serde_json::from_str(BLOCK_NAMES_ZH_CN).expect("bundled block_names_zh_cn.json is valid");
    let short = item_id.strip_prefix("minecraft:").unwrap_or(item_id);
    names
        .get(&format!("block.minecraft.{short}"))
        .or_else(|| names.get(&format!("item.minecraft.{short}")))
        .cloned()
        .unwrap_or_else(|| short.to_string())
}

/// Parse a .litematic byte blob into metadata, material list, and RLE preview
/// data. `decompress_limit` bounds the gzip-inflated NBT size (bytes), which
/// is the real memory cost of parsing an untrusted file.
///
/// Uses the streaming `litematica` reader: the NBT payload is scanned once
/// without building a tree, and block indices are decoded on the fly from the
/// borrowed `BlockStates` payload instead of being expanded into a per-voxel
/// vector.
pub fn parse_litematic(bytes: &[u8], decompress_limit: u64) -> Result<ParsedSchematic, String> {
    let nbt = decompress_gzip_with_limit(bytes, decompress_limit).map_err(|e| match e {
        litematica::Error::SizeLimitExceeded { .. } => format!(
            "文件解压后超过 {} MB 上限，文件过大",
            decompress_limit / (1024 * 1024)
        ),
        other => format!("无法解压 litematic 文件: {other}"),
    })?;
    let doc = Document::parse(&nbt).map_err(|e| format!("无法解析 litematic 文件: {e}"))?;
    if doc.regions.is_empty() {
        return Err("litematic 文件不包含任何区域 (region)".into());
    }

    let meta = &doc.metadata;
    let enclosing = doc.enclosing_size().unwrap_or([0i32; 3]);

    let mut item_counts: HashMap<String, u64> = HashMap::new();
    let mut total_blocks: u64 = 0;
    let mut regions_out = Vec::with_capacity(doc.regions.len());

    for region in &doc.regions {
        let palette = region.palette();
        let palette_states: Vec<String> = palette.iter().map(state_key).collect();

        // Count materials per palette entry and build the RLE in one pass.
        // iter_blocks yields raw indices in storage order (x fastest, then z,
        // then y) and does not validate them against the palette, so a corrupt
        // file is rejected here instead of panicking.
        let mut entry_counts = vec![0u64; palette.len()];
        let mut rle: Vec<[u64; 2]> = Vec::new();
        let mut run: Option<(u64, u64)> = None;
        for idx in region.iter_blocks() {
            let idx = usize::try_from(idx)
                .ok()
                .filter(|i| *i < palette.len())
                .ok_or_else(|| {
                    format!("文件损坏：区域 {} 的方块索引超出 palette 范围", region.name)
                })?;
            entry_counts[idx] += 1;
            match run {
                Some((cur, len)) if cur == idx as u64 => run = Some((cur, len + 1)),
                Some((cur, len)) => {
                    rle.push([cur, len]);
                    run = Some((idx as u64, 1));
                }
                None => run = Some((idx as u64, 1)),
            }
        }
        if let Some((cur, len)) = run {
            rle.push([cur, len]);
        }

        for (idx, count) in entry_counts.into_iter().enumerate() {
            if count == 0 {
                continue;
            }
            // Material statistics work on bare names; the preview palette
            // carries full state strings, so strip the property section first.
            let block_id = bare_block_name(&palette_states[idx]);
            if is_excluded_block(block_id) {
                continue;
            }
            total_blocks += count;
            if let Some(item) = block_to_item(block_id) {
                *item_counts.entry(item).or_insert(0) += count;
            }
        }

        regions_out.push(RegionPreview {
            name: region.name.clone(),
            pos: [
                i64::from(region.position[0]),
                i64::from(region.position[1]),
                i64::from(region.position[2]),
            ],
            size: [
                i64::from(region.size[0]),
                i64::from(region.size[1]),
                i64::from(region.size[2]),
            ],
            palette: palette_states,
            rle,
        });
    }

    let mut materials: Vec<MaterialEntry> = item_counts
        .into_iter()
        .map(|(item_id, count)| MaterialEntry {
            name_zh: zh_name(&item_id),
            item_id,
            count,
        })
        .collect();
    materials.sort_by(|a, b| b.count.cmp(&a.count).then(a.item_id.cmp(&b.item_id)));

    Ok(ParsedSchematic {
        name: meta.name.clone(),
        author: meta.author.clone(),
        description: meta.description.clone(),
        litematica_version: i64::from(meta.version),
        mc_data_version: i64::from(meta.minecraft_data_version),
        mc_version_name: mc_version_name(i64::from(meta.minecraft_data_version)),
        width: i64::from(enclosing[0]),
        height: i64::from(enclosing[1]),
        depth: i64::from(enclosing[2]),
        region_count: doc.regions.len(),
        total_blocks,
        materials,
        preview: PreviewData {
            schema: PREVIEW_SCHEMA_VERSION,
            size: [
                i64::from(enclosing[0]),
                i64::from(enclosing[1]),
                i64::from(enclosing[2]),
            ],
            regions: regions_out,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_mapping() {
        assert_eq!(mc_version_name(3700), "1.20.4");
        assert_eq!(mc_version_name(3701), "1.20.4+");
        assert_eq!(mc_version_name(5023), "26.3");
    }

    #[test]
    fn item_mapping() {
        assert_eq!(
            block_to_item("minecraft:oak_wall_sign").unwrap(),
            "minecraft:oak_sign"
        );
        assert_eq!(
            block_to_item("minecraft:potted_daisy").unwrap(),
            "minecraft:flower_pot"
        );
        assert_eq!(
            block_to_item("minecraft:carrots").unwrap(),
            "minecraft:carrot"
        );
        assert_eq!(block_to_item("minecraft:stone").unwrap(), "minecraft:stone");
        assert!(block_to_item("minecraft:water").is_none());
    }

    fn state(name: &str, props: &[(&str, &str)]) -> BlockState {
        BlockState {
            name: name.to_string(),
            properties: props
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    #[test]
    fn state_key_is_canonical_regardless_of_map_order() {
        // Insertion order is deliberately non-alphabetic; output must be sorted by key.
        let wire = state(
            "minecraft:redstone_wire",
            &[
                ("power", "7"),
                ("west", "side"),
                ("north", "up"),
                ("south", "side"),
                ("east", "side"),
            ],
        );
        assert_eq!(
            state_key(&wire),
            "minecraft:redstone_wire[east=side,north=up,power=7,south=side,west=side]"
        );
        // Property-less blocks stay bare.
        assert_eq!(state_key(&state("minecraft:stone", &[])), "minecraft:stone");
    }

    #[test]
    fn bare_name_strips_property_section() {
        assert_eq!(
            bare_block_name("minecraft:oak_stairs[facing=east,half=top,shape=straight]"),
            "minecraft:oak_stairs"
        );
        assert_eq!(bare_block_name("minecraft:stone"), "minecraft:stone");
    }
}
