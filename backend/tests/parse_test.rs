// The binary crate's parse module is not exposed as a lib, so this test file
// includes the module directly to exercise the pure parsing pipeline.
#[path = "../src/schematics/parse.rs"]
mod parse;

use mcdata::util::BlockPos;
use mcdata::{BlockState, GenericBlockState};
use rustmatica::{Litematic, Region};

fn block(name: &str) -> GenericBlockState {
    GenericBlockState {
        name: name.to_string().into(),
        properties: std::collections::HashMap::new(),
    }
}

fn build_test_litematic() -> Litematic {
    let mut schem = Litematic::new("测试原理图", "集成测试描述", "tester");
    schem.metadata.minecraft_data_version = 3700; // 1.20.4
    let mut region = Region::new("main", BlockPos::new(0, 0, 0), BlockPos::new(4, 3, 2));
    for y in 0..3 {
        for z in 0..2 {
            for x in 0..4 {
                let b = match (x, y, z) {
                    (0, 0, 0) => block("minecraft:stone"),
                    (1, 0, 0) => block("minecraft:oak_wall_sign"),
                    (2, 0, 0) => block("minecraft:carrots"),
                    (3, 0, 0) => block("minecraft:water"), // excluded from materials
                    (0, 0, 1) => block("minecraft:stone"),
                    _ => GenericBlockState::air(),
                };
                region.set_block(BlockPos::new(x, y, z), b);
            }
        }
    }
    schem.regions.push(region);
    schem
}

#[test]
fn parse_pipeline_roundtrip() {
    let schem = build_test_litematic();
    let bytes = schem.to_bytes().expect("serialize test litematic");

    let parsed = parse::parse_litematic(&bytes).expect("parse test litematic");

    assert_eq!(parsed.name, "测试原理图");
    assert_eq!(parsed.author, "tester");
    assert_eq!(parsed.description, "集成测试描述");
    assert_eq!(parsed.mc_version_name, "1.20.4");
    assert_eq!(parsed.mc_data_version, 3700);
    assert_eq!(parsed.litematica_version, 6);
    assert_eq!((parsed.width, parsed.height, parsed.depth), (4, 3, 2));
    assert_eq!(parsed.region_count, 1);
    // stone x2 + oak_wall_sign + carrots (water and air excluded)
    assert_eq!(parsed.total_blocks, 4);

    let by_id = |id: &str| {
        parsed
            .materials
            .iter()
            .find(|m| m.item_id == id)
            .map(|m| m.count)
    };
    assert_eq!(by_id("minecraft:stone"), Some(2));
    assert_eq!(
        by_id("minecraft:oak_sign"),
        Some(1),
        "wall sign maps to sign item"
    );
    assert_eq!(
        by_id("minecraft:carrot"),
        Some(1),
        "carrots maps to carrot item"
    );
    assert!(by_id("minecraft:water").is_none(), "water excluded");
    assert!(parsed.materials.iter().all(|m| !m.name_zh.is_empty()));

    // RLE roundtrip: expand and compare block-by-block against the source region.
    let region = &parsed.preview.regions[0];
    assert_eq!(region.size, [4, 3, 2]);
    assert_eq!(region.palette.len(), schem.regions[0].block_palette().len());

    let volume = 4 * 3 * 2;
    let mut expanded = Vec::with_capacity(volume);
    for [idx, run] in &region.rle {
        for _ in 0..*run {
            expanded.push(region.palette[*idx as usize].clone());
        }
    }
    assert_eq!(expanded.len(), volume);

    // Iteration order is x fastest, then z, then y (matching rustmatica's Blocks).
    let lookup = |x: usize, y: usize, z: usize| -> usize { y * (2 * 4) + z * 4 + x };
    assert_eq!(expanded[lookup(0, 0, 0)], "minecraft:stone");
    assert_eq!(expanded[lookup(1, 0, 0)], "minecraft:oak_wall_sign");
    assert_eq!(expanded[lookup(2, 0, 0)], "minecraft:carrots");
    assert_eq!(expanded[lookup(3, 0, 0)], "minecraft:water");
    assert_eq!(expanded[lookup(0, 0, 1)], "minecraft:stone");
    assert_eq!(expanded[lookup(1, 1, 0)], "minecraft:air");
    assert_eq!(expanded[lookup(3, 2, 1)], "minecraft:air");

    // The preview JSON must be serializable for storage.
    let json = serde_json::to_value(&parsed.preview).expect("preview serializes");
    assert!(!json.to_string().is_empty());
}

#[test]
fn rejects_garbage() {
    assert!(parse::parse_litematic(b"not a litematic").is_err());
}

#[test]
fn write_smoke_test_file() {
    // Materializes a small house for manual end-to-end smoke tests.
    let dx = 12;
    let dy = 11;
    let dz = 10;
    let roof_y = dy - 3; // roof slab at y=8, chimney above it
    let mut schem = Litematic::new("测试小屋", "冒烟测试用的小屋", "tester");
    schem.metadata.minecraft_data_version = 3700; // 1.20.4
    let mut region = Region::new("main", BlockPos::new(0, 0, 0), BlockPos::new(dx, dy, dz));

    let set = |region: &mut Region<
        GenericBlockState,
        mcdata::GenericEntity,
        mcdata::GenericBlockEntity,
    >,
               x: i32,
               y: i32,
               z: i32,
               name: &str| {
        region.set_block(
            BlockPos::new(x, y, z),
            GenericBlockState {
                name: name.to_string().into(),
                properties: std::collections::HashMap::new(),
            },
        );
    };

    for y in 0..dy {
        for z in 0..dz {
            for x in 0..dx {
                let on_shell = x == 0 || x == dx - 1 || z == 0 || z == dz - 1;
                if y == 0 {
                    set(&mut region, x, y, z, "minecraft:oak_planks"); // floor
                } else if y == roof_y {
                    set(&mut region, x, y, z, "minecraft:dark_oak_planks"); // roof
                } else if y > roof_y {
                    set(&mut region, x, y, z, "minecraft:air"); // above roof
                } else if on_shell {
                    // Windows: middle strip of each wall.
                    let mid_x = x == 0 || x == dx - 1;
                    let win = (y == 2 || y == 3)
                        && ((mid_x && (z == 4 || z == 5))
                            || (!mid_x
                                && z != 0
                                && z != dz - 1
                                && (x == 4 || x == 5 || x == 7 || x == 8)));
                    // Door hole on the front wall.
                    let door = z == 0 && (x == 5 || x == 6) && (y == 1 || y == 2);
                    if door {
                        set(&mut region, x, y, z, "minecraft:air");
                    } else if win {
                        set(&mut region, x, y, z, "minecraft:glass");
                    } else {
                        set(&mut region, x, y, z, "minecraft:stone_bricks");
                    }
                } else {
                    set(&mut region, x, y, z, "minecraft:air");
                }
            }
        }
    }
    // Chimney and interior decoration.
    for y in roof_y..dy {
        set(&mut region, 2, y, 2, "minecraft:oak_log");
    }
    set(&mut region, 3, 1, 3, "minecraft:crafting_table");
    set(&mut region, 3, 1, 4, "minecraft:furnace");
    set(&mut region, 9, 1, 8, "minecraft:oak_wall_sign");

    schem.regions.push(region);
    let out = std::path::Path::new("../data/test.litematic");
    if let Some(dir) = out.parent() {
        std::fs::create_dir_all(dir).unwrap();
    }
    schem.write_file(out).expect("write test litematic");
}
