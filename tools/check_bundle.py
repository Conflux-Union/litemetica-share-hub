#!/usr/bin/env python3
"""Validate the extracted render bundle (data/textures/bundle.json.gz).

Exit 0 when every assertion holds, exit 1 otherwise with one line per
failure printed to stderr. Run after `extract-textures` to catch shape
regressions in the bundle the frontend renderer depends on.

Usage:
    python tools/check_bundle.py [--skip-preview] [--data PATH]
"""

from __future__ import annotations

import argparse
import glob
import gzip
import json
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_bundle(data_dir: str, errors: list[str]) -> dict | None:
    path = os.path.join(data_dir, "textures", "bundle.json.gz")
    if not os.path.isfile(path):
        errors.append(f"missing bundle file: {path}")
        return None
    try:
        with gzip.open(path, "rt", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        errors.append(f"cannot decode {path}: {e}")
        return None


def check_bundle_shape(bundle: dict, data_dir: str, errors: list[str]) -> None:
    block_states = bundle.get("blockStates")
    if not isinstance(block_states, dict):
        errors.append("bundle.blockStates is missing or not an object")
        block_states = {}
    if len(block_states) <= 1200:
        errors.append(f"blockStates has {len(block_states)} entries, expected > 1200")

    wire = block_states.get("minecraft:block/redstone_wire")
    if not isinstance(wire, dict):
        errors.append("blockStates is missing minecraft:block/redstone_wire")
    elif not isinstance(wire.get("multipart"), list):
        errors.append("minecraft:block/redstone_wire is not a multipart blockstate")
    elif "side|up" not in json.dumps(wire):
        errors.append("redstone_wire multipart has no 'side|up' when-condition")

    block_models = bundle.get("blockModels")
    if not isinstance(block_models, dict):
        errors.append("bundle.blockModels is missing or not an object")
        block_models = {}
    if "minecraft:block/cube" not in block_models:
        errors.append("blockModels is missing minecraft:block/cube")
    if "parent" not in block_models.get("minecraft:block/cube", {}):
        errors.append("minecraft:block/cube lost its parent field (verbatim JSON broken)")

    # Chests are entity-rendered in vanilla; the extractor must synthesize
    # block models + facing/type variants so chests are not placeholder cubes.
    chest_state = block_states.get("minecraft:block/chest")
    if not isinstance(chest_state, dict):
        errors.append("blockStates is missing minecraft:block/chest")
    else:
        variants = chest_state.get("variants")
        if not isinstance(variants, dict) or not variants:
            errors.append("minecraft:block/chest has no synthesized variants")
        else:
            if "" not in variants:
                errors.append("minecraft:block/chest lacks the property-less default variant")
            east_single = variants.get("facing=east,type=single")
            if not (isinstance(east_single, dict) and east_single.get("y") == 90):
                errors.append(
                    f"facing=east,type=single should rotate y=90, got {east_single!r}"
                )
            referenced = {
                v.get("model")
                for v in variants.values()
                if isinstance(v, dict)
            }
            missing_models = [m for m in referenced if m not in block_models]
            if missing_models:
                errors.append(f"chest variants reference missing models: {missing_models}")
    for chest_model in ("minecraft:block/chest_single", "minecraft:block/ender_chest_single"):
        model = block_models.get(chest_model)
        if not isinstance(model, dict) or not isinstance(model.get("elements"), list) or len(model["elements"]) < 2:
            errors.append(f"{chest_model} is missing synthesized elements")
    if "minecraft:entity/chest/normal__base_up" not in bundle.get("textures", {}):
        errors.append("textures is missing derived chest tile normal__base_up")

    # The material universe carries item models: vanilla shows several
    # material items (redstone, rails, bell, torches, seeds, …) as item
    # sprites, not placed-block models.
    item_models = bundle.get("itemModels")
    if not isinstance(item_models, dict) or not item_models:
        errors.append("bundle.itemModels is missing or empty")
        item_models = {}
    else:
        for item_id in ("minecraft:item/redstone", "minecraft:item/bell", "minecraft:item/rail"):
            if item_id not in item_models:
                errors.append(f"itemModels is missing {item_id}")
        for item_id, model in item_models.items():
            if not isinstance(model, dict):
                errors.append(f"item model {item_id} is not an object")
                break
            for tex in (model.get("textures") or {}).values():
                ref = tex.get("sprite") if isinstance(tex, dict) else tex
                if not isinstance(ref, str) or ref.startswith("#"):
                    continue
                # Model files mix bare ("block/conduit") and namespaced refs;
                # atlas keys are always namespaced.
                namespaced = ref if ":" in ref else f"minecraft:{ref}"
                if namespaced not in bundle.get("textures", {}):
                    errors.append(f"item model {item_id} references texture missing from atlas: {ref}")
        if "minecraft:item/redstone" in item_models:
            layer0 = item_models["minecraft:item/redstone"].get("textures", {}).get("layer0")
            if layer0 != "minecraft:item/redstone":
                errors.append(f"redstone item sprite should use item/redstone, got {layer0!r}")


    textures = bundle.get("textures")
    if not isinstance(textures, dict):
        errors.append("bundle.textures is missing or not an object")
        textures = {}
    if "minecraft:block/redstone_dust_line0" not in textures:
        errors.append("textures is missing minecraft:block/redstone_dust_line0")
    if len(textures) <= 1200:
        errors.append(f"textures has {len(textures)} entries, expected > 1200")
    for tex_id, entry in textures.items():
        uv, alpha = entry.get("uv"), entry.get("alpha")
        if not (isinstance(uv, list) and len(uv) == 2 and all(isinstance(v, int) for v in uv)):
            errors.append(f"texture {tex_id} has invalid uv {uv!r}")
            break
        if alpha not in ("opaque", "cutout", "translucent"):
            errors.append(f"texture {tex_id} has invalid alpha class {alpha!r}")
            break

    atlas = bundle.get("atlas")
    if not isinstance(atlas, str) or not atlas.startswith("atlas-"):
        errors.append(f"bundle.atlas is not a hashed atlas name: {atlas!r}")
    else:
        atlas_path = os.path.join(data_dir, "textures", atlas)
        if not os.path.isfile(atlas_path):
            errors.append(f"atlas file referenced by bundle does not exist: {atlas_path}")
        elif os.path.getsize(atlas_path) <= 100_000:
            errors.append(
                f"atlas file {atlas_path} is {os.path.getsize(atlas_path)} bytes, expected > 100KB"
            )

    tints = bundle.get("tintColors", {})
    for key in ("grass", "foliage"):
        color = tints.get(key)
        if not (isinstance(color, list) and len(color) == 3 and all(0 <= c <= 255 for c in color)):
            errors.append(f"tintColors.{key} is not an [r,g,b] 0..255 triple: {color!r}")

    if bundle.get("formatVersion") != 3:
        errors.append(f"bundle.formatVersion is {bundle.get('formatVersion')!r}, expected 3")


def check_previews(data_dir: str, errors: list[str]) -> None:
    # Current format: gzip-compressed binary LPRV payloads (schema 3).
    # Magic + version byte are enough to catch stale or corrupt payloads.
    previews = sorted(glob.glob(os.path.join(data_dir, "previews", "*.bin.gz")))
    for path in previews:
        try:
            with gzip.open(path, "rb") as f:
                header = f.read(5)
        except OSError as e:
            errors.append(f"cannot decode preview {path}: {e}")
            continue
        if len(header) < 5 or header[:4] != b"LPRV":
            errors.append(f"preview {path} does not start with the LPRV magic: {header[:4]!r}")
        elif header[4] != 3:
            errors.append(f"preview {path} is LPRV version {header[4]}, expected 3")
    if not previews:
        errors.append(
            "no preview payloads under data/previews/*.bin.gz (run the regen-previews subcommand)"
        )
    # Schema-2 JSON payloads are legacy; regen rewrites them as LPRV and
    # deletes the old file.
    for path in sorted(glob.glob(os.path.join(data_dir, "previews", "*.json.gz"))):
        errors.append(
            f"legacy schema-2 preview {path}; run the regen-previews subcommand to migrate to LPRV v3"
        )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skip-preview", action="store_true", help="skip the preview payload assertions"
    )
    parser.add_argument(
        "--data", default=os.path.join(REPO_ROOT, "data"), help="data directory (default: repo data/)"
    )
    args = parser.parse_args()

    errors: list[str] = []
    bundle = load_bundle(args.data, errors)
    if bundle is not None:
        check_bundle_shape(bundle, args.data, errors)
    if not args.skip_preview:
        check_previews(args.data, errors)

    if errors:
        for e in errors:
            print(f"FAIL: {e}", file=sys.stderr)
        return 1
    print("bundle ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
