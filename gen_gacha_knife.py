"""Generates one textured knife model + material per knife skin texture.

    python gen_gacha_knife.py              # every texture in maps/knife_texture
    python gen_gacha_knife.py --compile    # also compile the results (only with CS2 closed)

Inputs
  maps/knife_texture/{knife}_{style}[_{fx}].png   skin texture, painted on the knife's legacy UV.
      Optional effect tier suffix (left out of the name shown in game):
        _rb  rainbow sheen (iridescence) on the patterned (not dark) parts of the knife
        _pl  pearl: a soft color shift with the view angle on the patterned parts
        _gl  glitter over the whole knife (no skin uses it any more)
        _rl  relief: the pattern's bright lines are raised (normal map + light and shadow
             baked into a copy of the color texture)
        _ed  trim shine: the texture's trim lines (whatever stands out from its base color)
             are mirror-polished, the rest matte
      no suffix = no effect
  maps/gacha_knife/base/                   the decompiled official knife (vmdl + dmx), per knife
Outputs
  maps/gacha_knife/{knife}_{style}.vmat / .vmdl   (copy of the knife with its material remapped)
  maps/gacha_knife/maps/{knife}_{style}_metal.png / _rough.png
It also rewrites the KNIFE_SKINS list in maps/scripts/aim_gacha.js from the textures.
"""
import re
import subprocess
import sys
from pathlib import Path

import tempfile

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ADDON = Path(__file__).resolve().parent
CS2 = ADDON.parents[2]
TEX_DIR = ADDON / "maps" / "knife_texture"
OUT_DIR = ADDON / "maps" / "gacha_knife"
BASE_DIR = OUT_DIR / "base"
MAP_DIR = OUT_DIR / "maps"
SCRIPT = ADDON / "maps" / "scripts" / "aim_gacha.js"
KNIVES = ["bayonet", "butterfly", "karambit", "m9", "skeleton"]

# Knives are polished steel: fairly metal and glossy, brighter areas shinier
METAL, METAL_CONTRAST = 0.70, 0.30
ROUGH, ROUGH_CONTRAST = 0.30, 0.20
MAP_SIZE = 1024  # metal / rough maps must be a power of two


def base_model(knife):
    """The decompiled vmdl with its file paths moved to maps/gacha_knife/base/."""
    text = (BASE_DIR / f"weapon_knife_{knife}.vmdl").read_text(encoding="utf-8")
    return text.replace(f"weapons/models/knife/knife_{knife}/", "maps/gacha_knife/base/")


def with_material(model_text, knife, material):
    remap = f"""
			{{
				_class = "MaterialGroupList"
				children =
				[
					{{
						_class = "DefaultMaterialGroup"
						remaps =
						[
							{{
								from = "weapons/models/knife/knife_{knife}/materials/weapon_knife_{knife}.vmat"
								to = "{material}"
							}},
						]
						use_global_default = false
						global_default_material = ""
					}},
				]
			}},"""
    new, n = re.subn(r'(_class = "RootNode"\r?\n\t\tchildren = ?\r?\n\t\t\[)', lambda m: m.group(1) + remap, model_text, count=1)
    if n != 1:
        raise SystemExit(f"could not find the RootNode children of weapon_knife_{knife}.vmdl")
    return new


FX = ("rb", "pl", "gl", "ed", "rl")
EDGE_PX = 6  # width of the polished band of the _ed tier, in pixels of a 1024 map
DMXCONVERT = CS2 / "game" / "bin" / "win64" / "dmxconvert.exe"
_islands = {}


def island_mask(knife):
    """White where the knife's UV islands are (from its legacy mesh), MAP_SIZE square."""
    if knife in _islands:
        return _islands[knife]
    with tempfile.TemporaryDirectory() as tmp:
        txt = Path(tmp) / "m.txt"
        subprocess.run([str(DMXCONVERT), "-i", str(BASE_DIR / f"weapon_knife_{knife}_body_legacy.dmx"),
                        "-o", str(txt), "-oe", "keyvalues2"], check=True, capture_output=True)
        t = txt.read_text(encoding="utf-8", errors="replace")
    arr = lambda n, k: re.search(r'"%s" "%s"\s*\[(.*?)\]' % (re.escape(n), k), t, re.S).group(1)
    uv = [tuple(map(float, x.split())) for x in re.findall(r'"([-\d.e]+ [-\d.e]+)"', arr("texcoord$0", "vector2_array"))]
    idx = list(map(int, re.findall(r"-?\d+", arr("texcoord$0Indices", "int_array"))))
    img = Image.new("L", (MAP_SIZE, MAP_SIZE), 0); d = ImageDraw.Draw(img)
    for m in re.finditer(r'"faces" "int_array"\s*\[(.*?)\]', t, re.S):
        cur = []
        for v in map(int, re.findall(r"-?\d+", m.group(1))):
            if v == -1:
                if len(cur) >= 3:
                    d.polygon([(uv[idx[k]][0] * MAP_SIZE, uv[idx[k]][1] * MAP_SIZE) for k in cur], fill=255)  # dmx v already points down the image
                cur = []
            else:
                cur.append(v)
    _islands[knife] = np.asarray(img) > 127
    return _islands[knife]


def edge_maps(knife, src, metal_path, rough_path, mask_path):
    """_ed tier: the trim lines painted in the texture are mirror-polished, the rest matte.
    Trim = pixels on the knife whose color is far from the texture's base (median) color."""
    rgb = np.asarray(Image.open(src).convert("RGB").resize((MAP_SIZE, MAP_SIZE), Image.LANCZOS), dtype=np.float32) / 255
    on_knife = island_mask(knife)
    base = np.median(rgb[on_knife], axis=0)
    diff = np.linalg.norm(rgb - base, axis=2)
    band = np.clip((diff - 0.18) / 0.15, 0, 1) * on_knife
    band = ndimage.gaussian_filter(ndimage.grey_dilation(band, size=3), 0.6)
    metal = 0.25 + 0.75 * band
    rough = 0.65 - 0.6 * band
    for path, v in ((metal_path, metal), (rough_path, rough), (mask_path, band)):
        Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8)).save(path, optimize=True)


RELIEF_STRENGTH = 1.0


def relief_maps(knife, src, color_path, normal_path):
    """_rl tier: the brightest strokes of the pattern (its lines) become raised ridges."""
    rgb = np.asarray(Image.open(src).convert("RGB"), dtype=np.float32) / 255
    size = rgb.shape[0]
    val = rgb.max(axis=2)
    lo, hi = np.percentile(val, 50), np.percentile(val, 99)
    lines = np.clip((val - lo) / max(hi - lo, 1e-3), 0, 1)
    height = ndimage.gaussian_filter(lines, 1.2)
    k = 6.0 * RELIEF_STRENGTH
    dx = (np.roll(height, -1, 1) - np.roll(height, 1, 1)) * 0.5 * k
    dy = (np.roll(height, -1, 0) - np.roll(height, 1, 0)) * 0.5 * k
    n = np.dstack([-dx, dy, np.ones_like(height)])
    n /= np.linalg.norm(n, axis=2, keepdims=True)
    nimg = Image.fromarray(((n * 0.5 + 0.5) * 255).astype(np.uint8)).resize((MAP_SIZE, MAP_SIZE), Image.LANCZOS)
    nimg.save(normal_path, optimize=True)
    # light from the upper left on the ridges, a soft shadow beside them
    light = np.array([-0.55, 0.55, 0.63], np.float32); light /= np.linalg.norm(light)
    shade = n @ light - light[2]
    cast = np.roll(np.roll(ndimage.gaussian_filter(lines, 2.5), 3, 0), 3, 1)
    shadow = np.clip(cast - lines, 0, 1)
    factor = 1 + 1.5 * RELIEF_STRENGTH * shade - 0.5 * RELIEF_STRENGTH * shadow
    Image.fromarray((np.clip(rgb * factor[..., None], 0, 1) * 255).astype(np.uint8)).save(color_path, optimize=True)


def pattern_mask(knife, src, mask_path):
    """Where the sheen of _rb / _pl goes: the knife's lit, patterned areas. Dark, plain
    parts (e.g. a black handle under a patterned blade) stay without it."""
    rgb = np.asarray(Image.open(src).convert("RGB").resize((MAP_SIZE, MAP_SIZE), Image.LANCZOS), dtype=np.float32) / 255
    val = ndimage.gaussian_filter(rgb.max(axis=2), 2)
    mask = np.clip((val - 0.18) / 0.12, 0, 1) * island_mask(knife)
    mask = ndimage.gaussian_filter(ndimage.grey_dilation(mask, size=5), 1.5)
    Image.fromarray((np.clip(mask, 0, 1) * 255).astype(np.uint8)).save(mask_path, optimize=True)


def fx_lines(fx, sid):
    """Material lines for an effect tier."""
    full = f"maps/gacha_knife/maps/{sid}_fxmask.png" if fx in ("rb", "pl") else "maps/gacha_knife/maps/_white.png"
    if fx == "rb":
        return f"""	"F_ENABLE_SFX_MASK"		"1"
	"TextureSfxMask1"		"{full}"
	"F_IRIDESCENCE"		"1"
	"g_flIridescentStrength"		"0.600"
	"g_flIridescentScale"		"2.000"
	"g_flIridescentHueShift"		"0.500"
"""
    if fx == "pl":
        # Pearl: a faint, narrow-hued iridescence plus the shader's pearlescent shift
        return f"""	"F_ENABLE_SFX_MASK"		"1"
	"TextureSfxMask1"		"{full}"
	"F_IRIDESCENCE"		"1"
	"g_flIridescentStrength"		"0.150"
	"g_flIridescentScale"		"0.600"
	"g_flIridescentHueShift"		"0.120"
	"g_flPearlescentScale"		"0.300"
"""
    if fx == "gl":
        return f"""	"F_ENABLE_SFX_MASK"		"1"
	"TextureSfxMask1"		"{full}"
	"F_GLITTER"		"1"
	"TextureGlitterMask"		"materials/default/stickers/squares_glitter_mask.tga"
	"TextureGlitterNormal"		"materials/default/stickers/squares_glitter_normal.tga"
	"g_fGlitterIntensity"		"0.800"
	"g_fGlitterScale"		"40.000"
	"g_fGlitterRainbowBalance"		"0.250"
	"g_fGlitterRainbowSpread"		"0.500"
"""
    if fx == "rl":
        return f"""	"TextureNormal"		"maps/gacha_knife/maps/{sid}_normal.png"
"""
    if fx == "ed":
        return f"""	"F_ENABLE_SFX_MASK"		"1"
	"TextureSfxMask1"		"maps/gacha_knife/maps/{sid}_fxmask.png"
"""
    return ""


def gray_maps(src, metal_path, rough_path):
    rgb = np.asarray(Image.open(src).convert("RGB").resize((MAP_SIZE, MAP_SIZE), Image.LANCZOS), dtype=np.float32) / 255
    lum = rgb @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    for path, v in ((metal_path, METAL + METAL_CONTRAST * (lum - 0.5)), (rough_path, ROUGH - ROUGH_CONTRAST * (lum - 0.5))):
        Image.fromarray((np.clip(v, 0, 1) * 255).astype(np.uint8)).save(path, optimize=True)


def write_if_changed(path, text):
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.write_text(text, encoding="utf-8")
    return True


def main():
    compile_ = "--compile" in sys.argv
    MAP_DIR.mkdir(parents=True, exist_ok=True)
    white = MAP_DIR / "_white.png"  # effect mask covering the whole knife
    if not white.exists():
        Image.new("L", (64, 64), 255).save(white)
    made, ids = [], []
    for tex in sorted(TEX_DIR.glob("*.png")):
        knife, _, style = tex.stem.partition("_")
        fx = style.rsplit("_", 1)[1].lower() if "_" in style and style.rsplit("_", 1)[1].lower() in FX else ""
        if knife not in KNIVES or not style:
            print(f"skipped {tex.name} (name it {{knife}}_{{style}}.png, knife = {', '.join(KNIVES)})")
            continue
        sid = tex.stem.lower()
        ids.append(sid)
        metal, rough = MAP_DIR / f"{sid}_metal.png", MAP_DIR / f"{sid}_rough.png"
        stale = not metal.exists() or metal.stat().st_mtime < tex.stat().st_mtime
        if stale:
            if fx == "ed":
                edge_maps(knife, tex, metal, rough, MAP_DIR / f"{sid}_fxmask.png")
            else:
                gray_maps(tex, metal, rough)
            if fx == "rl":
                relief_maps(knife, tex, MAP_DIR / f"{sid}_color.png", MAP_DIR / f"{sid}_normal.png")
            if fx in ("rb", "pl"):
                pattern_mask(knife, tex, MAP_DIR / f"{sid}_fxmask.png")
        mat = f"maps/gacha_knife/{sid}.vmat"
        vmat = f"""// Generated by gen_gacha_knife.py from {tex.name}
"Layer0"
{{
	"shader"		"csgo_weapon.vfx"
	"TextureColor1"		"{f'maps/gacha_knife/maps/{sid}_color.png' if fx == 'rl' else f'maps/knife_texture/{tex.name}'}"
	"TextureMetalness1"		"maps/gacha_knife/maps/{sid}_metal.png"
	"TextureRoughness1"		"maps/gacha_knife/maps/{sid}_rough.png"
	"g_vMetalnessRemapRange"		"[0.000 1.000]"
{fx_lines(fx, sid)}	"g_flModelTintAmount"		"1.000000"
	"g_vColorTint"		"[1.000000 1.000000 1.000000 0.000000]"
	"g_vTexCoordCenter"		"[0.500 0.500]"
	"g_vTexCoordOffset"		"[0.000 0.000]"
	"g_vTexCoordScale"		"[1.000 1.000]"
	"g_flTexCoordRotation"		"0.000000"
	"g_flUvScale1"		"1.000000"
}}
"""
        changed = write_if_changed(OUT_DIR / f"{sid}.vmat", vmat)
        changed |= write_if_changed(OUT_DIR / f"{sid}.vmdl", with_material(base_model(knife), knife, mat))
        if changed or stale:
            made.append(sid)
        print(f"{'updated' if changed or stale else 'unchanged'} maps/gacha_knife/{sid}.vmdl{'  (' + fx + ')' if fx else ''}")

    # Keep KNIFE_SKINS in aim_gacha.js in sync with the textures
    js = SCRIPT.read_text(encoding="utf-8")
    block = "const KNIFE_SKINS = [" + ", ".join(f'"{i}"' for i in ids) + "];"
    new_js = re.sub(r"const KNIFE_SKINS = \[[^\]]*\];", block, js, count=1)
    if new_js != js:
        SCRIPT.write_text(new_js, encoding="utf-8")
        print(f"updated KNIFE_SKINS in aim_gacha.js ({len(ids)} skins)")

    if compile_ and made:
        running = "cs2.exe" in subprocess.run(["tasklist"], capture_output=True, text=True).stdout.lower()
        if running:
            print("CS2 is running: not compiling (two compilers writing the same textures corrupts them)")
            return
        rc = CS2 / "game" / "bin" / "win64" / "resourcecompiler.exe"
        for sid in made:
            for ext in ("vmat", "vmdl"):
                out = subprocess.run([str(rc), "-addon", ADDON.name, "-f", "-i", str(OUT_DIR / f"{sid}.{ext}")],
                                     capture_output=True, text=True).stdout
                result = [l.strip() for l in out.splitlines() if "OK:" in l or "ERROR" in l]
                print(f"  {sid}.{ext}: {result[-1] if result else out[-300:]}")


if __name__ == "__main__":
    main()
