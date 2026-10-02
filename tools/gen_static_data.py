#!/usr/bin/env python3
"""Generate static data tables bundled with the backend.

Sources:
- Data versions: table below, maintained from https://minecraft.wiki/w/Data_version
- Chinese names: vanilla zh_cn.json via the minecraft-assets mirror

Run: python tools/gen_static_data.py
"""

import json
import pathlib
import urllib.request

# version=data_version, releases only, from minecraft.wiki/w/Data_version
DATA_VERSIONS = """
1.14.4=1976
1.15=2225
1.15.1=2227
1.15.2=2230
1.16=2566
1.16.1=2567
1.16.2=2578
1.16.3=2580
1.16.4=2584
1.16.5=2586
1.17=2724
1.17.1=2730
1.18=2860
1.18.1=2865
1.18.2=2975
1.19=3105
1.19.1=3117
1.19.2=3120
1.19.3=3218
1.19.4=3337
1.20=3463
1.20.1=3465
1.20.2=3578
1.20.3=3698
1.20.4=3700
1.20.5=3837
1.20.6=3839
1.21=3953
1.21.1=3955
1.21.2=4080
1.21.3=4082
1.21.4=4189
1.21.5=4325
1.21.6=4435
1.21.7=4438
1.21.8=4440
1.21.9=4554
1.21.10=4556
1.21.11=4671
26.1=4786
26.1.1=4788
26.1.2=4790
26.2=4903
26.3=5023
"""

LANG_URL = (
    "https://raw.githubusercontent.com/InventivetalentDev/minecraft-assets/"
    "1.21.4/assets/minecraft/lang/zh_cn.json"
)


def main() -> None:
    root = pathlib.Path(__file__).resolve().parent.parent
    out_dir = root / "backend" / "src" / "data"
    out_dir.mkdir(parents=True, exist_ok=True)

    versions = {}
    for line in DATA_VERSIONS.strip().splitlines():
        ver, dv = line.split("=")
        versions[int(dv)] = ver
    (out_dir / "mc_data_versions.json").write_text(
        json.dumps(versions, separators=(",", ":")), encoding="utf-8"
    )

    lang = json.load(urllib.request.urlopen(LANG_URL))
    zh = {
        k: v
        for k, v in lang.items()
        if k.startswith(("block.minecraft.", "item.minecraft."))
    }
    (out_dir / "block_names_zh_cn.json").write_text(
        json.dumps(zh, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    print(f"data versions: {len(versions)}, zh_cn entries: {len(zh)}")


if __name__ == "__main__":
    main()
