/**
 * Fallback block base colors for when no render bundle is available.
 * Approximate average colors of the vanilla textures.
 */

/** Strip a state string's "[k=v,...]" section; palettes may carry full
 * state strings, and every property variant of one block shares its color. */
function bareName(idOrState: string): string {
  const open = idOrState.indexOf('[')
  return open === -1 ? idOrState : idOrState.slice(0, open)
}

export function blockColor(blockId: string): [number, number, number] {
  const id = bareName(blockId)
  const known = BLOCK_COLORS[id]
  if (known !== undefined) {
    return [(known >> 16) / 255, ((known >> 8) & 0xff) / 255, (known & 0xff) / 255]
  }
  // Deterministic hash color for unknown blocks.
  let h = 2166136261
  for (const c of id) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return [(h & 0xff) / 255, ((h >> 8) & 0xff) / 255, ((h >> 16) & 0xff) / 255]
}

export function blockColorHex(blockId: string): string {
  const [r, g, b] = blockColor(blockId)
  const to2 = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`
}

const BLOCK_COLORS: Record<string, number> = {
  'minecraft:stone': 0x7d7d7d,
  'minecraft:granite': 0x9a6a5a,
  'minecraft:diorite': 0xbcbcbe,
  'minecraft:andesite': 0x8a8a8d,
  'minecraft:deepslate': 0x4d4d51,
  'minecraft:tuff': 0x6c6d67,
  'minecraft:dirt': 0x866043,
  'minecraft:grass_block': 0x7fb238,
  'minecraft:coarse_dirt': 0x7a5a3d,
  'minecraft:podzol': 0x5c3f19,
  'minecraft:sand': 0xdbd3a0,
  'minecraft:red_sand': 0xbe662c,
  'minecraft:gravel': 0x857f7e,
  'minecraft:clay': 0xa4a8b8,
  'minecraft:snow_block': 0xf0fafa,
  'minecraft:ice': 0x7dadff,
  'minecraft:packed_ice': 0x8db4e0,
  'minecraft:obsidian': 0x14101e,
  'minecraft:bedrock': 0x565656,
  'minecraft:oak_log': 0x9c7f4e,
  'minecraft:spruce_log': 0x6b4f2e,
  'minecraft:birch_log': 0xd7cb8d,
  'minecraft:jungle_log': 0x846437,
  'minecraft:acacia_log': 0xba6337,
  'minecraft:dark_oak_log': 0x4a341f,
  'minecraft:cherry_log': 0xd6b8b3,
  'minecraft:mangrove_log': 0x773934,
  'minecraft:oak_leaves': 0x4a8f28,
  'minecraft:spruce_leaves': 0x3d5e38,
  'minecraft:birch_leaves': 0x66a34a,
  'minecraft:jungle_leaves': 0x4c8f30,
  'minecraft:acacia_leaves': 0x59852f,
  'minecraft:dark_oak_leaves': 0x3f6425,
  'minecraft:cherry_leaves': 0xe8a9c2,
  'minecraft:azalea_leaves': 0x54861f,
  'minecraft:flowering_azalea_leaves': 0xb25c8a,
  'minecraft:oak_planks': 0xb08a53,
  'minecraft:spruce_planks': 0x7a5a34,
  'minecraft:birch_planks': 0xd0b483,
  'minecraft:jungle_planks': 0xa07150,
  'minecraft:acacia_planks': 0xab5d34,
  'minecraft:dark_oak_planks': 0x4b351f,
  'minecraft:cherry_planks': 0xe2b4a8,
  'minecraft:mangrove_planks': 0x773934,
  'minecraft:bamboo_planks': 0xc3af5b,
  'minecraft:crimson_planks': 0x67233d,
  'minecraft:warped_planks': 0x2b6963,
  'minecraft:coal_ore': 0x6b6b6b,
  'minecraft:iron_ore': 0x9a8676,
  'minecraft:copper_ore': 0x9c7a5c,
  'minecraft:gold_ore': 0x9a844d,
  'minecraft:redstone_ore': 0x86656b,
  'minecraft:lapis_ore': 0x6177a4,
  'minecraft:diamond_ore': 0x7fb3a2,
  'minecraft:emerald_ore': 0x7b9e77,
  'minecraft:ancient_debris': 0x5c4238,
  'minecraft:netherrack': 0x6b2b2b,
  'minecraft:basalt': 0x4c4a4f,
  'minecraft:blackstone': 0x2c2530,
  'minecraft:end_stone': 0xdadca0,
  'minecraft:purpur_block': 0xa97ba9,
  'minecraft:nether_bricks': 0x2c161a,
  'minecraft:quartz_block': 0xeae5de,
  'minecraft:prismarine': 0x639f8f,
  'minecraft:dark_prismarine': 0x33544a,
  'minecraft:sea_lantern': 0xa5cac1,
  'minecraft:bricks': 0x97584a,
  'minecraft:stone_bricks': 0x7a7a7a,
  'minecraft:mud_bricks': 0x8b6a53,
  'minecraft:sandstone': 0xdcd3a0,
  'minecraft:red_sandstone': 0xbe662c,
  'minecraft:glowstone': 0xf9d49c,
  'minecraft:redstone_block': 0xa81717,
  'minecraft:lapis_block': 0x1d47a5,
  'minecraft:iron_block': 0xd8d8d8,
  'minecraft:gold_block': 0xf9ec4e,
  'minecraft:diamond_block': 0x62e3d8,
  'minecraft:emerald_block': 0x2cbb5c,
  'minecraft:coal_block': 0x0f0f0f,
  'minecraft:copper_block': 0xc16d4f,
  'minecraft:netherite_block': 0x3e3938,
  'minecraft:amethyst_block': 0x8560c8,
  'minecraft:smooth_stone': 0x9e9e9e,
  'minecraft:glass': 0xc8f0f8,
  'minecraft:water': 0x3f76e4,
  'minecraft:lava': 0xd45a12,
  'minecraft:crafting_table': 0xa07040,
  'minecraft:furnace': 0x767676,
  'minecraft:chest': 0xa06d3c,
  'minecraft:bookshelf': 0x9c7f4e,
  'minecraft:tnt': 0xdb441a,
  'minecraft:hay_block': 0xa8a033,
  'minecraft:pumpkin': 0xc07615,
  'minecraft:melon': 0x6f9b33,
  'minecraft:cactus': 0x0d6412,
  'minecraft:white_wool': 0xe9ecec,
  'minecraft:orange_wool': 0xf07613,
  'minecraft:magenta_wool': 0xbd44b3,
  'minecraft:light_blue_wool': 0x3aafd9,
  'minecraft:yellow_wool': 0xf8c627,
  'minecraft:lime_wool': 0x70b919,
  'minecraft:pink_wool': 0xed8dac,
  'minecraft:gray_wool': 0x3e4447,
  'minecraft:light_gray_wool': 0x8e8e86,
  'minecraft:cyan_wool': 0x158991,
  'minecraft:purple_wool': 0x792aac,
  'minecraft:blue_wool': 0x35399d,
  'minecraft:brown_wool': 0x724728,
  'minecraft:green_wool': 0x546d1b,
  'minecraft:red_wool': 0xa12722,
  'minecraft:black_wool': 0x141519,
  'minecraft:white_concrete': 0xcfd5d6,
  'minecraft:orange_concrete': 0xe06101,
  'minecraft:magenta_concrete': 0xa9309f,
  'minecraft:light_blue_concrete': 0x2489c7,
  'minecraft:yellow_concrete': 0xf1af15,
  'minecraft:lime_concrete': 0x6ea419,
  'minecraft:pink_concrete': 0xd6498e,
  'minecraft:gray_concrete': 0x36393d,
  'minecraft:light_gray_concrete': 0x7d7d73,
  'minecraft:cyan_concrete': 0x157788,
  'minecraft:purple_concrete': 0x64209c,
  'minecraft:blue_concrete': 0x2c2e8f,
  'minecraft:brown_concrete': 0x603c20,
  'minecraft:green_concrete': 0x495b24,
  'minecraft:red_concrete': 0x8e2121,
  'minecraft:black_concrete': 0x080a0f,
  'minecraft:terracotta': 0x985e43,
  'minecraft:white_terracotta': 0xd1b1a1,
  'minecraft:orange_terracotta': 0xa75326,
  'minecraft:light_gray_terracotta': 0x93614b,
}
