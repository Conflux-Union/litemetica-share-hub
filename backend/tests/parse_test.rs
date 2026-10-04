// The binary crate's parse module is not exposed as a lib, so this test file
// includes the module directly to exercise the pure parsing pipeline.
#[path = "../src/schematics/parse.rs"]
mod parse;

use mcdata::util::BlockPos;
use mcdata::{BlockState, GenericBlockState};
use rustmatica::{Litematic, Region};

/// Minimal cursor over a schema-3 preview payload: unsigned LEB128 varints,
/// zigzag-decoded signed varints, and length-prefixed strings.
struct BinReader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl BinReader<'_> {
    fn new(buf: &[u8]) -> BinReader<'_> {
        BinReader { buf, pos: 0 }
    }

    fn byte(&mut self) -> u8 {
        let b = self.buf[self.pos];
        self.pos += 1;
        b
    }

    fn take(&mut self, n: usize) -> &'_ [u8] {
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        s
    }

    fn uvarint(&mut self) -> u64 {
        let mut result = 0u64;
        let mut shift = 0u32;
        loop {
            let b = self.byte();
            result |= u64::from(b & 0x7f) << shift;
            if b & 0x80 == 0 {
                return result;
            }
            shift += 7;
        }
    }

    fn varint(&mut self) -> i64 {
        let v = self.uvarint();
        ((v >> 1) as i64) ^ -((v & 1) as i64)
    }

    fn string(&mut self) -> String {
        let len = self.uvarint() as usize;
        String::from_utf8(self.take(len).to_vec()).expect("valid UTF-8")
    }
}

/// One region decoded from the binary payload, mirroring
/// [`parse::RegionPreview`] field for field.
struct DecodedRegion {
    name: String,
    pos: [i64; 3],
    size: [i64; 3],
    palette: Vec<String>,
    rle: Vec<[u64; 2]>,
}

fn decode_preview(payload: &[u8]) -> Vec<DecodedRegion> {
    let mut r = BinReader::new(payload);
    assert_eq!(r.take(4), parse::PREVIEW_MAGIC.as_slice());
    assert_eq!(r.byte() as u32, parse::PREVIEW_SCHEMA_VERSION);
    let dims = [r.uvarint(), r.uvarint(), r.uvarint()];
    let region_count = r.uvarint() as usize;
    let mut regions = Vec::with_capacity(region_count);
    for _ in 0..region_count {
        let mut region = DecodedRegion {
            name: r.string(),
            pos: [r.varint(), r.varint(), r.varint()],
            size: [r.varint(), r.varint(), r.varint()],
            palette: Vec::new(),
            rle: Vec::new(),
        };
        let palette_count = r.uvarint() as usize;
        region.palette = (0..palette_count).map(|_| r.string()).collect();
        let run_count = r.uvarint() as usize;
        region.rle = Vec::with_capacity(run_count);
        for _ in 0..run_count {
            let idx = r.uvarint();
            let len = r.uvarint();
            assert!(idx < palette_count as u64, "palette index in range");
            region.rle.push([idx, len]);
        }
        regions.push(region);
    }
    assert!(dims.iter().all(|d| *d > 0), "enclosing dims are positive");
    assert_eq!(r.pos, payload.len(), "payload fully consumed");
    regions
}

fn block(name: &str) -> GenericBlockState {
    GenericBlockState {
        name: name.to_string().into(),
        properties: std::collections::HashMap::new(),
    }
}

fn redstone_wire() -> GenericBlockState {
    let props: Vec<(
        std::borrow::Cow<'static, str>,
        std::borrow::Cow<'static, str>,
    )> = vec![
        ("north".to_string().into(), "up".to_string().into()),
        ("east".to_string().into(), "side".to_string().into()),
        ("south".to_string().into(), "side".to_string().into()),
        ("west".to_string().into(), "side".to_string().into()),
        ("power".to_string().into(), "7".to_string().into()),
    ];
    GenericBlockState {
        name: "minecraft:redstone_wire".to_string().into(),
        properties: props.into_iter().collect(),
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
                    (2, 1, 0) => redstone_wire(),
                    _ => GenericBlockState::air(),
                };
                region.set_block(BlockPos::new(x, y, z), b);
            }
        }
    }
    schem.regions.push(region);
    // Second region with a negative size: it extends in the negative x/z
    // direction from its position, while local coordinates still run over
    // 0..|size| relative to the minimum corner.
    let mut annex = Region::new("annex", BlockPos::new(6, 0, 3), BlockPos::new(-2, 2, -3));
    annex.set_block(BlockPos::new(0, 0, 0), block("minecraft:stone"));
    schem.regions.push(annex);
    schem
}

#[test]
fn parse_pipeline_roundtrip() {
    let schem = build_test_litematic();
    let bytes = schem.to_bytes().expect("serialize test litematic");

    let parsed = parse::parse_litematic(&bytes, 512 * 1024 * 1024).expect("parse test litematic");

    assert_eq!(parsed.name, "测试原理图");
    assert_eq!(parsed.author, "tester");
    assert_eq!(parsed.description, "集成测试描述");
    assert_eq!(parsed.mc_version_name, "1.20.4");
    assert_eq!(parsed.mc_data_version, 3700);
    assert_eq!(parsed.litematica_version, 6);
    // The annex at pos (6,0,3) size (-2,2,-3) extends the enclosing box to
    // x 0..6, y 0..2, z 0..3.
    assert_eq!((parsed.width, parsed.height, parsed.depth), (7, 3, 4));
    assert_eq!(parsed.region_count, 2);
    // stone x3 + oak_wall_sign + carrots + redstone_wire (water and air excluded)
    assert_eq!(parsed.total_blocks, 6);

    let by_id = |id: &str| {
        parsed
            .materials
            .iter()
            .find(|m| m.item_id == id)
            .map(|m| m.count)
    };
    assert_eq!(by_id("minecraft:stone"), Some(3));
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
    // The state-carrying wire still maps to the bare-name redstone item.
    assert_eq!(by_id("minecraft:redstone"), Some(1));
    assert!(parsed.materials.iter().all(|m| !m.name_zh.is_empty()));

    // NBT compounds are unordered maps, and the writer serializes regions
    // from a HashMap, so region order in the file (and thus in the preview)
    // varies between runs. Locate regions by name, never by position.
    let main = parsed
        .preview
        .regions
        .iter()
        .find(|r| r.name == "main")
        .expect("main region present");
    assert_eq!(main.size, [4, 3, 2]);
    let schem_main = schem
        .regions
        .iter()
        .find(|r| r.name == "main")
        .expect("main region in fixture");
    assert_eq!(main.palette.len(), schem_main.block_palette().len());

    // Binary roundtrip: serialize the preview into the schema-3 format and
    // decode it with the test-side reader. The wire payload must carry every
    // parsed region field unchanged, including the negative annex size.
    let payload = parse::preview_bytes(&parsed.preview);
    let decoded = decode_preview(&payload);
    assert_eq!(decoded.len(), 2);
    for (decoded, region) in decoded.iter().zip(&parsed.preview.regions) {
        assert_eq!(decoded.name, region.name);
        assert_eq!(decoded.pos, region.pos);
        assert_eq!(decoded.size, region.size);
        assert_eq!(decoded.palette, region.palette);
        assert_eq!(decoded.rle, region.rle);
    }
    let main = decoded
        .iter()
        .find(|r| r.name == "main")
        .expect("main decoded");
    let annex = decoded
        .iter()
        .find(|r| r.name == "annex")
        .expect("annex decoded");
    assert_eq!(annex.pos, [6, 0, 3]);
    assert_eq!(annex.size, [-2, 2, -3]);
    assert_eq!(annex.palette, vec!["minecraft:air", "minecraft:stone"]);

    // RLE roundtrip off the decoded bytes: expand and compare block-by-block
    // against the source region.
    let expand = |region: &DecodedRegion| -> Vec<String> {
        let mut expanded = Vec::new();
        for [idx, run] in &region.rle {
            for _ in 0..*run {
                expanded.push(region.palette[*idx as usize].clone());
            }
        }
        expanded
    };
    let expanded = expand(main);
    assert_eq!(expanded.len(), 4 * 3 * 2);

    // Iteration order is x fastest, then z, then y (litematica storage order).
    let lookup = |x: usize, y: usize, z: usize| -> usize { y * (2 * 4) + z * 4 + x };
    assert_eq!(expanded[lookup(0, 0, 0)], "minecraft:stone");
    assert_eq!(expanded[lookup(1, 0, 0)], "minecraft:oak_wall_sign");
    assert_eq!(expanded[lookup(2, 0, 0)], "minecraft:carrots");
    assert_eq!(expanded[lookup(3, 0, 0)], "minecraft:water");
    assert_eq!(expanded[lookup(0, 0, 1)], "minecraft:stone");
    // Property-carrying blocks expand to canonical state strings.
    assert_eq!(
        expanded[lookup(2, 1, 0)],
        "minecraft:redstone_wire[east=side,north=up,power=7,south=side,west=side]"
    );
    assert_eq!(expanded[lookup(1, 1, 0)], "minecraft:air");
    assert_eq!(expanded[lookup(3, 2, 1)], "minecraft:air");

    // The negative-size annex still carries |size| voxels: the stone at local
    // (0,0,0) followed by |size|-1 air blocks.
    let annex_blocks = expand(annex);
    assert_eq!(annex_blocks.len(), 2 * 2 * 3);
    assert_eq!(annex_blocks[0], "minecraft:stone");
    assert!(annex_blocks[1..].iter().all(|s| s == "minecraft:air"));
}

#[test]
fn rejects_garbage() {
    assert!(parse::parse_litematic(b"not a litematic", 512 * 1024 * 1024).is_err());
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
