use rustmatica::Litematic;
use serde::Serialize;
use std::collections::HashMap;

pub const MC_DATA_VERSIONS: &str = include_str!("../data/mc_data_versions.json");
pub const BLOCK_NAMES_ZH_CN: &str = include_str!("../data/block_names_zh_cn.json");

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
    /// Block ids (properties stripped), aligned with RLE palette indices.
    pub palette: Vec<String>,
    /// Run-length encoding in block iteration order (x fastest, then z, then y).
    pub rle: Vec<[u64; 2]>,
}

#[derive(Debug, Serialize)]
pub struct PreviewData {
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
fn block_to_item(block: &str) -> Option<String> {
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

/// Parse a .litematic byte blob into metadata, material list, and RLE preview data.
pub fn parse_litematic(bytes: &[u8]) -> Result<ParsedSchematic, String> {
    let schem: Litematic =
        Litematic::from_bytes(bytes).map_err(|e| format!("无法解析 litematic 文件: {e}"))?;
    if schem.regions.is_empty() {
        return Err("litematic 文件不包含任何区域 (region)".into());
    }

    let meta = &schem.metadata;
    let enclosing = schem.enclosing_size();

    let mut item_counts: HashMap<String, u64> = HashMap::new();
    let mut total_blocks: u64 = 0;
    let mut regions_out = Vec::with_capacity(schem.regions.len());

    for region in &schem.regions {
        let palette = region.block_palette();
        // `blocks()` yields references into the palette, so pointer identity gives
        // an O(1) block-state -> palette-index lookup without hashing the states.
        let mut ptr_to_idx: HashMap<*const _, u32> = HashMap::with_capacity(palette.len());
        for (i, b) in palette.iter().enumerate() {
            ptr_to_idx.insert(b as *const _, i as u32);
        }

        let palette_ids: Vec<String> = palette
            .iter()
            .map(|b| b.name.clone().into_owned())
            .collect();

        // Count materials per palette entry and build the RLE in one pass.
        let mut entry_counts = vec![0u64; palette.len()];
        let mut rle: Vec<[u64; 2]> = Vec::new();
        let mut run: Option<(u32, u64)> = None;
        for (_pos, block) in region.blocks() {
            let idx = *ptr_to_idx
                .get(&(block as *const _))
                .expect("blocks iterator yields palette entries");
            entry_counts[idx as usize] += 1;
            match run {
                Some((cur, len)) if cur == idx => run = Some((cur, len + 1)),
                Some((cur, len)) => {
                    rle.push([cur as u64, len]);
                    run = Some((idx, 1));
                }
                None => run = Some((idx, 1)),
            }
        }
        if let Some((cur, len)) = run {
            rle.push([cur as u64, len]);
        }

        for (idx, count) in entry_counts.into_iter().enumerate() {
            if count == 0 {
                continue;
            }
            let block_id = &palette_ids[idx];
            if is_excluded_block(block_id) {
                continue;
            }
            total_blocks += count;
            if let Some(item) = block_to_item(block_id) {
                *item_counts.entry(item).or_insert(0) += count;
            }
        }

        regions_out.push(RegionPreview {
            name: region.name.clone().into_owned(),
            pos: [
                region.position.x as i64,
                region.position.y as i64,
                region.position.z as i64,
            ],
            size: [
                region.size.x as i64,
                region.size.y as i64,
                region.size.z as i64,
            ],
            palette: palette_ids,
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
        name: meta.name.clone().into_owned(),
        author: meta.author.clone().into_owned(),
        description: meta.description.clone().into_owned(),
        litematica_version: meta.version as i64,
        mc_data_version: meta.minecraft_data_version as i64,
        mc_version_name: mc_version_name(meta.minecraft_data_version as i64),
        width: enclosing.x as i64,
        height: enclosing.y as i64,
        depth: enclosing.z as i64,
        region_count: schem.regions.len(),
        total_blocks,
        materials,
        preview: PreviewData {
            size: [enclosing.x as i64, enclosing.y as i64, enclosing.z as i64],
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
}
